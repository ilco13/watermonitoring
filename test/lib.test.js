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

test('profil horaire : tranches décalées pour coïncider avec les relevés (ex. 16 h 30 – 18 h 30)', () => {
  const day = at(2026, 6, 15);
  const mk = (minutes) => { const out = []; let v = 1000; for (let t = day - 30 * DAYMS + minutes * 60e3; t <= day + 5 * 3600e3; t += 2 * H) { out.push({ t, v }); v += 20; } return out; };
  assert.equal(WM.heatOffset(mk(10 * 60 + 29)), 30);            // relevés à 10 h 29, 12 h 29… : tranches 8 h 30 – 10 h 30
  assert.equal(WM.heatOffset(mk(11 * 60 + 29)), 90);            // en heure d'été le même compteur tombe sur des heures impaires
  assert.equal(WM.heatOffset(mk(10 * 60 + 2)), 0);              // relevés pile à l'heure
  assert.equal(WM.heatOffset(mk(10 * 60 + 29).slice(0, 2)), 0); // trop peu de relevés
  const irregular = [0, 47, 95, 20, 70, 110, 33, 5].map((m, i) => ({ t: day + i * 5 * H + m * 60e3, v: i }));
  assert.equal(WM.heatOffset(irregular), 0);                    // pas de rythme régulier
  const r = mk(10 * 60 + 29), end = r[r.length - 1].t;
  for (const off of [0, 30, 60, 90]) {
    const p = WM.weeklyProfile(WM.toIntervals(r), end, 4, off);
    assert.equal(p.length, 7);
    assert.ok(p.every((row) => row.length === 12));
    assert.ok(p.flat().every((x) => Math.abs(x - 20) < 1e-6), `décalage ${off} : 10 L/h => 20 L par tranche`);
  }
});

