#!/usr/bin/env node
/*
 * Reprend un historique (export TagoIO, JSON ou CSV) dans le tableau de bord, via /ingest.
 *
 *   node scripts/import.mjs <fichier.json|fichier.csv> <https://eau-maison.xxx.workers.dev> <INGEST_KEY>
 *
 * JSON : tableau d'objets {variable, value, time} ou réponse de l'API TagoIO {"result":[...]}.
 * CSV  : première ligne = en-têtes, dont au minimum variable, value, time (séparateur , ou ;).
 * Les doublons sont ignorés par le serveur : on peut relancer sans risque.
 */
import { readFileSync } from 'node:fs';

const [file, base, key] = process.argv.slice(2);
if (!file || !base || !key) {
  console.error('Usage : node scripts/import.mjs <fichier.json|.csv> <url-du-worker> <INGEST_KEY>');
  process.exit(1);
}

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const split = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sep && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map((h) => h.trim().toLowerCase());
  const iv = head.indexOf('variable'), ix = head.indexOf('value'), it = head.indexOf('time');
  if (iv < 0 || ix < 0 || it < 0) throw new Error('Colonnes variable, value et time introuvables : ' + head.join(', '));
  return lines.slice(1).map(split).map((r) => ({ variable: r[iv], value: r[ix], time: r[it] }));
}

const text = readFileSync(file, 'utf8');
let rows;
if (file.toLowerCase().endsWith('.csv')) rows = parseCsv(text);
else { const j = JSON.parse(text); rows = Array.isArray(j) ? j : j.result; }
rows = rows.filter((r) => r && r.variable && r.value !== '' && r.value != null);

const url = base.replace(/\/$/, '') + '/ingest';
const CHUNK = 500;
let stored = 0, dup = 0, bad = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Device-Token': key },
    body: JSON.stringify(rows.slice(i, i + CHUNK).map((r) => ({ variable: r.variable, value: r.value, time: r.time }))),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 422) { console.error(`Échec HTTP ${res.status} : ${out.message || ''}`); process.exit(1); }
  stored += out.stored || 0; dup += out.duplicates || 0; bad += out.ignored || 0;
  process.stdout.write(`\r${Math.min(i + CHUNK, rows.length)} / ${rows.length}`);
}
console.log(`\nTerminé : ${stored} ajoutés, ${dup} déjà présents, ${bad} ignorés.`);
