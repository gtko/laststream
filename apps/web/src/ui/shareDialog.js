/* Social v3 (lot F4) : fenêtre « Partager » (maquette Partage / MobilePartage). Bureau : boîte centrée de 760 px, amis et groupes
 * à gauche, « Hors de Laststream » à droite. Mobile (< 768 px) : panneau du bas. Le module enregistre openShareDialog dans
 * socialHooks ; main.js appelle configureShareDialog({ toast }). Tout texte venant du serveur passe par textContent. */
import { Capacitor } from '@capacitor/core';
import * as store from '../data/socialStore';
import { createShareLink } from '../data/socialV3Api';
import { getInvites } from '../data/socialApi';
import { tmdb } from '../data/lt';
import { registerSocialHook, inviteToParty } from './socialHooks.js';
import { socialAvailable } from './socialButton.js';
import { avatarEl, h, iconBtn, posterSrc, SVG } from './socialConvDom.js';
import { openDialog } from './socialConvDialog.js';
import { MOBILE_MAX } from './socialConvModel.js';
import { sendErrorMessage } from './socialChat.js';
import { qrSvg } from './qrcode.js';
import * as M from './shareModel.js';

let toastFn = () => undefined;
/** Branche le message bref de l'application. À appeler une fois depuis main.js. */
export function configureShareDialog(d) { if (d && typeof d.toast === 'function') toastFn = d.toast; }

const svg = (inner, size = 16, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" aria-hidden="true">${inner}</svg>`;
export const ICO = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>', 10, 3.5),
  party: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m10 9 4 2-4 2z" fill="currentColor"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 20),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>', 22),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', 22),
  qr: svg('<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>', 22),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>', 22),
  shareS: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>', 20),
  list: svg('<path d="M6 3h12v18l-6-4-6 4z"/>', 20),
  partyL: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m10 9 4 2-4 2z" fill="currentColor"/>', 20),
};

/** Copie dans le presse-papiers ; false si le navigateur refuse. */
export async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* repli ci-dessous */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

/**
 * Partage du système : plugin Capacitor Share s'il est présent (Android), sinon navigator.share, sinon copie du lien.
 * Renvoie 'native' | 'web' | 'copied' | 'cancelled' | 'failed'.
 */
