/* Discussions Social v3 (lot F3) : contenu d'une discussion (en-tête, messages, saisie), identique dans la fenêtre ancrée
 * (bureau) et dans le plein écran mobile. `createThread` renvoie { el, update, focus, destroy } ; le gestionnaire
 * (socialConv.js) l'alimente avec l'état du store, sans abonnement propre côté contenu. Entrée envoie, Échap ferme (d'abord
 * le panneau ouvert, puis la discussion). Tout texte passe par textContent. */
import * as store from '../data/socialStore';
import { createWatchWithHandler, playAt } from '../data/watchWith';
import { userStore } from '../data/userStore';
import { posterPathOf } from '../data/serverUserStore';
import { inviteToParty, openPartyLobby, openShareDialog } from './socialHooks.js';
import { sendErrorMessage } from './socialChat.js';
import { openDialog } from './socialConvDialog.js';
import { SVG, avatarEl, h, iconBtn, messageRow } from './socialConvDom.js';
import {
  EMOJI_TABS, POLL_OPTIONS_MAX, POLL_OPTIONS_MIN, POLL_OPTION_MAX, POLL_QUESTION_MAX, authorName, convInfo, loadRecentEmojis,
  messageText, pushRecentEmoji, timeline, typingText, watchingLine,
} from './socialConvModel.js';

const PAGE = 30;
const NEAR_BOTTOM_PX = 48;
const LONG_PRESS_MS = 450;
const TICK_MS = 2000;
const HEART_COUNT_FROM = 900;

/** Brouillons gardés quand on réduit puis rouvre une discussion (par conversation, en mémoire). */
const drafts = new Map();

const errText = (err) => sendErrorMessage(err);

/**
 * @param {{ conv: string, mode: 'window'|'sheet', deps: { launch: Function, toast: (m: string) => void },
 *   onClose: () => void, onMinimize?: () => void }} o
 */
