// Node-runnable tests for the pure parts of the extension:  node --test tests/
// The shared files are classic scripts that assign a global; load them for that side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../src/shared/selector-pack.js');
require('../src/shared/config.js');
require('../src/shared/render.js');
const { CCSL_PACK: PACK, CCSL_CONFIG: CONFIG, CCSL_RENDER: RENDER } = globalThis;

const usageUrl = 'https://claude.ai/api/organizations/org-123/usage';
const sessionUrl = 'https://claude.ai/v1/code/sessions/session_abc123?x=1';

test('matchEndpoint and sessionIdFor', () => {
  assert.equal(PACK.matchEndpoint(usageUrl).id, 'usage');
  const ep = PACK.matchEndpoint(sessionUrl);
  assert.equal(ep.id, 'sessionDetail');
  assert.equal(PACK.sessionIdFor(ep, sessionUrl), 'session_abc123');
  assert.equal(PACK.sessionIdFor(PACK.matchEndpoint(usageUrl), usageUrl), null);
  assert.equal(PACK.matchEndpoint('https://claude.ai/v1/code/sessions/session_abc/events'), null);
});

test('usage extraction, resets_at null when absent', () => {
  const ep = PACK.matchEndpoint(usageUrl);
  const { fields, drift } = PACK.extract(ep, {
    five_hour: { utilization: 42.5, resets_at: '2026-10-01T12:00:00Z' },
    seven_day: { utilization: 10 },
  });
  assert.deepEqual(drift, []);
  assert.equal(fields.fiveHourPct, 42.5);
  assert.equal(fields.sevenDayResetsAt, null);
});

test('usage drift when a required field is gone', () => {
  const { drift } = PACK.extract(PACK.matchEndpoint(usageUrl), { five_hour: {}, seven_day: { utilization: 1 } });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].key, 'fiveHourPct');
  assert.ok(!JSON.stringify(drift).includes('"1"'));
});

test('branch: present, legitimately absent (null), and drift', () => {
  const ep = PACK.matchEndpoint(sessionUrl);
  const ok = PACK.extract(ep, { response_shape: { external_metadata: { current_branches: { r: 'main' } } } });
  assert.equal(ok.fields.branch, 'main');
  const absent = PACK.extract(ep, { response_shape: { external_metadata: {} } });
  assert.deepEqual(absent.fields, { branch: null });
  assert.deepEqual(absent.drift, []);
  const gone = PACK.extract(ep, { response_shape: {} });
  assert.equal(gone.fields, null);
  assert.equal(gone.drift.length, 1);
});

test('normalize clamps, falls back, and keeps emoji glyphs whole', () => {
  const n = CONFIG.normalize({
    fontSize: 99, thresholds: { warn: 80, crit: 50 }, colors: { ok: 'red', warn: '#abc' },
    bar: { filled: '🟩x', width: 3.6 }, fields: [{ id: 'sevenDay' }, { id: 'bogus' }, { id: 'sevenDay' }],
  });
  assert.equal(n.fontSize, 18);
  assert.equal(n.thresholds.crit, 80);
  assert.equal(n.colors.ok, CONFIG.DEFAULTS.colors.ok);
  assert.equal(n.colors.warn, '#abc');
  assert.equal(n.bar.filled, '🟩');
  assert.equal(n.bar.width, 4);
  assert.deepEqual(n.fields.map((f) => f.id), ['sevenDay', 'branch', 'fiveHour']);
  assert.deepEqual(CONFIG.normalize(null), CONFIG.normalize({}));
});

test('defaults() is a private copy', () => {
  const d = CONFIG.defaults();
  d.colors.ok = '#000000';
  assert.notEqual(CONFIG.DEFAULTS.colors.ok, '#000000');
});

test('render helpers', () => {
  const cfg = CONFIG.normalize({});
  assert.equal(RENDER.progressBar(50, cfg), '█████░░░░░');
  assert.equal(RENDER.progressBar(null, cfg), '░░░░░░░░░░');
  assert.equal(RENDER.formatPct(42.5), '43%');
  assert.equal(RENDER.colorFor(95, cfg), cfg.colors.crit);
  assert.equal(RENDER.colorFor(75, cfg), cfg.colors.warn);
  assert.equal(RENDER.colorFor(10, cfg), cfg.colors.ok);
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(RENDER.resetsIn('2026-10-01T02:10:00Z', 'relative', now), 'resets 2h 10m');
  assert.equal(RENDER.resetsIn('2026-10-04T04:00:00Z', 'relative', now), 'resets 3d 4h');
  assert.equal(RENDER.resetsIn('2026-09-30T00:00:00Z', 'relative', now), 'resetting');
  assert.equal(RENDER.resetsIn('garbage', 'relative', now), '');
  assert.equal(RENDER.resetsIn(null, 'relative', now), '');
});
