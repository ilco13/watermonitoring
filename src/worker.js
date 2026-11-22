/*
 * Worker Cloudflare : reçoit les messages de Live Objects (HTTPS push), les stocke dans D1,
 * et sert le tableau de bord (public/), protégé par la connexion de l'ASL (connexion unique).
 *
 * Routes
 *   POST /ingest        Live Objects -> ici. Clé INGEST_KEY dans l'en-tête `Device-Token` (ou `X-Api-Key`,
 *                       `Authorization: <clé>` / `Bearer <clé>`, ou paramètre ?key=, à éviter : visible dans les journaux). Pas de mot de passe de tableau de bord.
 *   GET  /sso/callback  retour de l'ASL avec un jeton signé de 60 s -> ouvre une session de 12 h
 *   Tout le reste exige une session. Tous les colotis peuvent lire ; seul le bureau (rôle « admin » de l'ASL) écrit :
 *   GET  /api/status, /api/me, /api/data, /api/config          lecture, tous les connectés
 *   PUT  /api/config                                            réglages communs        (bureau)
 *   GET  /api/variables, /api/events                            diagnostic              (bureau)
 *   GET/POST/DELETE /api/readings                               liste, ajout, correction, suppression d'un relevé (bureau)
 *   GET  /api/export.csv                                        tous les relevés en CSV, pour une copie hors Cloudflare (bureau)
 *   GET/POST /api/backup                                        état / lancement immédiat de la sauvegarde R2 (bureau)
 *   GET/POST /api/ingest-key                                    état / régénération de la clé Live Objects (bureau)
 *   POST /api/logout                                            ferme la session ici et renvoie l'adresse qui ferme aussi celle de l'ASL
 *   tout le reste       fichiers de public/ (intégrés au Worker)
 *
 * Non connecté : les pages renvoient vers l'ASL (qui renvoie ici une fois connecté), les appels d'API reçoivent 401.
 * Secrets (npx wrangler secret put ...) : SSO_SECRET (partagé avec l'ASL), INGEST_KEY (clé d'origine ; le bureau peut en générer d'autres). Variable : ASL_URL.
 * Sans l'un de ces secrets, la partie concernée répond 503 : jamais ouverte par oubli.
 */
import { parseIngest } from './ingest.js';
import '../public/lib.js'; // calculs communs avec le navigateur : script UMD qui, dans un Worker, se range dans self.WM
import { alertStatus, bindLib, previewAlerts, runAlertCheck, sendTestMail, setMailEnabled } from './alerting.js';

import { SESSION_COOKIE, clearSessionCookie, getCookie, makeSession, safeNext, sessionCookie, sign, verify } from './auth.js';
import ASSETS from './assets.js'; // généré depuis public/ par scripts/build-assets.mjs

bindLib(globalThis.WM);

const MAX_BODY = 1_000_000;   // octets
const KEEP_EVENTS = 200;
const RAW_LIMIT = 6000;       // caractères conservés par message brut

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const digest = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (text) => hex(await digest(text));
const GRACE_MS = 24 * 3600e3;   // une clé remplacée reste valable 24 h, le temps de mettre à jour Live Objects

/**
 * Clés acceptées : la clé d'origine (secret INGEST_KEY, valable jusqu'à 24 h après la première régénération) et les clés
 * générées depuis le tableau de bord (empreinte en base, en vigueur ou remplacée depuis moins de 24 h).
 * @returns {{type:'legacy'}|{type:'db', id:number}|null}
 */
async function matchIngestKey(request, url, env) {
  const auth = request.headers.get('Authorization') || '';
  const candidates = [
    request.headers.get('Device-Token'),
    request.headers.get('X-Api-Key'),
    auth.startsWith('Bearer ') ? auth.slice(7) : auth || null, // « Bearer clé » ou simplement « clé » (comme TagoIO)
    url.searchParams.get('key'),
  ].filter(Boolean);
  if (!candidates.length) return null;
  const now = Date.now();
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'ingest_legacy_until'").first();
  const legacyOpen = Boolean(env.INGEST_KEY) && (!row || now < Number(row.value));
  for (const c of candidates) {
    if (legacyOpen && (await safeEqual(c, env.INGEST_KEY))) return { type: 'legacy' };
    const k = await env.DB.prepare('SELECT id FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > ?)').bind(await sha256hex(c), now).first();
    if (k) return { type: 'db', id: k.id };
  }
  return null;
}

