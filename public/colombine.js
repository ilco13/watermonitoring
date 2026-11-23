/* Colombine (assistante de l'ASL) sur le suivi de l'eau. Aucun HTML n'est injecté : tout passe par textContent. */
(function () {
  var btn = document.getElementById('colombine-btn'), panel = document.getElementById('colombine');
  if (!btn || !panel) return;
  var log = document.getElementById('colombine-log'), form = document.getElementById('colombine-form'), input = document.getElementById('colombine-q');
  var KEY = 'colombine-eau', OPEN = 'colombine-eau-open', history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (e) { history = []; }
  function bubble(role, text) { var n = document.createElement('div'); n.className = 'colombine-msg ' + (role === 'user' ? 'me' : 'her'); n.textContent = text; log.appendChild(n); log.scrollTop = log.scrollHeight; return n; }
  function remember(role, content) { history.push({ role: role, content: content }); history = history.slice(-12); try { sessionStorage.setItem(KEY, JSON.stringify(history)); } catch (e) {} }
  function redraw() { log.textContent = ''; if (!history.length) bubble('assistant', "Bonjour, je suis Colombine. Demandez-moi par exemple : combien d'eau a-t-on consommé hier ? y a-t-il une alerte ? quel jour consomme-t-on le plus ? Je réponds aussi aux questions sur l'ASL."); history.forEach(function (t) { bubble(t.role, t.content); }); }
  function toggle(open) { panel.hidden = !open; btn.setAttribute('aria-expanded', String(open)); try { sessionStorage.setItem(OPEN, open ? '1' : ''); } catch (e) {} if (open) { redraw(); input.focus(); } }
  btn.addEventListener('click', function () { toggle(panel.hidden); });
  document.getElementById('colombine-close').addEventListener('click', function () { toggle(false); btn.focus(); });
  document.getElementById('colombine-new').addEventListener('click', function () { history = []; try { sessionStorage.removeItem(KEY); } catch (e) {} redraw(); });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { toggle(false); btn.focus(); } });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim(), send = form.querySelector('button');
    if (!q || send.disabled) return;
    input.value = ''; bubble('user', q);
    var wait = bubble('assistant', 'Colombine réfléchit…'); wait.classList.add('wait');
    var sent = history.slice(-6); send.disabled = true; remember('user', q);
    fetch('api/colombine', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eau-dashboard' }, credentials: 'same-origin', body: JSON.stringify({ q: q, history: sent }) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) { send.disabled = false; log.removeChild(wait); var a = (j.result && j.result.answer) || "Je n'ai pas de réponse."; bubble('assistant', a); remember('assistant', a); })
      .catch(function () { send.disabled = false; log.removeChild(wait); bubble('assistant', "Je n'ai pas pu répondre. Vérifiez votre connexion ou reconnectez-vous, puis réessayez."); });
  });
  var was = ''; try { was = sessionStorage.getItem(OPEN) || ''; } catch (e) {}
  if (was) toggle(true);
})();
