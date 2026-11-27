/* Forum communautaire (LAST-1651) : accueil (#/forum), catégorie (#/forum/c/<id>), sujet (#/forum/t/<id>), nouveau sujet
 * (#/forum/new[/<catégorie>]) et modération (#/forum/mod). Réservé aux comptes qui ont accès au service (abonnement de
 * soutien sur le service en ligne) ; profil enfant exclu. Tout texte de membre passe par textContent ou par le rendu Markdown
 * en nœuds DOM (forumMarkdown.js). */
import '../styles/convwin.css';
import '../styles/forum.css';
import * as api from '../data/forumApi';
import { auth } from '../data/auth';
import { defaultStart, parseLocal } from '../data/eveningForm';
import { listParties } from '../data/socialApi';
import { detailEl, toast } from './dom.js';
import { topBar } from './fragments.js';
import { go } from './router.js';
import { teardownFiche } from './fiche.js';
import { avatarEl, h } from './socialConvDom.js';
import { openDialog } from './socialConvDialog.js';
import { ago } from './socialFmt.js';
import { quoteOf, renderMarkdown } from './forumMarkdown.js';
import { t as tr, tn } from '../i18n';

/** Accueil en cache le temps de la visite (rôle, catégories) : rafraîchi à chaque ouverture de l'accueil. */
let homeCache = null;
/** Jeton de rendu : un chargement qui revient après une autre navigation n'affiche rien. */
let renderSeq = 0;

const REASONS = [
  ['spam', tr('Spam ou publicité')],
  ['harassment', tr('Harcèlement ou propos haineux')],
  ['piracy', tr('Lien vers du contenu piraté')],
  ['spoiler', tr('Spoiler non masqué')],
  ['off_topic', tr('Hors-sujet')],
  ['other', tr('Autre')],
];
const REASON_LABEL = Object.fromEntries(REASONS);
const BAN_CHOICES = [[1, tr('1 jour')], [7, tr('7 jours')], [30, tr('30 jours')], [null, tr('Sans limite')]];

function errText(e) {
  const code = e && e.code;
  if (e && e.status === 402) return tr('Le forum est réservé aux membres qui soutiennent Laststream.');
  if (code === 'forum_banned') return tr('Tu ne peux plus écrire sur le forum pour le moment.');
  if (code === 'topic_locked') return tr('Ce sujet est verrouillé.');
  if (code === 'staff_only') return tr('Seule l’équipe peut publier dans cette catégorie.');
  if (code === 'moderator_only' || code === 'owner_only' || code === 'forbidden') return tr('Action réservée.');
  if (code === 'forum_unavailable') return tr('Le forum n’existe que sur le service en ligne Laststream.');
  if (code === 'kid_profile') return tr('Le forum n’est pas disponible sur un profil enfant.');
  if (code === 'event_not_open') return tr('Le salon s’ouvre 15 minutes avant le début de la séance (et jusqu’à 3 h après).');
  if (code === 'party_unavailable') return tr('Les salons de visionnage ne sont pas disponibles sur ce serveur.');
  if (code === 'too_many_rooms') return tr('Tu as déjà trop de salons ouverts : ferme-en un d’abord.');
  if (e && e.issues && e.issues.includes('startsAt:invalid')) return tr('Choisis une date de séance entre 5 minutes et 90 jours à partir de maintenant.');
  if (e && e.status === 429) return tr('Doucement : réessaie dans {v} min.', { v: Math.max(1, Math.ceil((e.retryAfterSec || 60) / 60)) });
  if (e && e.status === 404) return tr('Introuvable : le sujet a peut-être été retiré.');
  if (e && e.status === 400) return tr('Texte invalide : vérifie la longueur du titre (3 à 120 caractères) et du message.');
  if (e && (e.status === 0 || code === 'network')) return tr('Serveur injoignable pour le moment.');
  return tr('Action impossible pour le moment.');
}

const staff = () => !!homeCache && homeCache.me.role !== 'member';
const banned = () => !!homeCache && homeCache.me.bannedUntil !== undefined;
const nameOf = (a) => (a && a.handle ? a.handle.name : tr('Compte supprimé'));
const fullOf = (a) => (a && a.handle ? a.handle.full : '');
const roleBadge = (a) => (a.role === 'owner' ? h('span', 'fo-badge is-owner', tr('Équipe')) : a.role === 'mod' ? h('span', 'fo-badge is-mod', tr('Modération')) : null);
const av = (a, size) => avatarEl({ name: nameOf(a), avatarColor: a.avatarColor, avatar: a.avatar }, size);
const dateText = (ms) => new Date(ms).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const link = (href, cls, text) => h('a', cls, text, { href, 'data-go': '' });

/** Coquille de page : barre du haut et article ; rend le conteneur du contenu. */
function shell(title) {
  teardownFiche();
  document.title = tr('{title} · Laststream', { title });
  // eslint-disable-next-line laststream/no-html-sink -- gabarit constant (barre du haut du module fragments, sans texte de membre)
  detailEl.innerHTML = topBar(false) + '<article class="svc-page fo-page" tabindex="-1"><div class="fo-body"></div></article>';
  return detailEl.querySelector('.fo-body');
}

function crumbs(parts) {
  const nav = h('nav', 'fo-crumbs', null, { 'aria-label': tr('Fil d’Ariane') });
  parts.forEach(([label, href], i) => {
    if (i) nav.append(h('span', 'fo-sep', '›', { 'aria-hidden': 'true' }));
    nav.append(href ? link(href, null, label) : h('span', null, label, { 'aria-current': 'page' }));
  });
  return nav;
}

function stateMsg(body, msg, retry) {
  body.replaceChildren(h('p', 'row-msg fo-msg', msg, { role: 'alert' }));
  if (retry) {
    const b = h('button', 'btn btn-ghost', tr('Réessayer'), { type: 'button' });
    b.addEventListener('click', retry);
    body.append(b);
  }
}

async function ensureHome() {
  if (!homeCache) homeCache = await api.home();
  return homeCache;
}

function banNotice() {
  if (!banned()) return null;
  const until = homeCache.me.bannedUntil;
  return h('p', 'fo-notice', until === null ? tr('Ton accès en écriture au forum est suspendu.') : tr('Ton accès en écriture au forum est suspendu jusqu’au {until}.', { until: dateText(until) }), { role: 'status' });
}

// ---------- Éditeur ----------

/** Insère un balisage autour de la sélection du champ (ou en début de ligne pour `line`). */
function wrap(ta, before, after = before, line = false) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  if (line) {
    const start = value.lastIndexOf('\n', s - 1) + 1;
    ta.setRangeText(before, start, start, 'end');
  } else {
    const sel = value.slice(s, e);
    ta.setRangeText(before + sel + after, s, e, 'select');
    if (!sel) ta.setSelectionRange(s + before.length, s + before.length);
  }
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

/**
 * Champ de saisie Markdown avec barre d'outils et aperçu. `onSubmit(text)` publie (rejette une Error lisible) ;
 * rend { el, textarea, setText(t), focus() }.
 */