test('profil horaire décalé : un pic de consommation tombe dans la bonne tranche', () => {
  // 100 L consommés entre 8 h 30 et 10 h 30 chaque jour : avec le décalage de 30 min ils sont tous dans la colonne « 8 h 30 », sinon coupés en deux
  const iv = []; for (let d = 0; d < 35; d++) { const base = at(2026, 5, 1 + d); iv.push({ t0: base + (8 * 60 + 30) * 60e3, t1: base + (10 * 60 + 30) * 60e3, d: 100, reset: false }); }
  const end = at(2026, 6, 4, 23);
  const shifted = WM.weeklyProfile(iv, end, 4, 30), plain = WM.weeklyProfile(iv, end, 4, 0);
  assert.ok(shifted.every((row) => Math.abs(row[4] - 100) < 1e-6 && row.filter((_, c) => c !== 4).every((x) => x === 0)));
  assert.ok(plain.every((row) => row[4] < 100 && row[5] > 0));   // sans décalage la consommation est répartie sur deux cases
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

test('plage sans consommation : arrosage de nuit, une consommation en journée est suspecte', () => {
  const now = at(2026, 6, 15, 15, 0);
  const cfg = { quietFromH: 6, quietToH: 18, quietMaxL: 20, staleHours: 6 };
  // arrosage normal : 22 h -> 0 h (100 L / 2 h), rien le jour
  const mk = (extraAt) => {
    const r = []; let v = 0;
    for (let t = now - 48 * H; t <= now; t += 2 * H) {
      const h = new Date(t).getHours();
      v += (h === 22 ? 100 : 0) + (extraAt && t === extraAt ? 60 : 0);
      r.push({ t, v });
    }
    return { r, iv: null };
  };
  const codes = (x) => WM.evaluateAlerts(cfg, x.r, WM.toIntervals(x.r), now).map((a) => a.code);
  assert.ok(!codes(mk(null)).includes('quiet'), 'arrosage nocturne normal : pas d\'alerte');
  // 60 L pendant la tranche de 13 h à 15 h, dans les 24 h -> alerte
  const big = mk(now - 2 * H); // tranche 13h -> 15h, entièrement dans la plage
  assert.ok(codes(big).includes('quiet'), 'consommation de 60 L entre 13 h et 15 h : alerte');
  const al = WM.evaluateAlerts(cfg, big.r, WM.toIntervals(big.r), now).find((a) => a.code === 'quiet');
  assert.equal(al.level, 'serious');
  // sous le seuil (3 L) : ignoré ; règle désactivée si quietMaxL = 0
  const small = []; { let v = 0; for (let t = now - 48 * H; t <= now; t += 2 * H) { v += t === now - 2 * H ? 3 : 0; small.push({ t, v }); } }
  assert.ok(!WM.evaluateAlerts(cfg, small, WM.toIntervals(small), now).some((a) => a.code === 'quiet'));
  assert.ok(!WM.evaluateAlerts({ ...cfg, quietMaxL: 0 }, big.r, WM.toIntervals(big.r), now).some((a) => a.code === 'quiet'));
  // une tranche qui déborde de la plage (17 h -> 19 h, début de l'arrosage) n'est pas une alerte
  const edge = []; { let v = 0; const n2 = at(2026, 6, 15, 19, 30); for (let t = n2 - 48 * H; t <= n2; t += 2 * H) { v += new Date(t).getHours() === 19 ? 150 : 0; edge.push({ t, v }); } // relevé de 19 h 30 : consommation entre 17 h 30 et 19 h 30

    assert.ok(!WM.evaluateAlerts(cfg, edge, WM.toIntervals(edge), n2).some((a) => a.code === 'quiet'), 'tranche à cheval sur 18 h : ignorée'); }
});

test('prochain relevé attendu : dernier relevé automatique + période habituelle', () => {
  const t0 = at(2026, 6, 15, 8, 0);
  const auto = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 2 * H + (i % 3) * 20000, v: i * 20, src: 'auto' }));
  const n = WM.nextExpected(auto);
  assert.ok(Math.abs(n.period - 2 * H) < 60e3);
  assert.equal(n.anchor, auto[9].t);
  assert.ok(Math.abs(n.at - (auto[9].t + 2 * H)) < 60e3);
  // un relevé manuel plus récent ne décale pas l'horaire des relevés automatiques
  const withManual = auto.concat([{ t: auto[9].t + 30 * 60e3, v: 999, src: 'manual' }]);
  assert.equal(WM.nextExpected(withManual).anchor, auto[9].t);
  // doublons rapprochés (secondes) ignorés dans le calcul de la période
  const dup = []; for (const r of auto) { dup.push(r); dup.push({ t: r.t + 3000, v: r.v, src: 'auto' }); }
  assert.ok(Math.abs(WM.nextExpected(dup).period - 2 * H) < 60e3);
  // pas assez d'historique : rien
  assert.equal(WM.nextExpected(auto.slice(0, 3)), null);
  assert.equal(WM.nextExpected([]), null);
});

test('synthèse : semaine calendaire et fenêtres glissantes comparées à la précédente', () => {
  const now = at(2026, 6, 17, 12); // mercredi
  const r = constantFlow(at(2025, 1, 1), now, 10); // 240 L / jour partout
  const s = WM.summarize(r, WM.toIntervals(r), now);
  assert.ok(Math.abs(s.week - (2 * 240 + 12 * 10)) < 2, 'lundi, mardi + 12 h de mercredi');
  assert.ok(Math.abs(s.rolling.h24.cur - 240) < 1 && Math.abs(s.rolling.h24.prev - 240) < 1);
  assert.ok(Math.abs(s.rolling.d7.cur - 7 * 240) < 1 && Math.abs(s.rolling.d30.cur - 30 * 240) < 1);
  assert.ok(Math.abs(s.rolling.d365.cur - 365 * 240) < 5);
  assert.ok(Math.abs(s.rolling.d7.vs) < 1 && Math.abs(s.rolling.h24.vs) < 1, 'même débit : variation nulle');
  assert.equal(s.rolling.d365.partial, false);
  assert.equal(s.sparkRoll.length, 30);
  // historique court : pas de comparaison, et la fenêtre de 12 mois est signalée partielle
  const short = constantFlow(at(2026, 3, 1), now, 10); // ~108 jours : couvre 30 j + 30 j précédents, pas 12 mois
  const q = WM.summarize(short, WM.toIntervals(short), now);
  assert.equal(q.rolling.d365.partial, true);
  assert.equal(q.rolling.d365.vs, null);
  assert.equal(q.rolling.d30.vs !== null, true);
  assert.equal(q.weekVs !== null, true);
});

