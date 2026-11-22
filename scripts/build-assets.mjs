#!/usr/bin/env node
/*
 * Intègre les fichiers de public/ dans src/assets.js (fichier généré, non versionné) :
 * le Worker les sert lui-même, ce qui évite la fonction « assets » de Cloudflare.
 * Lancé automatiquement par `wrangler dev` et `wrangler deploy` (voir "build" dans wrangler.jsonc).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = join(root, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

const assets = {};
for (const file of walk(pub)) {
  const ext = extname(file).toLowerCase();
  if (!TYPES[ext]) throw new Error(`Type de fichier non géré dans public/ : ${file} (texte uniquement)`);
  const body = readFileSync(file, 'utf8');
  assets['/' + relative(pub, file).split('\\').join('/')] = {
    type: TYPES[ext],
    etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"',
    body,
  };
}
writeFileSync(join(root, 'src/assets.js'), '// Généré par scripts/build-assets.mjs : ne pas modifier.\nexport default ' + JSON.stringify(assets) + ';\n');
console.log(`assets : ${Object.keys(assets).length} fichiers intégrés (${Object.values(assets).reduce((n, a) => n + a.body.length, 0)} octets)`);
