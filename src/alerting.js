/*
 * Alertes par mail : le Worker recalcule lui-même les alertes (avec le même code que le navigateur, public/lib.js)
 * après chaque relevé et toutes les heures, et prévient le bureau des alertes critiques et importantes.
 *
 *  - un mail à l'apparition d'une alerte, un rappel toutes les 24 h tant qu'elle dure (3 rappels au plus), un mail quand elle disparaît ;
 *  - une seule alerte par compteur et par règle (par exemple « arrosage · consommation en journée ») ;
 *  - une alerte est déclarée rétablie après 2 contrôles de suite sans elle (évite les allers-retours à la limite du seuil) ;
 *  - le mail ne part pas d'ici : il est déposé dans la file d'attente de l'ASL (route /api/eau-alerte, jeton signé), et le script Gmail
 *    de l'ASL l'envoie, comme tous les autres mails. Les destinataires (le bureau) sont choisis par l'ASL.
 * Les calculs de lib.js se font à l'heure locale du navigateur ; un Worker est toujours en UTC. On lui donne donc des heures
 * « décalées » à l'heure de Paris (heure d'été comprise) : ses calculs de jour, de plage horaire et d'affichage tombent juste.
 */
import { sign } from './auth.js';

// lib.js est un script « navigateur » (UMD) : le Worker le charge dans worker.js puis le donne ici (les tests le chargent à leur façon).
let WM = null;
export const bindLib = (lib) => { WM = lib; };

const H = 3600e3;
export const MAIL_LEVELS = new Set(['critical', 'serious']);
export const LEVEL_LABEL = { critical: 'Critique', serious: 'Importante', warning: 'Attention' };
export const REMIND_MS = 24 * H;
export const MAX_REMINDERS = 3;
export const CLEAR_RUNS = 2;
const HISTORY_MS = 40 * 24 * H;

/* ---------- Heure de Paris ---------- */

/** Dernier dimanche du mois (m = 0..11) à 01:00 UTC : instant de passage à l'heure d'été (mars) ou d'hiver (octobre). */
function lastSunday1utc(y, m) {
  const d = new Date(Date.UTC(y, m + 1, 0, 1));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}
/** Décalage de Paris par rapport à UTC à l'instant t (ms) : 2 h en été, 1 h en hiver. */
export function parisOffset(t) {
  const y = new Date(t).getUTCFullYear();
  return t >= lastSunday1utc(y, 2) && t < lastSunday1utc(y, 9) ? 2 * H : H;
}
export const toParis = (t) => t + parisOffset(t);

/* ---------- Alertes en cours ---------- */

export const alertKey = (variable, code) => `${variable}|${code}`;

/** Alertes critiques et importantes d'après les relevés de la base. Retourne [{ key, level, code, meter, text }]. */
export function evaluate(cfg, readingsByVariable, now) {
  const out = [];
  const shiftedNow = toParis(now);
  for (const m of cfg.meters) {
    const rows = (readingsByVariable[m.variable] || []).map((r) => ({ time: toParis(r.ts), value: r.value }));
    const readings = WM.toReadings(rows, m.litresPerUnit);
    const intervals = WM.toIntervals(readings);
    for (const a of WM.evaluateAlerts(m.alerts, readings, intervals, shiftedNow)) {
      if (MAIL_LEVELS.has(a.level)) out.push({ key: alertKey(m.variable, a.code), level: a.level, code: a.code, meter: m.name, text: a.text });
    }
  }
  return out;
}

/* ---------- Décision : quoi envoyer ---------- */

/**
 * @param active  alertes en cours (evaluate)
 * @param states  Map clé -> { level, meter, text, first_at, last_sent_at, sent_count, clear_runs } : alertes déjà signalées par mail
 * @returns { events, ops } : événements à mettre dans le mail, et changements d'état à enregistrer une fois le mail déposé
 */
export function plan(active, states, now) {
  const events = [], ops = [];
  const activeKeys = new Set(active.map((a) => a.key));
  for (const a of active) {
    const st = states.get(a.key);
    if (!st) {
      events.push({ type: 'new', ...a });
      ops.push({ op: 'put', key: a.key, level: a.level, meter: a.meter, text: a.text, first_at: now, last_sent_at: now, sent_count: 1, clear_runs: 0 });
    } else if (now - st.last_sent_at >= REMIND_MS && st.sent_count <= MAX_REMINDERS) {
      events.push({ type: 'remind', ...a, since: st.first_at, n: st.sent_count });
      ops.push({ op: 'put', key: a.key, level: a.level, meter: a.meter, text: a.text, first_at: st.first_at, last_sent_at: now, sent_count: st.sent_count + 1, clear_runs: 0 });
    } else if (st.clear_runs > 0 || st.text !== a.text) {
      ops.push({ op: 'put', key: a.key, level: a.level, meter: a.meter, text: a.text, first_at: st.first_at, last_sent_at: st.last_sent_at, sent_count: st.sent_count, clear_runs: 0 });
    }
  }
  for (const [key, st] of states) {
    if (activeKeys.has(key)) continue;
    if (st.clear_runs + 1 >= CLEAR_RUNS) {
      events.push({ type: 'resolved', key, level: st.level, meter: st.meter, text: st.text, since: st.first_at });
      ops.push({ op: 'del', key });
    } else {
      ops.push({ op: 'put', ...st, key, clear_runs: st.clear_runs + 1 });
    }
  }
  return { events, ops };
}

