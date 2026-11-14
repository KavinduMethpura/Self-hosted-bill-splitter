// Local-first group store.
//
// Every edit is written to IndexedDB as an op *and* queued as pending in the
// same transaction, then applied to the in-memory state immediately. The sync
// loop pushes pending ops and pulls everyone else's; the reducer in
// @splitter/core makes the result independent of arrival order.

import { openDB, type IDBPDatabase } from 'idb';
import {
  applyOp, emptyState, expenseViews, groupView, makeOp, memberViews, newId, receive, computeLedger,
  type Clock, type EntityType, type GroupState, type Op,
} from '@splitter/core';

interface GroupMeta {
  id: string;
  name: string;
  cursor: number;
  pending: string[];
  /** created on this device and not yet acknowledged by the server */
  creating: boolean;
  rejected: Array<{ id: string; error: string }>;
  lastSyncAt: number | null;
  openedAt: number;
}

type StoredOp = Op & { seq?: number };

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  dbp ??= openDB('splitter', 1, {
    upgrade(d) {
      const ops = d.createObjectStore('ops', { keyPath: 'id' });
      ops.createIndex('groupId', 'groupId');
      d.createObjectStore('groups', { keyPath: 'id' });
    },
  });
  return dbp;
}

// ---------------------------------------------------------------------------
// Device identity and clock (persisted synchronously so a reload never reuses
// a timestamp).

function loadClock(): Clock {
  try {
    const c = JSON.parse(localStorage.getItem('splitter.clock') ?? 'null') as Clock | null;
    if (c && typeof c.node === 'string') return c;
  } catch { /* ignore */ }
  const node = 'w' + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('');
  return { wall: 0, counter: 0, node };
}
const clock = loadClock();
function saveClock() {
  try { localStorage.setItem('splitter.clock', JSON.stringify(clock)); } catch { /* ignore */ }
}

export function getMe(groupId: string): string | null {
  try { return localStorage.getItem(`splitter.me.${groupId}`); } catch { return null; }
}
export function setMe(groupId: string, memberId: string | null) {
  try {
    if (memberId) localStorage.setItem(`splitter.me.${groupId}`, memberId);
    else localStorage.removeItem(`splitter.me.${groupId}`);
  } catch { /* ignore */ }
}

