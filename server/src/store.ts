import pg from 'pg';
import type { Op } from '@splitter/core';

export interface StoredOp extends Op {
  seq: number;
}

export interface Store {
  groupExists(groupId: string): Promise<boolean>;
  createGroup(groupId: string): Promise<void>;
  /** Insert ops (ignoring ones already stored). Returns how many were new. */
  appendOps(groupId: string, ops: Op[]): Promise<number>;
  opsSince(groupId: string, since: number, limit: number): Promise<StoredOp[]>;
  allOps(groupId: string): Promise<Op[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private groups = new Map<string, { ops: StoredOp[]; ids: Set<string> }>();
  async groupExists(id: string) {
    return this.groups.has(id);
  }
  async createGroup(id: string) {
    if (!this.groups.has(id)) this.groups.set(id, { ops: [], ids: new Set() });
  }
  async appendOps(id: string, ops: Op[]) {
    const g = this.groups.get(id)!;
    let n = 0;
    for (const op of ops) {
      if (g.ids.has(op.id)) continue;
      g.ids.add(op.id);
      g.ops.push({ ...op, seq: g.ops.length + 1 });
      n++;
    }
    return n;
  }
  async opsSince(id: string, since: number, limit: number) {
    return (this.groups.get(id)?.ops ?? []).filter((o) => o.seq > since).slice(0, limit);
  }
  async allOps(id: string) {
    return this.groups.get(id)?.ops ?? [];
  }
  async close() {}
}

// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id          text PRIMARY KEY,
  seq         bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ops (
  group_id    text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  op_id       text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  hlc         text NOT NULL,
  actor       text NOT NULL,
  author      text,
  set         jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, seq),
  UNIQUE (group_id, op_id)
);
`;

type Row = {
  seq: string;
  op_id: string;
  group_id: string;
  entity: Op['entity'];
  entity_id: string;
  hlc: string;
  actor: string;
  author: string | null;
  set: Op['set'];
};

const toOp = (r: Row): StoredOp => ({
  seq: Number(r.seq),
  id: r.op_id,
  groupId: r.group_id,
  entity: r.entity,
  entityId: r.entity_id,
  hlc: r.hlc,
  actor: r.actor,
  ...(r.author ? { by: r.author } : {}),
  set: r.set,
});

export class PgStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    // Postgres may still be starting when the app container boots.
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query(SCHEMA);
        return new PgStore(pool);
      } catch (e) {
        if (attempt >= 30) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async groupExists(id: string) {
    const r = await this.pool.query('SELECT 1 FROM groups WHERE id = $1', [id]);
    return r.rowCount === 1;
  }

  async createGroup(id: string) {
    await this.pool.query('INSERT INTO groups (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  }

  /**
   * Sequence numbers are allocated per group under a row lock, so a reader
   * can never observe seq N+1 before seq N is committed. That makes
   * "give me everything after my cursor" safe without gaps.
   */
  async appendOps(id: string, ops: Op[]) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const g = await c.query<{ seq: string }>('SELECT seq FROM groups WHERE id = $1 FOR UPDATE', [id]);
      let seq = Number(g.rows[0]!.seq);
      let added = 0;
      for (const op of ops) {
        const r = await c.query(
          `INSERT INTO ops (group_id, seq, op_id, entity, entity_id, hlc, actor, author, set)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (group_id, op_id) DO NOTHING`,
          [id, seq + 1, op.id, op.entity, op.entityId, op.hlc, op.actor, op.by ?? null, JSON.stringify(op.set)],
        );
        if (r.rowCount === 1) {
          seq++;
          added++;
        }
      }
      await c.query('UPDATE groups SET seq = $2 WHERE id = $1', [id, seq]);
      await c.query('COMMIT');
      return added;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async opsSince(id: string, since: number, limit: number) {
    const r = await this.pool.query<Row>(
      'SELECT * FROM ops WHERE group_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [id, since, limit],
    );
    return r.rows.map(toOp);
  }

  async allOps(id: string) {
    const r = await this.pool.query<Row>('SELECT * FROM ops WHERE group_id = $1 ORDER BY seq', [id]);
    return r.rows.map(toOp);
  }

  async close() {
    await this.pool.end();
  }
}