export function createThread(o) {
  const { conv, mode, deps } = o;
  const mobile = mode === 'sheet';
  const isGroup = conv.startsWith('g:');
  let alive = true;
  let loading = true;
  let loadFailed = false;
  let hasMore = false;
  let painted = false;
  let lastSig = null;
  let lastNewest = null;
  let lastOldest = null;
  let sending = false;
  let marking = false;
  let markOff = false;
  let barFor = null;
  let replyTo = null;
  let lastState = store.getState();

  const el = h('section', 'cvw-panel' + (mobile ? ' is-sheet' : ''));
  const head = h('header', 'cvw-head');
  const log = h('div', 'cvw-log', null, { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const more = h('button', 'cvm-btn cvw-more', 'Messages précédents', { type: 'button' });
  const status = h('p', 'cvw-status', '', { role: 'status' });
  const replyBar = h('div', 'cvw-replybar');
  replyBar.hidden = true;
  const sugg = h('div', 'cvw-sugg');
  const form = h('form', 'cvw-form');
  form.noValidate = true;
  const plusBtn = iconBtn('cvw-ico', 'Partager un titre ou un moment, créer un sondage', SVG.plus);
  plusBtn.setAttribute('aria-haspopup', 'menu');
  const input = h('input', 'cvw-input', null, { type: 'text', name: 'text', autocomplete: 'off', 'aria-label': 'Message', enterkeyhint: 'send' });
  const emojiBtn = iconBtn('cvw-ico', 'Emojis', SVG.smile);
  emojiBtn.setAttribute('aria-expanded', 'false');
  const sendBtn = iconBtn('cvw-ico is-send', 'Envoyer', SVG.send);
  sendBtn.type = 'submit';
  const count = h('span', 'cvw-count', '');
  count.hidden = true;
  form.append(plusBtn, input, count, emojiBtn, sendBtn);
  const panelHost = h('div', 'cvw-emoji-host');
  panelHost.hidden = true;
  el.append(head, log, status, replyBar, sugg, form, panelHost);

  let menu = null;
  const info = () => convInfo(conv, lastState);
  const myPid = () => (lastState.me ? lastState.me.pid : '');
  const listOf = (s = lastState) => s.threads[conv] || [];
  const byId = (id) => listOf().find((m) => m.id === id);
  const setStatus = (text, tone) => {
    status.textContent = text || '';
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  };

  // ---------- En-tête ----------
  let headSig = '';
  function paintHead() {
    const inf = info();
    const watching = inf && inf.kind === 'dm' ? watchingLine(inf.watching) : '';
    let sub;
    if (!inf) sub = '';
    else if (inf.kind === 'group') sub = inf.members.length + 1 + ' membres';
    else sub = watching || (inf.status === 'offline' ? 'Hors ligne' : 'En ligne');
    const name = inf ? inf.name : 'Discussion';
    const sig = [conv, name, inf && inf.tag, sub, inf && inf.avatarColor, inf && inf.status, !!watching, mobile].join('|');
    if (sig === headSig) return;
    headSig = sig;
    head.textContent = '';
    el.setAttribute('aria-label', 'Discussion avec ' + name);
    if (mobile) head.append(iconBtn('cvw-ico is-big', 'Retour', SVG.back, () => o.onClose()));
    if (inf && inf.kind === 'group') head.append(groupAvatars(inf));
    else head.append(avatarEl(inf ? { name, avatarColor: inf.avatarColor, avatar: inf.avatar } : { name }, mobile ? 38 : 36, inf ? inf.status : ''));
    const who = h('div', 'cvw-who');
    const title = h('div', 'cvw-name', name);
    if (inf && inf.tag && !mobile) title.append(h('span', 'cvw-tag', '#' + inf.tag));
    const subEl = h('div', 'cvw-sub' + (watching ? ' is-watching' : ''), sub);
    subEl.dataset.sub = '';
    who.append(title, subEl);
    head.append(who);
    if (mobile) {
      if (watching) {
        const w = iconBtn('cvw-ico is-big is-accent', 'Regarder avec ' + name, SVG.playL, () => watchWith());
        head.append(w);
      }
      const more2 = iconBtn('cvw-ico is-big', 'Plus d’actions', SVG.more, (e) => openMenu(e.currentTarget, headerActions()));
      more2.setAttribute('aria-haspopup', 'menu');
      head.append(more2);
    } else {
      if (inf && inf.kind === 'dm') head.append(iconBtn('cvw-ico', 'Lancer une watch party avec ' + name, SVG.party, () => inviteToParty(inf.pid)));
      if (o.onMinimize) head.append(iconBtn('cvw-ico', 'Réduire', SVG.min, () => o.onMinimize()));
      head.append(iconBtn('cvw-ico', 'Fermer la discussion', SVG.close, () => o.onClose()));
    }
  }

  function groupAvatars(inf) {
    const wrap = h('span', 'cv-stack', null, { 'aria-hidden': 'true' });
    const ms = inf.members.slice(0, 2);
    ms.forEach((m, i) => {
      const a = avatarEl({ name: m.handle.name, avatarColor: m.avatarColor, avatar: m.avatar }, 26);
      a.classList.add(i === 0 ? 'is-a' : 'is-b');
      wrap.append(a);
    });
    return wrap;
  }

  function watchWith() {
    const inf = info();
    if (inf && inf.kind === 'dm') createWatchWithHandler(deps)(inf.friend);
  }

  function headerActions() {
    const inf = info();
    const acts = [];
    if (inf && inf.kind === 'dm') acts.push({ label: 'Proposer une watch party', run: () => inviteToParty(inf.pid) });
    acts.push({ label: 'Créer un sondage', run: () => openPollDialog() });
    acts.push({ label: 'Partager un titre', run: () => openShareDialog({ media: null, conv }) });
    if (inf && inf.kind === 'group') {
      acts.push({
        label: 'Quitter le groupe',
        run: () => store.leaveGroup(inf.id).then(() => o.onClose(), (e) => deps.toast(errText(e))),
      });
    }
    return acts;
  }

  // ---------- Menu contextuel simple ----------
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    plusBtn.setAttribute('aria-expanded', 'false');
  }
  function openMenu(anchor, items) {
    const was = menu && menu.dataset.for === (anchor.getAttribute('aria-label') || '');
    closeMenu();
    if (was) return;
    menu = h('div', 'cvw-menu', null, { role: 'menu', 'data-for': anchor.getAttribute('aria-label') || '' });
    for (const it of items) {
      const b = h('button', 'cvw-menu-it', it.label, { type: 'button', role: 'menuitem' });
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      menu.append(b);
    }
    menu.addEventListener('keydown', (e) => {
      const bs = Array.from(menu.querySelectorAll('button'));
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    });
    el.append(menu);
    if (anchor === plusBtn) plusBtn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  // ---------- Sondage ----------
  function openPollDialog() {
    openDialog({
      title: 'Nouveau sondage', confirmLabel: 'Envoyer le sondage', opener: plusBtn,
      build(body, ctl) {
        const q = h('input', 'cvd-input', null, { type: 'text', maxlength: POLL_QUESTION_MAX, placeholder: 'Question (ex. film de dimanche)', 'aria-label': 'Question du sondage' });
        body.append(q);
        const optsBox = h('div', 'cvd-opts');
        body.append(optsBox);
        const add = h('button', 'cvm-btn', '+ Ajouter une option', { type: 'button' });
        body.append(add);
        const fields = [];
        const check = () => {
          const filled = fields.filter((f) => f.value.trim() !== '').length;
          ctl.setValid(q.value.trim() !== '' && filled >= POLL_OPTIONS_MIN);
          add.hidden = fields.length >= POLL_OPTIONS_MAX;
        };
        const addField = () => {
          const f = h('input', 'cvd-input', null, { type: 'text', maxlength: POLL_OPTION_MAX, placeholder: 'Option ' + (fields.length + 1), 'aria-label': 'Option ' + (fields.length + 1) });
          f.addEventListener('input', check);
          fields.push(f);
          optsBox.append(f);
          check();
          return f;
        };
        addField();
        addField();
        add.addEventListener('click', () => addField().focus());
        q.addEventListener('input', check);
        pollData = { q, fields };
      },
      onConfirm: async () => {
        const { q, fields } = pollData;
        const options = fields.map((f) => f.value.trim()).filter(Boolean);
        try {
          await store.sendToConv(conv, { kind: 'poll', poll: { question: q.value.trim(), options } });
        } catch (e) { throw new Error(errText(e)); }
      },
    });
  }
  let pollData = null;

  // ---------- Actions des messages ----------
  const act = {
    read(t, opener) {
      if (t.type === 'series') { location.hash = '#/tv/' + t.tmdbId; return; }
      playAt(deps, { type: 'movie', tmdbId: t.tmdbId, title: t.title }, 0, opener);
    },
    inList(t) {
      try { return userStore.inLibrary((t.type === 'series' ? 'tv' : 'movie') + ':' + t.tmdbId); } catch { return false; }
    },
    addToList(t, opener) {
      try {
        const p = t.poster ? posterPathOf(t.poster) || (t.poster.startsWith('/') ? t.poster : '') : '';
        userStore.toggleLibrary({ id: String(t.tmdbId), type: t.type === 'series' ? 'tv' : 'movie', title: t.title, poster: p, year: t.year ? String(t.year) : '' });
        deps.toast(t.title + ' est dans ta liste.');
        repaintLog(true);
      } catch { deps.toast('Impossible d’ajouter à ta liste.'); }
      if (opener && opener.isConnected) opener.blur();
    },
    playMoment(mo, opener) {
      playAt(deps, { type: mo.type, tmdbId: mo.tmdbId, title: mo.title, season: mo.season, episode: mo.episode }, typeof mo.pos === 'number' ? mo.pos : 0, opener);
    },
    joinParty(id) { openPartyLobby(id); },
    react(m, emoji) {
      barFor = null;
      store.react(conv, m.id, emoji).catch((e) => deps.toast(errText(e)));
      repaintLog(true);
    },
    vote(m, optionId) {
      if (!m.poll) return;
      store.vote(conv, m.poll.id, optionId).catch((e) => deps.toast(errText(e)));
    },
    reply(m) {
      barFor = null;
      replyTo = m;
      paintReply();
      repaintLog(true);
      input.focus();
    },
    toggleBar(m) {
      barFor = barFor === m.id ? null : m.id;
      repaintLog(true);
    },
  };

  function paintReply() {
    replyBar.textContent = '';
    replyBar.hidden = !replyTo;
    if (!replyTo) return;
    const inf = info();
    const t = h('div', 'cvw-reply-t');
    t.append(h('b', null, 'Réponse à ' + authorName(replyTo.from, inf, lastState)), h('span', null, messageText(replyTo)));
    replyBar.append(t, iconBtn('cvw-ico', 'Annuler la réponse', SVG.close, () => { replyTo = null; paintReply(); input.focus(); }));
  }

  // ---------- Messages ----------
  function seenInfo(list, me) {
    if (isGroup) return null;
    const last = list[list.length - 1];
    if (!last || last.from !== me) return null;
    const pid = conv.slice(3);
    const v2 = (lastState.messages[pid] || []).find((x) => x.id === last.id);
    const at = last.readAt || (v2 && v2.readAt);
    return at ? at : null;
  }

  function typingNames() {
    const me = myPid();
    return store.typingPids(lastState, conv).filter((p) => p !== me).map((p) => authorName(p, info(), lastState));
  }

  function logSig(list) {
    const parts = list.map((m) => [
      m.id, m.readAt ? 1 : 0,
      (m.reactions || []).map((r) => r.emoji + r.count + (r.mine ? 'm' : '')).join(','),
      m.poll ? m.poll.options.map((x) => x.votes + (x.mine ? 'm' : '')).join('.') + (m.poll.closed ? 'c' : '') : '',
    ].join(':'));
    return parts.join('|') + '#' + barFor + '#' + (replyTo ? replyTo.id : '') + '#' + loading + '#' + typingNames().join(',') + '#' + seenInfo(list, myPid());
  }

  function repaintLog(force) {
    const list = listOf();
    const sig = logSig(list);
    if (!force && painted && sig === lastSig) return;
    const me = myPid();
    const dist = log.scrollHeight - log.scrollTop;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX;
    const newest = list.length ? list[list.length - 1].id : null;
    const oldest = list.length ? list[0].id : null;
    const first = !painted;
    const appended = !first && newest !== lastNewest;
    const prepended = !first && !appended && oldest !== lastOldest;
    const last = list[list.length - 1];
    const ctx = { me, info: info(), s: lastState, byId, act, barFor, mobile };

    log.textContent = '';
    log.append(more);
    more.hidden = !(hasMore || loadFailed);
    more.disabled = loading;
    more.textContent = loadFailed ? 'Réessayer le chargement' : 'Messages précédents';
    if (!list.length) {
      if (!loading) log.append(h('p', 'cvw-empty', 'Aucun message pour l’instant. Écris le premier !'));
    } else {
      for (const it of timeline(list)) {
        if (it.day) log.append(h('div', 'cvm-day', it.day));
        else log.append(withLongPress(messageRow(it.msg, ctx), it.msg));
      }
    }
    const seenAt = seenInfo(list, me);
    if (seenAt) log.append(h('div', 'cvm-seen', 'Vu · ' + new Date(seenAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })));
    const names = typingNames();
    if (names.length) {
      const t = h('div', 'cvm-typing');
      const dots = h('span', 'cvm-dots', null, { 'aria-hidden': 'true' });
      dots.append(h('i'), h('i'), h('i'));
      t.append(dots, h('span', null, typingText(names)));
      log.append(t);
    }
    lastSig = sig;
    lastNewest = newest;
    lastOldest = oldest;
    painted = true;
    if (first || (appended && (nearBottom || (last && last.from === me)))) log.scrollTop = log.scrollHeight;
    else if (prepended) log.scrollTop = log.scrollHeight - dist;
    else if (!force || nearBottom) log.scrollTop = nearBottom ? log.scrollHeight : log.scrollTop;
  }

  /** Appui long (toucher) ou clic droit : barre de réactions. */
  function withLongPress(row, m) {
    if (!mobile) return row;
    let timer = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a, input')) return;
      cancel();
      timer = setTimeout(() => { timer = null; act.toggleBar(m); }, LONG_PRESS_MS);
    });
    ['pointerup', 'pointercancel', 'pointermove', 'pointerleave'].forEach((t) => row.addEventListener(t, cancel));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); act.toggleBar(m); });
    return row;
  }

  // ---------- Chargement ----------
  async function loadFirst() {
    loading = true;
    loadFailed = false;
    repaintLog(true);
    try {
      const p = [store.loadThread(conv, { limit: PAGE })];
      // Cache v2 des messages directs : il reçoit les accusés « lu » en direct (Vu).
      if (!isGroup) p.push(store.loadMessages(conv.slice(3), { limit: PAGE }).catch(() => []));
      const [merged] = await Promise.all(p);
      hasMore = merged.length >= PAGE;
    } catch {
      loadFailed = true;
    }
    loading = false;
    if (!alive) return;
    setStatus(loadFailed ? 'Messages indisponibles pour le moment.' : '', loadFailed ? 'error' : '');
    lastState = store.getState();
    repaintLog(true);
  }

  async function loadOlder() {
    const list = listOf();
    if (loading || !list.length) return;
    loading = true;
    more.disabled = true;
    const prev = list.length;
    try {
      const merged = await store.loadThread(conv, { before: list[0].createdAt, limit: PAGE });
      hasMore = merged.length > prev;
    } catch {
      hasMore = true;
      if (alive) deps.toast('Messages précédents indisponibles pour le moment.');
    }
    loading = false;
    if (!alive) return;
    lastState = store.getState();
    repaintLog(true);
  }

  function markNow() {
    if (marking || markOff) return;
    marking = true;
    Promise.resolve()
      .then(() => store.markConvRead(conv))
      .catch(() => { markOff = true; })
      .finally(() => { marking = false; });
  }
  const visible = () => alive && el.isConnected && !el.closest('[hidden]');
  const unreadNow = () => {
    const inf = info();
    return inf ? inf.unread : 0;
  };

  // ---------- Saisie ----------
  function updateForm() {
    const n = Array.from(input.value.trim()).length;
    const over = n > store.MESSAGE_MAX;
    count.hidden = n < HEART_COUNT_FROM;
    count.textContent = n + ' / ' + store.MESSAGE_MAX;
    count.classList.toggle('is-over', over);
    sendBtn.disabled = sending || n === 0 || over;
    drafts.set(conv, input.value);
  }

  async function sendText() {
    const text = input.value.trim();
    if (sending || !text) return;
    if (Array.from(text).length > store.MESSAGE_MAX) {
      setStatus('Message trop long : ' + store.MESSAGE_MAX + ' caractères au maximum.', 'error');
      return;
    }
    sending = true;
    setStatus('');
    updateForm();
    try {
      await store.sendToConv(conv, { kind: 'text', body: text, ...(replyTo ? { replyTo: replyTo.id } : {}) });
      if (input.value.trim() === text) input.value = '';
      drafts.delete(conv);
      replyTo = null;
      paintReply();
    } catch (err) {
      if (alive) setStatus(errText(err), 'error');
    }
    sending = false;
    if (alive) {
      updateForm();
      lastState = store.getState();
      repaintLog(true);
      if (!mobile) input.focus();
    }
  }

  // ---------- Emojis ----------
  let emojiOpen = false;
  let emojiTab = 'recent';
  function paintEmoji() {
    panelHost.textContent = '';
    panelHost.hidden = !emojiOpen;
    emojiBtn.setAttribute('aria-expanded', emojiOpen ? 'true' : 'false');
    if (!emojiOpen) return;
    const tabs = h('div', 'cvw-etabs', null, { role: 'tablist' });
    for (const t of EMOJI_TABS) {
      const b = h('button', 'cvw-etab' + (t.id === emojiTab ? ' is-on' : ''), t.label, { type: 'button', role: 'tab', 'aria-selected': t.id === emojiTab ? 'true' : 'false' });
      b.addEventListener('click', () => { emojiTab = t.id; paintEmoji(); });
      tabs.append(b);
    }
    const grid = h('div', 'cvw-egrid', null, { role: 'group', 'aria-label': 'Emojis' });
    const tab = EMOJI_TABS.find((t) => t.id === emojiTab) || EMOJI_TABS[0];
    const list = tab.id === 'recent' ? loadRecentEmojis() : tab.list;
    for (const em of list) {
      const b = h('button', 'cvw-eit', em, { type: 'button', 'aria-label': 'Insérer ' + em });
      b.addEventListener('click', () => insertEmoji(em));
      grid.append(b);
    }
    panelHost.append(tabs, grid);
  }
  function insertEmoji(em) {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + em + input.value.slice(e);
    const pos = s + em.length;
    try { input.setSelectionRange(pos, pos); } catch { /* champ non sélectionnable */ }
    pushRecentEmoji(em);
    updateForm();
    if (emojiTab === 'recent') paintEmoji();
    input.focus();
  }

  // ---------- Suggestions rapides (bureau) ----------
  let suggSig = '';
  function paintSugg() {
    if (mobile) { sugg.hidden = true; return; }
    const inf = info();
    const sig = inf ? [inf.kind, inf.name, !!inf.watching, inf.pid].join('|') : '';
    if (sig === suggSig) return;
    suggSig = sig;
    sugg.textContent = '';
    if (!inf) { sugg.hidden = true; return; }
    if (inf.kind === 'dm') {
      if (inf.watching) {
        const b = h('button', 'cvw-chip', null, { type: 'button' });
        b.innerHTML = SVG.play;
        b.append('Regarder avec ' + inf.name);
        b.addEventListener('click', watchWith);
        sugg.append(b);
      }
      const p = h('button', 'cvw-chip', 'Proposer une watch party', { type: 'button' });
      p.addEventListener('click', () => inviteToParty(inf.pid));
      sugg.append(p);
    } else {
      const p = h('button', 'cvw-chip', 'Créer un sondage', { type: 'button' });
      p.addEventListener('click', () => openPollDialog());
      sugg.append(p);
    }
    sugg.hidden = false;
  }

  // ---------- Événements ----------
  input.addEventListener('input', () => {
    updateForm();
    if (input.value.trim()) store.notifyTyping(conv);
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); void sendText(); });
  more.addEventListener('click', () => { if (loadFailed) void loadFirst(); else void loadOlder(); });
  log.addEventListener('scroll', () => { if (log.scrollTop < 30 && hasMore && !loading && painted) void loadOlder(); });
  log.addEventListener('click', (e) => {
    if (barFor && !e.target.closest('.cvm-bar, .cvm-act')) { barFor = null; repaintLog(true); }
  });
  plusBtn.addEventListener('click', () => openMenu(plusBtn, [
    { label: 'Partager un titre', run: () => openShareDialog({ media: null, conv }) },
    { label: 'Créer un sondage', run: () => openPollDialog() },
  ]));
  emojiBtn.addEventListener('click', () => { emojiOpen = !emojiOpen; paintEmoji(); });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (menu) { closeMenu(); plusBtn.focus(); }
    else if (emojiOpen) { emojiOpen = false; paintEmoji(); emojiBtn.focus(); }
    else if (barFor) { barFor = null; repaintLog(true); }
    else if (replyTo) { replyTo = null; paintReply(); }
    else o.onClose();
  });

  const tick = setInterval(() => {
    if (!alive) return;
    lastState = store.getState();
    paintHead();
    const sub = head.querySelector('[data-sub]');
    const inf = info();
    if (sub && inf && inf.kind === 'dm' && inf.watching) sub.textContent = watchingLine(inf.watching);
    repaintLog(false);
  }, TICK_MS);

  input.value = drafts.get(conv) || '';

  // ---------- API ----------
  paintHead();
  paintSugg();
  updateForm();
  repaintLog(true);
  void loadFirst();
  if (visible() === false) { /* monté plus tard par le gestionnaire */ }

  return {
    el, conv,
    /** Nouvel état du store. */
    update(s) {
      if (!alive) return;
      lastState = s;
      paintHead();
      paintSugg();
      repaintLog(false);
      if (visible() && unreadNow() > 0) markNow();
    },
    /** Appelé quand la discussion devient visible : lu tout de suite, focus sur la saisie (bureau). */
    activate() {
      lastState = store.getState();
      markNow();
      repaintLog(true);
      log.scrollTop = log.scrollHeight;
      if (!mobile) input.focus();
    },
    focus() { input.focus(); },
    destroy() {
      alive = false;
      clearInterval(tick);
      closeMenu();
      drafts.set(conv, input.value);
      el.remove();
    },
  };
}
