# Splitter: a self-hosted bill splitter

A group expense app. Someone creates a group and shares the link, and everyone adds expenses without signing up. Splitter works out who owes whom and reduces that to the **fewest possible payments**.

- **Unequal splits**: equally, exact amounts, percentages, or shares (e.g. 2:1:1)
- **Multiple currencies**: each expense has its own currency and exchange rate. Balances are in the group's main currency.
- **Offline-first**: add and edit expenses with no connection. Changes sync later, and edits made offline by different people merge without losing data.
- **CSV export**: every expense with each person's share, plus balances and suggested payments
- **Live updates**: open devices refresh when someone else syncs
- **One `docker compose up`** to self-host

```
packages/core   TypeScript domain logic shared by server + web (money, splits, settlement, sync merge)
server          Fastify + PostgreSQL API, also serves the built web app
web             React + TypeScript + Vite (PWA, IndexedDB storage)
mobile          Flutter + Drift (SQLite), a Dart port of packages/core
spec/fixtures   Shared test vectors, run by both the TS and Dart test suites
```

## Self-hosting

```sh
cp .env.example .env        # set POSTGRES_PASSWORD
docker compose up -d
```

Open http://localhost:3000. Put it behind a reverse proxy with HTTPS (Caddy, Traefik, nginx) before you share links on the internet.

> **The group link is the password.** Group IDs are ~128-bit random values, and anyone who has the link can view and edit that group. There are no accounts by design.

Data is stored in the `db-data` volume. To back it up, run `docker compose exec db pg_dump -U splitter splitter > backup.sql`.

## How offline sync works (the hard part)

Nobody edits rows directly. Every change is an immutable **operation** ("set these fields on expense X"), saved locally first and pushed later.

1. **Ops are idempotent.** Each has a UUID, so retrying a push after a dropped connection never creates duplicates.
2. **Hybrid logical clocks.** Each op is stamped with an HLC timestamp. Any edit made after *seeing* another edit gets a larger timestamp, even if the phone's clock is wrong.
3. **Per-field merge.** Each op records which version of each field the author was looking at. So:
   - Alice changes the *description* and Bob changes the *amount* while both are offline → both changes apply.
   - Alice edits an expense, then later edits it again → the newer value simply replaces the old one.
   - Alice and Bob both change the *amount* offline → **both values are kept**. The app shows the newer one and flags a conflict ("Amount was changed by two people: $135.00 · Alice / $125.00 · Bob"). Anyone can pick the right one, and that choice syncs to everyone.
   - Someone deletes an expense while someone else is still editing it offline → the expense stays visible with a "deleted while being edited" prompt instead of disappearing.
4. **Order doesn't matter.** The state is computed from the *set* of ops, so every device ends up with the same result no matter what order ops arrive in. The tests shuffle and duplicate op logs to check this.
5. **Gap-free cursors.** The server assigns per-group sequence numbers under a row lock, so "give me everything after #N" never skips an op committed by a concurrent request.

The merge logic is in [`packages/core/src/ops.ts`](packages/core/src/ops.ts) and its Dart port in [`mobile/lib/core/ops.dart`](mobile/lib/core/ops.dart).

## Money and settlement

- Amounts are stored as integer minor units (cents, yen, fils). Currencies with 0 or 3 decimals are handled.
- Splits are allocated with the largest-remainder method, so shares always add up exactly to the total (e.g. $100 / 3 → 33.34, 33.33, 33.33).
- **Fewest payments:** finding the true minimum is NP-hard. It equals *people with a non-zero balance − the largest number of zero-sum subgroups they can be split into*. For groups of up to 18 people with outstanding balances, an exact bitmask DP finds that minimum. Above that, a greedy fallback is used.
- "Mark paid" on a suggested payment records it as a transfer, which updates the balances.

## Development

Requires Node 22+.

```sh
npm install
npm test                     # core + server tests (server uses an in-memory store)
npm run build -w packages/core
npm run dev:server           # API on :3000 (in-memory unless DATABASE_URL is set)
npm run dev:web              # Vite on :5173, proxies /api to :3000
```

To run the server tests against Postgres:

```sh
docker run -d --rm -p 127.0.0.1:5439:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5439/postgres npm test -w server
```

### API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/groups/:id/sync` | Body `{ since, ops, create? }`. Pushes local ops and returns `{ ops, cursor, more, rejected }` |
| `GET` | `/api/groups/:id/events` | Server-sent events. A `changed` ping tells clients to sync |
| `GET` | `/api/groups/:id/export.csv` | CSV export |
| `GET` | `/api/health` | Health check |

## Mobile app (Flutter)

The Dart sources are in `mobile/`. The platform folders aren't committed, so generate them once:

```sh
cd mobile
flutter create . --project-name splitter --platforms=android,ios
flutter pub get
dart run build_runner build      # generates the Drift database code
flutter test                     # runs the shared fixtures against the Dart port
flutter run
```

When you create a group in the app, enter your server's address. When you join, paste a link (`https://host/g/<id>`) and the app picks up the server from it. To test against a plain-`http` server from an Android device, add `android:usesCleartextTraffic="true"` to the `<application>` tag in `android/app/src/main/AndroidManifest.xml` (not needed with HTTPS).
