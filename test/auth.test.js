import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, getCookie, safeNext, roleOf, makeSession } from '../src/auth.js';

const S = 'secret-de-test-assez-long-0123456789';
const NOW = 1_800_000_000_000;

test('jeton valide : signature, audience, expiration', async () => {
  const t = await sign({ aud: 'eau', sub: 7, exp: NOW + 60_000 }, S);
  assert.equal((await verify(t, S, 'eau', NOW)).sub, 7);
  assert.equal(await verify(t, S, 'eau', NOW + 61_000), null, 'expiré');
  assert.equal(await verify(t, S, 'eau-session', NOW), null, "mauvaise audience : un jeton de l'ASL n'est pas une session");
  assert.equal(await verify(t, 'autre-secret', 'eau', NOW), null, 'mauvais secret');
});

test('jeton falsifié ou mal formé : toujours refusé, jamais une exception', async () => {
  const t = await sign({ aud: 'eau', role: 'member', exp: NOW + 60_000 }, S);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ aud: 'eau', role: 'admin', exp: NOW + 60_000 })).toString('base64url');
  for (const bad of [forged + '.' + sig, body + '.' + sig.slice(0, -2) + 'AA', body, '', 'a.b.c', '.', 'zzz.zzz', null, undefined, 42, body + '.']) {
    assert.equal(await verify(bad, S, 'eau', NOW), null, String(bad).slice(0, 20));
  }
  assert.equal(await verify(t, '', 'eau', NOW), null, 'secret absent : tout est refusé');
});

test('cookie : lecture par nom, valeurs voisines ignorées', () => {
  const r = new Request('https://x/', { headers: { Cookie: 'a=1; eau_session=abc.def; autre_eau_session=zzz' } });
  assert.equal(getCookie(r, 'eau_session'), 'abc.def');
  assert.equal(getCookie(r, 'absent'), null);
});

test('safeNext : jamais de redirection vers un autre site', () => {
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/?periode=semaine'), '/?periode=semaine');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil.com', '', null, undefined, '/a\nb', '/a\\b', '/' + 'x'.repeat(400)]) {
    assert.equal(safeNext(bad), '/', String(bad).slice(0, 25));
  }
});

test('rôles : seul « admin » (bureau) est administrateur', async () => {
  assert.equal(roleOf('admin'), 'admin');
  for (const r of ['member', 'colotis', '', undefined, 'ADMIN']) assert.equal(roleOf(r), 'member');
  const s = await verify(await makeSession({ sub: 1, email: 'a@b.fr', name: 'A', role: 'admin' }, S, NOW), S, 'eau-session', NOW + 1000);
  assert.equal(s.role, 'admin');
  assert.equal(await verify(await makeSession({ sub: 1, role: 'admin' }, S, NOW), S, 'eau-session', NOW + 13 * 3600_000), null, 'session expirée après 12 h');
});
