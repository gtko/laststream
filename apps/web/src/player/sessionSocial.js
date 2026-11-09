/* Social pendant la lecture : salon (watch party), présence, réactions horodatées, cinéma, messages manqués. */
import { relayableUrl } from '../relay/sourceUrl';
import { setPresenceMedia } from './presenceV2';
import { deleteNote, getNotes, postNote, updateNote } from '../data/socialV2Api';
import { getHeatmap, getMissed } from '../data/socialV3Api';
import { cinemaOn, endCinema, getState as getSocialState, loadPrefs, onNote, onNoteRemoved, sendMessage as sendSocialMessage, setCinemaHidden, startCinema, subscribe as subscribeSocial } from '../data/socialStore';
import { isKidProfile } from '../data/auth';
import { partyBridge } from '../party/bridge';
import { partyReactLimit } from '../party/reactLimit';
import { knownMessages } from './messageBubble';
import { freshIncoming, handleNativeReact, handleNativeReply, handleNativeReplyText, nativeRoomOf, nativeSocialOf, partyReactMessageOf, roomViewers, toNativeMessage, toNativeNotes, watchingViewers } from './nativeSocial';
import { openShareDialog } from '../ui/socialHooks.js';
import { cinemaEndsOnTeardown, durationOf, filmEnded, friendsWatching, heatBars, hiddenElements, initialOf, isTouchLayout, menuSelection, remainingLabel, roomNames, startPolicy, toggleElement, untilFor } from './playbackSocial';
import { clusterNotes, crossing, liveFlashDue, mediaKey, rearmed, upsertNotes } from './notesTimeline';
import { seekTo } from './sessionActions.js';
import { resolveMedia } from './sessionPlay.js';
import { S, notesAllowed } from './sessionState.js';
import { allSubtitleTracks } from './sessionTracks.js';


/** Titre en cours de lecture, tel que le salon (watch party) le voit : identité, source choisie, moteur. Jamais de lien. */
export function partyAdapter(p = S.P) {
  if (!p || p.addon) return null; // ODY-252 : le salon identifie les titres par id TMDB, pas ceux d'un addon
  return {
    req: p.req, cur: p.cur, view: p.view, poster: p.meta ? p.meta.poster : '', engine: p.engine,
    // Pas prêt pendant un rechargement (bascule de source) : l'ancien moteur, détruit, n'est pas une mesure.
    // Pas prêt non plus pendant une réouverture (LAST-507) : mpv repart de zéro, ce n'est pas un saut de l'hôte.
    ready: !!(p.view && p.engine && p.mediaUrl && !p.failing && !p.resumeTimer && !p.reloading && !p.reopening),
    // Bascule de source demandée par le salon : le lecteur suit le salon, il ne l'aligne pas sur lui.
    switching: !!p.partySwitch,
    // Lien HTTP(S) lu directement par cet appareil (débridé ou direct d'addon) pour le partage aux invités ; jamais un torrent.
    relayUrl: () => (p.engine ? relayableUrl(p.mediaUrl, p.view ? p.view.stream : null) : null),
    // Sources déjà chargées du titre, classées : le salon y cherche une source compatible avec tous les invités.
    sources: () => p.ranked || p.views || [],
    // Lien lisible d'une source pour en lire l'en-tête seulement (sans lancer la lecture) ; jamais un torrent ni un proxy.
    resolveUrl: (view, signal) => resolveRelayUrl(view, signal),
    // Sous-titre texte choisi et chargé : partagé aux invités (texte seulement, jamais son adresse).
    subtitle: () => partySubtitle(p),
  };
}

/** Sous-titre texte choisi et chargé par l'hôte (cues en mémoire), pour le partage aux invités ; null pour mpv ou sans cues. */
function partySubtitle(p) {
  const s = p.subs;
  if (!s || !s.selectedId || s.native || !s.cues.length) return null;
  const track = allSubtitleTracks().find((t) => t.id === s.selectedId);
  return track ? { lang: track.lang, cues: s.cues } : null;
}

