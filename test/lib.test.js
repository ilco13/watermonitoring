import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// lib.js est un script navigateur (UMD) : on l'exécute comme tel, sans module.exports
const sandbox = { self: {}, Intl, Date, Math, Number, Infinity, isFinite };
vm.runInNewContext(readFileSync(new URL('../public/lib.js', import.meta.url), 'utf8'), sandbox);
const WM = sandbox.self.WM;
const plain = (x) => JSON.parse(JSON.stringify(x)); // tableaux issus du contexte vm -> tableaux ordinaires
const H = 3600e3;
const DAYMS = 24 * H;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

// relevés toutes les 2 h avec un débit constant de 10 L/h
// (pas de 2 h en ms, ancré sur `to` : insensible aux changements d'heure)
function constantFlow(from, to, lph, stepH = 2) {
  const n = Math.floor((to - from) / (stepH * H));
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ t: to - (n - i) * stepH * H, v: 1000 + i * lph * stepH });
  return out;
}

test('toReadings : conversion en litres, tri, doublons et valeurs invalides', () => {
  const r = WM.toReadings([
    { time: '2026-01-01T02:00:00Z', value: '12.5' },
    { time: '2026-01-01T00:00:00Z', value: 12.0 },
    { time: '2026-01-01T00:00:00Z', value: 12.0 },
    { time: 'pas une date', value: 1 },
    { time: '2026-01-01T04:00:00Z', value: null },
  ], 1000);
  assert.deepEqual(plain(r.map((x) => x.v)), [12000, 12500]);
});

test('bucketize : répartition au prorata du temps, aucun litre perdu', () => {
  // 100 L entre 23:00 et 03:00 : 25 L avant minuit, 75 L après
  const iv = [{ t0: at(2026, 3, 1, 23), t1: at(2026, 3, 2, 3), d: 100 }];
  const [a, b] = WM.bucketize(iv, [at(2026, 3, 1), at(2026, 3, 2), at(2026, 3, 3)]);
  assert.ok(Math.abs(a - 25) < 1e-9);
  assert.ok(Math.abs(b - 75) < 1e-9);
});

test('bucketize : intervalle à cheval sur plusieurs périodes et hors fenêtre', () => {
  const iv = [{ t0: at(2026, 3, 1), t1: at(2026, 3, 5), d: 400 }]; // 100 L/jour
  const res = WM.bucketize(iv, [at(2026, 3, 2), at(2026, 3, 3), at(2026, 3, 4)]);
  assert.deepEqual(plain(res.map(Math.round)), [100, 100]);
  assert.equal(WM.total(iv, at(2026, 4, 1), at(2026, 4, 2)), 0);
});

test('toIntervals : un index qui recule est signalé et ignoré', () => {
  const iv = WM.toIntervals([{ t: 0, v: 100 }, { t: H, v: 110 }, { t: 2 * H, v: 5 }, { t: 3 * H, v: 15 }]);
  assert.deepEqual(plain(iv.map((x) => x.d)), [10, 0, 10]);
  assert.deepEqual(plain(iv.map((x) => x.reset)), [false, true, false]);
});

test('summarize : totaux jour / mois / année pour un débit constant', () => {
  const now = at(2026, 6, 15, 12);
  const readings = constantFlow(at(2025, 1, 1), now, 10); // 10 L/h => 240 L/jour
  const s = WM.summarize(readings, WM.toIntervals(readings), now);
  assert.ok(Math.abs(s.today - 12 * 10) < 1);              // 12 h écoulées
  assert.ok(Math.abs(s.yesterday - 240) < 1);
  assert.ok(Math.abs(s.avg7 - 240) < 1);
  assert.ok(Math.abs(s.month - (14 * 240 + 120)) < 1);      // 14 jours pleins + 12 h
  // depuis le 1er janvier 00:00 local, en heures réellement écoulées (le passage à l'heure d'été en retire une)
  assert.ok(Math.abs(s.year - (now - at(2026, 1, 1)) / H * 10) < 1);
  assert.ok(Math.abs(s.yearVs) < 1);                        // même débit l'an dernier : ~0 %
});

test('edgesHours / edgesBack : bornes croissantes, bon nombre de cases', () => {
  const e = WM.edgesHours(at(2026, 6, 15, 13, 30), 24, 2);
  assert.equal(e.length, 25);
  assert.equal(new Date(e[24]).getHours(), 14);
  assert.ok(e.every((t, i) => i === 0 || t > e[i - 1]));
  const d = WM.edgesBack(at(2026, 6, 15, 13), 30, 'day');
  assert.equal(d.length, 31);
  assert.equal(d[30], at(2026, 6, 16));
});

