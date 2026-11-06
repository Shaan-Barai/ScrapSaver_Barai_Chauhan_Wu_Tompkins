/**
 * Re-run Gemini + SAM on real plates that already have a result (e.g. food
 * added to the menu after the plate was scanned, or a fixed target-dish rule).
 * Same eventId and photo, the service's current menu; the new attempt is
 * counted only if it succeeds. About 2-3 Gemini calls per plate.
 *
 *   node scripts/reanalyze.mjs --events cap_A,cap_B [--dry-run]
 *   API_URL=http://localhost:8787 (default)
 *
 * Demo copies repeat real plates: afterwards run `npm run demo:clear` and
 * spread them again (POST /api/demo/spread with the same endDate).
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { values: args } = parseArgs({
  options: { events: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
const events = (args.events ?? '').split(',').map((e) => e.trim()).filter(Boolean);
if (events.length === 0) {
  console.error('usage: reanalyze.mjs --events cap_A,cap_B [--dry-run]');
  process.exit(2);
}
const api = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.SCRAP_INGEST_TOKEN && existsSync(envFile)) process.loadEnvFile(envFile);
const auth = process.env.SCRAP_INGEST_TOKEN ? { Authorization: `Bearer ${process.env.SCRAP_INGEST_TOKEN}` } : {};

async function getJson(path, init) {
  const res = await fetch(`${api}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`);
  return body;
}

/** "Halal Rice 207,625 px · Food not on the menu 56,053 px" for the counted attempt. */
async function describe(eventId) {
  const d = await getJson(`/api/captures/${encodeURIComponent(eventId)}`);
  const attempt = d.attempts.find((a) => a.attemptId === d.countedAttemptId);
  const menu = (await getJson(`/api/menus/by-service/${encodeURIComponent(d.event.serviceId)}`)).menu;
  const name = (id) => (id === null ? 'Food not on the menu' : menu.items.find((i) => i.itemId === id)?.displayName ?? id);
  const foods = d.measurements.map((m) => `${name(m.itemId)} ${m.remainingAreaPx.toLocaleString('en-US')} px`).join(' · ');
  const seg = attempt?.segmentation;
  return `${seg?.capturePixelsWasted?.toLocaleString('en-US') ?? '?'} px total [${foods}] menu v${attempt?.menuVersion} ${(attempt?.qualityFlags ?? []).join(',')}`;
}

let ok = 0;
for (const eventId of events) {
  console.log(`${eventId}\n  before: ${await describe(eventId)}`);
  if (args['dry-run']) continue;
  try {
    const r = await getJson(`/api/captures/${encodeURIComponent(eventId)}/reanalyze`, { method: 'POST', headers: auth });
    if (r.attempt?.status === 'succeeded') ok++;
    else console.log(`  re-run ${r.attempt?.status} (${r.attempt?.error?.code ?? 'no code'}): earlier result kept`);
    console.log(`  after:  ${await describe(eventId)}`);
  } catch (e) {
    console.log(`  request failed: ${e.message}`);
  }
}
if (!args['dry-run']) console.log(`Done: ${ok} of ${events.length} re-analyzed.`);
