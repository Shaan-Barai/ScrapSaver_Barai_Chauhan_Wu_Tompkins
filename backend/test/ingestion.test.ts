/**
 * Idempotent ingestion (AGENTS.md 5.3): CaptureEvent.eventId is the key.
 * Retries update the same event and add analysis attempts; a successful
 * observation is never double-counted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('submitting the same eventId twice yields one observation, not two', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  const eventId = 'cap_idempotent_1';
  s.fixtures[eventId] = {
    measurements: [{ itemId: 'item_eggs', remainingAreaPx: 12000 }],
  };
  const objectId = await s.uploadImage(eventId);

  const first = await s.submitCapture(eventId, objectId);
  assert.equal(first.status, 201);
  assert.equal(first.json.deduplicated, false);
  assert.equal(first.json.event.state, 'succeeded');
  assert.equal(first.json.measurements.length, 1);

  // Retry with the identical eventId: same event returned, no new attempt.
  const second = await s.submitCapture(eventId, objectId);
  assert.equal(second.status, 200);
  assert.equal(second.json.deduplicated, true);
  assert.equal(second.json.event.eventId, eventId);

  const detail = await s.api('GET', `/api/captures/${eventId}`);
  assert.equal(detail.json.attempts.length, 1, 'no second analysis attempt for a succeeded event');
  assert.equal(detail.json.measurements.length, 1, 'exactly one counted measurement');

  // The capture list shows the dish once.
  const listed = await s.api('GET', '/api/captures?hallId=hall-main&start=all&end=2026-12-31');
  assert.deepEqual(listed.json.map((c: { eventId: string }) => c.eventId), [eventId]);
});

test('a failed event can be retried: same event, appended attempts, counted once', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  const eventId = 'cap_retry_1';
  s.fixtures[eventId] = { status: 'failed', errorCode: 'GEMINI_TIMEOUT' };
  const objectId = await s.uploadImage(eventId);

  const first = await s.submitCapture(eventId, objectId);
  assert.equal(first.json.event.state, 'failed');
  assert.equal(first.json.attempt.status, 'failed');
  assert.equal(first.json.attempt.error.code, 'GEMINI_TIMEOUT');
  assert.equal(first.json.measurements.length, 0);

  // The analyzer recovers; the retry runs a NEW attempt on the SAME event.
  s.fixtures[eventId] = { measurements: [{ itemId: 'item_toast', remainingAreaPx: 9000 }] };
  const retry = await s.submitCapture(eventId, objectId);
  assert.equal(retry.json.deduplicated, false);
  assert.equal(retry.json.event.eventId, eventId);
  assert.equal(retry.json.event.state, 'succeeded');

  const detail = await s.api('GET', `/api/captures/${eventId}`);
  assert.equal(detail.json.attempts.length, 2, 'failed attempt preserved as history');
  assert.equal(detail.json.measurements.length, 1, 'only the succeeded attempt is counted');
  assert.equal(detail.json.countedAttemptId, retry.json.attempt.attemptId);

  const listed = await s.api('GET', '/api/captures?hallId=hall-main&start=all&end=2026-12-31');
  assert.equal(listed.json.length, 1, 'retries never duplicate the dish');
});

test('frozen context: the attempt records the menu version and baseline versions used', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  const eventId = 'cap_frozen_1';
  s.fixtures[eventId] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 1000 }] };
  const objectId = await s.uploadImage(eventId);
  const result = await s.submitCapture(eventId, objectId);

  assert.equal(result.json.attempt.menuVersion, 1);
  assert.deepEqual(result.json.attempt.baselineVersions, { item_eggs: 1, item_toast: 1 });
});

test('reanalyze: a succeeded plate gets a new counted attempt; a failed re-run keeps the old result', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  const eventId = 'cap_reanalyze_1';
  s.fixtures[eventId] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 5000 }] };
  const objectId = await s.uploadImage(eventId);
  const first = await s.submitCapture(eventId, objectId);
  assert.equal(first.json.event.state, 'succeeded');
  await new Promise((r) => setTimeout(r, 5)); // attempts are ordered by createdAt (ms)

  // Same photo, better analysis: the new attempt replaces the counted result.
  s.fixtures[eventId] = { measurements: [{ itemId: 'item_toast', remainingAreaPx: 7000 }] };
  const redo = await s.api('POST', `/api/captures/${eventId}/reanalyze`);
  assert.equal(redo.status, 201);
  assert.equal(redo.json.event.state, 'succeeded');
  let detail = await s.api('GET', `/api/captures/${eventId}`);
  assert.equal(detail.json.attempts.length, 2, 'the first attempt stays as history');
  assert.equal(detail.json.countedAttemptId, redo.json.attempt.attemptId);
  assert.deepEqual(detail.json.measurements.map((m: any) => [m.itemId, m.remainingAreaPx]), [['item_toast', 7000]]);
  await new Promise((r) => setTimeout(r, 5));

  // A failed re-run is recorded, but the plate keeps its counted result.
  s.fixtures[eventId] = { status: 'failed', errorCode: 'GEMINI_TIMEOUT' };
  const failed = await s.api('POST', `/api/captures/${eventId}/reanalyze`);
  assert.equal(failed.json.attempt.status, 'failed');
  assert.equal(failed.json.event.state, 'succeeded');
  detail = await s.api('GET', `/api/captures/${eventId}`);
  assert.equal(detail.json.attempts.length, 3);
  assert.equal(detail.json.countedAttemptId, redo.json.attempt.attemptId);

  const listed = await s.api('GET', '/api/captures?hallId=hall-main&start=all&end=2026-12-31');
  assert.equal(listed.json.length, 1, 're-analysis never duplicates the dish');

  assert.equal((await s.api('POST', '/api/captures/cap_missing/reanalyze')).status, 404);
});