/* ---------- Texte du mail ---------- */

const fmtStamp = (now) => new Date(toParis(now)).toLocaleString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' à');

export function buildMail(events, now, siteUrl) {
  const live = events.filter((e) => e.type !== 'resolved');
  const names = [...new Set(events.map((e) => e.meter))].join(', ');
  let subject;
  if (live.length) {
    const top = live.some((e) => e.level === 'critical') ? 'critique' : 'importante';
    subject = live.length === 1 ? `[Eau] Alerte ${top} — ${names}` : `[Eau] ${live.length} alertes (${top}) — ${names}`;
    if (events.length > live.length) subject += ' (et rétablissement)';
  } else {
    subject = `[Eau] Alerte rétablie — ${names}`;
  }
  const lines = [`Suivi de l'eau — contrôle du ${fmtStamp(now)}`, ''];
  const block = (title, e, extra) => { lines.push(`${title} — ${LEVEL_LABEL[e.level] || e.level} — ${e.meter}`); lines.push(`  ${e.text}`); if (extra) lines.push(`  ${extra}`); lines.push(''); };
  for (const e of events.filter((x) => x.type === 'new')) block('NOUVELLE ALERTE', e);
  for (const e of events.filter((x) => x.type === 'remind')) block(`RAPPEL (alerte active depuis ${WM.fmtDuration(now - e.since)})`, e, e.n >= MAX_REMINDERS ? 'Dernier rappel : plus aucun mail tant que l\'alerte dure.' : null);
  for (const e of events.filter((x) => x.type === 'resolved')) block('RÉTABLIE', e, `Elle était active depuis ${WM.fmtDuration(now - e.since)}. Texte de la dernière alerte ci-dessus.`);
  lines.push(`Détail et graphiques : ${siteUrl}/#synthese`);
  lines.push('');
  lines.push("— Message automatique du suivi de l'eau, envoyé au bureau. Seuils et envoi des mails : « Réglages » du site (réservé au bureau).");
  return { subject, body: lines.join('\n') };
}

/* ---------- Dépôt du mail dans la file de l'ASL ---------- */

const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Dépose un mail pour le bureau dans la file d'attente de l'ASL. Retourne le nombre de destinataires, ou lève une erreur. */
export async function sendToAsl(env, subject, body) {
  if (!env.SSO_SECRET || !env.ASL_URL) throw new Error('liaison avec l\'ASL non configurée (SSO_SECRET, ASL_URL)');
  const token = await sign({ v: 1, aud: 'eau-mail', nonce: randomHex(16), exp: Date.now() + 120e3, subject, body }, env.SSO_SECRET);
  const url = `${env.ASL_URL.replace(/\/$/, '')}/api/eau-alerte`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) };
  // liaison de service si elle existe (de Worker à Worker), sinon appel HTTPS ordinaire
  const res = env.ASL ? await env.ASL.fetch(new Request(url, init)) : await fetch(url, init);
  let j = null; try { j = await res.json(); } catch { /* corps non JSON */ }
  if (!res.ok || !j || !j.ok) throw new Error(`l'ASL a refusé le mail (HTTP ${res.status}${j && j.error ? ' : ' + j.error : ''})`);
  if (!(j.recipients > 0)) throw new Error('aucun destinataire : aucun compte « bureau » actif dans l\'ASL');
  return j.recipients;
}

/* ---------- Orchestration ---------- */

const CFG_KEY = 'main', MAIL_KEY = 'alerts_mail', LAST_KEY = 'alerts_last';
const upsert = (env, key, value) => env.DB.prepare(`INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, JSON.stringify(value), Date.now());

export async function mailSettings(env) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(MAIL_KEY).first();
  let v = null; try { v = row ? JSON.parse(row.value) : null; } catch { /* réglage illisible : valeur par défaut */ }
  return { enabled: v ? v.enabled !== false : true };   // actif par défaut
}
export async function setMailEnabled(env, enabled, by) {
  await env.DB.prepare(`INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(MAIL_KEY, JSON.stringify({ enabled: !!enabled }), Date.now(), by).run();
}

