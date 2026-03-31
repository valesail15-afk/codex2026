import { CrawlerService } from '../src/server/crawler';

type Target = 'trade' | 'hga' | 'external';

const target = (process.env.TARGET || 'hga') as Target;
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 60000);

const timer = setTimeout(() => {
  console.log(JSON.stringify({ status: 'timeout' }));
  process.exit(2);
}, timeoutMs);

async function run() {
  try {
    const t0 = Date.now();
    let rows: any[] = [];
    if (target === 'trade') rows = await (CrawlerService as any).fetchTrade500AsPrimaryMatches();
    if (target === 'hga') rows = await (CrawlerService as any).fetchHgaMatches();
    if (target === 'external') rows = await (CrawlerService as any).fetchExternalMatches();
    clearTimeout(timer);
    console.log(JSON.stringify({ status: 'ok', count: Array.isArray(rows) ? rows.length : 0, ms: Date.now() - t0 }));
    process.exit(0);
  } catch (err: any) {
    clearTimeout(timer);
    console.log(JSON.stringify({ status: 'fail', err: String(err?.message || err) }));
    process.exit(1);
  }
}

run();