function composer({ placeholder, submitLabel, initial = '', onSubmit, onCancel, autofocus = false }) {
  const box = h('form', 'fo-compose');
  const bar = h('div', 'fo-tools', null, { role: 'toolbar', 'aria-label': tr('Mise en forme') });
  const ta = h('textarea', 'fo-ta', null, { placeholder, rows: 6, maxlength: 10000, 'aria-label': placeholder });
  ta.value = initial;
  const preview = h('div', 'fo-preview', null, { hidden: '' });
  const tools = [
    ['B', tr('Gras'), () => wrap(ta, '**')],
    ['I', tr('Italique'), () => wrap(ta, '*')],
    ['S', tr('Barré'), () => wrap(ta, '~~')],
    ['❝', tr('Citation'), () => wrap(ta, '> ', '', true)],
    ['•', tr('Liste'), () => wrap(ta, '- ', '', true)],
    ['</>', tr('Code'), () => wrap(ta, '`')],
    ['🙈', tr('Spoiler'), () => wrap(ta, '||')],
    ['🔗', tr('Lien'), () => wrap(ta, '[', '](https://)')],
  ];
  for (const [label, title, fn] of tools) {
    const b = h('button', 'fo-tool', label, { type: 'button', title, 'aria-label': title });
    b.addEventListener('click', fn);
    bar.append(b);
  }
  const prevBtn = h('button', 'fo-tool fo-tool-prev', tr('Aperçu'), { type: 'button', 'aria-pressed': 'false' });
  prevBtn.addEventListener('click', () => {
    const on = preview.hidden;
    preview.hidden = !on;
    ta.hidden = on;
    prevBtn.setAttribute('aria-pressed', String(on));
    prevBtn.textContent = on ? tr('Écrire') : tr('Aperçu');
    if (on) preview.replaceChildren(ta.value.trim() ? renderMarkdown(ta.value) : h('p', 'fo-dim', tr('Rien à prévisualiser.')));
  });
  bar.append(prevBtn);
  const foot = h('div', 'fo-compose-foot');
  const count = h('span', 'fo-count');
  const err = h('p', 'fo-err', '', { role: 'alert' });
  const send = h('button', 'btn btn-primary', submitLabel, { type: 'submit' });
  const refresh = () => { const n = [...ta.value].length; count.textContent = n > 9000 ? n + ' / 10 000' : ''; send.disabled = ta.value.trim() === ''; };
  ta.addEventListener('input', refresh);
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); box.requestSubmit(); } });
  foot.append(count);
  if (onCancel) {
    const cancel = h('button', 'btn btn-ghost', tr('Annuler'), { type: 'button' });
    cancel.addEventListener('click', onCancel);
    foot.append(cancel);
  }
  foot.append(send);
  box.append(bar, ta, preview, err, foot);
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (send.disabled) return;
    send.disabled = true;
    err.textContent = '';
    try {
      await onSubmit(ta.value);
    } catch (x) {
      err.textContent = x && x.message ? x.message : tr('Action impossible pour le moment.');
    } finally {
      refresh();
    }
  });
  refresh();
  if (autofocus) queueMicrotask(() => ta.focus({ preventScroll: true }));
  return {
    el: box,
    textarea: ta,
    setText(t) { ta.value = t; refresh(); },
    insert(t) { ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n\n') : '') + t; refresh(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); },
  };
}

// ---------- Watch parties ----------

const EVENT_CAT = 'watch-parties';
const MIN = 60_000;
const OPEN_LEAD = 15 * MIN;
const OPEN_GRACE = 3 * 60 * MIN;
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** « dans 2 h », « en cours », « terminée ». */
function untilText(ms, now = Date.now()) {
  const d = ms - now;
  if (d <= 0) return d > -OPEN_GRACE ? tr('en cours') : tr('terminée');
  const min = Math.ceil(d / MIN);
  if (min < 60) return tr('dans {min} min', { min });
  const hrs = Math.round(min / 60);
  if (hrs < 24) return tr('dans {hrs} h', { hrs });
  return 'dans ' + tn(Math.round(hrs / 24), '{n} jour', '{n} jours');
}
const whenText = (ms) => new Date(ms).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const timeText = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function dateChip(ms, big = false) {
  const d = new Date(ms);
  const chip = h('span', 'fo-ev-date' + (big ? ' is-big' : ''), null, { 'aria-hidden': 'true' });
  chip.append(h('span', 'fo-ev-day', String(d.getDate())), h('span', 'fo-ev-mon', d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '')));
  return chip;
}

/** Bouton « Je participe » / « Inscrit » ; `after(event)` reçoit la séance à jour. */
function rsvpButton(topic, after) {
  const ev = topic.event;
  const b = h('button', 'btn ' + (ev.mine ? 'btn-ghost fo-going' : 'btn-primary'), ev.mine ? tr('Inscrit') : tr('Je participe'), { type: 'button', 'aria-pressed': String(!!ev.mine) });
  if (banned() || Date.now() > ev.startsAt + OPEN_GRACE) b.disabled = true;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api.rsvp(topic.id, !ev.mine);
      topic.event = r.event;
      homeCache = null;
      toast(r.event.mine ? tr('Inscrit : rendez-vous le {startsAt}.', { startsAt: whenText(r.event.startsAt) }) : tr('Inscription retirée.'));
      after(r.event);
    } catch (e) {
      toast(errText(e));
      b.disabled = false;
    }
  });
  return b;
}

function eventCard(t, now) {
  const ev = t.event;
  const card = h('article', 'fo-ev fo-rise');
  const live = now >= ev.startsAt;
  card.append(dateChip(ev.startsAt));
  const main = h('div', 'fo-ev-main');
  main.append(h('span', 'fo-ev-when' + (live ? ' is-live' : ''), (live ? tr('En cours') : untilText(ev.startsAt, now)) + ' · ' + timeText(ev.startsAt)));
  main.append(link('#/forum/t/' + encodeURIComponent(t.id), 'fo-ev-t', t.title));
  main.append(h('span', 'fo-dim', tn(ev.going, '{n} inscrit', '{n} inscrits') + ' · proposée par ' + nameOf(t.author)));
  const acts = h('div', 'fo-ev-acts');
  const draw = () => {
    acts.replaceChildren();
    if (ev.roomId) acts.append(link('#/party/' + encodeURIComponent(ev.roomId), 'btn btn-primary', tr('Rejoindre le salon')));
    else acts.append(rsvpButton(t, (next) => { Object.assign(ev, next); main.lastChild.textContent = tn(ev.going, '{n} inscrit', '{n} inscrits') + ' · proposée par ' + nameOf(t.author); draw(); }));
  };
  draw();
  card.append(main, acts);
  return card;
}

/** Salons publics ouverts en ce moment (tout Laststream) ; la section reste cachée sans salon ou si le serveur n'en a pas. */
async function liveRoomsInto(section, seq) {
  const pid = auth.profile && auth.profile.id;
  if (!pid) return;
  let rooms;
  try {
    rooms = (await listParties(pid, { limit: 8 })).rooms || [];
  } catch {
    return;
  }
  if (seq !== renderSeq || !rooms.length) return;
  const row = h('div', 'fo-live');
  for (const r of rooms) {
    const n = Number(r.participants) || 0;
    const a = link('#/party/' + encodeURIComponent(r.id), 'fo-live-card fo-rise');
    a.append(h('span', 'fo-live-tag', tr('En direct')), h('span', 'fo-live-t', r.title), h('span', 'fo-dim', tr('Salon de {host} · {n}', { host: r.host, n: tn(n, '{n} spectateur', '{n} spectateurs') })));
    row.append(a);
  }
  section.replaceChildren(sectionHead(tr('Watch parties en direct'), tr('Rejoins un salon public et regarde en même temps que les autres.')), row);
  section.hidden = false;
}

