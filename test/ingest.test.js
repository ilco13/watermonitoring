import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngest, parseTime, parseNumber } from '../src/ingest.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');

test('format TagoIO : objet seul, tableau, valeur texte', () => {
  const r = parseIngest([
    { variable: 'index_1', value: 123.4, time: '2026-11-22T10:00:00Z' },
    { variable: 'index_2', value: '45,6', time: '2026-11-22T10:00:00Z', unit: 'm3', metadata: { a: 1 } },
  ], NOW);
  assert.equal(r.points.length, 2);
  assert.deepEqual(r.points[0], { variable: 'index_1', ts: Date.parse('2026-11-22T10:00:00Z'), value: 123.4, source: 'auto' });
  assert.equal(r.points[1].value, 45.6);
  assert.equal(parseIngest({ variable: 'x', value: 1 }, NOW).points[0].ts, NOW); // sans heure : heure de réception
});

test('message de données Live Objects : champs décodés de "value"', () => {
  const r = parseIngest({
    streamId: 'urn:lo:nsid:mqtt:device1', timestamp: '2026-11-22T10:00:00.000Z', model: 'pulse',
    value: { index_1: 12, index_2: 7.5, status: 'OK', nested: { c: 3 }, flag: true }, tags: ['x'],
  }, NOW);
  const byVar = Object.fromEntries(r.points.map((p) => [p.variable, p.value]));
  assert.deepEqual(byVar, { index_1: 12, index_2: 7.5, 'nested.c': 3 });
  assert.equal(r.ignored, 2); // 'status' (texte) et 'flag' (booléen)
  assert.ok(r.points.every((p) => p.ts === Date.parse('2026-11-22T10:00:00.000Z')));
});

test('objet plat et enveloppe {result: [...]}', () => {
  const flat = parseIngest({ time: '2026-11-22T10:00:00Z', index_1: 5, index_2: 6 }, NOW);
  assert.deepEqual(flat.points.map((p) => p.variable), ['index_1', 'index_2']);
  const wrapped = parseIngest({ result: [{ variable: 'a', value: 1 }] }, NOW);
  assert.equal(wrapped.points.length, 1);
});

test('contenu inexploitable : aucun point, jamais d\'exception', () => {
  for (const bad of [null, undefined, 42, 'texte', [], {}, [null, 3, 'x'], { value: { a: 'abc' } }]) {
    assert.equal(parseIngest(bad, NOW).points.length, 0);
  }
});

test('parseTime / parseNumber', () => {
  assert.equal(parseTime(1763805600, 0), 1763805600000);        // secondes
  assert.equal(parseTime(1763805600000, 0), 1763805600000);     // millisecondes
  assert.equal(parseTime('1763805600', 0), 1763805600000);
  assert.equal(parseTime('n importe quoi', 7), 7);
  assert.equal(parseNumber('1 2'), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(Infinity), null);
  assert.equal(parseNumber('0'), 0);
});

test('plafond de points par requête', () => {
  const big = Array.from({ length: 6000 }, (_, i) => ({ variable: 'v', value: i, time: i + 1e12 }));
  assert.ok(parseIngest(big, NOW).points.length <= 5000);
});

test('Adeunis Pulse : genericSensor, message direct, imbriqué, ou en texte JSON', () => {
  const msg = { streamId: 'urn:lo:nsid:mqtt:x', timestamp: '2026-11-22T10:00:00Z', model: 'pulse',
    value: { genericSensor: { 0: { sensorType: 'counter', sensorValue: 1234 }, 1: { sensorValue: '567' } }, battery: 3.6 } };
  const expected = [
    { variable: 'index_eau_1', ts: Date.parse('2026-11-22T10:00:00Z'), value: 1234, source: 'auto' },
    { variable: 'index_eau_2', ts: Date.parse('2026-11-22T10:00:00Z'), value: 567, source: 'auto' },
  ];
  assert.deepEqual(parseIngest(msg, NOW).points, expected);
  // enveloppe TagoIO : variable "payload" dont la valeur est le message en texte
  assert.deepEqual(parseIngest([{ variable: 'payload', value: JSON.stringify(msg) }], NOW).points
    .map((p) => [p.variable, p.value]), [['index_eau_1', 1234], ['index_eau_2', 567]]);
  // sans "value" intermédiaire, et heure absente -> heure de réception
  const bare = parseIngest({ genericSensor: { 0: { sensorValue: 1 } } }, NOW).points;
  assert.deepEqual(bare, [{ variable: 'index_eau_1', ts: NOW, value: 1, source: 'auto' }]);
  // voie sans sensorValue numérique : ignorée, pas d'exception
  const r = parseIngest({ genericSensor: { 0: { sensorValue: 'n/a' } } }, NOW);
  assert.equal(r.points.length, 0);
  assert.equal(r.ignored, 2);
});

test('message Live Objects réel (Adeunis Pulse, connecteur lwm2m)', () => {
  const msg = {
    metadata: { connector: 'lwm2m', source: 'urn:lo:nsid:imei:355025930044829', group: { path: '/', id: 'root' }, network: { lwm2m: { ep: 'urn:imei:355025930044829' } } },
    streamId: 'urn:lo:nsid:imei:355025930044829', created: '2026-11-22T09:29:22.772Z', extra: {}, location: null,
    model: 'twin_json', id: '6b02b5f25e4a241fdf9bc24d',
    value: { genericSensor: { 0: { sensorValue: 1574894 }, 1: { sensorValue: 668411 } } },
    timestamp: '2026-11-22T09:29:19Z', tags: [],
  };
  const r = parseIngest(msg, NOW);
  // l'heure retenue est celle du compteur (timestamp), pas celle de réception par Live Objects (created)
  assert.deepEqual(r.points, [
    { variable: 'index_eau_1', ts: Date.parse('2026-11-22T09:29:19Z'), value: 1574894, source: 'auto' },
    { variable: 'index_eau_2', ts: Date.parse('2026-11-22T09:29:19Z'), value: 668411, source: 'auto' },
  ]);
  assert.equal(r.ignored, 0);
  // même message sans "timestamp" : repli sur "created"
  const { timestamp, ...noTs } = msg;
  assert.equal(parseIngest(noTs, NOW).points[0].ts, Date.parse('2026-11-22T09:29:22.772Z'));
});

test('origine du relevé : « manual » conservé au format TagoIO, tout le reste est « auto »', () => {
  const r = parseIngest([
    { variable: 'index_eau_1', value: 1, time: '2026-07-30T07:14:00Z', source: 'manual' },
    { variable: 'index_eau_1', value: 2, time: '2026-07-30T09:14:00Z', source: 'auto' },
    { variable: 'index_eau_1', value: 3, time: '2026-07-30T11:14:00Z', source: 'nimporte quoi' },
    { variable: 'index_eau_1', value: 4, time: '2026-07-30T13:14:00Z' },
  ]);
  assert.deepEqual(r.points.map((p) => p.source), ['manual', 'auto', 'auto', 'auto']);
  // un message Live Objects ne peut pas se déclarer manuel
  assert.equal(parseIngest({ source: 'manual', genericSensor: { 0: { sensorValue: 5 } } }).points[0].source, 'auto');
});
