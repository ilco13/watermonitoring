/*
 * Thème clair / sombre, identique sur l'ASL et sur le suivi de l'eau (ce fichier est le même des deux côtés).
 *  - choix mémorisé dans le navigateur (clé « theme ») ; sans choix, on suit le réglage de l'appareil ;
 *  - les deux sites n'ont pas la même adresse, donc pas de stockage commun : le thème voyage dans le lien qui
 *    mène de l'un à l'autre (?theme=dark|light, retiré de l'adresse dès l'arrivée) ;
 *  - à charger dans <head>, sans « defer », pour que la page s'affiche directement dans le bon thème.
 */
(function () {
  var KEY = 'theme', root = document.documentElement, stored = null;
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* stockage indisponible : le choix vaut pour cette page seulement */ } }
  var ok = function (v) { return v === 'dark' || v === 'light'; };

  // Thème reçu par le lien d'un des deux sites : il prime, et on nettoie l'adresse
  try {
    var u = new URL(location.href), q = u.searchParams.get('theme');
    if (q !== null) {
      if (ok(q)) { stored = q; write(q); }
      u.searchParams.delete('theme');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    }
  } catch (e) { /* ignoré */ }
  if (!stored) stored = read(KEY);
  if (!ok(stored)) { stored = read('wm.theme'); if (ok(stored)) write(stored); }   // ancien choix du suivi de l'eau
  if (!ok(stored)) stored = null;

  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function current() { return stored || (mq && mq.matches ? 'dark' : 'light'); }

  function paint() {
    var t = current();
    root.setAttribute('data-theme', t);
    var b = document.getElementById('btn-theme');
    if (b) {
      var label = t === 'dark' ? 'Thème sombre : passer au thème clair' : 'Thème clair : passer au thème sombre';
      b.title = label; b.setAttribute('aria-label', label);
    }
    // les liens vers l'autre site emportent le thème courant
    var links = document.querySelectorAll('a[data-sync-theme]');
    for (var i = 0; i < links.length; i++) {
      try { var h = new URL(links[i].getAttribute('href'), location.href); h.searchParams.set('theme', t); links[i].setAttribute('href', h.href); } catch (e) { /* ignoré */ }
    }
  }
  function set(t) {
    stored = ok(t) ? t : null;
    if (stored) write(stored);
    paint();
    try { document.dispatchEvent(new CustomEvent('themechange', { detail: current() })); } catch (e) { /* ignoré */ }
  }
  window.siteTheme = { get: current, set: set, toggle: function () { set(current() === 'dark' ? 'light' : 'dark'); } };

  paint();   // avant le premier affichage
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('btn-theme');
    if (b) b.addEventListener('click', function () { window.siteTheme.toggle(); });
    paint();
  });
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!stored) set(null); });
  window.addEventListener('storage', function (e) {   // autre onglet du même site
    if (e.key === KEY) { var v = read(KEY); stored = ok(v) ? v : null; set(stored); }
  });
})();
