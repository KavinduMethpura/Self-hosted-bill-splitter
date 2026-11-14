// Offline-first data model: an append-only log of operations.
//
// Nobody edits rows directly. Every change is an Op that sets one or more
// fields on one entity. Ops are immutable, identified by a UUID (so syncing
// is idempotent) and stamped with an HLC timestamp.
//
// Each field is a *multi-value register*: an op records, per field, which
// versions ("heads") the author could see when making the edit (`b`, base).
// A version is superseded only by an edit that saw it. So:
//   * edits to different fields of the same expense merge cleanly;
//   * sequential edits replace each other as you would expect;
//   * two people editing the same field offline produce TWO heads. The one
//     with the later timestamp is shown, but the other is kept and surfaced
//     as a conflict the group can resolve -- nothing is silently lost.
// The resulting state depends only on the *set* of ops, never on the order
// they arrive in, so every device converges to the same view.

import { isHlc } from './hlc.js';
import { isCurrencyCode } from './money.js';
import { isSplit, type Split } from './splits.js';

export type EntityType = 'group' | 'member' | 'expense';

export interface FieldWrite {
  /** new value */
  v: unknown;
  /** HLCs of the versions of this field the author saw (empty for a new field) */
  b: string[];
}

export interface Op {
  id: string;
  groupId: string;
  entity: EntityType;
  entityId: string;
  hlc: string;
  actor: string;
  /** member id of the person who made the edit, if known (display only) */
  by?: string;
  set: Record<string, FieldWrite>;
}

/** Field validators. Unknown fields are rejected. */
export const FIELD_RULES: Record<EntityType, Record<string, (v: unknown) => boolean>> = {
  group: {
    name: (v) => isText(v, 1, 100),
    baseCurrency: isCurrencyCode,
  },
  member: {
    name: (v) => isText(v, 1, 60),
    deleted: (v) => typeof v === 'boolean',
  },
  expense: {
    description: (v) => isText(v, 0, 200),
    amount: (v) => Number.isSafeInteger(v) && (v as number) > 0,
    currency: isCurrencyCode,
    rate: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e9,
    paidBy: (v) => isId(v),
    split: isSplit,
    date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
    kind: (v) => v === 'expense' || v === 'transfer',
    deleted: (v) => typeof v === 'boolean',
  },
};

function isText(v: unknown, min: number, max: number) {
  return typeof v === 'string' && v.trim().length >= min && v.length <= max;
}

export function isId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}

