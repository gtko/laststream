/* Social v3 (lot F4) : page d'une liste partagée (#/list/<id>) : nom, membres, titres ajoutés (qui, quand), ouverture de la
 * fiche, retrait d'un titre, renommage, ajout d'amis, sortie de la liste. Tout texte du serveur passe par textContent. */
import '../styles/share.css';
import * as store from '../data/socialStore';
import { isKidProfile, isServerMode } from '../data/auth';
import { detailEl, toast, toastError } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { avatarEl, h, posterSrc } from './socialConvDom.js';
import { openDialog } from './socialConvDialog.js';
import { dayLabel } from './socialConvModel.js';
import * as M from './shareModel.js';
import { t as tr } from '../i18n';

let unsub = null;
let listId = '';

function unavailable() {
  return topBar(false) + '<article class="svc-page soc-page"><div class="soc-body"><p class="row-msg"></p></div></article>';
}

const errText = (e) => {
  if (e && e.status === 404) return tr('Cette liste n’existe pas ou tu n’en fais plus partie.');
  if (e && e.status === 403) return tr('Seul le créateur de la liste peut faire ça.');
  if (e && (e.status === 0 || e.code === 'network')) return tr('Serveur injoignable pour le moment.');
  return tr('Action impossible pour le moment.');
};

function itemCard(it, d, mePid) {
  const card = h('li', 'sl-item');
  const a = h('a', 'sl-poster', null, { href: M.ficheHash(it.type, it.tmdbId), 'data-go': '', 'aria-label': tr('Ouvrir la fiche : {title}', { title: it.title }) });
  const src = posterSrc(it.poster);
  if (src) {
    const img = h('img', null, null, { alt: '', loading: 'lazy' });
    img.src = src;
    img.addEventListener('error', () => { img.remove(); a.textContent = it.title; });
    a.append(img);
  } else {
    a.textContent = it.title;
  }
  const body = h('div', 'sl-item-b');
  body.append(h('div', 'sl-item-t', it.title));
  body.append(h('div', 'sl-item-m', (it.type === 'series' ? tr('Série') : tr('Film')) + ' ' + tr('· ajouté par {addedBy} · {addedAt}', { addedBy: M.adderName(it.addedBy, d, mePid), addedAt: dayLabel(it.addedAt) })));
  const rm = h('button', 'btn btn-ghost btn-sm', tr('Retirer'), { type: 'button', 'aria-label': tr('Retirer {title} de la liste', { title: it.title }) });
  rm.addEventListener('click', async () => {
    rm.disabled = true;
    try { await store.removeFromList(d.id, it.type, it.tmdbId); toast(tr('Titre retiré de la liste')); } catch (e) { rm.disabled = false; toastError(errText(e), e, 'listes'); }
  });
  body.append(rm);
  card.append(a, body);
  return card;
}

function renameDialog(d, opener) {
  let inp;
  openDialog({
    title: tr('Renommer la liste'), confirmLabel: tr('Renommer'), opener,
    build(body, ctl) {
      inp = h('input', 'cvd-input', null, { type: 'text', maxlength: M.LIST_NAME_MAX, value: d.name, 'aria-label': tr('Nom de la liste') });
      inp.addEventListener('input', () => ctl.setValid(inp.value.trim().length > 0 && inp.value.trim() !== d.name));
      body.append(inp);
    },
    async onConfirm() {
      try { await store.updateList(d.id, { name: inp.value.trim() }); } catch (e) { throw new Error(errText(e)); }
    },
  });
}

function addMembersDialog(d, opener) {
  const st = store.getState();
  const inList = new Set((d.members || []).map((m) => m.pid));
  const candidates = [...st.friends, ...st.household].filter((f, i, all) => !inList.has(f.pid) && all.findIndex((x) => x.pid === f.pid) === i);
  const picked = new Set();
  openDialog({
    title: tr('Ajouter des amis à la liste'), confirmLabel: tr('Ajouter'), opener,
    build(body, ctl) {
      if (!candidates.length) { body.append(h('p', 'cvd-hint', tr('Tous tes amis sont déjà dans cette liste.'))); return; }
      const people = h('div', 'cvd-people');
      for (const f of candidates) {
        const lab = h('label', 'cvd-person');
        const cb = h('input', null, null, { type: 'checkbox' });
        cb.addEventListener('change', () => { if (cb.checked) picked.add(f.pid); else picked.delete(f.pid); ctl.setValid(picked.size > 0); });
        lab.append(cb, avatarEl({ name: f.handle.name, avatarColor: f.avatarColor, avatar: f.avatar }, 28), h('span', null, f.nickname || f.handle.name));
        people.append(lab);
      }
      body.append(people);
    },
    async onConfirm() {
      try { await store.updateList(d.id, { add: [...picked] }); } catch (e) { throw new Error(e && e.code === 'too_many_members' ? tr('La liste a atteint son nombre maximal de membres.') : errText(e)); }
    },
  });
}

