/* Social v3 (lot F4) : page d'une liste partagée (#/list/<id>) : nom, membres, titres ajoutés (qui, quand), ouverture de la
 * fiche, retrait d'un titre, renommage, ajout d'amis, sortie de la liste. Tout texte du serveur passe par textContent. */
import * as store from '../data/socialStore';
import { isKidProfile, isServerMode } from '../data/auth';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { avatarEl, h, posterSrc } from './socialConvDom.js';
import { openDialog } from './socialConvDialog.js';
import { dayLabel } from './socialConvModel.js';
import * as M from './shareModel.js';

let unsub = null;
let listId = '';

function unavailable() {
  return topBar(false) + '<article class="svc-page soc-page"><div class="soc-body"><p class="row-msg"></p></div></article>';
}

const errText = (e) => {
  if (e && e.status === 404) return 'Cette liste n’existe pas ou tu n’en fais plus partie.';
  if (e && e.status === 403) return 'Seul le créateur de la liste peut faire ça.';
  if (e && (e.status === 0 || e.code === 'network')) return 'Serveur injoignable pour le moment.';
  return 'Action impossible pour le moment.';
};

function itemCard(it, d, mePid) {
  const card = h('li', 'sl-item');
  const a = h('a', 'sl-poster', null, { href: M.ficheHash(it.type, it.tmdbId), 'data-go': '', 'aria-label': 'Ouvrir la fiche : ' + it.title });
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
  body.append(h('div', 'sl-item-m', (it.type === 'series' ? 'Série' : 'Film') + ' · ajouté par ' + M.adderName(it.addedBy, d, mePid) + ' · ' + dayLabel(it.addedAt)));
  const rm = h('button', 'btn btn-ghost btn-sm', 'Retirer', { type: 'button', 'aria-label': 'Retirer ' + it.title + ' de la liste' });
  rm.addEventListener('click', async () => {
    rm.disabled = true;
    try { await store.removeFromList(d.id, it.type, it.tmdbId); toast('Titre retiré de la liste'); } catch (e) { rm.disabled = false; toast(errText(e)); }
  });
  body.append(rm);
  card.append(a, body);
  return card;
}

function renameDialog(d, opener) {
  let inp;
  openDialog({
    title: 'Renommer la liste', confirmLabel: 'Renommer', opener,
    build(body, ctl) {
      inp = h('input', 'cvd-input', null, { type: 'text', maxlength: M.LIST_NAME_MAX, value: d.name, 'aria-label': 'Nom de la liste' });
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
    title: 'Ajouter des amis à la liste', confirmLabel: 'Ajouter', opener,
    build(body, ctl) {
      if (!candidates.length) { body.append(h('p', 'cvd-hint', 'Tous tes amis sont déjà dans cette liste.')); return; }
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
      try { await store.updateList(d.id, { add: [...picked] }); } catch (e) { throw new Error(e && e.code === 'too_many_members' ? 'La liste a atteint son nombre maximal de membres.' : errText(e)); }
    },
  });
}

function paint(root, d) {
  const mePid = store.getState().me ? store.getState().me.pid : '';
  root.textContent = '';
  const head = h('header', 'svc-head svc-head-plain');
  const t = h('div', 'svc-head-t');
  t.append(h('p', 'svc-eyebrow', 'Liste partagée'));
  const h1 = h('h1', 'svc-title', d.name, { id: 'svc-title', tabindex: '-1' });
  t.append(h1);
  const mem = h('ul', 'sl-members', null, { 'aria-label': 'Membres de la liste' });
  for (const m of d.members || []) {
    const li = h('li', 'sl-member');
    li.append(avatarEl({ name: m.nickname || m.handle.name, avatarColor: m.avatarColor, avatar: m.avatar }, 28), h('span', null, m.pid === mePid ? 'Toi' : m.nickname || m.handle.name));
    mem.append(li);
  }
  t.append(mem);
  const acts = h('div', 'sl-acts');
  const ren = h('button', 'btn btn-ghost btn-sm', 'Renommer', { type: 'button' });
  ren.addEventListener('click', () => renameDialog(d, ren));
  const add = h('button', 'btn btn-ghost btn-sm', 'Ajouter des amis', { type: 'button' });
  add.addEventListener('click', () => addMembersDialog(d, add));
  const leave = h('button', 'btn btn-ghost btn-sm', 'Quitter la liste', { type: 'button' });
  leave.addEventListener('click', async () => {
    if (!mePid) return;
    leave.disabled = true;
    try { await store.updateList(d.id, { remove: [mePid] }); toast('Tu as quitté la liste'); location.hash = '#/'; } catch (e) { leave.disabled = false; toast(errText(e)); }
  });
  acts.append(ren, add, leave);
  t.append(acts);
  head.append(t);
  root.append(head);
  if (!d.items || !d.items.length) {
    root.append(h('p', 'row-msg', 'Aucun titre pour l’instant. Ajoute-en depuis la fenêtre « Partager » d’une fiche.'));
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
  document.title = d.name + ' · Laststream';
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
  document.title = 'Liste partagée · Laststream';
  if (!isServerMode() || isKidProfile()) {
    detailEl.innerHTML = unavailable();
    detailEl.querySelector('.row-msg').textContent = isKidProfile() ? 'Cette page n’est pas disponible sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour utiliser les listes partagées.';
    return;
  }
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page soc-page sl-page" aria-labelledby="svc-title"><div id="sl-body" data-nav><p class="row-msg" role="status">Chargement de la liste…</p></div></article>';
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
