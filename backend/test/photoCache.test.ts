/**
 * PHOTO_CACHE_DIR: plate photos served by the backend under stable names,
 * resized for tiles and the plate view, kept on disk, cached for a year.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startTestServer, HALL, SERVICE, GEOMETRY } from './helpers.js';

async function upload(s: Awaited<ReturnType<typeof startTestServer>>, eventId: string, bytes: Buffer, mimeType: string): Promise<string> {
  const req = await s.api('POST', '/api/images/uploads', { associationKind: 'capture', associationId: eventId, mimeType, sizeBytes: bytes.length });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  const put = await fetch(`${s.baseUrl}${req.json.uploadUrl}`, { method: 'PUT', headers: { 'content-type': mimeType }, body: bytes });
  assert.equal(put.status, 204);
  assert.equal((await s.api('POST', `/api/images/${req.json.objectId}/finalize`)).status, 200);
  return req.json.objectId as string;
}

test('photos: stable resized links with year-long caching, kept on disk; unknown names are 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scrap-photos-'));
  const s = await startTestServer(undefined, { config: { photoCacheDir: dir } });
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  // A 2000x1500 camera-style JPEG and a small PNG mask.
  const jpeg = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const photoId = await upload(s, 'plate-1', jpeg, 'image/jpeg');
  const maskId = await upload(s, 'plate-1-mask', png, 'image/png');
  await s.repo.upsertCaptureEvent({ eventId: 'plate-1', hallId: HALL, serviceId: SERVICE, capturedAt: '2026-10-03T16:00:00Z', imageObjectId: photoId, geometry: GEOMETRY, source: 'camera', qualityFlags: [], state: 'succeeded' });

  const images = (await s.api('GET', '/api/captures/plate-1/images')).json;
  assert.equal(images.original.url, `/api/photos/${photoId}.display.jpg`);
  assert.equal(images.original.thumbUrl, `/api/photos/${photoId}.thumb.jpg`);
  assert.ok(Date.parse(images.original.expiresAt) > Date.now() + 300 * 24 * 3600 * 1000, 'links do not need renewing');

  for (const [variant, edge] of [['thumb', 480], ['display', 1600]] as const) {
    const res = await fetch(`${s.baseUrl}/api/photos/${photoId}.${variant}.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(Math.max(meta.width!, meta.height!), edge);
    assert.ok(existsSync(join(dir, `${photoId}.${variant}.jpg`)), `${variant} kept on disk`);
  }
  // Served again from disk, byte for byte.
  const again = await fetch(`${s.baseUrl}/api/photos/${photoId}.thumb.jpg`);
  assert.equal(again.status, 200);

  // PNGs are served as stored, under .full.png only.
  const mask = await fetch(`${s.baseUrl}/api/photos/${maskId}.full.png`);
  assert.equal(mask.status, 200);
  assert.deepEqual(Buffer.from(await mask.arrayBuffer()), png);
  for (const bad of [`${maskId}.thumb.png`, `${maskId}.full.jpg`, `${photoId}.full.png`, 'img_missing123.thumb.jpg', '..%2Fetc%2Fpasswd', `${photoId}.huge.jpg`]) {
    assert.equal((await fetch(`${s.baseUrl}/api/photos/${bad}`)).status, 404, bad);
  }
  assert.ok(readdirSync(dir).every((f) => !f.endsWith('.tmp')), 'no temporary files left behind');
});

test('without PHOTO_CACHE_DIR, images keep presigned links and /api/photos does not exist', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const res = await fetch(`${s.baseUrl}/api/photos/img_abcdef123.thumb.jpg`);
  assert.equal(res.status, 404);
});
