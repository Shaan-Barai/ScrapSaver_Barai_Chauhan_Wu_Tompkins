/**
 * API contract checks: shared ApiError envelope on every error path,
 * menu retrieval, and the suggestions 'unavailable' stub.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, HALL, SERVICE, MENU } from './helpers.js';

test('missing menu returns the shared ApiError envelope', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  // Retrieval of a menu that was never uploaded.
  const get = await s.api('GET', '/api/menus?hallId=hall-main&date=2026-10-04');
  assert.equal(get.status, 404);
  assert.deepEqual(get.json, {
    error: {
      code: 'MENU_NOT_FOUND',
      message: 'No menu is saved for this hall and day yet. Add one in Menus.',
      details: { hallId: 'hall-main', serviceDate: '2026-10-04' },
      retryable: false,
    },
  });

  // Capture submission against a service with no menu: same envelope shape.
  const objectId = await s.uploadImage('cap_no_menu');
  const cap = await s.submitCapture('cap_no_menu', objectId);
  assert.equal(cap.status, 404);
  assert.equal(cap.json.error.code, 'MENU_NOT_FOUND');
  assert.equal(typeof cap.json.error.message, 'string');
  assert.equal(cap.json.error.retryable, false);
});

test('menu upload is validated and retrievable by hall/date/service', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const bad = await s.api('POST', '/api/menus', { service: { serviceId: 'x' }, items: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_MENU');

  const ok = await s.api('POST', '/api/menus', MENU);
  assert.equal(ok.status, 201);

  const byDay = await s.api('GET', '/api/menus?hallId=hall-main&date=2026-10-03&meal=lunch');
  assert.equal(byDay.status, 200);
  assert.equal(byDay.json.menus.length, 1);
  assert.equal(byDay.json.menus[0].service.serviceId, SERVICE);

  const byService = await s.api('GET', `/api/menus/by-service/${SERVICE}`);
  assert.equal(byService.status, 200);
  assert.equal(byService.json.menu.items.length, MENU.items.length);
});

test('capture submissions reject unfinalized or mismatched images', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  // Image uploaded for a DIFFERENT capture event must be rejected.
  const objectId = await s.uploadImage('cap_owner');
  const mismatch = await s.submitCapture('cap_thief', objectId);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error.code, 'IMAGE_ASSOCIATION_MISMATCH');

  // Pending (never finalized) image must be rejected too.
  const pending = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: 'cap_pending',
    mimeType: 'image/png',
    sizeBytes: 64,
  });
  const notFinal = await s.submitCapture('cap_pending', pending.json.objectId);
  assert.equal(notFinal.status, 400);
  assert.equal(notFinal.json.error.code, 'IMAGE_NOT_FINALIZED');
});
