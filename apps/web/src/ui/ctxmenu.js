/* Menu contextuel de toute l'application : titres, épisodes, chaînes, personnes.
 * Ouverture : clic droit, appui long (500 ms), bouton « … » des tuiles, Maj+F10 / touche Menu.
 * Hors de nos éléments, le menu natif du navigateur reste disponible (sélection de texte, champs de saisie). */
import { userStore } from '../data/userStore';
import { isHiddenKey } from '../data/homeFilters';
import { isKidProfile } from '../data/auth';
import { LastAddonError } from '../data/errors';
import { UserApiError } from '../data/userApi';
import { toggleHidden } from './homeprefs.js';
import { fetchFull } from './ficheModel.js';
import { getDetail } from './catalog.js';
import { toast } from './dom.js';
import { nextToWatch } from './fiche.js';
import { ICON } from './icons.js';
import { inLib, renderLibrary, toggleLib } from './library.js';
import { openTrailer } from './modal.js';
import { hv } from './hover.js';
import { go } from './router.js';
import { openSources } from './sources-ui.js';
import { state } from './state.js';
import { getFavs } from './tv.js';
import { mark } from './watched.js';
import { esc } from './util.js';

const LONG_PRESS_MS = 500;
let pressTimer = null;

/** Autres modules (suivis, notes…) ajoutent leurs entrées : (cible) => [{ id, label, icon, run }]. */
const extrasOf = () => state.ctxExtras || [];