async function handleIngest(request, url, env) {
  if (!env.INGEST_KEY && !(await env.DB.prepare('SELECT 1 AS x FROM api_keys LIMIT 1').first())) {
    return json({ ok: false, message: 'Aucune clé de réception définie' }, 503);
  }
  const matched = await matchIngestKey(request, url, env);
  if (!matched) return json({ ok: false, message: 'Clé refusée' }, 401);
  // dernière utilisation de la clé : permet de voir si Live Objects a bien basculé sur la nouvelle
  await (matched.type === 'db'
    ? env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(Date.now(), matched.id)
    : env.DB.prepare("INSERT INTO config (key, value, updated_at, updated_by) VALUES ('ingest_legacy_last_used', ?, ?, NULL) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(Date.now()), Date.now())
  ).run();
  if (request.method !== 'POST') return json({ ok: false, message: 'POST attendu' }, 405);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, message: 'Message trop volumineux' }, 413);

  let body = null;
  try { body = JSON.parse(text); } catch { /* conservé en brut ci-dessous */ }
  const { points, ignored } = body === null ? { points: [], ignored: 0 } : parseIngest(body);

  const stmts = points.map((p) =>
    env.DB.prepare('INSERT OR IGNORE INTO readings (variable, ts, value, source) VALUES (?, ?, ?, ?)').bind(p.variable, p.ts, p.value, p.source));
  let stored = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    stored += res.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (received_at, stored, ignored, raw) VALUES (?, ?, ?, ?)')
      .bind(Date.now(), stored, ignored, text.slice(0, RAW_LIMIT)),
    env.DB.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').bind(KEEP_EVENTS),
  ]);

  // 4xx = Live Objects abandonne ce message et le signale dans ses compteurs d'erreurs
  if (!points.length) {
    return json({ ok: false, message: body === null ? 'Corps non JSON' : 'Aucune mesure numérique reconnue', ignored }, 422);
  }
  return json({ ok: true, received: points.length, stored, duplicates: points.length - stored, ignored });
}

const VARIABLE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const MIN_TS = Date.UTC(2000, 0, 1);

/**
 * Le cookie de session est envoyé automatiquement par le navigateur : sans garde-fou, un site tiers pourrait
 * faire écrire à l'insu de l'utilisateur (CSRF). On exige donc un en-tête personnalisé (bloqué en cross-origin
 * sans CORS) et, s'il est présent, un Origin identique (en plus de SameSite=Lax sur le cookie).
 */
function writeAllowed(request, url) {
  if (request.headers.get('X-Requested-With') !== 'eau-dashboard') return false;
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return false;
  return true;
}

