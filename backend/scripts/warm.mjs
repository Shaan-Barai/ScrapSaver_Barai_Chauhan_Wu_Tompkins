/**
 * Fill a server's caches so the first visitor waits for nothing
 * (deploy/server/deploy.sh warm, docs/deploy-server.md):
 *   1. the answers every page asks for first, for each range button
 *      (All time, Today, Last 7 / 30 / 90 days), kept by the READ_ONLY GET cache;
 *   2. every plate photo the gallery can show, as its tile thumbnail and plate
 *      view copy (PHOTO_CACHE_DIR keeps them on disk).
 *
 *   node backend/scripts/warm.mjs [base-url] [hall-id]
 *   (defaults: http://127.0.0.1:8787, hall-main; dates are America/Detroit)
 *
 * Read-only: GET requests only. Needs Node 18+ (global fetch), no packages.
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const hall = process.argv[3] ?? 'hall-main';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function get(path) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(300_000) });
    const body = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, body: Buffer.alloc(0), ms: Date.now() - started, error: String(err) };
  }
}

const q = (params) => new URLSearchParams(params).toString();

for (let i = 0; i < 60; i++) {
  if ((await get('/api/health')).ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}

// 1. Dashboard, Statistics and Behind the scenes, for each range button.
const windows = [
  ['all', today],
  [today, today],
  [addDays(today, -6), today],
  [addDays(today, -29), today],
  [addDays(today, -89), today],
];
let pages = 0;
const pageStart = Date.now();
await get(`/api/dashboard/totals?${q({ hallId: hall, today })}`);
await get(`/api/demo/status?${q({ hallId: hall })}`);
for (const [start, end] of windows) {
  for (const path of ['dashboard/impact', 'dashboard/impact/daily', 'recommendation', 'captures']) {
    const r = await get(`/api/${path}?${q({ hallId: hall, start, end })}`);
    pages += r.ok ? 1 : 0;
    if (!r.ok) console.log(`warm: ${path} ${start}..${end} -> ${r.status} ${r.error ?? ''}`);
  }
}
console.log(`warm: ${pages} dashboard answers in ${Math.round((Date.now() - pageStart) / 1000)} s`);

// 2. Every plate's images: the gallery's links, then the photos behind them.
const list = await get(`/api/captures?${q({ hallId: hall, start: 'all', end: today, limit: '200' })}`);
const plates = list.ok ? JSON.parse(list.body.toString('utf8')) : [];
const urls = new Set();
for (const plate of plates) {
  const r = await get(`/api/captures/${encodeURIComponent(plate.eventId)}/images`);
  if (!r.ok) continue;
  const images = JSON.parse(r.body.toString('utf8'));
  for (const img of [images.original, images.raw, images.overlay, ...(images.masks ?? [])]) {
    if (!img?.url?.startsWith('/api/photos/')) continue; // presigned links are not cached here
    urls.add(img.url);
    if (img.thumbUrl) urls.add(img.thumbUrl);
  }
}
const photoStart = Date.now();
let photos = 0;
let bytes = 0;
const queue = [...urls];
// Two at a time: resizing a camera photo is the heaviest thing a small VM does here.
await Promise.all(
  [0, 1].map(async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const r = await get(url);
      if (r.ok) {
        photos++;
        bytes += r.body.length;
      } else console.log(`warm: ${url} -> ${r.status}`);
    }
  }),
);
console.log(
  `warm: ${plates.length} plates, ${photos}/${urls.size} photos (${(bytes / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - photoStart) / 1000)} s`,
);
