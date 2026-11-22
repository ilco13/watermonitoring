/* app.js - interface du tableau de bord. Les calculs sont dans lib.js (window.WM). */
(function () {
  'use strict';
  const { WM, DEMO, Chart } = window;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- Configuration (stockée dans ce navigateur) ---------- */

  const CFG_KEY = 'wm.config.v4';
  const DEFAULT_CFG = {
    historyYears: 3,
    refreshMin: 10,
    // index_eau_1 = voie 0 (genericSensor "0") = eau potable ; index_eau_2 = voie 1 = arrosage ; index en litres
    meters: [
      { id: 'potable', name: 'Eau potable', variable: 'index_eau_1', litresPerUnit: 1, slot: 1,
        alerts: { dailyLimitL: 4000, monthlyLimitL: 0, maxFlowLph: 1500, leakHours: 0, quietFromH: 0, quietToH: 0, quietMaxL: 0, baseFlowRatio: 2, baseFlowMinLph: 20, spikeRatio: 2.5, staleHours: 6 } },
      { id: 'arrosage', name: 'Arrosage', variable: 'index_eau_2', litresPerUnit: 1, slot: 2,
        alerts: { dailyLimitL: 3000, monthlyLimitL: 0, maxFlowLph: 1500, leakHours: 12, quietFromH: 6, quietToH: 18, quietMaxL: 10, baseFlowRatio: 0, baseFlowMinLph: 0, spikeRatio: 0, staleHours: 6 } },
    ],
  };

  function mergeCfg(saved) {
    if (!saved || typeof saved !== 'object') return JSON.parse(JSON.stringify(DEFAULT_CFG));
    return Object.assign({}, DEFAULT_CFG, saved, {
      meters: DEFAULT_CFG.meters.map((m, i) => Object.assign({}, m, (saved.meters || [])[i], { alerts: Object.assign({}, m.alerts, ((saved.meters || [])[i] || {}).alerts) })),
    });
  }
  function loadCfg() {
    try { return mergeCfg(JSON.parse(localStorage.getItem(CFG_KEY) || 'null')); } catch (e) { return mergeCfg(null); }
  }
  // Sur le site, les réglages sont communs à tous et modifiables par le bureau (serveur) ; en démonstration, ils restent locaux.
  async function saveCfg() {
    if (mode === 'server') await apiSend('PUT', 'config', { config: cfg });
    else { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }
  }

  let cfg = loadCfg();
  let mode = 'demo'; // 'server' (Worker Cloudflare + D1) | 'demo'
  const state = { me: null, view: 'synthese', synthMode: 'cal', data: {}, tab: 'm', mode: 'roll', stacked: false, hidden: new Set(), asTable: false, heatMeter: 0, loadedAt: 0, errors: [], hint: '' };
  let chart = null;
  let timer = null;

  /* ---------- Accès aux données ---------- */

  async function detectMode() {
    if (new URLSearchParams(location.search).has('demo')) return 'demo';
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (r.status === 401) { sessionExpired(); return 'server'; } // session expirée : reconnexion via l'ASL
      if (r.ok && (await r.json()).ok) return 'server';
    } catch (e) { /* pas de Worker : page ouverte en local ou hébergée ailleurs */ }
    return 'demo';
  }

  // Session expirée : on recharge la page, le serveur renvoie vers l'ASL qui nous ramène connecté (au plus une fois par minute)
  function sessionExpired() {
    try { if (Date.now() - Number(sessionStorage.getItem('wm.relogin') || 0) < 60e3) return false; sessionStorage.setItem('wm.relogin', String(Date.now())); } catch (e) { /* ignore */ }
    location.reload(); return true;
  }

  async function apiSend(method, path, body) {
    const res = await fetch('api/' + path, { method, cache: 'no-store', body: JSON.stringify(body),
      headers: { 'X-Requested-With': 'eau-dashboard', 'Content-Type': 'application/json' } });
    let j = null; try { j = await res.json(); } catch (e) { /* corps vide */ }
    if (res.status === 401 && sessionExpired()) throw new Error('Session expirée, reconnexion…');
    if (!res.ok || (j && j.status === false)) throw new Error((j && j.message) || `HTTP ${res.status}`);
    return j;
  }

  async function apiGet(path, params) {
    const res = await fetch('api/' + path + '?' + new URLSearchParams(params), { cache: 'no-store' });
    if (res.status === 401 && sessionExpired()) throw new Error('Session expirée, reconnexion…');
    let body = null;
    try { body = await res.json(); } catch (e) { /* corps vide */ }
    if (!res.ok || (body && body.status === false)) throw new Error((body && body.message) || `HTTP ${res.status}`);
    return (body && body.result) || [];
  }

  /**
   * Relevés d'une variable. Sans `sinceMs` : tout l'historique configuré. Avec `sinceMs` : seulement ce qui est plus récent
   * (actualisation incrémentale : le plafond de lectures de la base gratuite se compte en lignes lues).
   */
  async function fetchVariable(variable, sinceMs) {
    let start;
    if (sinceMs) start = new Date(sinceMs);
    else { start = new Date(); start.setFullYear(start.getFullYear() - cfg.historyYears); start.setMonth(0, 1); start.setHours(0, 0, 0, 0); }
    const qty = 10000, rows = [];
    for (let skip = 0; ; skip += qty) {
      const page = await apiGet('data', { variable, qty, skip, start_date: start.toISOString(), ordination: 'descending' });
      rows.push(...page);
      if (page.length < qty) break;
    }
    return rows;
  }

  const FULL_RELOAD_MS = 24 * 3600e3;    // rechargement complet au moins une fois par jour (corrections faites ailleurs)
  const OVERLAP_MS = 24 * 3600e3;        // en incrémental, on redemande les 24 dernières heures : rattrape un message arrivé en retard
  state.rows = {};                       // compteur -> { key, map: heure ISO -> ligne, fullAt }

  /** full = true : tout recharger (modification manuelle, bouton Actualiser, changement de réglages). */
  async function loadAll(full) {
    state.errors = [];
    const demo = mode === 'demo' ? DEMO.generate(Date.now(), cfg.historyYears) : null;
    await Promise.all(cfg.meters.map(async (m) => {
      try {
        let rows;
        if (demo) rows = demo[m.id];
        else {
          const key = `${m.variable}|${cfg.historyYears}`;
          const have = state.rows[m.id];
          const incremental = !full && have && have.key === key && Date.now() - have.fullAt < FULL_RELOAD_MS && have.map.size > 0;
          if (incremental) {
            const last = Math.max(...[...have.map.keys()].map((t) => Date.parse(t)));
            for (const r of await fetchVariable(m.variable, last - OVERLAP_MS)) have.map.set(r.time, r);
          } else {
            const map = new Map();
            for (const r of await fetchVariable(m.variable)) map.set(r.time, r);
            state.rows[m.id] = { key, map, fullAt: Date.now() };
          }
          rows = [...state.rows[m.id].map.values()];
        }
        if (!rows.length) throw new Error(`aucune donnée pour la variable « ${m.variable} »`);
        const readings = WM.toReadings(rows, m.litresPerUnit);
        state.data[m.id] = { readings, intervals: WM.toIntervals(readings) };
      } catch (e) {
        state.data[m.id] = { readings: [], intervals: [] };
        delete state.rows[m.id];
        state.errors.push(`${m.name} : ${e.message}`);
      }
    }));
    state.hint = '';
    if (state.errors.length && mode === 'server') {
      try {
        const vars = await apiGet('variables', {});
        state.hint = vars.length
          ? `Variables reçues : ${vars.map((v) => v.variable).join(', ')}. Corrigez le nom dans Réglages.`
          : 'Aucun message reçu pour l\'instant : vérifiez l\'action Live Objects (README) puis ouvrez Réglages → Derniers messages reçus.';
      } catch (e) { /* ignoré */ }
    }
    state.loadedAt = Date.now();
  }

  /* ---------- Formats ---------- */

  const fmtHm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const fmtDelta = (p) => {
    if (p == null || !isFinite(p)) return '';
    const r = Math.round(p);
    return r === 0 ? '= stable' : `${r > 0 ? '▲ +' : '▼ −'}${Math.abs(r)}\u202f%`;
  };
  const fmtIndex = (litres) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(litres / 1000) + ' m³';
  const fmtDateTime = (ms) => new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const colorVar = (m) => `var(--series-${m.slot})`;
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ---------- Bandeau, statut ---------- */

  function renderBanner() {
    const el = $('#banner');
    const parts = [];
    let err = false;
    if (mode === 'demo') parts.push('<span><strong>Données de démonstration.</strong> Cette page n\'est pas reliée au Worker Cloudflare qui reçoit les messages de Live Objects (voir README).</span>');
    if (state.errors.length) { err = true; parts.push(`<span><strong>Lecture impossible.</strong> ${esc(state.errors.join(' · '))}${state.hint ? '<br>' + esc(state.hint) : ''}</span>`); }
    el.hidden = !parts.length;
    el.classList.toggle('err', err);
    el.innerHTML = parts.join('') + (parts.length ? '<button class="btn" type="button" data-open-settings>Réglages</button>' : '');
  }

  function renderStatus() {
    const lastT = Math.max(0, ...cfg.meters.map((m) => (state.data[m.id] || { readings: [] }).readings.slice(-1).map((r) => r.t)[0] || 0));
    const nexts = cfg.meters.map((m) => (state.data[m.id] ? WM.nextExpected(state.data[m.id].readings) : null)).filter(Boolean);
    const next = nexts.length ? nexts.reduce((a, b) => (b.anchor > a.anchor ? b : a)) : null;
    const hm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    let nextTxt = '';
    if (next) {
      const wait = next.at - Date.now();
      nextTxt = wait > 0 ? ` · prochain relevé vers ${hm(next.at)} (dans ${WM.fmtDuration(wait)})`
        : wait > -10 * 60e3 ? ' · prochain relevé imminent'
          : ` · prochain relevé attendu à ${hm(next.at)} (en retard de ${WM.fmtDuration(-wait)})`;
    }
    const who = '';
    const whoEl = $('#who'); if (whoEl) { whoEl.textContent = state.me ? (state.me.name || 'Connecté') : ''; whoEl.title = state.me ? (state.me.role === 'admin' ? 'Membre du bureau' : 'Coloti') : ''; }
    $('#status').textContent = lastT
      ? `Dernier relevé : ${fmtDateTime(lastT)} (il y a ${WM.fmtDuration(Date.now() - lastT)})${nextTxt} · actualisé à ${hm(state.loadedAt)}${who}`
      : 'Aucun relevé.';
  }

  /* ---------- Alertes ---------- */

  const LEVEL = { critical: ['Critique', '×'], serious: ['Important', '!'], warning: ['Attention', '!'] };

  function renderAlerts() {
    const items = [];
    for (const m of cfg.meters) {
      const d = state.data[m.id];
      if (!d || !d.readings.length) continue;
      for (const a of WM.evaluateAlerts(m.alerts, d.readings, d.intervals, Date.now())) items.push({ m, a });
    }
    const rank = { critical: 3, serious: 2, warning: 1 };
    items.sort((x, y) => rank[y.a.level] - rank[x.a.level]);
    $('#alert-list').innerHTML = items.length
      ? items.map(({ m, a }) => `<li><span class="pill ${a.level}"><i aria-hidden="true">${LEVEL[a.level][1]}</i>${LEVEL[a.level][0]}</span><span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span><span>${esc(a.text)}</span></li>`).join('')
      : '<li><span class="pill good"><i aria-hidden="true">✓</i>Normal</span><span>Aucune alerte : consommation et relevés dans les seuils.</span></li>';
  }

  /* ---------- Cartes ---------- */

  function sparkSvg(values, m) {
    const w = 300, h = 34, n = values.length, max = Math.max(...values, 1), gap = 2;
    const bw = (w - gap * (n - 1)) / n;
    const rects = values.map((v, i) => {
      const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (h - 2));
      return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${colorVar(m)}" opacity="${i === n - 1 ? 1 : 0.55}"/>`;
    }).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Consommation des 30 derniers jours"><title>30 derniers jours</title>${rects}</svg>`;
  }

  function renderCards() {
    const roll = state.synthMode === 'roll';
    document.querySelectorAll('#synth-seg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.synth === 'roll') === roll)));
    $('#synth-note').textContent = roll ? 'Fenêtres qui se terminent au dernier relevé' : "Aujourd'hui, la semaine depuis lundi, le mois et l'année en cours";
    const v = (x) => WM.fmtVolume(x);
    const vs = (p, what) => (p == null ? '' : `${fmtDelta(p)} vs ${what}`);
    $('#cards').innerHTML = cfg.meters.map((m) => {
      const d = state.data[m.id];
      const s = d && d.readings.length ? WM.summarize(d.readings, d.intervals, Date.now()) : null;
      if (!s) return `<article class="card"><div class="card-head"><span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span></div><p class="muted">Pas de données.</p></article>`;
      const row = (label, val, delta) => `<div class="row"><dt>${label}</dt><dd class="num">${val}</dd><dd class="delta num">${delta || ''}</dd></div>`;
      let hero, sub, rows;
      if (!roll) {
        hero = s.today;
        sub = `aujourd'hui, jusqu'au relevé de ${fmtHm(s.lastT)} · moyenne des 7 jours précédents : ${v(s.avg7)}/jour`;
        rows = [row('Hier', v(s.yesterday)), row('Cette semaine', v(s.week), vs(s.weekVs, 'sem. préc.')),
          row('Ce mois', v(s.month), vs(s.monthVs, 'mois préc.')), row('Cette année', v(s.year), vs(s.yearVs, 'N−1'))];
      } else {
        const r = s.rolling;
        hero = r.h24.cur;
        sub = `24 dernières heures, jusqu'au relevé de ${fmtHm(s.lastT)}${r.h24.vs == null ? '' : ` · ${fmtDelta(r.h24.vs)} vs les 24 h précédentes`}`;
        rows = [row('24 h précédentes', v(r.h24.prev)), row('7 jours glissants', v(r.d7.cur), vs(r.d7.vs, '7 j préc.')),
          row('30 jours glissants', v(r.d30.cur), vs(r.d30.vs, '30 j préc.')),
          row('12 mois glissants', v(r.d365.cur), r.d365.partial ? 'partiel (historique court)' : vs(r.d365.vs, '12 mois préc.'))];
      }
      return `<article class="card" aria-label="${esc(m.name)}">
        <div class="card-head"><span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span><span class="small muted num">Index ${fmtIndex(s.indexL)}</span></div>
        <div class="hero num">${v(hero)}</div>
        <div class="hero-sub">${sub}</div>
        ${sparkSvg(roll ? s.sparkRoll : s.spark, m)}
        <dl class="stats">${rows.join('')}</dl></article>`;
    }).join('');
  }

  /* ---------- Graphique principal ---------- */

  function chartSpec() {
    const now = Date.now();
    const H = WM.H, DAY = WM.DAY;
    const fmt = (o) => (t) => new Date(t).toLocaleString('fr-FR', o);
    const lastT = Math.max(0, ...cfg.meters.map((m) => (state.data[m.id].readings.slice(-1)[0] || { t: 0 }).t));
    const anchor = lastT || now;             // les périodes glissantes se terminent au dernier relevé
    const roll = state.mode === 'roll';
    const hm = fmt({ hour: '2-digit', minute: '2-digit' });
    const dayLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
    const dayShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
    const dm = fmt({ day: 'numeric', month: 'short' });
    const range = (a, b) => `du ${dayShort(a)} ${hm(a)} au ${dayShort(b)} ${hm(b)}`;
    let edges, label, longLabel, note = '';
    switch (state.tab) {
      case 'd':
        if (roll) {
          edges = WM.edgesRolling(anchor, 12, 2 * H); label = (a) => hm(a);
          longLabel = (a, b) => `${dayShort(a)} ${hm(a)} → ${hm(b)}`; note = `24 h jusqu'au relevé de ${dayShort(anchor)} ${hm(anchor)}`;
        } else {
          edges = WM.edgesCalendar(now, 'day'); label = fmt({ hour: 'numeric' });
          longLabel = (a, b) => `${dayLong(a)}, ${fmt({ hour: '2-digit' })(a)} → ${fmt({ hour: '2-digit' })(b)}`; note = `Aujourd'hui, ${dayLong(now)}`;
        }
        break;
      case 'w':
        if (roll) {
          edges = WM.edgesRolling(anchor, 7, DAY); label = (a, b) => dm(b);
          longLabel = range; note = `7 jours jusqu'au relevé de ${dayShort(anchor)} ${hm(anchor)}`;
        } else {
          edges = WM.edgesCalendar(now, 'week'); label = fmt({ weekday: 'short', day: 'numeric' });
          longLabel = (a) => dayLong(a); note = `Semaine du ${fmt({ day: 'numeric', month: 'long' })(edges[0])} au ${fmt({ day: 'numeric', month: 'long' })(edges[7] - 1)}`;
        }
        break;
      case 'm':
        if (roll) {
          edges = WM.edgesRolling(anchor, 30, DAY); label = (a, b) => dm(b);
          longLabel = range; note = `30 jours jusqu'au relevé de ${dayShort(anchor)} ${hm(anchor)}`;
        } else {
          edges = WM.edgesCalendar(now, 'month'); label = fmt({ day: 'numeric' });
          longLabel = (a) => dayLong(a); note = fmt({ month: 'long', year: 'numeric' })(edges[0]);
        }
        break;
      case 'd90': edges = WM.edgesBack(now, 90, 'day'); label = fmt({ day: 'numeric', month: 'short' });
        longLabel = (a) => fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })(a); break;
      case 'm12': edges = WM.edgesBack(now, 12, 'month'); label = fmt({ month: 'short', year: '2-digit' });
        longLabel = (a) => fmt({ month: 'long', year: 'numeric' })(a); break;
      default: { // 'y'
        const first = Math.min(...cfg.meters.map((m) => (state.data[m.id].readings[0] || { t: now }).t));
        const n = new Date(now).getFullYear() - new Date(first).getFullYear() + 1;
        edges = WM.edgesBack(now, Math.max(n, 1), 'year'); label = fmt({ year: 'numeric' });
        longLabel = (a) => fmt({ year: 'numeric' })(a);
      }
    }
    const starts = edges.slice(0, -1);
    const labels = starts.map((a, i) => label(a, edges[i + 1]));
    const full = starts.map((a, i) => longLabel(a, edges[i + 1]));
    const open = starts.map((a, i) => edges[i + 1] > lastT && a <= lastT); // période en cours
    const series = cfg.meters.map((m) => ({ m, raw: WM.bucketize(state.data[m.id].intervals, edges), est: WM.estimatedShare(state.data[m.id].intervals, edges) }));
    return { labels, full, open, series, note };
  }

  function renderChart() {
    const spec = chartSpec();
    const visible = spec.series.filter((s) => !state.hidden.has(s.m.id));

    // légende = filtres (le total de chaque compteur sur la période affichée)
    $('#legend').innerHTML = spec.series.map(({ m, raw }) => {
      const tot = raw.reduce((a, b) => a + b, 0);
      return `<button type="button" class="chip" data-meter="${m.id}" aria-pressed="${!state.hidden.has(m.id)}"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}<span class="tot num">${WM.fmtVolume(tot)}</span></button>`;
    }).join('');
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
    $('#mode-seg').hidden = !['d', 'w', 'm'].includes(state.tab);
    document.querySelectorAll('#mode-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    $('#range-note').textContent = spec.note;
    document.querySelectorAll('#stack-seg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.stack === '1') === state.stacked)));

    $('#chartwrap').hidden = state.asTable;
    $('#tablewrap').hidden = !state.asTable;
    if (state.asTable) {
      $('#tablewrap').innerHTML = `<table class="data num"><thead><tr><th>Période</th>${visible.map((s) => `<th>${esc(s.m.name)}</th>`).join('')}</tr></thead><tbody>${
        spec.full.map((l, i) => `<tr><td>${esc(l)}${spec.open[i] ? ' (en cours)' : ''}</td>${visible.map((s) => `<td>${s.est[i] >= 0.5 && s.raw[i] > 0 ? '≈ ' : ''}${WM.fmtVolume(s.raw[i])}</td>`).join('')}</tr>`).reverse().join('')
      }</tbody></table><p class="small muted">≈ : valeur estimée, répartie uniformément entre deux relevés manuels espacés.</p>`;
      if (chart) { chart.destroy(); chart = null; }
      return;
    }

    const peak = Math.max(1, ...(state.stacked ? spec.labels.map((_, i) => visible.reduce((a, s) => a + s.raw[i], 0)) : visible.flatMap((s) => s.raw)));
    const k = peak >= 5000 ? 1000 : 1, unit = k === 1000 ? 'm³' : 'L';
    const ink = cssVar('--text-secondary'), grid = cssVar('--grid'), surface = cssVar('--surface-1'), border = cssVar('--border'), primary = cssVar('--text-primary');

    const anyEst = visible.some((s) => s.est.some((x, i) => x >= 0.5 && s.raw[i] > 0));
    $('#est-note').hidden = !anyEst;
    const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
    const datasets = visible.map((s) => ({
      label: s.m.name, raw: s.raw, est: s.est, data: s.raw.map((v) => v / k),
      backgroundColor: s.est.map((x, i) => (x >= 0.5 && s.raw[i] > 0 ? alpha(cssVar(`--series-${s.m.slot}`), 0.4) : cssVar(`--series-${s.m.slot}`))),
      borderRadius: state.stacked ? 0 : { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom',
      borderColor: surface, borderWidth: state.stacked ? 1 : 0,
      maxBarThickness: 28, barPercentage: 0.9, categoryPercentage: 0.8,
    }));
    if (chart) chart.destroy();
    chart = new Chart($('#chart'), {
      type: 'bar',
      data: { labels: spec.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: state.stacked, grid: { display: false }, border: { color: grid }, ticks: { color: ink, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { stacked: state.stacked, beginAtZero: true, border: { display: false }, grid: { color: grid }, ticks: { color: ink }, title: { display: true, text: unit, color: ink } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: surface, titleColor: primary, bodyColor: ink, borderColor: border, borderWidth: 1, padding: 10, boxPadding: 4,
            callbacks: {
              title: (items) => spec.full[items[0].dataIndex] + (spec.open[items[0].dataIndex] ? ' (en cours)' : ''),
              label: (c) => ` ${c.dataset.label} : ${c.dataset.est[c.dataIndex] >= 0.5 && c.dataset.raw[c.dataIndex] > 0 ? '≈ ' : ''}${WM.fmtVolume(c.dataset.raw[c.dataIndex])}${c.dataset.est[c.dataIndex] >= 0.5 && c.dataset.raw[c.dataIndex] > 0 ? ' (estimé)' : ''}`,
              footer: (items) => (items.length > 1 ? `Total : ${WM.fmtVolume(items.reduce((a, c) => a + c.dataset.raw[c.dataIndex], 0))}` : ''),
            },
          },
        },
      },
    });
    $('#chart').setAttribute('aria-label', `Histogramme de consommation (${unit}), ${spec.labels.length} périodes`);
  }

  /* ---------- Profil horaire ---------- */

  function renderHeat() {
    const m = cfg.meters[state.heatMeter];
    $('#heat-seg').innerHTML = cfg.meters.map((x, i) => `<button type="button" data-heat="${i}" aria-pressed="${i === state.heatMeter}">${esc(x.name)}</button>`).join('');
    const d = state.data[m.id];
    const el = $('#heat');
    if (!d || !d.readings.length) { el.innerHTML = ''; $('#heat-trend').innerHTML = ''; return; }
    const prof = WM.weeklyProfile(d.intervals, d.readings[d.readings.length - 1].t, 4);
    const max = Math.max(1, ...prof.flat());
    const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const dayNames = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    const now = new Date(), nowRow = (now.getDay() + 6) % 7, nowCol = Math.floor(now.getHours() / 2);
    const tr = WM.trendVsUsual(d.readings, d.intervals, 4);
    const vol = (x) => WM.fmtVolume(x);
    // pastille dans la case « maintenant » : le sens de la tendance (jamais la seule couleur)
    const tag = !tr || tr.level === 'unknown' ? ['●', 'ici']
      : tr.level === 'up' ? ['▲', `+${Math.round(tr.pct)} %`] : tr.level === 'down' ? ['▼', `−${Math.abs(Math.round(tr.pct))} %`]
        : tr.level === 'unusual' ? ['!', 'inhabituel'] : ['=', 'habituel'];
    let html = '<div></div>' + Array.from({ length: 12 }, (_, i) => `<div class="h">${i % 2 === 0 ? i * 2 + 'h' : ''}</div>`).join('');
    prof.forEach((row, r) => {
      html += `<div class="d">${days[r]}</div>`;
      row.forEach((val, c) => {
        const isNow = r === nowRow && c === nowCol;
        const pct = val <= 0 ? 0 : 10 + 90 * (val / max);
        const bg = val <= 0 ? 'color-mix(in srgb, var(--text-muted) 10%, var(--surface-1))' : `color-mix(in srgb, ${colorVar(m)} ${pct.toFixed(0)}%, var(--surface-1))`;
        const lbl = `${days[r]} ${c * 2}h–${c * 2 + 2}h : ${vol(val)} en moyenne${isNow ? ' — vous êtes ici (maintenant)' : ''}`;
        html += `<div class="c${isNow ? ' now' : ''}" data-tip="${esc(lbl)}" style="background:${bg}" role="presentation">${isNow ? `<span class="nt"><b>${tag[0]}</b><span class="t"> ${esc(tag[1])}</span></span>` : ''}</div>`;
      });
    });
    el.innerHTML = html;
    $('#heat-scale').innerHTML = `0 <span class="bar" style="background:linear-gradient(90deg,color-mix(in srgb,var(--text-muted) 10%,var(--surface-1)),color-mix(in srgb,${colorVar(m)} 10%,var(--surface-1)),${colorVar(m)})"></span> ${vol(max)} par tranche de 2 h`;

    // texte de tendance : dernière tranche mesurée comparée à la même tranche, le même jour de la semaine, les semaines précédentes
    let txt = `<strong>Maintenant</strong> : ${dayNames[nowRow]}, ${nowCol * 2} h–${nowCol * 2 + 2} h (case entourée). `;
    if (!tr) txt += 'Pas encore assez de relevés récents pour comparer.';
    else {
      const win = `${fmtHm(tr.t0)} → ${fmtHm(tr.t1)}`, dn = dayNames[(new Date(tr.t1).getDay() + 6) % 7];
      const base = `Dernière tranche mesurée (${win}) : <strong>${vol(tr.value)}</strong>`;
      const usual = tr.usual == null ? '' : `${vol(tr.usual)} en moyenne ces ${tr.weeks} derniers ${dn}s à la même heure`;
      txt += tr.level === 'unknown' ? `${base}. Pas assez de semaines comparables pour dire si c'est habituel (il en faut au moins 2).`
        : tr.level === 'up' ? `${base}, soit <span class="trend-pill">▲ ${fmtDelta(tr.pct).replace('▲ ', '')}</span> par rapport à d'habitude (${usual}).`
          : tr.level === 'down' ? `${base}, soit <span class="trend-pill">▼ ${fmtDelta(tr.pct).replace('▼ ', '')}</span> par rapport à d'habitude (${usual}).`
            : tr.level === 'unusual' ? `${base} alors que d'habitude presque rien à cette heure (${usual}) : <span class="trend-pill warn">! consommation inhabituelle</span>`
              : `${base} : <span class="trend-pill">= comme d'habitude</span> (${usual}).`;
    }
    $('#heat-trend').innerHTML = txt;
  }

  /* ---------- Réglages ---------- */

  function settingsHtml() {
    const meterFs = cfg.meters.map((m, i) => `
      <fieldset data-i="${i}"><legend><span class="dot" style="background:${colorVar(m)}"></span> ${esc(m.name)}</legend>
        <div class="grid2">
          <div class="field"><label>Nom</label><input name="name" value="${esc(m.name)}"></div>
          <div class="field"><label>Variable de l'index</label><input name="variable" list="vars" value="${esc(m.variable)}"></div>
          <div class="field"><label>Litres par unité d'index</label><input name="litresPerUnit" type="number" step="any" min="0" value="${m.litresPerUnit}"><span class="hint">1 : l'index du compteur est déjà en litres (cas du décodeur actuel). 1000 s'il est en m³.</span></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Seuil journalier (L)</label><input name="dailyLimitL" type="number" min="0" value="${m.alerts.dailyLimitL}"></div>
          <div class="field"><label>Seuil mensuel (L)</label><input name="monthlyLimitL" type="number" min="0" value="${m.alerts.monthlyLimitL}"></div>
          <div class="field"><label>Débit moyen max. sur 2 h (L/h)</label><input name="maxFlowLph" type="number" min="0" value="${m.alerts.maxFlowLph}"></div>
          <div class="field"><label>Fuite : écoulement continu depuis (h)</label><input name="leakHours" type="number" min="0" value="${m.alerts.leakHours}"><span class="hint">0 = désactivé. Pour un compteur qui s'arrête normalement (arrosage).</span></div>
          <div class="field"><label>Plage sans consommation normale : de (h)</label><input name="quietFromH" type="number" min="0" max="24" step="0.5" value="${m.alerts.quietFromH}"><span class="hint">Ex. 6 à 18 pour un arrosage de nuit. Laisser le seuil à 0 pour désactiver.</span></div>
          <div class="field"><label>… à (h)</label><input name="quietToH" type="number" min="0" max="24" step="0.5" value="${m.alerts.quietToH}"></div>
          <div class="field"><label>… alerte si une tranche dépasse (L)</label><input name="quietMaxL" type="number" min="0" value="${m.alerts.quietMaxL}"></div>
          <div class="field"><label>Débit de fond : × la normale</label><input name="baseFlowRatio" type="number" step="0.1" min="0" value="${m.alerts.baseFlowRatio}"><span class="hint">0 = désactivé. Pour un compteur qui ne s'arrête jamais (eau potable).</span></div>
          <div class="field"><label>… et au moins (L/h) de plus</label><input name="baseFlowMinLph" type="number" min="0" value="${m.alerts.baseFlowMinLph}"></div>
          <div class="field"><label>Jour anormal : × la médiane</label><input name="spikeRatio" type="number" step="0.1" min="0" value="${m.alerts.spikeRatio}"><span class="hint">0 = désactivé</span></div>
          <div class="field"><label>Alerte si aucun relevé depuis (h)</label><input name="staleHours" type="number" min="0" value="${m.alerts.staleHours}"></div>
        </div>
      </fieldset>`).join('');
    return `<form method="dialog" id="settings-form">
      <h2>Réglages</h2>
      ${mode === 'server' ? '<p class="hint">Ces réglages s\'appliquent à tous les utilisateurs du site.</p>' : ''}
      <fieldset><legend>Données reçues de Live Objects</legend>
        <div class="grid2">
          <div class="field"><label>Historique chargé (années)</label><input name="historyYears" type="number" min="1" max="10" value="${cfg.historyYears}"></div>
          <div class="field"><label>Actualisation (minutes)</label><input name="refreshMin" type="number" min="1" value="${cfg.refreshMin}"></div>
        </div>
        <div><button class="btn" type="button" id="btn-detect">Variables et derniers messages reçus</button></div>
        <div id="detect-out" hidden></div><datalist id="vars"></datalist>
      </fieldset>
      ${mode === 'server' ? '<fieldset><legend>Clé de réception Live Objects</legend><div id="key-box" class="small">Chargement…</div></fieldset>' : ''}
      ${mode === 'server' ? `<fieldset><legend>Sauvegarde des relevés</legend>
        <p class="small">Tous les relevés sont conservés sans limite de durée. Gardez aussi une copie chez vous : le fichier CSV contient la variable, l'heure (UTC), la valeur en litres et l'origine (auto ou manuel).</p>
        <div><a class="btn" href="api/export.csv" download>Télécharger tous les relevés (CSV)</a></div>
        <p class="hint">Se réimporte avec <code>scripts/import.mjs</code> (voir le README). La restauration redonne les mêmes relevés, origine comprise.</p></fieldset>` : ''}
      ${meterFs}
      <div class="dlg-actions">
        <button class="btn" type="button" id="btn-reset">Valeurs par défaut</button>
        <button class="btn" type="button" id="btn-cancel">Annuler</button>
        <button class="btn primary" type="submit" value="save">Enregistrer</button>
      </div></form>`;
  }

  function readForm(form) {
    const f = new FormData(form);
    const next = JSON.parse(JSON.stringify(cfg));
    next.historyYears = Math.min(10, Math.max(1, Number(f.get('historyYears')) || 3));
    next.refreshMin = Math.max(1, Number(f.get('refreshMin')) || 10);
    form.querySelectorAll('fieldset[data-i]').forEach((fs) => {
      const m = next.meters[Number(fs.dataset.i)];
      const v = (n) => fs.querySelector(`[name="${n}"]`).value;
      m.name = v('name').trim() || m.name; m.variable = v('variable').trim();
      m.litresPerUnit = Number(v('litresPerUnit')) || 1;
      for (const k of ['dailyLimitL', 'monthlyLimitL', 'maxFlowLph', 'leakHours', 'quietFromH', 'quietToH', 'quietMaxL', 'baseFlowRatio', 'baseFlowMinLph', 'spikeRatio', 'staleHours']) m.alerts[k] = Number(v(k)) || 0;
    });
    return next;
  }

  async function detectVariables() {
    const out = $('#detect-out'); out.hidden = false; out.textContent = 'Lecture…';
    if (mode !== 'server') { out.textContent = 'Aucun serveur de données joint (mode démonstration).'; return; }
    try {
      const [vars, events] = await Promise.all([apiGet('variables', {}), apiGet('events', { limit: 5 })]);
      $('#vars').innerHTML = vars.map((v) => `<option value="${esc(v.variable)}">`).join('');
      let txt = vars.length
        ? 'Variables reçues (dernière valeur, dernier relevé, nombre de relevés) :\n' + vars.map((v) => `• ${v.variable} = ${v.value}   (${fmtDateTime(Date.parse(v.time))}, ${v.count} relevés)`).join('\n')
        : 'Aucune variable reçue pour l\'instant.';
      txt += '\n\nDerniers messages reçus :\n' + (events.length
        ? events.map((e) => `• ${fmtDateTime(Date.parse(e.time))} — ${e.stored} mesure(s) retenue(s), ${e.ignored} ignorée(s)\n  ${e.raw.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
        : 'aucun.');
      out.textContent = txt;
    } catch (e) { out.textContent = 'Échec : ' + e.message; }
  }

  /* ---------- Clé de réception Live Objects (régénération par le bureau) ---------- */

  async function loadKeyBox() {
    const box = $('#key-box'); if (!box) return;
    try {
      const st = await apiGet('ingest-key', {});
      const d = (iso) => (iso ? fmtFull(Date.parse(iso)) : null);
      const used = (iso) => (iso ? `dernière utilisation ${d(iso)}` : 'jamais utilisée');
      const lines = [];
      const current = st.keys.find((k) => k.active && !k.validUntil);
      const old = st.keys.filter((k) => k.active && k.validUntil);
      if (current) lines.push(`<li><strong>Clé actuelle</strong> : générée le ${esc(d(current.createdAt))} par ${esc(current.createdBy || '?')} · ${esc(used(current.lastUsedAt))}</li>`);
      if (st.legacy.present) {
        lines.push(st.legacy.active
          ? `<li><strong>Clé d'origine</strong> (installation)${st.legacy.validUntil ? ` : <strong>valable jusqu'au ${esc(d(st.legacy.validUntil))}</strong>` : ' : en vigueur'} · ${esc(used(st.legacy.lastUsedAt))}</li>`
          : `<li class="muted">Clé d'origine (installation) : expirée.</li>`);
      }
      for (const k of old) lines.push(`<li><strong>Ancienne clé</strong> : valable jusqu'au ${esc(d(k.validUntil))} · ${esc(used(k.lastUsedAt))}</li>`);
      const live = (current && current.lastUsedAt) ? 'Live Objects utilise déjà la nouvelle clé.' : current ? 'Live Objects n\'a pas encore utilisé la nouvelle clé : mettez-le à jour avant l\'expiration de l\'ancienne.' : '';
      box.innerHTML = `<ul class="plain">${lines.join('') || '<li class="muted">Aucune clé.</li>'}</ul>${live ? `<p>${esc(live)}</p>` : ''}
        <p class="hint">Live Objects envoie cette clé dans l'en-tête <code>Device-Token</code> vers <code>${esc(location.origin)}/ingest</code>.</p>
        <div><button class="btn" type="button" id="btn-regen-key">Régénérer la clé…</button></div><div id="key-new"></div>`;
      $('#btn-regen-key').onclick = regenerateKey;
    } catch (e) { box.textContent = 'Lecture impossible : ' + e.message; }
  }

  function showNewKey(key) {
    $('#key-new').innerHTML = `<div class="flash-key"><p><strong>Nouvelle clé</strong> — copiez-la maintenant, elle ne sera plus jamais affichée :</p>
      <div class="key-row"><input id="key-value" type="text" readonly value="${esc(key)}" aria-label="Nouvelle clé de réception"><button class="btn" type="button" id="btn-copy-key">Copier</button></div>
      <p class="hint">Dans Live Objects, remplacez la valeur de l'en-tête <code>Device-Token</code> de l'action HTTPS push par cette clé. L'ancienne clé fonctionne encore 24 h.</p></div>`;
    const input = $('#key-value'); input.focus(); input.select();
    $('#btn-copy-key').onclick = async () => {
      try { await navigator.clipboard.writeText(key); $('#btn-copy-key').textContent = 'Copiée ✓'; }
      catch (e) { input.select(); $('#btn-copy-key').textContent = 'Sélectionnée : Ctrl+C'; }
    };
  }

  async function regenerateKey() {
    if (!window.confirm('Générer une nouvelle clé de réception ?\n\nLa clé actuelle reste valable 24 h pour vous laisser le temps de mettre à jour l\'action HTTPS push de Live Objects. La nouvelle clé ne sera affichée qu\'une seule fois.')) return;
    $('#btn-regen-key').disabled = true;
    try {
      const key = (await apiSend('POST', 'ingest-key', {})).result.key;
      await loadKeyBox();      // met à jour l'état des clés
      showNewKey(key);         // puis affiche la clé, une seule fois
    } catch (e) { window.alert('Régénération impossible : ' + e.message); const b = $('#btn-regen-key'); if (b) b.disabled = false; }
  }

  function openSettings() {
    const dlg = $('#settings');
    dlg.innerHTML = settingsHtml();
    $('#btn-detect').onclick = detectVariables;
    if (mode === 'server') loadKeyBox();
    $('#btn-cancel').onclick = () => dlg.close();
    const persist = async () => { try { await saveCfg(); } catch (e) { window.alert('Enregistrement impossible : ' + e.message); } start(); };
    $('#btn-reset').onclick = () => { cfg = JSON.parse(JSON.stringify(DEFAULT_CFG)); dlg.close(); persist(); };
    $('#settings-form').onsubmit = () => { cfg = readForm($('#settings-form')); setTimeout(persist, 0); };
    dlg.showModal();
  }

  /* ---------- Édition des relevés (ajout, correction, suppression) ---------- */

  const rd = { source: 'manual', meter: 'all', edit: null, rows: [], more: false, msg: '', err: false };
  const fmtFull = (ms) => new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rawToM3 = (m, raw) => raw * m.litresPerUnit / 1000;
  const fmtM3 = (m, raw) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(rawToM3(m, raw)) + ' m³';
  const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const meterByVar = (v) => cfg.meters.find((m) => m.variable === v);

  async function apiWrite(method, params, body) {
    const q = params ? '?' + new URLSearchParams(params) : '';
    const res = await fetch('api/readings' + q, {
      method, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
      headers: { 'X-Requested-With': 'eau-dashboard', 'Content-Type': 'application/json' },
    });
    let j = null; try { j = await res.json(); } catch (e) { /* corps vide */ }
    if (!res.ok || (j && j.status === false)) throw new Error((j && j.message) || `HTTP ${res.status}`);
    return j;
  }

  function setRdMsg(text, err) {
    rd.msg = text; rd.err = !!err;
    const el = $('#rd-msg'); if (el) { el.textContent = text; el.className = 'rd-msg small' + (err ? ' err' : ''); el.hidden = !text; }
  }

  function renderRdForm() {
    const e = rd.edit;
    const fields = cfg.meters.map((m) => {
      const mine = e && e.variable === m.variable;
      const last = state.data[m.id] && state.data[m.id].readings.slice(-1)[0];
      const val = mine ? Number(rawToM3(m, e.raw).toFixed(3)) : '';
      return `<div class="field"><label for="rd-v-${m.id}"><span class="dot" style="background:${colorVar(m)}"></span> Index ${esc(m.name)} (m³)</label>
        <input id="rd-v-${m.id}" name="v_${m.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="ex. 1299,7" ${e && !mine ? 'disabled' : ''} value="${String(val).replace('.', ',')}">
        <span class="hint">${last ? `dernier relevé : ${fmtIndex(last.v)} (${fmtDateTime(last.t)})` : ''}</span></div>`;
    }).join('');
    $('#rd-form-box').innerHTML = `<form id="rd-form" autocomplete="off">
      <h3>${e ? 'Modifier un relevé' : 'Ajouter un relevé manuel'}</h3>
      <div class="grid2">
        <div class="field"><label for="rd-when">Date et heure</label><input id="rd-when" name="when" type="datetime-local" required value="${toLocalInput(e ? e.ms : Date.now())}"></div>
        ${fields}
      </div>
      <div class="dlg-actions">${e ? '<button class="btn" type="button" data-rd-cancel>Annuler la modification</button>' : ''}
        <button class="btn primary" type="submit">${e ? 'Enregistrer la modification' : 'Ajouter'}</button></div>
      <p id="rd-msg" class="rd-msg small" hidden></p></form>`;
    setRdMsg(rd.msg, rd.err);
  }

  async function submitRd(ev) {
    ev.preventDefault();
    const f = new FormData(ev.target), e = rd.edit;
    const whenStr = String(f.get('when')), typed = new Date(whenStr).getTime();
    if (!Number.isFinite(typed)) return setRdMsg('Date invalide.', true);
    const ts = e && whenStr === toLocalInput(e.ms) ? e.ms : typed; // l'heure n'est pas touchée (secondes) si elle n'a pas été modifiée
    const entries = cfg.meters.filter((m) => !(e && e.variable !== m.variable))
      .map((m) => ({ m, str: String(f.get('v_' + m.id) ?? '').replace(/[\s\u00a0\u202f]/g, '').replace(',', '.') })).filter((x) => x.str !== '');
    if (!entries.length) return setRdMsg('Saisissez au moins un index.', true);
    const warnings = [], posts = [];
    for (const { m, str } of entries) {
      const v = Number(str);
      if (!/^\d+(\.\d+)?$/.test(str) || !Number.isFinite(v) || v < 0) return setRdMsg(`Index ${m.name} invalide : saisissez un nombre en m³ (ex. 1299,7).`, true);
      const litres = Math.round(v * 1000), raw = litres / m.litresPerUnit;
      const ownTs = e && e.variable === m.variable ? e.ms : null;
      const others = state.data[m.id].readings.filter((r) => r.t !== ownTs);
      const prev = [...others].reverse().find((r) => r.t < ts), next = others.find((r) => r.t > ts);
      if (prev && litres < prev.v) warnings.push(`${m.name} : ${fmtIndex(litres)} est inférieur au relevé précédent (${fmtIndex(prev.v)}, ${fmtDateTime(prev.t)}).`);
      if (next && litres > next.v) warnings.push(`${m.name} : ${fmtIndex(litres)} est supérieur au relevé suivant (${fmtIndex(next.v)}, ${fmtDateTime(next.t)}).`);
      posts.push({ variable: m.variable, time: new Date(ts).toISOString(), value: raw, replaces: ownTs !== null ? e.time : undefined });
    }
    if (ts > Date.now() + 3600e3) warnings.push('La date est dans le futur.');
    if (warnings.length && !window.confirm(warnings.join('\n') + '\n\nEnregistrer quand même ?')) return;
    try { for (const body of posts) await apiWrite('POST', null, body); }
    catch (err) { return setRdMsg('Échec : ' + err.message, true); }
    rd.edit = null;
    setRdMsg(`${posts.length} relevé${posts.length > 1 ? 's' : ''} enregistré${posts.length > 1 ? 's' : ''}.`, false);
    await afterWrite();
  }

  async function afterWrite() {
    const msg = rd.msg, err = rd.err;
    await loadAll(true); renderAll(); renderRdForm(); setRdMsg(msg, err); await loadRdList(false);
  }

  async function loadRdList(append) {
    const box = $('#rd-list-box');
    const vars = (rd.meter === 'all' ? cfg.meters : cfg.meters.filter((m) => m.id === rd.meter)).map((m) => m.variable);
    const offset = append ? rd.rows.length : 0;
    try {
      const params = { variables: vars.join(','), limit: 50, offset };
      if (rd.source !== 'all') params.source = rd.source;
      const page = await apiGet('readings', params);
      rd.rows = append ? rd.rows.concat(page) : page; rd.more = page.length === 50;
    } catch (e) { box.innerHTML = `<p class="rd-msg small err">Lecture impossible : ${esc(e.message)}</p>`; return; }
    box.innerHTML = `<table class="data num"><thead><tr><th>Date et heure</th><th>Compteur</th><th>Index</th><th>Origine</th><th></th></tr></thead><tbody>${
      rd.rows.map((r, i) => { const m = meterByVar(r.variable); return `<tr><td>${esc(fmtFull(Date.parse(r.time)))}</td>
        <td>${m ? `<span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span>` : esc(r.variable)}</td>
        <td>${m ? fmtM3(m, r.value) : esc(r.value)}</td><td>${r.source === 'manual' ? 'manuel' : 'auto'}</td>
        <td class="rd-actions">${m ? `<button class="btn small" type="button" data-rd-edit="${i}">Modifier</button> ` : ''}<button class="btn small" type="button" data-rd-del="${i}">Supprimer</button></td></tr>`; }).join('')
    }</tbody></table>${rd.rows.length ? '' : '<p class="muted small">Aucun relevé pour ce filtre.</p>'}${rd.more ? '<p><button class="btn" type="button" data-rd-more>Afficher plus</button></p>' : ''}`;
  }

  function openReadings() {
    const dlg = $('#readings');
    if (mode !== 'server') {
      dlg.innerHTML = '<form method="dialog"><h2>Relevés</h2><p>La saisie n\'est pas disponible en mode démonstration : la page n\'est pas reliée à la base de données.</p><div class="dlg-actions"><button class="btn primary">Fermer</button></div></form>';
      dlg.showModal(); return;
    }
    rd.edit = null; rd.msg = ''; rd.err = false;
    dlg.innerHTML = `<div class="dlg-body"><h2>Relevés</h2>
      <p class="small muted">Ajoutez un relevé relu sur le compteur, corrigez une erreur ou supprimez un relevé. Les index se saisissent en m³ (ex. 1 299,7). Les totaux se recalculent aussitôt.</p>
      <div id="rd-form-box"></div>
      <div class="rd-filters"><h3>Relevés enregistrés</h3>
        <label class="small">Origine <select id="rd-source"><option value="manual">Manuels</option><option value="auto">Automatiques</option><option value="all">Tous</option></select></label>
        <label class="small">Compteur <select id="rd-meter"><option value="all">Les deux</option>${cfg.meters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label></div>
      <div id="rd-list-box" class="tablewrap"></div>
      <div class="dlg-actions"><button class="btn" type="button" data-rd-close>Fermer</button></div></div>`;
    $('#rd-source').value = rd.source; $('#rd-meter').value = rd.meter;
    renderRdForm(); loadRdList(false); dlg.showModal();
  }

  function setupReadings() {
    const dlg = $('#readings');
    dlg.addEventListener('submit', (e) => { if (e.target.id === 'rd-form') submitRd(e); });
    dlg.addEventListener('change', (e) => {
      if (e.target.id === 'rd-source') { rd.source = e.target.value; loadRdList(false); }
      if (e.target.id === 'rd-meter') { rd.meter = e.target.value; loadRdList(false); }
    });
    dlg.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if ('rdClose' in b.dataset) dlg.close();
      else if ('rdCancel' in b.dataset) { rd.edit = null; rd.msg = ''; renderRdForm(); }
      else if ('rdMore' in b.dataset) loadRdList(true);
      else if (b.dataset.rdEdit !== undefined) {
        const r = rd.rows[Number(b.dataset.rdEdit)]; if (!r) return;
        rd.edit = { variable: r.variable, time: r.time, ms: Date.parse(r.time), raw: r.value }; rd.msg = '';
        renderRdForm(); $('#rd-form').scrollIntoView({ block: 'nearest' });
      } else if (b.dataset.rdDel !== undefined) {
        const r = rd.rows[Number(b.dataset.rdDel)]; if (!r) return;
        const m = meterByVar(r.variable);
        if (!window.confirm(`Supprimer ce relevé ?\n\n${fmtFull(Date.parse(r.time))}\n${m ? m.name + ' : ' + fmtM3(m, r.value) : r.variable}\n\nCette action est définitive.`)) return;
        try { await apiWrite('DELETE', { variable: r.variable, time: r.time }); setRdMsg('Relevé supprimé.', false); await afterWrite(); }
        catch (err) { setRdMsg('Échec : ' + err.message, true); }
      }
    });
  }

  /* ---------- Infobulle du profil horaire ---------- */

  function setupTip() {
    const tip = $('#tip');
    document.addEventListener('pointerover', (e) => {
      const c = e.target.closest && e.target.closest('[data-tip]');
      if (!c) { tip.style.display = 'none'; return; }
      tip.textContent = c.dataset.tip; tip.style.display = 'block';
    });
    document.addEventListener('pointermove', (e) => {
      if (tip.style.display === 'none') return;
      tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
  }

  /* ---------- Thème ---------- */

  function applyTheme(t) {
    t = t === 'dark' ? 'dark' : 'light'; // clair par défaut, comme l'ASL ; le sombre est un choix explicite
    document.documentElement.dataset.theme = t;
    const tb = $('#btn-theme'); tb.textContent = t === 'dark' ? '☾' : '☀';
    tb.setAttribute('aria-label', `Changer de thème (actuellement ${t === 'dark' ? 'sombre' : 'clair'})`); tb.title = t === 'dark' ? 'Thème sombre : passer au clair' : 'Thème clair : passer au sombre';
    try { localStorage.setItem('wm.theme', t); } catch (e) { /* ignore */ }
  }

  /* ---------- Rôles : le bureau modifie, les colotis consultent ---------- */

  const canEdit = () => mode !== 'server' || (state.me && state.me.role === 'admin');
  function applyRole() {
    $('#btn-settings').hidden = !canEdit();
    $('#btn-readings').hidden = !canEdit();
    $('#btn-logout').hidden = mode !== 'server';
  }

  /* ---------- Orchestration ---------- */

  /* ---------- Vues : synthèse, graphiques, profil horaire (adresse #synthese, #graphiques, #profil) ---------- */

  const VIEWS = ['synthese', 'graphiques', 'profil'];
  function showView() {
    const h = (location.hash || '').slice(1);
    state.view = VIEWS.includes(h) ? h : 'synthese';
    document.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== state.view; });
    document.querySelectorAll('[data-view-link]').forEach((link) => {
      const on = link.dataset.viewLink === state.view;
      link.classList.toggle('active', on);
      if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    if (state.loadedAt) renderView();
  }
  // seule la vue affichée est dessinée : un graphique dans une zone masquée n'aurait pas de taille
  function renderView() { if (state.view === 'graphiques') renderChart(); else if (state.view === 'profil') renderHeat(); }

  function renderAll() {
    renderBanner(); renderStatus(); renderAlerts(); renderCards(); renderView();
  }

  async function start() {
    clearInterval(timer);
    mode = await detectMode();
    state.me = null; state.rows = {};      // (re)démarrage : chargement complet
    if (mode === 'server') {
      try {
        const [me, conf] = await Promise.all([apiGet('me', {}), apiGet('config', {})]);
        state.me = me; if (conf && conf.config) cfg = mergeCfg(conf.config);
      } catch (e) { state.errors = [e.message]; }
    }
    applyRole();
    $('#status').textContent = 'Chargement…';
    await loadAll();
    renderAll();
    timer = setInterval(async () => { await loadAll(); renderAll(); }, Math.max(1, cfg.refreshMin) * 60e3);
  }

  function init() {
    let theme = 'light'; try { theme = localStorage.getItem('wm.theme') || 'light'; } catch (e) { /* ignore */ }
    applyTheme(theme);
    $('#btn-theme').onclick = () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); renderView(); };
    $('#btn-refresh').onclick = async () => { $('#status').textContent = 'Actualisation…'; await loadAll(true); renderAll(); };
    $('#btn-logout').onclick = async () => {
      try { location.href = (await apiSend('POST', 'logout', {})).result.url; }   // ferme la session ici puis celle de l'ASL
      catch (e) { window.alert('Déconnexion impossible : ' + e.message); }
    };
    $('#btn-settings').onclick = openSettings;
    $('#btn-readings').onclick = openReadings;
    setupReadings();
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-open-settings')) openSettings();
      else if (t.dataset.tab) { state.tab = t.dataset.tab; renderChart(); }
      else if (t.dataset.mode) { state.mode = t.dataset.mode; renderChart(); }
      else if (t.dataset.synth) { state.synthMode = t.dataset.synth; renderCards(); }
      else if (t.dataset.meter) { state.hidden.has(t.dataset.meter) ? state.hidden.delete(t.dataset.meter) : state.hidden.add(t.dataset.meter); renderChart(); }
      else if (t.dataset.stack != null) { state.stacked = t.dataset.stack === '1'; renderChart(); }
      else if (t.dataset.heat != null) { state.heatMeter = Number(t.dataset.heat); renderHeat(); }
    });
    $('#as-table').onchange = (e) => { state.asTable = e.target.checked; renderChart(); };
    setupTip();
    const navToggle = $('#navtoggle');
    $('header.top').addEventListener('click', (e) => { if (navToggle && e.target.closest('nav a, .top-actions button')) navToggle.checked = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && navToggle) navToggle.checked = false; });
    window.addEventListener('hashchange', showView);
    showView();
    setInterval(() => { if (state.loadedAt) renderStatus(); }, 30000);
    start();
  }

  init();
})();
