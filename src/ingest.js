/*
 * ingest.js - extrait des mesures {variable, ts, value} d'un message reçu de Live Objects.
 *
 * Formats acceptés (le premier qui correspond gagne, élément par élément) :
 *
 *  1. Format TagoIO, tel que l'envoie déjà votre action Live Objects :
 *       {"variable":"index_1","value":123.4,"time":"2026-11-22T10:00:00Z"}   (objet seul ou tableau)
 *  2. Message de données Live Objects : l'objet "value" contient les champs décodés,
 *     chaque champ numérique devient une variable :
 *       {"streamId":"urn:lo:nsid:...","timestamp":"2026-11-22T10:00:00Z","value":{"index_1":123.4,"index_2":45.6}}
 *  3. Objet plat avec horodatage : {"time":"...","index_1":123.4,"index_2":45.6}
 *  0. (prioritaire) Compteur Adeunis Pulse : un objet "genericSensor" quelque part dans le message
 *       {"genericSensor":{"0":{"sensorValue":123},"1":{"sensorValue":45}}}   (index en litres)
 *     donne index_eau_1 (voie 0) et index_eau_2 (voie 1). Même logique que le parseur TagoIO d'origine :
 *     le message peut être l'objet lui-même, ou sa version texte JSON dans "value".
 *
 * Tout ce qui n'est pas numérique est ignoré (compté dans `ignored`).
 */

const MAX_POINTS = 5000;
const TIME_KEYS = ['time', 'timestamp', 'created', 'date', 'ts'];

export function parseTime(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'number') return v < 1e11 ? Math.round(v * 1000) : Math.round(v); // secondes ou millisecondes
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return parseTime(Number(v), fallback);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : fallback;
  }
  return fallback;
}

export function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null; // null, booléens, objets : pas une mesure
}

function flatten(obj, prefix, out, depth) {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, name, out, depth + 1);
    else out.push([name, v]);
  }
  return out;
}

function maybeJson(v) {
  if (typeof v === 'string' && /^\s*[{[]/.test(v)) { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

/** Cherche un objet `genericSensor` dans le message (profondeur limitée, JSON imbriqué en texte accepté). */
function findGenericSensor(node, depth = 0) {
  node = maybeJson(node);
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (node.genericSensor && typeof node.genericSensor === 'object') return node.genericSensor;
  for (const v of Object.values(node)) {
    const r = findGenericSensor(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Heure du message : champ horaire de l'élément, sinon de son contenu JSON. */
function messageTime(it) {
  const own = firstTime(it);
  if (own !== undefined) return own;
  const inner = maybeJson(it.value);
  return inner && typeof inner === 'object' ? firstTime(inner) : undefined;
}

const firstTime = (o) => TIME_KEYS.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== '');

/** @returns {{points: {variable:string, ts:number, value:number}[], ignored:number}} */
export function parseIngest(body, now = Date.now()) {
  const items = Array.isArray(body) ? body
    : body && Array.isArray(body.result) ? body.result
      : body && typeof body === 'object' ? [body] : [];
  const points = [];
  let ignored = 0;

  const add = (variable, rawValue, rawTime, source) => {
    const value = parseNumber(rawValue);
    if (value === null || !variable) { ignored++; return; }
    points.push({ variable: String(variable).slice(0, 80), ts: parseTime(rawTime, now), value, source: source === 'manual' ? 'manual' : 'auto' });
  };

  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) { ignored++; continue; }
    const gs = findGenericSensor(it);
    if (gs) {                                                        // 0. compteur Adeunis Pulse
      const t = messageTime(it);
      let found = 0;
      for (const [k, ch] of Object.entries(gs)) {
        if (!/^\d+$/.test(k) || !ch || typeof ch !== 'object') continue;
        const before = points.length;
        add(`index_eau_${Number(k) + 1}`, ch.sensorValue, t);
        found += points.length - before;
      }
      if (!found) ignored++;
      continue;
    }
    if (typeof it.variable === 'string' && 'value' in it) {          // 1. format TagoIO
      add(it.variable, it.value, firstTime(it), it.source);   // « source: manual » : relevé saisi à la main (sauvegarde restaurée)
    } else if (it.value && typeof it.value === 'object' && !Array.isArray(it.value)) { // 2. Live Objects
      const t = firstTime(it);
      for (const [name, v] of flatten(it.value, '', [], 0)) add(name, v, t);
    } else if ('value' in it && typeof it.streamId === 'string') {   // 2b. valeur scalaire d'un stream
      add(it.streamId, it.value, firstTime(it));
    } else {                                                         // 3. objet plat
      const t = firstTime(it);
      for (const [name, v] of flatten(it, '', [], 0)) {
        if (TIME_KEYS.includes(name)) continue;
        add(name, v, t);
      }
    }
    if (points.length > MAX_POINTS) break;
  }
  return { points: points.slice(0, MAX_POINTS), ignored };
}
