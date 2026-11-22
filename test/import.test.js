import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExport, parseCsv, timeOf } from '../scripts/import-lib.mjs';
import { parseIngest } from '../src/ingest.js';

const LO = (ts, a, b) => ({ streamId: 'urn:lo:nsid:imei:355025930044829', timestamp: ts, model: 'twin_json', value: { genericSensor: { 0: { sensorValue: a }, 1: { sensorValue: b } } }, tags: [] });
const points = (items) => parseIngest(items).points.map((p) => [p.variable, p.value]);

test('TagoIO : tableau JSON, enveloppe {result}, CSV à séparateur ;', () => {
  const rows = [{ variable: 'index_eau_1', value: 10, time: '2026-09-04T00:00:00Z' }, { variable: 'index_eau_1', value: '', time: '2026-09-04T02:00:00Z' }];
  assert.equal(parseExport(JSON.stringify(rows), 'x.json').items.length, 1);
  assert.equal(parseExport(JSON.stringify({ result: rows }), 'x.json').items.length, 1);
  const csv = 'time;variable;unit;value\n2026-09-04T00:00:00Z;index_eau_1;L;10\n2026-09-04T02:00:00Z;index_eau_2;L;5';
  const r = parseExport(csv, 'x.csv');
  assert.deepEqual(r.items.map((i) => [i.variable, i.value]), [['index_eau_1', '10'], ['index_eau_2', '5']]);
});

test('Live Objects : tableau de messages, enveloppes, _source, lignes JSON', () => {
  const m = [LO('2026-09-03T10:00:00Z', 100, 50), LO('2026-09-03T12:00:00Z', 110, 50)];
  for (const [label, text] of [
    ['tableau', JSON.stringify(m)],
    ['{hits}', JSON.stringify({ hits: m })],
    ['hits.hits', JSON.stringify({ hits: { hits: m } })],
    ['_source', JSON.stringify(m.map((x) => ({ _id: 'a', _source: x })))],
    ['NDJSON', m.map((x) => JSON.stringify(x)).join('\n')],
  ]) {
    const r = parseExport(text, 'export.json');
    assert.equal(r.items.length, 2, label);
    assert.deepEqual(points(r.items), [['index_eau_1', 100], ['index_eau_2', 50], ['index_eau_1', 110], ['index_eau_2', 50]], label);
  }
});

test('Live Objects : CSV avec le message en JSON dans la colonne value', () => {
  const v = (a, b) => JSON.stringify(LO('x', a, b).value).replace(/"/g, '""');
  const csv = `timestamp,streamId,value\n2026-09-03T10:00:00Z,urn:lo:nsid:imei:1,"${v(100, 50)}"\n2026-09-03T12:00:00Z,urn:lo:nsid:imei:1,"${v(110, 51)}"`;
  const r = parseExport(csv, 'lo.csv');
  assert.equal(r.items.length, 2);
  const pts = parseIngest(r.items).points;
  assert.deepEqual(pts.map((p) => [p.variable, p.value]), [['index_eau_1', 100], ['index_eau_2', 50], ['index_eau_1', 110], ['index_eau_2', 51]]);
  assert.equal(pts[0].ts, Date.parse('2026-09-03T10:00:00Z'), "l'heure du CSV est conservée");
});

test('période : --after inclus, --before exclu ; sans heure = écarté quand une borne est donnée', () => {
  const m = [LO('2026-09-03T10:00:00Z', 1, 1), LO('2026-09-20T10:00:00Z', 2, 2), LO('2026-10-01T01:30:00Z', 3, 3), { genericSensor: { 0: { sensorValue: 4 } } }];
  const txt = JSON.stringify(m);
  assert.equal(parseExport(txt, 'a.json').items.length, 4);
  const r = parseExport(txt, 'a.json', { before: Date.parse('2026-10-01T01:30:00Z') });
  assert.deepEqual(r.items.map((i) => i.timestamp), ['2026-09-03T10:00:00Z', '2026-09-20T10:00:00Z']);
  assert.equal(r.outOfRange, 1); assert.equal(r.noTime, 1);
  assert.equal(parseExport(txt, 'a.json', { after: Date.parse('2026-09-20T10:00:00Z'), before: Date.parse('2026-10-01T00:00:00Z') }).items.length, 1);
});

test('entrées invalides : jamais d\'exception inattendue', () => {
  assert.throws(() => parseExport('{pas du json', 'x.json'), /illisible/);
  assert.deepEqual(parseExport('[]', 'x.json').items, []);
  assert.deepEqual(parseExport('[null, 3, "a"]', 'x.json').items, []);
  assert.deepEqual(parseCsv(''), []);
  assert.equal(timeOf({ time: 1795339759 }), 1795339759000);
  assert.equal(timeOf({}), null);
});
