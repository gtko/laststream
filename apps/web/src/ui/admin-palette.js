/* Palette de commandes de la console d'administration (Ctrl/Cmd+K, ou « / » hors champ de saisie).
 * Groupes : Comptes (recherche serveur, débounce 200 ms), Sections, Actions. Clavier : ↑↓ naviguent, Entrée exécute, Échap ferme.
 * Le focus reste dans la palette et revient à l'élément d'origine. Les actions sensibles passent toujours par confirmDialog ;
 * l'élévation (mot de passe) est demandée avant l'action quand elle l'exige, sinon adminAction la déclenche seul au besoin. */
import '../styles/admin-palette.css';
import {
  getCaches, getSettings, hasElevation, listAccounts, obtainElevation, purgeCache, putSettings, rerunTv, suspendAccount,
} from '../data/adminApi';
import {
  buildPaletteGroups, foldText, isPaletteShortcut, moveActive, PALETTE_ACCOUNT_LIMIT, PALETTE_SEARCH_DEBOUNCE_MS,
} from '../data/adminPalette';
import { confirmDialog } from './admin-dialog.js';
import { esc } from './util.js';

const ICON = '<svg class="adm-pal-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="5"></circle><path d="M11 11l3.5 3.5"></path></svg>';
const STATUS_MS = 2400;
let seq = 0;
let toastTimer = 0;
let current = null; // { id, focus(), handle: { close } } : une seule palette ouverte à la fois

const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, String(v));
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
const EDITABLE_ROLES = ['textbox', 'combobox'];

/** Champ où l'on tape (saisie, liste, rôle textbox ou combobox, contenteditable) : « / » et Ctrl+K n'ouvrent pas la palette. */
const isEditable = (node) => {
  if (!node || typeof node.getAttribute !== 'function') return false;
  const ce = node.getAttribute('contenteditable');
  return node.isContentEditable === true || (ce !== null && ce.toLowerCase() !== 'false') ||
    EDITABLE_TAGS.includes(node.tagName) || EDITABLE_ROLES.includes(node.getAttribute('role'));
};

/** Message lisible d'une erreur : les codes techniques (snake_case) deviennent un message générique. */
function messageOf(err) {
  if (err && err.code === 'cancelled') return 'Action annulée.';
  const m = err && typeof err.message === 'string' ? err.message : '';
  return m && !/^[a-z_]+$/.test(m) ? m : 'Action impossible pour le moment.';
}

/** Recherche de comptes par défaut : listAccounts, limité à PALETTE_ACCOUNT_LIMIT. Le débounce est géré par la palette. */
export function searchAccountsDefault(q) {
  return listAccounts({ q, limit: PALETTE_ACCOUNT_LIMIT }).then((r) => r.accounts || []);
}

/**
 * Actions de la console. `forAccount` : une entrée par compte trouvé (« Suspendre <compte> »).
 * `children()` : sous-actions chargées à la demande (préfixes de cache), présentées à la place du parent une fois listées.
 * `run(target)` : appelé après confirmation (si `sensitive`) et élévation (si `elevated`).
 */