test('alertes : fuite = écoulement sans interruption', () => {
  const now = at(2026, 6, 15, 12);
  const mk = (flowFn) => {
    const r = []; let v = 0;
    for (let t = now - 48 * H; t <= now; t += 2 * H) { v += flowFn(t); r.push({ t, v }); }
    return { r, iv: WM.toIntervals(r) };
  };
  const cfg = { dailyLimitL: 0, leakHours: 24, staleHours: 6 };
  const normal = mk((t) => (new Date(t).getHours() < 6 ? 0 : 30)); // nuits à zéro
  assert.equal(WM.evaluateAlerts(cfg, normal.r, normal.iv, now).filter((a) => a.code === 'leak').length, 0);
  const leak = mk((t) => (t > now - 30 * H ? 6 : 0));              // 3 L/h pendant 30 h
  const al = WM.evaluateAlerts(cfg, leak.r, leak.iv, now).find((a) => a.code === 'leak');
  assert.ok(al, 'fuite détectée');
  assert.equal(al.level, 'serious');
});

test('alertes : seuil journalier, débit de pointe, relevés manquants', () => {
  const now = at(2026, 6, 15, 12);
  const r = constantFlow(now - 72 * H, now, 100);   // 100 L/h => 2400 L/jour, 200 L / 2 h
  const iv = WM.toIntervals(r);
  const codes = WM.evaluateAlerts({ dailyLimitL: 1000, maxFlowLph: 50, staleHours: 6 }, r, iv, now).map((a) => a.code);
  assert.ok(codes.includes('daily'));
  assert.ok(codes.includes('burst'));
  const stale = WM.evaluateAlerts({ staleHours: 6 }, r, iv, now + 10 * H).map((a) => a.code);
  assert.ok(stale.includes('stale'));
  assert.equal(WM.evaluateAlerts({}, [], [], now)[0].code, 'nodata');
});

test('weeklyProfile : un jour sur 7 et 12 tranches, la somme est conservée', () => {
  const now = at(2026, 6, 15, 12);
  const r = constantFlow(now - 40 * 24 * H, now, 10);
  const p = WM.weeklyProfile(WM.toIntervals(r), now, 4);
  assert.equal(p.length, 7);
  assert.ok(p.every((row) => row.length === 12));
  assert.ok(p.flat().every((x) => Math.abs(x - 20) < 1e-6)); // 10 L/h => 20 L par tranche de 2 h, partout
});

test('formats français', () => {
  assert.equal(WM.fmtVolume(0), '0 L');
  assert.equal(WM.fmtVolume(5.5), '5,5 L');
  assert.equal(WM.fmtVolume(1500), '1,5 m³');
  assert.equal(WM.fmtVolume(25000), '25 m³');
  assert.equal(WM.fmtDuration(90 * 60e3), '1 h 30');
});

test('règles de débit : des relevés rapprochés ne créent ni débit absurde ni faux arrêt', () => {
  const now = at(2026, 6, 15, 12);
  // relevé toutes les 2 h, 10 L/h, sauf un doublon 2 s après chaque relevé de 8 h, avec 1 L d'écart (rejeu)
  const r = [];
  let v = 1000;
  for (let t = now - 48 * H; t <= now; t += 2 * H) {
    v += 20; r.push({ t, v });
    if (new Date(t).getHours() === 8) r.push({ t: t + 2000, v: v + 1 });
  }
  const iv = WM.toIntervals(r);
  const codes = WM.evaluateAlerts({ maxFlowLph: 500, leakHours: 24, staleHours: 6 }, r, iv, now).map((a) => a.code);
  assert.ok(!codes.includes('burst'), 'pas de « débit élevé » dû aux relevés à 2 s d\'écart');
  assert.ok(codes.includes('leak'), 'la fuite continue reste détectée malgré un intervalle de 2 s à 0 L');
  // même série, mais un doublon à l'identique (0 L en 2 s) ne doit pas couper la série
  const dup = []; for (const x of r) { dup.push(x); dup.push({ t: x.t + 1500, v: x.v }); }
  assert.ok(WM.evaluateAlerts({ leakHours: 24 }, dup, WM.toIntervals(dup), now).some((a) => a.code === 'leak'));
});