// ---------- Accueil ----------

function categoryCard(c) {
  const a = link('#/forum/c/' + encodeURIComponent(c.id), 'fo-cat');
  a.append(h('span', 'fo-cat-ic', c.icon, { 'aria-hidden': 'true' }));
  const main = h('span', 'fo-cat-main');
  main.append(h('span', 'fo-cat-name', c.name), h('span', 'fo-cat-desc', c.description));
  const meta = h('span', 'fo-cat-meta');
  meta.append(h('span', null, tn(c.topicCount, '{n} sujet', '{n} sujets')));
  if (c.lastPostAt) meta.append(h('span', 'fo-dim', tr('actif il y a {lastPostAt}', { lastPostAt: ago(c.lastPostAt) })));
  a.append(main, meta);
  return a;
}

function topicRow(t, cats) {
  const li = h('li', 'fo-topic' + (t.pinned ? ' is-pinned' : '') + (t.hidden ? ' is-hidden' : ''));
  li.append(t.event ? dateChip(t.event.startsAt) : av(t.author, 36));
  const main = h('div', 'fo-topic-main');
  const title = link('#/forum/t/' + encodeURIComponent(t.id), 'fo-topic-t');
  if (t.pinned) title.append(h('span', 'fo-flag', '📌', { title: tr('Épinglé'), 'aria-label': tr('Épinglé') }));
  if (t.locked) title.append(h('span', 'fo-flag', '🔒', { title: tr('Verrouillé'), 'aria-label': tr('Verrouillé') }));
  if (t.hidden) title.append(h('span', 'fo-flag', '🚫', { title: tr('Masqué'), 'aria-label': tr('Masqué') }));
  title.append(document.createTextNode(t.title));
  const sub = h('div', 'fo-topic-sub');
  sub.append(h('span', null, nameOf(t.author)));
  if (t.event) sub.append(h('span', 'fo-dim', '· ' + whenText(t.event.startsAt) + ' · ' + tn(t.event.going, '{n} inscrit', '{n} inscrits')));
  if (cats) {
    const cat = cats.find((c) => c.id === t.categoryId);
    if (cat) sub.append(h('span', 'fo-dim', '· ' + cat.icon + ' ' + cat.name));
  }
  main.append(title, sub);
  const stats = h('div', 'fo-topic-stats');
  stats.append(h('span', 'fo-replies', String(t.replyCount), { title: tr('Réponses'), 'aria-label': tr('{replyCount} réponses', { replyCount: t.replyCount }) }));
  const last = h('span', 'fo-last');
  last.append(av(t.lastPoster, 22), h('span', 'fo-dim', ago(t.lastPostAt)));
  stats.append(last);
  li.append(main, stats);
  return li;
}

function sectionHead(title, lede, action) {
  const head = h('div', 'fo-sechead');
  const t = h('div');
  t.append(h('h2', 'fo-h2', title));
  if (lede) t.append(h('p', 'fo-dim fo-seclede', lede));
  head.append(t);
  if (action) head.append(action);
  return head;
}

/** Compteur animé (ou direct si l'utilisateur limite les animations). */
function countUp(el, to) {
  const fmt = (n) => n.toLocaleString('fr-FR');
  if (reduceMotion() || to < 10) { el.textContent = fmt(to); return; }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 700);
    el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function statsEl(stats) {
  const dl = h('dl', 'fo-stats');
  for (const [label, n] of [[tr('Sujets'), stats.topics], [tr('Messages'), stats.posts], [tr('Membres qui écrivent'), stats.members], [tr('Messages aujourd’hui'), stats.postsToday]]) {
    const box = h('div', 'fo-stat');
    const dd = h('dd', 'fo-stat-n', '0');
    box.append(h('dt', 'fo-stat-l', label), dd);
    dl.append(box);
    countUp(dd, n);
  }
  return dl;
}

function feedItem(t, cats, i) {
  const li = h('li', 'fo-feed-item fo-rise', null, { style: '--i:' + i });
  li.append(av(t.lastPoster, 38));
  const main = h('div', 'fo-feed-main');
  const who = h('p', 'fo-feed-who');
  who.append(h('strong', null, nameOf(t.lastPoster)), document.createTextNode(t.replyCount ? ' ' + tr('a répondu') : ' ' + tr('a ouvert le sujet')), h('span', 'fo-dim', ' · il y a ' + ago(t.lastPostAt)));
  main.append(who, link('#/forum/t/' + encodeURIComponent(t.id), 'fo-feed-t', t.title));
  if (t.excerpt) main.append(h('p', 'fo-feed-ex', t.excerpt));
  const meta = h('div', 'fo-feed-meta');
  const cat = cats.find((c) => c.id === t.categoryId);
  if (cat) meta.append(link('#/forum/c/' + encodeURIComponent(cat.id), 'fo-tag', cat.icon + ' ' + cat.name));
  meta.append(h('span', 'fo-dim', tn(t.replyCount, '{n} réponse', '{n} réponses')));
  main.append(meta);
  li.append(main);
  return li;
}

function trendingEl(list) {
  const ol = h('ol', 'fo-trend');
  const max = Math.max(1, ...list.map((t) => t.heat));
  list.forEach((t, i) => {
    const li = h('li', 'fo-trend-item fo-rise', null, { style: '--i:' + i });
    li.append(h('span', 'fo-trend-rank', String(i + 1), { 'aria-hidden': 'true' }));
    const main = h('div', 'fo-trend-main');
    main.append(link('#/forum/t/' + encodeURIComponent(t.id), 'fo-trend-t', t.title));
    const bar = h('span', 'fo-heat', null, { 'aria-hidden': 'true' });
    bar.append(h('span', 'fo-heat-in', null, { style: 'width:' + Math.round((t.heat / max) * 100) + '%' }));
    main.append(bar, h('span', 'fo-dim', tn(t.heat, '{n} message', '{n} messages') + ' cette semaine'));
    li.append(main);
    ol.append(li);
  });
  return ol;
}

function membersEl(list) {
  const ul = h('ul', 'fo-members');
  list.forEach((m, i) => {
    const li = h('li', 'fo-member fo-rise', null, { style: '--i:' + i });
    li.append(av(m.author, 32));
    const main = h('div', 'fo-member-main');
    const name = h('span', 'fo-member-name', nameOf(m.author));
    const badge = roleBadge(m.author);
    if (badge) name.append(badge);
    main.append(name, h('span', 'fo-dim', tn(m.posts, '{n} message', '{n} messages') + ' ce mois-ci'));
    li.append(main);
    ul.append(li);
  });
  return ul;
}

