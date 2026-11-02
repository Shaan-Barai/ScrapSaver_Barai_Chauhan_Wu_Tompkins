/**
 * Demo copies (2026-11-01): the hall's real plates repeated on earlier days,
 * labeled demo data, removable with the demo rows, and "All time" windows
 * (start=all) that start on the first day with a plate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import { parseWindow } from '../src/services/impactService.js';
import type { FoodMeasurement } from '../src/types.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function addPlate(s: Server, eventId: string, capturedAt: string, px: number, source: 'camera' | 'replay' = 'camera') {
  await s.repo.upsertCaptureEvent({ eventId, hallId: HALL, serviceId: SERVICE, capturedAt, imageObjectId: `img-${eventId}`, geometry: GEOMETRY, source, qualityFlags: [], state: 'succeeded' });
  await s.repo.upsertScanInfo({ eventId, deviceId: 'uno-q-c920', timestampBasis: 'laptop_trigger', originalImageObjectId: `raw-${eventId}`, demo: false });
  const measurements: FoodMeasurement[] = [{
    measurementId: `${eventId}-0`, eventId, attemptId: `att-${eventId}`, itemId: 'item_toast', remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [],
    maskCount: { validated: true, assignment: 'exclusive', pixelsWasted: px, geometry: GEOMETRY, menuId: MENU.service.menuId, menuVersion: 1, maskObjectId: `mask-${eventId}`, classificationVersion: 'fixture', segmentationVersion: 'fixture', processingVersion: 'fixture' },
  }];
  await s.repo.recordAnalysis({ eventId, attemptId: `att-${eventId}`, menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: capturedAt,
    overlayObjectId: `overlay-${eventId}`,
    segmentation: { model: 'fixture', checkpoint: 'fixture', codeRevision: 'fixture', promptSource: 'gemini_box', settingsVersion: 'fixture', countingRuleVersion: 'union-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: px, widthPx: GEOMETRY.widthPx, heightPx: GEOMETRY.heightPx,
      regions: [{ regionId: `rgn-${eventId}`, eventId, attemptId: `att-${eventId}`, itemId: 'item_toast', visualLabel: 'toast', box: { gemini: [0, 0, 500, 500], pixelXyxy: [0, 0, 512, 512], convention: 'gemini-yxyx-1000_to_xyxy-px_v1' }, segmentationStatus: 'succeeded', maskObjectId: `mask-${eventId}`, maskPixels: px }] } }, measurements);
}

test('parseWindow accepts start=all ("All time") and nothing else that is not a date', () => {
  assert.deepEqual(parseWindow({ start: 'all', end: '2026-11-01' }), { start: 'all', end: '2026-11-01' });
  assert.throws(() => parseWindow({ start: 'alltime', end: '2026-11-01' }), /'start'/);
  assert.throws(() => parseWindow({ start: '2026-11-01', end: 'all' }), /'end'/);
});

test('All time starts on the first day with a plate, and is empty (start = end) without plates', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const empty = (await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=all&end=2026-11-01`)).json;
  assert.deepEqual([empty.window.start, empty.window.end], ['2026-11-01', '2026-11-01']);

  await s.seedMenuAndBaselines();
  await addPlate(s, 'p1', '2026-10-03T16:00:00Z', 1000);
  const impact = (await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=all&end=2026-11-01`)).json;
  assert.deepEqual([impact.window.start, impact.window.end], ['2026-10-03', '2026-11-01']);
  assert.equal(impact.totals.pixels, 1000);
  const daily = (await s.api('GET', `/api/dashboard/impact/daily?hallId=${HALL}&start=all&end=2026-11-01`)).json.days;
  assert.equal(daily[0].date, '2026-10-03');
  assert.equal(daily.length, 30);
  assert.equal((await s.api('GET', `/api/captures?hallId=${HALL}&start=all&end=2026-11-01`)).json.length, 1);
});

test('demo copies spread the real plates over earlier days, labeled demo, and clear removes only them', async (t) => {
  const now = Date.parse('2026-10-10T23:30:00Z');
  const s = await startTestServer(undefined, { now: () => now });
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  await addPlate(s, 'real-a', '2026-10-03T16:00:00Z', 1200);
  await addPlate(s, 'real-b', '2026-10-03T16:05:00Z', 3400, 'replay');
  await addPlate(s, 'real-c', '2026-10-03T16:10:00Z', 5600);

  const res = await s.api('POST', '/api/demo/spread', { hallId: HALL, endDate: '2026-10-10', days: 10 });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.sourcePlates, 3);
  // 10 days x lunch + dinner, minus the real 2026-10-03 lunch.
  assert.equal(res.json.skippedSlots, 1);
  assert.equal(res.json.services, 19);
  assert.ok(res.json.captures >= 19, `at least one copy per meal, got ${res.json.captures}`);

  const all = (await s.api('GET', `/api/captures?hallId=${HALL}&start=all&end=2026-10-10&limit=200`)).json as Array<{ eventId: string; source: string; capturedAt: string; pixelsWasted: number; hasOverlay: boolean }>;
  const copies = all.filter((c) => c.source === 'demo');
  assert.equal(copies.length, res.json.captures);
  assert.ok(copies.every((c) => [1200, 3400, 5600].includes(c.pixelsWasted) && c.hasOverlay), 'each copy repeats a real plate');
  const days = new Set(copies.map((c) => c.capturedAt.slice(0, 10)));
  assert.ok(days.size >= 9, `copies spread over the days, got ${[...days].join(', ')}`);
  assert.ok(copies.every((c) => Date.parse(c.capturedAt) <= now), 'no copy is in the future');

  // A copy shows its source plate's photo, original and AI outline (image objects are reused).
  const copyId = copies[0]!.eventId;
  const detail = (await s.api('GET', `/api/captures/${copyId}`)).json;
  const source = detail.attempts[0].overlayObjectId.replace('overlay-', '');
  assert.equal(detail.event.imageObjectId, `img-${source}`);
  assert.equal(detail.measurements[0].maskCount.maskObjectId, `mask-${source}`);
  const scan = await s.repo.getScanInfo(copyId);
  assert.deepEqual([scan?.demo, scan?.timestampBasis, scan?.originalImageObjectId], [true, 'demo', `raw-${source}`]);

  // The dashboard labels the window as demo data; each copied service has demo portions.
  const impact = (await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=all&end=2026-10-10`)).json;
  assert.equal(impact.labels.sampleData, true);
  assert.equal(impact.coverage.sampleCaptures, copies.length);
  assert.equal(impact.totals.pixels, 1200 + 3400 + 5600 + copies.reduce((n, c) => n + c.pixelsWasted, 0));

  // Running it again adds nothing: every slot now has a service.
  const again = await s.api('POST', '/api/demo/spread', { hallId: HALL, endDate: '2026-10-10', days: 10 });
  assert.deepEqual([again.json.services, again.json.captures], [0, 0]);

  // Clearing demo data removes the copies and their services; the real plates stay.
  await s.api('POST', '/api/demo/clear');
  const after = (await s.api('GET', `/api/captures?hallId=${HALL}&start=all&end=2026-10-10&limit=200`)).json as Array<{ eventId: string }>;
  assert.deepEqual(after.map((c) => c.eventId).sort(), ['real-a', 'real-b', 'real-c']);
  assert.deepEqual((await s.repo.listServices(HALL)).map((x) => x.serviceId), [SERVICE]);
});
