/* Discussions Social v3 (lot F3) : fabriques DOM partagées (icônes, avatar, boutons) et rendu d'un message (bulle, carte
 * « titre », carte « moment », invitation, sondage, réactions, citation). Tout texte passe par textContent. */
import { safeTmdbImage } from './safeImg.js';
import {
  QUICK_REACTIONS, authorName, colorOf, hhmm, initialOf, messageText, pollShare, pollTotal, posLabel, STATUS_COLOR,
} from './socialConvModel.js';


export const SVG = {
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  min: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/></svg>',
  party: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="m10 9 4 2-4 2z" fill="currentColor"/><path d="M8 21h8"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
  playL: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  smile: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg>',
  send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  reply: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/></svg>',
};

/** Élément avec classe, texte (textContent) et attributs facultatifs. */
export function h(tag, cls, text, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  return e;
}

/** Bouton icône (le SVG est une constante du module, jamais un texte serveur). */
export function iconBtn(cls, label, svg, onClick) {
  const b = h('button', cls, null, { type: 'button', 'aria-label': label, title: label });
  b.innerHTML = svg;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Avatar : initiale sur la couleur du profil ; l'illustration (data-avatar) est posée par avatar-art.js. */
export function avatarEl(p, size, dotStatus) {
  const a = h('span', 'cv-av', initialOf(p.name), { 'aria-hidden': 'true' });
  a.style.width = a.style.height = size + 'px';
  a.style.fontSize = Math.round(size * 0.42) + 'px';
  a.style.background = colorOf(p.avatarColor);
  if (p.avatar) a.dataset.avatar = p.avatar;
  if (dotStatus && STATUS_COLOR[dotStatus]) {
    const d = h('span', 'cv-dot');
    d.style.background = STATUS_COLOR[dotStatus];
    a.append(d);
  }
  return a;
}

/** URL d'affiche : https telle quelle, chemin TMDB converti ; sinon ''. */
export function posterSrc(p) {
  return safeTmdbImage(p, 'w342') || '';
}
export function stillSrc(p) {
  return safeTmdbImage(p, 'w500') || '';
}

/** Affiche (image) ou, sans image, tuile d'initiales. */
function posterEl(src, title, w, hgt) {
  const wrap = h('div', 'cvm-poster');
  wrap.style.width = w + 'px';
  wrap.style.height = hgt + 'px';
  const url = posterSrc(src);
  if (url) {
    const img = h('img', null, null, { alt: '', loading: 'lazy' });
    img.src = url;
    img.addEventListener('error', () => { img.remove(); wrap.textContent = title || ''; });
    wrap.append(img);
  } else {
    wrap.textContent = title || '';
  }
  return wrap;
}

const btn = (cls, text, onClick) => {
  const b = h('button', cls, text, { type: 'button' });
  if (onClick) b.addEventListener('click', onClick);
  return b;
};

/**
 * Carte « titre » : affiche, « Léa te recommande », titre, année · ★ note de Léa, Lire et + Ma liste.
 * ctx.act.read(titleRef, button), ctx.act.addToList(titleRef, button) et ctx.act.inList(titleRef) viennent du contrôleur.
 */
function titleCard(m, mine, ctx) {
  const t = m.title;
  const card = h('div', 'cvm-card cvm-title');
  card.append(posterEl(t.poster, t.title, 54, 80));
  const col = h('div', 'cvm-card-col');
  const who = authorName(m.from, ctx.info, ctx.s);
  col.append(h('div', 'cvm-card-kicker', mine ? 'Tu recommandes' : (who === 'Toi' ? 'Recommandé' : who + ' te recommande')));
  col.append(h('div', 'cvm-card-title', t.title));
  const meta = [t.year ? String(t.year) : '', typeof t.rating === 'number' ? '★ ' + t.rating + ' de ' + who.replace(/^Toi$/, 'moi') : ''].filter(Boolean).join(' · ');
  if (meta) col.append(h('div', 'cvm-card-meta', meta));
  const row = h('div', 'cvm-card-btns');
  const read = btn('cvm-btn is-accent', 'Lire', (e) => ctx.act.read(t, e.currentTarget));
  read.setAttribute('aria-label', 'Lire ' + t.title);
  const inList = ctx.act.inList(t);
  const add = btn('cvm-btn', inList ? '✓ Dans ma liste' : '+ Ma liste', (e) => ctx.act.addToList(t, e.currentTarget));
  add.setAttribute('aria-label', (inList ? 'Dans ma liste : ' : 'Ajouter à ma liste : ') + t.title);
  if (inList) add.disabled = true;
  row.append(read, add);
  col.append(row);
  card.append(col);
  return card;
}

/** Carte « moment » : image de la scène, pastille ▶ position, légende, lien « Titre · ouvrir à 1:12:34 ». */
function momentCard(m, ctx) {
  const mo = m.moment;
  const card = h('div', 'cvm-card cvm-moment');
  const shot = h('div', 'cvm-shot');
  const url = stillSrc(mo.still);
  if (url) {
    const img = h('img', null, null, { alt: '', loading: 'lazy' });
    img.src = url;
    img.addEventListener('error', () => img.remove());
    shot.append(img);
  } else {
    shot.append(h('span', 'cvm-shot-empty', mo.title));
  }
  const chip = h('span', 'cvm-chip');
  chip.innerHTML = SVG.play;
  chip.append(posLabel(mo.pos));
  shot.append(chip);
  card.append(shot);
  const body = h('div', 'cvm-moment-body');
  if (m.body) body.append(h('div', 'cvm-moment-text', m.body));
  const link = h('button', 'cvm-moment-link', mo.title + ' · ouvrir à ' + posLabel(mo.pos), { type: 'button', title: 'Ouvrir ce passage dans le lecteur' });
  link.addEventListener('click', (e) => ctx.act.playMoment(mo, e.currentTarget));
  body.append(link);
  card.append(body);
  return card;
}

function partyCard(m, ctx) {
  const card = h('div', 'cvm-card cvm-party');
  const col = h('div', 'cvm-card-col');
  col.append(h('div', 'cvm-card-kicker', 'Invitation à une watch party'));
  col.append(h('div', 'cvm-card-title', m.party.title));
  const row = h('div', 'cvm-card-btns');
  row.append(btn('cvm-btn is-accent', 'Rejoindre', () => ctx.act.joinParty(m.party.partyId)));
  col.append(row);
  card.append(col);
  return card;
}

/** Sondage : question, options en barres (part des votes), vote au clic, total. */
function pollCard(m, ctx) {
  const p = m.poll;
  const card = h('div', 'cvm-card cvm-poll');
  card.append(h('div', 'cvm-poll-q', 'Sondage · ' + p.question));
  const list = h('div', 'cvm-poll-opts', null, { role: 'group', 'aria-label': 'Options du sondage' });
  for (const o of p.options) {
    const b = h('button', 'cvm-opt' + (o.mine ? ' is-mine' : ''), null, { type: 'button', 'aria-pressed': o.mine ? 'true' : 'false' });
    const bar = h('span', 'cvm-opt-bar');
    bar.style.width = pollShare(p, o) + '%';
    b.append(bar, h('span', 'cvm-opt-label', o.label), h('span', 'cvm-opt-n', String(o.votes)));
    b.setAttribute('aria-label', o.label + ', ' + o.votes + ' vote' + (o.votes > 1 ? 's' : '') + (o.mine ? ', ton choix' : ''));
    if (p.closed) b.disabled = true;
    else b.addEventListener('click', () => ctx.act.vote(m, o.id));
    list.append(b);
  }
  card.append(list);
  const n = pollTotal(p);
  card.append(h('div', 'cvm-poll-foot', (p.closed ? 'Sondage terminé · ' : '') + n + ' vote' + (n > 1 ? 's' : '')));
  return card;
}

/** Bloc cité au-dessus d'un message qui répond à un autre. */
function quoteEl(m, ctx) {
  const q = ctx.byId(m.replyTo);
  const box = h('div', 'cvm-quote');
  if (q) {
    box.append(h('b', null, authorName(q.from, ctx.info, ctx.s)), h('span', null, messageText(q)));
  } else {
    box.append(h('span', null, 'Message d’origine indisponible'));
  }
  return box;
}

/** Pastilles de réaction (clic = bascule). */
function reactionsEl(m, ctx) {
  const row = h('div', 'cvm-rxs');
  for (const r of m.reactions) {
    if (!(r.count > 0)) continue;
    const b = h('button', 'cvm-rx' + (r.mine ? ' is-mine' : ''), r.emoji + ' ' + r.count, {
      type: 'button', 'aria-pressed': r.mine ? 'true' : 'false', 'aria-label': 'Réaction ' + r.emoji + ', ' + r.count + (r.mine ? ', la tienne' : ''),
    });
    b.addEventListener('click', () => ctx.act.react(m, r.emoji));
    row.append(b);
  }
  return row.childElementCount ? row : null;
}

/** Barre de réactions (appui long ou survol) : emojis rapides, ↩ répondre, plus d'emojis. */
export function reactionBar(m, ctx) {
  const bar = h('div', 'cvm-bar', null, { role: 'toolbar', 'aria-label': 'Réagir au message' });
  for (const r of QUICK_REACTIONS) {
    const mine = m.reactions.some((x) => x.emoji === r.emoji && x.mine);
    const b = h('button', 'cvm-bar-em' + (mine ? ' is-on' : ''), r.emoji, { type: 'button', 'aria-label': 'Réagir : ' + r.name, 'aria-pressed': mine ? 'true' : 'false' });
    b.addEventListener('click', () => ctx.act.react(m, r.emoji));
    bar.append(b);
  }
  bar.append(h('button', 'cvm-bar-em is-text', '↩', { type: 'button', 'aria-label': 'Répondre' }));
  bar.lastChild.addEventListener('click', () => ctx.act.reply(m));
  return bar;
}

/** Une ligne de message complète. `ctx` : { me, info, s, byId, act, barFor, mobile }. */
export function messageRow(m, ctx) {
  const mine = m.from === ctx.me;
  const row = h('div', 'cvm-row ' + (mine ? 'is-mine' : 'is-theirs'), null, { 'data-id': m.id });
  if (ctx.info && ctx.info.kind === 'group' && !mine) row.append(h('div', 'cvm-from', authorName(m.from, ctx.info, ctx.s)));
  const wrap = h('div', 'cvm-wrap');
  if (m.replyTo) wrap.append(quoteEl(m, ctx));
  let content;
  const kind = m.kind || 'text';
  if (kind === 'title' && m.title) content = titleCard(m, mine, ctx);
  else if (kind === 'moment' && m.moment) content = momentCard(m, ctx);
  else if (kind === 'party' && m.party) content = partyCard(m, ctx);
  else if (kind === 'poll' && m.poll) content = pollCard(m, ctx);
  else {
    content = h('div', 'cvm-bub', m.body || '');
    content.title = Number.isFinite(m.createdAt) ? hhmm(m.createdAt) : '';
    if (m.context) {
      const c = m.context;
      const b = h('button', 'ss-chat-ctx', (typeof c.pos === 'number' ? 'à ' + posLabel(c.pos) + ' ' : '') + 'dans un titre', { type: 'button' });
      b.addEventListener('click', (e) => ctx.act.playMoment({ type: c.type, tmdbId: c.tmdbId, season: c.season, episode: c.episode, title: '', pos: c.pos || 0 }, e.currentTarget));
      content = h('div', 'cvm-bub-ctx');
      content.append(h('div', 'cvm-bub', m.body || ''), b);
    }
  }
  wrap.append(content);
  // Actions au survol / focus (bureau) ; sur mobile, l'appui long ouvre la barre.
  if (!ctx.mobile) {
    const acts = h('div', 'cvm-acts');
    acts.append(
      iconBtn('cvm-act', 'Réagir', SVG.smile.replace(/width="18" height="18"/, 'width="16" height="16"'), () => ctx.act.toggleBar(m)),
      iconBtn('cvm-act', 'Répondre', SVG.reply, () => ctx.act.reply(m)),
    );
    wrap.append(acts);
  }
  if (ctx.barFor === m.id) wrap.append(reactionBar(m, ctx));
  row.append(wrap);
  const rx = reactionsEl(m, ctx);
  if (rx) row.append(rx);
  return row;
}