test('tendance par rapport à d\'habitude : plus, moins, pareil, inhabituel, historique insuffisant', () => {
  const end = at(2026, 6, 14, 16, 30); // dimanche
  // profil hebdomadaire : 10 L/h partout ; la dernière tranche (14 h 30 -> 16 h 30) est paramétrée
  const make = (lastFactor, weeks = 6, base = 10) => {
    const r = []; let v = 0;
    const start = end - weeks * 7 * 24 * H;
    for (let t = start; t <= end; t += 2 * H) {
      v += (t === end ? base * lastFactor : base) * 2; r.push({ t, v, src: 'auto' });
    }
    return r;
  };
  const trend = (readings) => WM.trendVsUsual(readings, WM.toIntervals(readings));
  let t = trend(make(1.5));
  assert.equal(t.level, 'up'); assert.ok(Math.abs(t.pct - 50) < 3, 'pct ' + t.pct); assert.equal(t.weeks, 4);
  assert.equal(trend(make(0.4)).level, 'down');
  assert.equal(trend(make(1.05)).level, 'same');
  // d'habitude presque rien (0,5 L/h), mais 30 L sur la tranche : inhabituel
  t = trend(make(60, 6, 0.5)); assert.equal(t.level, 'unusual');
  assert.equal(trend(make(1, 6, 0.5)).level, 'same');
  // pas assez de semaines comparables
  assert.equal(trend(make(1.5, 1)).level, 'unknown');
  // relevés manuels ignorés : un relevé manuel plus récent ne change pas la tranche mesurée
  const withManual = make(1.5).concat([{ t: end + 30 * 60e3, v: 99999, src: 'manual' }]);
  assert.equal(trend(withManual).t1, end);
  assert.equal(WM.trendVsUsual([], []), null);
});

/* ---------- Alertes adaptatives : les besoins augmentent, une fuite reste une fuite ---------- */

const SLOT_W = [0, 0, 0.01, 0.12, 0.12, 0.06, 0.10, 0.10, 0.09, 0.20, 0.15, 0.05];   // part de la consommation du jour par tranche de 2 h (0 h-2 h, 2 h-4 h…)
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
/**
 * Relevés toutes les 2 h (à :29) du 1er juin jusqu'à `days` jours après, avec une consommation faite de `peopleOn(jour)` × 150 L/jour,
 * un débit de fond de 1 L/h, du bruit, et des ajouts : extra(jour, tranche) litres dans la tranche.
 */
function gen({ days, peopleOn, extra = () => 0, floorExtra = () => 0, seed = 7 }) {
  const rand = rng(seed), out = []; let v = 5000;
  const start = at(2026, 6, 1);
  for (let d = 0; d < days; d++) {
    const dayF = 0.85 + 0.3 * rand();
    for (let k = 0; k < 12; k++) {
      const t0 = start + d * DAYMS + (2 * k * 60 + 29) * 60e3;
      if (d === 0 && k === 0) out.push({ t: t0 - 2 * H, v });
      const usage = peopleOn(d) * 150 * dayF * SLOT_W[k] * (0.8 + 0.4 * rand());
      v += usage + 2 + 2 * floorExtra(d) + extra(d, k);   // 2 L = 1 L/h de débit de fond sur la tranche
      out.push({ t: t0, v });
    }
  }
  return { readings: out, start };
}
const potable = (over = {}) => Object.assign({}, WM.mergeCfg(null).meters[0], over);
const SITE6 = { people: [{ from: '2026-01-01', n: 6 }], works: 0, events: [] };
const codes = (m, site, g, dayIdx, hour = 23) => {
  const now = g.start + dayIdx * DAYMS + hour * H + 40 * 60e3;
  const rs = g.readings.filter((r) => r.t <= now), iv = WM.toIntervals(rs);
  return plain(WM.evaluateMeter(m, site, rs, iv, now)).map((a) => a.code).sort();
};

