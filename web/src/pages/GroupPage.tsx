import { useState, useSyncExternalStore } from 'react';
import { expenseShares, formatMoney, newId, type ExpenseView } from '@splitter/core';
import { navigate } from '../App';
import { getMe, getStore, setMe, type GroupStore } from '../store';
import { ExpenseForm } from '../components/ExpenseForm';
import { ConflictList } from '../components/Conflicts';
import { exportCsvFile } from '../csv';

type Tab = 'expenses' | 'balances' | 'people' | 'more';

export function useGroup(groupId: string): GroupStore {
  const store = getStore(groupId);
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

export function GroupPage({ groupId }: { groupId: string }) {
  const store = useGroup(groupId);
  const [tab, setTab] = useState<Tab>('expenses');
  const [editing, setEditing] = useState<ExpenseView | 'new' | null>(null);
  const [me, setMeState] = useState(() => getMe(groupId));

  const chooseMe = (id: string | null) => {
    setMe(groupId, id);
    setMeState(id);
  };

  if (!store.loaded) return <div className="page center muted">Loading…</div>;

  if (!store.exists) {
    return (
      <div className="page">
        <TopBar store={store} />
        <main className="content">
          <div className="card empty">
            {store.status === 'notfound' ? (
              <>
                <h1>Group not found</h1>
                <p className="muted">Check the link. Groups only exist on the server they were created on.</p>
              </>
            ) : store.status === 'offline' ? (
              <>
                <h1>You're offline</h1>
                <p className="muted">Open this link once while online to download the group. After that it works offline.</p>
              </>
            ) : store.status === 'error' ? (
              <>
                <h1>Couldn't load the group</h1>
                <p className="muted">{store.error}</p>
                <button className="btn" onClick={() => void store.sync()}>Try again</button>
              </>
            ) : (
              <p className="muted">Downloading group…</p>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (!me || !store.allMembers.some((m) => m.id === me)) {
    return (
      <div className="page">
        <TopBar store={store} />
        <main className="content">
          <WhoAreYou store={store} onPick={chooseMe} />
        </main>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="page">
        <main className="content">
          <ExpenseForm store={store} me={me} expense={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <TopBar store={store} />
      <nav className="tabs" role="tablist">
        {(['expenses', 'balances', 'people', 'more'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'expenses' ? 'Expenses' : t === 'balances' ? 'Balances' : t === 'people' ? 'People' : 'More'}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'expenses' && <Expenses store={store} me={me} onOpen={setEditing} />}
        {tab === 'balances' && <Balances store={store} me={me} />}
        {tab === 'people' && <People store={store} me={me} />}
        {tab === 'more' && <More store={store} me={me} onSwitchUser={() => chooseMe(null)} />}
      </main>
      {tab === 'expenses' && (
        <button className="fab" onClick={() => setEditing('new')} aria-label="Add expense">
          + Add expense
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ store }: { store: GroupStore }) {
  const pending = store.meta.pending.length;
  const label =
    store.status === 'offline' ? 'Offline' :
    store.status === 'error' ? 'Sync failed' :
    store.status === 'notfound' ? 'Not found' :
    pending > 0 || store.status === 'syncing' ? 'Syncing…' : 'Synced';
  const cls = store.status === 'offline' || store.status === 'error' ? 'warn' : pending ? 'busy' : 'ok';
  return (
    <header className="topbar">
      <button className="icon-btn" onClick={() => navigate('/')} aria-label="All groups">‹</button>
      <div className="title grow">{store.exists ? store.group.name : 'Group'}</div>
      <button
        className={`sync ${cls}`}
        onClick={() => void store.sync()}
        title={store.error ?? (pending ? `${pending} change(s) waiting to sync` : 'Tap to sync now')}
      >
        <span className="dot" />
        {label}
        {pending > 0 && <span className="count">{pending}</span>}
      </button>
    </header>
  );
}

function WhoAreYou({ store, onPick }: { store: GroupStore; onPick: (id: string) => void }) {
  const [name, setName] = useState('');
  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = newId();
    setMe(store.groupId, id);
    await store.edit('member', id, { name: name.trim() });
    onPick(id);
  };
  return (
    <div className="card form">
      <h1>Who are you?</h1>
      <p className="muted">Pick your name so we know who's adding expenses. No account needed.</p>
      <ul className="list">
        {store.members.map((m) => (
          <li key={m.id}>
            <button className="row link" onClick={() => onPick(m.id)}>
              <Avatar name={m.name} />
              <span className="grow">{m.name}</span>
              <span className="chev">›</span>
            </button>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={join}>
        <input placeholder="I'm not on the list: my name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()}>Join</button>
      </form>
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ background: `hsl(${h} 45% 45%)` }} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

// ---------------------------------------------------------------------------

function Expenses({ store, me, onOpen }: { store: GroupStore; me: string; onOpen: (x: ExpenseView) => void }) {
  const base = store.group.baseCurrency;
  const list = store.expenses;
  const conflicted = list.filter((x) => x.conflicts.length > 0);
  const myBalance = store.ledger.balances[me] ?? 0;

  return (
    <>
      <div className="summary card">
        <div>
          <div className="muted small">Group spending</div>
          <div className="big">{formatMoney(store.ledger.total, base)}</div>
        </div>
        <div className="right">
          <div className="muted small">You</div>
          <div className={`big ${myBalance > 0 ? 'pos' : myBalance < 0 ? 'neg' : ''}`}>
            {myBalance === 0 ? 'Settled' : `${myBalance > 0 ? 'are owed' : 'owe'} ${formatMoney(Math.abs(myBalance), base)}`}
          </div>
        </div>
      </div>

      {conflicted.length > 0 && (
        <div className="notice warn">
          <strong>{conflicted.length} expense{conflicted.length > 1 ? 's were' : ' was'} edited by two people at once.</strong>{' '}
          Both versions are kept; open {conflicted.length > 1 ? 'them' : 'it'} to pick the right one.
        </div>
      )}

      {list.length === 0 ? (
        <div className="card empty">
          <p>No expenses yet.</p>
          <p className="muted">Tap <strong>+ Add expense</strong> to record the first one.</p>
        </div>
      ) : (
        <ul className="list card">
          {list.map((x) => {
            const share = expenseShareFor(store, x, me);
            return (
              <li key={x.id}>
                <button className="row link expense" onClick={() => onOpen(x)}>
                  <span className="date">{shortDate(x.date)}</span>
                  <span className="grow">
                    <span className="desc">
                      {x.kind === 'transfer' ? `${store.nameOf(x.paidBy)} paid ${store.nameOf(Object.keys(x.split.entries)[0] ?? '')}` : x.description || 'Expense'}
                      {x.conflicts.length > 0 && <span className="pill warn">conflict</span>}
                    </span>
                    <span className="muted small">
                      {x.kind === 'transfer' ? 'Payment' : `${x.paidBy === me ? 'You' : store.nameOf(x.paidBy)} paid ${formatMoney(x.amount, x.currency)}`}
                    </span>
                  </span>
                  {x.kind === 'expense' && (
                    <span className={`amount ${share > 0 ? 'pos' : share < 0 ? 'neg' : 'muted'}`}>
                      {share === 0 ? 'not involved' : `${share > 0 ? 'you lent' : 'you owe'} ${formatMoney(Math.abs(share), base)}`}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function expenseShareFor(store: GroupStore, x: ExpenseView, me: string): number {
  const shares = expenseShares(x, store.group.baseCurrency);
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  return (x.paidBy === me ? total : 0) - (shares[me] ?? 0);
}

function shortDate(d: string) {
  const dt = new Date(d + 'T00:00:00');
  return isNaN(+dt) ? d : dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------

function Balances({ store, me }: { store: GroupStore; me: string }) {
  const { balances, transfers, baseCurrency: base } = store.ledger;
  const people = store.allMembers.filter((m) => !m.deleted || balances[m.id] !== 0);
  const max = Math.max(1, ...people.map((m) => Math.abs(balances[m.id] ?? 0)));
  const today = new Date().toISOString().slice(0, 10);

  const markPaid = (from: string, to: string, amount: number) =>
    store.edit('expense', newId(), {
      kind: 'transfer', description: 'Payment', amount, currency: base, rate: 1, paidBy: from,
      split: { mode: 'exact', entries: { [to]: amount } }, date: today,
    });

  return (
    <>
      <h2 className="section-title">Suggested payments</h2>
      {transfers.length === 0 ? (
        <div className="card empty"><p>Everyone is settled up. 🎉</p></div>
      ) : (
        <>
          <p className="muted small">The fewest payments that settle everyone ({transfers.length}).</p>
          <ul className="list card">
            {transfers.map((t) => (
              <li key={`${t.from}-${t.to}`} className="row">
                <span className="grow">
                  <strong>{t.from === me ? 'You' : store.nameOf(t.from)}</strong> pay{t.from === me ? '' : 's'}{' '}
                  <strong>{t.to === me ? 'you' : store.nameOf(t.to)}</strong>
                  <div className="big">{formatMoney(t.amount, base)}</div>
                </span>
                <button className="btn small" onClick={() => void markPaid(t.from, t.to, t.amount)}>Mark paid</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="section-title">Balances</h2>
      <ul className="list card">
        {people.map((m) => {
          const b = balances[m.id] ?? 0;
          return (
            <li key={m.id} className="row balance">
              <Avatar name={m.name} />
              <span className="grow">
                {m.name}{m.id === me && ' (you)'}
                <span className="bar"><span className={b >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(b) / max) * 100}%` }} /></span>
              </span>
              <span className={`amount ${b > 0 ? 'pos' : b < 0 ? 'neg' : 'muted'}`}>
                {b === 0 ? 'settled' : `${b > 0 ? '+' : '−'}${formatMoney(Math.abs(b), base)}`}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------

function People({ store, me }: { store: GroupStore; me: string }) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const balances = store.ledger.balances;

  return (
    <>
      <ul className="list card">
        {store.members.map((m) => (
          <li key={m.id} className="row">
            <Avatar name={m.name} />
            {renaming === m.id ? (
              <form
                className="inline-form grow"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) void store.edit('member', m.id, { name: draft.trim() });
                  setRenaming(null);
                }}
              >
                <input value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} autoFocus />
                <button className="btn small">Save</button>
              </form>
            ) : (
              <>
                <span className="grow">{m.name}{m.id === me && <span className="muted"> (you)</span>}</span>
                <button className="btn ghost small" onClick={() => { setRenaming(m.id); setDraft(m.name); }}>Rename</button>
                <button
                  className="btn ghost small"
                  disabled={m.id === me || (balances[m.id] ?? 0) !== 0}
                  title={(balances[m.id] ?? 0) !== 0 ? 'Settle their balance first' : undefined}
                  onClick={() => { if (confirm(`Remove ${m.name} from the group?`)) void store.edit('member', m.id, { deleted: true }); }}
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void store.edit('member', newId(), { name: name.trim() });
          setName('');
        }}
      >
        <input placeholder="Add a person" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()}>Add</button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

function More({ store, me, onSwitchUser }: { store: GroupStore; me: string; onSwitchUser: () => void }) {
  const [name, setName] = useState(store.group.name);
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/g/${store.groupId}`;
  const deleted = store.deletedExpenses;
  const groupConflicts = store.state.entities.group.get(store.groupId);

  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: store.group.name, url: link }); return; } catch { /* fall through */ }
    }
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <section className="card form">
        <h2>Invite people</h2>
        <p className="muted small">Anyone with this link can view and edit the group. Treat it like a password.</p>
        <div className="inline-form">
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
          <button className="btn primary" onClick={() => void share()}>{copied ? 'Copied!' : 'Share'}</button>
        </div>
      </section>

      <section className="card form">
        <h2>Group</h2>
        {groupConflicts && <ConflictList store={store} entity="group" id={store.groupId} />}
        <form
          className="inline-form"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) void store.edit('group', store.groupId, { name: name.trim() }); }}
        >
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
          <button className="btn" disabled={!name.trim() || name.trim() === store.group.name}>Rename</button>
        </form>
        <p className="muted small">Main currency: {store.group.baseCurrency}</p>
      </section>

      <section className="card form">
        <h2>Export</h2>
        <p className="muted small">All expenses with each person's share, balances and suggested payments.</p>
        <button className="btn" onClick={() => exportCsvFile(store)}>Download CSV</button>
      </section>

      {deleted.length > 0 && (
        <section className="card form">
          <h2>Recently deleted</h2>
          <ul className="list">
            {deleted.slice(0, 20).map((x) => (
              <li key={x.id} className="row">
                <span className="grow">{x.description || 'Payment'} · {formatMoney(x.amount, x.currency)}</span>
                <button className="btn small ghost" onClick={() => void store.edit('expense', x.id, { deleted: false })}>Restore</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card form">
        <h2>This device</h2>
        <p className="muted small">
          You are <strong>{store.nameOf(me)}</strong>.{' '}
          {store.meta.lastSyncAt ? `Last synced ${new Date(store.meta.lastSyncAt).toLocaleString()}.` : 'Not synced yet.'}
        </p>
        {store.meta.rejected.length > 0 && (
          <p className="notice warn small">{store.meta.rejected.length} change(s) were rejected by the server: {store.meta.rejected[0]!.error}</p>
        )}
        <button className="btn ghost" onClick={onSwitchUser}>I'm not {store.nameOf(me)}</button>
      </section>
    </>
  );
}