function paint(root, d) {
  const mePid = store.getState().me ? store.getState().me.pid : '';
  root.textContent = '';
  const head = h('header', 'svc-head svc-head-plain');
  const t = h('div', 'svc-head-t');
  t.append(h('p', 'svc-eyebrow', tr('Liste partagée')));
  const h1 = h('h1', 'svc-title', d.name, { id: 'svc-title', tabindex: '-1' });
  t.append(h1);
  const mem = h('ul', 'sl-members', null, { 'aria-label': tr('Membres de la liste') });
  for (const m of d.members || []) {
    const li = h('li', 'sl-member');
    li.append(avatarEl({ name: m.nickname || m.handle.name, avatarColor: m.avatarColor, avatar: m.avatar }, 28), h('span', null, m.pid === mePid ? tr('Toi') : m.nickname || m.handle.name));
    mem.append(li);
  }
  t.append(mem);
  const acts = h('div', 'sl-acts');
  const ren = h('button', 'btn btn-ghost btn-sm', tr('Renommer'), { type: 'button' });
  ren.addEventListener('click', () => renameDialog(d, ren));
  const add = h('button', 'btn btn-ghost btn-sm', tr('Ajouter des amis'), { type: 'button' });
  add.addEventListener('click', () => addMembersDialog(d, add));
  const leave = h('button', 'btn btn-ghost btn-sm', tr('Quitter la liste'), { type: 'button' });
  leave.addEventListener('click', async () => {
    if (!mePid) return;
    leave.disabled = true;
    try { await store.updateList(d.id, { remove: [mePid] }); toast(tr('Tu as quitté la liste')); location.hash = '#/'; } catch (e) { leave.disabled = false; toastError(errText(e), e, 'listes'); }
  });
  acts.append(ren, add, leave);
  t.append(acts);
  head.append(t);
  root.append(head);
  if (!d.items || !d.items.length) {
    root.append(h('p', 'row-msg', tr('Aucun titre pour l’instant. Ajoute-en depuis la fenêtre « Partager » d’une fiche.')));
    return;
  }
  const ul = h('ul', 'sl-items');
  for (const it of d.items) ul.append(itemCard(it, d, mePid));
  root.append(ul);
}

function repaint() {
  const root = detailEl.querySelector('#sl-body');
  const d = store.getState().listDetails[listId];
  if (!root || !d) return;
  const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.textContent : '';
  paint(root, d);
  document.title = tr('{name} · Laststream', { name: d.name });
  if (focused) {
    const again = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === focused);
    if (again) again.focus();
  }
}

export function showSharedList(id) {
  teardownFiche();
  if (unsub) { unsub(); unsub = null; }
  state.kind = 'list';
  listId = id;
  document.title = tr('Liste partagée · Laststream');
  if (!isServerMode() || isKidProfile()) {
    detailEl.innerHTML = unavailable();
    detailEl.querySelector('.row-msg').textContent = isKidProfile() ? tr('Cette page n’est pas disponible sur un profil enfant.') : tr('Connecte-toi à un compte Laststream pour utiliser les listes partagées.');
    return;
  }
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page soc-page sl-page" aria-labelledby="svc-title"><div id="sl-body" data-nav><p class="row-msg" role="status">' + tr('Chargement de la liste…') + '</p></div></article>';
  unsub = store.subscribe(() => {
    if (state.kind !== 'list' || listId !== id) { if (unsub) { unsub(); unsub = null; } return; }
    repaint();
  });
  Promise.resolve(store.getState().me ? undefined : store.refresh().catch(() => undefined))
    .then(() => store.loadList(id))
    .then(() => {
      repaint();
      const h1 = detailEl.querySelector('#svc-title');
      if (h1) h1.focus({ preventScroll: true });
    })
    .catch((e) => {
      const root = detailEl.querySelector('#sl-body');
      if (root && state.kind === 'list') { root.textContent = ''; root.append(h('p', 'row-msg', errText(e), { role: 'alert' })); }
    });
}