test('adaptatif : consommation normale de 6 maisons habitées, aucune alerte, le niveau appris est le bon', () => {
  const g = gen({ days: 45, peopleOn: () => 6 });
  for (const d of [20, 30, 44]) assert.deepEqual(codes(potable(), SITE6, g, d), [], `jour ${d}`);
  const rs = g.readings, iv = WM.toIntervals(rs), now = g.start + 44 * DAYMS + 23 * H;
  const a = WM.adaptiveAssess(potable(), SITE6, rs, iv, now);
  assert.ok(a.ready);
  assert.ok(a.ref.v > 750 && a.ref.v < 1050, 'normale ≈ 900 L/jour : ' + a.ref.v);
  assert.ok(a.ref.f < 3, 'débit de fond normal ≈ 1 L/h : ' + a.ref.f);
});

test('adaptatif : hausse progressive des besoins (6 → 14 maisons habitées, jamais annoncée) : pas de fausse alerte', () => {
  const g = gen({ days: 90, peopleOn: (d) => 6 + 8 * Math.min(1, Math.max(0, (d - 20) / 60)) });
  for (let d = 25; d < 90; d += 3) assert.deepEqual(codes(potable(), SITE6, g, d), [], `jour ${d}`);
});

test('adaptatif : une hausse ANNONCÉE (6 → 14 maisons habitées d\'un coup) ne déclenche rien, la même hausse non annoncée oui', () => {
  const g = gen({ days: 60, peopleOn: (d) => (d < 40 ? 6 : 18) });          // ×3 d'un coup au jour 40
  const declared = { people: [{ from: '2026-01-01', n: 6 }, { from: '2026-07-11', n: 18 }], events: [] };   // jour 40 = 11 juillet
  for (const d of [40, 41, 45, 59]) assert.deepEqual(codes(potable(), declared, g, d), [], `annoncée, jour ${d}`);
  assert.ok(codes(potable(), SITE6, g, 41).includes('daily'), 'non annoncée : alerte de consommation');
  // elle ne devient pas « normale » toute seule : l'alerte dure
  assert.ok(codes(potable(), SITE6, g, 59).includes('daily'), 'toujours signalée 19 jours plus tard');
});

test('adaptatif : « c\'est le nouveau normal » remet l\'apprentissage à zéro à partir d\'un jour', () => {
  const g = gen({ days: 70, peopleOn: (d) => (d < 40 ? 6 : 18) });
  const m = potable({ since: '2026-07-12' });                                 // jour 41
  assert.deepEqual(codes(m, SITE6, g, 43), [], 'pendant l\'apprentissage (moins de 7 jours) : aucune alerte adaptative');
  for (const d of [50, 60, 69]) assert.deepEqual(codes(m, SITE6, g, d), [], `après apprentissage, jour ${d}`);
  const a = WM.adaptiveAssess(m, SITE6, g.readings.filter((r) => r.t <= g.start + 69 * DAYMS), WM.toIntervals(g.readings.filter((r) => r.t <= g.start + 69 * DAYMS)), g.start + 69 * DAYMS + 12 * H);
  assert.ok(a.ready && a.ref.v > 2200 && a.ref.v < 3200, 'le niveau appris suit les 18 maisons habitées : ' + a.ref.v);
});

test('adaptatif : une fuite (débit de fond +40 L/h) est signalée et ne devient jamais « normale »', () => {
  const g = gen({ days: 80, peopleOn: () => 6, floorExtra: (d) => (d >= 40 ? 40 : 0) });
  assert.deepEqual(codes(potable(), SITE6, g, 39), []);
  assert.ok(codes(potable(), SITE6, g, 42).includes('baseflow'), 'détectée en 2 jours');
  for (const d of [55, 70, 79]) assert.ok(codes(potable(), SITE6, g, d).includes('baseflow'), `toujours signalée au jour ${d}`);
  const txt = plain(WM.evaluateMeter(potable(), SITE6, g.readings, WM.toIntervals(g.readings), g.start + 79 * DAYMS + 23 * H)).find((a) => a.code === 'baseflow').text;
  assert.match(txt, /pour 6 maisons habitées/);
});

