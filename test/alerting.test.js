import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { bindLib, buildMail, evaluate, parisOffset, plan, toParis, MAX_REMINDERS, REMIND_MS } from '../src/alerting.js';

const sandbox = { self: {}, Intl, Date, Math, Number, Infinity, isFinite };
vm.runInNewContext(readFileSync(new URL('../public/lib.js', import.meta.url), 'utf8'), sandbox);
const WM = sandbox.self.WM;
bindLib(WM);
const H = 3600e3, DAY = 24 * H;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('heure de Paris : décalage identique à Intl, y compris aux passages à l\'heure d\'été et d\'hiver', () => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const real = (t) => { const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000; };
  let n = 0;
  for (let y = 2024; y <= 2032; y++) {
    for (const [m, d0] of [[2, 25], [9, 25]]) {        // fin mars, fin octobre : 8 jours, toutes les 15 minutes
      for (let t = Date.UTC(y, m, d0); t < Date.UTC(y, m, d0 + 8); t += 15 * 60e3) { assert.equal(parisOffset(t), real(t), new Date(t).toISOString()); n++; }
    }
    for (let k = 0; k < 400; k++) { const t = Date.UTC(y, 0, 1) + Math.floor(((k * 7919) % 36500) / 100 * DAY); assert.equal(parisOffset(t), real(t)); n++; }
  }
  assert.ok(n > 5000);
  assert.equal(toParis(Date.UTC(2026, 6, 1, 10)), Date.UTC(2026, 6, 1, 12));
  assert.equal(toParis(Date.UTC(2026, 0, 1, 10)), Date.UTC(2026, 0, 1, 11));
});

const alert = (key, level = 'critical', text = 'texte') => ({ key, level, code: key.split('|')[1], meter: 'Arrosage', text });
const state = (o = {}) => ({ level: 'critical', meter: 'Arrosage', text: 'texte', first_at: 0, last_sent_at: 0, sent_count: 1, clear_runs: 0, ...o });

test('plan : nouvelle alerte -> un mail, puis silence, rappel après 24 h (3 au plus), rétablissement après 2 contrôles', () => {
  const states = new Map();
  const apply = (ops) => { for (const o of ops) { if (o.op === 'del') states.delete(o.key); else { const { op, key, ...v } = o; states.set(key, v); } } };
  let now = 1e12, r;
  const A = [alert('v|stale')];
  r = plan(A, states, now); assert.deepEqual(r.events.map((e) => e.type), ['new']); apply(r.ops);
  r = plan(A, states, now += H); assert.equal(r.events.length, 0, 'pas de second mail dans l\'heure');
  r = plan(A, states, now += 22 * H); assert.equal(r.events.length, 0, 'ni avant 24 h');
  const sent = [];
  for (let i = 0; i < 12; i++) { now += REMIND_MS; r = plan(A, states, now); apply(r.ops); sent.push(...r.events.map((e) => e.type)); }
  assert.deepEqual(sent, Array(MAX_REMINDERS).fill('remind'), 'trois rappels au plus, puis plus rien');
  r = plan([], states, now += H); assert.equal(r.events.length, 0, 'un seul contrôle sans l\'alerte : pas encore rétablie'); apply(r.ops);
  r = plan([], states, now += H); assert.deepEqual(r.events.map((e) => e.type), ['resolved']); apply(r.ops);
  assert.equal(states.size, 0);
  r = plan([], states, now += H); assert.equal(r.events.length, 0 + 0);
});

test('plan : une alerte qui disparaît un instant puis revient ne renvoie pas de mail', () => {
  const states = new Map([['v|quiet', state({ last_sent_at: 1e12 })]]);
  let r = plan([], states, 1e12 + H);
  assert.equal(r.events.length, 0);
  states.set('v|quiet', { ...states.get('v|quiet'), clear_runs: 1 });
  r = plan([alert('v|quiet')], states, 1e12 + 2 * H);
  assert.equal(r.events.length, 0);
  assert.equal(r.ops[0].clear_runs, 0);
});

