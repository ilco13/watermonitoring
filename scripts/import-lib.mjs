/*
 * import-lib.mjs - lit un export (TagoIO ou Orange Live Objects) et en tire des éléments à envoyer à /ingest.
 *
 * Formats reconnus :
 *   - TagoIO : [{variable, value, time}] ou {"result": [...]}, CSV avec colonnes variable, value, time
 *   - Live Objects : messages {streamId, timestamp, value:{genericSensor:{...}}} en tableau JSON, objet {hits|result|data|items|messages: [...]},
 *     éléments « _source », lignes JSON (NDJSON), ou CSV avec colonnes timestamp (ou created / time) et value (le message en JSON)
 * Les éléments sont transmis tels quels : c'est le serveur (src/ingest.js) qui décode genericSensor.
 */

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
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
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

const TIME_FIELDS = ['time', 'timestamp', 'created', 'date'];

/** Heure d'un élément en ms, ou null. */
export function timeOf(item) {
  for (const k of TIME_FIELDS) {
    const v = item && item[k];
    if (v === undefined || v === null || v === '') continue;
    const t = typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function fromJson(text) {
  let j;
  try { j = JSON.parse(text); } catch {
    // lignes JSON (NDJSON)
    const items = [];
    for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; try { items.push(JSON.parse(line)); } catch { throw new Error('Fichier JSON illisible'); } }
    return items;
  }
  if (Array.isArray(j)) return j;
  for (const k of ['result', 'hits', 'data', 'items', 'messages']) if (Array.isArray(j && j[k])) return j[k];
  if (j && j.hits && Array.isArray(j.hits.hits)) return j.hits.hits; // enveloppe de type Elasticsearch
  return [j];
}

/**
 * @param {string} text contenu du fichier
 * @param {string} filename pour reconnaître le CSV
 * @param {{after?: number, before?: number}} range bornes (ms) : on garde after <= heure < before
 * @returns {{items: object[], skipped: number, outOfRange: number, noTime: number}}
 */
export function parseExport(text, filename = '', range = {}) {
  const isCsv = /\.csv$/i.test(filename) || !/^[\s﻿]*[[{]/.test(text);
  let raw = isCsv ? parseCsv(text) : fromJson(text);
  raw = raw.map((r) => (r && typeof r === 'object' && r._source && typeof r._source === 'object' ? r._source : r));
  const items = []; let skipped = 0, outOfRange = 0, noTime = 0;
  const bounded = range.after !== undefined || range.before !== undefined;
  for (const r of raw) {
    if (!r || typeof r !== 'object') { skipped++; continue; }
    let item = r;
    if (isCsv) {
      if ('variable' in r && 'value' in r) item = { variable: r.variable, value: r.value, time: r.time };            // TagoIO
      else if ('value' in r) item = { value: r.value, timestamp: r.timestamp || r.created || r.time, streamId: r.streamid };  // Live Objects
      else { skipped++; continue; }
    }
    if ('variable' in item && (item.value === '' || item.value === null || item.value === undefined)) { skipped++; continue; }
    if (bounded) {
      const t = timeOf(item);
      if (t === null) { noTime++; continue; }
      if ((range.after !== undefined && t < range.after) || (range.before !== undefined && t >= range.before)) { outOfRange++; continue; }
    }
    items.push(item);
  }
  return { items, skipped, outOfRange, noTime };
}