async function handleReadings(request, url, env) {
  if (request.method === 'GET') {
    const vars = (url.searchParams.get('variables') || '').split(',').filter(Boolean).slice(0, 6);
    if (!vars.length || !vars.every((v) => VARIABLE_RE.test(v))) return json({ status: false, message: 'Paramètre variables invalide' }, 400);
    const src = url.searchParams.get('source');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const marks = vars.map(() => '?').join(',');
    const sql = `SELECT variable, ts, value, source FROM readings WHERE variable IN (${marks})`
      + (src === 'manual' || src === 'auto' ? ' AND source = ?' : '') + ' ORDER BY ts DESC, variable LIMIT ? OFFSET ?';
    const binds = [...vars, ...(src === 'manual' || src === 'auto' ? [src] : []), limit, offset];
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ status: true, result: results.map((r) => ({ variable: r.variable, time: new Date(r.ts).toISOString(), value: r.value, source: r.source })) });
  }

  if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);

  if (request.method === 'POST') {
    let b;
    try { b = await request.json(); } catch { return json({ status: false, message: 'JSON invalide' }, 400); }
    const ts = Date.parse(b && b.time), value = Number(b && b.value);
    if (!b || !VARIABLE_RE.test(String(b.variable)) || !Number.isFinite(ts) || !Number.isFinite(value)) {
      return json({ status: false, message: 'variable, time et value requis' }, 400);
    }
    if (ts < MIN_TS || ts > Date.now() + 2 * 864e5) return json({ status: false, message: 'Date hors limites' }, 400);
    if (value < 0 || value > 1e12) return json({ status: false, message: 'Valeur hors limites' }, 400);
    const stmts = [];
    if (b.replaces) {
      const old = Date.parse(b.replaces);
      if (!Number.isFinite(old)) return json({ status: false, message: 'replaces invalide' }, 400);
      stmts.push(env.DB.prepare('DELETE FROM readings WHERE variable = ? AND ts = ?').bind(b.variable, old));
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO readings (variable, ts, value, source) VALUES (?, ?, ?, 'manual')
       ON CONFLICT (variable, ts) DO UPDATE SET value = excluded.value, source = 'manual'`).bind(b.variable, ts, value));
    await env.DB.batch(stmts);
    return json({ status: true });
  }

  if (request.method === 'DELETE') {
    const variable = url.searchParams.get('variable'), ts = Date.parse(url.searchParams.get('time') || '');
    if (!VARIABLE_RE.test(String(variable)) || !Number.isFinite(ts)) return json({ status: false, message: 'variable et time requis' }, 400);
    const res = await env.DB.prepare('DELETE FROM readings WHERE variable = ? AND ts = ?').bind(variable, ts).run();
    return json({ status: true, deleted: res.meta.changes || 0 });
  }
  return json({ status: false, message: 'Méthode non autorisée' }, 405);
}

const CONFIG_KEY = 'main';
const NUM = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback);

/** Reconstruit la configuration à partir de champs connus, bornés : rien d'autre n'est conservé. */
function sanitizeConfig(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.meters) || c.meters.length < 1 || c.meters.length > 4) return null;
  const meters = [];
  for (const m of c.meters) {
    if (!m || typeof m !== 'object' || !VARIABLE_RE.test(String(m.variable)) || !/^[a-z0-9_-]{1,30}$/.test(String(m.id))) return null;
    const a = m.alerts && typeof m.alerts === 'object' ? m.alerts : {};
    const alerts = {};
    for (const k of ['dailyLimitL', 'monthlyLimitL', 'maxFlowLph', 'leakHours', 'quietFromH', 'quietToH', 'quietMaxL', 'baseFlowRatio', 'baseFlowMinLph', 'spikeRatio', 'staleHours']) {
      alerts[k] = NUM(a[k], 0, 1e9, 0);
    }
    meters.push({ id: String(m.id), name: String(m.name ?? '').slice(0, 60) || String(m.id), variable: String(m.variable),
      litresPerUnit: NUM(m.litresPerUnit, 1e-6, 1e6, 1), slot: NUM(m.slot, 1, 8, 1), alerts });
  }
  return { historyYears: NUM(c.historyYears, 1, 10, 3), refreshMin: NUM(c.refreshMin, 1, 1440, 10), meters };
}

/** Nouvelle clé (192 bits) : renvoyée une seule fois, seule son empreinte est conservée. La précédente reste valable 24 h. */
async function regenerateIngestKey(env, session) {
  const now = Date.now(), by = String(session.email || session.name || session.sub).slice(0, 120);
  const key = hex(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.batch([
    // la clé d'origine (secret Cloudflare) cesse de fonctionner 24 h après la première régénération (jamais prolongée ensuite)
    env.DB.prepare("INSERT OR IGNORE INTO config (key, value, updated_at, updated_by) VALUES ('ingest_legacy_until', ?, ?, ?)").bind(String(now + GRACE_MS), now, by),
    env.DB.prepare('UPDATE api_keys SET expires_at = ? WHERE expires_at IS NULL').bind(now + GRACE_MS),
    env.DB.prepare('INSERT INTO api_keys (key_hash, created_at, created_by) VALUES (?, ?, ?)').bind(await sha256hex(key), now, by),
  ]);
  return key;
}

/** État des clés, sans aucun secret : dates, auteur, dernière utilisation. */
async function ingestKeyStatus(env) {
  const now = Date.now();
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const legacy = await env.DB.prepare("SELECT key, value FROM config WHERE key IN ('ingest_legacy_until', 'ingest_legacy_last_used')").all();
  const cfg = Object.fromEntries(legacy.results.map((r) => [r.key, Number(r.value)]));
  const { results } = await env.DB.prepare('SELECT id, created_at, created_by, expires_at, last_used_at FROM api_keys ORDER BY id DESC LIMIT 5').all();
  return {
    legacy: {
      present: Boolean(env.INGEST_KEY),
      validUntil: iso(cfg.ingest_legacy_until),
      active: Boolean(env.INGEST_KEY) && (!cfg.ingest_legacy_until || now < cfg.ingest_legacy_until),
      lastUsedAt: iso(cfg.ingest_legacy_last_used),
    },
    keys: results.map((k) => ({ id: k.id, createdAt: iso(k.created_at), createdBy: k.created_by, validUntil: iso(k.expires_at), active: !k.expires_at || k.expires_at > now, lastUsedAt: iso(k.last_used_at) })),
  };
}

/** Tous les relevés en CSV (variable, time, value, source) : export téléchargé et sauvegarde R2. */
async function buildCsv(env) {
  const { results } = await env.DB.prepare('SELECT variable, ts, value, source FROM readings ORDER BY variable, ts').all();
  const cell = (x) => (/[",\n\r]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  const lines = ['variable,time,value,source', ...results.map((r) => [r.variable, new Date(r.ts).toISOString(), r.value, r.source].map(cell).join(','))];
  return { csv: lines.join('\n') + '\n', rows: results.length };
}

/**
 * Sauvegarde dans R2 (liaison BACKUPS) : fichier CSV daté, écrit puis relu pour vérifier sa taille ; empreinte SHA-256 et nombre de
 * lignes en métadonnées. Le résultat (succès ou erreur) est mémorisé pour l'écran Réglages. Les sauvegardes ne sont jamais supprimées
 * (environ 130 Ko chacune : 7 Mo par an en hebdomadaire).
 * @param {'hebdo'|'manuel'} kind
 */
async function runBackup(env, kind, session) {
  const at = new Date();
  const rec = { at: at.toISOString(), kind, by: session ? String(session.email || session.name || session.sub).slice(0, 120) : 'automatique' };
  try {
    if (!env.BACKUPS) throw new Error('R2 non configuré : liaison BACKUPS absente (voir README)');
    const { csv, rows } = await buildCsv(env);
    const bytes = new TextEncoder().encode(csv);
    const key = kind === 'hebdo' ? `hebdo/releves-${rec.at.slice(0, 10)}.csv` : `manuel/releves-${rec.at.slice(0, 10)}T${rec.at.slice(11, 19).replace(/:/g, '-')}.csv`;
    await env.BACKUPS.put(key, bytes, { httpMetadata: { contentType: 'text/csv; charset=utf-8' }, customMetadata: { rows: String(rows), sha256: await sha256hex(csv) } });
    const head = await env.BACKUPS.head(key);
    if (!head || head.size !== bytes.length) throw new Error(`Vérification impossible : taille écrite ${head ? head.size : 'inconnue'} au lieu de ${bytes.length}`);
    Object.assign(rec, { ok: true, key, rows, bytes: head.size });
  } catch (e) {
    Object.assign(rec, { ok: false, error: String((e && e.message) || e).slice(0, 240) });
  }
  await env.DB.prepare(`INSERT INTO config (key, value, updated_at, updated_by) VALUES ('last_backup', ?, ?, NULL)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(JSON.stringify(rec), Date.now()).run();
  return rec;
}

/** État pour l'écran Réglages : liaison présente ?, dernière sauvegarde, cinq fichiers les plus récents. */
async function backupStatus(env) {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'last_backup'").first();
  const out = { configured: Boolean(env.BACKUPS), last: row ? JSON.parse(row.value) : null, files: [] };
  if (env.BACKUPS) {
    const all = [];
    for (const prefix of ['hebdo/', 'manuel/']) {
      const l = await env.BACKUPS.list({ prefix, limit: 1000, include: ['customMetadata'] });
      all.push(...l.objects);
    }
    all.sort((a, b) => b.uploaded - a.uploaded);
    out.total = all.length;
    out.files = all.slice(0, 5).map((o) => ({ key: o.key, bytes: o.size, uploaded: o.uploaded.toISOString(), rows: o.customMetadata && o.customMetadata.rows ? Number(o.customMetadata.rows) : null }));
  }
  return out;
}

const BACKUP_CRON = '17 3 * * 1';
const FORBIDDEN = () => json({ status: false, message: 'Réservé au bureau' }, 403);

/**
 * Déconnexion : supprime le cookie de session d'ici et renvoie l'adresse de l'ASL qui ferme aussi sa session. Sans cela, l'ASL
 * restant connecté, le site de l'eau rouvrirait aussitôt une session. L'adresse porte un jeton signé de 60 s : seul ce site
 * peut demander à l'ASL de fermer une session (un site tiers ne peut pas déconnecter quelqu'un par un simple lien).
 */
async function handleLogout(request, url, env, session) {
  if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);
  const token = await sign({ v: 1, aud: 'asl-logout', sub: String(session.sub ?? ''), nonce: hex(crypto.getRandomValues(new Uint8Array(16))), exp: Date.now() + 60_000 }, env.SSO_SECRET);
  const res = json({ status: true, result: { url: `${env.ASL_URL.replace(/\/$/, '')}/sso/deconnexion?token=${token}` } });
  res.headers.append('Set-Cookie', clearSessionCookie(url.protocol === 'https:'));
  return res;
}

