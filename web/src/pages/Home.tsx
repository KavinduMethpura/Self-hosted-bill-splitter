import { useEffect, useState } from 'react';
import { COMMON_CURRENCIES, newId } from '@splitter/core';
import { navigate } from '../App';
import { GroupStore, listLocalGroups } from '../store';

type LocalGroup = Awaited<ReturnType<typeof listLocalGroups>>[number];

export function Home() {
  const [groups, setGroups] = useState<LocalGroup[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState('');

  useEffect(() => {
    listLocalGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const m = /([A-Za-z0-9_-]{16,64})\/?$/.exec(link.trim());
    if (m) navigate(`/g/${m[1]}`);
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>Splitter</span>
        </div>
      </header>

      <main className="content">
        {creating ? (
          <CreateGroup onCancel={() => setCreating(false)} />
        ) : (
          <>
            <section className="hero">
              <h1>Split group expenses without the sign-ups</h1>
              <p className="muted">
                Create a group, share the link, and everyone adds what they paid. Works offline and syncs when
                you're back online.
              </p>
              <button className="btn primary" onClick={() => setCreating(true)}>
                Create a group
              </button>
            </section>

            {groups && groups.length > 0 && (
              <section>
                <h2 className="section-title">Your groups on this device</h2>
                <ul className="list card">
                  {groups.map((g) => (
                    <li key={g.id}>
                      <a
                        className="row link"
                        href={`/g/${g.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/g/${g.id}`);
                        }}
                      >
                        <span className="grow">{g.name || 'Untitled group'}</span>
                        {g.pending.length > 0 && <span className="pill warn">{g.pending.length} unsynced</span>}
                        <span className="chev" aria-hidden>›</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h2 className="section-title">Got a link?</h2>
              <form className="inline-form" onSubmit={join}>
                <input
                  aria-label="Group link"
                  placeholder="Paste a group link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                />
                <button className="btn" type="submit" disabled={!link.trim()}>
                  Open
                </button>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function CreateGroup({ onCancel }: { onCancel: () => void }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(() => guessCurrency());
  const [me, setMe] = useState('');
  const [others, setOthers] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const id = newId();
    await GroupStore.create(id, name.trim(), currency, me.trim(), others.map((o) => o.trim()).filter(Boolean));
    navigate(`/g/${id}`);
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h1>New group</h1>
      <label>
        Group name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tasmania trip" autoFocus />
      </label>
      <label>
        Main currency
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {COMMON_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <small className="muted">Balances are shown in this currency. Expenses can be in any currency.</small>
      </label>
      <label>
        Your name
        <input required maxLength={60} value={me} onChange={(e) => setMe(e.target.value)} placeholder="Sam" />
      </label>
      <fieldset>
        <legend>Other people</legend>
        {others.map((o, i) => (
          <input
            key={i}
            maxLength={60}
            value={o}
            placeholder={`Person ${i + 2}`}
            onChange={(e) => {
              const next = [...others];
              next[i] = e.target.value;
              if (i === next.length - 1 && e.target.value) next.push('');
              setOthers(next);
            }}
          />
        ))}
        <small className="muted">You can add more people later, and anyone with the link can add themselves.</small>
      </fieldset>
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy || !name.trim() || !me.trim()}>Create group</button>
      </div>
    </form>
  );
}

function guessCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    const map: Record<string, string> = {
      AU: 'AUD', NZ: 'NZD', GB: 'GBP', US: 'USD', CA: 'CAD', JP: 'JPY', IN: 'INR', LK: 'LKR', SG: 'SGD',
      MY: 'MYR', ID: 'IDR', TH: 'THB', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', CN: 'CNY', HK: 'HKD',
      KR: 'KRW', ZA: 'ZAR', BR: 'BRL', MX: 'MXN', PH: 'PHP', VN: 'VND', AE: 'AED', PL: 'PLN',
    };
    const eur = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'GR'];
    if (region && map[region]) return map[region]!;
    if (region && eur.includes(region)) return 'EUR';
  } catch { /* ignore */ }
  return 'USD';
}
