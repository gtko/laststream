/* Menu contextuel de toute l'application : titres, épisodes, chaînes, personnes.
 * Ouverture : clic droit, appui long (500 ms), bouton « … » des tuiles, Maj+F10 / touche Menu.
 * Hors de nos éléments, le menu natif du navigateur reste disponible (sélection de texte, champs de saisie). */
import { userStore } from '../data/userStore';
import { isHiddenKey } from '../data/homeFilters';
import { isKidProfile, isServerMode } from '../data/auth';
import { LastAddonError } from '../data/errors';
import { UserApiError } from '../data/userApi';
import { toggleHidden } from './homeprefs.js';
import { fetchFull } from './ficheModel.js';
import { getDetail } from './catalog.js';
import { isFuture } from './dates.js';
import { runOnce, TOGGLE_COOLDOWN_MS } from './busy.js';
import { toast } from './dom.js';
import { downloadsAllowed, ficheDownloadMenuItems, startDownload } from './downloadBtn.js';
import { platformAvailability } from '../downloads/service';
import { nextToWatch, partyKind } from './fiche.js';
import { ICON } from './icons.js';
import { inLib, renderLibrary, toggleLib } from './library.js';
import { openTrailer, openVideo } from './modal.js';
import { hv } from './hover.js';
import { go } from './router.js';
import { openPartyDialog } from './partylaunch.js';
import { socialAvailable } from './socialButton.js';
import { openShareDialog } from './socialHooks.js';
import { openSources } from './sources-ui.js';
import { state } from './state.js';
import { getFavs } from './tv.js';
import { mark } from './watched.js';
import { esc } from './util.js';
import { setOpenState } from './disclosure.js';
import { pushLayer } from './backStack.js';

const LONG_PRESS_MS = 500;
const HINT_KEY = 'ls.ctxHintSeen';

/** Téléchargement proposé dans le menu (ODY-238) : profil adulte et appareil compatible seulement. */
function canDownload() {
  try { return downloadsAllowed() && platformAvailability().ok; } catch (_) { return false; }
}

/** Astuce du premier usage : une seule fois par appareil, jamais bloquante si le stockage est refusé. */
function takeHint() {
  try {
    if (localStorage.getItem(HINT_KEY)) return false;
    localStorage.setItem(HINT_KEY, '1');
    return true;
  } catch (_) { return false; }
}
let pressTimer = null;

/** Autres modules (suivis, notes…) ajoutent leurs entrées : (cible) => [{ id, label, icon, run }]. */
const extrasOf = () => state.ctxExtras || [];

export function closeCtx(restoreFocus) {
  const m = state.ctxMenu;
  if (!m) return;
  const opener = m._opener;
  if (m._more) setOpenState(m._more, false);
  if (m._releaseBack) m._releaseBack();
  if (m._scrim) m._scrim.remove();
  m.remove();
  state.ctxMenu = null;
  if (restoreFocus && opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
}

// ---------- Cibles ----------
/** Clé d'un titre : `movie:<id>` ou `tv:<id>`. */
const TITLE_KEY = /^(movie|tv):\d+$/;

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
    // Clé de titre (movie:/tv:) hors catalogue chargé : résolue à l'action (minimalItem).
    if (key && (state.byKey.get(key) || TITLE_KEY.test(key))) return { kind: 'title', el: t, key, inContinue: !!t.closest('#cont-slot') };
  }
  // Bannière de la mise en avant (et ses boutons), rangée à venir, émission : titre résolu même hors catalogue chargé.
  const slide = el.closest('[data-slide-key]');
  if (slide && slide.dataset.slideKey) return { kind: 'title', el: slide, key: slide.dataset.slideKey, inContinue: false };
  const soon = el.closest('[data-play-key]');
  if (soon && soon.dataset.playKey) return { kind: 'title', el: soon, key: soon.dataset.playKey, inContinue: false };
  const show = el.closest('[data-showopen]');
  if (show && /^\d+$/.test(show.dataset.showopen)) return { kind: 'show', el: show, key: 'tv:' + show.dataset.showopen, inContinue: false };
  // Affiche de fond et logo de la fiche ouverte.
  if (state.kind === 'fiche' && state.model && el.matches('.f-bg img, img.f-logo')) return { kind: 'fiche', el, model: state.model };
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
  const name = it ? it.name : await fetchFull(type, id).then((m) => m.name, () => '');
  openSources({ type, id, name, season, episode, key }, opener);
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

// ---------- Verrou des actions du menu (ODY-257) ----------
/** Bascules (bibliothèque, vu, favori, masquer) : un second choix dans le délai de redéclenchement ne les annule pas. */
const LOCKED_ITEMS = new Set(['lib', 'seen', 'upto', 'fav', 'hide', 'remove']);
/** Une clé par cible et par action : l'action tourne une fois à la fois, même si le menu est rouvert aussitôt. */
export const ctxLockKey = (t, id) => 'ctx:' + t.kind + ':' + (t.key || (t.model && t.model.key) || t.id || '') + (t.season != null ? ':' + t.season + ':' + t.episode : '') + ':' + id;