/** Lien HTTP(S) lisible d'une source (débridé ou direct), ou null : sert à lire son en-tête avant de la proposer. */
export async function resolveRelayUrl(view, signal) {
  const media = await resolveMedia(view, signal, false);
  return relayableUrl(media.url, view.stream);
}

/** Média lu au format de la présence : film, ou série avec saison et épisode en cours. Null si le média n'est pas identifiable. */
export function presenceMediaOf(p) {
  if (p.addon) return null; // id d'addon : la présence exige un id TMDB
  const id = Number(p.req.id);
  if (!p.req.id || !Number.isFinite(id)) return null;
  const series = p.req.type === 'tv';
  const m = { type: series ? 'series' : 'movie', tmdbId: id, title: p.req.name || p.meta.title || '' };
  if (p.imdb) m.imdbId = p.imdb;
  if (p.meta.poster && p.meta.poster.startsWith('/')) m.poster = p.meta.poster;
  if (series && p.cur.season != null) m.season = p.cur.season;
  if (series && p.cur.episode != null) m.episode = p.cur.episode;
  return m;
}

/** Média lu au format des notes (film, ou série avec saison et épisode). Null si le média n'est pas identifiable. */
function noteMediaOf(p) {
  if (p.addon) return null;
  const id = Number(p.req.id);
  if (!p.req.id || !Number.isFinite(id)) return null;
  if (p.req.type !== 'tv') return { type: 'movie', tmdbId: id };
  if (p.cur.season == null || p.cur.episode == null) return null;
  return { type: 'series', tmdbId: id, season: p.cur.season, episode: p.cur.episode };
}

/** Ajoute des notes à la liste (une note de même identifiant remplace l'ancienne : édition) et signale le changement aux marqueurs. */
function putNotes(nt, notes) {
  nt.list = upsertNotes(nt.list, notes);
  nt.version += 1;
  syncNativeNotes(nt);
}

function removeNote(nt, id) {
  nt.list = nt.list.filter((n) => n.id !== id);
  nt.version += 1;
  syncNativeNotes(nt);
}

/** Vrai si l'auteur de la note est dans le salon actif (ou est moi) : sa réaction y a déjà son écho. */
function fromRoom(note) {
  const me = getSocialState().me;
  if (me && note.author.pid === me.pid) return true;
  const c = partyBridge.client;
  const h = note.author.handle;
  const wanted = [h.name, h.full].map((n) => String(n || '').trim().toLowerCase());
  return !!c && (c.participants || []).some((q) => roomNames(q.username).some((n) => n && wanted.includes(n)));
}

/** Charge les notes du média lu et écoute celles qui arrivent en direct. Erreurs silencieuses : la lecture n'en dépend pas. */
export function startNotes(p) {
  const media = notesAllowed() ? noteMediaOf(p) : null;
  // Écho des réactions de salon suivi pour tout titre lu, avec ou sans notes (LAST-1615) ; retiré à la fin de la session (stopNotes).
  if (p.partyEcho) p.partyEcho();
  const unsubParty = partyBridge.onChange(onPartyChange);
  bindPartyReact();
  p.partyEcho = () => { unsubParty(); unbindPartyReact(); p.partyEcho = null; };
  // En salon, « Réagir » reste visible sans notes : la réaction de salon marche sans note (seul le salon actif la garde).
  if (!media) { S.ui.setNotesAvailable(partyBridge.isActive()); return; }
  const nt = { media, key: mediaKey(media), list: [], fired: new Set(), last: null, version: 0, renderKey: '', unsub: null };
  p.notes = nt;
  S.ui.setNotesAvailable(true);
  nt.unsub = onNote((m, note) => {
    if (p.notes !== nt || mediaKey(m) !== nt.key) return;
    // En salon, l'emoji d'un participant du salon n'est pas affiché : l'écho du salon le montre déjà. Il reste un marqueur ; celui d'un
    // ami hors salon, sur le même titre, s'affiche comme d'habitude (LAST-1615).
    if (partyBridge.isActive() && note.kind === 'emoji' && fromRoom(note)) { nt.fired.add(note.id); putNotes(nt, [note]); return; }
    // Réaction d'un ami arrivée en direct près de notre position : affichée tout de suite (sinon seulement au franchissement).
    const me = getSocialState().me;
    const due = liveFlashDue(note, p.engine ? p.engine.state().time : NaN, { now: Date.now(), mePid: me ? me.pid : null, known: nt.list });
    putNotes(nt, [note]);
    if (due) { nt.fired.add(note.id); S.ui.showNoteFlash(note); }
  });
  const unsubRemoved = onNoteRemoved((m, id) => {
    if (p.notes !== nt || mediaKey(m) !== nt.key || !nt.list.some((n) => n.id === id)) return;
    removeNote(nt, id);
    loadHeat(p);
  });
  const unsubNote = nt.unsub;
  nt.unsub = () => { unsubNote(); unsubRemoved(); };
  loadHeat(p);
  getNotes(media).then(({ notes }) => {
    if (p.notes === nt) putNotes(nt, notes);
  }).catch(() => undefined);
}

