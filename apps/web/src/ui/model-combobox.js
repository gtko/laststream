/* Choix du modèle OpenRouter (Réglages > Serveur) : combobox ARIA avec recherche sans accents, groupes par fournisseur,
 * tri, badges et tarifs ; feuille du bas sur mobile ; saisie libre en repli (erreur réseau ou identifiant personnalisé).
 * La valeur enregistrée reste la chaîne id du modèle, dans un champ caché `name` (lu tel quel par settings.js).
 * Le HTML est une chaîne (comme le reste de la page) ; l'état vit dans une WeakMap par racine et les événements sont
 * délégués au document une seule fois. Données : data/openrouterModels.ts (liste publique, cache 24 h). */
import {
  badges, cachedModels, ctxLabel, estimateText, filterModels, groupModels, loadModels, priceLabel,
} from '../data/openrouterModels';
import { esc } from './util.js';
import '../styles/model-combobox.css';

const SORTS = [['price', 'Prix'], ['ctx', 'Contexte'], ['name', 'Nom']];
const SKELETON_ROWS = 6;
const CHEV = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>';
const CROSS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const CHECK = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
const PLUS = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
const SEARCH_PH = 'Rechercher un modèle, un fournisseur…';
const FREE_PH = 'fournisseur/nom-du-modèle';

/** Catalogue partagé par tous les widgets : idle → loading → ok | error. */
const store = { status: 'idle', models: [], byId: new Map() };
const states = new WeakMap();
let keyboardMode = false;

function setModels(models) {
  store.models = models;
  store.byId = new Map(models.map((m) => [m.id, m]));
  store.status = 'ok';
}

function fetchModels(force) {
  store.status = 'loading';
  refreshAll();
  loadModels({ force }).then(setModels, () => { store.status = 'error'; }).then(refreshAll);
}

/** Premier affichage : cache frais tout de suite, sinon une seule requête pour toute la page. */
function ensureModels() {
  if (store.status !== 'idle') return;
  const fresh = cachedModels();
  if (fresh) setModels(fresh);
  else fetchModels(false);
}

/** Champ complet. `id` : identifiant du champ (relié au libellé de la ligne), `value` : modèle enregistré. */
export function modelComboHTML(id, value) {
  ensureModels();
  queueMicrotask(refreshAll);
  const lb = id + '-lb';
  return '<div class="mcb" data-mcb data-lb="' + lb + '">' +
    '<input type="hidden" name="svc.openrouterModel" value="' + esc(value) + '" data-mcb-value>' +
    '<div class="mcb-field mcb-field-main"><input class="mcb-input" id="' + id + '" type="text" data-mcb-q autocomplete="off" spellcheck="false" aria-describedby="' + id + '-cp ' + id + '-est">' +
    '<span class="mcb-curprice" id="' + id + '-cp"></span>' +
    '<button type="button" class="mcb-chev" tabindex="-1" aria-label="Afficher la liste des modèles" data-mcb-toggle>' + CHEV + '</button></div>' +
    '<button type="button" class="mcb-trig" data-mcb-trig aria-haspopup="listbox" aria-expanded="false" aria-controls="' + lb + '">' +
    '<span class="mcb-trig-t"><span class="mcb-trig-n"></span><span class="mcb-trig-id"></span></span><span class="mcb-curprice"></span>' + CHEV + '</button>' +
    '<div class="mcb-veil" data-mcb-close hidden></div>' +
    '<div class="mcb-pop" data-mcb-pop hidden>' +
    '<div class="mcb-sheet-h"><div class="mcb-handle" aria-hidden="true"></div><div class="mcb-field">' +
    '<input class="mcb-input" type="text" data-mcb-q="sheet" role="combobox" aria-label="Rechercher un modèle" aria-expanded="true" aria-controls="' + lb + '" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="' + SEARCH_PH + '">' +
    '<button type="button" class="mcb-chev" aria-label="Fermer la liste" data-mcb-close>' + CROSS + '</button></div></div>' +
    '<div class="mcb-bar"><span class="mcb-count" aria-live="polite"></span><div class="mcb-segs" role="group" aria-label="Trier par">' +
    SORTS.map(([k, l]) => '<button type="button" class="mcb-seg" data-mcb-sort="' + k + '" aria-pressed="false">' + l + '</button>').join('') + '</div></div>' +
    '<div class="mcb-body"><div class="mcb-sk-wrap" role="status" aria-label="Chargement des modèles" hidden>' +
    '<div class="mcb-sk"><i class="mcb-sk-dot"></i><span><i class="mcb-sk-a"></i><i class="mcb-sk-b"></i></span><i></i></div>'.repeat(SKELETON_ROWS) + '</div>' +
    '<div class="mcb-empty" hidden></div>' +
    '<ul class="mcb-list" id="' + lb + '" role="listbox" aria-label="Modèles OpenRouter"></ul></div>' +
    '<div class="mcb-foot"><button type="button" class="mcb-link" data-mcb-custom>' + PLUS + 'Utiliser un identifiant personnalisé</button></div></div>' +
    '<div class="mcb-warn" role="alert" hidden><span>Impossible de charger la liste des modèles. Saisis l’identifiant à la main, ou réessaie.</span>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-mcb-retry>Réessayer</button></div>' +
    '<p class="mcb-invalid" role="status" hidden>Cet identifiant ne ressemble pas à « fournisseur/modèle » : vérifie-le sur openrouter.ai.</p>' +
    '<p class="mcb-note" hidden>Identifiant personnalisé. <button type="button" class="mcb-back" data-mcb-back>Revenir à la liste</button></p>' +
    '<p class="mcb-est" id="' + id + '-est" aria-live="polite"></p></div>';
}