// ---------- Titres hors catalogue chargé ----------
/** Titre dont la clé n'est pas dans state.byKey (émission, rangée à venir, mise en avant hors liste) : nom et affiche viennent de la fiche, à l'action. */
function minimalItem(key) {
  const [type, id] = key.split(':');
  return { key, type, id: Number(id), name: '', posterPath: null };
}
const itemOf = (t) => state.byKey.get(t.key) || minimalItem(t.key);

/** Nom et affiche : ceux du catalogue, ou ceux de la fiche chargée à la demande (mise en cache). */
async function named(it) {
  if (it.name) return it;
  const m = await fetchFull(it.type, it.id);
  return { ...it, name: m.name, posterPath: m.posterPath };
}
/** Lance `fn` avec nom et affiche : tout de suite quand le catalogue les connaît (action synchrone), sinon après la fiche. */
const withNamed = (it, fn) => (it.name ? fn(it) : named(it).then(fn));

const shareMedia = (m) => ({ type: m.type === 'tv' ? 'series' : 'movie', tmdbId: Number(m.id), title: m.name, poster: m.posterPath || undefined });

/** Suite de `v` : tout de suite quand la valeur est là (fiche ouverte), sinon après son chargement. */
const whenLoaded = (v, fn) => (v && typeof v.then === 'function' ? v.then(fn) : fn(v));

/** Watch party : refusée pour un titre pas encore sorti ou au cinéma, comme le bouton de la fiche. `key` : titre du menu d'une affiche
 * ou d'une émission (sans fiche ouverte) ; sa série est « vue » chargée avant la fenêtre, sans quoi l'épisode proposé serait le premier. */
function partyFor(el, m, key = null) {
  if (isFuture(m.releaseFR) || m.cinemaSince) { toast('Watch party indisponible pour ce titre'); return; }
  const seen = key && key.startsWith('tv:') && userStore.loadWatched ? Promise.resolve(userStore.loadWatched(key)).catch(() => undefined) : null;
  whenLoaded(seen, () => openPartyDialog(el, m));
}

/** « Partager » (compte connecté, profil adulte) et « Proposer une watch party » (compte connecté). `load()` rend la fiche complète, ou une promesse de celle-ci ; l'action reste synchrone quand la fiche est déjà là. */
function socialItems(el, load, key = null) {
  const items = [];
  if (socialAvailable()) items.push({ id: 'share', label: 'Partager', icon: ICON.share, run: () => whenLoaded(load(), (m) => openShareDialog({ media: shareMedia(m) })) });
  if (isServerMode()) items.push({ id: 'party', label: 'Proposer une watch party', icon: ICON.users, run: () => whenLoaded(load(), (m) => partyFor(el, m, key)) });
  return items;
}