/** Sections vivantes de l'accueil (séances, discussions, tendances, membres), reconstruites à chaque rafraîchissement. */
function pulseInto(box, data) {
  const { pulse, categories } = data;
  const now = Date.now();
  box.replaceChildren();
  const events = h('section', 'fo-sec', null, { 'aria-label': tr('Prochaines watch parties') });
  const propose = banned() ? null : link('#/forum/new/' + EVENT_CAT, 'btn btn-ghost', tr('Proposer une séance'));
  events.append(sectionHead(tr('Prochaines watch parties'), tr('Une date, un film, et tout le monde lance la lecture en même temps.'), propose));
  if (pulse.events.length) {
    const row = h('div', 'fo-evs');
    pulse.events.forEach((t) => row.append(eventCard(t, now)));
    events.append(row);
  } else {
    events.append(h('p', 'fo-empty fo-evempty', tr('Aucune séance de prévue. Propose la première : choisis une date, les membres s’inscrivent et le salon s’ouvre 15 minutes avant.')));
  }
  box.append(events);

  const grid = h('div', 'fo-grid');
  const feed = h('section', 'fo-sec fo-feed', null, { 'aria-label': tr('Dernières discussions') });
  feed.append(sectionHead(tr('Dernières discussions'), null, banned() ? null : link('#/forum/new', 'btn btn-ghost', tr('Nouveau sujet'))));
  if (pulse.recent.length) {
    const ul = h('ul', 'fo-feed-list');
    pulse.recent.forEach((t, i) => ul.append(feedItem(t, categories, i)));
    feed.append(ul);
  } else {
    feed.append(h('p', 'fo-empty', tr('Le forum attend son premier sujet. Une question, un bug, une idée : lance-toi !')));
  }
  const aside = h('aside', 'fo-aside');
  if (pulse.trending.length) {
    const sec = h('section', 'fo-sec fo-card', null, { 'aria-label': tr('En vue cette semaine') });
    sec.append(h('h2', 'fo-h2', tr('En vue cette semaine')), trendingEl(pulse.trending));
    aside.append(sec);
  }
  if (pulse.activeMembers.length) {
    const sec = h('section', 'fo-sec fo-card', null, { 'aria-label': tr('Membres actifs') });
    sec.append(h('h2', 'fo-h2', tr('Membres actifs')), membersEl(pulse.activeMembers));
    aside.append(sec);
  }
  grid.append(feed);
  if (aside.childNodes.length) grid.append(aside);
  box.append(grid);
}

/** Rafraîchissement de l'accueil toutes les 60 s tant qu'il est affiché et visible. */
let pulseTimer = null;
function stopPulse() {
  if (pulseTimer) clearInterval(pulseTimer);
  pulseTimer = null;
}

async function showHome(seq) {
  stopPulse();
  const body = shell(tr('Communauté'));
  body.classList.add('is-wide');
  body.append(h('p', 'row-msg', tr('Chargement…')));
  let data;
  try {
    homeCache = null;
    data = await ensureHome();
  } catch (e) {
    if (seq !== renderSeq) return;
    stateMsg(body, errText(e), () => route());
    return;
  }
  if (seq !== renderSeq) return;
  body.replaceChildren();
  const head = h('header', 'fo-hero');
  const ht = h('div', 'fo-hero-t');
  ht.append(h('p', 'fo-eyebrow', tr('Forum des membres')), h('h1', 'fo-h1', tr('Communauté')), h('p', 'fo-lede', tr('Entraide, bugs, idées, guides, cinéma et watch parties : l’espace des membres qui font vivre Laststream.')));
  const acts = h('div', 'fo-hero-acts');
  if (!banned()) acts.append(link('#/forum/new', 'btn btn-primary', tr('Nouveau sujet')), link('#/forum/new/' + EVENT_CAT, 'btn btn-ghost', tr('Proposer une watch party')));
  if (staff()) {
    const mod = link('#/forum/mod', 'btn btn-ghost fo-modbtn', tr('Modération'));
    if (data.openReports) mod.append(h('span', 'fo-pill', String(data.openReports), { 'aria-label': data.openReports + ' signalements' }));
    acts.append(mod);
  }
  ht.append(acts);
  head.append(ht, statsEl(data.pulse.stats));
  body.append(head);
  const notice = banNotice();
  if (notice) body.append(notice);

  const form = h('form', 'fo-search', null, { role: 'search' });
  const input = h('input', 'fo-search-in', null, { type: 'search', placeholder: tr('Rechercher un sujet, un message…'), 'aria-label': tr('Rechercher dans le forum'), minlength: 2, maxlength: 100 });
  form.append(input);
  const results = h('section', 'fo-results', null, { hidden: '', 'aria-live': 'polite' });
  const home = h('div', 'fo-home');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; home.hidden = false; return; }
    results.hidden = false;
    home.hidden = true;
    results.replaceChildren(h('p', 'row-msg', tr('Recherche…')));
    try {
      const r = await api.search(q);
      results.replaceChildren(h('h2', 'fo-h2', r.topics.length ? tr('Résultats pour « {q} »', { q }) : tr('Aucun sujet pour « {q} »', { q })));
      const ul = h('ul', 'fo-topics');
      r.topics.forEach((t) => ul.append(topicRow(t, data.categories)));
      results.append(ul);
    } catch (x) {
      results.replaceChildren(h('p', 'row-msg', errText(x)));
    }
  });
  input.addEventListener('input', () => { if (!input.value.trim()) { results.hidden = true; home.hidden = false; } });
  body.append(form, results, home);

  const live = h('section', 'fo-sec', null, { hidden: '', 'aria-label': tr('Watch parties en direct') });
  const pulseBox = h('div', 'fo-pulse');
  const cats = h('section', 'fo-sec', null, { 'aria-label': tr('Catégories') });
  cats.append(sectionHead(tr('Catégories'), null));
  const catGrid = h('div', 'fo-cats');
  data.categories.forEach((c) => catGrid.append(categoryCard(c)));
  cats.append(catGrid);
  home.append(live, pulseBox, cats);
  pulseInto(pulseBox, data);
  void liveRoomsInto(live, seq);

  pulseTimer = setInterval(async () => {
    if (seq !== renderSeq) { stopPulse(); return; }
    if (document.hidden || !home.isConnected) return;
    try {
      const fresh = await api.home();
      if (seq !== renderSeq) return;
      homeCache = fresh;
      pulseInto(pulseBox, fresh);
      void liveRoomsInto(live, seq);
    } catch {
      /* hors ligne : on garde l'affichage */
    }
  }, 60_000);
}

// ---------- Catégorie ----------

