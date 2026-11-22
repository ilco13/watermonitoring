/*
 * lib.js - calculs purs (sans DOM) pour le suivi des compteurs d'eau.
 * Utilisable dans le navigateur (window.WM) et sous Node (require).
 *
 * Modèle de données
 *   reading  : { t: ms epoch, v: index cumulé en LITRES }
 *   interval : { t0, t1, d, reset }  consommation d (litres) entre deux relevés
 *
 * La consommation d'une période [a, b[ est la somme des intervalles de relevé,
 * répartis au prorata du temps (interpolation linéaire de l'index). Un relevé
 * toutes les 2 h ne tombe pas pile à minuit : c'est ce qui permet d'avoir des
 * totaux journaliers / mensuels / annuels justes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const H = 3600e3;
  const DAY = 24 * H;
  // En dessous, un intervalle ne dit rien sur un débit (deux relevés rapprochés par un rejeu ou un doublon) :
  // quelques litres sur quelques secondes donneraient des millions de L/h.
  const MIN_FLOW_SPAN = 30 * 60e3;

  /* ---------- Relevés -> intervalles ---------- */

  /** rows: [{time, value}] (format TagoIO). litresPerUnit: litres par unité d'index. */
  function toReadings(rows, litresPerUnit) {
    const k = Number(litresPerUnit) || 1;
    const out = [];
    for (const r of rows) {
      const v = r.value === null || r.value === '' || r.value === undefined ? NaN : Number(r.value);
      const t = typeof r.time === 'number' ? r.time : Date.parse(r.time);
      if (Number.isFinite(v) && Number.isFinite(t)) out.push({ t, v: v * k });
    }
    out.sort((a, b) => a.t - b.t);
    // supprime les doublons de timestamp (rejeu http push)
    return out.filter((r, i) => i === 0 || r.t !== out[i - 1].t);
  }

  function toIntervals(readings) {
    const out = [];
    for (let i = 1; i < readings.length; i++) {
      const a = readings[i - 1], b = readings[i];
      const diff = b.v - a.v;
      out.push({ t0: a.t, t1: b.t, d: diff > 0 ? diff : 0, reset: diff < 0 });
    }
    return out;
  }

  /** Répartit les intervalles dans les cases définies par `edges` (croissants). */
  function bucketize(intervals, edges) {
    const n = edges.length - 1;
    const res = new Array(Math.max(n, 0)).fill(0);
    if (n <= 0) return res;
    for (const iv of intervals) {
      const span = iv.t1 - iv.t0;
      if (span <= 0 || iv.d === 0 || iv.t1 <= edges[0] || iv.t0 >= edges[n]) continue;
      // première case dont la borne haute dépasse t0 (recherche dichotomique)
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (edges[mid + 1] <= iv.t0) lo = mid + 1; else hi = mid;
      }
      for (let i = lo; i < n && edges[i] < iv.t1; i++) {
        const a = Math.max(edges[i], iv.t0), b = Math.min(edges[i + 1], iv.t1);
        if (b > a) res[i] += iv.d * (b - a) / span;
      }
    }
    return res;
  }

  function total(intervals, a, b) {
    return bucketize(intervals, [a, b])[0] || 0;
  }

  /* ---------- Calendrier (fuseau local du navigateur) ---------- */

  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const startOfMonth = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  const addMonths = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };
  const startOfYear = (ms) => new Date(new Date(ms).getFullYear(), 0, 1).getTime();
  const addYears = (ms, n) => new Date(new Date(ms).getFullYear() + n, 0, 1).getTime();

  /** Bornes de `n` périodes consécutives qui se terminent à la fin de la période contenant `ms`. */
  function edgesBack(ms, n, unit) {
    const start = { day: startOfDay, month: startOfMonth, year: startOfYear }[unit];
    const add = { day: addDays, month: addMonths, year: addYears }[unit];
    const last = add(start(ms), 1);
    const edges = [last];
    for (let i = 1; i <= n; i++) edges.unshift(add(last, -i));
    return edges;
  }

  /** Bornes de 2 h (heure locale) couvrant les `n` dernières tranches jusqu'à ms inclus. */
  function edgesHours(ms, n, stepH) {
    const step = stepH || 2;
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    d.setHours(Math.floor(d.getHours() / step) * step + step);
    const end = d.getTime();
    const edges = [end];
    for (let i = 1; i <= n; i++) {
      const p = new Date(end);
      p.setHours(p.getHours() - step * i);
      edges.unshift(p.getTime());
    }
    // les passages heure d'été/hiver peuvent désordonner : on re-trie
    return edges.sort((a, b) => a - b);
  }

  /* ---------- Statistiques d'un compteur ---------- */

  const pct = (cur, ref) => (ref > 0 ? (cur - ref) / ref * 100 : null);

  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Indicateurs de la carte d'un compteur. `now` = ms, tronqué au dernier relevé. */
  function summarize(readings, intervals, now) {
    if (!readings.length) return null;
    const last = readings[readings.length - 1];
    const ref = Math.min(now, Math.max(last.t, 0));
    const day0 = startOfDay(ref);
    const mon0 = startOfMonth(ref);
    const yr0 = startOfYear(ref);

    const today = total(intervals, day0, ref + 1);
    const yesterday = total(intervals, addDays(day0, -1), day0);
    const dailyEdges = edgesBack(ref, 14, 'day');
    const days = bucketize(intervals, dailyEdges); // 14 derniers jours dont aujourd'hui
    const prev7 = days.slice(6, 13); // 7 jours complets avant aujourd'hui
    const avg7 = prev7.reduce((s, x) => s + x, 0) / 7;
    const last7 = total(intervals, addDays(day0, -6), ref + 1);

    const month = total(intervals, mon0, ref + 1);
    const prevMonthSame = total(intervals, addMonths(mon0, -1), addMonths(mon0, -1) + (ref - mon0));
    const year = total(intervals, yr0, ref + 1);
    const prevYearSame = total(intervals, addYears(yr0, -1), addYears(yr0, -1) + (ref - yr0));

    return {
      lastT: last.t, indexL: last.v,
      today, yesterday, avg7, last7,
      month, monthVs: pct(month, prevMonthSame), prevMonthSame,
      year, yearVs: pct(year, prevYearSame), prevYearSame,
      spark: bucketize(intervals, edgesBack(ref, 30, 'day')),
    };
  }

  /* ---------- Alertes ---------- */

  const LEVEL_RANK = { critical: 3, serious: 2, warning: 1 };

  /**
   * cfg : { dailyLimitL, monthlyLimitL, maxFlowLph, leakHours, baseFlowRatio, baseFlowMinLph, spikeRatio, staleHours }
   * (0 / vide = règle désactivée)
   *  - leakHours : écoulement sans le moindre arrêt (utile si le compteur s'arrête normalement, ex. arrosage)
   *  - baseFlowRatio / baseFlowMinLph : « débit de fond » (le plus petit débit des dernières 24 h) supérieur à
   *    ratio × sa valeur habituelle (médiane des minima des 14 jours précédents) ET d'au moins baseFlowMinLph L/h
   *    de plus. Adapté à un compteur qui ne s'arrête jamais vraiment (réseau d'une ASL).
   */
  function evaluateAlerts(cfg, readings, intervals, now) {
    const out = [];
    if (!readings.length) {
      out.push({ level: 'critical', code: 'nodata', text: 'Aucun relevé reçu.' });
      return out;
    }
    const lastT = readings[readings.length - 1].t;
    const sum = summarize(readings, intervals, now);

    if (cfg.staleHours > 0 && now - lastT > cfg.staleHours * H) {
      out.push({ level: 'critical', code: 'stale', text: `Aucune donnée depuis ${fmtDuration(now - lastT)} (compteur ou réseau NB-IoT ?).` });
    }
    if (intervals.some((iv) => iv.reset && iv.t1 > now - 7 * DAY)) {
      out.push({ level: 'warning', code: 'reset', text: 'Index en recul sur les 7 derniers jours (remplacement ou remise à zéro du compteur ?). Ces intervalles sont ignorés.' });
    }
    if (cfg.dailyLimitL > 0) {
      if (sum.today > cfg.dailyLimitL) out.push({ level: 'critical', code: 'daily', text: `Consommation du jour au-dessus du seuil : ${fmtVolume(sum.today)} pour ${fmtVolume(cfg.dailyLimitL)} autorisés.` });
      else if (sum.today > 0.8 * cfg.dailyLimitL) out.push({ level: 'warning', code: 'daily80', text: `Consommation du jour à ${Math.round(sum.today / cfg.dailyLimitL * 100)} % du seuil (${fmtVolume(sum.today)} / ${fmtVolume(cfg.dailyLimitL)}).` });
    }
    if (cfg.monthlyLimitL > 0 && sum.month > cfg.monthlyLimitL) {
      out.push({ level: 'serious', code: 'monthly', text: `Consommation du mois au-dessus du seuil : ${fmtVolume(sum.month)} pour ${fmtVolume(cfg.monthlyLimitL)}.` });
    }
    if (cfg.maxFlowLph > 0) {
      let peak = null;
      for (const iv of intervals) {
        if (iv.t1 < lastT - DAY || iv.t1 - iv.t0 < MIN_FLOW_SPAN) continue;
        const f = iv.d / ((iv.t1 - iv.t0) / H);
        if (!peak || f > peak.f) peak = { f, t1: iv.t1 };
      }
      if (peak && peak.f > cfg.maxFlowLph) {
        out.push({ level: 'critical', code: 'burst', text: `Débit moyen élevé : ${Math.round(peak.f)} L/h sur la tranche terminée à ${fmtTime(peak.t1)} (seuil ${cfg.maxFlowLph} L/h).` });
      }
    }
    if (cfg.leakHours > 0) {
      // série ininterrompue d'intervalles avec consommation, en remontant depuis le dernier relevé
      let run = 0, minFlow = Infinity;
      for (let i = intervals.length - 1; i >= 0; i--) {
        const iv = intervals[i];
        if (iv.t1 - iv.t0 < MIN_FLOW_SPAN && !iv.reset) continue;
        if (iv.d <= 0 || iv.reset) break;
        run += iv.t1 - iv.t0;
        minFlow = Math.min(minFlow, iv.d / ((iv.t1 - iv.t0) / H));
      }
      if (run >= cfg.leakHours * H) {
        out.push({ level: 'serious', code: 'leak', text: `Fuite possible : l'eau coule sans interruption depuis ${fmtDuration(run)} (débit minimum ${minFlow < 10 ? minFlow.toFixed(1) : Math.round(minFlow)} L/h).` });
      }
    }
    if (cfg.baseFlowRatio > 0) {
      const flowsOf = (a, b) => intervals
        .filter((iv) => iv.t1 > a && iv.t1 <= b && !iv.reset && iv.t1 - iv.t0 >= MIN_FLOW_SPAN)
        .map((iv) => iv.d / ((iv.t1 - iv.t0) / H));
      const current = flowsOf(lastT - DAY, lastT);
      const edges = edgesBack(lastT - 2 * DAY, 14, 'day'); // 14 jours complets qui précèdent les dernières 24 h
      const mins = [];
      for (let i = 0; i < 14; i++) {
        const f = flowsOf(edges[i], edges[i + 1]);
        if (f.length >= 8) mins.push(Math.min(...f));
      }
      if (current.length >= 10 && mins.length >= 7) {
        const cur = Math.min(...current), ref = median(mins);
        if (cur > cfg.baseFlowRatio * ref && cur - ref > (cfg.baseFlowMinLph || 0)) {
          out.push({ level: 'serious', code: 'baseflow', text: `Débit de fond anormal : l'eau ne descend pas sous ${Math.round(cur)} L/h depuis 24 h (habituellement ${Math.round(ref)} L/h). Fuite possible.` });
        }
      }
    }
    if (cfg.spikeRatio > 0) {
      const edges = edgesBack(lastT, 15, 'day');
      const d = bucketize(intervals, edges); // d[14] = aujourd'hui, d[13] = hier
      const ref = median(d.slice(0, 13).filter((x) => x > 0));
      if (ref > 0 && d[13] > cfg.spikeRatio * ref) {
        out.push({ level: 'warning', code: 'spike', text: `Hier : ${fmtVolume(d[13])}, soit ${(d[13] / ref).toFixed(1).replace('.', ',')} × la médiane des jours précédents (${fmtVolume(ref)}).` });
      }
    }
    out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    return out;
  }

  /* ---------- Profil horaire (jour de semaine × tranche de 2 h) ---------- */

  /** Moyenne de litres par tranche de 2 h, sur les `weeks` dernières semaines. Lundi = ligne 0. */
  function weeklyProfile(intervals, ref, weeks) {
    const n = weeks * 7 * 12;
    const edges = edgesHours(ref, n, 2);
    const b = bucketize(intervals, edges);
    const sums = Array.from({ length: 7 }, () => new Array(12).fill(0));
    const cnt = Array.from({ length: 7 }, () => new Array(12).fill(0));
    for (let i = 0; i < b.length; i++) {
      if (edges[i + 1] > ref) continue; // tranche en cours : incomplète, on ne la moyenne pas
      const d = new Date(edges[i]);
      const row = (d.getDay() + 6) % 7, col = Math.floor(d.getHours() / 2);
      sums[row][col] += b[i]; cnt[row][col]++;
    }
    return sums.map((r, i) => r.map((s, j) => (cnt[i][j] ? s / cnt[i][j] : 0)));
  }

  /* ---------- Formats (fr-FR) ---------- */

  const nf = (digits) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  function fmtVolume(litres) {
    const a = Math.abs(litres);
    if (a >= 10000) return nf(1).format(litres / 1000) + ' m³';
    if (a >= 1000) return nf(2).format(litres / 1000) + ' m³';
    return nf(a < 10 ? 1 : 0).format(litres) + ' L';
  }
  function fmtDuration(ms) {
    const h = ms / H;
    if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' min';
    if (h < 48) return Math.floor(h) + ' h' + (Math.round((h % 1) * 60) ? ' ' + String(Math.round((h % 1) * 60)).padStart(2, '0') : '');
    return Math.round(h / 24) + ' jours';
  }
  const fmtTime = (ms) => new Date(ms).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  return {
    H, DAY, toReadings, toIntervals, bucketize, total,
    startOfDay, addDays, startOfMonth, addMonths, startOfYear, addYears,
    edgesBack, edgesHours, summarize, evaluateAlerts, weeklyProfile, median,
    fmtVolume, fmtDuration, fmtTime, pct,
  };
});