async function loadAlertInputs(env, now) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(CFG_KEY).first();
  let saved = null; try { saved = row ? JSON.parse(row.value) : null; } catch { /* configuration illisible : réglages par défaut */ }
  const cfg = WM.mergeCfg(saved);
  const byVar = {};
  for (const m of cfg.meters) {
    const { results } = await env.DB.prepare('SELECT ts, value FROM readings WHERE variable = ? AND ts >= ? ORDER BY ts').bind(m.variable, now - HISTORY_MS).all();
    byVar[m.variable] = results;
  }
  return { cfg, byVar };
}

async function loadStates(env) {
  const { results } = await env.DB.prepare('SELECT key, level, meter, text, first_at, last_sent_at, sent_count, clear_runs FROM alert_state').all();
  return new Map(results.map((r) => [r.key, r]));
}

/** Alertes en cours (toutes, pour l'écran Réglages) et mails qui partiraient maintenant, sans rien envoyer. */
export async function previewAlerts(env, now = Date.now()) {
  const { cfg, byVar } = await loadAlertInputs(env, now);
  const active = evaluate(cfg, byVar, now);
  const { events } = plan(active, await loadStates(env), now);
  return { active, events };
}

/**
 * Contrôle complet : calcule, décide, dépose le mail dans l'ASL, puis (seulement si le dépôt a réussi) mémorise l'état.
 * Un échec laisse l'état inchangé : le prochain contrôle (dans l'heure) réessaie.
 */
export async function runAlertCheck(env, now = Date.now(), { dry = false } = {}) {
  const rec = { at: now, ok: true, active: 0, sent: false };
  try {
    const { enabled } = await mailSettings(env);
    const { cfg, byVar } = await loadAlertInputs(env, now);
    const active = evaluate(cfg, byVar, now);
    rec.active = active.length;
    rec.enabled = enabled;
    if (enabled) {
      const { events, ops } = plan(active, await loadStates(env), now);
      rec.events = events.length;
      if (events.length) {
        const mail = buildMail(events, now, (env.SITE_URL || '').replace(/\/$/, ''));
        rec.subject = mail.subject;
        if (dry) { rec.dry = true; rec.body = mail.body; return rec; }
        rec.recipients = await sendToAsl(env, mail.subject, mail.body);
        rec.sent = true;
        rec.sentAt = now;
      }
      if (!dry && ops.length) {
        await env.DB.batch(ops.map((o) => (o.op === 'del'
          ? env.DB.prepare('DELETE FROM alert_state WHERE key = ?').bind(o.key)
          : env.DB.prepare(`INSERT INTO alert_state (key, level, meter, text, first_at, last_sent_at, sent_count, clear_runs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET level = excluded.level, meter = excluded.meter, text = excluded.text, last_sent_at = excluded.last_sent_at, sent_count = excluded.sent_count, clear_runs = excluded.clear_runs`)
            .bind(o.key, o.level, o.meter, o.text, o.first_at, o.last_sent_at, o.sent_count, o.clear_runs))));
      }
    }
  } catch (e) { rec.ok = false; rec.error = String((e && e.message) || e).slice(0, 240); }
  if (!dry) {
    // on garde la dernière tentative, et à part le dernier mail réellement déposé
    let prev = null; try { const r = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(LAST_KEY).first(); prev = r ? JSON.parse(r.value) : null; } catch { /* ignoré */ }
    const lastMail = rec.sent ? { at: rec.sentAt, subject: rec.subject, recipients: rec.recipients } : (prev && prev.lastMail) || null;
    await upsert(env, LAST_KEY, { ...rec, lastMail }).run().catch(() => {});
  }
  return rec;
}

export async function alertStatus(env) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(LAST_KEY).first();
  let last = null; try { last = row ? JSON.parse(row.value) : null; } catch { /* ignoré */ }
  const { enabled } = await mailSettings(env);
  const { results } = await env.DB.prepare('SELECT key, level, meter, text, first_at, last_sent_at, sent_count FROM alert_state ORDER BY first_at').all();
  return { enabled, last, tracked: results };
}

/** Mail de test (bouton des Réglages) : vérifie toute la chaîne jusqu'à la file de l'ASL. */
export async function sendTestMail(env, by, now = Date.now()) {
  const body = [`Ceci est un mail de test du suivi de l'eau, demandé par ${by} le ${fmtStamp(now)}.`, '',
    'S\'il vous parvient, les alertes critiques et importantes arriveront de la même façon.', '',
    `Site : ${(env.SITE_URL || '').replace(/\/$/, '')}/#synthese`].join('\n');
  return sendToAsl(env, '[Eau] Mail de test', body);
}