async function showCategory(seq, id) {
  const body = shell(tr('Forum'));
  body.append(h('p', 'row-msg', tr('Chargement…')));
  let data;
  let page;
  try {
    data = await ensureHome();
    page = await api.topics(id);
  } catch (e) {
    if (seq !== renderSeq) return;
    stateMsg(body, errText(e), () => route());
    return;
  }
  if (seq !== renderSeq) return;
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) { stateMsg(body, tr('Catégorie introuvable.')); return; }
  document.title = tr('{name} · Forum · Laststream', { name: cat.name });
  body.replaceChildren(crumbs([[tr('Forum'), '#/forum'], [cat.name]]));
  const head = h('header', 'fo-cathead');
  const ht = h('div');
  ht.append(h('h1', 'fo-h1', cat.icon + ' ' + cat.name), h('p', 'fo-lede', cat.description));
  head.append(ht);
  if (!banned() && (!cat.staffOnly || staff())) head.append(link('#/forum/new/' + encodeURIComponent(cat.id), 'btn btn-primary', tr('Nouveau sujet')));
  body.append(head);
  const notice = banNotice();
  if (notice) body.append(notice);
  const ul = h('ul', 'fo-topics');
  const more = h('button', 'btn btn-ghost fo-more', tr('Plus de sujets'), { type: 'button' });
  const fill = (p) => {
    p.topics.forEach((t) => ul.append(topicRow(t)));
    more.hidden = !p.more;
  };
  if (!page.topics.length) body.append(h('p', 'fo-empty', tr('Aucun sujet pour l’instant. Lance la discussion !')));
  fill(page);
  more.addEventListener('click', async () => {
    const lastNormal = [...page.topics].reverse().find((t) => !t.pinned);
    if (!lastNormal) return;
    more.disabled = true;
    try {
      page = await api.topics(id, lastNormal.lastPostAt);
      fill(page);
    } catch (e) {
      toast(errText(e));
    } finally {
      more.disabled = false;
    }
  });
  body.append(ul, more);
}

// ---------- Nouveau sujet ----------

async function showNew(seq, catId) {
  const body = shell(tr('Nouveau sujet'));
  let data;
  try {
    data = await ensureHome();
  } catch (e) {
    if (seq !== renderSeq) return;
    stateMsg(body, errText(e), () => route());
    return;
  }
  if (seq !== renderSeq) return;
  const allowed = data.categories.filter((c) => !c.staffOnly || staff());
  body.append(crumbs([[tr('Forum'), '#/forum'], [tr('Nouveau sujet')]]), h('h1', 'fo-h1', tr('Nouveau sujet')));
  if (banned()) { body.append(banNotice()); return; }
  const form = h('div', 'fo-newform');
  const catLab = h('label', 'fo-field');
  const select = h('select', 'fo-select', null, { 'aria-label': tr('Catégorie') });
  for (const c of allowed) {
    const o = h('option', null, c.icon + ' ' + c.name, { value: c.id });
    if (c.id === catId) o.selected = true;
    select.append(o);
  }
  catLab.append(h('span', 'fo-lab', tr('Catégorie')), select);
  const hint = h('p', 'fo-hint');
  const hints = {
    bugs: tr('Indique ton appareil (Android, Windows, TV…), la version de Laststream et les étapes pour reproduire le problème.'),
    extensions: tr('Pas de lien vers du contenu piraté : ces messages sont retirés.'),
    films: tr('Pense à masquer les révélations avec ||spoiler||.'),
    [EVENT_CAT]: tr('Dis ce que vous regarderez et comment le trouver. Les membres s’inscrivent, et tu ouvres le salon à partir de 15 minutes avant le début.'),
  };
  const start = defaultStart(Date.now());
  const when = h('fieldset', 'fo-when');
  const dateIn = h('input', 'fo-input', null, { type: 'date', value: start.date, 'aria-label': tr('Date de la séance') });
  const timeIn = h('input', 'fo-input', null, { type: 'time', value: start.time, step: 300, 'aria-label': tr('Heure de la séance') });
  const dLab = h('label', 'fo-field');
  dLab.append(h('span', 'fo-lab', tr('Date')), dateIn);
  const tLab = h('label', 'fo-field');
  tLab.append(h('span', 'fo-lab', tr('Heure')), timeIn);
  when.append(h('legend', 'fo-lab', tr('Séance')), dLab, tLab);
  const refreshHint = () => {
    hint.textContent = hints[select.value] || '';
    when.hidden = select.value !== EVENT_CAT;
  };
  select.addEventListener('change', refreshHint);
  refreshHint();
  const titleLab = h('label', 'fo-field');
  const title = h('input', 'fo-input', null, { type: 'text', maxlength: 120, placeholder: tr('Un titre clair et précis'), 'aria-label': tr('Titre') });
  titleLab.append(h('span', 'fo-lab', tr('Titre')), title);
  const comp = composer({
    placeholder: tr('Ton message (Markdown : **gras**, *italique*, > citation, ||spoiler||)'),
    submitLabel: tr('Publier'),
    onCancel: () => history.back(),
    async onSubmit(text) {
      if (title.value.trim().length < 3) throw new Error(tr('Le titre doit faire au moins 3 caractères.'));
      let startsAt;
      if (select.value === EVENT_CAT) {
        startsAt = parseLocal(dateIn.value, timeIn.value);
        if (!Number.isFinite(startsAt) || startsAt < Date.now() + 5 * MIN) throw new Error(tr('Choisis une date et une heure à venir pour la séance.'));
      }
      try {
        const r = await api.createTopic(select.value, title.value, text, startsAt);
        homeCache = null;
        go('#/forum/t/' + encodeURIComponent(r.topic.id));
      } catch (e) {
        throw new Error(errText(e));
      }
    },
  });
  form.append(catLab, hint, when, titleLab, comp.el);
  body.append(form);
  title.focus({ preventScroll: true });
}

// ---------- Sujet ----------

function reactionBar(post, onChange) {
  const bar = h('div', 'fo-reacts');
  const draw = () => {
    bar.replaceChildren();
    for (const r of post.reactions) {
      const b = h('button', 'fo-react' + (r.mine ? ' is-mine' : ''), r.emoji + ' ' + r.count, { type: 'button', 'aria-pressed': String(r.mine), 'aria-label': r.emoji + ' : ' + r.count });
      b.addEventListener('click', () => toggle(r.emoji, !r.mine));
      bar.append(b);
    }
    if (post.hidden || banned()) return;
    const add = h('button', 'fo-react fo-react-add', '☺+', { type: 'button', 'aria-label': tr('Réagir'), 'aria-expanded': 'false' });
    const pal = h('div', 'fo-palette', null, { hidden: '' });
    for (const emoji of api.FORUM_REACTIONS) {
      const e = h('button', 'fo-pal', emoji, { type: 'button', 'aria-label': tr('Réagir {emoji}', { emoji }) });
      e.addEventListener('click', () => { pal.hidden = true; const mine = post.reactions.find((r) => r.emoji === emoji && r.mine); toggle(emoji, !mine); });
      pal.append(e);
    }
    add.addEventListener('click', () => { pal.hidden = !pal.hidden; add.setAttribute('aria-expanded', String(!pal.hidden)); });
    bar.append(add, pal);
  };
  async function toggle(emoji, on) {
    try {
      const r = await api.react(post.id, emoji, on);
      post.reactions = r.reactions;
      draw();
      if (onChange) onChange();
    } catch (e) {
      toast(errText(e));
    }
  }
  draw();
  return bar;
}