export function defaultActions(ctx = {}) {
  const go = ctx.go || (() => {});
  const setMaintenance = (enabled) => async () => {
    const s = await getSettings();
    return putSettings({ maintenance: { enabled, message: s.maintenance.message } });
  };
  const purgeItems = async () => {
    const r = await getCaches('24h');
    return (r.caches || []).filter((c) => c.prefix).map((c) => ({
      id: 'purge:' + c.prefix,
      label: 'Purger le cache « ' + c.prefix + ' »',
      hint: 'Plateforme',
      sensitive: true,
      elevated: true,
      done: 'Purge lancée.',
      confirm: () => ({
        title: 'Vider le cache « ' + c.prefix + ' »',
        message: 'Toutes les entrées du cache <strong>' + esc(c.prefix) + '</strong> seront supprimées par lots, en arrière-plan. Les prochaines requêtes seront plus lentes le temps de le reconstituer.',
        confirmLabel: 'Vider le cache',
        danger: true,
      }),
      run: () => purgeCache(c.prefix),
    }));
  };
  return [
    {
      id: 'maintenance-on',
      label: 'Activer la maintenance',
      hint: 'Système',
      sensitive: true,
      elevated: true,
      confirm: () => ({
        title: 'Activer la maintenance',
        message: '<strong>Tout le serveur répondra « 503 »</strong> à tous les utilisateurs sauf à l’administration. Tu devras confirmer avec ton mot de passe.',
        confirmLabel: 'Activer la maintenance',
        danger: true,
      }),
      run: setMaintenance(true),
      done: 'Maintenance activée.',
    },
    {
      id: 'maintenance-off',
      label: 'Désactiver la maintenance',
      hint: 'Système',
      sensitive: true,
      confirm: () => ({
        title: 'Désactiver la maintenance',
        message: 'Le serveur redevient accessible à tous les utilisateurs.',
        confirmLabel: 'Désactiver la maintenance',
      }),
      run: setMaintenance(false),
      done: 'Maintenance désactivée.',
    },
    {
      id: 'purge',
      label: 'Purger un préfixe de cache',
      hint: 'Plateforme',
      children: purgeItems,
      pick: 'Tape le préfixe de cache à purger.',
    },
    { id: 'announce', label: 'Publier une annonce', hint: 'Système', run: () => go('announcements'), done: '' },
    {
      id: 'tv',
      label: 'Relancer la tâche TV',
      hint: 'Plateforme',
      sensitive: true,
      confirm: () => ({
        title: 'Relancer la tâche TV',
        message: 'La mise à jour des chaînes va être relancée maintenant, en dehors de son horaire habituel.',
        confirmLabel: 'Relancer',
      }),
      run: () => rerunTv(),
      done: 'Relance demandée.',
    },
    {
      id: 'suspend',
      label: 'Suspendre',
      hint: 'Action · mode élevé',
      sensitive: true,
      elevated: true,
      forAccount: true,
      confirm: (acc) => ({
        title: 'Suspendre ' + acc.username,
        message: '<strong>' + esc(acc.username) + '</strong> ne pourra plus se connecter et toutes ses sessions seront révoquées immédiatement. Tu pourras réactiver le compte.',
        confirmLabel: 'Suspendre',
        danger: true,
      }),
      run: (acc) => suspendAccount(acc.id),
      done: 'Compte suspendu.',
    },
  ];
}

/**
 * Ouvre la palette (une seule à la fois : un second appel ramène le focus sur celle déjà ouverte).
 * deps : { sections:[{id,label,group}], go(sectionId), openAccount(id), searchAccounts(q)->Promise<AdminAccount[]>,
 *   actions?, confirm?, elevate?, hasElevation?, notify? }. Par défaut : actions de la console, confirmDialog, obtainElevation.
 * Renvoie { close() }.
 */