test('débit de fond : hausse du minimum nocturne détectée, usage normal ignoré', () => {
  const now = at(2026, 6, 15, 12);
  const series = (floorLph) => {
    const r = []; let v = 0;
    for (let t = now - 20 * DAYMS; t <= now; t += 2 * H) {
      const h = new Date(t).getHours();
      const lph = h >= 1 && h < 5 ? (t > now - 30 * H ? floorLph : 4) : 120; // nuit calme, jour actif
      v += lph * 2; r.push({ t, v });
    }
    return r;
  };
  const cfg = { baseFlowRatio: 2, baseFlowMinLph: 20, staleHours: 6 };
  const normal = series(4);
  assert.ok(!WM.evaluateAlerts(cfg, normal, WM.toIntervals(normal), now).some((a) => a.code === 'baseflow'));
  // le fond monte à 40 L/h partout dans la fenêtre de 24 h : fuite probable
  const leak = []; { let v = 0; for (let t = now - 20 * DAYMS; t <= now; t += 2 * H) { v += (t > now - 30 * H ? 40 : (new Date(t).getHours() >= 1 && new Date(t).getHours() < 5 ? 4 : 120)) * 2; leak.push({ t, v }); } }
  const al = WM.evaluateAlerts(cfg, leak, WM.toIntervals(leak), now).find((a) => a.code === 'baseflow');
  assert.ok(al && al.level === 'serious');
  assert.equal(WM.evaluateAlerts({ ...cfg, baseFlowRatio: 0 }, leak, WM.toIntervals(leak), now).some((a) => a.code === 'baseflow'), false);
});

test('comparaison N-1 : absente si la période de référence précède le premier relevé', () => {
  const now = at(2026, 6, 15, 12);
  const short = constantFlow(at(2026, 1, 5), now, 10); // premier relevé en 2026
  const s = WM.summarize(short, WM.toIntervals(short), now);
  assert.equal(s.yearVs, null);            // 2025 n'existe pas
  assert.notEqual(s.monthVs, null);        // mai 2026 est couvert
  const long = constantFlow(at(2025, 1, 1), now, 10);
  assert.notEqual(WM.summarize(long, WM.toIntervals(long), now).yearVs, null);
});

test('part estimée : relevés manuels espacés vs relevés toutes les 2 h', () => {
  const now = at(2026, 6, 15, 12);
  const manual = [{ t: at(2026, 1, 1, 10), v: 0 }, { t: at(2026, 3, 1, 10), v: 5900 }]; // 2 mois sans relevé
  const dense = constantFlow(at(2026, 3, 1, 10), now, 10);
  const iv = WM.toIntervals(manual.concat(dense.slice(1).map((r) => ({ t: r.t, v: 5900 + (r.v - 1000) }))));
  const edges = WM.edgesBack(now, 6, 'month'); // janv. .. juin
  const share = WM.estimatedShare(iv, edges);
  assert.ok(share[0] > 0.99 && share[1] > 0.99, 'janvier et février : estimés');
  assert.ok(share[3] < 0.01 && share[4] < 0.01, 'avril et mai : mesurés');
});

test('périodes calendaires : jour, semaine (lundi), mois ; glissantes ancrées sur le dernier relevé', () => {
  const wed = at(2026, 11, 18, 15, 40); // mercredi
  const day = WM.edgesCalendar(wed, 'day');
  assert.equal(day.length, 13);
  assert.equal(day[0], at(2026, 11, 18)); assert.equal(day[12], at(2026, 11, 19));
  const week = WM.edgesCalendar(wed, 'week');
  assert.equal(week.length, 8);
  assert.equal(week[0], at(2026, 11, 16)); assert.equal(new Date(week[0]).getDay(), 1); // lundi
  assert.equal(week[7], at(2026, 11, 23));
  const month = WM.edgesCalendar(wed, 'month');
  assert.equal(month.length, 31); // 30 jours en novembre + borne finale
  assert.equal(month[0], at(2026, 11, 1)); assert.equal(month[30], at(2026, 12, 1));
  assert.equal(WM.edgesCalendar(at(2026, 2, 10), 'month').length, 29);           // février 2026 : 28 jours
  assert.equal(WM.edgesCalendar(at(2026, 3, 29, 12), 'day').length, 13);          // jour de passage à l'heure d'été
  assert.ok(WM.edgesCalendar(at(2026, 3, 29, 12), 'day').every((x, i, a) => i === 0 || x > a[i - 1]));
  // dimanche : la semaine commence bien le lundi précédent
  assert.equal(WM.edgesCalendar(at(2026, 11, 22, 9), 'week')[0], at(2026, 11, 16));
  const roll = WM.edgesRolling(wed, 7, 24 * H);
  assert.equal(roll.length, 8); assert.equal(roll[7], wed); assert.equal(roll[0], wed - 7 * 24 * H);
});

test('fenêtres glissantes du résumé : 24 h, 7 jours, 30 jours', () => {
  const now = at(2026, 6, 15, 12);
  const r = constantFlow(at(2026, 4, 1), now, 10); // 240 L / jour
  const s = WM.summarize(r, WM.toIntervals(r), now);
  assert.ok(Math.abs(s.roll24 - 240) < 1);
  assert.ok(Math.abs(s.roll7 - 7 * 240) < 1);
  assert.ok(Math.abs(s.roll30 - 30 * 240) < 1);
});
