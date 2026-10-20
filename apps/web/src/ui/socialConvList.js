/* Discussions Social v3 (lot F3) : liste des conversations (onglet Messages de la barre latérale) : recherche, groupes,
 * non-lus, saisie en cours, sondage ouvert sous la conversation, création de groupe. `renderConversationList(el)` renvoie
 * sa fonction de nettoyage (abonnement au store, minuteur). Tout texte passe par textContent. */
import * as store from '../data/socialStore';
import { openConversation } from './socialHooks.js';
import { openDialog } from './socialConvDialog.js';
import { SVG, avatarEl, h, iconBtn } from './socialConvDom.js';
import {
  GROUP_MEMBERS_MAX, GROUP_MEMBERS_MIN, GROUP_NAME_MAX, convInfo, dmConv, fold, getActiveConv, listTime, onActiveConv, personName, pollShare,
  pollTotal, previewOf, typingText,
} from './socialConvModel.js';
import { groupErrorMessage } from './socialChat.js';

/** Boîte « Nouveau groupe » : nom (≤ 40) et 2 à 19 amis. Ouvre le groupe créé. */
export function openGroupDialog(opener, toast) {
  let nameEl = null;
  const picked = new Set();
  openDialog({
    title: 'Nouveau groupe', confirmLabel: 'Créer le groupe', opener,
    build(body, ctl) {
      nameEl = h('input', 'cvd-input', null, { type: 'text', maxlength: GROUP_NAME_MAX, placeholder: 'Nom du groupe (ex. Ciné du dimanche)', 'aria-label': 'Nom du groupe' });
      body.append(nameEl);
      const hint = h('p', 'cvd-hint', '');
      const list = h('div', 'cvd-people', null, { role: 'group', 'aria-label': 'Amis à ajouter' });
      const s = store.getState();
      const people = [...s.friends, ...s.household];
      const check = () => {
        const n = picked.size;
        hint.textContent = n + ' ami' + (n > 1 ? 's' : '') + ' choisi' + (n > 1 ? 's' : '') + ' (de ' + GROUP_MEMBERS_MIN + ' à ' + GROUP_MEMBERS_MAX + ')';
        ctl.setValid(nameEl.value.trim() !== '' && n >= GROUP_MEMBERS_MIN && n <= GROUP_MEMBERS_MAX);
      };
      if (!people.length) list.append(h('p', 'cvd-hint', 'Ajoute d’abord des amis pour créer un groupe.'));
      for (const f of people) {
        const label = h('label', 'cvd-person');
        const cb = h('input', null, null, { type: 'checkbox' });
        cb.addEventListener('change', () => {
          if (cb.checked) picked.add(f.pid);
          else picked.delete(f.pid);
          check();
        });
        label.append(cb, avatarEl({ name: f.handle.name, avatarColor: f.avatarColor, avatar: f.avatar }, 28), h('span', null, f.nickname || f.handle.name));
        list.append(label);
      }
      body.append(list, hint);
      nameEl.addEventListener('input', check);
      check();
    },
    onConfirm: async () => {
      let conv;
      try { conv = await store.createGroup(nameEl.value.trim(), [...picked]); } catch (e) {
        throw new Error(groupErrorMessage(e, (pid) => personName(pid, store.getState())));
      }
      if (toast) toast('Groupe créé.');
      openConversation(conv.conv);
    },
  });
}

/** Avatar de ligne : un avatar pour un ami, deux avatars superposés pour un groupe. */
function rowAvatar(inf) {
  if (inf.kind === 'dm') return avatarEl({ name: inf.name, avatarColor: inf.avatarColor, avatar: inf.avatar }, 42, inf.known ? inf.status : '');
  const wrap = h('span', 'cv-stack is-list', null, { 'aria-hidden': 'true' });
  inf.members.slice(0, 2).forEach((m, i) => {
    const a = avatarEl({ name: m.handle.name, avatarColor: m.avatarColor, avatar: m.avatar }, 28);
    a.classList.add(i === 0 ? 'is-a' : 'is-b');
    wrap.append(a);
  });
  if (!inf.members.length) wrap.append(avatarEl({ name: inf.name }, 28));
  return wrap;
}

function miniPoll(poll) {
  const box = h('div', 'cvl-poll', null, { role: 'group', 'aria-label': 'Sondage : ' + poll.question });
  box.append(h('div', 'cvl-poll-q', 'Sondage · ' + poll.question));
  for (const o of poll.options.slice(0, 3)) {
    const row = h('div', 'cvl-poll-o');
    const bar = h('span', 'cvl-poll-bar');
    bar.style.width = pollShare(poll, o) + '%';
    row.append(bar, h('span', 'cvl-poll-l', o.label), h('b', null, String(o.votes)));
    box.append(row);
  }
  if (pollTotal(poll) === 0) box.append(h('div', 'cvl-poll-hint', 'Aucun vote pour l’instant'));
  return box;
}

/**
 * @param {HTMLElement} el conteneur de l'onglet
 * @param {{ toast?: (m: string) => void }} [deps]
 * @returns {() => void}
 */