export async function nativeShare({ title, text, url }) {
  const plug = Capacitor && Capacitor.Plugins ? Capacitor.Plugins.Share : null;
  if (plug && typeof plug.share === 'function') {
    try { await plug.share({ title, text, url, dialogTitle: 'Partager' }); return 'native'; } catch (e) {
      if (e && /cancel|abort/i.test(String(e.message || e.name || ''))) return 'cancelled';
    }
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try { await navigator.share({ title, text, url }); return 'web'; } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}

const openExternal = (href) => {
  const a = h('a', null, null, { href, rel: 'noopener' });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
};

const isMobile = () => typeof window !== 'undefined' && (window.matchMedia ? window.matchMedia('(max-width: ' + MOBILE_MAX + 'px)').matches : window.innerWidth <= MOBILE_MAX);

function linkErrorText(e) {
  if (e && e.status === 429) return 'Trop de liens créés d’un coup : réessaie dans une minute.';
  if (e && (e.status === 0 || e.code === 'network')) return 'Serveur injoignable pour le moment.';
  return 'Impossible de créer le lien pour le moment.';
}

let current = null;
/** Ferme la fenêtre ouverte, s'il y en a une. */
export function closeShareDialog() { if (current) current.close(); }

/**
 * Hook `openShareDialog`. opts = { media: {type, tmdbId, title, poster?, season?, episode?} | null, pos?: number,
 * to?: string[] (pids présélectionnés), conv?: string ("dm:<pid>" ou "g:<id>" présélectionné) }.
 * Sans média, un sélecteur de titre s'affiche d'abord.
 */
export function openShareDialog(opts) {
  if (!socialAvailable()) return null;
  closeShareDialog();
  const o = opts || {};
  const mobile = isMobile();
  const opener = typeof document !== 'undefined' ? document.activeElement : null;
  const st = {
    media: M.normalizeMedia(o.media), pos: typeof o.pos === 'number' && o.pos >= 0 ? Math.floor(o.pos) : undefined,
    mode: 'title', keys: [], q: '', body: '', withInvite: true, invitesLeft: null, link: null, linkKey: '', qr: false, busy: false,
    lists: store.getState().lists || [], added: new Set(), preDone: false, view: 'main',
  };
  st.mode = M.canShareMoment(st.media, st.pos) ? 'moment' : 'title';
  const ui = {};
  let alive = true;

  const veil = h('div', 'shd-veil' + (mobile ? ' is-sheet' : ''));
  const box = h('div', 'shd' + (mobile ? ' is-sheet' : ''), null, { role: 'dialog', 'aria-modal': 'true' });
  veil.append(box);
  document.body.append(veil);
  document.body.classList.add('shd-open');

  const targets = () => M.buildTargets(store.getState());
  const mePid = () => { const me = store.getState().me; return me ? me.pid : ''; };
  const say = (msg, tone) => { if (ui.status) { ui.status.textContent = msg || ''; ui.status.dataset.tone = tone || ''; } };

  // ---------- Fermeture, clavier ----------
  function close() {
    if (!alive) return;
    alive = false;
    unsub();
    veil.remove();
    document.body.classList.remove('shd-open');
    document.removeEventListener('keydown', onKey, true);
    if (current === api) current = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  }
  function onKey(e) {
    if (!alive || document.querySelector('.cvd-veil')) return; // une boîte de dialogue ouverte par-dessus garde le clavier
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = Array.from(box.querySelectorAll('button, input, textarea, select, [tabindex]')).filter((x) => !x.disabled && x.tabIndex >= 0 && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  const api = { close, el: box, state: st };
  current = api;

  // ---------- Données ----------
  const unsub = store.subscribe(() => {
    if (!alive) return;
    applyPreselect();
    if (st.view === 'main') { paintGrid(); paintSend(); paintLists(); }
  });
  function applyPreselect() {
    if (st.preDone) return;
    const t = targets();
    if (!t.length) return;
    st.preDone = true;
    st.keys = M.preselect(t, o.to, o.conv);
  }
  if (!store.getState().me) Promise.resolve().then(() => store.refresh()).catch(() => undefined);
  applyPreselect();
  Promise.resolve().then(() => store.loadLists()).then((l) => { st.lists = l; paintLists(); }).catch(() => undefined);
  Promise.resolve().then(() => getInvites()).then((d) => { st.invitesLeft = M.freeInvites(d); if (st.invitesLeft === 0) st.withInvite = false; paintInvite(); }).catch(() => undefined);

  // ---------- Éléments partagés ----------
  function poster(w, hgt) {
    const wrap = h('div', 'shd-poster');
    wrap.style.width = w + 'px';
    wrap.style.height = hgt + 'px';
    const url = posterSrc(st.media && st.media.poster);
    if (url) {
      const img = h('img', null, null, { alt: '', loading: 'lazy' });
      img.src = url;
      img.addEventListener('error', () => { img.remove(); wrap.textContent = (st.media.title || '').slice(0, 8); });
      wrap.append(img);
    } else {
      wrap.textContent = ((st.media && st.media.title) || '').slice(0, 8);
    }
    return wrap;
  }

  function friendBtn(t, size) {
    const on = st.keys.includes(t.key);
    const b = h('button', 'shd-fr' + (on ? ' is-on' : ''), null, { type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-key': t.key });
    b.setAttribute('aria-label', (t.kind === 'group' ? 'Groupe ' : '') + t.name + (on ? ', choisi' : ''));
    const av = h('span', 'shd-avwrap');
    if (t.kind === 'group') {
      const g = h('span', 'shd-gr', Array.from(t.name).slice(0, 4).join('').toUpperCase(), { 'aria-hidden': 'true' });
      g.style.width = g.style.height = size + 'px';
      av.append(g);
    } else {
      av.append(avatarEl({ name: t.name, avatarColor: t.avatarColor, avatar: t.avatar }, size));
    }
    if (on) { const ck = h('span', 'shd-ck', null, { 'aria-hidden': 'true' }); ck.innerHTML = ICO.check; av.append(ck); }
    b.append(av, h('span', 'shd-fr-name', t.name));
    b.addEventListener('click', () => toggleKey(t.key));
    return b;
  }

  function toggleKey(key) {
    st.keys = st.keys.includes(key) ? st.keys.filter((k) => k !== key) : [...st.keys, key];
    paintGrid();
    paintSend();
    const again = ui.grid && ui.grid.querySelector('[data-key="' + key + '"]');
    if (again) again.focus();
  }

  function paintGrid() {
    if (!ui.grid) return;
    const all = targets();
    const list = M.filterTargets(all, st.q);
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : '';
    ui.grid.textContent = '';
    if (!all.length) ui.grid.append(h('p', 'shd-empty', 'Tu n’as pas encore d’ami. Ajoute-en depuis la barre des amis.'));
    else if (!list.length) ui.grid.append(h('p', 'shd-empty', 'Aucun ami ni groupe ne correspond.'));
    for (const t of list) ui.grid.append(friendBtn(t, mobile ? 56 : 52));
    if (focusKey) { const f = ui.grid.querySelector('[data-key="' + focusKey + '"]'); if (f) f.focus(); }
  }

  const canMoment = () => M.canShareMoment(st.media, st.pos);
  const subLine = () => {
    if (!st.media) return '';
    if (st.mode === 'moment') return 'Tu en es à ' + M.posLabel(st.pos);
    return st.media.type === 'series' ? 'Série' : 'Film';
  };

  function paintHeader() {
    if (!ui.titleEl) return;
    const t = st.media ? st.media.title : '';
    ui.titleEl.textContent = 'Partager ' + t;
    ui.sub.textContent = mobile ? (st.mode === 'moment' ? 'Ce moment · ' + M.posLabel(st.pos) : subLine()) : subLine();
    box.setAttribute('aria-label', 'Partager ' + t);
    box.removeAttribute('aria-labelledby');
  }

  function setMode(mode) {
    if (mode === 'moment' && !canMoment()) return;
    st.mode = mode;
    paintOpts();
    paintHeader();
    paintInvite();
  }

  function paintOpts() {
    if (!ui.opts) return;
    ui.opts.textContent = '';
    const mk = (id, title, hint, extra) => {
      const on = st.mode === id;
      const row = h('div', 'shd-opt' + (on ? ' is-on' : ''));
      const main = h('button', 'shd-opt-main', null, { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false' });
      main.append(h('span', 'shd-rd' + (on ? ' on' : ''), null, { 'aria-hidden': 'true' }), (() => {
        const c = h('span', 'shd-opt-txt');
        c.append(h('span', 'shd-opt-t', title), h('span', 'shd-opt-h', hint));
        return c;
      })());
      main.addEventListener('click', () => setMode(id));
      row.append(main);
      if (extra) row.append(extra);
      return row;
    };
    if (canMoment()) {
      const step = h('span', 'shd-step');
      const minus = h('button', 'shd-step-b', '−10 s', { type: 'button', 'aria-label': 'Reculer de 10 secondes' });
      const plus = h('button', 'shd-step-b', '+10 s', { type: 'button', 'aria-label': 'Avancer de 10 secondes' });
      const val = h('b', 'shd-step-v', M.posLabel(st.pos), { 'aria-live': 'polite' });
      minus.addEventListener('click', () => { st.pos = M.shiftPos(st.pos, -M.MOMENT_STEP); st.mode = 'moment'; paintOpts(); paintHeader(); focusStep(0); });
      plus.addEventListener('click', () => { st.pos = M.shiftPos(st.pos, M.MOMENT_STEP); st.mode = 'moment'; paintOpts(); paintHeader(); focusStep(1); });
      step.append(minus, ' · ', val, ' · ', plus);
      ui.opts.append(mk('moment', 'Ce moment précis', 'S’ouvre chez eux à ' + M.posLabel(st.pos), step));
    }
    ui.opts.append(mk('title', 'Le titre', canMoment() ? 'Depuis le début' : 'La fiche, avec ton conseil'));
    ui.opts.setAttribute('role', 'radiogroup');
    ui.opts.setAttribute('aria-label', 'Ce que tu partages');
  }
  function focusStep(i) { const b = ui.opts && ui.opts.querySelectorAll('.shd-step-b')[i]; if (b) b.focus(); }

  function paintSend() {
    const t = targets();
    const none = st.keys.length === 0;
    const label = M.sendLabel(t, st.keys);
    if (ui.send) { ui.send.textContent = mobile ? 'Envoyer' : label; ui.send.disabled = none || st.busy; ui.send.setAttribute('aria-label', label); }
    if (ui.party) ui.party.disabled = none;
    if (ui.partyRow) ui.partyRow.disabled = none;
  }

  // ---------- Actions ----------
  async function send() {
    if (st.busy || !st.keys.length) return;
    const input = M.buildShareInput({ keys: st.keys, media: st.media, mode: st.mode, pos: st.pos, body: st.body });
    if (!input) return;
    st.busy = true;
    paintSend();
    say('');
    try {
      await store.share(input);
      const n = st.keys.length;
      toastFn(n === 1 ? 'Envoyé' : 'Envoyé à ' + n + ' destinataires');
      close();
    } catch (e) {
      st.busy = false;
      paintSend();
      say(sendErrorMessage(e), 'error');
    }
  }

  function startParty() {
    const pids = M.friendPids(targets(), st.keys, mePid());
    if (!pids.length) return;
    pids.forEach((pid) => { try { inviteToParty(pid); } catch { /* invitation suivante */ } });
    toastFn(pids.length === 1 ? 'Invitation à la watch party envoyée' : 'Invitations à la watch party envoyées');
    close();
  }

  async function ensureLink() {
    if (!st.media) return null;
    const input = M.buildLinkInput({ media: st.media, mode: st.mode, pos: st.pos, withInvite: st.withInvite && st.invitesLeft !== 0, note: st.body });
    const key = M.linkKey(input);
    if (st.link && st.linkKey === key) return st.link;
    try {
      const r = await createShareLink(input);
      st.link = r;
      st.linkKey = key;
      if (r.inviteCode && st.invitesLeft !== null) st.invitesLeft = Math.max(0, st.invitesLeft - 1);
      paintLink();
      paintInvite();
      return r;
    } catch (e) {
      if (e && e.code === 'invite_quota_reached') {
        st.invitesLeft = 0;
        st.withInvite = false;
        paintInvite();
        say('Tu n’as plus d’invitation libre : le lien se copie sans invitation.', 'error');
      } else {
        say(linkErrorText(e), 'error');
      }
      return null;
    }
  }

  async function copyLink() {
    const l = await ensureLink();
    if (!l) return;
    const ok = await copyText(l.url);
    toastFn(ok ? 'Lien copié' : 'Copie impossible : sélectionne le lien et copie-le');
    if (ui.linkInput) { ui.linkInput.focus(); ui.linkInput.select(); }
  }
  const textFor = () => (st.media ? M.shareText(st.media, st.pos, st.mode) : 'Laststream');
  async function viaSms() { const l = await ensureLink(); if (l) openExternal('sms:?&body=' + encodeURIComponent(textFor() + ' ' + l.url)); }
  async function viaMail() {
    const l = await ensureLink();
    if (l) openExternal('mailto:?subject=' + encodeURIComponent(textFor()) + '&body=' + encodeURIComponent(textFor() + '\n' + l.url));
  }
  async function viaSystem() {
    const l = await ensureLink();
    if (!l) return;
    const r = await nativeShare({ title: textFor(), text: textFor(), url: l.url });
    if (r === 'copied') toastFn('Lien copié');
    else if (r === 'failed') say('Partage impossible : copie le lien à la main.', 'error');
  }
  async function toggleQr() {
    if (st.qr) { st.qr = false; paintQr(); return; }
    const l = await ensureLink();
    if (!l) return;
    st.qr = true;
    paintQr();
  }

  function paintQr() {
    if (!ui.qr) return;
    ui.qr.textContent = '';
    ui.qr.hidden = !st.qr;
    if (ui.qrBtn) ui.qrBtn.setAttribute('aria-expanded', st.qr ? 'true' : 'false');
    if (!st.qr || !st.link) return;
    try {
      const s = qrSvg(st.link.url, 'QR code du lien vers ' + (st.media ? st.media.title : 'le titre'));
      s.classList.add('shd-qr-img');
      ui.qr.append(s, h('p', 'shd-qr-cap', 'Scanne pour ouvrir la fiche.'));
    } catch {
      ui.qr.append(h('p', 'shd-qr-cap', 'QR code indisponible pour ce lien.'));
    }
  }

  function paintLink() {
    if (ui.linkInput) {
      ui.linkInput.value = st.link ? st.link.url : '';
      ui.linkInput.placeholder = 'Le lien est créé quand tu le copies';
    }
    paintQr();
  }

  const inviteHint = () => {
    if (st.invitesLeft === null) return 'Quelqu’un sans compte peut s’inscrire avec ce lien. Il devient ton ami automatiquement.';
    if (st.invitesLeft === 0) return 'Quelqu’un sans compte pourrait s’inscrire avec ce lien, mais ' + M.invitesText(0).toLowerCase();
    return 'Quelqu’un sans compte peut s’inscrire avec ce lien. ' + M.invitesText(st.invitesLeft) + ' Il devient ton ami automatiquement.';
  };
  function paintInvite() {
    const on = st.withInvite && st.invitesLeft !== 0;
    for (const sw of ui.switches || []) {
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.disabled = st.invitesLeft === 0;
      sw.classList.toggle('is-on', on);
    }
    if (ui.inviteHint) ui.inviteHint.textContent = inviteHint();
    if (ui.copySub) {
      const n = st.invitesLeft;
      ui.copySub.textContent = on ? 'Avec une invitation' + (n === null ? '' : ' · ' + n + ' restante' + (n > 1 ? 's' : '')) : 'Sans invitation';
    }
  }
  function toggleInvite() {
    if (st.invitesLeft === 0) return;
    st.withInvite = !st.withInvite;
    paintInvite();
  }
  function makeSwitch(label) {
    const sw = h('button', 'shd-tg', null, { type: 'button', role: 'switch', 'aria-label': label });
    sw.append(h('span', 'shd-tg-knob', null, { 'aria-hidden': 'true' }));
    sw.addEventListener('click', toggleInvite);
    (ui.switches = ui.switches || []).push(sw);
    return sw;
  }

  // ---------- Listes partagées ----------
  function itemOf() {
    const it = { type: st.media.type, tmdbId: st.media.tmdbId, title: st.media.title };
    if (st.media.poster) it.poster = st.media.poster;
    return it;
  }
  async function addTo(list) {
    if (st.added.has(list.id)) return;
    try {
      await store.addToList(list.id, itemOf());
      st.added.add(list.id);
      toastFn('Ajouté à « ' + list.name + ' »');
      paintLists();
    } catch (e) {
      toastFn(e && e.status === 409 ? 'Déjà dans cette liste' : 'Ajout impossible pour le moment');
    }
  }
  function newList(opener2) {
    const picked = new Set();
    let nameEl;
    openDialog({
      title: 'Nouvelle liste partagée', confirmLabel: 'Créer et ajouter', opener: opener2,
      build(body, ctl) {
        nameEl = h('input', 'cvd-input', null, { type: 'text', maxlength: M.LIST_NAME_MAX, placeholder: 'Nom de la liste', 'aria-label': 'Nom de la liste' });
        const sync = () => ctl.setValid(nameEl.value.trim().length > 0);
        nameEl.addEventListener('input', sync);
        body.append(nameEl, h('p', 'cvd-hint', 'Choisis les amis qui la verront et pourront y ajouter des titres.'));
        const people = h('div', 'cvd-people');
        for (const t of targets().filter((x) => x.kind === 'friend')) {
          const lab = h('label', 'cvd-person');
          const cb = h('input', null, null, { type: 'checkbox' });
          cb.addEventListener('change', () => { if (cb.checked) picked.add(t.id); else picked.delete(t.id); });
          lab.append(cb, avatarEl({ name: t.name, avatarColor: t.avatarColor, avatar: t.avatar }, 28), h('span', null, t.name));
          people.append(lab);
        }
        body.append(people);
      },
      async onConfirm() {
        try {
          const l = await store.createList(nameEl.value.trim(), [...picked]);
          await store.addToList(l.id, itemOf());
          st.added.add(l.id);
          st.lists = store.getState().lists;
          toastFn('Liste « ' + l.name + ' » créée');
          paintLists();
        } catch (e) {
          if (e && e.code === 'list_limit_reached') throw new Error('Tu as atteint le nombre maximal de listes.');
          throw new Error('Création impossible pour le moment.');
        }
      },
    });
  }
  function paintLists() {
    if (!ui.lists || !st.media) return;
    ui.lists.textContent = '';
    for (const l of st.lists) {
      const done = st.added.has(l.id);
      const b = h('button', 'shd-chip' + (done ? ' is-done' : ''), (done ? '✓ ' : '') + l.name, { type: 'button', 'aria-pressed': done ? 'true' : 'false' });
      b.setAttribute('aria-label', (done ? 'Ajouté à la liste ' : 'Ajouter à la liste ') + l.name);
      if (done) b.disabled = true;
      b.addEventListener('click', () => { void addTo(l); });
      ui.lists.append(b);
    }
    const nw = h('button', 'shd-chip is-new', '+ Nouvelle', { type: 'button', 'aria-label': 'Créer une liste partagée' });
    nw.addEventListener('click', () => newList(nw));
    ui.lists.append(nw);
  }

  // ---------- Sélecteur de titre (sans média) ----------
  function buildPicker() {
    st.view = 'pick';
    box.textContent = '';
    box.classList.add('is-pick');
    const id = 'shd-t-' + Date.now();
    box.setAttribute('aria-labelledby', id);
    box.removeAttribute('aria-label');
    const head = h('div', 'shd-head');
    const hc = h('div', 'shd-head-t');
    hc.append(h('h2', 'shd-title', 'Partager un titre', { id }), h('div', 'shd-sub', 'Cherche le film ou la série à envoyer.'));
    head.append(hc, iconBtn('shd-x', 'Fermer', SVG.close, close));
    const wrap = h('div', 'shd-pick');
    const field = h('div', 'shd-search');
    field.innerHTML = ICO.search;
    const inp = h('input', null, null, { type: 'search', placeholder: 'Titre d’un film ou d’une série', 'aria-label': 'Rechercher un film ou une série', autocomplete: 'off' });
    field.append(inp);
    const res = h('div', 'shd-results', null, { role: 'list' });
    const stat = h('p', 'shd-empty', 'Tape au moins deux lettres.', { role: 'status' });
    wrap.append(field, stat, res);
    box.append(head, wrap);
    let seq = 0;
    let timer = 0;
    const choose = (r) => {
      const m = M.normalizeMedia({ type: r.media_type === 'tv' ? 'series' : 'movie', tmdbId: r.id, title: r.title || r.name, poster: r.poster_path || undefined });
      if (!m) return;
      st.media = m;
      st.mode = 'title';
      buildMain();
    };
    async function run() {
      const q = inp.value.trim();
      const my = ++seq;
      res.textContent = '';
      if (q.length < 2) { stat.textContent = 'Tape au moins deux lettres.'; return; }
      stat.textContent = 'Recherche…';
      try {
        const data = await tmdb('search/multi', { query: q, include_adult: 'false' });
        if (my !== seq || !alive) return;
        const list = (data.results || []).filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && (r.title || r.name)).slice(0, 12);
        stat.textContent = list.length ? '' : 'Aucun résultat.';
        for (const r of list) {
          const b = h('button', 'shd-res', null, { type: 'button', role: 'listitem' });
          const date = (r.release_date || r.first_air_date || '').slice(0, 4);
          const p = h('span', 'shd-res-p');
          if (r.poster_path) { const im = h('img', null, null, { alt: '', loading: 'lazy' }); im.src = 'https://image.tmdb.org/t/p/w92' + r.poster_path; p.append(im); }
          const c = h('span', 'shd-res-c');
          c.append(h('span', 'shd-res-t', r.title || r.name), h('span', 'shd-res-m', (r.media_type === 'tv' ? 'Série' : 'Film') + (date ? ' · ' + date : '')));
          b.append(p, c);
          b.addEventListener('click', () => choose(r));
          res.append(b);
        }
      } catch {
        if (my === seq) stat.textContent = 'Recherche indisponible pour le moment.';
      }
    }
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { void run(); }, 250); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); void run().then(() => { const f = res.querySelector('button'); if (f) f.focus(); }); }
    });
    inp.focus();
  }

  // ---------- Fenêtre principale ----------
  function buildMain() {
    st.view = 'main';
    box.textContent = '';
    box.classList.remove('is-pick');
    ui.switches = [];
    st.mode = canMoment() ? 'moment' : 'title';
    if (mobile) buildSheet(); else buildDesktop();
    paintHeader();
    paintOpts();
    paintGrid();
    paintSend();
    paintLink();
    paintInvite();
    paintLists();
    const first = ui.firstFocus || box.querySelector('button, input, textarea');
    if (first) first.focus();
  }

  function messageField(placeholderMode) {
    const lab = h('label', 'sr-only', 'Message', { for: 'shd-mot' });
    const common = { id: 'shd-mot', maxlength: '1000', 'aria-label': 'Message' };
    if (placeholderMode === 'input') {
      const inp = h('input', 'shd-in', null, { ...common, type: 'text', placeholder: 'Ajouter un mot…' });
      inp.addEventListener('input', () => { st.body = inp.value; });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } });
      return [lab, inp];
    }
    const ta = h('textarea', 'shd-ta', null, { ...common, placeholder: 'Ajouter un mot…', rows: '2' });
    ta.addEventListener('input', () => { st.body = ta.value; });
    return [lab, ta];
  }

  function buildDesktop() {
    const id = 'shd-t-' + Date.now();
    box.removeAttribute('aria-label');
    const head = h('div', 'shd-head');
    head.append(poster(44, 64));
    const hc = h('div', 'shd-head-t');
    ui.titleEl = h('h2', 'shd-title', '', { id });
    ui.sub = h('div', 'shd-sub');
    hc.append(ui.titleEl, ui.sub);
    head.append(hc, iconBtn('shd-x', 'Fermer', SVG.close, close));
    ui.firstFocus = null;

    const cols = h('div', 'shd-cols');
    // à des amis
    const left = h('div', 'shd-col shd-left');
    left.append(h('div', 'shd-lb', 'À des amis'));
    const search = h('div', 'shd-search');
    search.innerHTML = ICO.search;
    const sInp = h('input', null, null, { type: 'search', placeholder: 'Ami, groupe ou Nom#TAG', 'aria-label': 'Chercher un ami ou un groupe', autocomplete: 'off' });
    sInp.addEventListener('input', () => { st.q = sInp.value; paintGrid(); });
    search.append(sInp);
    ui.grid = h('div', 'shd-grid', null, { role: 'group', 'aria-label': 'Amis et groupes' });
    ui.opts = h('div', 'shd-opts');
    const [lab, ta] = messageField('textarea');
    ui.status = h('p', 'shd-status', '', { role: 'alert' });
    const foot = h('div', 'shd-foot');
    ui.party = h('button', 'shd-btn is-sec', null, { type: 'button' });
    ui.party.innerHTML = ICO.party;
    ui.party.append('Watch party');
    ui.party.addEventListener('click', startParty);
    ui.send = h('button', 'shd-btn is-pri', 'Envoyer', { type: 'button' });
    ui.send.addEventListener('click', () => { void send(); });
    foot.append(ui.party, ui.send);
    left.append(search, ui.grid, ui.opts, lab, ta, ui.status, foot);

    // hors de Laststream
    const right = h('div', 'shd-col shd-right');
    right.append(h('div', 'shd-lb', 'Hors de Laststream'));
    const lk = h('div', 'shd-link');
    lk.append(h('label', 'shd-link-l', 'Lien de partage', { for: 'shd-link' }));
    const lrow = h('div', 'shd-link-row');
    ui.linkInput = h('input', 'shd-link-in', null, { id: 'shd-link', type: 'text', readonly: '', 'aria-label': 'Lien de partage' });
    const copy = h('button', 'shd-btn is-pri is-s', 'Copier', { type: 'button' });
    copy.addEventListener('click', () => { void copyLink(); });
    lrow.append(ui.linkInput, copy);
    lk.append(lrow);
    const shares = h('div', 'shd-shares');
    const sh = (icon, label, fn, expanded) => {
      const b = h('button', 'shd-sh', null, { type: 'button' });
      const ic = h('span', 'shd-sh-i', null, { 'aria-hidden': 'true' });
      ic.innerHTML = icon;
      b.append(ic, h('span', null, label));
      if (expanded) b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', () => { void fn(); });
      return b;
    };
    ui.qrBtn = sh(ICO.qr, 'QR code', toggleQr, true);
    shares.append(sh(ICO.chat, 'Messages', viaSms), sh(ICO.mail, 'E-mail', viaMail), ui.qrBtn, sh(ICO.share, 'Autres', viaSystem));
    ui.qr = h('div', 'shd-qr');
    ui.qr.hidden = true;
    const inv = h('div', 'shd-opt shd-inv');
    ui.inviteHint = h('div', 'shd-opt-h');
    const invTxt = h('div', 'shd-opt-txt');
    invTxt.append(h('div', 'shd-opt-t', 'Joindre une invitation'), ui.inviteHint);
    inv.append(makeSwitch('Joindre une invitation'), invTxt);
    const priv = h('p', 'shd-note', 'Le lien montre la fiche et ta recommandation, jamais ta position ni ta bibliothèque, sauf « ce moment ».');
    ui.lists = h('div', 'shd-chips');
    right.append(lk, shares, ui.qr, inv, priv, h('div', 'shd-lb shd-lb-2', 'Ajouter à une liste partagée'), ui.lists);

    cols.append(left, right);
    box.append(head, cols);
    ui.firstFocus = sInp;
  }

  function buildSheet() {
    const id = 'shd-t-' + Date.now();
    box.removeAttribute('aria-label');
    box.append(h('div', 'shd-handle', null, { 'aria-hidden': 'true' }));
    const head = h('div', 'shd-head');
    head.append(poster(40, 58));
    const hc = h('div', 'shd-head-t');
    ui.titleEl = h('h2', 'shd-title', '', { id });
    ui.sub = h('div', 'shd-sub');
    hc.append(ui.titleEl, ui.sub);
    head.append(hc);
    if (canMoment()) {
      const sw = h('button', 'shd-pill', st.mode === 'moment' ? 'Le titre' : 'Ce moment', { type: 'button' });
      sw.addEventListener('click', () => {
        setMode(st.mode === 'moment' ? 'title' : 'moment');
        sw.textContent = st.mode === 'moment' ? 'Le titre' : 'Ce moment';
      });
      head.append(sw);
    } else {
      head.append(iconBtn('shd-x', 'Fermer', SVG.close, close));
    }
    box.append(head);
    ui.opts = null;
    box.append(h('div', 'shd-lb', 'Amis'));
    ui.grid = h('div', 'shd-grid is-row', null, { role: 'group', 'aria-label': 'Amis et groupes' });
    box.append(ui.grid);
    const [lab, inp] = messageField('input');
    ui.status = h('p', 'shd-status', '', { role: 'alert' });
    ui.send = h('button', 'shd-btn is-pri is-m', 'Envoyer', { type: 'button' });
    ui.send.addEventListener('click', () => { void send(); });
    const row = h('div', 'shd-msg');
    row.append(lab, inp, ui.send);
    box.append(row, ui.status, h('div', 'shd-sep'));

    const acts = h('div', 'shd-acts');
    const act = (icon, title, sub, fn) => {
      const b = h('button', 'shd-ac', null, { type: 'button' });
      const ic = h('span', 'shd-ac-i', null, { 'aria-hidden': 'true' });
      ic.innerHTML = icon;
      const tx = h('span', 'shd-ac-t');
      const subEl = h('span', 'shd-ac-s', sub);
      tx.append(h('span', 'shd-ac-n', title), subEl);
      b.append(ic, tx);
      b.addEventListener('click', () => { void fn(); });
      return { b, subEl };
    };
    const party = act(ICO.partyL, 'Lancer une watch party', 'Avec les amis choisis', startParty);
    ui.partyRow = party.b;
    const copyA = act(ICO.link, 'Copier le lien', 'Avec une invitation', copyLink);
    ui.copySub = copyA.subEl;
    const copyWrap = h('div', 'shd-ac-wrap');
    copyWrap.append(copyA.b, makeSwitch('Joindre une invitation'));
    const sys = act(ICO.shareS, 'Autres applis', Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() ? 'Partage Android : WhatsApp, SMS…' : 'Partage du système', viaSystem);
    const lst = act(ICO.list, 'Liste partagée', 'Ajouter à une liste', () => showListsView());
    ui.listSub = lst.subEl;
    acts.append(party.b, copyWrap, sys.b, lst.b);
    box.append(acts);
    ui.inviteHint = null;
    ui.firstFocus = null;
    ui.mobileLists = lst.b;
  }

  function showListsView() {
    st.view = 'lists';
    const saved = Array.from(box.childNodes);
    box.textContent = '';
    const head = h('div', 'shd-head');
    head.append(iconBtn('shd-x', 'Retour', SVG.back, restore), h('h2', 'shd-title', 'Liste partagée'));
    ui.lists = h('div', 'shd-chips is-col');
    box.append(h('div', 'shd-handle', null, { 'aria-hidden': 'true' }), head,
      h('p', 'shd-sub', 'Ajouter « ' + st.media.title + ' » à une liste que tu partages avec tes amis.'), ui.lists);
    paintLists();
    const first = ui.lists.querySelector('button');
    if (first) first.focus();
    function restore() {
      box.textContent = '';
      saved.forEach((n) => box.append(n));
      st.view = 'main';
      ui.lists = null;
      if (ui.mobileLists) ui.mobileLists.focus();
    }
  }

  if (st.media) buildMain(); else buildPicker();
  return api;
}

registerSocialHook('openShareDialog', openShareDialog);
