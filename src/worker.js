/*
 * Worker Cloudflare : reçoit les messages de Live Objects (HTTPS push), les stocke dans D1,
 * et sert le tableau de bord (public/) protégé par mot de passe.
 *
 * Routes
 *   POST /ingest        Live Objects -> ici. Clé INGEST_KEY dans l'en-tête `Device-Token` (ou `X-Api-Key`,
 *                       `Authorization: <clé>` / `Bearer <clé>`, ou paramètre ?key=, à éviter : visible dans les journaux). Pas de mot de passe de tableau de bord.
 *   GET  /api/data      lectures d'une variable (utilisé par le tableau de bord)
 *   GET  /api/variables variables connues + dernière valeur
 *   GET  /api/events    derniers messages bruts reçus (diagnostic)
 *   GET  /api/status    sonde
 *   tout le reste       fichiers statiques
 *
 * Secrets (npx wrangler secret put ...) : DASHBOARD_PASSWORD, INGEST_KEY
 * Sans l'un de ces secrets, la partie concernée répond 503 : jamais ouverte par oubli.
 */
import { parseIngest } from './ingest.js';

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

async function dashboardAuthorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(header.slice(6)); } catch { return false; }
  return safeEqual(decoded.slice(decoded.indexOf(':') + 1), env.DASHBOARD_PASSWORD);
}

async function ingestAuthorized(request, url, env) {
  const auth = request.headers.get('Authorization') || '';
  const candidates = [
    request.headers.get('Device-Token'),
    request.headers.get('X-Api-Key'),
    auth.startsWith('Bearer ') ? auth.slice(7) : auth || null, // « Bearer clé » ou simplement « clé » (comme TagoIO)
    url.searchParams.get('key'),
  ].filter(Boolean);
  for (const c of candidates) if (await safeEqual(c, env.INGEST_KEY)) return true;
  return false;
}

async function handleIngest(request, url, env) {
  if (!env.INGEST_KEY) return json({ ok: false, message: 'Secret INGEST_KEY non défini' }, 503);
  if (!(await ingestAuthorized(request, url, env))) return json({ ok: false, message: 'Clé refusée' }, 401);
  if (request.method !== 'POST') return json({ ok: false, message: 'POST attendu' }, 405);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, message: 'Message trop volumineux' }, 413);

  let body = null;
  try { body = JSON.parse(text); } catch { /* conservé en brut ci-dessous */ }
  const { points, ignored } = body === null ? { points: [], ignored: 0 } : parseIngest(body);

  const stmts = points.map((p) =>
    env.DB.prepare('INSERT OR IGNORE INTO readings (variable, ts, value) VALUES (?, ?, ?)').bind(p.variable, p.ts, p.value));
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

async function handleApi(request, url, env) {
  const p = url.pathname;
  if (p === '/api/status') return json({ ok: true });

  if (p === '/api/data') {
    const variable = url.searchParams.get('variable');
    if (!variable) return json({ status: false, message: 'Paramètre variable requis' }, 400);
    const qty = Math.min(10000, Math.max(1, Number(url.searchParams.get('qty')) || 1000));
    const skip = Math.max(0, Number(url.searchParams.get('skip')) || 0);
    const start = Date.parse(url.searchParams.get('start_date') || '') || 0;
    const order = url.searchParams.get('ordination') === 'ascending' ? 'ASC' : 'DESC';
    const { results } = await env.DB
      .prepare(`SELECT ts, value FROM readings WHERE variable = ? AND ts >= ? ORDER BY ts ${order} LIMIT ? OFFSET ?`)
      .bind(variable, start, qty, skip).all();
    return json({ status: true, result: results.map((r) => ({ variable, value: r.value, time: new Date(r.ts).toISOString() })) });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ingest') return handleIngest(request, url, env);

    if (!env.DASHBOARD_PASSWORD) {
      return new Response('Tableau de bord non configuré : définissez le secret DASHBOARD_PASSWORD (voir README).',
        { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (!(await dashboardAuthorized(request, env))) {
      return new Response('Authentification requise.', {
        status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Consommation eau", charset="UTF-8"' },
      });
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json({ status: false, message: 'Méthode non autorisée' }, 405);
      return handleApi(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
};