function reportDialog(post, opener) {
  let reason = '';
  let details;
  openDialog({
    title: tr('Signaler ce message'),
    confirmLabel: tr('Signaler'),
    opener,
    build(body, ctl) {
      const list = h('div', 'fo-radios');
      for (const [id, label] of REASONS) {
        const lab = h('label', 'fo-radio');
        const rb = h('input', null, null, { type: 'radio', name: 'fo-reason', value: id });
        rb.addEventListener('change', () => { reason = id; ctl.setValid(true); });
        lab.append(rb, h('span', null, label));
        list.append(lab);
      }
      details = h('textarea', 'cvd-input fo-ta-sm', null, { maxlength: 500, rows: 3, placeholder: tr('Précisions (facultatif)'), 'aria-label': tr('Précisions') });
      body.append(list, details);
    },
    async onConfirm() {
      try {
        await api.report(post.id, reason, details.value.trim() || undefined);
        post.reported = true;
        toast(tr('Merci, l’équipe va regarder.'));
      } catch (e) {
        throw new Error(errText(e));
      }
    },
  });
}

function banDialog(author, opener, after) {
  let days = 7;
  let reason;
  openDialog({
    title: tr('Exclure {v} du forum', { v: (fullOf(author) || tr('ce membre')) }),
    confirmLabel: tr('Exclure'),
    opener,
    build(body, ctl) {
      body.append(h('p', 'cvd-hint', tr('Le membre pourra encore lire le forum, mais plus y écrire.')));
      const list = h('div', 'fo-radios');
      for (const [value, label] of BAN_CHOICES) {
        const lab = h('label', 'fo-radio');
        const rb = h('input', null, null, { type: 'radio', name: 'fo-ban', value: String(value) });
        if (value === 7) rb.checked = true;
        rb.addEventListener('change', () => { days = value; });
        lab.append(rb, h('span', null, label));
        list.append(lab);
      }
      reason = h('input', 'cvd-input', null, { type: 'text', maxlength: 300, placeholder: tr('Motif (visible par l’équipe)'), 'aria-label': tr('Motif') });
      body.append(list, reason);
      ctl.setValid(true);
    },
    async onConfirm() {
      try {
        await api.ban(author.pid, days, reason.value.trim() || undefined);
        toast(tr('Membre exclu du forum.'));
        if (after) after();
      } catch (e) {
        throw new Error(errText(e));
      }
    },
  });
}

function postEl(post, topic, ctx) {
  const art = h('article', 'fo-post' + (post.hidden ? ' is-hidden' : ''), null, { id: 'p-' + post.id });
  const side = h('div', 'fo-post-side');
  side.append(av(post.author, 40));
  const main = h('div', 'fo-post-main');
  const head = h('header', 'fo-post-head');
  head.append(h('span', 'fo-post-name', nameOf(post.author), { title: fullOf(post.author) }));
  const badge = roleBadge(post.author);
  if (badge) head.append(badge);
  const time = h('time', 'fo-dim', ago(post.createdAt), { datetime: new Date(post.createdAt).toISOString(), title: dateText(post.createdAt) });
  head.append(time);
  if (post.editedAt) head.append(h('span', 'fo-dim fo-edited', tr('· modifié'), { title: dateText(post.editedAt) }));
  main.append(head);

  const content = h('div', 'fo-post-body');
  const drawBody = () => {
    content.replaceChildren();
    if (post.hidden === 'author') content.append(h('p', 'fo-gone', tr('Message supprimé par son auteur.')));
    else if (post.hidden && !post.body) content.append(h('p', 'fo-gone', post.hidden === 'auto' ? tr('Message masqué après plusieurs signalements, en attente de l’équipe.') : tr('Message masqué par l’équipe.')));
    else {
      if (post.hidden) content.append(h('p', 'fo-gone', post.hidden === 'auto' ? tr('Masqué automatiquement (signalements) : visible par l’équipe seulement.') : tr('Masqué : visible par l’équipe seulement.')));
      content.append(renderMarkdown(post.body));
    }
  };
  drawBody();
  main.append(content);
  if (post.hidden !== 'author') main.append(reactionBar(post));

  const acts = h('div', 'fo-post-acts');
  const act = (label, fn, cls) => {
    const b = h('button', 'fo-act' + (cls ? ' ' + cls : ''), label, { type: 'button' });
    b.addEventListener('click', () => fn(b));
    acts.append(b);
    return b;
  };
  const canReply = !banned() && (!topic.locked || staff());
  if (canReply && post.hidden === '') act(tr('Citer'), () => ctx.quote(post));
  if (post.canEdit) {
    act(tr('Modifier'), () => {
      const editor = composer({
        placeholder: tr('Ton message'),
        submitLabel: tr('Enregistrer'),
        initial: post.body,
        autofocus: true,
        onCancel: () => editor.el.replaceWith(content),
        async onSubmit(text) {
          try {
            const r = await api.editPost(post.id, text);
            Object.assign(post, r.post);
            drawBody();
            editor.el.replaceWith(content);
            const edited = head.querySelector('.fo-edited');
            if (!edited) head.append(h('span', 'fo-dim fo-edited', tr('· modifié')));
          } catch (e) {
            throw new Error(errText(e));
          }
        },
      });
      content.replaceWith(editor.el);
    });
    act(tr('Supprimer'), async (b) => {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = tr('Confirmer la suppression'); setTimeout(() => { b.dataset.confirm = ''; b.textContent = tr('Supprimer'); }, 4000); return; }
      try {
        const r = await api.deletePost(post.id);
        homeCache = null;
        if (r.topicRemoved) { toast(tr('Sujet supprimé.')); go('#/forum/c/' + encodeURIComponent(topic.categoryId)); return; }
        post.hidden = 'author';
        post.body = '';
        art.replaceWith(postEl(post, topic, ctx));
      } catch (e) {
        toast(errText(e));
      }
    }, 'is-danger');
  }
  if (ctx.me.pid !== post.author.pid && post.hidden !== 'author') {
    const rep = act(post.reported ? tr('Signalé') : tr('Signaler'), (b) => reportDialog(post, b));
    if (post.reported) rep.disabled = true;
  }
  if (staff() && post.hidden !== 'author') {
    act(post.hidden ? tr('Rétablir') : tr('Masquer'), async () => {
      try {
        await api.moderatePost(post.id, !post.hidden);
        ctx.reload();
      } catch (e) {
        toast(errText(e));
      }
    }, 'is-mod');
    if (post.author.role === 'member' && post.author.handle) act(tr('Exclure l’auteur'), (b) => banDialog(post.author, b), 'is-mod');
  }
  main.append(acts);
  art.append(side, main);
  return art;
}

function staffBar(topic, cats, reload) {
  const bar = h('div', 'fo-staffbar', null, { role: 'group', 'aria-label': tr('Modération du sujet') });
  const flag = (label, key) => {
    const b = h('button', 'fo-act is-mod', label(topic[key]), { type: 'button', 'aria-pressed': String(topic[key]) });
    b.addEventListener('click', async () => {
      try {
        await api.setTopic(topic.id, { [key]: !topic[key] });
        homeCache = null;
        reload();
      } catch (e) {
        toast(errText(e));
      }
    });
    bar.append(b);
  };
  flag((on) => (on ? tr('Désépingler') : tr('Épingler')), 'pinned');
  flag((on) => (on ? tr('Déverrouiller') : tr('Verrouiller')), 'locked');
  flag((on) => (on ? tr('Rendre visible') : tr('Masquer le sujet')), 'hidden');
  const move = h('select', 'fo-select fo-select-sm', null, { 'aria-label': tr('Déplacer vers') });
  for (const c of cats) {
    const o = h('option', null, tr('Déplacer : {name}', { name: c.name }), { value: c.id });
    if (c.id === topic.categoryId) o.selected = true;
    move.append(o);
  }
  move.addEventListener('change', async () => {
    try {
      await api.setTopic(topic.id, { categoryId: move.value });
      homeCache = null;
      toast(tr('Sujet déplacé.'));
      reload();
    } catch (e) {
      toast(errText(e));
    }
  });
  bar.append(move);
  return bar;
}

