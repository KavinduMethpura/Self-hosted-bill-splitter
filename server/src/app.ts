import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { buildState, exportCsv, groupView, isId, validateOp, type Op } from '@splitter/core';
import type { Store } from './store.js';

export interface AppOptions {
  store: Store;
  webDist?: string;
  logger?: boolean;
  rateLimitPerMinute?: number;
}

const MAX_PUSH = 500;
const PAGE = 1000;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { store } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  await app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url.endsWith('/events'),
  });

  app.get('/api/health', async () => ({ ok: true }));

  /**
   * Sync: push local ops, pull everything after `since`.
   * Body: { since: number, ops: Op[], create?: boolean }
   * The group id in the URL is the secret share link; there are no accounts.
   */
  app.post<{ Params: { groupId: string }; Body: { since?: unknown; ops?: unknown; create?: unknown } }>(
    '/api/groups/:groupId/sync',
    async (req, reply) => {
      const { groupId } = req.params;
      if (!isId(groupId)) return reply.code(400).send({ error: 'bad group id' });
      const body = req.body ?? {};
      const since = typeof body.since === 'number' && body.since >= 0 ? Math.floor(body.since) : 0;
      const incoming = Array.isArray(body.ops) ? body.ops : [];
      if (incoming.length > MAX_PUSH) return reply.code(413).send({ error: `max ${MAX_PUSH} ops per request` });

      if (!(await store.groupExists(groupId))) {
        if (body.create !== true) return reply.code(404).send({ error: 'group not found' });
        await store.createGroup(groupId);
      }

      const accepted: Op[] = [];
      const rejected: Array<{ id: unknown; error: string }> = [];
      for (const raw of incoming) {
        const err = validateOp(raw) ?? ((raw as Op).groupId !== groupId ? 'op belongs to another group' : null);
        if (err) rejected.push({ id: (raw as Op)?.id, error: err });
        else accepted.push(pick(raw as Op));
      }
      if (accepted.length) {
        const added = await store.appendOps(groupId, accepted);
        if (added) bus.emit(groupId);
      }

      const ops = await store.opsSince(groupId, since, PAGE);
      const cursor = ops.length ? ops[ops.length - 1]!.seq : since;
      return { ops, cursor, more: ops.length === PAGE, rejected };
    },
  );

  /** Server-sent events: a tiny "something changed, sync now" ping. */
  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId/events', async (req, reply) => {
    const { groupId } = req.params;
    if (!isId(groupId) || !(await store.groupExists(groupId))) return reply.code(404).send({ error: 'group not found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const ping = () => res.write('event: changed\ndata: {}\n\n');
    const keepAlive = setInterval(() => res.write(': ka\n\n'), 25_000);
    bus.on(groupId, ping);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      bus.off(groupId, ping);
    });
  });

  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId/export.csv', async (req, reply) => {
    const { groupId } = req.params;
    if (!isId(groupId) || !(await store.groupExists(groupId))) return reply.code(404).send({ error: 'group not found' });
    const state = buildState(groupId, await store.allOps(groupId));
    const name = groupView(state).name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'group';
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}.csv"`)
      .send('﻿' + exportCsv(state));
  });

  // The web app (built by Vite) is served from the same origin.
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

/** Strip any extra properties a client might send. */
function pick(op: Op): Op {
  const set: Op['set'] = {};
  for (const [k, w] of Object.entries(op.set)) set[k] = { v: w.v, b: w.b };
  return { id: op.id, groupId: op.groupId, entity: op.entity, entityId: op.entityId, hlc: op.hlc, actor: op.actor, ...(op.by ? { by: op.by } : {}), set };
}