// ---------- État et rendu ----------
function st(root) {
  let s = states.get(root);
  if (!s) {
    s = { open: false, sheet: false, query: '', sort: 'name', active: 0, pendingCur: false, suppressOpen: false, custom: false, flat: [], mode: '' };
    states.set(root, s);
  }
  return s;
}

const parts = (root) => ({
  hidden: root.querySelector('[data-mcb-value]'),
  input: root.querySelector('.mcb-field-main .mcb-input'),
  sheetInput: root.querySelector('[data-mcb-q="sheet"]'),
  trig: root.querySelector('[data-mcb-trig]'),
  pop: root.querySelector('[data-mcb-pop]'),
  veil: root.querySelector('.mcb-veil'),
  list: root.querySelector('.mcb-list'),
});

const isFree = (root) => st(root).custom || store.status === 'error';
const current = (root) => store.byId.get(parts(root).hidden.value.trim());

function refreshAll() {
  document.querySelectorAll('[data-mcb]').forEach(paint);
  // Garde-fou : une feuille retirée du DOM sans closeList (rerendu, navigation) ne doit pas bloquer le défilement.
  if (!document.querySelector('[data-mcb].is-sheet')) document.documentElement.classList.remove('mcb-lock');
}

/** Identifiant plausible « fournisseur/modèle » : simple avertissement, la saisie n'est jamais bloquée. */
const ID_RE = /^[\w.-]+\/[\w.\-:@]+$/;
const ID_MAX = 200;
const plausibleId = (v) => !v || (v.length <= ID_MAX && ID_RE.test(v));

function paintInvalid(root) {
  const v = parts(root).hidden.value.trim();
  root.querySelector('.mcb-invalid').hidden = !isFree(root) || plausibleId(v);
}

function optionHTML(m, k, lb, cur, active) {
  const b = badges(m);
  const ctx = ctxLabel(m.ctx);
  return '<li class="mcb-opt' + (cur ? ' is-cur' : '') + (k === active ? ' is-act' : '') + '" id="' + lb + '-o' + k + '" role="option" aria-selected="' + cur + '" data-mcb-opt="' + esc(m.id) + '">' +
    '<span class="mcb-check" aria-hidden="true">' + (cur ? CHECK : '') + '</span>' +
    '<span class="mcb-main"><span class="mcb-name">' + esc(m.name) +
    (b.free ? ' <span class="mcb-badge is-free">Gratuit</span>' : '') +
    (b.eco ? ' <span class="mcb-badge is-eco">Économique</span>' : '') +
    (b.long ? ' <span class="mcb-badge is-long">Long contexte</span>' : '') +
    '</span><span class="mcb-id">' + esc(m.id) + '</span></span>' +
    '<span class="mcb-meta"><span class="mcb-pr">' + esc(priceLabel(m)) + '</span>' + (ctx ? '<span class="mcb-ctx">' + ctx + ' de contexte</span>' : '') + '</span></li>';
}

