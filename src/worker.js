/*
 * Worker Cloudflare : sert le tableau de bord (public/) et relaie les lectures vers TagoIO.
 *
 * Pourquoi un relais ?
 *   - le token TagoIO reste un secret Cloudflare : il n'est jamais envoyé au navigateur ;
 *   - pas de souci de CORS ;
 *   - l'accès est protégé par un mot de passe (secret DASHBOARD_PASSWORD).
 *
 * Secrets (npx wrangler secret put ...) :
 *   DASHBOARD_PASSWORD  mot de passe demandé par le navigateur (identifiant libre)
 *   TAGO_TOKEN          Device-Token TagoIO, de préférence en lecture seule
 * Variable (wrangler.jsonc) : TAGO_API  (https://api.eu-w1.tago.io pour l'Europe)
 *
 * Sans DASHBOARD_PASSWORD le Worker refuse tout (503) : jamais de données publiques par oubli.
 */

const ALLOWED_PARAMS = ['variable', 'qty', 'skip', 'start_date', 'end_date', 'ordination'];

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function isAuthorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const [a, b] = await Promise.all([digest(password), digest(env.DASHBOARD_PASSWORD)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    if (!env.DASHBOARD_PASSWORD) {
      return new Response(
        'Tableau de bord non configuré : définissez le secret DASHBOARD_PASSWORD (voir README).',
        { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    if (!(await isAuthorized(request, env))) {
      return new Response('Authentification requise.', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Consommation eau", charset="UTF-8"' },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/status') {
      return json({ proxy: Boolean(env.TAGO_TOKEN) });
    }

    if (url.pathname === '/api/data') {
      if (request.method !== 'GET') return json({ status: false, message: 'Méthode non autorisée' }, 405);
      if (!env.TAGO_TOKEN) return json({ status: false, message: 'Secret TAGO_TOKEN absent' }, 503);
      const upstream = new URL('/data', env.TAGO_API || 'https://api.eu-w1.tago.io');
      for (const key of ALLOWED_PARAMS) {
        const value = url.searchParams.get(key);
        if (value !== null) upstream.searchParams.set(key, value);
      }
      const res = await fetch(upstream, {
        headers: { 'Device-Token': env.TAGO_TOKEN, Accept: 'application/json' },
      });
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
