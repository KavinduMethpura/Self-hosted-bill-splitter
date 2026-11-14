import { formatMoney, type EntityType, type Split, type Version } from '@splitter/core';
import type { GroupStore } from '../store';

const LABELS: Record<string, string> = {
  description: 'Description', amount: 'Amount', currency: 'Currency', rate: 'Exchange rate',
  paidBy: 'Paid by', split: 'Split', date: 'Date', kind: 'Type', deleted: 'Deleted', name: 'Name',
  baseCurrency: 'Main currency',
};

/**
 * Shows every field that two people edited at the same time, with both
 * versions, and lets the user choose. Choosing writes a new edit whose base
 * includes all versions, which resolves the conflict on every device.
 */
export function ConflictList({ store, entity, id, currency }: { store: GroupStore; entity: EntityType; id: string; currency?: string }) {
  const conflicts =
    entity === 'expense'
      ? store.expenses.find((x) => x.id === id)?.conflicts ?? []
      : [...(store.state.entities[entity].get(id)?.fields ?? [])]
          .filter(([, r]) => r.heads.length > 1)
          .map(([field, r]) => ({ field, versions: r.heads }));
  if (conflicts.length === 0) return null;

  const show = (field: string, v: unknown): string => {
    if (field === 'deleted') return v ? 'Delete it' : 'Keep it';
    if (field === 'amount' && typeof v === 'number') return formatMoney(v, currency ?? store.group.baseCurrency);
    if (field === 'paidBy' && typeof v === 'string') return store.nameOf(v);
    if (field === 'split') {
      const s = v as Split;
      const names = Object.entries(s.entries).filter(([, n]) => n > 0).map(([m, n]) => (s.mode === 'equal' ? store.nameOf(m) : `${store.nameOf(m)} ${n}${s.mode === 'percent' ? '%' : ''}`));
      return `${s.mode}: ${names.join(', ')}`;
    }
    return String(v);
  };
  const who = (v: Version) => (v.by ? store.nameOf(v.by) : 'Someone');

  return (
    <div className="conflicts">
      {conflicts.map((c) => (
        <div key={c.field} className="notice warn">
          <div>
            <strong>{c.field === 'deleted' ? 'Deleted while being edited.' : `${LABELS[c.field] ?? c.field} was changed by two people.`}</strong>{' '}
            {c.field === 'deleted'
              ? `${who(c.versions[1]!)} deleted this, but ${who(c.versions[0]!)} edited it at the same time.`
              : 'Pick the right one:'}
          </div>
          <div className="choices">
            {c.versions.map((v, i) => (
              <button
                key={v.hlc}
                type="button"
                className={`btn small ${i === 0 ? 'primary' : ''}`}
                onClick={() => void store.edit(entity, id, { [c.field]: v.v }, [c.field])}
              >
                {show(c.field, v.v)}
                {c.field !== 'deleted' && <span className="muted"> · {who(v)}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
