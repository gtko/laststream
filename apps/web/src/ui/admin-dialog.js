/* Calques de la console d'administration : modale (confirmation, mot de passe), panneau latéral (détail d'un compte).
 * Piège le focus, se ferme avec Échap ou le fond, rend le focus à l'élément d'origine. Plusieurs calques peuvent s'empiler
 * (confirmation par-dessus le panneau). Hors de #detail : les événements du contenu sont gérés par l'appelant. */
import { esc } from './util.js';
import { ICON } from './icons.js';

const stack = [];
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let uid = 0;

export function openLayer({ title, html, variant = 'modal', onClose }) {
  const id = 'adm-l' + (++uid);
  const el = document.createElement('div');
  el.className = 'adm-layer adm-layer--' + variant;
  el.innerHTML = '<div class="adm-scrim" data-adm-close></div>' +
    '<section class="adm-sheet" role="dialog" aria-modal="true" aria-labelledby="' + id + '-t" tabindex="-1">' +
    '<header class="adm-sheet-h"><h2 id="' + id + '-t">' + esc(title) + '</h2>' +
    '<button type="button" class="set-icon-btn" data-adm-close aria-label="Fermer">' + ICON.close + '</button></header>' +
    '<div class="adm-sheet-b">' + html + '</div></section>';
  const opener = document.activeElement;
  document.body.appendChild(el);
  document.body.classList.add('modal-open');
  const sheet = el.querySelector('.adm-sheet');
  let closed = false;
  const layer = {
    el,
    body: el.querySelector('.adm-sheet-b'),
    setBody(h) { layer.body.innerHTML = h; },
    close(result) {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      el.remove();
      if (!stack.length) document.body.classList.remove('modal-open');
      if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
      if (onClose) onClose(result);
    },
  };
  el.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-adm-close]')) layer.close();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); layer.close(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(sheet.querySelectorAll(FOCUSABLE));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  stack.push(layer);
  const first = layer.body.querySelector('input:not([disabled]), select, textarea, button:not([disabled]):not([data-adm-close])');
  (first || sheet).focus({ preventScroll: true });
  return layer;
}

export const closeAllLayers = () => { [...stack].reverse().forEach((l) => l.close()); };
export const topLayer = () => stack[stack.length - 1] || null;

/**
 * Confirmation explicite. `expect` : texte à recopier pour valider (suppression d'un compte).
 * Se résout par true (confirmé) ou false (annulé, Échap, fond).
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirmer', danger = false, expect = '' }) {
  return new Promise((resolve) => {
    let ok = false;
    const layer = openLayer({
      title,
      html: '<form class="adm-form" data-adm-confirm autocomplete="off"><p class="adm-lead">' + message + '</p>' +
        (expect ? '<label class="adm-field">Pour confirmer, tape « <strong>' + esc(expect) + '</strong> »<input class="set-input" name="expect" autocomplete="off" autocapitalize="none" spellcheck="false"></label>' : '') +
        '<div class="set-actions"><button type="button" class="btn btn-ghost" data-adm-close>Annuler</button>' +
        '<button type="submit" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '"' + (expect ? ' disabled' : '') + '>' + esc(confirmLabel) + '</button></div></form>',
      onClose: () => resolve(ok),
    });
    const form = layer.el.querySelector('form');
    const submit = form.querySelector('[type=submit]');
    if (expect) form.elements.expect.addEventListener('input', () => { submit.disabled = form.elements.expect.value.trim() !== expect; });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (expect && form.elements.expect.value.trim() !== expect) return;
      ok = true;
      layer.close();
    });
  });
}

/**
 * Ré-authentification : « Confirme avec ton mot de passe ». Se résout par le mot de passe saisi, ou null si annulé.
 * Le mot de passe n'est jamais gardé : il part vers /admin/elevate et le champ est vidé.
 */
export function passwordDialog({ error } = {}) {
  return new Promise((resolve) => {
    let value = null;
    const layer = openLayer({
      title: 'Confirme avec ton mot de passe',
      html: '<form class="adm-form" data-adm-reauth autocomplete="off"><p class="adm-lead">Cette action est sensible. Après confirmation, tu n’auras plus à retaper ton mot de passe pendant 10 minutes ; le jeton reste en mémoire dans cet onglet et n’est jamais enregistré.</p>' +
        '<label class="adm-field">Mot de passe<input class="set-input" type="password" name="password" autocomplete="current-password" required></label>' +
        '<p class="set-msg" role="alert">' + esc(error || '') + '</p>' +
        '<div class="set-actions"><button type="button" class="btn btn-ghost" data-adm-close>Annuler</button><button type="submit" class="btn btn-primary">Confirmer</button></div></form>',
      onClose: () => resolve(value),
    });
    const form = layer.el.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = form.elements.password.value;
      form.elements.password.value = '';
      if (!v) return;
      value = v;
      layer.close();
    });
  });
}