export function closeCtx(restoreFocus) {
  const m = state.ctxMenu;
  if (!m) return;
  const opener = m._opener;
  if (m._more) m._more.classList.remove('is-open');
  m.remove();
  state.ctxMenu = null;
  if (restoreFocus && opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
}

// ---------- Cibles ----------
export function ctxTarget(el) {
  if (!(el instanceof Element) || el.closest('.ctxmenu, input, textarea, select, [contenteditable="true"]')) return null;
  const ep = el.closest('.ep[data-ep]');
  if (ep && state.model) {
    const [s, e] = ep.dataset.ep.split(':').map(Number);
    return { kind: 'episode', el: ep, season: s, episode: e, model: state.model };
  }
  const hc = el.closest('#hovercard');
  if (hc && state.byKey.get(hv.key || '')) return { kind: 'title', el: hc, key: hv.key, inContinue: false };
  const ch = el.closest('[data-tvplay], .epg-row[data-chid]');
  if (ch) return { kind: 'channel', el: ch, id: ch.dataset.tvplay || ch.dataset.chid };
  const person = el.closest('[data-person]');
  if (person) return { kind: 'person', el: person, id: person.dataset.person };
  const t = el.closest('[data-tile], [data-open]');
  if (t) {
    const key = t.dataset.tile || t.dataset.open;
    if (key && state.byKey.get(key)) return { kind: 'title', el: t, key, inContinue: !!t.closest('#cont-slot') };
  }
  return null;
}

// ---------- Actions ----------
const resumeEntry = (key) => userStore.continueWatching().find((p) => p.key === key) || null;

export async function playTitle(key, opener, fromStart) {
  const it = state.byKey.get(key);
  const [type, id] = key.split(':');
  let season = null;
  let episode = null;
  if (type === 'tv') {
    const p = resumeEntry(key);
    if (p && p.season != null) {
      season = p.season;
      episode = p.episode;
    } else {
      try {
        await (userStore.loadWatched ? userStore.loadWatched(key) : null);
        const n = nextToWatch(await fetchFull(type, id));
        season = n ? n.s : 1;
        episode = n ? n.e : 1;
      } catch (_) { season = 1; episode = 1; }
    }
  }
  if (fromStart) {
    const p = resumeEntry(key);
    if (p) userStore.setProgress({ key: p.key, type: p.type, id: p.id, title: p.title, poster: p.poster, backdrop: p.backdrop, season: p.season, episode: p.episode, position: 0, duration: p.duration });
  }
  openSources({ type, id, name: it ? it.name : '', season, episode, key }, opener);
}

/** Retire un titre de « Reprendre la lecture » (la progression est conservée), avec annulation possible. */
export async function removeFromContinue(key) {
  const ok = await userStore.hideContinue(key);
  if (!ok) { toast('Impossible de retirer ce titre'); return; }
  const refresh = () => import('./home.js').then((h) => h.renderContinue());
  refresh();
  toast('Retiré de « Reprendre la lecture »', {
    ms: 5000,
    action: { label: 'Annuler', run: async () => { await userStore.showContinue(key); refresh(); } },
  });
}

/** Raison lisible d'un échec (ni URL, ni jeton, ni valeur de réglage). */
export function reasonOf(err) {
  if (err instanceof LastAddonError) {
    if (err.kind === 'network') return 'lastAddon est injoignable (réseau)';
    if (err.kind === 'not_configured') return 'lastAddon n’est pas configuré';
    if (err.kind === 'http') return err.status === 429 ? 'trop de requêtes, réessaie dans un instant' : 'lastAddon a répondu HTTP ' + err.status + (err.code ? ' (' + err.code + ')' : '');
    return 'réponse lastAddon illisible';
  }
  if (err instanceof UserApiError) {
    if (err.code === 'network') return 'serveur injoignable (réseau)';
    if (err.status === 429) return 'trop de requêtes, réessaie dans un instant';
    if (err.code === 'pin_required') return 'code du profil requis';
    if (err.code === 'unauthorized') return 'session expirée, reconnecte-toi';
    return 'serveur : ' + err.code + ' (HTTP ' + err.status + ')';
  }
  return (err && err.message) || 'erreur inconnue';
}

async function toggleSeriesWatched(key) {
  const [type, id] = key.split(':');
  const on = !userStore.watchedTitle(key);
  toast(on ? 'Marquage de la série…' : 'Série marquée comme non vue…');
  try {
    const m = await fetchFull(type, id);
    const { markSeries } = await import('./watched.js');
    await markSeries(m, on);
  } catch (err) {
    console.error('[laststream] série ' + key + ' : ' + (on ? 'marquage' : 'retrait') + ' impossible', err);
    toast('Impossible de marquer la série : ' + reasonOf(err));
  }
}

function titleItems(t) {
  const it = state.byKey.get(t.key);
  const [type, id] = t.key.split(':');
  const resume = resumeEntry(t.key);
  const items = [];
  if (!it.cinema) items.push({ id: 'play', label: resume || (type === 'tv' && userStore.watchedEpisodes(t.key).length) ? 'Reprendre' : 'Lecture', icon: ICON.play, run: () => playTitle(t.key, t.el, false) });
  items.push({ id: 'info', label: 'Plus d’infos', icon: ICON.info, run: () => go('#/' + type + '/' + id, t.el) });
  items.push({
    id: 'trailer', label: 'Bande-annonce', icon: ICON.film,
    run: async () => { const d = await getDetail(it); if (d && d.trailer) openTrailer(it, t.el); else toast('Pas de bande-annonce pour ce titre'); },
  });
  const on = inLib(t.key);
  items.push({
    id: 'lib', label: on ? 'Retirer de ma bibliothèque' : 'Ajouter à ma bibliothèque', icon: on ? ICON.check : ICON.list,
    run: () => { const now = toggleLib({ type, id: it.id, name: it.name, posterPath: it.posterPath }); toast(now ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque'); renderLibrary(); },
  });
  extrasOf().forEach((fn) => fn(t).forEach((x) => items.push(x)));
  if (type === 'movie') {
    const seen = userStore.isWatched(t.key);
    items.push({ id: 'seen', label: seen ? 'Marquer comme non vu' : 'Marquer comme vu', icon: ICON.check, run: () => mark(t.key, null, !seen) });
  } else {
    const any = !!userStore.watchedTitle(t.key);
    items.push({ id: 'seen', label: any ? 'Marquer la série comme non vue' : 'Marquer la série comme vue', icon: ICON.check, run: () => toggleSeriesWatched(t.key) });
  }
  if (!isKidProfile()) { // profil enfant : pas de « Ne plus proposer » (accueil déjà filtré)
    const hidden = isHiddenKey(t.key);
    items.push({ id: 'hide', label: hidden ? 'Réafficher sur l’accueil' : 'Ne plus proposer', icon: ICON.close, run: () => toggleHidden(t.key, it.name, it.posterPath) });
  }
  if (t.inContinue || resume) {
    items.push({ id: 'restart', label: 'Recommencer depuis le début', icon: ICON.back, run: () => playTitle(t.key, t.el, true) });
    items.push({ id: 'remove', label: 'Retirer de « Reprendre la lecture »', icon: ICON.close, run: () => removeFromContinue(t.key) });
  }
  return items;
}

function episodeItems(t) {
  const m = t.model;
  const seen = userStore.isWatched(m.key, t.season, t.episode);
  return [
    { id: 'play', label: 'Lire', icon: ICON.play, run: () => openSources({ type: 'tv', id: String(m.id), name: m.name, season: t.season, episode: t.episode, key: m.key }, t.el) },
    { id: 'seen', label: seen ? 'Marquer comme non vu' : 'Marquer comme vu', icon: ICON.check, run: () => mark(m.key, [{ season: t.season, episode: t.episode }], !seen) },
    { id: 'upto', label: 'Vu jusqu’ici', icon: ICON.check, run: () => { const b = t.el.querySelector('[data-upto]'); if (b) b.click(); } },
  ];
}

function channelItems(t) {
  const fav = getFavs().includes(t.id);
  return [
    { id: 'watch', label: 'Regarder', icon: ICON.play, run: () => { const b = t.el.matches('[data-tvplay]') ? t.el : t.el.querySelector('[data-tvplay]'); if (b) b.click(); } },
    {
      id: 'fav', label: fav ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: fav ? ICON.starOn : ICON.star,
      run: () => { const b = document.querySelector('[data-tvfav="' + t.id.replace(/"/g, '\\"') + '"]'); if (b) b.click(); else toast('Ouvre le guide TV pour gérer tes favoris'); },
    },
  ];
}

function personItems(t) {
  const items = [{ id: 'person', label: 'Voir la fiche', icon: ICON.info, run: () => go('#/person/' + t.id, t.el) }];
  extrasOf().forEach((fn) => fn(t).forEach((x) => items.push(x)));
  return items;
}

export function ctxItems(t) {
  if (t.kind === 'title') return titleItems(t);
  if (t.kind === 'episode') return episodeItems(t);
  if (t.kind === 'channel') return channelItems(t);
  return personItems(t);
}

// ---------- Rendu ----------
export function openCtx(t, x, y) {
  closeCtx();
  const items = ctxItems(t);
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'ctxmenu glass';
  menu.setAttribute('role', 'menu');
  menu.dataset.kind = t.kind;
  if (t.key) menu.dataset.key = t.key;
  menu.innerHTML = items.map((it) => '<button type="button" role="menuitem" data-ctx="' + esc(it.id) + '">' + (it.icon || '') + '<span>' + esc(it.label) + '</span></button>').join('');
  menu._opener = t.el;
  document.body.appendChild(menu);
  state.ctxMenu = menu;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  const buttons = Array.from(menu.querySelectorAll('button'));
  menu.addEventListener('click', (e) => {
    const b = e.target instanceof Element && e.target.closest('[data-ctx]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const item = items.find((i) => i.id === b.dataset.ctx);
    closeCtx(false);
    if (item) Promise.resolve(item.run()).catch((err) => {
      console.error('[laststream] menu contextuel : « ' + item.id + ' » impossible', err);
      toast('Action impossible : ' + reasonOf(err));
    });
  });
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length].focus();
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length].focus();
    else if (e.key === 'Home') buttons[0].focus();
    else if (e.key === 'End') buttons[buttons.length - 1].focus();
    else if (e.key === 'Tab') closeCtx(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  buttons[0].focus();
}

const pointOf = (el, e) => {
  if (e && (e.clientX || e.clientY)) return [e.clientX, e.clientY];
  const r = el.getBoundingClientRect();
  return [r.left + Math.min(40, r.width / 2), r.top + Math.min(40, r.height / 2)];
};

document.addEventListener('contextmenu', (e) => {
  const t = ctxTarget(e.target);
  if (!t) return; // menu natif
  e.preventDefault();
  const [x, y] = pointOf(t.el, e);
  openCtx(t, x, y);
});

// Capture : « … » et « × » des tuiles passent avant l'ouverture de la fiche.
document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const more = el.closest('.t-more');
  if (more) {
    e.preventDefault();
    e.stopPropagation();
    const t = ctxTarget(more.closest('[data-tile]'));
    if (!t) return;
    // Second appui sur « … » : referme le menu qu'il a ouvert (sans quoi la capture le rouvrirait aussitôt).
    if (state.ctxMenu && state.ctxMenu._more === more) { closeCtx(true); return; }
    const r = more.getBoundingClientRect();
    openCtx(t, r.left, r.bottom + 4);
    if (state.ctxMenu) { state.ctxMenu._more = more; more.classList.add('is-open'); }
    return;
  }
  const rm = el.closest('[data-continue-remove]');
  if (rm) {
    e.preventDefault();
    e.stopPropagation();
    removeFromContinue(rm.dataset.continueRemove);
    return;
  }
  if (state.ctxMenu && !el.closest('.ctxmenu')) closeCtx(false);
}, true);

// Appui long (tactile / stylet).
document.addEventListener('pointerdown', (e) => {
  clearTimeout(pressTimer);
  if (e.pointerType === 'mouse' || !(e.target instanceof Element)) return;
  const t = ctxTarget(e.target);
  if (!t) return;
  const x = e.clientX;
  const y = e.clientY;
  pressTimer = setTimeout(() => {
    state.suppressClick = true;
    setTimeout(() => { state.suppressClick = false; }, 400);
    openCtx(t, x, y);
  }, LONG_PRESS_MS);
});
['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (ev === 'pointermove' && e.pointerType === 'mouse') return;
  clearTimeout(pressTimer);
}));

// Fermeture : défilement, redimensionnement, changement de page.
window.addEventListener('scroll', () => closeCtx(false), { passive: true });
window.addEventListener('resize', () => closeCtx(false));
window.addEventListener('hashchange', () => closeCtx(false));
