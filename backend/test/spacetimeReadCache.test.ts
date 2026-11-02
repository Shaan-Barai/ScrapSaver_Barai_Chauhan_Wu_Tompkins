/**
 * SpacetimeRepository whole-table read cache: one SQL request per table,
 * filtered in memory; every reducer call clears it; readiness is never cached.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpacetimeRepository, parseSimpleSelect } from '../src/repo/spacetimeRepository.js';

test('parseSimpleSelect reads exactly the queries the repository issues', () => {
  assert.deepEqual(parseSimpleSelect('SELECT * FROM capture_event'), { table: 'capture_event', columns: null, where: [] });
  assert.deepEqual(parseSimpleSelect("SELECT * FROM portions_served WHERE service_id = 'svc_1' AND menu_version = 3"), {
    table: 'portions_served',
    columns: null,
    where: [{ column: 'serviceId', value: 'svc_1' }, { column: 'menuVersion', value: 3 }],
  });
  assert.deepEqual(parseSimpleSelect('SELECT event_id FROM capture_visibility WHERE hidden = true'), {
    table: 'capture_visibility',
    columns: ['eventId'],
    where: [{ column: 'hidden', value: true }],
  });
  assert.deepEqual(parseSimpleSelect("SELECT * FROM menu_item WHERE item_id = 'it''s AND x = ''y'''"), {
    table: 'menu_item',
    columns: null,
    where: [{ column: 'itemId', value: "it's AND x = 'y'" }],
  });
  assert.equal(parseSimpleSelect('SELECT * FROM meal_service LIMIT 1')?.limit, 1);
  for (const other of ["SELECT * FROM t WHERE a > 'x'", "SELECT * FROM t WHERE a = 'x' OR b = 'y'", 'DELETE FROM t', "SELECT * FROM t WHERE a = 'x"]) {
    assert.equal(parseSimpleSelect(other), null, other);
  }
});

/** A fake SpacetimeDB answering `SELECT * FROM capture_event` and reducer calls, counting requests. */
function fakeServer(rows: Array<[string, string, boolean]>) {
  const requests: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/call/')) {
      requests.push(`call ${u.split('/call/')[1]}`);
      rows.push(['ev_new', 'svc_1', false]);
      return new Response('', { status: 200 });
    }
    const query = String(init?.body);
    requests.push(query);
    const schema = {
      elements: [
        { name: { some: 'event_id' }, algebraic_type: { String: [] } },
        { name: { some: 'service_id' }, algebraic_type: { String: [] } },
        { name: { some: 'hidden' }, algebraic_type: { Bool: [] } },
      ],
    };
    const filtered = query.includes('LIMIT 1') ? rows.slice(0, 1) : rows;
    return new Response(JSON.stringify([{ schema, rows: filtered }]), { status: 200 });
  }) as typeof fetch;
  return { requests, fetchFn };
}

test('table cache: one request per table, writes clear it, ping always asks the server', async (t) => {
  const { requests, fetchFn } = fakeServer([
    ['ev_1', 'svc_1', false],
    ['ev_2', 'svc_2', true],
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  t.after(() => {
    globalThis.fetch = original;
  });
  let clock = 0;
  const repo = new SpacetimeRepository({ uri: 'http://stdb.test', module: 'scrap', readCacheMs: 1000 }, () => clock);
  const sql = (q: string) => (repo as unknown as { sql(q: string): Promise<Record<string, unknown>[]> }).sql(q);

  assert.deepEqual(await sql("SELECT * FROM capture_event WHERE event_id = 'ev_2'"), [{ eventId: 'ev_2', serviceId: 'svc_2', hidden: true }]);
  assert.deepEqual((await sql("SELECT * FROM capture_event WHERE service_id = 'svc_1'")).map((r) => r.eventId), ['ev_1']);
  assert.deepEqual(await sql('SELECT event_id FROM capture_event WHERE hidden = true'), [{ eventId: 'ev_2' }]);
  assert.deepEqual(await sql("SELECT * FROM capture_event WHERE event_id = 'nope'"), []);
  assert.deepEqual(requests, ['SELECT * FROM capture_event'], 'one request for the whole table');

  // Callers get copies: changing one does not change the cache.
  const [row] = await sql("SELECT * FROM capture_event WHERE event_id = 'ev_1'");
  row!.serviceId = 'changed';
  assert.equal((await sql("SELECT * FROM capture_event WHERE event_id = 'ev_1'"))[0]!.serviceId, 'svc_1');

  // A write clears the cache: the new row is visible at once.
  await repo.setCaptureVisibility(['ev_1'], true, '2026-11-01T00:00:00Z');
  assert.equal((await sql("SELECT * FROM capture_event WHERE event_id = 'ev_new'")).length, 1);
  assert.equal(requests.filter((r) => r === 'SELECT * FROM capture_event').length, 2);

  // Entries expire after readCacheMs.
  clock = 5000;
  await sql("SELECT * FROM capture_event WHERE event_id = 'ev_1'");
  assert.equal(requests.filter((r) => r === 'SELECT * FROM capture_event').length, 3);

  // Readiness is never answered from the cache.
  await repo.ping();
  await repo.ping();
  assert.equal(requests.filter((r) => r === 'SELECT * FROM meal_service LIMIT 1').length, 2);
});

test('without readCacheMs every read goes to the server as written', async (t) => {
  const { requests, fetchFn } = fakeServer([['ev_1', 'svc_1', false]]);
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  t.after(() => {
    globalThis.fetch = original;
  });
  const repo = new SpacetimeRepository({ uri: 'http://stdb.test', module: 'scrap' });
  await repo.getCaptureEvent('ev_1');
  await repo.getCaptureEvent('ev_1');
  assert.deepEqual(requests, ["SELECT * FROM capture_event WHERE event_id = 'ev_1'", "SELECT * FROM capture_event WHERE event_id = 'ev_1'"]);
});
