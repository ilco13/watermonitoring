/* app.js - interface du tableau de bord. Les calculs sont dans lib.js (window.WM). */
(function () {
  'use strict';
  const { WM, DEMO, Chart } = window;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- Configuration (stockée dans ce navigateur) ---------- */

  const CFG_KEY = 'wm.config.v3';
  const DEFAULT_CFG = {
    historyYears: 3,
    refreshMin: 10,
    // index_eau_1 = voie 0 (genericSensor "0") = eau potable ; index_eau_2 = voie 1 = arrosage ; index en litres
    meters: [
      { id: 'potable', name: 'Eau potable', variable: 'index_eau_1', litresPerUnit: 1, slot: 1,
        alerts: { dailyLimitL: 4000, monthlyLimitL: 0, maxFlowLph: 1500, leakHours: 0, baseFlowRatio: 2, baseFlowMinLph: 20, spikeRatio: 2.5, staleHours: 6 } },
      { id: 'arrosage', name: 'Arrosage', variable: 'index_eau_2', litresPerUnit: 1, slot: 2,
        alerts: { dailyLimitL: 3000, monthlyLimitL: 0, maxFlowLph: 1500, leakHours: 12, baseFlowRatio: 0, baseFlowMinLph: 0, spikeRatio: 0, staleHours: 6 } },
    ],
  };

  function loadCfg() {
    try {
      const saved = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (saved) return Object.assign({}, DEFAULT_CFG, saved, {
        meters: DEFAULT_CFG.meters.map((m, i) => Object.assign({}, m, (saved.meters || [])[i], { alerts: Object.assign({}, m.alerts, ((saved.meters || [])[i] || {}).alerts) })),
      });
    } catch (e) { /* stockage indisponible */ }
    return JSON.parse(JSON.stringify(DEFAULT_CFG));
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }

  let cfg = loadCfg();
  let mode = 'demo'; // 'server' (Worker Cloudflare + D1) | 'demo'
  const state = { data: {}, tab: 'd30', stacked: false, hidden: new Set(), asTable: false, heatMeter: 0, loadedAt: 0, errors: [], hint: '' };
  let chart = null;
  let timer = null;

  /* ---------- Accès aux données ---------- */

  async function detectMode() {
    if (new URLSearchParams(location.search).has('demo')) return 'demo';
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (r.ok && (await r.json()).ok) return 'server';
    } catch (e) { /* pas de Worker : page ouverte en local ou hébergée ailleurs */ }
    return 'demo';
  }

  async function apiGet(path, params) {
    const res = await fetch('api/' + path + '?' + new URLSearchParams(params), { cache: 'no-store' });
    let body = null;
    try { body = await res.json(); } catch (e) { /* corps vide */ }
    if (!res.ok || (body && body.status === false)) throw new Error((body && body.message) || `HTTP ${res.status}`);
    return (body && body.result) || [];
  }

  async function fetchVariable(variable) {
    const start = new Date(); start.setFullYear(start.getFullYear() - cfg.historyYears); start.setMonth(0, 1); start.setHours(0, 0, 0, 0);
    const qty = 10000, rows = [];
    for (let skip = 0; ; skip += qty) {
      const page = await apiGet('data', { variable, qty, skip, start_date: start.toISOString(), ordination: 'descending' });
      rows.push(...page);
      if (page.length < qty) break;
    }
    return rows;
  }

  async function loadAll() {
    state.errors = [];
    const demo = mode === 'demo' ? DEMO.generate(Date.now(), cfg.historyYears) : null;
    await Promise.all(cfg.meters.map(async (m) => {
      try {
        const rows = demo ? demo[m.id] : await fetchVariable(m.variable);
        if (!rows.length) throw new Error(`aucune donnée pour la variable « ${m.variable} »`);
        const readings = WM.toReadings(rows, m.litresPerUnit);
        state.data[m.id] = { readings, intervals: WM.toIntervals(readings) };
      } catch (e) {
        state.data[m.id] = { readings: [], intervals: [] };
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
    $('#status').textContent = lastT
      ? `Dernier relevé : ${fmtDateTime(lastT)} (il y a ${WM.fmtDuration(Date.now() - lastT)}) · actualisé à ${new Date(state.loadedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
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
    $('#cards').innerHTML = cfg.meters.map((m) => {
      const d = state.data[m.id];
      const s = d && d.readings.length ? WM.summarize(d.readings, d.intervals, Date.now()) : null;
      if (!s) return `<article class="card"><div class="card-head"><span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span></div><p class="muted">Pas de données.</p></article>`;
      const row = (label, val, delta) => `<div class="row"><dt>${label}</dt><dd class="num">${val}</dd><dd class="delta num">${delta || ''}</dd></div>`;
      return `<article class="card" aria-label="${esc(m.name)}">
        <div class="card-head"><span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span><span class="small muted num">Index ${fmtIndex(s.indexL)}</span></div>
        <div class="hero num">${WM.fmtVolume(s.today)}</div>
        <div class="hero-sub">aujourd'hui · moyenne des 7 jours précédents : ${WM.fmtVolume(s.avg7)}/jour</div>
        ${sparkSvg(s.spark, m)}
        <dl class="stats">
          ${row('Hier', WM.fmtVolume(s.yesterday))}
          ${row('7 jours', WM.fmtVolume(s.last7))}
          ${row('Ce mois', WM.fmtVolume(s.month), fmtDelta(s.monthVs) && fmtDelta(s.monthVs) + ' vs mois préc.')}
          ${row('Cette année', WM.fmtVolume(s.year), fmtDelta(s.yearVs) && fmtDelta(s.yearVs) + ' vs N−1')}
        </dl></article>`;
    }).join('');
  }

  /* ---------- Graphique principal ---------- */

  function chartSpec() {
    const now = Date.now();
    const fmt = (o) => (t) => new Date(t).toLocaleString('fr-FR', o);
    let edges, label, longLabel;
    switch (state.tab) {
      case 'h48': edges = WM.edgesHours(now, 24, 2); label = fmt({ weekday: 'short', hour: 'numeric' });
        longLabel = (a, b) => `${fmt({ weekday: 'long', day: 'numeric', month: 'short' })(a)}, ${fmt({ hour: '2-digit' })(a)} → ${fmt({ hour: '2-digit' })(b)}`; break;
      case 'd90': edges = WM.edgesBack(now, 90, 'day'); label = fmt({ day: 'numeric', month: 'short' });
        longLabel = (a) => fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })(a); break;
      case 'm12': edges = WM.edgesBack(now, 12, 'month'); label = fmt({ month: 'short', year: '2-digit' });
        longLabel = (a) => fmt({ month: 'long', year: 'numeric' })(a); break;
      case 'y': {
        const first = Math.min(...cfg.meters.map((m) => (state.data[m.id].readings[0] || { t: now }).t));
        const n = new Date(now).getFullYear() - new Date(first).getFullYear() + 1;
        edges = WM.edgesBack(now, Math.max(n, 1), 'year'); label = fmt({ year: 'numeric' });
        longLabel = (a) => fmt({ year: 'numeric' })(a); break;
      }
      default: edges = WM.edgesBack(now, 30, 'day'); label = fmt({ day: 'numeric', month: 'short' });
        longLabel = (a) => fmt({ weekday: 'long', day: 'numeric', month: 'long' })(a);
    }
    const labels = edges.slice(0, -1).map(label);
    const full = edges.slice(0, -1).map((a, i) => longLabel(a, edges[i + 1]));
    const lastT = Math.max(0, ...cfg.meters.map((m) => (state.data[m.id].readings.slice(-1)[0] || { t: 0 }).t));
    const open = edges.slice(0, -1).map((a, i) => edges[i + 1] > lastT && a <= lastT); // période en cours
    const series = cfg.meters.map((m) => ({ m, raw: WM.bucketize(state.data[m.id].intervals, edges), est: WM.estimatedShare(state.data[m.id].intervals, edges) }));
    return { labels, full, open, series };
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
    if (!d || !d.readings.length) { el.innerHTML = ''; return; }
    const prof = WM.weeklyProfile(d.intervals, d.readings[d.readings.length - 1].t, 4);
    const max = Math.max(1, ...prof.flat());
    const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    let html = '<div></div>' + Array.from({ length: 12 }, (_, i) => `<div class="h">${i % 2 === 0 ? i * 2 + 'h' : ''}</div>`).join('');
    prof.forEach((row, r) => {
      html += `<div class="d">${days[r]}</div>`;
      row.forEach((v, c) => {
        const pct = v <= 0 ? 0 : 10 + 90 * (v / max);
        const bg = v <= 0 ? 'color-mix(in srgb, var(--text-muted) 10%, var(--surface-1))' : `color-mix(in srgb, ${colorVar(m)} ${pct.toFixed(0)}%, var(--surface-1))`;
        const lbl = `${days[r]} ${c * 2}h–${c * 2 + 2}h : ${WM.fmtVolume(v)} en moyenne`;
        html += `<div class="c" data-tip="${esc(lbl)}" style="background:${bg}" role="presentation"></div>`;
      });
    });
    el.innerHTML = html;
    $('#heat-scale').innerHTML = `0 <span class="bar" style="background:linear-gradient(90deg,color-mix(in srgb,var(--text-muted) 10%,var(--surface-1)),color-mix(in srgb,${colorVar(m)} 10%,var(--surface-1)),${colorVar(m)})"></span> ${WM.fmtVolume(max)} par tranche de 2 h`;
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
          <div class="field"><label>Débit de fond : × la normale</label><input name="baseFlowRatio" type="number" step="0.1" min="0" value="${m.alerts.baseFlowRatio}"><span class="hint">0 = désactivé. Pour un compteur qui ne s'arrête jamais (eau potable).</span></div>
          <div class="field"><label>… et au moins (L/h) de plus</label><input name="baseFlowMinLph" type="number" min="0" value="${m.alerts.baseFlowMinLph}"></div>
          <div class="field"><label>Jour anormal : × la médiane</label><input name="spikeRatio" type="number" step="0.1" min="0" value="${m.alerts.spikeRatio}"><span class="hint">0 = désactivé</span></div>
          <div class="field"><label>Alerte si aucun relevé depuis (h)</label><input name="staleHours" type="number" min="0" value="${m.alerts.staleHours}"></div>
        </div>
      </fieldset>`).join('');
    return `<form method="dialog" id="settings-form">
      <h2>Réglages</h2>
      <fieldset><legend>Données reçues de Live Objects</legend>
        <div class="grid2">
          <div class="field"><label>Historique chargé (années)</label><input name="historyYears" type="number" min="1" max="10" value="${cfg.historyYears}"></div>
          <div class="field"><label>Actualisation (minutes)</label><input name="refreshMin" type="number" min="1" value="${cfg.refreshMin}"></div>
        </div>
        <div><button class="btn" type="button" id="btn-detect">Variables et derniers messages reçus</button></div>
        <div id="detect-out" hidden></div><datalist id="vars"></datalist>
      </fieldset>
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
      for (const k of ['dailyLimitL', 'monthlyLimitL', 'maxFlowLph', 'leakHours', 'baseFlowRatio', 'baseFlowMinLph', 'spikeRatio', 'staleHours']) m.alerts[k] = Number(v(k)) || 0;
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

  function openSettings() {
    const dlg = $('#settings');
    dlg.innerHTML = settingsHtml();
    $('#btn-detect').onclick = detectVariables;
    $('#btn-cancel').onclick = () => dlg.close();
    $('#btn-reset').onclick = () => { cfg = JSON.parse(JSON.stringify(DEFAULT_CFG)); saveCfg(); dlg.close(); start(); };
    $('#settings-form').onsubmit = () => { cfg = readForm($('#settings-form')); saveCfg(); setTimeout(start, 0); };
    dlg.showModal();
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
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    $('#btn-theme').textContent = 'Thème : ' + ({ light: 'clair', dark: 'sombre' }[t] || 'auto');
    try { localStorage.setItem('wm.theme', t || 'auto'); } catch (e) { /* ignore */ }
  }

  /* ---------- Orchestration ---------- */

  function renderAll() {
    renderBanner(); renderStatus(); renderAlerts(); renderCards(); renderChart(); renderHeat();
  }

  async function start() {
    clearInterval(timer);
    mode = await detectMode();
    $('#status').textContent = 'Chargement…';
    await loadAll();
    renderAll();
    timer = setInterval(async () => { await loadAll(); renderAll(); }, Math.max(1, cfg.refreshMin) * 60e3);
  }

  function init() {
    let theme = 'auto'; try { theme = localStorage.getItem('wm.theme') || 'auto'; } catch (e) { /* ignore */ }
    applyTheme(theme);
    $('#btn-theme').onclick = () => { const o = ['auto', 'light', 'dark']; const cur = document.documentElement.dataset.theme || 'auto'; applyTheme(o[(o.indexOf(cur) + 1) % 3]); renderChart(); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderChart());
    $('#btn-refresh').onclick = async () => { $('#status').textContent = 'Actualisation…'; await loadAll(); renderAll(); };
    $('#btn-settings').onclick = openSettings;
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-open-settings')) openSettings();
      else if (t.dataset.tab) { state.tab = t.dataset.tab; renderChart(); }
      else if (t.dataset.meter) { state.hidden.has(t.dataset.meter) ? state.hidden.delete(t.dataset.meter) : state.hidden.add(t.dataset.meter); renderChart(); }
      else if (t.dataset.stack != null) { state.stacked = t.dataset.stack === '1'; renderChart(); }
      else if (t.dataset.heat != null) { state.heatMeter = Number(t.dataset.heat); renderHeat(); }
    });
    $('#as-table').onchange = (e) => { state.asTable = e.target.checked; renderChart(); };
    setupTip();
    start();
  }

  init();
})();