test('adaptatif : événement annoncé (remplissage de piscine) : pas d\'alerte, et la référence n\'est pas faussée', () => {
  const pool = (d, k) => (d === 45 && k === 9 ? 8000 : 0);
  const g = gen({ days: 60, peopleOn: () => 6, extra: pool });
  assert.ok(codes(potable(), SITE6, g, 45).includes('daily'), 'sans annonce : alerte');
  const ev = { people: SITE6.people, events: [{ label: 'Remplissage piscine', from: '2026-07-16', to: '2026-07-16' }] };   // jour 45 = 16 juillet
  assert.deepEqual(codes(potable(), ev, g, 45), [], 'annoncé : aucune alerte ce jour-là');
  const a = (site) => { const now = g.start + 59 * DAYMS + 23 * H, rs = g.readings.filter((r) => r.t <= now); return WM.adaptiveAssess(potable(), site, rs, WM.toIntervals(rs), now); };
  assert.ok(Math.abs(a(ev).ref.v - a(SITE6).ref.v) / a(SITE6).ref.v < 0.1, 'le jour exceptionnel n\'entre pas dans le niveau normal');
});

test('adaptatif : compteur non adaptatif (arrosage) : règles classiques inchangées', () => {
  const arro = WM.mergeCfg(null).meters[1];
  assert.equal(arro.adaptive, false);
  const g = gen({ days: 30, peopleOn: () => 6 });
  const rs = g.readings, iv = WM.toIntervals(rs), now = g.start + 29 * DAYMS + 23 * H;
  assert.deepEqual(plain(WM.evaluateMeter(arro, SITE6, rs, iv, now)), plain(WM.evaluateAlerts(arro.alerts, rs, iv, now)));
});

test('maisons habitées : dernier changement annoncé avant la date ; réglages anciens migrés', () => {
  const site = { people: [{ from: '2026-09-01', n: 6 }, { from: '2027-05-01', n: 14 }] };
  assert.equal(WM.peopleAt(site, at(2026, 8, 1)), 6);
  assert.equal(WM.peopleAt(site, at(2026, 12, 25)), 6);
  assert.equal(WM.peopleAt(site, at(2027, 5, 1)), 14);
  assert.equal(WM.peopleAt({}, at(2026, 8, 1)), 1);
  const old = WM.mergeCfg({ historyYears: 3, refreshMin: 10, meters: [{ id: 'potable', name: 'Eau potable', variable: 'index_eau_1', alerts: { dailyLimitL: 4000, spikeRatio: 2.5 } }, { id: 'arrosage', name: 'Arrosage', variable: 'index_eau_2', alerts: { dailyLimitL: 3000 } }] });
  assert.equal(old.meters[0].adaptive, true);
  assert.equal(old.meters[0].alerts.dailyLimitL, 0);           // l'ancien plafond fixe est abandonné
  assert.equal(old.meters[1].alerts.dailyLimitL, 3000);         // l'arrosage garde le sien
  assert.equal(old.site.people[0].n, 5);
});

test('adaptatif : des maisons en travaux élargissent la tolérance sur le volume (un jour ×2,5 n\'alerte pas avec 4 chantiers)', () => {
  const g = gen({ days: 50, peopleOn: (d) => (d === 45 ? 15 : 6) });          // le jour 45 : consommation ×2,5
  assert.ok(codes(potable(), SITE6, g, 45).includes('daily'), 'sans chantier : alerte');
  const works = { ...SITE6, works: 4 };                                       // tolérance ×1,6 → seuil à 3,2 × la normale
  assert.deepEqual(codes(potable(), works, g, 45), [], 'avec 4 maisons en travaux : pas d\'alerte');
  const g2 = gen({ days: 50, peopleOn: (d) => (d === 45 ? 24 : 6) });        // ×4 : même avec les chantiers, c'est anormal
  assert.ok(codes(potable(), works, g2, 45).includes('daily'));
  assert.equal(WM.mergeCfg(null).site.works, 4);
  assert.equal(WM.mergeCfg(null).site.people[0].n, 5);
});

