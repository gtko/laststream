/* Comportements du menu des Réglages : clavier (↑/↓ avec boucle, Début/Fin, tabindex itinérant), sélecteur déroulant mobile.
 * Le HTML est dans settings-ui.js (navHTML) ; le défilement vers le panneau reste à la charge de l'appelant (onPick). */

const ITEMS = '.set-nav-list [data-set-cat]';

/** Met à jour l'état visuel et accessible du menu pour la catégorie active (liste, tabindex itinérant, sélecteur mobile). */
export function syncNav(root, id) {
  const items = Array.from(root.querySelectorAll(ITEMS));
  items.forEach((b) => {
    const on = b.dataset.setCat === id;
    b.setAttribute('aria-current', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    const nav = b.closest('.set-nav');
    if (on && nav && nav.scrollHeight > nav.clientHeight) nav.scrollTop = b.offsetTop - (nav.clientHeight - b.offsetHeight) / 2;
  });
  const opts = Array.from(root.querySelectorAll('[data-set-opt]'));
  opts.forEach((o) => o.setAttribute('aria-selected', o.dataset.setOpt === id ? 'true' : 'false'));
  const i = items.findIndex((b) => b.dataset.setCat === id);
  const btn = root.querySelector('[data-set-sel]');
  if (!btn || i < 0) return;
  const label = btn.querySelector('[data-sel-name]');
  const ic = btn.querySelector('[data-sel-ic]');
  const pos = btn.querySelector('[data-sel-pos]');
  const src = items[i];
  if (label) label.textContent = src.querySelector('.set-nav-t').textContent;
  if (ic) ic.innerHTML = src.querySelector('svg').outerHTML;
  if (pos) pos.textContent = (i + 1) + ' sur ' + items.length;
}

function closeSel(root, refocus) {
  const btn = root.querySelector('[data-set-sel]');
  const list = root.querySelector('.set-sel-l');
  if (!btn || !list || list.hidden) return;
  list.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

function openSel(root) {
  const btn = root.querySelector('[data-set-sel]');
  const list = root.querySelector('.set-sel-l');
  if (!btn || !list) return;
  list.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const cur = list.querySelector('[aria-selected="true"]') || list.querySelector('[data-set-opt]');
  if (cur) cur.focus();
}

/** Déplace le focus dans une liste de boutons : ↑/↓ avec boucle, Début, Fin. Renvoie true si la touche est traitée. */
function moveFocus(list, key) {
  const i = list.indexOf(document.activeElement);
  let n;
  if (key === 'ArrowDown') n = (i + 1) % list.length;
  else if (key === 'ArrowUp') n = (i <= 0 ? list.length : i) - 1;
  else if (key === 'Home') n = 0;
  else if (key === 'End') n = list.length - 1;
  else return false;
  list[n].focus();
  return true;
}

/**
 * Branche le clavier et le sélecteur mobile sur `root` (conteneur de la page). Délégué : survit aux rendus.
 * `onPick(id)` : active la catégorie et amène son panneau en haut.
 */
export function bindSettingsNav(root, onPick) {
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const item = t.closest(ITEMS);
    if (item) {
      const items = Array.from(root.querySelectorAll(ITEMS));
      if (!moveFocus(items, e.key)) return;
      e.preventDefault();
      e.stopPropagation(); // sinon la navigation spatiale générale (data-nav) reprend la main
      items.forEach((b) => { b.tabIndex = b === document.activeElement ? 0 : -1; });
      return;
    }
    const opt = t.closest('[data-set-opt]');
    if (opt) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSel(root, true); return; }
      if (e.key === 'Tab') { closeSel(root, false); return; }
      if (moveFocus(Array.from(root.querySelectorAll('[data-set-opt]')), e.key)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (t.closest('[data-set-sel]') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      e.stopPropagation();
      openSel(root);
    }
  });
  root.addEventListener('focusout', (e) => {
    const sel = e.target instanceof Element ? e.target.closest('.set-sel') : null;
    // relatedTarget nul (Safari, Firefox macOS : un clic ne donne pas le focus au bouton) : ne rien fermer, le clic extérieur est géré plus bas.
    if (!sel || !(e.relatedTarget instanceof Node)) return;
    if (!sel.contains(e.relatedTarget)) closeSel(root, false);
  });
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const sel = t.closest('[data-set-sel]');
    if (sel) {
      if (sel.getAttribute('aria-expanded') === 'true') closeSel(root, false); else openSel(root);
      return;
    }
    const opt = t.closest('[data-set-opt]');
    if (opt) { closeSel(root, true); onPick(opt.dataset.setOpt); return; }
    if (!t.closest('.set-sel')) closeSel(root, false);
  });
}