export async function listLocalGroups(): Promise<GroupMeta[]> {
  const all = (await (await db()).getAll('groups')) as GroupMeta[];
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function forgetGroup(groupId: string) {
  const d = await db();
  const tx = d.transaction(['ops', 'groups'], 'readwrite');
  const keys = await tx.objectStore('ops').index('groupId').getAllKeys(groupId);
  for (const k of keys) await tx.objectStore('ops').delete(k);
  await tx.objectStore('groups').delete(groupId);
  await tx.done;
  stores.get(groupId)?.close();
  stores.delete(groupId);
}

// ---------------------------------------------------------------------------

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'notfound';

export class GroupStore {
  state: GroupState;
  meta: GroupMeta;
  status: SyncStatus = 'syncing';
  error: string | null = null;
  version = 0;
  loaded = false;

  private listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private events: EventSource | null = null;
  private cache = new Map<string, unknown>();

  constructor(public readonly groupId: string) {
    this.state = emptyState(groupId);
    this.meta = { id: groupId, name: '', cursor: 0, pending: [], creating: false, rejected: [], lastSyncAt: null, openedAt: Date.now() };
  }

  async load() {
    const d = await db();
    const meta = (await d.get('groups', this.groupId)) as GroupMeta | undefined;
    if (meta) this.meta = { ...meta, openedAt: Date.now() };
    const ops = (await d.getAllFromIndex('ops', 'groupId', this.groupId)) as StoredOp[];
    for (const op of ops) {
      applyOp(this.state, op);
      receive(clock, op.hlc);
    }
    saveClock();
    this.loaded = true;
    if (meta) await d.put('groups', this.meta);
    this.changed();
    this.start();
  }

  // --- subscriptions (for React's useSyncExternalStore) ---------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    this.cache.clear();
    const name = groupView(this.state).name;
    if (this.state.entities.group.size && name !== this.meta.name) {
      this.meta.name = name;
      void db().then((d) => d.put('groups', this.meta));
    }
    for (const fn of this.listeners) fn();
  }
  private memo<T>(key: string, fn: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key) as T;
  }

  // --- derived views (memoised per version) ---------------------------------
  get group() { return this.memo('group', () => groupView(this.state)); }
  get members() { return this.memo('members', () => memberViews(this.state)); }
  get allMembers() { return this.memo('allMembers', () => memberViews(this.state, true)); }
  get expenses() { return this.memo('expenses', () => expenseViews(this.state)); }
  get deletedExpenses() { return this.memo('deleted', () => expenseViews(this.state, true).filter((x) => x.deleted)); }
  get ledger() { return this.memo('ledger', () => computeLedger(this.state)); }
  get exists() { return this.state.entities.group.size > 0; }
  nameOf = (id: string) => this.allMembers.find((m) => m.id === id)?.name ?? 'Someone';

  // --- writes ---------------------------------------------------------------
  /** Record a change locally (works offline) and queue it for sync. */
  async edit(entity: EntityType, entityId: string, changes: Record<string, unknown>, force: string[] = []) {
    const op = makeOp(this.state, clock, entity, entityId, changes, force, getMe(this.groupId) ?? undefined);
    saveClock();
    if (!op) return;
    await this.commit([op]);
  }

  async commit(ops: Op[]) {
    const d = await db();
    const tx = d.transaction(['ops', 'groups'], 'readwrite');
    for (const op of ops) {
      await tx.objectStore('ops').put(op);
      this.meta.pending.push(op.id);
    }
    await tx.objectStore('groups').put(this.meta);
    await tx.done;
    for (const op of ops) applyOp(this.state, op);
    this.changed();
    void this.sync();
  }

  /** Create a brand-new group on this device. */
  static async create(groupId: string, name: string, baseCurrency: string, myName: string, others: string[]) {
    const s = new GroupStore(groupId);
    s.meta.creating = true;
    stores.set(groupId, s);
    const ops: Op[] = [];
    const add = (entity: EntityType, id: string, changes: Record<string, unknown>, by?: string) => {
      const op = makeOp(s.state, clock, entity, id, changes, [], by)!;
      applyOp(s.state, op);
      ops.push(op);
    };
    const meId = newId();
    add('group', groupId, { name, baseCurrency }, meId);
    add('member', meId, { name: myName }, meId);
    for (const o of others) add('member', newId(), { name: o }, meId);
    saveClock();
    setMe(groupId, meId);
    await s.commit(ops); // applyOp is idempotent, so re-applying here is a no-op
    s.loaded = true;
    s.start();
    return s;
  }

  // --- sync -----------------------------------------------------------------
  private start() {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), 30_000);
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.listen();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.events?.close();
    this.events = null;
  }

  private onOnline = () => void this.sync();
  private onVisible = () => { if (document.visibilityState === 'visible') void this.sync(); };

  /** Live updates: the server pings us when someone else pushes. */
  private listen() {
    if (this.events || typeof EventSource === 'undefined') return;
    if (this.meta.creating || !this.exists) return; // wait until the server knows the group
    const es = new EventSource(`/api/groups/${this.groupId}/events`);
    es.addEventListener('changed', () => void this.sync());
    es.onerror = () => { /* browser reconnects automatically */ };
    this.events = es;
  }

  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.syncing;
  }

  private setStatus(status: SyncStatus, error: string | null = null) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.changed();
  }

  private async runSync() {
    if (!navigator.onLine) return this.setStatus('offline');
    this.setStatus('syncing');
    const d = await db();
    try {
      for (let round = 0; round < 50; round++) {
        const pendingIds = this.meta.pending.slice(0, 500);
        const ops = (await Promise.all(pendingIds.map((id) => d.get('ops', id)))).filter(Boolean) as StoredOp[];
        const res = await fetch(`/api/groups/${this.groupId}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ since: this.meta.cursor, ops, create: this.meta.creating }),
        });
        if (res.status === 404) return this.setStatus('notfound', 'This group does not exist on the server.');
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const body = (await res.json()) as {
          ops: StoredOp[]; cursor: number; more: boolean; rejected: Array<{ id: string; error: string }>;
        };

        const tx = d.transaction(['ops', 'groups'], 'readwrite');
        let changed = false;
        for (const op of body.ops) {
          receive(clock, op.hlc);
          if (applyOp(this.state, op)) {
            changed = true;
            await tx.objectStore('ops').put(op);
          }
        }
        const done = new Set(pendingIds);
        this.meta.pending = this.meta.pending.filter((id) => !done.has(id));
        if (body.rejected.length) this.meta.rejected.push(...body.rejected);
        this.meta.cursor = body.cursor;
        this.meta.creating = false;
        this.meta.lastSyncAt = Date.now();
        await tx.objectStore('groups').put(this.meta);
        await tx.done;
        saveClock();
        if (changed) this.changed();
        this.listen();
        if (!body.more && this.meta.pending.length === 0) break;
      }
      this.setStatus('synced');
    } catch (e) {
      this.setStatus(navigator.onLine ? 'error' : 'offline', e instanceof Error ? e.message : String(e));
    }
  }
}

const stores = new Map<string, GroupStore>();

export function getStore(groupId: string): GroupStore {
  let s = stores.get(groupId);
  if (!s) {
    s = new GroupStore(groupId);
    stores.set(groupId, s);
    void s.load();
  }
  return s;
}