/** Fin de session ou changement de média : désabonnement, marqueurs et popover retirés. */
export function stopNotes(p) {
  if (p && p.partyEcho) p.partyEcho();
  const nt = p && p.notes;
  if (!nt) return;
  p.notes = null;
  if (nt.unsub) nt.unsub();
  S.ui.setNoteMarkers([]);
  S.ui.setHeat([]);
  S.ui.setFriendChip(null);
  S.ui.setNotesAvailable(false);
}

/** Relevé d'interface (250 ms) : les notes franchies par une lecture normale s'affichent ; un retour en arrière les relâche. */
export function notesTick(p, st) {
  const nt = p.notes;
  if (!nt) return;
  const prev = nt.last;
  nt.last = st.time;
  if (prev === null) return;
  for (const id of rearmed(prev, st.time, nt.list)) nt.fired.delete(id);
  if (st.paused) return;
  for (const n of crossing(prev, st.time, nt.list, { fired: nt.fired })) {
    nt.fired.add(n.id);
    S.ui.showNoteFlash(n);
  }
}

/** Carte de chaleur des réactions (60 tranches), rechargée après chaque note posée. Erreurs silencieuses. */
function loadHeat(p) {
  const nt = p.notes;
  if (!nt) return;
  getHeatmap({ ...nt.media, buckets: 60 }).then(({ buckets }) => {
    if (p.notes === nt) S.ui.setHeat(heatBars(buckets));
  }).catch(() => undefined);
}

/** Marqueurs redessinés seulement quand la liste ou la durée changent. */
export function refreshNoteMarkers(nt, duration) {
  const dur = Number.isFinite(duration) ? duration : 0;
  const key = nt.version + ':' + Math.round(dur);
  if (key === nt.renderKey) return;
  nt.renderKey = key;
  S.ui.setNoteMarkers(clusterNotes(nt.list, dur));
}

