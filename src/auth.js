/*
 * auth.js - jetons signés (HMAC-SHA-256) pour la connexion unique avec l'ASL.
 *
 * Deux sortes de jetons, signés avec le même secret SSO_SECRET mais d'audience différente :
 *   - 'eau'          : émis par l'ASL (60 s) après connexion, échangé contre une session ;
 *   - 'eau-session'  : cookie de session de ce site (12 h).
 * L'audience empêche d'utiliser l'un à la place de l'autre.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SESSION_COOKIE = 'eau_session';
export const SESSION_SECONDS = 12 * 3600;
export const SSO_TTL_SECONDS = 60;

const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

const key = (secret, usage) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function sign(payload, secret) {
  const body = b64.enc(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode(body));
  return `${body}.${b64.enc(sig)}`;
}

/** @returns le contenu si la signature, l'audience et la durée de vie sont bons, sinon null. Ne lève jamais d'exception. */
export async function verify(token, secret, aud, now = Date.now()) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) return null;
    const ok = await crypto.subtle.verify('HMAC', await key(secret, 'verify'), b64.dec(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(b64.dec(parts[0])));
    if (!p || p.aud !== aud || typeof p.exp !== 'number' || p.exp <= now) return null;
    return p;
  } catch { return null; }
}

export function getCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Chemin relatif sûr pour une redirection : jamais un autre site. */
export function safeNext(path) {
  const s = String(path ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.length > 300 || /[\u0000-\u001f\u007f\\]/.test(s)) return '/';
  return s;
}

export const roleOf = (aslRole) => (aslRole === 'admin' ? 'admin' : 'member');

export async function makeSession(user, secret, now = Date.now()) {
  return sign({ v: 1, aud: 'eau-session', sub: user.sub, email: user.email, name: user.name, role: roleOf(user.role), exp: now + SESSION_SECONDS * 1000 }, secret);
}

export function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}
