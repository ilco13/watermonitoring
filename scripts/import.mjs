#!/usr/bin/env node
/*
 * Reprend un historique (export TagoIO ou Orange Live Objects, JSON ou CSV) dans le tableau de bord, via /ingest.
 *
 *   node scripts/import.mjs <fichier> <https://eau.xxx.workers.dev> <clé> [--after=ISO] [--before=ISO]
 *
 * --after / --before bornent la période importée (heure incluse / exclue, ex. --before=2026-10-01T01:30:00Z).
 * Indispensable pour combler un trou sans dupliquer les relevés déjà présents : TagoIO note l'heure de réception (quelques
 * secondes après l'heure du compteur que note Live Objects), donc deux sources pour la même période feraient des quasi-doublons.
 * Les relevés strictement identiques (même variable, même heure) sont ignorés par le serveur : on peut relancer sans risque.
 * Formats reconnus : voir scripts/import-lib.mjs.
 */
import { readFileSync } from 'node:fs';
import { parseExport } from './import-lib.mjs';

const args = process.argv.slice(2);
const opts = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v]; }));
const [file, base, key] = args.filter((a) => !a.startsWith('--'));
if (!file || !base || !key) {
  console.error('Usage : node scripts/import.mjs <fichier> <url-du-worker> <clé> [--after=ISO] [--before=ISO]');
  process.exit(1);
}
const bound = (v) => { if (v === undefined) return undefined; const t = Date.parse(v); if (!Number.isFinite(t)) { console.error(`Date invalide : ${v}`); process.exit(1); } return t; };
const range = { after: bound(opts.after), before: bound(opts.before) };

const { items, skipped, outOfRange, noTime } = parseExport(readFileSync(file, 'utf8'), file, range);
console.log(`${items.length} éléments à envoyer` + (outOfRange ? `, ${outOfRange} hors période ignorés` : '') + (noTime ? `, ${noTime} sans heure ignorés` : '') + (skipped ? `, ${skipped} vides ignorés` : ''));
if (!items.length) process.exit(0);

const url = base.replace(/\/$/, '') + '/ingest';
const CHUNK = 200;
let stored = 0, dup = 0, bad = 0, failed = 0;
for (let i = 0; i < items.length; i += CHUNK) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'Device-Token': key }, body: JSON.stringify(items.slice(i, i + CHUNK)) });
  const out = await res.json().catch(() => ({}));
  if (res.status === 422) { failed += Math.min(CHUNK, items.length - i); continue; }   // lot sans aucune mesure reconnue
  if (!res.ok) { console.error(`\nÉchec HTTP ${res.status} : ${out.message || ''}`); process.exit(1); }
  stored += out.stored || 0; dup += out.duplicates || 0; bad += out.ignored || 0;
  process.stdout.write(`\r${Math.min(i + CHUNK, items.length)} / ${items.length}`);
}
console.log(`\nTerminé : ${stored} relevés ajoutés, ${dup} déjà présents, ${bad} champs ignorés` + (failed ? `, ${failed} éléments non reconnus (aucune mesure)` : '') + '.');