/** Liste filtrée et groupée ; `st.flat` garde l'ordre affiché pour le clavier. */
function paintList(root) {
  const s = st(root);
  const p = parts(root);
  const lb = root.dataset.lb;
  const loading = store.status === 'loading';
  const groups = loading ? [] : groupModels(filterModels(store.models, s.query), s.sort);
  s.flat = groups.flatMap((g) => g.models);
  const curId = p.hidden.value.trim();
  // À l'ouverture (ou quand la liste arrive pendant qu'elle est ouverte), le modèle actuel est l'option active.
  if (s.pendingCur && !loading) { s.active = Math.max(0, s.flat.findIndex((m) => m.id === curId)); s.pendingCur = false; }
  if (s.active >= s.flat.length) s.active = 0;
  let k = 0;
  p.list.innerHTML = groups.map((g, gi) => '<li class="mcb-g" role="group" aria-labelledby="' + lb + '-g' + gi + '"><div class="mcb-grp" id="' + lb + '-g' + gi + '" role="presentation">' + esc(g.provider) + '</div>' +
    '<ul class="mcb-gl" role="none">' + g.models.map((m) => optionHTML(m, k++, lb, m.id === curId, s.active)).join('') + '</ul></li>').join('');
  const n = s.flat.length;
  root.querySelector('.mcb-count').textContent = loading ? 'Chargement…' : n + (n > 1 ? ' modèles' : ' modèle') + ' · prix par million de tokens (entrée / sortie)';
  root.querySelector('.mcb-sk-wrap').hidden = !loading;
  const empty = root.querySelector('.mcb-empty');
  empty.hidden = loading || n > 0;
  if (!empty.hidden) {
    const q = s.query.trim();
    empty.innerHTML = '<strong>Aucun modèle pour « ' + esc(q) + ' »</strong><span>Essaie un autre mot, ou utilise un identifiant personnalisé.</span>' +
      (q ? '<button type="button" class="mcb-back" data-mcb-custom>Utiliser « ' + esc(q) + ' » comme identifiant</button>' : '');
  }
  p.list.hidden = loading || n === 0;
  root.querySelectorAll('[data-mcb-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mcbSort === s.sort)));
  setActive(root, s.active, false);
}

function setActive(root, i, scroll) {
  const s = st(root);
  const p = parts(root);
  s.active = i;
  const prev = p.list.querySelector('.mcb-opt.is-act');
  if (prev) prev.classList.remove('is-act');
  const el = s.open && s.flat.length ? p.list.querySelector('#' + root.dataset.lb + '-o' + i) : null;
  if (el) el.classList.add('is-act');
  const ad = el ? el.id : '';
  [p.input, p.sheetInput].forEach((inp) => {
    if (ad) inp.setAttribute('aria-activedescendant', ad); else inp.removeAttribute('aria-activedescendant');
  });
  // Défile la liste seule (scrollIntoView ferait aussi défiler la page).
  if (el && scroll) {
    const list = p.list;
    const top = el.offsetTop - list.offsetTop;
    if (scroll === 'center') list.scrollTop = top - (list.clientHeight - el.offsetHeight) / 2;
    else if (top < list.scrollTop) list.scrollTop = top;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
  }
}

function paint(root) {
  const s = st(root);
  const p = parts(root);
  const free = isFree(root);
  const mode = free ? 'free' : 'list';
  if (free && s.open) closeList(root, false);
  root.classList.toggle('is-free', free);
  root.classList.toggle('is-open', s.open);
  root.classList.toggle('is-sheet', s.open && s.sheet);
  const cur = current(root);
  const id = p.hidden.value.trim();
  const inp = p.input;
  if (free) {
    ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-haspopup', 'aria-activedescendant'].forEach((a) => inp.removeAttribute(a));
    inp.placeholder = FREE_PH;
    if (s.mode !== mode) inp.value = id;
  } else {
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-controls', root.dataset.lb);
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-haspopup', 'listbox');
    inp.setAttribute('aria-expanded', String(s.open && !s.sheet));
    inp.placeholder = s.open ? SEARCH_PH : (store.status === 'loading' ? 'Chargement des modèles…' : SEARCH_PH);
    if (!s.open) inp.value = cur ? cur.name : id;
  }
  s.mode = mode;
  const price = cur ? priceLabel(cur) : '';
  root.querySelectorAll('.mcb-curprice').forEach((el) => { el.textContent = s.open || free ? '' : price; });
  p.trig.setAttribute('aria-expanded', String(s.open && s.sheet));
  p.trig.setAttribute('aria-label', 'Modèle OpenRouter : ' + (cur ? cur.name + ', ' + price : id || 'aucun'));
  p.trig.querySelector('.mcb-trig-n').textContent = cur ? cur.name : (id || 'Choisir un modèle');
  p.trig.querySelector('.mcb-trig-id').textContent = cur ? id : '';
  p.pop.hidden = !s.open;
  p.veil.hidden = !(s.open && s.sheet);
  root.querySelector('.mcb-warn').hidden = store.status !== 'error';
  root.querySelector('.mcb-note').hidden = !(s.custom && store.status !== 'error');
  root.querySelector('.mcb-est').textContent = store.status === 'loading' && !free ? '' : estimateText(cur);
  paintInvalid(root);
  if (s.open) paintList(root); else setActive(root, s.active, false);
}

// ---------- Actions ----------
function openList(root, sheet) {
  const s = st(root);
  if (isFree(root)) return;
  ensureModels();
  s.open = true;
  s.sheet = !!sheet;
  s.query = '';
  const p = parts(root);
  p.input.value = '';
  p.sheetInput.value = '';
  s.active = 0;
  s.pendingCur = true;
  paint(root);
  setActive(root, s.active, 'center');
  if (sheet) {
    document.documentElement.classList.add('mcb-lock');
    p.sheetInput.focus({ preventScroll: true });
  }
}

/** Ferme et vide la recherche ; le focus revient au champ (ou au bouton sur mobile) si `refocus`. */
function closeList(root, refocus) {
  const s = st(root);
  if (!s.open) return;
  const wasSheet = s.sheet;
  s.open = false;
  s.sheet = false;
  s.query = '';
  document.documentElement.classList.remove('mcb-lock');
  paint(root);
  if (!refocus) return;
  const inp = parts(root).input;
  // Le retour du focus sur le champ ne doit pas rouvrir la liste (voir focusin).
  s.suppressOpen = true;
  try {
    (wasSheet ? parts(root).trig : inp).focus({ preventScroll: true });
  } finally {
    s.suppressOpen = false;
  }
  if (!wasSheet && document.activeElement === inp) inp.select();
}

function choose(root, id) {
  const p = parts(root);
  p.hidden.value = id;
  p.hidden.dispatchEvent(new Event('change', { bubbles: true }));
  closeList(root, true);
}

function goCustom(root) {
  const s = st(root);
  const p = parts(root);
  const typed = s.query.trim();
  const wasSheet = s.sheet;
  closeList(root, false);
  if (typed) p.hidden.value = typed;
  s.custom = true;
  s.mode = '';
  paint(root);
  p.input.focus({ preventScroll: !wasSheet });
  p.input.select();
}

function backToList(root) {
  st(root).custom = false;
  paint(root);
  parts(root).input.focus({ preventScroll: true });
}

// ---------- Événements délégués ----------
const rootOf = (t) => (t instanceof Element ? t.closest('[data-mcb]') : null);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') keyboardMode = true;
  const t = e.target;
  // Échap avec la liste ouverte, quel que soit l'élément focalisé (tri, pied) : ferme sans quitter la page (events.js).
  const r = rootOf(t);
  if (e.key === 'Escape' && r && st(r).open) { e.preventDefault(); closeList(r, true); return; }
  if (!(t instanceof HTMLInputElement) || t.dataset.mcbQ === undefined) return;
  const root = rootOf(t);
  if (!root || isFree(root)) return;
  const s = st(root);
  const n = s.flat.length;
  const k = e.key;
  if (k.startsWith('Arrow') || k === 'Home' || k === 'End') root.classList.add('is-kbd');
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    if (!s.open) { openList(root, false); return; }
    if (n) setActive(root, (s.active + (k === 'ArrowDown' ? 1 : -1) + n) % n, true);
  } else if ((k === 'Home' || k === 'End') && s.open) {
    e.preventDefault();
    if (n) setActive(root, k === 'Home' ? 0 : n - 1, true);
  } else if (k === 'Enter' && s.open) {
    e.preventDefault();
    if (s.flat[s.active]) choose(root, s.flat[s.active].id);
  }
}, true);

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.dataset.mcbQ === undefined) return;
  const root = rootOf(t);
  if (!root) return;
  const s = st(root);
  if (isFree(root)) {
    parts(root).hidden.value = t.value.trim();
    root.querySelector('.mcb-est').textContent = estimateText(current(root));
    paintInvalid(root);
    return;
  }
  // openList vide le champ : on garde le premier caractère tapé.
  const v = t.value;
  if (!s.open) { openList(root, t.dataset.mcbQ === 'sheet'); t.value = v; }
  s.query = v;
  s.active = 0;
  paintList(root);
});

