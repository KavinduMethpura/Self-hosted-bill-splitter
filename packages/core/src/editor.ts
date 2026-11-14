// Turn "set these fields" into an Op, recording which versions the author saw.

import { tick, type Clock } from './hlc.js';
import { headsOf, type EntityType, type FieldWrite, type GroupState, type Op } from './ops.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 22 random base62 chars = ~131 bits. Used for group ids (the share secret) too. */
export function newId(): string {
  const bytes = new Uint8Array(22);
  (globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 62];
  return s;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build an op that sets `changes` on an entity. Fields whose displayed value
 * already equals the new value are skipped, unless they are in conflict (then
 * writing them resolves the conflict). Returns null if nothing changed.
 */
export function makeOp(
  state: GroupState,
  clock: Clock,
  entity: EntityType,
  entityId: string,
  changes: Record<string, unknown>,
  /** fields to write even if unchanged (e.g. to confirm a delete over a later edit) */
  force: string[] = [],
  by?: string,
): Op | null {
  const ent = state.entities[entity].get(entityId);
  const set: Record<string, FieldWrite> = {};
  for (const [field, v] of Object.entries(changes)) {
    if (v === undefined) continue;
    const heads = ent?.fields.get(field)?.heads ?? [];
    if (heads.length === 1 && same(heads[0]!.v, v) && !force.includes(field)) continue;
    set[field] = { v, b: headsOf(state, entity, entityId, field) };
  }
  if (Object.keys(set).length === 0) return null;
  return {
    id: newId(),
    groupId: state.groupId,
    entity,
    entityId,
    hlc: tick(clock),
    actor: clock.node,
    ...(by ? { by } : {}),
    set,
  };
}