export function renderConversationList(el, deps = {}) {
  el.textContent = '';
  const wrap = h('div', 'cvl');
  const bar = h('div', 'cvl-bar');
  const search = h('input', 'cvl-search', null, { type: 'search', placeholder: 'Rechercher une discussion', 'aria-label': 'Rechercher une discussion', autocomplete: 'off' });
  const addBtn = iconBtn('cvl-add', 'Nouveau groupe', SVG.plus, () => openGroupDialog(addBtn, deps.toast));
  bar.append(search, addBtn);
  const list = h('ul', 'cvl-list', null, { 'aria-label': 'Discussions' });
  wrap.append(bar, list);
  el.append(wrap);

  let alive = true;
  let query = '';
  let timer = null;
  let sig = '';

  function entries(s) {
    const out = [];
    for (const c of s.conversations) { const inf = convInfo(dmConv(c.pid), s); if (inf) out.push(inf); }
    for (const g of s.groups) { const inf = convInfo(g.conv, s); if (inf) out.push(inf); }
    out.sort((a, b) => (b.last ? b.last.createdAt : 0) - (a.last ? a.last.createdAt : 0));
    return out;
  }

  function item(inf, s) {
    const li = h('li', 'cvl-item');
    const typing = store.typingPids(s, inf.conv).filter((p) => !s.me || p !== s.me.pid);
    const unread = inf.unread > 0;
    const b = h('button', 'cvl-row' + (getActiveConv() === inf.conv ? ' is-active' : ''), null, { type: 'button' });
    b.setAttribute('aria-label', inf.name + (unread ? ', ' + inf.unread + ' message' + (inf.unread > 1 ? 's' : '') + ' non lu' + (inf.unread > 1 ? 's' : '') : ''));
    b.append(rowAvatar(inf));
    const mid = h('div', 'cvl-mid');
    const top = h('div', 'cvl-top');
    const name = h('b', 'cvl-name', inf.name);
    if (inf.household) name.append(h('span', 'cvl-home', ' · foyer'));
    top.append(name, h('span', 'cvl-time' + (unread ? ' is-unread' : ''), inf.last ? listTime(inf.last.createdAt) : ''));
    const names = typing.map((p) => (inf.kind === 'group' ? (inf.members.find((m) => m.pid === p) || { handle: { name: 'Quelqu’un' } }).handle.name : inf.name));
    const prev = h('div', 'cvl-prev' + (unread ? ' is-unread' : '') + (typing.length ? ' is-typing' : ''), typing.length ? typingText(names) : previewOf(inf, s));
    mid.append(top, prev);
    b.append(mid);
    if (unread) b.append(h('span', 'cvl-dot', null, { 'aria-hidden': 'true' }));
    b.addEventListener('click', () => openConversation(inf.conv));
    li.append(b);
    if (inf.kind === 'group' && inf.last && inf.last.kind === 'poll' && inf.last.poll && !inf.last.poll.closed) li.append(miniPoll(inf.last.poll));
    return li;
  }

  function paint(s = store.getState(), force = false) {
    if (!alive) return;
    const q = fold(query.trim());
    const all = entries(s);
    const shown = q ? all.filter((i) => fold(i.name).includes(q)) : all;
    // Recherche : les amis sans discussion proposent d'en commencer une.
    const fresh = q
      ? [...s.friends, ...s.household].filter((f) => !all.some((i) => i.conv === dmConv(f.pid)) && fold(f.nickname || f.handle.name).includes(q))
      : [];
    const next = [q, getActiveConv(), ...shown.map((i) => [i.conv, i.name, i.unread, i.last && i.last.id, i.last && i.last.poll ? JSON.stringify(i.last.poll.options.map((o) => o.votes)) : '', store.typingPids(s, i.conv).join(','), i.status, i.avatarColor].join('~')), ...fresh.map((f) => f.pid)].join('|');
    if (!force && next === sig) return;
    sig = next;
    list.textContent = '';
    for (const inf of shown) list.append(item(inf, s));
    for (const f of fresh) {
      const li = h('li', 'cvl-item');
      const b = h('button', 'cvl-row', null, { type: 'button' });
      b.append(avatarEl({ name: f.nickname || f.handle.name, avatarColor: f.avatarColor, avatar: f.avatar }, 42, f.status));
      const mid = h('div', 'cvl-mid');
      mid.append(h('b', 'cvl-name', f.nickname || f.handle.name), h('div', 'cvl-prev', 'Nouvelle discussion'));
      b.append(mid);
      b.addEventListener('click', () => openConversation(dmConv(f.pid)));
      li.append(b);
      list.append(li);
    }
    if (!shown.length && !fresh.length) {
      list.append(h('li', 'cvl-empty', q ? 'Aucune discussion ne correspond.' : 'Aucune discussion pour l’instant. Choisis un ami dans l’onglet Amis pour lui écrire.'));
    }
  }

  search.addEventListener('input', () => { query = search.value; paint(store.getState(), true); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; query = ''; paint(store.getState(), true); }
  });
  const unsub = store.subscribe((s) => paint(s));
  const unActive = onActiveConv(() => paint(store.getState()));
  // La saisie expire sans événement du store : un contrôle léger la retire.
  timer = setInterval(() => paint(store.getState()), 2000);
  paint(store.getState(), true);

  return () => {
    alive = false;
    unsub();
    unActive();
    if (timer) clearInterval(timer);
    el.textContent = '';
  };
}