/**
 * Sujet alimenté par le bouton feedback de l'app (LAST-1654) : nombre de membres concernés ; pour l'équipe, références des
 * événements Sentry (le détail technique, privé, est là-bas), à copier pour la recherche Sentry.
 */
function feedbackPanel(fb) {
  const box = h('div', 'fo-fbpanel');
  box.append(h('p', 'fo-fbpanel-t', tr('🐞 Signalé depuis l’app par {reporters}', { reporters: tn(fb.reporters, '{n} membre', '{n} membres') })));
  if (fb.sentryEventIds && fb.sentryEventIds.length) {
    const refs = h('p', 'fo-dim fo-fbpanel-refs', tr('Équipe · références Sentry :') + ' ');
    fb.sentryEventIds.slice(0, 5).forEach((id, i) => {
      if (i) refs.append(document.createTextNode(', '));
      refs.append(h('code', '', id));
    });
    box.append(refs);
  }
  return box;
}

async function showTopic(seq, id) {
  const body = shell(tr('Forum'));
  body.append(h('p', 'row-msg', tr('Chargement…')));
  let data;
  let topic;
  try {
    data = await ensureHome();
    topic = (await api.topic(id)).topic;
  } catch (e) {
    if (seq !== renderSeq) return;
    stateMsg(body, errText(e), () => route());
    return;
  }
  if (seq !== renderSeq) return;
  const cat = data.categories.find((c) => c.id === topic.categoryId);
  document.title = tr('{title} · Forum · Laststream', { title: topic.title });
  body.replaceChildren(crumbs([[tr('Forum'), '#/forum'], [cat ? cat.name : tr('Catégorie'), '#/forum/c/' + encodeURIComponent(topic.categoryId)], [topic.title]]));
  const head = h('header', 'fo-topichead');
  const title = h('h1', 'fo-h1 fo-topic-title');
  if (topic.pinned) title.append(h('span', 'fo-flag', '📌', { 'aria-label': tr('Épinglé') }));
  if (topic.locked) title.append(h('span', 'fo-flag', '🔒', { 'aria-label': tr('Verrouillé') }));
  title.append(document.createTextNode(topic.title));
  head.append(title, h('p', 'fo-dim', (topic.replyCount + 1) + (topic.replyCount ? ' messages' : ' message') + ' ' + tr('· ouvert par {author}', { author: nameOf(topic.author) }) + ' ' + (ago(topic.createdAt) === 'à l’instant' ? tr('à l’instant') : 'il y a ' + ago(topic.createdAt))));
  body.append(head);
  const reload = () => { if (seq === renderSeq) void showTopic(++renderSeq, id); };
  if (topic.event) body.append(eventPanel(topic, data.me, reload));
  if (topic.feedback) body.append(feedbackPanel(topic.feedback));
  if (staff()) body.append(staffBar(topic, data.categories, reload));
  const notice = banNotice();
  if (notice) body.append(notice);

  const list = h('div', 'fo-posts');
  let comp = null;
  const ctx = {
    me: data.me,
    reload,
    quote(post) {
      if (!comp) return;
      comp.insert(quoteOf(fullOf(post.author), post.body));
      comp.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  };
  topic.posts.forEach((p) => list.append(postEl(p, topic, ctx)));
  body.append(list);
  const more = h('button', 'btn btn-ghost fo-more', tr('Messages suivants'), { type: 'button' });
  more.hidden = !topic.more;
  more.addEventListener('click', async () => {
    const last = topic.posts[topic.posts.length - 1];
    more.disabled = true;
    try {
      const next = (await api.topic(id, last.createdAt)).topic;
      next.posts.forEach((p) => { topic.posts.push(p); list.append(postEl(p, topic, ctx)); });
      more.hidden = !next.more;
    } catch (e) {
      toast(errText(e));
    } finally {
      more.disabled = false;
    }
  });
  body.append(more);

  if (banned()) return;
  if (topic.locked && !staff()) { body.append(h('p', 'fo-notice', tr('🔒 Ce sujet est verrouillé : on ne peut plus y répondre.'))); return; }
  comp = composer({
    placeholder: tr('Ta réponse (Markdown : **gras**, *italique*, > citation, ||spoiler||). Ctrl+Entrée pour envoyer.'),
    submitLabel: tr('Répondre'),
    async onSubmit(text) {
      try {
        const r = await api.reply(id, text);
        homeCache = null;
        if (!more.hidden) { reload(); return; }
        topic.posts.push(r.post);
        list.append(postEl(r.post, topic, ctx));
        comp.setText('');
        document.getElementById('p-' + r.post.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {
        throw new Error(errText(e));
      }
    },
  });
  const wrapReply = h('section', 'fo-reply', null, { 'aria-label': tr('Répondre') });
  wrapReply.append(h('h2', 'fo-h2', tr('Répondre')), comp.el);
  body.append(wrapReply);
}

/** Carte de séance d'un sujet de watch party : date, compte à rebours, inscrits, inscription, ouverture du salon. */
function eventPanel(topic, me, reload) {
  const ev = topic.event;
  const now = Date.now();
  const sec = h('section', 'fo-evpanel', null, { 'aria-label': tr('Séance de watch party') });
  sec.append(dateChip(ev.startsAt, true));
  const main = h('div', 'fo-evpanel-main');
  const live = now >= ev.startsAt && now <= ev.startsAt + OPEN_GRACE;
  main.append(h('span', 'fo-ev-when' + (live ? ' is-live' : ''), live ? tr('En cours') : untilText(ev.startsAt, now)));
  main.append(h('h2', 'fo-h2 fo-evpanel-t', tr('Séance du {startsAt}', { startsAt: whenText(ev.startsAt) })));
  const who = h('div', 'fo-attendees');
  const stack = h('span', 'fo-stack', null, { 'aria-hidden': 'true' });
  (topic.attendees || []).slice(0, 8).forEach((a) => stack.append(av(a, 28)));
  who.append(stack, h('span', 'fo-dim', tn(ev.going, '{n} inscrit', '{n} inscrits')));
  main.append(who);
  const acts = h('div', 'fo-ev-acts');
  if (ev.roomId) acts.append(link('#/party/' + encodeURIComponent(ev.roomId), 'btn btn-primary', tr('Rejoindre le salon')));
  acts.append(rsvpButton(topic, () => reload()));
  const host = topic.author.pid === me.pid || me.role !== 'member';
  if (host && !ev.roomId && !banned() && now <= ev.startsAt + OPEN_GRACE) {
    const open = h('button', 'btn btn-primary', tr('Ouvrir le salon'), { type: 'button' });
    const tooEarly = now < ev.startsAt - OPEN_LEAD;
    if (tooEarly) open.disabled = true;
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const r = await api.openEvent(topic.id);
        homeCache = null;
        go('#/party/' + encodeURIComponent(r.roomId));
      } catch (e) {
        toast(errText(e));
        open.disabled = false;
      }
    });
    acts.append(open);
    if (tooEarly) main.append(h('p', 'fo-dim', tr('Tu pourras ouvrir le salon à partir de {timeText} le jour J. Chaque participant lance ensuite sa propre source.', { timeText: timeText(ev.startsAt - OPEN_LEAD) })));
  }
  main.append(acts);
  sec.append(main);
  return sec;
}