async function handleApi(request, url, env, session) {
  const p = url.pathname;
  const admin = session.role === 'admin';
  if (p === '/api/logout' && request.method === 'POST') return handleLogout(request, url, env, session);
  if (p === '/api/readings') return admin ? handleReadings(request, url, env) : FORBIDDEN();

  if (p === '/api/config' && request.method === 'PUT') {
    if (!admin) return FORBIDDEN();
    if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);
    const text = await request.text();
    if (text.length > 20000) return json({ status: false, message: 'Configuration trop volumineuse' }, 413);
    let body; try { body = JSON.parse(text); } catch { return json({ status: false, message: 'JSON invalide' }, 400); }
    const cfg = sanitizeConfig(body && body.config);
    if (!cfg) return json({ status: false, message: 'Configuration invalide' }, 400);
    await env.DB.prepare(`INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(CONFIG_KEY, JSON.stringify(cfg), Date.now(), String(session.email || session.name || session.sub).slice(0, 120)).run();
    return json({ status: true });
  }

  if (p === '/api/backup') {
    if (!admin) return FORBIDDEN();
    if (request.method === 'POST') {
      if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);
      return json({ status: true, result: await runBackup(env, 'manuel', session) });
    }
    if (request.method === 'GET') return json({ status: true, result: await backupStatus(env) });
  }
  if (p === '/api/alerts-mail' || p.startsWith('/api/alerts-mail/')) {
    if (!admin) return FORBIDDEN();
    const by = String(session.email || session.name || session.sub).slice(0, 120);
    if (request.method === 'GET' && p === '/api/alerts-mail') return json({ status: true, result: await alertStatus(env) });
    if (request.method === 'GET' && p === '/api/alerts-mail/preview') return json({ status: true, result: await previewAlerts(env) });
    if (request.method === 'PUT' && p === '/api/alerts-mail') {
      if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);
      let body; try { body = await request.json(); } catch { return json({ status: false, message: 'JSON invalide' }, 400); }
      await setMailEnabled(env, !!(body && body.enabled), by);
      return json({ status: true, result: await alertStatus(env) });
    }
    if (request.method === 'POST' && (p === '/api/alerts-mail/test' || p === '/api/alerts-mail/check')) {
      if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);
      if (p.endsWith('/test')) {
        try { return json({ status: true, result: { ok: true, recipients: await sendTestMail(env, by) } }); }
        catch (e) { return json({ status: true, result: { ok: false, error: String((e && e.message) || e).slice(0, 240) } }); }
      }
      return json({ status: true, result: await runAlertCheck(env) });
    }
  }
  if (p === '/api/ingest-key') {
    if (!admin) return FORBIDDEN();
    if (request.method === 'POST') {
      if (!writeAllowed(request, url)) return json({ status: false, message: 'Requête refusée' }, 403);
      return json({ status: true, result: { key: await regenerateIngestKey(env, session) } });
    }
    if (request.method === 'GET') return json({ status: true, result: await ingestKeyStatus(env) });
  }

  if (request.method !== 'GET') return json({ status: false, message: 'Méthode non autorisée' }, 405);
  if (p === '/api/status') return json({ ok: true });
  if (p === '/api/me') return json({ status: true, result: { name: session.name || session.email || '', role: session.role } });
  if (p === '/api/config') {
    const row = await env.DB.prepare('SELECT value, updated_at, updated_by FROM config WHERE key = ?').bind(CONFIG_KEY).first();
    return json({ status: true, result: row ? { config: JSON.parse(row.value), updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by } : { config: null } });
  }

  if (p === '/api/data') {
    const variable = url.searchParams.get('variable');
    if (!variable) return json({ status: false, message: 'Paramètre variable requis' }, 400);
    const qty = Math.min(10000, Math.max(1, Number(url.searchParams.get('qty')) || 1000));
    const skip = Math.max(0, Number(url.searchParams.get('skip')) || 0);
    const start = Date.parse(url.searchParams.get('start_date') || '') || 0;
    const order = url.searchParams.get('ordination') === 'ascending' ? 'ASC' : 'DESC';
    const { results } = await env.DB
      .prepare(`SELECT ts, value, source FROM readings WHERE variable = ? AND ts >= ? ORDER BY ts ${order} LIMIT ? OFFSET ?`)
      .bind(variable, start, qty, skip).all();
    return json({ status: true, result: results.map((r) => ({ variable, value: r.value, time: new Date(r.ts).toISOString(), source: r.source })) });
  }

  if (p === '/api/variables' || p === '/api/events' || p === '/api/export.csv' || p === '/api/backup') {
    if (!admin) return FORBIDDEN();
  }

  if (p === '/api/export.csv') {
    // Sauvegarde complète : variable, heure UTC (ISO), valeur brute (litres), origine. Se réimporte avec scripts/import.mjs.
    const { csv } = await buildCsv(env);
    return new Response(csv, { headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="releves-eau-${new Date().toISOString().slice(0, 10)}.csv"`,
    } });
  }


  if (p === '/api/variables') {
    const { results } = await env.DB.prepare(
      `SELECT r.variable, r.value, r.ts, c.n FROM readings r
       JOIN (SELECT variable, MAX(ts) AS m, COUNT(*) AS n FROM readings GROUP BY variable) c
         ON r.variable = c.variable AND r.ts = c.m ORDER BY r.variable`).all();
    return json({ status: true, result: results.map((r) => ({ variable: r.variable, value: r.value, time: new Date(r.ts).toISOString(), count: r.n })) });
  }

  if (p === '/api/events') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    const { results } = await env.DB.prepare('SELECT received_at, stored, ignored, raw FROM events ORDER BY id DESC LIMIT ?').bind(limit).all();
    return json({ status: true, result: results.map((e) => ({ time: new Date(e.received_at).toISOString(), stored: e.stored, ignored: e.ignored, raw: e.raw })) });
  }

  return json({ status: false, message: 'Route inconnue' }, 404);
}