/** « Réagir ici » : popover pour la position courante, figée à l'ouverture. */
export function openReactHere() {
  // En salon, la réaction ne dépend pas des notes du titre (LAST-1615) : le popover s'ouvre aussi sans notes.
  if (!S.P || !S.P.view || (!S.P.notes && !partyBridge.isActive())) return;
  S.ui.closeCinemaMenu(false);
  const peer = S.bubble ? S.bubble.lastPeer() : null;
  const friend = peer ? { pid: peer.pid, name: peer.who.replace(/#.*$/, '') } : null;
  S.ui.openReact(S.P.engine.state().time, { friend, touch: isTouchLayout() });
}

/**
 * Envoie une réaction à la position du popover. Si le profil connecté est connu, la note apparaît tout de suite (optimiste,
 * avec sa bulle) puis est remplacée par celle du serveur ; en cas d'échec elle disparaît et un toast explique.
 */
export function postReact({ pos, kind, body, also = null }) {
  const p = S.P;
  const nt = p && p.notes;
  const at = Math.round(Math.max(0, pos) * 10) / 10;
  // En salon, un emoji part par le WebSocket du salon : son écho est le seul affichage, rien n'est montré en local.
  // La note est postée en silence pour les marqueurs. Une réaction par seconde, le reste est ignoré sans erreur (LAST-1615).
  if (kind === 'emoji' && partyBridge.isActive() && partyBridge.client) {
    if (!partyReactLimit.ready()) return;
    if (partyBridge.client.sendReact(body, at)) {
      partyReactLimit.sent();
      if (also && nt) sendSocialMessage(also, body, { ...nt.media, pos: at }).catch(() => S.ui.toast('Message non envoyé, réessaie plus tard', 3500));
      if (nt) postQuietNote(p, nt, { ...nt.media, pos: at, kind, body });
      return;
    }
  }
  if (!nt) return;
  const me = getSocialState().me;
  const tmp = me ? 'tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) : '';
  if (me) {
    const local = { id: tmp, author: { pid: me.pid, handle: me.handle, avatarColor: me.avatarColor, ...(me.avatar ? { avatar: me.avatar } : {}) }, pos: at, kind, body, createdAt: Date.now() };
    putNotes(nt, [local]);
    S.ui.showNoteFlash(local);
  }
  if (also) sendSocialMessage(also, body, { ...nt.media, pos: at }).catch(() => S.ui.toast('Message non envoyé, réessaie plus tard', 3500));
  postNote({ ...nt.media, pos: at, kind, body }).then(({ note }) => {
    if (p.notes !== nt) return;
    loadHeat(p);
    if (tmp) removeNote(nt, tmp);
    nt.fired.add(note.id);
    putNotes(nt, [note]);
    if (!tmp) S.ui.showNoteFlash(note);
  }, (err) => {
    if (p.notes !== nt) return;
    if (tmp) removeNote(nt, tmp);
    S.ui.toast(err && err.status === 429 ? 'Trop de réactions : réessaie dans une minute' : 'Réaction non envoyée, réessaie plus tard', 3500);
  });
}

/** Note de réaction de salon posée sans affichage : marqueur et carte de chaleur seulement, erreurs silencieuses (LAST-1615). */
function postQuietNote(p, nt, data) {
  postNote(data).then(({ note }) => {
    if (p.notes !== nt) return;
    loadHeat(p);
    nt.fired.add(note.id);
    putNotes(nt, [note]);
  }, () => undefined);
}

/** Écho des réactions de salon (LAST-1615) : suivi du client du salon, rebranché à chaque changement du salon. */
let partyClient = null;
let partyOff = null;
let partyReactSeq = 0;
function bindPartyReact() {
  const c = partyBridge.isActive() ? partyBridge.client : null;
  if (c === partyClient) return;
  if (partyOff) partyOff();
  partyClient = c;
  partyOff = c ? c.on('react', onPartyReact) : null;
}
function unbindPartyReact() {
  if (partyOff) partyOff();
  partyOff = null;
  partyClient = null;
}

/** Salon changé (connexion, membres, fin) : écho rebranché, couche native à jour (avatars et rangée) (LAST-1627). */
function onPartyChange() {
  bindPartyReact();
  syncNativeSocial();
}

/** Réaction de salon reçue : au natif, une bulle (pas de réactions flottantes) ; le web l'affiche déjà (LAST-1615). */
function onPartyReact(d) {
  const eng = nativeEngineOf(S.P);
  if (!eng || socialHidden().has('bubbles')) return;
  const c = partyBridge.client;
  if (c && c.settings && c.settings.reactions === 'off') return;
  const m = partyReactMessageOf(d, 'party-react-' + ++partyReactSeq);
  if (m) eng.pushMessage(m);
}

/** Échec d'une modification ou d'une suppression : note absente côté serveur → retrait local, sinon retour en arrière. */
const noteGone = (err) => !!err && err.status === 404 && err.code === 'note_not_found';

/**
 * Modifie le contenu (emoji ou texte) d'une de mes réactions ; l'horodatage ne change pas. Mise à jour optimiste, retour
 * arrière et toast en cas d'échec. La bulle n'est pas rejouée après une édition.
 */
export function editReaction(id, kind, body) {
  const p = S.P;
  const nt = p && p.notes;
  const prev = nt && nt.list.find((n) => n.id === id);
  if (!nt || !prev) return;
  const optimistic = { ...prev, kind, body };
  putNotes(nt, [optimistic]);
  nt.fired.add(id);
  updateNote(id, { kind, body }).then((res) => {
    if (p.notes !== nt) return;
    if (res && res.note && res.note.id === id) putNotes(nt, [res.note]);
    loadHeat(p);
  }, (err) => {
    if (p.notes !== nt) return;
    if (noteGone(err)) { removeNote(nt, id); loadHeat(p); S.ui.toast('Réaction introuvable', 3500); return; }
    // Retour arrière seulement si la note est encore la version optimiste : une modification plus récente n'est pas écrasée.
    if (nt.list.find((n) => n.id === id) === optimistic) putNotes(nt, [prev]);
    S.ui.toast('Modification non enregistrée, réessaie plus tard', 3500);
  });
}

/** Supprime une de mes réactions (déjà confirmée dans le menu) : retrait immédiat, remise en place si le serveur refuse. */
export function deleteReaction(id) {
  const p = S.P;
  const nt = p && p.notes;
  const prev = nt && nt.list.find((n) => n.id === id);
  if (!nt || !prev) return;
  removeNote(nt, id);
  deleteNote(id).then(() => {
    if (p.notes === nt) loadHeat(p);
  }, (err) => {
    if (p.notes !== nt) return;
    if (noteGone(err)) { loadHeat(p); S.ui.toast('Réaction introuvable', 3500); return; }
    putNotes(nt, [prev]);
    S.ui.toast('Suppression non enregistrée, réessaie plus tard', 3500);
  });
}

// ---------- Pont natif Android (LAST-1612) : le lecteur natif affiche le social, le web garde le réseau ----------

/** Moteur natif de la session, ou null : le pont ne lui parle que lorsqu'il est actif. */
const nativeEngineOf = (p) => (p && p.engine && p.engine.kind === 'native' ? p.engine : null);
const nativeMeId = () => (getSocialState().me ? getSocialState().me.pid : null);
/** Salon actif avec son client : la réaction native et les avatars passent par lui (LAST-1627). */
const inParty = () => partyBridge.isActive() && !!partyBridge.client;
/** Mon nom dans le salon actif (participant « moi »), ou null si le salon ne l'a pas encore donné. */
const roomMeName = () => (partyBridge.client && partyBridge.client.you ? partyBridge.client.you.username : null);
/** Social disponible pour le titre lu (réglé par startSocialPlayback). */
let socialLive = false;
/** Messages déjà traités pour le natif, et début du mode : mêmes principes que la bulle web. */
let nativeSeen = new Set();
let nativeSince = 0;
/** Dernière charge utile `setSocial` envoyée (comparée par contenu) et dernière version des marqueurs envoyée. */
let nativeSocialKey = '';
let nativeNotesSent = { nt: null, version: -1 };

/** Marqueurs au natif, seulement quand la liste a changé. Sans moteur natif, rien. */
function syncNativeNotes(nt) {
  const p = S.P;
  const eng = p && p.notes === nt ? nativeEngineOf(p) : null;
  if (!eng || (nativeNotesSent.nt === nt && nativeNotesSent.version === nt.version)) return;
  nativeNotesSent = { nt, version: nt.version };
  eng.setNotes(toNativeNotes(nt.list, nativeMeId()));
}

/**
 * Couche sociale au natif (emojis, spectateurs, activation) et marqueurs en retard : appelé à chaque relevé lent et à chaque
 * changement du store. N'envoie que ce qui a changé.
 */
function syncNativeSocial(p = S.P) {
  const eng = nativeEngineOf(p);
  if (!eng) return;
  if (p.notes) syncNativeNotes(p.notes);
  const now = Date.now();
  const st = getSocialState();
  const room = inParty();
  const shown = !socialHidden().has('friendsPresence');
  // Salon : avatars = membres du salon, sans moi (LAST-1627). Hors salon : amis qui regardent le titre, inchangé.
  const viewers = room
    ? (shown ? roomViewers(roomMembers() || [], roomMeName()) : [])
    : (socialLive && shown ? watchingViewers(st, presenceMediaOf(p), now, eng.state().duration, roomMembers()) : []);
  // État du salon (LAST-1632) : membres, rôle, synchro (attente de tampon ou écart du contrôleur). Seul l'état change la clé, pas l'écart exact.
  const roomState = room ? nativeRoomOf(partyBridge.client, partyBridge.controller ? partyBridge.controller.drift : null) : null;
  const payload = nativeSocialOf({ available: socialLive, kid: isKidProfile(), status: st.status, cinema: cinemaOn(st.cinema, now), room }, viewers, roomState);
  const key = JSON.stringify(payload);
  if (key === nativeSocialKey) return;
  nativeSocialKey = key;
  eng.setSocial(payload);
}

/** Barrière côté JS (défense en profondeur) : jamais de note ni de réponse si le social est coupé (enfant, invisible, cinéma).
 * Exception : en salon, une réaction native suit `nativeReactOn` et peut retomber sur une note, comme sur le web. */
function nativeSocialOn() {
  const st = getSocialState();
  return nativeSocialOf({ available: socialLive, kid: isKidProfile(), status: st.status, cinema: cinemaOn(st.cinema, Date.now()) }, []).enabled;
}

/** Messages entrants au natif (bulles) : règles de la bulle web, rien quand les bulles sont masquées (mode cinéma). */
function pushNativeMessages(p, st) {
  const eng = nativeEngineOf(p);
  if (!eng || !socialLive) return;
  const fresh = freshIncoming(st, nativeSeen, nativeSince);
  if (socialHidden().has('bubbles')) return;
  for (const m of fresh) eng.pushMessage(toNativeMessage(m, st));
}

/** Réaction posée dans le natif : en salon, elle part au salon même si le social amis est coupé ; profil enfant toujours exclu (LAST-1627). */
function nativeReactOn() {
  return inParty() ? !isKidProfile() : nativeSocialOn();
}

/** Réaction posée dans le natif : même chemin que « Réagir ici » (note optimiste, 429 affiché en toast). */
export function onNativeReact(d) {
  if (!nativeReactOn()) return;
  handleNativeReact(d, { react: (pos, emoji) => postReact({ pos, kind: 'emoji', body: emoji }) });
}

/** Réponse rapide dans le natif à un message affiché : même envoi que la bulle web. */
export function onNativeReply(d) {
  if (!nativeSocialOn()) return;
  handleNativeReply(d, {
    messageOf: (id) => knownMessages(getSocialState()).find((m) => m.id === id),
    send: sendSocialMessage,
    error: (message) => S.ui.toast(message, 3500),
  });
}

/** Réponse texte saisie dans le natif (LAST-1632) : au chat du salon en salon (profil enfant exclu), sinon à l'auteur du message. */
export function onNativeReplyText(d) {
  const room = inParty();
  if (room ? isKidProfile() : !nativeSocialOn()) return;
  const c = partyBridge.client;
  const eng = nativeEngineOf(S.P);
  handleNativeReplyText(d, {
    chat: room && c ? (text) => c.sendChat(text, eng ? eng.state().time : null) : null,
    messageOf: (id) => knownMessages(getSocialState()).find((m) => m.id === id),
    send: sendSocialMessage,
    error: (message) => S.ui.toast(message, 3500),
  });
}

// ---------- Social pendant la lecture (Social v3) : mode cinéma, anti-spoiler, « regarde aussi » ----------

/** Éléments sociaux masqués par le réglage « messages seulement » du profil (le mode cinéma s'y ajoute). */
let quietHidden = [];
let socialUnsub = null;
let socialKey = '';
let cinemaSince = null;
let cinemaQuietEnd = false;
let chipPid = '';
const cinemaDraft = { duration: 'film', hidden: [] };

export const socialHidden = () => hiddenElements(getSocialState().cinema, Date.now(), quietHidden);
const antiSpoilerOn = () => { const pr = getSocialState().prefs; return pr ? pr.antiSpoiler : true; };

export function startSocialPlayback(p, social) {
  stopSocialPlayback(true);
  socialLive = !!social;
  nativeSeen = new Set(knownMessages(getSocialState()).map((m) => m.id));
  nativeSince = Date.now();
  S.ui.setSocialButtons({ cinema: social, share: social && !!presenceMediaOf(p) });
  if (!social) return;
  const c0 = getSocialState().cinema;
  cinemaDraft.duration = 'film';
  cinemaDraft.hidden = menuSelection(c0.hidden);
  quietHidden = [];
  socialKey = '';
  cinemaSince = c0.active ? c0.since : null;
  socialUnsub = subscribeSocial(onSocialChange);
  const applyPolicy = (prefs) => {
    if (S.P !== p) return;
    const pol = startPolicy(prefs && prefs.playbackSocial);
    quietHidden = pol.quiet;
    if (pol.cinema && !getSocialState().cinema.active) startCinema('always', cinemaDraft.hidden);
    onSocialChange(getSocialState());
  };
  const pr = getSocialState().prefs;
  if (pr) applyPolicy(pr); else { onSocialChange(getSocialState()); loadPrefs().then(applyPolicy, () => undefined); }
  syncNativeSocial(p);
}

/** Fin de session : abonnement retiré, mode cinéma levé sans résumé (les messages restent non lus dans la discussion). */
export function stopSocialPlayback(silent) {
  if (socialUnsub) { socialUnsub(); socialUnsub = null; }
  socialLive = false;
  nativeSocialKey = '';
  nativeNotesSent = { nt: null, version: -1 };
  if (cinemaEndsOnTeardown(silent, getSocialState().cinema.active)) { cinemaQuietEnd = true; endCinema(); cinemaQuietEnd = false; }
  cinemaSince = null;
  quietHidden = [];
  socialKey = '';
  chipPid = '';
  S.ui.setSocialHidden(new Set());
  S.ui.setCinemaIndicator(null);
  S.ui.setCinemaActive(false);
  S.ui.closeCinemaMenu(false);
  S.ui.hideCinemaSummary();
  S.ui.setSocialButtons({ cinema: false, share: false });
}

/** Le store change : visibilité du social, indicateur, présence ; la fin du mode (échéance) déclenche le résumé. */
function onSocialChange(st) {
  const p = S.P;
  if (!p) return;
  pushNativeMessages(p, st);
  syncNativeSocial(p);
  const c = st.cinema;
  if (c.active) cinemaSince = c.since;
  else if (cinemaSince !== null) {
    const since = cinemaSince;
    cinemaSince = null;
    if (!cinemaQuietEnd) showMissed(p, since);
  }
  const hidden = hiddenElements(c, Date.now(), quietHidden);
  const key = [...hidden].sort().join(',') + '|' + c.active + '|' + (hidden.has('bubbles') ? c.count : 0);
  if (key === socialKey) return;
  socialKey = key;
  S.ui.setSocialHidden(hidden);
  S.ui.setCinemaActive(c.active);
  S.ui.setCinemaIndicator(c.active ? (hidden.has('bubbles') ? c.count : 0) : null);
  setPresenceMedia(notesAllowed() && !hidden.has('myPresence') ? presenceMediaOf(p) : null);
  if (S.ui.isCinemaMenuOpen()) S.ui.renderCinemaMenu(cinemaModel());
}

/** Résumé de fin de mode : ce que les amis ont envoyé et posé depuis since. */
function showMissed(p, since) {
  const media = noteMediaOf(p);
  if (!media) return;
  getMissed({ ...media, since }).then((sum) => {
    if (S.P !== p) return;
    if (sum.messages > 0 || sum.notes.length > 0) S.ui.showCinemaSummary(sum);
    else S.ui.toast('Mode cinéma terminé, rien de manqué', 3000);
  }).catch(() => { if (S.P === p) S.ui.toast('Mode cinéma terminé', 3000); });
}

function cinemaModel() {
  const c = getSocialState().cinema;
  const st = S.P && S.P.engine ? S.P.engine.state() : null;
  const left = st && Number.isFinite(st.duration) ? st.duration - st.time : 0;
  return {
    active: c.active,
    duration: c.active ? durationOf(c.until) : cinemaDraft.duration,
    hidden: c.active ? c.hidden : cinemaDraft.hidden,
    remaining: remainingLabel(left),
  };
}

export function toggleCinemaMenu() {
  if (!S.P || !S.P.view) return;
  if (S.ui.isCinemaMenuOpen()) S.ui.closeCinemaMenu(true); else S.ui.openCinemaMenu(cinemaModel());
}

/** Rappels du menu du mode cinéma (interrupteur, durée, cases « Masquer »). */
export function onCinema(kind, v) {
  const c = getSocialState().cinema;
  if (kind === 'switch') {
    if (v) startCinema(untilFor(cinemaDraft.duration, Date.now()), cinemaDraft.hidden);
    else endCinema();
  } else if (kind === 'duration') {
    if (!c.active) cinemaDraft.duration = v;
  } else if (kind === 'toggle') {
    const next = toggleElement(c.active ? c.hidden : cinemaDraft.hidden, v);
    cinemaDraft.hidden = next;
    if (c.active) setCinemaHidden(next);
  }
  if (S.ui.isCinemaMenuOpen()) S.ui.renderCinemaMenu(cinemaModel());
}

/** Relevé d'interface (250 ms) : fin du film levant le mode, position pour l'anti-spoiler. */
export function socialTick(p, st) {
  if (!p.notes) return;
  const c = getSocialState().cinema;
  if (c.active && filmEnded(c.until, st)) { endCinema(); return; }
  S.ui.setSocialTime(st.time, st.duration, antiSpoilerOn());
}

/** Participants du salon courant (vide hors salon) : les amis qui y sont déjà ne sont pas proposés par la puce « regarde aussi ». */
function roomMembers() {
  return partyBridge.isActive() && partyBridge.client ? partyBridge.client.participants || [] : null;
}

/** Relevé lent (1 s) : puce « regarde aussi ». */
export function friendChipTick(p, st) {
  syncNativeSocial(p);
  if (!p.notes) return;
  if (socialHidden().has('friendsPresence')) { S.ui.setFriendChip(null); chipPid = ''; return; }
  const peers = friendsWatching(getSocialState(), presenceMediaOf(p), Date.now(), st.duration, roomMembers());
  if (!peers.length) { S.ui.setFriendChip(null); chipPid = ''; return; }
  const f = peers[0];
  chipPid = f.pid;
  S.ui.setFriendChip({ name: f.name, initial: initialOf(f.name), color: f.color, pos: f.pos, more: peers.length - 1 });
}

/** « Se caler sur elle » : saute à la position estimée de l'ami affiché. */
export function catchUp() {
  if (!S.P || !S.P.view || !chipPid) return;
  const st = S.P.engine.state();
  const peer = friendsWatching(getSocialState(), presenceMediaOf(S.P), Date.now(), st.duration, roomMembers()).find((x) => x.pid === chipPid);
  if (!peer) { S.ui.toast('Cet ami ne regarde plus', 2500); return; }
  seekTo(peer.pos);
  S.ui.toast('Calé sur ' + peer.name, 2000);
}

/** Bouton « Partager » : ouvre la fenêtre du lot Partage (F4) sur le titre, à la position courante. */
export function shareHere() {
  if (!S.P || !S.P.view) return;
  const m = presenceMediaOf(S.P);
  if (!m) return;
  const media = { type: m.type, tmdbId: m.tmdbId, title: m.title };
  if (m.poster) media.poster = m.poster;
  if (typeof S.P.meta.backdrop === 'string' && S.P.meta.backdrop.startsWith('/')) media.backdrop = S.P.meta.backdrop;
  if (m.season != null) media.season = m.season;
  if (m.episode != null) media.episode = m.episode;
  const st = S.P.engine.state();
  openShareDialog({ media, pos: Math.round(st.time), duration: Number.isFinite(st.duration) && st.duration > 0 ? Math.floor(st.duration) : undefined });
}
