import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../../server/app.mjs';

const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);

function parameters(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

// Independent oracle: canonical records, numeric UTC bounds, and per-service
// reductions. No production filtering or aggregation helpers are used.
function oracle(rows, options) {
  const start = options.from ? Date.parse(`${options.from}T00:00:00Z`) : -Infinity;
  const end = options.to ? Date.parse(`${options.to}T00:00:00Z`) + 86400000 : Infinity;
  const matches = rows.filter(row => {
    const search = (options.q ?? '').toUpperCase();
    if (![row.id, row.title, row.description].some(text => text.toUpperCase().includes(search))) return false;
    for (const key of ['service', 'status', 'severity']) {
      if (options[key]?.length && !options[key].includes(row[key])) return false;
    }
    const opened = Date.parse(row.openedAt);
    return opened >= start && opened < end;
  });
  const services = [...new Set(matches.map(row => row.service))].map(service => {
    const incidents = matches.filter(row => row.service === service);
    const resolved = incidents.filter(row => row.status === 'resolved');
    const elapsed = resolved.reduce((sum, row) => sum + new Date(row.resolvedAt).getTime() - new Date(row.openedAt).getTime(), 0);
    return {
      service,
      incidentCount: incidents.length,
      unresolvedCount: incidents.filter(row => row.status === 'open' || row.status === 'in_progress').length,
      highSeverityCount: incidents.filter(row => row.severity === 'critical' || row.severity === 'high').length,
      averageResolutionHours: resolved.length ? elapsed / resolved.length / 3600000 : null,
    };
  });
  services.sort((a, b) => b.unresolvedCount - a.unresolvedCount || a.service.localeCompare(b.service));
  return { matches, body: { services } };
}

test('overview measures across the whole result through real loopback HTTP', { timeout: 30000 }, async t => {
  const before = await readFile(dataURL);
  const rows = JSON.parse(before);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = path => fetch(base + path, { signal: AbortSignal.timeout(3000) });
    const check = async (options = {}) => {
      const response = await request(`/api/overview?${parameters(options)}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.deepEqual(body, oracle(rows, options).body);
      return body;
    };

    await t.test('all services, mixed statuses, exact unrounded averages and ordering', async () => {
      const body = await check();
      assert.equal(body.services.length, 6);
      assert.equal(body.services.reduce((sum, service) => sum + service.incidentCount, 0), 2400);
      assert.ok(body.services.every(service => service.unresolvedCount > 0 && service.unresolvedCount < service.incidentCount));
      assert.ok(body.services.some(service => service.averageResolutionHours !== Math.round(service.averageResolutionHours)));
      assert.ok(new Set(body.services.map(service => service.unresolvedCount)).size > 1);
      const resolved = await check({ status: ['resolved'] });
      assert.ok(resolved.services.every(service => service.unresolvedCount === 0));
      assert.deepEqual(resolved.services.map(service => service.service), resolved.services.map(service => service.service).sort());
    });

    await t.test('combined filters span multiple incident pages and ignore pagination and sorting', async () => {
      const options = { q: 'iNcIdEnT', service: ['Billing', 'Notifications'], status: ['open', 'in_progress', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13' };
      const { matches } = oracle(rows, options);
      assert.ok(matches.length > 50);
      assert.ok(matches.some(row => row.status === 'resolved'));
      const overview = await check(options);
      assert.equal(overview.services.reduce((sum, service) => sum + service.incidentCount, 0), matches.length);
      for (const sort of ['openedAt', 'severity']) {
        for (const direction of ['asc', 'desc']) {
          for (const pageSize of [25, 50]) {
            for (const page of [1, 2, 999999]) {
              assert.deepEqual(await check({ ...options, sort, direction, pageSize, page }), overview);
            }
          }
        }
      }
      const collected = [];
      for (let page = 1; page <= Math.ceil(matches.length / 25); page++) {
        const response = await request(`/api/incidents?${parameters({ ...options, page })}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.total, matches.length);
        collected.push(...body.items);
      }
      assert.deepEqual(collected.map(row => row.id).sort(), matches.map(row => row.id).sort());
      assert.deepEqual(await check(options), overview);
    });

    await t.test('unresolved-only matches have unavailable averages and only matching services', async () => {
      for (const status of [['open'], ['in_progress'], ['open', 'in_progress']]) {
        const body = await check({ service: ['Accounts', 'Search'], status });
        assert.equal(body.services.length, 2);
        for (const service of body.services) {
          assert.equal(service.averageResolutionHours, null);
          assert.equal(service.unresolvedCount, service.incidentCount);
          assert.ok(service.incidentCount > 0);
        }
      }
    });

    await t.test('literal search fields, repeated facets and inclusive UTC date boundaries', async () => {
      for (const q of ['inc-000001', 'BATCH PROCESSING DELAY', 'sEcOnD LiNe: <SAMPLE>', 'retry, then continue', '.*', '[']) await check({ q });
      await check({ service: ['Billing', 'Billing', 'Search'] });
      for (const day of ['2026-04-01', '2026-06-29']) {
        const body = await check({ from: day, to: day });
        assert.ok(body.services.reduce((sum, service) => sum + service.incidentCount, 0) > 0);
      }
      await check({ from: '2026-06-13' });
      await check({ to: '2026-04-15' });
    });

    await t.test('empty search, date and incompatible facets return an empty services array', async () => {
      for (const options of [{ q: 'no such incident', page: 300 }, { from: '2027-01-01' }, { q: 'INC-000001', service: [rows[0].service === 'Billing' ? 'Search' : 'Billing'] }]) {
        assert.deepEqual(await check(options), { services: [] });
      }
    });

    await t.test('validation envelopes match incident-list semantics', async () => {
      const invalid = ['unknown=yes', 'q=a&q=b', 'service=billing', 'status=closed', 'severity=urgent', 'from=2026-02-30', 'to=2026-13-01', 'from=2026-4-01', 'from=', 'from=2026-06-01&to=2026-04-01', 'from=2026-04-01&from=2026-04-02', 'sort=id', 'sort=severity&sort=openedAt', 'direction=down', 'direction=asc&direction=desc', 'page=0', 'page=-1', 'page=1.5', 'page=9007199254740992', 'page=1&page=2', 'pageSize=100', 'pageSize=25&pageSize=50'];
      for (const params of invalid) {
        const overview = await request(`/api/overview?${params}`);
        const list = await request(`/api/incidents?${params}`);
        assert.equal(overview.status, 400, params);
        assert.equal(list.status, 400, params);
        const error = await overview.json();
        assert.equal(error.error.code, 'INVALID_QUERY');
        assert.ok(error.error.message.length);
        assert.deepEqual(error, await list.json());
      }
    });

    await t.test('GET-only behavior preserves the existing method error', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const response = await fetch(`${base}/api/overview`, { method, signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET');
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else assert.deepEqual(await response.json(), { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this read-only server' } });
      }
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    assert.deepEqual(await readFile(dataURL), before);
  }
});