/** Validate an op coming from an untrusted client. Returns an error or null. */
export function validateOp(op: unknown): string | null {
  if (!op || typeof op !== 'object') return 'op must be an object';
  const o = op as Op;
  if (!isId(o.id)) return 'bad id';
  if (!isId(o.groupId)) return 'bad groupId';
  if (!(o.entity in FIELD_RULES)) return 'bad entity';
  if (!isId(o.entityId)) return 'bad entityId';
  if (o.entity === 'group' && o.entityId !== o.groupId) return 'group op must target the group';
  if (!isHlc(o.hlc)) return 'bad hlc';
  if (!isId(o.actor)) return 'bad actor';
  if (o.by !== undefined && !isId(o.by)) return 'bad by';
  if (!o.set || typeof o.set !== 'object' || Array.isArray(o.set)) return 'bad set';
  const keys = Object.keys(o.set);
  if (keys.length === 0) return 'empty set';
  const rules = FIELD_RULES[o.entity];
  for (const k of keys) {
    const rule = rules[k];
    if (!rule) return `unknown field ${o.entity}.${k}`;
    const w = o.set[k]!;
    if (!w || typeof w !== 'object') return `bad write for ${k}`;
    if (!rule(w.v)) return `invalid value for ${o.entity}.${k}`;
    if (!Array.isArray(w.b) || w.b.length > 32 || !w.b.every(isHlc)) return `bad base for ${k}`;
    if (w.b.some((h) => h >= o.hlc)) return `base for ${k} is not older than the op`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reducer

export interface Version {
  v: unknown;
  hlc: string;
  actor: string;
  by?: string;
}

export interface Register {
  /** live versions, sorted newest first. heads[0] is the displayed value */
  heads: Version[];
  /** every version some edit has seen and replaced */
  superseded: Set<string>;
}

export interface EntityState {
  id: string;
  createdHlc: string;
  updatedHlc: string;
  fields: Map<string, Register>;
}

export interface GroupState {
  groupId: string;
  opIds: Set<string>;
  entities: Record<EntityType, Map<string, EntityState>>;
}

export function emptyState(groupId: string): GroupState {
  return {
    groupId,
    opIds: new Set(),
    entities: { group: new Map(), member: new Map(), expense: new Map() },
  };
}

/** Apply an op. Idempotent and commutative. Returns false if already applied. */
export function applyOp(state: GroupState, op: Op): boolean {
  if (state.opIds.has(op.id)) return false;
  state.opIds.add(op.id);
  const table = state.entities[op.entity];
  let ent = table.get(op.entityId);
  if (!ent) {
    ent = { id: op.entityId, createdHlc: op.hlc, updatedHlc: op.hlc, fields: new Map() };
    table.set(op.entityId, ent);
  }
  if (op.hlc < ent.createdHlc) ent.createdHlc = op.hlc;
  if (op.hlc > ent.updatedHlc) ent.updatedHlc = op.hlc;

  for (const [field, w] of Object.entries(op.set)) {
    let reg = ent.fields.get(field);
    if (!reg) {
      reg = { heads: [], superseded: new Set() };
      ent.fields.set(field, reg);
    }
    for (const b of w.b) reg.superseded.add(b);
    reg.heads = reg.heads.filter((h) => !reg!.superseded.has(h.hlc));
    if (!reg.superseded.has(op.hlc)) {
      reg.heads.push(op.by ? { v: w.v, hlc: op.hlc, actor: op.actor, by: op.by } : { v: w.v, hlc: op.hlc, actor: op.actor });
      reg.heads.sort((a, b) => (a.hlc < b.hlc ? 1 : a.hlc > b.hlc ? -1 : 0));
    }
  }
  return true;
}

export function buildState(groupId: string, ops: Iterable<Op>): GroupState {
  const s = emptyState(groupId);
  for (const op of ops) applyOp(s, op);
  return s;
}

/** The HLCs of the current heads of a field; use as `b` when editing it. */
export function headsOf(state: GroupState, entity: EntityType, id: string, field: string): string[] {
  return state.entities[entity].get(id)?.fields.get(field)?.heads.map((h) => h.hlc) ?? [];
}

// ---------------------------------------------------------------------------
// Materialised views

export interface Conflict {
  field: string;
  versions: Version[]; // newest (displayed) first
}

export interface GroupView {
  id: string;
  name: string;
  baseCurrency: string;
}

export interface MemberView {
  id: string;
  name: string;
  deleted: boolean;
  createdHlc: string;
}

export interface ExpenseView {
  id: string;
  description: string;
  amount: number;
  currency: string;
  rate: number;
  paidBy: string;
  split: Split;
  date: string;
  kind: 'expense' | 'transfer';
  deleted: boolean;
  createdHlc: string;
  updatedHlc: string;
  conflicts: Conflict[];
}

function val<T>(e: EntityState | undefined, field: string, fallback: T): T {
  const h = e?.fields.get(field)?.heads[0];
  return h === undefined ? fallback : (h.v as T);
}

function conflictsOf(e: EntityState): Conflict[] {
  const out: Conflict[] = [];
  for (const [field, reg] of e.fields) {
    if (reg.heads.length > 1) out.push({ field, versions: reg.heads });
  }
  return out.sort((a, b) => (a.field < b.field ? -1 : 1));
}

export function groupView(s: GroupState): GroupView {
  const g = s.entities.group.get(s.groupId);
  return {
    id: s.groupId,
    name: val(g, 'name', 'Untitled group'),
    baseCurrency: val(g, 'baseCurrency', 'USD'),
  };
}

export function memberViews(s: GroupState, includeDeleted = false): MemberView[] {
  const out: MemberView[] = [];
  for (const e of s.entities.member.values()) {
    const m = { id: e.id, name: val(e, 'name', '?'), deleted: val(e, 'deleted', false), createdHlc: e.createdHlc };
    if (includeDeleted || !m.deleted) out.push(m);
  }
  return out.sort((a, b) => (a.createdHlc < b.createdHlc ? -1 : a.createdHlc > b.createdHlc ? 1 : 0));
}

export function expenseViews(s: GroupState, includeDeleted = false): ExpenseView[] {
  const base = groupView(s).baseCurrency;
  const out: ExpenseView[] = [];
  for (const e of s.entities.expense.values()) {
    const x: ExpenseView = {
      id: e.id,
      description: val(e, 'description', ''),
      amount: val(e, 'amount', 0),
      currency: val(e, 'currency', base),
      rate: val(e, 'rate', 1),
      paidBy: val(e, 'paidBy', ''),
      split: val(e, 'split', { mode: 'equal', entries: {} } as Split),
      date: val(e, 'date', ''),
      kind: val(e, 'kind', 'expense'),
      deleted: val(e, 'deleted', false),
      createdHlc: e.createdHlc,
      updatedHlc: e.updatedHlc,
      conflicts: conflictsOf(e),
    };
    // Someone deleted this while someone else (offline) was still editing it.
    // Don't hide the edit: keep the expense visible and flag the conflict.
    const del = e.fields.get('deleted')?.heads[0];
    if (x.deleted && del) {
      let newest: Version | undefined;
      for (const [f, reg] of e.fields) {
        if (f === 'deleted') continue;
        for (const h of reg.heads) if (h.hlc > del.hlc && (!newest || h.hlc > newest.hlc)) newest = h;
      }
      if (newest) {
        x.deleted = false;
        x.conflicts = x.conflicts.filter((c) => c.field !== 'deleted');
        x.conflicts.unshift({ field: 'deleted', versions: [{ ...newest, v: false }, del] });
      }
    }
    if (includeDeleted || !x.deleted) out.push(x);
  }
  // newest date first, then newest created
  return out.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.createdHlc < b.createdHlc ? 1 : a.createdHlc > b.createdHlc ? -1 : 0,
  );
}
