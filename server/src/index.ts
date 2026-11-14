import { buildApp } from './app.js';
import { MemoryStore, PgStore, type Store } from './store.js';

const url = process.env.DATABASE_URL;
let store: Store;
if (url) {
  store = await PgStore.connect(url);
} else {
  console.warn('DATABASE_URL not set: using an in-memory store (data is lost on restart)');
  store = new MemoryStore();
}

const app = await buildApp({
  store,
  webDist: process.env.WEB_DIST,
  logger: true,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 600,
});

const port = Number(process.env.PORT) || 3000;
await app.listen({ port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await store.close();
    process.exit(0);
  });
}