document.addEventListener('focusin', (e) => {
  const t = e.target;
  const root = rootOf(t);
  if (!root) return;
  root.classList.toggle('is-kbd', keyboardMode);
  const s = st(root);
  if (t === parts(root).input && !isFree(root) && !s.open && !s.suppressOpen) openList(root, false);
});

document.addEventListener('focusout', (e) => {
  const root = rootOf(e.target);
  if (!root || !st(root).open) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body && !root.contains(a)) closeList(root, false);
  }, 0);
});

document.addEventListener('pointerdown', (e) => {
  keyboardMode = false;
  document.querySelectorAll('[data-mcb].is-open').forEach((root) => {
    if (!(e.target instanceof Node) || !root.contains(e.target)) closeList(root, false);
  });
  const root = rootOf(e.target);
  if (root) root.classList.remove('is-kbd');
}, true);

// Retour Android / historique : la page change, la feuille ne doit pas laisser le défilement bloqué.
window.addEventListener('popstate', () => document.querySelectorAll('[data-mcb].is-open').forEach((r) => closeList(r, false)));

// Garde le focus dans le champ pendant les clics dans la liste (options, tri, pied).
document.addEventListener('mousedown', (e) => {
  const t = e.target;
  if (t instanceof Element && t.closest('[data-mcb-pop], [data-mcb-toggle]') && !t.closest('input')) e.preventDefault();
});