test('plan : deux alertes indépendantes, une nouvelle et une rétablie dans le même mail', () => {
  const states = new Map([['v|a', state({ last_sent_at: 1e12, clear_runs: 1 })]]);
  const r = plan([alert('v|b', 'serious')], states, 1e12 + H);
  assert.deepEqual(r.events.map((e) => e.type).sort(), ['new', 'resolved']);
  const m = buildMail(r.events, 1e12 + H, 'https://eau.example');
  assert.match(m.subject, /^\[Eau\] Alerte importante — Arrosage \(et rétablissement\)$/);
  assert.match(m.body, /NOUVELLE ALERTE — Importante — Arrosage/);
  assert.match(m.body, /RÉTABLIE — Critique — Arrosage/);
  assert.match(m.body, /https:\/\/eau\.example\/#synthese/);
});

test('mail : objet selon le nombre et la gravité', () => {
  const t = 1e12;
  assert.equal(buildMail([{ type: 'new', ...alert('v|a') }], t, 'u').subject, '[Eau] Alerte critique — Arrosage');
  const two = [{ type: 'new', ...alert('v|a', 'serious') }, { type: 'new', ...alert('w|b', 'critical'), meter: 'Eau potable' }];
  assert.equal(buildMail(two, t, 'u').subject, '[Eau] 2 alertes (critique) — Arrosage, Eau potable');
  assert.equal(buildMail([{ type: 'resolved', ...alert('v|a'), since: t - 5 * H }], t, 'u').subject, '[Eau] Alerte rétablie — Arrosage');
  const rem = buildMail([{ type: 'remind', ...alert('v|a'), since: t - 3 * DAY, n: MAX_REMINDERS }], t, 'u');
  assert.match(rem.body, /RAPPEL \(alerte active depuis 3 j/);
  assert.match(rem.body, /Dernier rappel/);
});

/* ---- Même résultat que dans le navigateur (heure de Paris), alors que le Worker est en UTC ---- */

const SCENARIO = `
  import { readFileSync } from 'node:fs';
  import vm from 'node:vm';
  const sb = { self: {}, Intl, Date, Math, Number, Infinity, isFinite };
  vm.runInNewContext(readFileSync(process.argv[1], 'utf8'), sb);
  const WM = sb.self.WM;
  const mode = process.argv[2], now = Number(process.argv[3]), H = 3600e3;
  // arrosage : 8 L/h la nuit (22 h-6 h Paris), un jet de 55 L en journée sur les deux derniers relevés, dernier relevé 7 h avant 'now'
  const par = (t) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' }).formatToParts(t); return Number(p.find((x) => x.type === 'hour').value); };
  const last = now - 7 * H;
  const readings = []; let v = 5000;
  for (let t = last - 40 * 24 * H; t <= last; t += 2 * H) {
    const h = par(t + 2 * H);
    v += (h >= 22 || h < 6 ? 16 : 0) + (t > last - 4 * H ? 55 : 0);
    readings.push({ ts: t, value: v });
  }
  const cfg = WM.mergeCfg(null);
  let out;
  if (mode === 'browser') {
    out = [];
    for (const m of cfg.meters) {
      const rs = WM.toReadings(readings.map((r) => ({ time: r.ts, value: r.value })), 1);
      for (const a of WM.evaluateMeter(m, cfg.site, rs, WM.toIntervals(rs), now)) if (a.level === 'critical' || a.level === 'serious') out.push([m.variable + '|' + a.code, a.text]);
    }
  } else {
    const { bindLib, evaluate } = await import(process.argv[4]);
    bindLib(WM);
    out = evaluate(cfg, { index_eau_1: readings, index_eau_2: readings }, now).map((a) => [a.key, a.text]);
  }
  console.log(JSON.stringify(out));
`;
const run = (tz, mode, now) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', SCENARIO, new URL('../public/lib.js', import.meta.url).pathname, mode, String(now), new URL('../src/alerting.js', import.meta.url).href],
  { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));

for (const [label, now, exact] of [
  ['été, après-midi', Date.UTC(2026, 6, 15, 14, 5), true],
  ['hiver, matin', Date.UTC(2026, 0, 20, 9, 40), true],
  ['début de mois, 1 h du matin', Date.UTC(2026, 7, 1, 0, 30), true],
  ['lendemain du passage à l\'heure d\'été', Date.UTC(2026, 2, 30, 15, 0), false],
  ['lendemain du passage à l\'heure d\'hiver', Date.UTC(2026, 9, 26, 15, 0), false],
]) {
  test(`mêmes alertes que le navigateur (Europe/Paris) — ${label}`, () => {
    const browser = run('Europe/Paris', 'browser', now);
    const worker = run('UTC', 'worker', now);
    assert.ok(browser.length >= 2, 'le scénario doit produire des alertes : ' + JSON.stringify(browser));
    if (exact) assert.deepEqual(worker, browser);
    else assert.deepEqual(worker.map((x) => x[0]), browser.map((x) => x[0]));   // aux changements d'heure, une durée peut différer d'une heure
  });
}