export function openPalette(deps = {}) {
  if (current) {
    current.focus();
    return current.handle;
  }
  const go = deps.go || (() => {});
  const d = {
    sections: deps.sections || [],
    go,
    openAccount: deps.openAccount || (() => {}),
    searchAccounts: deps.searchAccounts || searchAccountsDefault,
    actions: deps.actions || defaultActions({ go }),
    confirm: deps.confirm || confirmDialog,
    elevate: deps.elevate || obtainElevation,
    hasElevation: deps.hasElevation || hasElevation,
    notify: deps.notify || null,
  };

  const uid = 'adm-pal-' + ++seq;
  const listId = uid + '-list';
  const opener = document.activeElement;
  const addedModal = !document.body.classList.contains('modal-open');
  const st = { query: '', accounts: [], accountsError: '', searching: false, active: 0 };
  const children = new Map(); // id d'action -> { status: 'loading' | 'ready' | 'error', list }
  let rows = [];
  let timer = 0;
  let searchId = 0;
  let open = true;

  const layer = el('div', { class: 'adm-pal-layer' });
  const dialog = el('div', { class: 'adm-pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Palette de commandes' });
  const head = el('div', { class: 'adm-pal-head' });
  head.insertAdjacentHTML('beforeend', ICON);
  const input = el('input', {
    class: 'adm-pal-input', type: 'text', role: 'combobox', 'aria-label': 'Commande', 'aria-autocomplete': 'list',
    'aria-expanded': 'true', 'aria-controls': listId, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    placeholder: 'Compte, section ou action…',
  });
  head.append(input, el('kbd', { class: 'adm-pal-kbd' }, 'Échap'));
  const list = el('div', { class: 'adm-pal-list', id: listId, role: 'listbox', 'aria-label': 'Résultats' });
  const empty = el('p', { class: 'adm-pal-empty', role: 'status' });
  dialog.append(head, list, empty);
  layer.append(dialog);

  function say(message) {
    if (d.notify) { d.notify(message); return; }
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = message;
      t.classList.remove('has-action');
      t.classList.add('is-on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('is-on'), STATUS_MS);
      return;
    }
    document.querySelectorAll('.adm-pal-status').forEach((n) => n.remove());
    const note = el('div', { class: 'adm-pal-status', role: 'status' }, message);
    document.body.append(note);
    setTimeout(() => note.remove(), STATUS_MS);
  }

  function setActive(i) {
    st.active = i;
    rows.forEach((r, j) => {
      const on = j === i;
      r.el.classList.toggle('is-active', on);
      r.el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const cur = rows[i];
    if (cur) {
      input.setAttribute('aria-activedescendant', cur.el.id);
      if (typeof cur.el.scrollIntoView === 'function') cur.el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function computeParts() {
    const accounts = [];
    const forAccount = d.actions.filter((a) => a.forAccount);
    for (const acc of st.accounts) {
      accounts.push({ key: 'open:' + acc.id, label: acc.username, hint: 'Ouvrir la fiche', ref: { kind: 'open', account: acc } });
      for (const a of forAccount) {
        accounts.push({
          key: a.id + ':' + acc.id, label: a.label + ' ' + acc.username, hint: a.hint || '',
          ref: { kind: 'action', action: a, target: acc },
        });
      }
    }
    const sections = d.sections.map((s) => ({ key: 'sec:' + s.id, label: s.label, hint: s.group || '', ref: { kind: 'section', id: s.id } }));
    const typed = foldText(st.query) !== '';
    const actions = [];
    const actionEntry = (a) => ({ key: 'act:' + a.id, label: a.label, hint: a.hint || '', ref: { kind: 'action', action: a } });
    for (const a of d.actions) {
      if (a.forAccount) continue;
      const c = children.get(a.id);
      if (typed && typeof a.children === 'function' && c && c.status === 'ready' && c.list.length) {
        for (const sub of c.list) actions.push(actionEntry(sub));
        continue;
      }
      actions.push(actionEntry(a));
    }
    return { accounts, sections, actions };
  }

  function render() {
    if (!open) return;
    const groups = buildPaletteGroups(st.query, computeParts());
    list.replaceChildren();
    rows = [];
    groups.forEach((g, gi) => {
      const titleId = uid + '-g' + gi;
      const wrap = el('div', { role: 'group', 'aria-labelledby': titleId });
      wrap.append(el('div', { class: 'adm-pal-group-title', id: titleId }, g.title));
      for (const entry of g.entries) {
        const i = rows.length;
        const node = el('div', { class: 'adm-pal-item', role: 'option', id: uid + '-o' + i, 'aria-selected': 'false' });
        node.append(el('span', { class: 'adm-pal-label' }, entry.label));
        if (entry.hint) node.append(el('span', { class: 'adm-pal-hint' }, entry.hint));
        node.addEventListener('mousedown', (e) => e.preventDefault());
        node.addEventListener('mousemove', () => { if (st.active !== i) setActive(i); });
        node.addEventListener('click', () => runRow(i));
        rows.push({ el: node, entry });
        wrap.append(node);
      }
      list.append(wrap);
    });
    if (st.active >= rows.length) st.active = 0;
    setActive(st.active);
    let msg = '';
    if (!rows.length) {
      if (st.searching) msg = 'Recherche…';
      else if (st.accountsError) msg = st.accountsError;
      else msg = foldText(st.query) === '' ? 'Aucune commande disponible.' : 'Aucun résultat pour « ' + st.query.trim() + ' ».';
    }
    empty.textContent = msg;
    empty.hidden = !msg;
    list.setAttribute('aria-busy', st.searching ? 'true' : 'false');
  }

  function ensureChildren() {
    for (const a of d.actions) {
      if (typeof a.children !== 'function' || children.has(a.id)) continue;
      children.set(a.id, { status: 'loading', list: [] });
      let p;
      try { p = Promise.resolve(a.children()); } catch (err) { p = Promise.reject(err); }
      p.then(
        (list) => children.set(a.id, { status: 'ready', list: Array.isArray(list) ? list : [] }),
        () => children.set(a.id, { status: 'error', list: [] }),
      ).then(() => { if (open) render(); });
    }
  }

  function runSearch(q) {
    const id = ++searchId;
    st.searching = true;
    render();
    let p;
    try { p = Promise.resolve(d.searchAccounts(q)); } catch (err) { p = Promise.reject(err); }
    p.then(
      (found) => { if (id === searchId && open) { st.accounts = Array.isArray(found) ? found : []; st.accountsError = ''; } },
      () => { if (id === searchId && open) { st.accounts = []; st.accountsError = 'Recherche de comptes impossible.'; } },
    ).then(() => {
      if (id === searchId && open) { st.searching = false; render(); }
    });
  }

  function onInput() {
    st.query = input.value;
    st.active = 0;
    clearTimeout(timer);
    if (foldText(st.query) === '') {
      searchId += 1;
      st.accounts = [];
      st.accountsError = '';
      st.searching = false;
      render();
      return;
    }
    ensureChildren();
    st.searching = true;
    render();
    const q = st.query.trim();
    timer = setTimeout(() => runSearch(q), PALETTE_SEARCH_DEBOUNCE_MS);
  }

  async function runAction(action, target) {
    if (typeof action.run !== 'function') {
      say(action.pick || 'Action indisponible pour le moment.');
      return;
    }
    try {
      if (action.sensitive) {
        const spec = typeof action.confirm === 'function'
          ? action.confirm(target)
          : { title: action.label, message: esc(action.label) + ' ?', confirmLabel: action.label, danger: true };
        if (!(await d.confirm(spec))) return;
        if (action.elevated && !d.hasElevation()) await d.elevate();
      }
      await action.run(target);
      if (action.done !== '') say(action.done || 'Action effectuée.');
    } catch (err) {
      say(messageOf(err));
    }
  }

  function dispatch(ref) {
    if (ref.kind === 'open') { d.openAccount(ref.account.id); return; }
    if (ref.kind === 'section') { d.go(ref.id); return; }
    void runAction(ref.action, ref.target);
  }

  function runRow(i) {
    const row = rows[i];
    if (!row) return;
    const ref = row.entry.ref;
    close();
    dispatch(ref);
  }

  function onKey(e) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(moveActive(st.active, rows.length, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runRow(st.active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      // Le champ est le seul élément focusable de la palette : le focus y reste.
      e.preventDefault();
      input.focus({ preventScroll: true });
    }
  }

  function trap(e) {
    if (open && !layer.contains(e.target)) input.focus({ preventScroll: true });
  }

  function close() {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    document.removeEventListener('focusin', trap, true);
    layer.remove();
    if (addedModal && !document.querySelector('.adm-layer')) document.body.classList.remove('modal-open');
    if (current && current.id === uid) current = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  }

  input.addEventListener('input', onInput);
  dialog.addEventListener('keydown', onKey);
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
  document.addEventListener('focusin', trap, true);
  if (addedModal) document.body.classList.add('modal-open');

  document.body.append(layer);
  render();
  input.focus({ preventScroll: true });
  current = { id: uid, focus: () => input.focus({ preventScroll: true }), handle: { close } };
  return current.handle;
}

/** Ferme la palette si elle est ouverte. */
export function closePalette() {
  if (current) current.handle.close();
}

/**
 * Pose le raccourci global (Ctrl/Cmd+K, « / » hors champ) qui appelle `openFn`. `canOpen()` (facultatif) dit si la palette
 * peut s'ouvrir maintenant ; sinon la touche n'est pas interceptée. Renvoie la fonction qui retire l'écouteur.
 */
export function installPaletteShortcuts(openFn, canOpen = () => true) {
  const onKeyDown = (e) => {
    const inField = isEditable(e.target) || isEditable(document.activeElement);
    if (!isPaletteShortcut(e, inField) || !canOpen()) return;
    e.preventDefault();
    openFn();
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