document.addEventListener('click', (e) => {
  const t = e.target;
  const root = rootOf(t);
  if (!root || !(t instanceof Element)) return;
  // Clic sur le champ déjà focalisé (après un choix ou Échap) : focusin ne se redéclenche pas, on rouvre ici.
  if (t === parts(root).input && !isFree(root) && !st(root).open) { openList(root, false); return; }
  const opt = t.closest('[data-mcb-opt]');
  if (opt) { choose(root, opt.getAttribute('data-mcb-opt')); return; }
  const sort = t.closest('[data-mcb-sort]');
  if (sort) { const s = st(root); s.sort = sort.dataset.mcbSort; s.active = 0; paintList(root); return; }
  if (t.closest('[data-mcb-custom]')) { goCustom(root); return; }
  if (t.closest('[data-mcb-back]')) { backToList(root); return; }
  if (t.closest('[data-mcb-retry]')) { st(root).custom = false; fetchModels(true); openList(root, false); parts(root).input.focus({ preventScroll: true }); return; }
  if (t.closest('[data-mcb-close]')) { closeList(root, true); return; }
  if (t.closest('[data-mcb-trig]')) { openList(root, true); return; }
  if (t.closest('[data-mcb-toggle]')) {
    if (st(root).open) closeList(root, true);
    else { parts(root).input.focus({ preventScroll: true }); openList(root, false); }
  }
});