test('profils calendaires : jour de la semaine, jour du mois, mois de l\'année (jours complets seulement)', () => {
  const start = at(2026, 1, 1), days = 110;
  const r = []; let v = 0;
  for (let t = start - 2 * H; t <= start + days * DAYMS; t += 2 * H) { const d = new Date(t - H); v += d.getDay() === 6 ? 40 : 20; r.push({ t, v }); }   // samedi : 480 L/jour ; autres : 240 L/jour
  const p = WM.calendarProfiles(r, WM.toIntervals(r));
  assert.ok(p.days > 100);
  p.weekday.forEach((x, i) => assert.ok(Math.abs(x.avg - (i === 5 ? 480 : 240)) < 15, `jour ${i} : ${x.avg}`));
  assert.ok(p.dom.slice(0, 28).every((x) => x.n >= 3));
  assert.ok(p.month[0].n === 1 && p.month[1].n === 1 && p.month[2].n === 1 && p.month[3].n === 0, 'janv. à mars complets, avril incomplet');
  assert.ok(p.month[0].avg > p.month[1].avg, 'janvier (31 j) > février (28 j)');
  assert.equal(WM.calendarProfiles([], []).days, 0);
});

test('profil à la demande : x = jour de la semaine / heure / jour du mois / mois, regroupement = tranche / jour / semaine / mois', () => {
  const start = at(2026, 6, 1), r = []; let v = 0;
  for (let t = start - 2 * H; t <= start + 110 * DAYMS; t += 2 * H) { const d = new Date(t - H); v += (d.getDay() === 6 ? 40 : 20) + (d.getHours() === 3 ? -19 : 0); r.push({ t, v }); }
  const iv = WM.toIntervals(r), G = (o) => WM.groupedProfile(r, iv, o).groups;
  const ref = WM.calendarProfiles(r, iv).weekday;
  G({ x: 'weekday', y: 'mean', unit: 'day' }).forEach((g, i) => assert.ok(Math.abs(g.value - ref[i].avg) < 1e-6 && g.n === ref[i].n));
  assert.ok(G({ x: 'weekday', y: 'max', unit: 'day' })[5].value >= G({ x: 'weekday', y: 'mean', unit: 'day' })[5].value);
  assert.ok(G({ x: 'weekday', y: 'flow', unit: 'day' }).every((g, i) => g.n > 10 && g.value < (i === 5 ? 11 : 2)), 'débit minimal de nuit : 0,5 L/h (10,5 le samedi)');
  const hour = G({ x: 'hour', y: 'mean', unit: 'slot' });
  assert.equal(hour.length, 12);
  assert.ok(hour[1].value < 6 && hour[0].value > 15, 'tranche 2 h-4 h presque vide');
  const sat = G({ x: 'weekday', y: 'mean', unit: 'slot' });     // volume moyen d'une tranche de 2 h selon le jour : samedi plus fort
  assert.ok(sat[5].value > sat[0].value * 1.9);
  assert.equal(G({ x: 'dom', y: 'mean', unit: 'day' }).length, 31);
  const mo = G({ x: 'month', y: 'mean', unit: 'month' });
  assert.ok(mo[5].n === 1 && mo[8].n === 0 && mo[8].value === null);
  const wk = G({ x: 'month', y: 'mean', unit: 'week' });
  assert.ok(wk[5].n >= 3 && wk[6].n >= 3, 'semaines complètes rangées par mois de leur début');
  const perDay = G({ x: 'month', y: 'mean', unit: 'day' });
  assert.ok(Math.abs(perDay[5].value - perDay[6].value) < 40, 'par jour : juin et juillet comparables');
});