// ---------- Modération ----------

async function showMod(seq) {
  const body = shell(tr('Modération du forum'));
  let data;
  try {
    data = await ensureHome();
  } catch (e) {
    if (seq !== renderSeq) return;
    stateMsg(body, errText(e), () => route());
    return;
  }
  if (seq !== renderSeq) return;
  body.append(crumbs([[tr('Forum'), '#/forum'], [tr('Modération')]]), h('h1', 'fo-h1', tr('Modération')));
  if (!staff()) { body.append(h('p', 'row-msg', tr('Réservé à l’équipe de modération.'))); return; }
  const reload = () => { if (seq === renderSeq) void showMod(++renderSeq); };

  // Signalements
  const repSec = h('section', 'fo-modsec');
  repSec.append(h('h2', 'fo-h2', tr('Messages signalés')));
  body.append(repSec);
  try {
    const { reports } = await api.reports();
    if (!reports.length) repSec.append(h('p', 'fo-empty', tr('Rien à traiter. 🎉')));
    for (const r of reports) {
      const card = h('div', 'fo-report');
      const top = h('div', 'fo-report-top');
      top.append(av(r.author, 28), h('strong', null, nameOf(r.author)), h('span', 'fo-dim', 'dans'), link('#/forum/t/' + encodeURIComponent(r.topicId), 'fo-link', r.topicTitle));
      top.append(h('span', 'fo-pill', r.count + (r.count > 1 ? ' signalements' : ' signalement')));
      card.append(top);
      card.append(h('p', 'fo-dim', r.reasons.map((x) => REASON_LABEL[x] || x).join(' · ') + (r.hidden === 'auto' ? ' ' + tr('· masqué automatiquement') : '')));
      for (const d of r.details) card.append(h('p', 'fo-report-detail', '« ' + d + ' »'));
      const quote = h('div', 'fo-report-body');
      quote.append(renderMarkdown(r.body));
      card.append(quote);
      const acts = h('div', 'fo-post-acts');
      const b1 = h('button', 'fo-act', tr('Garder le message'), { type: 'button' });
      b1.addEventListener('click', async () => { try { await api.dismissReports(r.postId); reload(); } catch (e) { toast(errText(e)); } });
      const b2 = h('button', 'fo-act is-danger', tr('Masquer le message'), { type: 'button' });
      b2.addEventListener('click', async () => { try { await api.moderatePost(r.postId, true); reload(); } catch (e) { toast(errText(e)); } });
      acts.append(b1, b2);
      if (r.author.role === 'member' && r.author.handle) {
        const b3 = h('button', 'fo-act is-mod', tr('Exclure l’auteur'), { type: 'button' });
        b3.addEventListener('click', () => banDialog(r.author, b3, reload));
        acts.append(b3);
      }
      card.append(acts);
      repSec.append(card);
    }
  } catch (e) {
    repSec.append(h('p', 'row-msg', errText(e)));
  }

  // Exclusions
  const banSec = h('section', 'fo-modsec');
  banSec.append(h('h2', 'fo-h2', tr('Membres exclus')));
  body.append(banSec);
  try {
    const { bans } = await api.bans();
    if (!bans.length) banSec.append(h('p', 'fo-empty', tr('Aucune exclusion en cours.')));
    const ul = h('ul', 'fo-plain');
    for (const b of bans) {
      const li = h('li', 'fo-person');
      li.append(av(b.author, 28), h('span', 'fo-person-n', fullOf(b.author) || tr('Compte supprimé')));
      li.append(h('span', 'fo-dim', (b.until === null ? tr('sans limite') : tr('jusqu’au {until}', { until: dateText(b.until) })) + (b.reason ? ' · ' + b.reason : '')));
      const lift = h('button', 'fo-act', tr('Lever'), { type: 'button' });
      lift.addEventListener('click', async () => { try { await api.unban(b.pid); reload(); } catch (e) { toast(errText(e)); } });
      li.append(lift);
      ul.append(li);
    }
    banSec.append(ul);
  } catch (e) {
    banSec.append(h('p', 'row-msg', errText(e)));
  }

  // Modérateurs (le propriétaire nomme et retire)
  const modSec = h('section', 'fo-modsec');
  modSec.append(h('h2', 'fo-h2', tr('Modérateurs')));
  body.append(modSec);
  try {
    const { moderators } = await api.moderators();
    const ul = h('ul', 'fo-plain');
    if (!moderators.length) modSec.append(h('p', 'fo-empty', tr('Pas encore de modérateur nommé : le propriétaire du serveur modère seul.')));
    for (const m of moderators) {
      const li = h('li', 'fo-person');
      li.append(av(m, 28), h('span', 'fo-person-n', fullOf(m) || tr('Compte supprimé')));
      if (data.me.role === 'owner') {
        const rm = h('button', 'fo-act is-danger', tr('Retirer'), { type: 'button' });
        rm.addEventListener('click', async () => { try { await api.removeModerator(m.pid); reload(); } catch (e) { toast(errText(e)); } });
        li.append(rm);
      }
      ul.append(li);
    }
    modSec.append(ul);
    if (data.me.role === 'owner') {
      const form = h('form', 'fo-addmod');
      const input = h('input', 'fo-input', null, { type: 'text', placeholder: tr('Nom#TAG du membre'), 'aria-label': tr('Handle du nouveau modérateur'), maxlength: 40 });
      const add = h('button', 'btn btn-primary', tr('Nommer'), { type: 'submit' });
      form.append(input, add);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        try {
          await api.addModerator(input.value.trim());
          toast(tr('Modérateur nommé.'));
          reload();
        } catch (x) {
          toast(x && x.status === 404 ? tr('Aucun membre avec ce Nom#TAG.') : errText(x));
        }
      });
      modSec.append(form);
    }
  } catch (e) {
    modSec.append(h('p', 'row-msg', errText(e)));
  }
}

// ---------- Entrée ----------

let current = { view: 'home' };

function route() {
  stopPulse();
  const seq = ++renderSeq;
  const v = current;
  if (v.view === 'cat') return showCategory(seq, v.id);
  if (v.view === 'topic') return showTopic(seq, v.id);
  if (v.view === 'new') return showNew(seq, v.id);
  if (v.view === 'mod') return showMod(seq);
  return showHome(seq);
}

/** Ouvre une vue du forum : `view` ∈ home | cat | topic | new | mod, `id` : catégorie ou sujet. */
export function showForum(view = 'home', id = '') {
  current = { view, id };
  void route();
}

/** Page quittée : un chargement en cours n'affichera plus rien. */
export function teardownForum() {
  stopPulse();
  renderSeq++;
}
