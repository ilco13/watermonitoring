/*
 * demo.js - données fictives mais réalistes, affichées tant qu'aucune source réelle n'est configurée.
 * Génère, pour chaque compteur, des relevés toutes les 2 h au format TagoIO ({time, value}),
 * avec un index en m³. Déterministe (même courbe à chaque chargement), fuite simulée sur les ~30 dernières heures.
 */
(function (root) {
  'use strict';

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // poids par tranche de 2 h (0-2 h … 22-24 h), somme = 1
  const PROFILE_POTABLE = [0, 0, 0.07, 0.17, 0.09, 0.10, 0.11, 0.09, 0.12, 0.17, 0.05, 0.005];
  const PROFILE_ARROSAGE = [0, 0, 0.1, 0.8, 0.1, 0, 0, 0, 0, 0, 0, 0]; // tôt le matin

  function generate(now, years) {
    const step = 2 * 3600e3;
    const end = Math.floor(now / step) * step + 7 * 60e3; // relevé à hh:07
    const n = Math.round((years || 3) * 365 * 12);
    const out = { potable: [], arrosage: [] };
    const rand = rng(1234);
    const state = { potable: 1234.567, arrosage: 345.123 }; // index de départ (m³)
    const dayFactor = {}; // facteur aléatoire par jour

    for (let i = n; i >= 0; i--) {
      const t = end - i * step;
      const d = new Date(t);
      const key = d.getFullYear() * 1000 + Math.floor((t - new Date(d.getFullYear(), 0, 1)) / 864e5);
      if (!(key in dayFactor)) dayFactor[key] = { p: 0.7 + rand() * 0.6, rain: rand() < 0.35, a: 0.6 + rand() * 0.8 };
      const f = dayFactor[key];
      const slot = Math.floor(d.getHours() / 2);
      const dow = d.getDay();
      const month = d.getMonth();

      // eau potable : ~350 L/jour, plus le week-end et l'été (piscine, douches)
      const perDay = (dow === 0 || dow === 6 ? 470 : 330) * (month >= 5 && month <= 8 ? 1.25 : 1) * f.p;
      let litres = perDay * PROFILE_POTABLE[slot] * (0.7 + rand() * 0.6);
      // fuite simulée sur les 30 dernières heures : ~3 L/h en continu
      if (i < 15) litres += 6;
      state.potable += litres / 1000;

      // arrosage : avril → octobre, sauf jours de pluie, au petit matin
      let arro = 0;
      if (month >= 3 && month <= 9 && !f.rain) {
        const base = month >= 5 && month <= 7 ? 1400 : 700;
        arro = base * f.a * PROFILE_ARROSAGE[slot];
      }
      state.arrosage += arro / 1000;

      // jitter de ±2 min sur l'horodatage, comme sur un vrai compteur
      const ts = new Date(t + Math.round((rand() - 0.5) * 240e3)).toISOString();
      out.potable.push({ time: ts, value: Math.round(state.potable * 1000) / 1000 });
      out.arrosage.push({ time: ts, value: Math.round(state.arrosage * 1000) / 1000 });
    }
    return out;
  }

  root.DEMO = { generate };
})(typeof self !== 'undefined' ? self : this);
