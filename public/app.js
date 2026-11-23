/* app.js - interface du tableau de bord. Les calculs sont dans lib.js (window.WM). */
(function () {
  'use strict';
  const { WM, DEMO, Chart } = window;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- Configuration (stockée dans ce navigateur) ---------- */

  const CFG_KEY = 'wm.config.v4';
  // Réglages par défaut et fusion : dans lib.js, partagés avec le Worker (contrôle automatique des alertes)
  const DEFAULT_CFG = WM.DEFAULT_CFG;
  const mergeCfg = WM.mergeCfg;
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
          ? `Variables reçues : ${vars.map((v) => v.variable).join(', ')}. Corrigez le nom dans Paramètres.`
          : 'Aucun message reçu pour l\'instant : vérifiez l\'action Live Objects (README) puis ouvrez Paramètres → Réglages techniques → Variables et derniers messages reçus.';
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
    el.innerHTML = parts.join('') + (parts.length ? '<button class="btn" type="button" data-open-settings>Paramètres</button>' : '');
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
      for (const a of WM.evaluateMeter(m, cfg.site, d.readings, d.intervals, Date.now())) items.push({ m, a });
    }
    const rank = { critical: 3, serious: 2, warning: 1 };
    items.sort((x, y) => rank[y.a.level] - rank[x.a.level]);
    $('#alert-list').innerHTML = items.length
      ? items.map(({ m, a }) => `<li><span class="pill ${a.level}"><i aria-hidden="true">${LEVEL[a.level][1]}</i>${LEVEL[a.level][0]}</span><span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span><span>${esc(a.text)}${m.adaptive && canEdit() && (a.code === 'daily' || a.code === 'baseflow') ? ` <button class="btn small" type="button" data-newnormal="${cfg.meters.indexOf(m)}" title="Consommation désormais normale (nouveaux habitants, piscine…) : le site réapprend le niveau normal">C'est le nouveau normal</button>` : ''}</span></li>`).join('')
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
    // Le conseil de lecture dépend du compteur : un arrosage de nuit se trahit par une consommation de JOUR, un réseau par une consommation de NUIT
    const qa = m.alerts, quiet = qa.quietMaxL > 0 && qa.quietToH > qa.quietFromH;
    const hint = quiet
      ? `Une case colorée entre ${qa.quietFromH} h et ${qa.quietToH} h est suspecte : ce compteur ne consomme normalement pas à cette heure.`
      : qa.baseFlowRatio > 0 ? 'Une fuite se voit en cases colorées la nuit, quand plus personne ne consomme.'
        : 'Une case colorée à une heure où le compteur ne consomme normalement pas est suspecte.';
    $('#heat-hint').textContent = `Litres par tranche de 2 h, moyenne sur les 4 dernières semaines. ${hint} Le texte de la case entourée (dernière mesure) passe du vert (−100 %) au blanc (comme d'habitude) puis au rouge (+200 % et au-delà) selon l'écart avec d'habitude.`;  // complété plus bas si les tranches sont décalées
    const off = WM.heatOffset(d.readings);                        // tranches décalées comme les relevés (ex. 16 h 30 – 18 h 30)
    const hh = (min) => `${Math.floor(min / 60) % 24}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`;
    if (off) $('#heat-hint').textContent += ` Les tranches sont décalées de ${off % 60 ? off + ' min' : off / 60 + ' h'} pour coïncider avec les relevés (par exemple ${hh(16 * 60 + off)} – ${hh(18 * 60 + off)}).`;
    const slot = (c) => `${hh(c * 120 + off)}–${hh(c * 120 + off + 120)}`;
    const prof = WM.weeklyProfile(d.intervals, d.readings[d.readings.length - 1].t, 4, off);
    const max = Math.max(1, ...prof.flat());
    const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const dayNames = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    const tr = WM.trendVsUsual(d.readings, d.intervals, 4);
    // case repérée : celle de la dernière tranche MESURÉE (le milieu de la tranche entre les deux derniers relevés), pas l'heure qu'il est
    const refT = tr ? (tr.t0 + tr.t1) / 2 : d.readings[d.readings.length - 1].t - 3600e3;
    const ref = new Date(refT - off * 60e3), nowRow = (ref.getDay() + 6) % 7, nowCol = Math.floor(ref.getHours() / 2);
    const vol = (x) => WM.fmtVolume(x);
    // pastille dans la case de la dernière mesure : le sens de la tendance (jamais la seule couleur)
    const tag = !tr || tr.level === 'unknown' ? ['●', 'ici']
      : tr.level === 'up' ? ['▲', `+${Math.round(tr.pct)} %`] : tr.level === 'down' ? ['▼', `−${Math.abs(Math.round(tr.pct))} %`]
        : tr.level === 'unusual' ? ['!', 'inhabituel'] : ['=', 'habituel'];
    // couleur du texte de la case repérée : dégradé vert (−100 %) → blanc (habituel) → rouge cramoisi (+200 % et au-delà)
    const mix = (c1, c2, k) => '#' + c1.map((v, i) => Math.round(v + (c2[i] - v) * k).toString(16).padStart(2, '0')).join('');
    const GREEN = [34, 197, 94], WHITE = [255, 255, 255], CRIMSON = [220, 20, 60];
    const tagColor = !tr || tr.level === 'unknown' ? '#ffffff' : tr.pct == null ? (tr.level === 'unusual' ? '#dc143c' : '#ffffff')
      : tr.pct < 0 ? mix(GREEN, WHITE, 1 - Math.min(1, -tr.pct / 100)) : mix(WHITE, CRIMSON, Math.min(1, tr.pct / 200));
    let html = '<div></div>' + Array.from({ length: 12 }, (_, i) => `<div class="h">${i % 2 === 0 ? hh(i * 120 + off) : ''}</div>`).join('');
    prof.forEach((row, r) => {
      html += `<div class="d">${days[r]}</div>`;
      row.forEach((val, c) => {
        const isNow = r === nowRow && c === nowCol;
        const pct = val <= 0 ? 0 : 10 + 90 * (val / max);
        const bg = val <= 0 ? 'color-mix(in srgb, var(--text-muted) 10%, var(--surface-1))' : `color-mix(in srgb, ${colorVar(m)} ${pct.toFixed(0)}%, var(--surface-1))`;
        const lbl = `${days[r]} ${slot(c)} : ${vol(val)} en moyenne${isNow ? ' — dernière tranche mesurée' : ''}`;
        html += `<div class="c${isNow ? ' now' : ''}" data-tip="${esc(lbl)}" style="background:${bg}" role="presentation">${isNow ? `<span class="nt" style="color:${tagColor}"><b>${tag[0]}</b><span class="t"> ${esc(tag[1])}</span></span>` : ''}</div>`;
      });
    });
    el.innerHTML = html;
    $('#heat-scale').innerHTML = `0 <span class="bar" style="background:linear-gradient(90deg,color-mix(in srgb,var(--text-muted) 10%,var(--surface-1)),color-mix(in srgb,${colorVar(m)} 10%,var(--surface-1)),${colorVar(m)})"></span> ${vol(max)} par tranche de 2 h`;

    // texte de tendance : dernière tranche mesurée comparée à la même tranche, le même jour de la semaine, les semaines précédentes
    let txt;
    if (!tr) txt = 'Pas encore assez de relevés récents pour comparer.';
    else {
      const head = `Dernière tranche horaire mesurée de <strong>${fmtHm(tr.t0)}</strong> à <strong>${fmtHm(tr.t1)}</strong> : <strong>${vol(tr.value)}</strong>`;
      if (tr.usual == null) txt = `${head} (pas assez de semaines comparables pour dire si c'est habituel).`;
      else {
        const diff = tr.value - tr.usual, big = tr.level === 'same' || Math.abs(diff) < 0.5;
        txt = big ? `${head}, comme d'habitude (${vol(tr.usual)}).`
          : `${head}, soit <strong>${vol(Math.abs(diff))} de ${diff > 0 ? 'plus' : 'moins'}</strong>${tr.pct == null ? '' : ` (${fmtDelta(tr.pct)})`} par rapport à d'habitude (${vol(tr.usual)}).`;
      }
    }
    $('#heat-trend').innerHTML = txt;
  }

  /* ---------- Profils sur la semaine, le mois, l'année ---------- */

  let calChart = null;
  const CAL_UNITS = { slot: 'tranche de 2 h', day: 'jour', week: 'semaine', month: 'mois' };
  const CAL_ALLOWED = { hour: ['slot'], weekday: ['slot', 'day'], dom: ['slot', 'day'], month: ['slot', 'day', 'week', 'month'] };
  const CAL_DEFAULT_UNIT = { hour: 'slot', weekday: 'day', dom: 'day', month: 'month' };
  function renderCal() {
    const c = state.cal = Object.assign({ x: 'weekday', unit: 'day', y: 'mean' }, state.cal);
    if (!CAL_ALLOWED[c.x].includes(c.unit)) c.unit = CAL_DEFAULT_UNIT[c.x];
    const uname = CAL_UNITS[c.unit];
    $('#cal-x').value = c.x;
    $('#cal-unit').innerHTML = CAL_ALLOWED[c.x].map((u) => `<option value="${u}">${CAL_UNITS[u][0].toUpperCase() + CAL_UNITS[u].slice(1)}</option>`).join(''); $('#cal-unit').value = c.unit;
    $('#cal-y').innerHTML = `<option value="mean">Volume moyen par ${uname}</option><option value="max">Volume de la ${c.unit === 'day' || c.unit === 'month' ? 'plus forte' : 'plus forte'} ${uname}</option><option value="flow">Débit minimal (fuite, L/h)</option>`;
    $('#cal-y').value = c.y;
    const metersData = cfg.meters.filter((m) => state.data[m.id] && state.data[m.id].readings.length);
    if (!metersData.length) { $('#cal-note').textContent = ''; return; }
    const off = c.x === 'hour' || c.unit === 'slot' ? WM.heatOffset(state.data[metersData[0].id].readings) : 0;
    const prof = Object.fromEntries(metersData.map((m) => [m.id, WM.groupedProfile(state.data[m.id].readings, state.data[m.id].intervals, { x: c.x, y: c.y, unit: c.unit, offsetMin: off }).groups]));
    const hh = (min) => `${Math.floor(min / 60) % 24}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`;
    const labels = { weekday: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'], dom: Array.from({ length: 31 }, (_, i) => String(i + 1)), month: ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'], hour: Array.from({ length: 12 }, (_, i) => hh(i * 120 + off)) }[c.x];
    const full = { weekday: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'], dom: labels.map((l) => `le ${l}`), month: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'], hour: labels.map((l, i) => `${hh(i * 120 + off)} – ${hh(i * 120 + off + 120)}`) }[c.x];
    $('#cal-hint').textContent = `${c.y === 'flow' ? 'Plus petit débit observé' : c.y === 'max' ? 'Plus forte consommation observée' : 'Consommation moyenne'} sur une ${uname}, selon ${{ weekday: 'le jour de la semaine', hour: "l'heure du jour", dom: 'le jour du mois', month: "le mois de l'année" }[c.x]}. Seules les périodes complètes et mesurées comptent.`;
    const fmt = (v) => (c.y === 'flow' ? `${v < 10 ? v.toFixed(1).replace('.', ',') : Math.round(v)} L/h` : WM.fmtVolume(v));
    const note = metersData.map((m) => {
      const arr = prof[m.id], best = arr.reduce((bi, x, i) => (x.n && (bi < 0 || x.value > arr[bi].value) ? i : bi), -1), low = arr.reduce((bi, x, i) => (x.n && (bi < 0 || x.value < arr[bi].value) ? i : bi), -1);
      const who = `<span class="who"><span class="dot" style="background:${colorVar(m)}"></span>${esc(m.name)}</span>`;
      return best < 0 ? `${who} : pas encore de période complète.` : `${who} : le plus fort <strong>${full[best]}</strong> (${fmt(arr[best].value)}, ${arr[best].n} mesure${arr[best].n > 1 ? 's' : ''})${low !== best ? `, le plus faible <strong>${full[low]}</strong> (${fmt(arr[low].value)})` : ''}.`;
    }).join('<br>');
    $('#cal-note').innerHTML = note;
    const peak = Math.max(1, ...metersData.flatMap((m) => prof[m.id].map((x) => x.value || 0)));
    const k = c.y !== 'flow' && peak >= 5000 ? 1000 : 1, unit = c.y === 'flow' ? 'L/h' : (k === 1000 ? 'm³' : 'L') + ' par ' + uname;
    const ink = cssVar('--text-secondary'), grid = cssVar('--grid'), surface = cssVar('--surface-1'), border = cssVar('--border'), primary = cssVar('--text-primary');
    const datasets = metersData.map((m) => ({ label: m.name, raw: prof[m.id], data: prof[m.id].map((x) => (x.value == null ? null : x.value / k)), backgroundColor: cssVar(`--series-${m.slot}`), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', maxBarThickness: 28, barPercentage: 0.9, categoryPercentage: 0.8 }));
    if (calChart) calChart.destroy();
    calChart = new Chart($('#cal-chart'), {
      type: 'bar', data: { labels, datasets },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
        scales: { x: { grid: { display: false }, border: { color: grid }, ticks: { color: ink, maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } }, y: { beginAtZero: true, border: { display: false }, grid: { color: grid }, ticks: { color: ink }, title: { display: true, text: unit, color: ink } } },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: surface, titleColor: primary, bodyColor: ink, borderColor: border, borderWidth: 1, padding: 10,
          callbacks: { title: (it) => full[it[0].dataIndex], label: (ci) => { const r = ci.dataset.raw[ci.dataIndex]; return ` ${ci.dataset.label} : ${r.n ? fmt(r.value) + ' (' + r.n + ' mesure' + (r.n > 1 ? 's' : '') + ')' : 'pas de mesure'}`; } } } } },
    });
    $('#cal-chart').setAttribute('aria-label', `${$('#cal-hint').textContent}`);
  }

  /* ---------- Aide ---------- */

  function openHelp() {
    const dlg = $('#help');
    const bureau = canEdit();
    dlg.innerHTML = `<div class="dlg-body help-body"><div class="dlg-head"><h2>Aide</h2><button class="dlg-x" type="button" aria-label="Fermer" title="Fermer" data-dlg-close>✕</button></div>
      <h3>Les trois pages</h3>
      <ul>
        <li><strong>Synthèse</strong> : les alertes en cours, puis pour chaque compteur la consommation d'aujourd'hui, d'hier, de la semaine, du mois et de l'année. « Calendaire » compte depuis le début du jour, de la semaine (lundi), du mois, de l'année ; « Glissant » compte les dernières 24 h, 7 jours, 30 jours, 12 mois.</li>
        <li><strong>Graphiques</strong> : la consommation par heure, jour, semaine, mois ou année, et l'index du compteur. Le signe « ≈ » ou une teinte plus claire signale une période seulement estimée, faute de relevés assez rapprochés.</li>
        <li><strong>Profil horaire</strong> (et en dessous « Quand consomme-t-on le plus ? » : moyenne par jour de la semaine, par jour du mois et par mois de l'année) : la consommation moyenne de chaque tranche de 2 h, par jour de semaine (4 dernières semaines). La case entourée est celle de la <strong>dernière mesure</strong> ; son texte passe du vert (consommation plus faible que d'habitude, ▼) au blanc (pareil, =) puis au rouge cramoisi (plus forte, ▲, saturé à +200 %). Selon le compteur : pour l'eau potable une fuite se voit en cases colorées la nuit ; pour l'arrosage (qui ne coule que la nuit) c'est une case colorée en journée qui est suspecte.</li>
      </ul>
      <h3>D'où viennent les chiffres</h3>
      <p>Le compteur envoie son index toutes les 2 heures environ ; la consommation d'une période est calculée à partir de ces index, répartis au prorata du temps. Le prochain relevé attendu est indiqué en haut de page. Le bouton ↻ recharge les données.</p>
      <h3>Colombine</h3>
      <p>La bulle en bas à droite ouvre Colombine, l'assistante de l'ASL. Elle répond aux questions sur l'eau (consommation, alertes, jour le plus fort, comment fonctionnent les seuils) et sur l'ASL, comme sur le site de l'ASL. Elle ne peut rien modifier ici.</p>
      <h3>Les alertes</h3>
      <ul>
        <li><span class="pill critical"><i>×</i>Critique</span> : plus de relevé depuis longtemps, consommation du jour au-dessus du seuil, très gros débit.</li>
        <li><span class="pill serious"><i>!</i>Important</span> : fuite possible (écoulement sans arrêt ou débit de fond anormal), consommation dans une plage où le compteur ne devrait pas consommer, consommation du mois au-dessus du seuil.</li>
        <li><span class="pill warning"><i>!</i>Attention</span> : 80 % du seuil du jour, jour anormal, index en recul.</li>
      </ul>
      <p>Les alertes critiques et importantes sont aussi envoyées <strong>par mail au bureau</strong> (à l'apparition, rappel toutes les 24 h, puis au rétablissement).</p>
      <h3>Des seuils qui suivent les besoins</h3>
      <p>Pour l'eau potable, le site apprend la consommation <strong>normale par maison habitée</strong> (les 28 derniers jours normaux) et surveille l'écart : l'arrivée de nouvelles maisons ne déclenche pas de fausse alerte, une fuite (l'eau ne descend plus à zéro la nuit) ou un gros écart de consommation, si. Une hausse lente est suivie automatiquement ; un jour anormal n'est <strong>jamais</strong> appris comme « normal » tant qu'on ne l'a pas décidé.</p>
      <ul>
        <li><strong>Nouvelle maison habitée</strong> : annoncez-la dans Paramètres → Situation du lotissement (nombre de maisons habitées au total à partir d'une date, y compris dans le futur). Le niveau normal monte ce jour-là.</li>
        <li><strong>Maisons en travaux</strong> : leur consommation est irrégulière ; indiquez leur nombre, le site élargit un peu la tolérance (15 % par chantier). Les compléments d'eau habituels des piscines sont appris comme normaux ; le remplissage d'une piscine est un événement exceptionnel.</li>
        <li><strong>Événement ponctuel</strong> (remplissage de piscine, grosse fête) : annoncez-le en « Événements exceptionnels » ; les alertes de consommation sont suspendues et ces jours ne sont pas appris.</li>
        <li><strong>Changement durable non annoncé</strong> (une piscine qui se remplit en continu…) : sur l'alerte, « C'est le nouveau normal » ; le site réapprend pendant 7 jours.</li>
      </ul>
      <h3>Réservé au bureau</h3>
      <ul>
        <li><strong>Données</strong> (icône base de données) : ajouter un relevé fait à la main, corriger ou supprimer un relevé, et chercher un relevé par date.</li>
        <li><strong>Paramètres</strong> (icône d'engrenage) : pour chaque compteur, son type (réseau ou arrosage), la consommation maximale par jour et le délai sans relevé ; les alertes par mail ; et, repliés, les réglages techniques : réception depuis Live Objects, clé de réception, sauvegardes et export CSV de tous les relevés.</li>
      </ul>
      <p class="small muted">${bureau ? 'Vous êtes membre du bureau : vous voyez ces deux boutons.' : 'Vous consultez le suivi : les boutons Données et Paramètres sont réservés au bureau.'} Le thème clair ou sombre se change avec le bouton rond en haut à droite ; il suit aussi le site de l'ASL.</p>
      <div class="dlg-actions"><button class="btn primary" type="button" id="btn-help-close">Fermer</button></div></div>`;
    $('#btn-help-close').onclick = () => dlg.close();
    dlg.showModal();
    dlg.scrollTop = 0;   // le bouton « Fermer » prend le focus : on remonte au titre
  }

  /* ---------- Paramètres ---------- */

  const peopleRow = (x) => `<div class="rowline" data-people><input type="date" name="p_from" value="${esc(x.from)}" aria-label="À partir du"><input type="number" name="p_n" min="1" max="100000" value="${x.n}" aria-label="Maisons habitées"><span>maisons habitées</span><button type="button" class="dlg-x" data-rm aria-label="Supprimer cette ligne" title="Supprimer">✕</button></div>`;
  const eventRow = (x) => `<div class="rowline" data-event><input name="e_label" placeholder="Ex. remplissage de piscine" value="${esc(x.label)}" aria-label="Événement"><input type="date" name="e_from" value="${esc(x.from)}" aria-label="Du"><span>au</span><input type="date" name="e_to" value="${esc(x.to)}" aria-label="Au"><button type="button" class="dlg-x" data-rm aria-label="Supprimer cet événement" title="Supprimer">✕</button></div>`;

  /** Ce que le site a appris d'un compteur (avec les paramètres enregistrés) : niveau normal, seuils. */
  function adaptiveInfoText(m) {
    const d = state.data[m.id];
    if (!d || !d.readings.length) return 'Pas encore de données.';
    const a = WM.adaptiveAssess(m, cfg.site, d.readings, d.intervals, Date.now());
    const since = m.since ? ` (apprentissage depuis le ${m.since})` : '';
    if (!a.ready) return `Apprentissage en cours : ${a.learned} journée${a.learned > 1 ? 's' : ''} normale${a.learned > 1 ? 's' : ''} retenue${a.learned > 1 ? 's' : ''} sur 7 nécessaires${since}. Les alertes automatiques de volume et de débit de fond commencent ensuite ; les autres règles restent actives.`;
    const lim = [Number.isFinite(a.vMax) ? `la consommation du jour dépasse ${WM.fmtVolume(a.vMax)}` : '', Number.isFinite(a.fMax) ? `l'eau ne descend jamais sous ${Math.round(a.fMax)} L/h pendant 24 h` : ''].filter(Boolean).join(' ou ');
    return `Niveau normal appris pour ${a.people} maison${a.people > 1 ? 's' : ''} habitée${a.people > 1 ? 's' : ''} : environ ${WM.fmtVolume(a.ref.v)} par jour (${WM.fmtVolume(a.ref.v / a.people)} par maison), débit de fond ≈ ${Math.round(a.ref.f)} L/h${since}. ${lim ? 'Alerte si ' + lim + '.' : ''}`;
  }

  function settingsHtml() {
    const num = (name, label, v, extra = '', hint = '') => `<div class="field"><label>${label}</label><input name="${name}" type="number" min="0" ${extra} value="${v}">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
    const siteFs = `<fieldset id="site-fs"><legend>Situation du lotissement</legend>
        <p class="small">Le site apprend la consommation <strong>normale par maison habitée</strong> et surveille l'écart : l'arrivée d'une nouvelle maison habitée ne déclenche donc pas de fausse alerte, alors qu'une fuite, elle, reste signalée. Annoncez ici le nombre de maisons habitées <strong>au total</strong>, à partir de chaque date (passée ou prévue).</p>
        <div id="people-rows">${(cfg.site.people || []).map(peopleRow).join('')}</div>
        <div><button class="btn" type="button" id="btn-add-people">Ajouter un changement (nouvelle maison habitée)</button></div>
        <div class="field"><label for="site-works">Maisons en travaux</label><input id="site-works" name="works" type="number" min="0" max="100" value="${cfg.site.works || 0}"><span class="hint">Leur consommation est irrégulière (béton, nettoyage, essais) : le site élargit un peu la tolérance sur le volume du jour (15 % par maison en travaux). Mettez 0 quand il n'y en a plus.</span></div>
        <h3>Événements exceptionnels</h3>
        <p class="small muted">Événements ponctuels : remplissage d'une piscine, grosse fête, essai d'une installation… Pendant ces jours les alertes de consommation sont suspendues et le site n'apprend rien de ces journées. (Les travaux qui durent se règlent plus haut avec « Maisons en travaux ».)</p>
        <div id="event-rows">${(cfg.site.events || []).map(eventRow).join('')}</div>
        <div><button class="btn" type="button" id="btn-add-event">Ajouter un événement</button></div></fieldset>`;
    const meterFs = cfg.meters.map((m, i) => `
      <fieldset data-i="${i}" class="meter-fs"><legend><span class="dot" style="background:${colorVar(m)}"></span> ${esc(m.name)}</legend>
        <div class="field"><label>Nom</label><input name="name" value="${esc(m.name)}"></div>
        <div class="field"><label>Type de compteur</label>
          <select data-kind>
            <option value="reseau">Réseau : l'eau ne s'arrête jamais (ex. eau potable)</option>
            <option value="arrosage">Arrosage : s'arrête normalement (ex. arrosage de nuit)</option>
            <option value="perso">Personnalisé (paramètres détaillés)</option>
          </select>
          <span class="hint" data-kind-hint></span></div>
        <div class="adaptive-box" data-adaptive-box>
          <label class="check"><input type="checkbox" name="adaptive" ${m.adaptive ? 'checked' : ''}> Seuils automatiques : ils s'adaptent au nombre de maisons habitées</label>
          <input type="hidden" name="since" value="${esc(m.since || '')}">
          <p class="small muted" data-adaptive-info>${esc(adaptiveInfoText(m))}</p>
          <div><button class="btn" type="button" data-relearn>C'est le nouveau normal : réapprendre à partir d'aujourd'hui</button></div>
        </div>
        <div class="grid2">
          <div class="field" data-daily-field><label><span data-daily-lbl>Consommation maximale par jour (L)</span></label><input name="dailyLimitL" type="number" min="0" value="${m.alerts.dailyLimitL}"><span class="hint" data-daily-hint>Alerte critique au-delà, « attention » à 80 %. 0 = pas de limite.</span></div>
          ${num('staleHours', 'Aucun relevé depuis (h)', m.alerts.staleHours, '', 'Alerte critique si le compteur ne répond plus. Il envoie un relevé toutes les 2 h.')}
          <div class="field" data-quiet>${'<label>Pas de consommation de (h)</label>'}<input name="quietFromH" type="number" min="0" max="24" step="0.5" value="${m.alerts.quietFromH}"><span class="hint">Plage où l'arrosage ne doit pas couler, par exemple de 6 à 18.</span></div>
          <div class="field" data-quiet><label>… à (h)</label><input name="quietToH" type="number" min="0" max="24" step="0.5" value="${m.alerts.quietToH}"></div>
        </div>
        <p class="rule-summary small" data-summary></p>
        <details class="adv"><summary>Paramètres détaillés</summary>
          <div class="grid2">
            ${num('monthlyLimitL', 'Consommation maximale par mois (L)', m.alerts.monthlyLimitL, '', '0 = pas de limite.')}
            ${num('maxFlowLph', 'Débit moyen maximal sur 2 h (L/h)', m.alerts.maxFlowLph, '', 'Alerte critique en cas de gros débit (rupture de tuyau).')}
            ${num('leakHours', 'Fuite : écoulement continu depuis (h)', m.alerts.leakHours, '', '0 = désactivé. Pour un compteur qui s\'arrête normalement (arrosage).')}
            ${num('quietMaxL', 'Plage ci-dessus : alerte si une tranche dépasse (L)', m.alerts.quietMaxL, '', '0 = désactivé.')}
            ${num('baseFlowRatio', 'Débit de fond : × la normale', m.alerts.baseFlowRatio, 'step="0.1"', '0 = désactivé. Pour un compteur qui ne s\'arrête jamais (fuite lente).')}
            ${num('baseFlowMinLph', '… et au moins (L/h) de plus', m.alerts.baseFlowMinLph)}
            ${num('spikeRatio', 'Jour anormal : × la consommation normale', m.alerts.spikeRatio, 'step="0.1"', 'Avec les seuils automatiques : alerte si le volume du jour dépasse ce multiple du niveau normal pour le nombre d\'habitants. 0 = désactivé.')}
          </div>
          <div class="grid2">
            <div class="field"><label>Variable de l'index</label><input name="variable" list="vars" value="${esc(m.variable)}"></div>
            <div class="field"><label>Litres par unité d'index</label><input name="litresPerUnit" type="number" step="any" min="0" value="${m.litresPerUnit}"><span class="hint">1 : l'index du compteur est déjà en litres. 1000 s'il est en m³.</span></div>
          </div>
        </details>
      </fieldset>`).join('');
    return `<form method="dialog" id="settings-form">
      <div class="dlg-head"><h2>Paramètres</h2><button class="dlg-x" type="button" aria-label="Fermer" title="Fermer" data-dlg-close>✕</button></div>
      ${mode === 'server' ? '<p class="hint">Ces paramètres s\'appliquent à tous les utilisateurs du site.</p>' : ''}
      ${siteFs}
      ${meterFs}
      ${mode === 'server' ? `<fieldset><legend>Alertes par mail</legend>
        <p class="small">Le site recalcule les alertes toutes les heures. Les alertes <strong>critiques et importantes</strong> sont envoyées par mail au <strong>bureau</strong> (comptes « bureau » de l'ASL), via la messagerie Gmail de l'ASL : un mail à l'apparition, un rappel toutes les 24 h tant que l'alerte dure (3 au plus), un mail au rétablissement. Les alertes « attention » restent visibles sur la page seulement.</p>
        <label class="check"><input type="checkbox" id="am-enabled"> Envoyer les alertes par mail au bureau</label>
        <div id="am-box" class="small">Chargement…</div>
        <div class="row-btns"><button class="btn" type="button" id="btn-am-test">Envoyer un mail de test</button> <button class="btn" type="button" id="btn-am-check">Contrôler maintenant</button></div>
        <p class="hint">Les mails partent de la file d'attente de l'ASL : le script Gmail les envoie dans les 10 minutes.</p></fieldset>` : ''}
      <details class="adv tech"><summary>Paramètres techniques : réception des données, clé, sauvegarde</summary>
      <div class="stack">
      <fieldset><legend>Données reçues de Live Objects</legend>
        <div class="grid2">
          <div class="field"><label>Historique affiché (années)</label><input name="historyYears" type="number" min="1" max="10" value="${cfg.historyYears}"><span class="hint">Combien d'années de relevés la page charge à son ouverture pour les graphiques et les comparaisons (année précédente…). Tous les relevés restent conservés ; une valeur plus grande rend seulement le chargement plus lent.</span></div>
          <div class="field"><label>Actualisation automatique (minutes)</label><input name="refreshMin" type="number" min="1" value="${cfg.refreshMin}"><span class="hint">Toutes les combien de minutes une page restée ouverte va chercher les nouveaux relevés. Le compteur n'en envoie qu'un toutes les 2 h : 10 minutes suffisent.</span></div>
        </div>
        <div><button class="btn" type="button" id="btn-detect">Variables et derniers messages reçus</button></div>
        <div id="detect-out" hidden></div><datalist id="vars"></datalist>
      </fieldset>
      ${mode === 'server' ? '<fieldset><legend>Clé de réception Live Objects</legend><div id="key-box" class="small">Chargement…</div></fieldset>' : ''}
      ${mode === 'server' ? `<fieldset><legend>Sauvegarde des relevés</legend>
        <p class="small">Tous les relevés sont conservés sans limite de durée.</p>
        <div id="backup-box" class="small">Chargement…</div>
        <p class="small">Vous pouvez aussi garder une copie chez vous : le fichier CSV contient la variable, l'heure (UTC), la valeur en litres et l'origine (auto ou manuel).</p>
        <div><a class="btn" href="api/export.csv" download>Télécharger tous les relevés (CSV)</a></div>
        <p class="hint">Se réimporte avec <code>scripts/import.mjs</code> (voir le README). La restauration redonne les mêmes relevés, origine comprise.</p></fieldset>` : ''}
      </div></details>
      <div class="dlg-actions">
        <button class="btn" type="button" id="btn-reset">Valeurs par défaut</button>
        <button class="btn" type="button" id="btn-cancel">Annuler</button>
        <button class="btn primary" type="submit" value="save">Enregistrer</button>
      </div></form>`;
  }

  /** Bouton de la liste d'alertes : la consommation actuelle devient la nouvelle normale (le site réapprend à partir d'aujourd'hui). */
  async function newNormal(i) {
    const m = cfg.meters[i]; if (!m) return;
    if (!window.confirm(`Considérer la consommation actuelle de « ${m.name} » comme normale ?\n\nÀ utiliser après un changement durable : nouvelles maisons, piscine… Le site oubliera ce qu'il avait appris avant aujourd'hui et réapprendra le niveau normal pendant 7 jours (sans alerte automatique de volume ni de débit de fond pendant ce temps).\n\nSi c'est un événement ponctuel (remplissage de piscine), annoncez-le plutôt dans Paramètres → Événements exceptionnels.`)) return;
    m.since = WM.dayKey(Date.now());
    try { await saveCfg(); } catch (e) { window.alert('Enregistrement impossible : ' + e.message); }
    start();
  }

  /* ---------- Réglages d'alerte simplifiés : un type de compteur, deux seuils, le détail repliable ---------- */

  const KIND_PRESETS = {
    reseau: { leakHours: 0, quietMaxL: 0, quietFromH: 0, quietToH: 0, baseFlowRatio: 2, baseFlowMinLph: 20, spikeRatio: 2 },
    arrosage: { leakHours: 12, quietMaxL: 10, quietFromH: 6, quietToH: 18, baseFlowRatio: 0, baseFlowMinLph: 0, spikeRatio: 0 },
  };
  const KIND_HINT = {
    reseau: 'On surveille le débit de fond (une fuite lente se voit à l\'eau qui ne descend jamais à zéro la nuit) et les jours anormaux.',
    arrosage: 'On surveille l\'écoulement continu et toute consommation dans la plage interdite (par exemple en journée si l\'arrosage se fait la nuit).',
    perso: 'Chaque règle est réglable dans « Paramètres détaillés ».',
  };
  function kindOf(a) {
    if (a.leakHours === 0 && a.quietMaxL === 0 && a.baseFlowRatio > 0) return 'reseau';
    if (a.baseFlowRatio === 0 && a.spikeRatio === 0 && (a.leakHours > 0 || a.quietMaxL > 0)) return 'arrosage';
    return 'perso';
  }
  /** Phrase qui dit, en clair, ce qui est surveillé avec les réglages du formulaire. */
  function ruleSummary(a, adaptive) {
    const L = (x) => WM.fmtVolume(x), r = [];
    if (a.staleHours > 0) r.push(`aucun relevé depuis ${a.staleHours} h`);
    if (adaptive && a.spikeRatio > 0) r.push(`consommation du jour × ${String(a.spikeRatio).replace('.', ',')} la normale (selon les maisons habitées)`);
    if (a.dailyLimitL > 0) r.push(adaptive ? `plafond absolu de ${L(a.dailyLimitL)} par jour` : `plus de ${L(a.dailyLimitL)} par jour`);
    if (a.monthlyLimitL > 0) r.push(`plus de ${L(a.monthlyLimitL)} par mois`);
    if (a.maxFlowLph > 0) r.push(`débit supérieur à ${a.maxFlowLph} L/h`);
    if (a.leakHours > 0) r.push(`écoulement continu depuis ${a.leakHours} h`);
    if (a.quietMaxL > 0 && a.quietToH > a.quietFromH) r.push(`plus de ${L(a.quietMaxL)} entre ${a.quietFromH} h et ${a.quietToH} h`);
    if (a.baseFlowRatio > 0) r.push(`débit de fond anormal (× ${String(a.baseFlowRatio).replace('.', ',')} la normale)`);
    if (!adaptive && a.spikeRatio > 0) r.push(`jour × ${String(a.spikeRatio).replace('.', ',')} la médiane`);
    return r.length ? `<strong>Alerte quand :</strong> ${r.join(' ; ')}.` : 'Aucune alerte active pour ce compteur.';
  }
  function wireMeterForm(fs) {
    const inp = (n) => fs.querySelector(`[name="${n}"]`);
    const read = () => { const a = {}; for (const k of ['dailyLimitL', 'monthlyLimitL', 'maxFlowLph', 'leakHours', 'quietFromH', 'quietToH', 'quietMaxL', 'baseFlowRatio', 'baseFlowMinLph', 'spikeRatio', 'staleHours']) a[k] = Number(inp(k).value) || 0; return a; };
    const sel = fs.querySelector('[data-kind]');
    const refresh = (setKind) => {
      const a = read(), kind = setKind || kindOf(a);
      sel.value = kind;
      fs.querySelector('[data-kind-hint]').textContent = KIND_HINT[kind];
      fs.querySelectorAll('[data-quiet]').forEach((el) => { el.hidden = kind === 'reseau'; });
      const ad = fs.querySelector('[name="adaptive"]').checked;
      fs.querySelector('[data-summary]').innerHTML = ruleSummary(a, ad);
      fs.querySelector('[data-adaptive-box]').hidden = kind === 'arrosage';
      fs.querySelector('[data-daily-lbl]').textContent = ad ? 'Plafond absolu par jour (L), facultatif' : 'Consommation maximale par jour (L)';
      fs.querySelector('[data-daily-hint]').textContent = ad ? 'Garde-fou en plus des seuils automatiques : alerte critique au-delà, quoi qu\'il arrive. 0 = aucun.' : 'Alerte critique au-delà, « attention » à 80 %. 0 = pas de limite.';
    };
    sel.onchange = () => {
      const p = KIND_PRESETS[sel.value];
      if (p) for (const [k, v] of Object.entries(p)) { if (k === 'quietFromH' || k === 'quietToH') { if (v === 0 || !Number(inp(k).value)) inp(k).value = v; } else inp(k).value = v; }
      if (p && Number(inp('maxFlowLph').value) === 0) inp('maxFlowLph').value = 1500;
      if (sel.value === 'reseau') { inp('adaptive').checked = true; inp('dailyLimitL').value = 0; } else if (sel.value === 'arrosage') inp('adaptive').checked = false;
      refresh(sel.value);
    };
    fs.addEventListener('input', (e) => { if (e.target !== sel) refresh(); });
    fs.querySelector('[data-relearn]').onclick = () => {
      if (!window.confirm('Considérer la consommation actuelle comme normale ?\n\nLe site oubliera ce qu\'il avait appris avant aujourd\'hui et réapprendra le niveau normal pendant 7 jours (sans alerte automatique de volume ni de débit de fond pendant ce temps). À utiliser après un changement durable : nouvelles maisons, piscine…')) return;
      inp('since').value = WM.dayKey(Date.now());
      fs.querySelector('[data-adaptive-info]').textContent = 'Le site réapprendra à partir d\'aujourd\'hui dès que vous aurez enregistré.';
    };
    refresh();
    if (kindOf(read()) === 'perso') fs.querySelector('details.adv').open = true;
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
      m.adaptive = fs.querySelector('[name="adaptive"]').checked;
      m.since = /^\d{4}-\d{2}-\d{2}$/.test(v('since')) ? v('since') : '';
    });
    const val = (row, n) => row.querySelector(`[name="${n}"]`).value;
    const people = [...form.querySelectorAll('[data-people]')].map((r) => ({ from: val(r, 'p_from'), n: Math.round(Number(val(r, 'p_n'))) }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.from) && x.n >= 1).sort((a, b) => (a.from < b.from ? -1 : 1));
    next.site = {
      works: Math.max(0, Math.round(Number(form.querySelector('[name="works"]').value) || 0)),
      people: people.length ? people : cfg.site.people,
      events: [...form.querySelectorAll('[data-event]')].map((r) => ({ label: val(r, 'e_label').trim() || 'Événement', from: val(r, 'e_from'), to: val(r, 'e_to') }))
        .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.from) && /^\d{4}-\d{2}-\d{2}$/.test(x.to) && x.from <= x.to),
    };
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

  async function loadBackupBox() {
    const box = $('#backup-box'); if (!box) return;
    try {
      const st = await apiGet('backup', {});
      const d = (iso) => fmtFull(Date.parse(iso));
      const kb = (b) => `${Math.max(1, Math.round(b / 1024))} Ko`;
      let html = '';
      if (!st.configured) html = '<p class="rd-msg err">Sauvegarde automatique non configurée : le stockage R2 n\'est pas relié à ce site (voir le README).</p>';
      else {
        html += '<p>Sauvegarde automatique <strong>chaque lundi vers R2</strong> (bucket <code>eau-sauvegardes</code>). Les sauvegardes ne sont jamais supprimées.</p>';
        if (st.last) html += st.last.ok
          ? `<p>✓ Dernière sauvegarde : ${esc(d(st.last.at))} (${st.last.kind === 'hebdo' ? 'automatique' : 'manuelle, ' + esc(st.last.by)}) — ${st.last.rows} relevés, ${kb(st.last.bytes)}.</p>`
          : `<p class="rd-msg err">✗ Dernière tentative en échec (${esc(d(st.last.at))}) : ${esc(st.last.error)}</p>`;
        else html += '<p class="muted">Aucune sauvegarde pour l\'instant : la première aura lieu lundi, ou lancez-la maintenant.</p>';
        html += `<p class="hint">${st.total} fichier${st.total > 1 ? 's' : ''} dans le bucket.</p><div><button class="btn" type="button" id="btn-backup-now">Sauvegarder maintenant</button></div>`;
      }
      box.innerHTML = html;
      const b = $('#btn-backup-now'); if (b) b.onclick = backupNow;
    } catch (e) { box.textContent = 'Lecture impossible : ' + e.message; }
  }

  /* ---------- Alertes par mail (réglages) ---------- */

  async function loadAlertsMailBox() {
    const box = $('#am-box'); if (!box) return;
    try {
      const st = await apiGet('alerts-mail', {});
      const d = (ms) => fmtFull(ms);
      $('#am-enabled').checked = !!st.enabled;
      let html = '';
      if (!st.enabled) html += '<p class="muted">Envoi par mail désactivé : les alertes ne sont affichées que sur la page.</p>';
      if (st.last) html += st.last.ok
        ? `<p>✓ Dernier contrôle : ${esc(d(st.last.at))} — ${st.last.active} alerte${st.last.active > 1 ? 's' : ''} critique${st.last.active > 1 ? 's' : ''} ou importante${st.last.active > 1 ? 's' : ''} en cours.</p>`
        : `<p class="rd-msg err">✗ Dernier contrôle en échec (${esc(d(st.last.at))}) : ${esc(st.last.error)}. Nouvel essai dans l'heure.</p>`;
      else html += '<p class="muted">Aucun contrôle pour l\'instant : le premier a lieu dans l\'heure.</p>';
      if (st.last && st.last.lastMail) html += `<p class="small">Dernier mail déposé : ${esc(d(st.last.lastMail.at))} — « ${esc(st.last.lastMail.subject)} » (${st.last.lastMail.recipients} destinataire${st.last.lastMail.recipients > 1 ? 's' : ''}).</p>`;
      if (st.tracked.length) html += '<p class="small">Alertes signalées et encore suivies : ' + st.tracked.map((a) => `${esc(a.meter)} (${a.level === 'critical' ? 'critique' : 'importante'}, depuis ${esc(d(a.first_at))})`).join(' ; ') + '.</p>';
      box.innerHTML = html;
    } catch (e) { box.textContent = 'Lecture impossible : ' + e.message; }
    $('#am-enabled').onchange = async (ev) => {
      try { await apiSend('PUT', 'alerts-mail', { enabled: ev.target.checked }); } catch (e) { window.alert('Enregistrement impossible : ' + e.message); ev.target.checked = !ev.target.checked; }
      loadAlertsMailBox();
    };
    $('#btn-am-test').onclick = async (ev) => {
      const b = ev.target; b.disabled = true; b.textContent = 'Envoi…';
      try {
        const r = (await apiSend('POST', 'alerts-mail/test', {})).result;
        window.alert(r.ok ? `Mail de test déposé dans la file de l'ASL pour ${r.recipients} destinataire${r.recipients > 1 ? 's' : ''} (le bureau). Il part dans les 10 minutes.` : 'Mail de test impossible : ' + r.error);
      } catch (e) { window.alert('Mail de test impossible : ' + e.message); }
      b.disabled = false; b.textContent = 'Envoyer un mail de test';
    };
    $('#btn-am-check').onclick = async (ev) => {
      const b = ev.target; b.disabled = true; b.textContent = 'Contrôle…';
      try {
        const r = (await apiSend('POST', 'alerts-mail/check', {})).result;
        window.alert(!r.ok ? 'Contrôle en échec : ' + r.error : !r.enabled ? 'Envoi par mail désactivé : rien n\'a été envoyé.' : r.sent ? `Mail déposé pour ${r.recipients} destinataire${r.recipients > 1 ? 's' : ''} : « ${r.subject} ».` : `Contrôle terminé : ${r.active} alerte${r.active > 1 ? 's' : ''} en cours, aucun nouveau mail à envoyer.`);
      } catch (e) { window.alert('Contrôle impossible : ' + e.message); }
      loadAlertsMailBox();
    };
  }

  async function backupNow() {
    const b = $('#btn-backup-now'); b.disabled = true; b.textContent = 'Sauvegarde…';
    try { const r = (await apiSend('POST', 'backup', {})).result; if (!r.ok) window.alert('Sauvegarde en échec : ' + r.error); }
    catch (e) { window.alert('Sauvegarde impossible : ' + e.message); }
    await loadBackupBox();
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
    dlg.querySelectorAll('fieldset.meter-fs').forEach(wireMeterForm);
    $('#btn-add-people').onclick = () => { const rows = $('#people-rows').querySelectorAll('[data-people]'); const last = rows.length ? Number(rows[rows.length - 1].querySelector('[name="p_n"]').value) || 6 : 6; $('#people-rows').insertAdjacentHTML('beforeend', peopleRow({ from: WM.dayKey(Date.now()), n: last })); };
    $('#btn-add-event').onclick = () => $('#event-rows').insertAdjacentHTML('beforeend', eventRow({ label: '', from: WM.dayKey(Date.now()), to: WM.dayKey(Date.now()) }));
    $('#site-fs').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.rowline').remove(); };
    if (mode === 'server') { loadKeyBox(); loadBackupBox(); loadAlertsMailBox(); }
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
      dlg.innerHTML = '<form method="dialog"><h2>Données</h2><p>La saisie n\'est pas disponible en mode démonstration : la page n\'est pas reliée à la base de données.</p><div class="dlg-actions"><button class="btn primary">Fermer</button></div></form>';
      dlg.showModal(); return;
    }
    rd.edit = null; rd.msg = ''; rd.err = false;
    dlg.innerHTML = `<div class="dlg-body"><div class="dlg-head"><h2>Données</h2><button class="dlg-x" type="button" aria-label="Fermer" title="Fermer" data-dlg-close>✕</button></div>
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

  // Le thème est géré par theme.js (commun avec l'ASL) ; on redessine les graphiques quand il change.
  document.addEventListener('themechange', () => { try { renderView(); } catch (e) { /* page pas encore prête */ } });

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
  function renderView() { if (state.view === 'graphiques') renderChart(); else if (state.view === 'profil') { renderHeat(); renderCal(); } }

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
    $('#btn-refresh').onclick = async () => { $('#status').textContent = 'Actualisation…'; await loadAll(true); renderAll(); };
    $('#btn-logout').onclick = async () => {
      try { location.href = (await apiSend('POST', 'logout', {})).result.url; }   // ferme la session ici puis celle de l'ASL
      catch (e) { window.alert('Déconnexion impossible : ' + e.message); }
    };
    $('#btn-settings').onclick = openSettings;
    $('#btn-help').onclick = openHelp;
    for (const [id, key] of [['#cal-x', 'x'], ['#cal-unit', 'unit'], ['#cal-y', 'y']]) $(id).addEventListener('change', (e) => { state.cal = Object.assign({}, state.cal, { [key]: e.target.value }); if (key === 'x') delete state.cal.unit; renderCal(); });
    document.addEventListener('click', (ev) => { const x = ev.target.closest('[data-dlg-close]'); if (x) { const d = x.closest('dialog'); if (d) d.close(); } });
    $('#btn-readings').onclick = openReadings;
    setupReadings();
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-open-settings')) openSettings();
      else if (t.dataset.newnormal != null) newNormal(Number(t.dataset.newnormal));
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