function titleItems(t) {
  const it = itemOf(t);
  const [type, id] = t.key.split(':');
  const resume = resumeEntry(t.key);
  const items = [];
  if (!it.cinema) items.push({ id: 'play', label: resume || (type === 'tv' && userStore.watchedEpisodes(t.key).length) ? 'Reprendre' : 'Lecture', icon: ICON.play, run: () => playTitle(t.key, t.el, false) });
  items.push({ id: 'info', label: 'Plus d’infos', icon: ICON.info, run: () => go('#/' + type + '/' + id, t.el) });
  items.push({
    id: 'trailer', label: 'Bande-annonce', icon: ICON.film,
    run: async () => { const x = await named(it); const d = await getDetail(x); if (d && d.trailer) openTrailer(x, t.el); else toast('Pas de bande-annonce pour ce titre'); },
  });
  const on = inLib(t.key);
  items.push({
    id: 'lib', label: on ? 'Retirer de ma bibliothèque' : 'Ajouter à ma bibliothèque', icon: on ? ICON.check : ICON.list,
    run: () => withNamed(it, (x) => { const now = toggleLib({ type, id: x.id, name: x.name, posterPath: x.posterPath }); toast(now ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque'); renderLibrary(); }),
  });
  if (type === 'movie' && !it.cinema && canDownload()) {
    items.push({ id: 'download', label: 'Télécharger', icon: ICON.download, run: () => startDownload({ key: t.key, type: 'movie', id: String(id), name: it.name }, t.el) });
  }
  socialItems(t.el, () => fetchFull(type, id), t.key).forEach((x) => items.push(x));
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
    items.push({ id: 'hide', label: hidden ? 'Réafficher sur l’accueil' : 'Ne plus proposer', icon: ICON.close, run: async () => { const x = await named(it); return toggleHidden(t.key, x.name, x.posterPath); } });
  }
  if (t.inContinue || resume) {
    items.push({ id: 'restart', label: 'Recommencer depuis le début', icon: ICON.back, run: () => playTitle(t.key, t.el, true) });
    items.push({ id: 'remove', label: 'Retirer de « Reprendre la lecture »', icon: ICON.close, run: () => removeFromContinue(t.key) });
  }
  return items;
}

/** Émission (guide, « Émissions ») : « Plus d’infos » vers sa page, partage et watch party, suivre et noter. Pas de « vu » ni de bibliothèque : une émission n’est pas une série du catalogue. */
function showItems(t) {
  const id = t.key.split(':')[1];
  const items = [{ id: 'info', label: 'Plus d’infos', icon: ICON.info, run: () => go('#/emission/' + id, t.el) }];
  socialItems(t.el, () => fetchFull('tv', id), t.key).forEach((x) => items.push(x));
  extrasOf().forEach((fn) => fn(t).forEach((x) => items.push(x)));
  return items;
}

function episodeItems(t) {
  const m = t.model;
  const seen = userStore.isWatched(m.key, t.season, t.episode);
  const dl = canDownload()
    ? [{ id: 'download', label: 'Télécharger', icon: ICON.download, run: () => startDownload({ key: m.key, type: 'tv', id: String(m.id), name: m.name, season: t.season, episode: t.episode }, t.el) }]
    : [];
  return [
    { id: 'play', label: 'Lire', icon: ICON.play, run: () => openSources({ type: 'tv', id: String(m.id), name: m.name, season: t.season, episode: t.episode, key: m.key }, t.el) },
    ...dl,
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

/** Menu de la fiche (« … » et affiche) : bande-annonce, bibliothèque, vu (film), sources (au cinéma), « Partager », watch party, suivre,
 * « Ne plus proposer sur l'accueil » (ou « Proposer à nouveau » quand le titre est masqué). Profil enfant : pas de « Partager » ni de « Ne plus proposer ». */
function ficheItems(t) {
  const m = t.model;
  if (!m) return [];
  const items = [];
  // Groupes séparés par un filet : le titre, son téléchargement, le social, l'accueil (LAST-500).
  if (m.trailer) items.push({ id: 'trailer', label: 'Bande-annonce', icon: ICON.film, run: () => openVideo(m.trailer, 'Bande-annonce', t.el, !!m.trailerVO) });
  const on = inLib(m.key);
  items.push({
    id: 'lib', label: on ? 'Retirer de ma bibliothèque' : 'Ajouter à ma bibliothèque', icon: on ? ICON.check : ICON.list,
    run: () => { const now = toggleLib({ type: m.type, id: Number(m.id), name: m.name, posterPath: m.posterPath }); toast(now ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque'); renderLibrary(); },
  });
  if (m.type === 'movie') {
    const seen = userStore.isWatched(m.key);
    items.push({ id: 'seen', label: seen ? 'Marquer comme non vu' : 'Marquer comme vu', icon: ICON.check, run: () => mark(m.key, null, !seen) });
  }
  // Sur demande seulement : aucune vérification automatique des sources d'un film au cinéma.
  if (m.cinemaSince) items.push({ id: 'sources', label: 'Voir les sources', icon: ICON.list, run: () => openSources({ type: m.type, id: String(m.id), name: m.name, season: null, episode: null, key: m.key }, t.el) });
  // Adulte connecté, titre sorti : « Regarder avec… » (feuille chargée au clic, hors du premier chargement) à la place de la watch party simple.
  const withSheet = partyKind(m) === 'with';
  const social = socialItems(t.el, () => m).map((x) => (x.id !== 'party' || !withSheet ? x
    : { id: 'party', label: 'Regarder avec…', icon: ICON.users, run: () => import('./watchWith.js').then((w) => { if (!w.openWatchWith(t.el, m)) openPartyDialog(t.el); }, () => openPartyDialog(t.el)) }));
  extrasOf().forEach((fn) => fn(t).forEach((x) => items.push(x)));
  items.forEach((x) => { x.group = 'title'; });
  ficheDownloadMenuItems(m, m.seasons ? nextToWatch(m) : null, t.el).forEach((x) => items.push(x));
  social.forEach((x) => items.push({ ...x, group: 'social' }));
  if (!isKidProfile()) {
    const hidden = isHiddenKey(m.key);
    items.push({ id: 'hide', group: 'home', label: hidden ? 'Proposer à nouveau sur l’accueil' : 'Ne plus proposer sur l’accueil', icon: ICON.close, run: () => toggleHidden(m.key, m.name, m.posterPath) });
  }
  return items;
}

export function ctxItems(t) {
  if (t.kind === 'fiche') return ficheItems(t);
  if (t.kind === 'title') return titleItems(t);
  if (t.kind === 'show') return showItems(t);
  if (t.kind === 'episode') return episodeItems(t);
  if (t.kind === 'channel') return channelItems(t);
  return personItems(t);
}

// ---------- Rendu ----------
/** Tactile : l'appui long ouvre ce menu, et le navigateur envoie aussi « contextmenu » (dans un ordre ou dans l'autre) sur la même cible. */
const DUP_MS = 1000;
const DUP_PX = 24;

export function openCtx(t, x, y) {
  const open = state.ctxMenu;
  if (open && open._opener === t.el && Date.now() - open._at < DUP_MS && Math.abs(open._x - x) < DUP_PX && Math.abs(open._y - y) < DUP_PX) return;
  closeCtx();
  const items = ctxItems(t);
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'ctxmenu glass';
  menu.setAttribute('role', 'menu');
  menu.dataset.kind = t.kind;
  if (t.key) menu.dataset.key = t.key;
  menu._at = Date.now();
  menu._x = x;
  menu._y = y;
  // Fiche sur téléphone : feuille basse avec le titre, sur un voile (LAST-500).
  const sheet = t.kind === 'fiche' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
  menu.innerHTML = (sheet ? '<div class="ctx-sheet-h" aria-hidden="true"><span class="ctx-grip"></span><strong>' + esc(t.model.name || '') + '</strong></div>' : '') +
    items.map((it, i) => (i && it.group && items[i - 1].group && it.group !== items[i - 1].group ? '<div class="ctx-sep" role="separator"></div>' : '') +
      '<button type="button" role="menuitem" data-ctx="' + esc(it.id) + '">' + (it.icon || '') + '<span>' + esc(it.label) + '</span></button>').join('');
  if ((t.kind === 'title' || t.kind === 'episode') && takeHint()) {
    menu.insertAdjacentHTML('beforeend', '<p class="ctx-hint" aria-hidden="true">Astuce : clic droit, appui long ou « … » sur une affiche ouvre ce menu.</p>');
  }
  menu._opener = t.el;
  if (sheet) {
    menu.classList.add('is-sheet');
    menu.setAttribute('aria-label', 'Actions : ' + (t.model.name || ''));
    const scrim = document.createElement('div');
    scrim.className = 'ctx-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    document.body.appendChild(scrim);
    menu._scrim = scrim;
  }
  document.body.appendChild(menu);
  state.ctxMenu = menu;
  menu._releaseBack = pushLayer(() => closeCtx(true)); // retour du téléphone : ferme le menu (LAST-499)
  if (!sheet) {
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }
  const buttons = Array.from(menu.querySelectorAll('button'));
  menu.addEventListener('click', (e) => {
    const b = e.target instanceof Element && e.target.closest('[data-ctx]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const item = items.find((i) => i.id === b.dataset.ctx);
    closeCtx(false);
    if (item) Promise.resolve(runOnce(ctxLockKey(t, item.id), () => item.run(), { cooldown: LOCKED_ITEMS.has(item.id) ? TOGGLE_COOLDOWN_MS : 0 })).catch((err) => {
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

/** Visuels de l'app (affiches, bannières, images) : jamais de menu natif dessus, même quand l'app n'a pas de menu pour eux.
 * Les cartes d'import Stremio (`data-open="true"`) ne sont pas des titres : menu natif. */
const VISUAL = 'img, picture, video, canvas, [data-media], .hero-slide, [data-tile], [data-open^="movie:"], [data-open^="tv:"], [data-play-key], [data-showopen]';
const FIELD = 'input, textarea, select, [contenteditable="true"]';
/** Carte du guide (`epg:…`) : pas de titre TMDB, donc pas de menu de l'app ; le menu natif reste disponible. */
const GUIDE_CARD = '[data-showopen^="epg:"]';

document.addEventListener('contextmenu', (e) => {
  const t = ctxTarget(e.target);
  if (!t) { // menu natif, sauf sur un visuel
    const el = e.target instanceof Element ? e.target : null;
    if (el && el.closest(VISUAL) && !el.closest(FIELD) && !el.closest(GUIDE_CARD)) e.preventDefault();
    return;
  }
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
    if (state.ctxMenu) { state.ctxMenu._more = more; setOpenState(more, true); }
    return;
  }
  const fm = el.closest('[data-fiche-more]');
  if (fm) {
    e.preventDefault();
    e.stopPropagation();
    // Second appui sur « … » : referme le menu qu'il a ouvert (ODY-217).
    if (state.ctxMenu && state.ctxMenu._more === fm) { closeCtx(true); return; }
    if (!state.model) return;
    const r = fm.getBoundingClientRect();
    openCtx({ kind: 'fiche', el: fm, model: state.model }, r.left, r.bottom + 6);
    if (state.ctxMenu) { state.ctxMenu._more = fm; setOpenState(fm, true); }
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