function serveAsset(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Méthode non autorisée', { status: 405 });
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const a = Object.prototype.hasOwnProperty.call(ASSETS, path) ? ASSETS[path] : null;
  if (!a) return new Response('Introuvable', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const headers = { 'content-type': a.type, 'cache-control': 'private, no-cache', ...securityHeaders(env) };
  let body = a.body;
  if (path === '/index.html') {
    // nom et adresse de l'ASL (logo, lien de retour) : propres à l'installation, donc pas mis en cache
    body = body.replaceAll('{{ASL_URL}}', escHtml((env.ASL_URL || '').replace(/\/$/, ''))).replaceAll('{{ASL_NAME}}', escHtml(env.ASL_NAME || 'ASL'));
    headers['cache-control'] = 'no-store';
  } else {
    headers.etag = a.etag;
    if (request.headers.get('If-None-Match') === a.etag) return new Response(null, { status: 304, headers });
  }
  if (a.b64) { body = Uint8Array.from(atob(body), (c) => c.charCodeAt(0)); headers['cache-control'] = 'public, max-age=86400'; }
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

/** En-têtes de sécurité du site (pages et fichiers) : le site gère des sessions, il ne doit être ni intégré ailleurs ni charger de code étranger. */
const securityHeaders = (env) => ({
  // le logo de l'ASL est chargé depuis le site de l'ASL : son adresse est la seule origine étrangère autorisée (images)
  'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${aslOrigin(env)}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
});
const aslOrigin = (env) => { try { return new URL(env.ASL_URL).origin; } catch { return ''; } };
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = (body, status = 200, env = {}) => new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Consommation d'eau</title><link rel="stylesheet" href="/style.css"><body><main>${body}</main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders(env) } });

/** Retour de l'ASL : échange le jeton signé (60 s, usage unique) contre une session de 12 h. */
async function handleSsoCallback(request, url, env) {
  const retry = `<p><a href="/">Se reconnecter</a></p>`;
  const p = await verify(url.searchParams.get('token'), env.SSO_SECRET, 'eau');
  if (!p || typeof p.nonce !== 'string' || p.nonce.length < 16 || p.nonce.length > 100) {
    return html(`<h1>Connexion impossible</h1><p>Le lien de connexion est invalide ou expiré.</p>${retry}`, 400, env);
  }
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO sso_nonces (nonce, exp) VALUES (?, ?)').bind(p.nonce, p.exp).run();
  if (!ins.meta.changes) return html(`<h1>Connexion impossible</h1><p>Ce lien de connexion a déjà été utilisé.</p>${retry}`, 400, env);
  await env.DB.prepare('DELETE FROM sso_nonces WHERE exp < ?').bind(Date.now()).run();
  const clip = (v) => (typeof v === 'string' ? v.slice(0, 120) : '');
  const token = await makeSession({ sub: String(p.sub ?? '').slice(0, 40), email: clip(p.email), name: clip(p.name), role: p.role }, env.SSO_SECRET);
  return new Response(null, { status: 302, headers: {
    Location: safeNext(url.searchParams.get('next')), 'Set-Cookie': sessionCookie(token, url.protocol === 'https:'), 'Cache-Control': 'no-store',
  } });
}

export default {
  // Déclencheurs (wrangler.jsonc) : sauvegarde hebdomadaire des relevés dans R2 (lundi 3 h 17 UTC), contrôle des alertes toutes les heures
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === BACKUP_CRON ? runBackup(env, 'hebdo', null) : runAlertCheck(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ingest') return handleIngest(request, url, env);

    if (!env.SSO_SECRET || !env.ASL_URL) {
      return new Response('Connexion non configurée : définissez le secret SSO_SECRET et la variable ASL_URL (voir README).',
        { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname === '/sso/callback') return handleSsoCallback(request, url, env);

    // l'icône est publique : elle doit s'afficher dans l'onglet même avant la connexion
    if (url.pathname === '/icone.png') return serveAsset(request, url, env);

    const cookie = getCookie(request, SESSION_COOKIE);
    const session = cookie ? await verify(cookie, env.SSO_SECRET, 'eau-session') : null;
    if (!session) {
      const navigation = request.method === 'GET' && !url.pathname.startsWith('/api/') && (request.headers.get('Accept') || '').includes('text/html');
      if (navigation) {
        const back = encodeURIComponent(safeNext(url.pathname + url.search));
        return new Response(null, { status: 302, headers: { Location: `${env.ASL_URL.replace(/\/$/, '')}/sso/eau?next=${back}`, 'Cache-Control': 'no-store' } });
      }
      return json({ status: false, message: 'Non connecté' }, 401);
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, url, env, session);
    return serveAsset(request, url, env);
  },
};
