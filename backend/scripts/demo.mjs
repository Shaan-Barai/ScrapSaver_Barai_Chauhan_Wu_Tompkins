/**
 * Sample history for the dashboard (DEMO_SEED), against a running backend.
 *
 *   npm run demo:seed     # ~14 days of labeled sample scans (needs DEMO_SEED=1 in .env)
 *   npm run demo:spread   # copy the hall's real plates over the last 56 days (labeled demo data)
 *   npm run demo:clear    # remove every sample row and copy; real scans are untouched
 *   API_URL=http://host:port npm run demo:clear
 *
 * Sends SCRAP_INGEST_TOKEN (from the environment) when set.
 */

const action = process.argv[2];
const api = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, '');
if (action !== 'seed' && action !== 'clear' && action !== 'spread') {
  console.error('Usage: node scripts/demo.mjs seed|spread|clear [days]');
  process.exit(2);
}
const hallId = process.env.HALL_ID || 'hall-main';
const days = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const body = action === 'seed' ? { hallId, days: days ?? 14 } : action === 'spread' ? { hallId, ...(days ? { days } : {}) } : {};

let res;
try {
  res = await fetch(`${api}/api/demo/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SCRAP_INGEST_TOKEN ? { Authorization: `Bearer ${process.env.SCRAP_INGEST_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
} catch {
  console.error(`No backend at ${api}. Start it first (cd backend && npm start).`);
  process.exit(1);
}
const out = await res.json();
if (!res.ok) {
  console.error(`${out.error?.code}: ${out.error?.message}`);
  process.exit(1);
}
if (action === 'seed') {
  console.log(`Sample history: ${out.services} services, ${out.captures} sample scans, ${out.measurements} sample measurements.`);
  if (out.skippedSlots.length > 0) console.log(`Skipped ${out.skippedSlots.length} meal(s) that already have a real menu or earlier sample data.`);
} else if (action === 'spread') {
  console.log(`Demo copies: ${out.captures} copies of ${out.sourcePlates} real plates in ${out.services} lunches/dinners (${out.measurements} food measurements).`);
  if (out.skippedSlots > 0) console.log(`Skipped ${out.skippedSlots} meal(s) that already have a menu (real, sample, or earlier copies).`);
} else {
  console.log(`Removed ${out.removedRows} demo rows (sample scans and copies). Real scans, menus and portions were not touched.`);
}
