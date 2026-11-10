/* Actions de l'utilisateur : transport, plein écran, épisodes, panneau des sources, boutons, touches et données des panneaux. */
import { isConfigured } from '../data/config';
import { postLt } from '../data/lt';
import { pushPrefs } from '../data/auth';
import { setLangPrefs, wantedSubLang } from '../data/langPrefs';
import { getSkipPref } from '../data/prefs';
import { userStore } from '../data/userStore';
import { addonVideoOf } from './addonRequest';
import { openSourcePicker } from '../sources/picker.js';
import { IMG } from '../ui/constants.js';
import { levelProbeSupported } from './audiolevel.js';
import { APP_DOWNLOAD_URL } from './appDownload';
import { CONVERSION_LABEL } from './engine';
import { filterEpisodes, firstUnseen } from './episodes';
import { manualSubPlan } from './langAnnounce';
import { keyToAction, stepVolume } from './keys';
import { MINI_ON_EXIT_KEY, miniOnExitEnabled } from './mini';
import { isOfflineView } from './offlinePlay';
import { remember } from './memory';
import { backStep, setShellFullscreen, setShellPip } from './shell';
import { activeSkip, buildSubmission } from './skip';
import { serverBase } from './server';
import { normalizeSubStyle, writeSubStyle } from './subs';
import { rateChoice } from './subsync';
import { groupAudioTracks, sectionSubtitleTracks } from './trackgroups';
import { partyBridge } from '../party/bridge';
import { togglePartyPanel } from '../ui/partypanel.js';
import { toggleOpen } from '../ui/disclosure.js';
import { playBest } from './session.js';
import { closePlayer } from './sessionClose.js';
import { streamInstead } from './sessionFailover.js';
import { chooseResume, continueWith, ensureEpisodes } from './sessionOpen.js';
import { externalAction } from './externalScreen.js';
import { castAction, castSeekBy, castTogglePlay, endCasting, isCasting } from './sessionCast.js';
import { AUDIO_MODE_LABEL, playView } from './sessionPlay.js';
import { catchUp, openReactHere, shareHere, toggleCinemaMenu } from './sessionSocial.js';
import { S, activeLangPrefs, audioPreference, AUTOPIP_KEY, AUTOSYNC_MIN, AUTOSYNC_TARGET, headingFor, langPrefsOf, miniState, nextRef, originalLangOf, storeGet, storeSet, THUMBS_KEY } from './sessionState.js';
import { cancelAddonThumb, thumbSourceOf } from './sessionThumbs.js';
import { refreshUI, saveProgress } from './sessionTick.js';
import { allSubtitleTracks, clearSecondary, effectiveSubMode, ensureExternalSubs, finishAutoSync, forceTranscoding, saveSync, selectSecondary, selectSubtitle, startAutoSync, stopAutoSync, trackContext, transcodeAction } from './sessionTracks.js';
import { canMinimize, expandPlayer, leavePlayer, minimizePlayer, rememberVolume } from './sessionUi.js';


// ---------- Actions ----------

/** Actions qui changent ce qui est lu : elles mettent fin à la diffusion Chromecast. */
const CAST_ENDS = new Set(['choose-myself', 'stream', 'next', 'episode', 'retry', 'force-hls', 'audio', 'resume', 'restart']);

/** Salon : seul l'hôte change d'épisode ; un invité qui essaie est prévenu. La lecture (pause, reprise, saut) est partagée. */
function guestBlocked() {
  if (!partyBridge.guestLocked()) return false;
  S.ui.toast('Seul l’hôte du salon change d’épisode', 1800);
  return true;
}

export function seekTo(t) {
  if (!S.P || !S.P.view || !S.P.engine || isCasting()) return;
  S.P.engine.seek(t);
  S.P.watch.reset(Date.now());
  S.P.skipped = null;
}

function seekBy(d) {
  if (!S.P || !S.P.view || !S.P.engine) return;
  if (isCasting()) { castSeekBy(d); return; } // diffusion : le saut se fait sur le téléviseur
  const st = S.P.engine.state();
  const to = Math.min(st.duration || Infinity, Math.max(0, st.time + d));
  seekTo(to);
  S.ui.toast((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900);
  S.ui.previewTime(to);
}

export function togglePlay() {
  if (!S.P || !S.P.view || !S.P.engine) return;
  if (isCasting()) { castTogglePlay(); return; } // diffusion : lecture / pause sur le téléviseur
  const st = S.P.engine.state();
  if (st.paused) S.P.engine.play(); else { S.P.engine.pause(); saveProgress(true); }
}

async function toggleFullscreen() {
  // Dans la coque, c'est la fenêtre qui passe en plein écran (mpv est dessous), pas un élément de la page.
  if (S.shell) { S.shellFullscreen = !S.shellFullscreen; setShellFullscreen(S.shell, S.shellFullscreen); refreshUI(); return; }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await S.ui.root.requestFullscreen();
  } catch (_) { S.ui.toast('Plein écran indisponible'); }
}

async function togglePip() {
  // Coque Windows : mpv est sous la page, donc c'est la fenêtre entière qui devient une petite fenêtre au premier plan.
  if (S.shell && S.P && S.P.engine.kind === 'mpv') { setShellPip(S.shell, !S.shellPip); return; }
  if (!S.P || !S.P.view || !S.P.engine.supportsPip()) { S.ui.toast('Image dans l’image indisponible ici'); return; }
  try { await S.P.engine.togglePip(); } catch (_) { S.ui.toast('Image dans l’image refusée par le navigateur'); }
}

/** Sélecteur de sources dans un panneau du lecteur : recherche initiale sans résultat, lecture automatique désactivée, changement de source. */
export function showSourcesPanel(reasons = []) {
  const p = S.P;
  if (!p) return;
  if (S.nativeEng && p.engine === S.nativeEng) S.nativeEng.closeNow(); // le panneau web passe par-dessus : l'activité native se ferme
  if (p.addon && !p.views.length) { S.ui.toast('Aucune source trouvée pour ce titre', 3500); closePlayer(); return; } // le sélecteur chercherait via IMDb
  expandPlayer();
  S.ui.setLoading(null);
  S.ui.root.classList.remove('is-searching');
  const host = S.ui.mountPanel('sources', 'Sources');
  openSourcePicker(p.req, null, {
    host, views: p.views, pending: p.pending || [], imdb: p.imdb, currentIndex: p.view ? p.view.index : null, notice: reasons, originalLang: originalLangOf(p), lp: langPrefsOf(p),
    onPick: (view, views) => {
      if (!S.P || S.P.token !== p.token) return;
      // Choix manuel : la bascule salon et son filtre de repli ne s'appliquent plus.
      p.fallbackFilter = null;
      S.ui.closePanel(true);
      p.views = views;
      p.ranked = [...views];
      if (!p.view) { p.req.imdb = p.req.imdb || p.imdb; continueWith(view, { resume: p.resumeMode || 'ask' }); return; }
      if (view.index === p.view.index) { S.ui.focusFirst(); return; }
      if (p.casting) endCasting(p, 'pause'); // la nouvelle source part de la position du téléviseur
      const st = p.engine.state();
      p.attempts = 0;
      p.tried = new Set();
      S.ui.toast('Changement de source…');
      playView(view, st.time > 5 ? st.time : 0);
      S.ui.focusFirst();
    },
  });
}

/** Lecteur natif en attente d'un « suivant » refusé (le toast est caché sous l'activité) : il reprend la lecture. */
function resumeNative(p) {
  if (p && p.engine && p.engine.kind === 'native') p.engine.play();
}

/** Épisode d'une série : même ouverture immédiate que « Lecture », sans reprise proposée. */
export function playEpisode(season, episode) {
  const p = S.P;
  if (!p) return Promise.resolve();
  if (guestBlocked()) { resumeNative(p); return Promise.resolve(); }
  S.ui.closePanel(true);
  S.ui.closeMark(false); // le segment en cours de marquage appartient à l'épisode qu'on quitte
  // Lecteur natif Android : son activité couvre la page. Laissée ouverte, l'épisode quitté continuerait par-dessus la recherche
  // du suivant ; la vignette flottante, elle, ne cache rien et reste en place (en pause) pour être réutilisée.
  if (p.engine && p.engine.kind === 'native') { if (S.nativeMini) p.engine.pause(); else p.engine.closeNow(); }
  if (p.addon) {
    // Titre d'addon : l'identifiant de flux de l'épisode est celui de la fiche de l'addon (`videos[].id`), sans TMDB.
    const video = addonVideoOf(p.addon.videos, season, episode);
    return playBest({ ...p.req, season, episode, streamId: video ? video.id : null }, p.opener, { resume: 'none' });
  }
  const info = (p.episodes.get(season) || []).find((e) => e.episode === episode);
  // Identifiant de flux de la structure canonique : même numérotation que l'épisode affiché (progression « vu » inchangée).
  const streamId = (info && info.streamId) || null;
  return playBest({ ...p.req, season, episode, imdb: p.imdb, streamId }, p.opener, { resume: 'none', notYetAired: info && !info.aired ? info.airDate : '' });
}

/** Message quand un épisode pas encore diffusé n'a aucune source (la recherche décide de la lecture). */
export const notYetAiredMessage = (iso) => 'Pas encore disponible — diffusion le ' +
  new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Le marquage d'un segment demande un épisode identifié (IMDb) et un lastAddon configuré. */
export const markAllowed = (p) => !!p.imdb && isConfigured();

export function submitTarget() {
  const p = S.P;
  return { type: p.req.type === 'tv' ? 'series' : 'movie', imdbId: p.imdb, season: p.req.type === 'tv' ? p.cur.season ?? 1 : 0, episode: p.req.type === 'tv' ? p.cur.episode ?? 1 : 0 };
}

export async function sendSegment(kind, start, end, negative) {
  const p = S.P;
  const body = buildSubmission(submitTarget(), kind, start, end, p.engine.state().duration, negative);
  if (!body) { S.ui.toast('Segment invalide : il doit durer au moins 3 s'); return false; }
  try {
    await postLt('skip/submit', body);
    if (negative) {
      p.segments = p.segments.filter((s) => !(s.kind === kind && s.inferred));
      S.ui.setSkip(null);
      S.ui.toast('Merci, signalé : ce segment ne sera plus proposé');
    } else {
      p.segments = [...p.segments.filter((s) => s.kind !== kind), { kind, start: body.start, end: body.end }].sort((a, b) => a.start - b.start);
      S.ui.toast('Merci, segment envoyé et utilisable tout de suite');
    }
    return true;
  } catch (_) {
    S.ui.toast('Envoi impossible pour le moment');
    return false;
  }
}

export function onAction(act, data) {
  if (!S.P) return;
  if (act === 'close') { closePlayer(); return; }
  // Diffusion en cours : changer de source ou d'épisode ramène d'abord la lecture ici, à la position du téléviseur.
  if (isCasting() && CAST_ENDS.has(act)) endCasting(S.P, 'pause');
  if (act === 'minimize') { if (!minimizePlayer()) closePlayer(); return; }
  if (act === 'leave') { leavePlayer(); return; }
  if (act === 'expand') { expandPlayer(); return; }
  if (act === 'party') { togglePartyPanel(); return; }
  if (act === 'react') { toggleOpen(S.ui.isReactOpen, openReactHere, () => S.ui.closeReact(true)); return; }
  if (act === 'cinema') { toggleCinemaMenu(); return; }
  if (act === 'share') { shareHere(); return; }
  if (act === 'catch-up') { catchUp(); return; }
  if (act === 'app-download') { window.open(APP_DOWNLOAD_URL, '_blank', 'noopener'); return; }
  if (act === 'stream') { streamInstead({ force: true }); return; }
  if (act === 'source') { toggleOpen(() => S.ui.panel === 'sources', () => { if (isOfflineView(S.P.view)) streamInstead({ picker: true }); else showSourcesPanel(); }, () => S.ui.closePanel()); return; }
  if (act === 'choose-myself') {
    if (S.P.race) { S.P.race.cancel(); S.P.race = null; }
    S.P.pickMine = true; // arrête l'attente de lancement (playBest)
    S.P.view = null;
    showSourcesPanel();
    return;
  }
  if (act.startsWith('ext-')) { externalAction(act); return; }
  if (act === 'cast' || act.startsWith('cast-')) { castAction(act); return; }
  // Recherche en cours : seuls « Annuler » et le choix de source sont possibles. Lecteur externe : pas de moteur, pas de commande de lecture.
  if (!S.P.view || !S.P.engine) return;
  const st = S.P.engine.state();
  const s = S.P.subs;
  switch (act) {
    case 'toggle-play': togglePlay(); break;
    case 'back10': seekBy(-10); break;
    case 'fwd10': seekBy(10); break;
    case 'mute': S.P.engine.setMuted(!st.muted); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'pip': togglePip(); break;
    case 'info': S.ui.togglePanel('info'); break;
    case 'skip': { const seg = activeSkip(S.P.segments, st.time); if (seg) { seekTo(seg.end); S.ui.toast('Passé'); } break; }
    case 'skip-wrong': { const seg = activeSkip(S.P.segments, st.time); if (seg) sendSegment(seg.kind, seg.start, seg.end, true); break; }
    case 'next': { const nx = nextRef(); if (nx) playEpisode(nx.season, nx.episode); else { S.ui.toast('Dernier épisode'); resumeNative(S.P); } break; }
    case 'next-dismiss': S.P.nextDismissed = true; S.ui.setNextCard(null); break;
    case 'end-dismiss': S.P.endDismissed = true; S.ui.setEndRow(false); break;
    case 'more-info': case 'recs': {
      const key = S.P.req.key;
      closePlayer();
      setTimeout(() => {
        if (location.hash !== '#/' + key.replace(':', '/')) location.hash = '#/' + key.replace(':', '/');
        if (act === 'recs') setTimeout(() => { const el = document.querySelector('#detail [data-tab="recs"], #detail .f-recs, #detail #f-recs'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 700);
      }, 50);
      break;
    }
    case 'langsettings': closePlayer(); location.hash = '#/settings'; break;
    case 'resume': chooseResume(true); break;
    case 'restart': chooseResume(false); break;
    case 'retry': { const v = S.P.view; S.P.tried = new Set(); S.P.attempts = 0; playView(v, st.time > 5 ? st.time : 0); break; }
    case 'audio': {
      const t = S.P.engine.audioTracks().find((x) => x.id === data.id);
      if (t && t.lang) remember(S.P.req.key, { audio: t.lang });
      S.P.applier.markManual();
      if (!t || S.P.engine.setAudioTrack(data.id) === false) { S.ui.toast('Langue audio non modifiable avec cette source', 6000, transcodeAction()); break; }
      S.P.watch.reset(Date.now());
      setTimeout(() => S.ui.refreshPanel(), 200);
      S.ui.toast('Audio : ' + t.label);
      break;
    }
    case 'force-hls': forceTranscoding(); break;
    case 'sub': {
      const t = data.id ? allSubtitleTracks().find((x) => x.id === data.id) : null;
      remember(S.P.req.key, { sub: t ? t.lang || 'off' : 'off' });
      S.P.applier.markManual();
      // Mode apprentissage : le second sous-titre (langue principale) reste, sauf si l'on choisit « off » ou la langue principale.
      const plan = manualSubPlan(allSubtitleTracks(), activeLangPrefs(), data.id || null, trackContext().canSecondary, !!s.secondaryId);
      clearSecondary();
      selectSubtitle(data.id || null);
      if (plan.secondaryId) selectSecondary(plan.secondaryId);
      if (plan.toast) S.ui.toast(plan.toast, 4500);
      break;
    }
    case 'subsearch': ensureExternalSubs(false, true); break;
    case 'suboffset': s.offset = Math.max(-120, Math.min(120, Math.round((s.offset + Number(data.by)) * 10) / 10)); saveSync(); S.ui.refreshPanel(); break;
    case 'suboffset-reset': s.offset = 0; s.rate = 1; s.rateId = 'none'; s.rateHint = ''; saveSync(); S.ui.refreshPanel(); break;
    case 'subrate': { const r = rateChoice(data.id); s.rate = r.ratio; s.rateId = r.id; s.rateHint = ''; saveSync(); S.ui.refreshPanel(); break; }
    case 'autosync': startAutoSync(); break;
    case 'autosync-now':
      if (s.sync.probe && s.sync.probe.seconds() >= AUTOSYNC_MIN) finishAutoSync(); else S.ui.toast('Encore un peu de lecture (' + AUTOSYNC_MIN + ' s minimum)');
      break;
    case 'autosync-cancel': stopAutoSync(); S.ui.refreshPanel(); break;
    case 'style-open': s.styleOpen = data.open === '1'; break;
    case 'substyle': updateStyle({ [data.key]: data.key === 'size' ? Number(data.val) : data.val }); break;
    case 'substep': updateStyle({ [data.key]: s.style[data.key] + Number(data.by) }); break;
    case 'rate': S.P.engine.setRate(Number(data.rate)); setTimeout(() => S.ui.refreshPanel(), 50); break;
    case 'thumbs': storeSet(THUMBS_KEY, storeGet(THUMBS_KEY) === '0' ? '1' : '0'); S.thumbs.cancel(); cancelAddonThumb(); S.ui.refreshPanel(); break;
    case 'aspect': S.P.aspect = data.val; S.ui.video.style.objectFit = data.val; S.ui.refreshPanel(); break;
    case 'miniexit': storeSet(MINI_ON_EXIT_KEY, miniOnExitEnabled(storeGet(MINI_ON_EXIT_KEY)) ? '0' : '1'); S.ui.refreshPanel(); break;
    case 'autopip': { const on = storeGet(AUTOPIP_KEY) !== '1'; storeSet(AUTOPIP_KEY, on ? '1' : '0'); S.ui.video.autoPictureInPicture = on; S.ui.refreshPanel(); break; }
    case 'season': ensureEpisodes(Number(data.season)); break;
    case 'episode': playEpisode(Number(data.season), Number(data.episode)); break;
    case 'epsearch': S.P.epQuery = data.q || ''; if (!S.P.epQuery) S.P.epSearchOpen = false; S.ui.refreshPanel(); if (!S.P.epSearchOpen) S.ui.focusEpSearch(false); break;
    case 'ep-search': {
      S.P.epSearchOpen = !(S.P.epSearchOpen || S.P.epQuery);
      if (!S.P.epSearchOpen) S.P.epQuery = '';
      S.ui.refreshPanel();
      S.ui.focusEpSearch(S.P.epSearchOpen);
      break;
    }
    case 'ep-seen': {
      Promise.resolve(userStore.setWatched(S.P.req.key, [{ season: Number(data.season), episode: Number(data.episode) }], data.seen === '1')).then(() => S.ui.refreshPanel());
      break;
    }
    case 'ep-season-seen': {
      const sn = Number(data.season);
      const aired = (S.P.episodes.get(sn) || []).filter((e) => e.aired);
      const all = aired.every((e) => userStore.isWatched(S.P.req.key, sn, e.episode));
      Promise.resolve(userStore.setWatched(S.P.req.key, aired.map((e) => ({ season: sn, episode: e.episode })), !all)).then(() => { S.ui.refreshPanel(); S.ui.toast(all ? 'Saison marquée non vue' : 'Saison marquée comme vue'); });
      break;
    }
    case 'ep-next-unseen': {
      const start = S.P.panelSeason ?? S.P.cur.season ?? 1;
      const seen = (sn, e) => userStore.isWatched(S.P.req.key, sn, e);
      const skipFillers = getSkipPref('filler');
      const from = firstUnseen(S.P.seasons, S.P.episodes, start, seen, skipFillers);
      if (!from) {
        // Réglage filler actif : il peut rester des épisodes non vus, mais seulement des fillers ou des récaps.
        const onlyFillers = skipFillers && !!firstUnseen(S.P.seasons, S.P.episodes, start, seen);
        S.ui.toast(onlyFillers ? 'Il ne reste que des épisodes filler' : 'Tous les épisodes diffusés sont vus');
        break;
      }
      S.P.epQuery = '';
      S.P.epSearchOpen = false;
      ensureEpisodes(from.season).then(() => S.ui.revealEpisode(from.episode));
      break;
    }
    case 'mark-open': toggleOpen(S.ui.isMarkOpen, () => S.ui.openMark(), () => S.ui.closeMark(true)); break;
    default: break;
  }
}

function updateStyle(patch) {
  const next = normalizeSubStyle({ ...S.P.subs.style, ...patch });
  S.P.subs.style = next;
  writeSubStyle(next);
  // « Par défaut : Auto / Toujours / Jamais » : « Jamais » coupe les sous-titres automatiques du profil (réglage Audio et sous-titres).
  if (patch.mode !== undefined) { setLangPrefs({ subsOn: next.mode !== 'off' }); pushPrefs(); }
  S.ui.refreshPanel();
}

// ---------- Panneaux ----------

export function panelData(name) {
  const p = S.P;
  if (!p || !p.view) return {};
  if (name === 'tracks') {
    const tracks = p.engine.audioTracks();
    const hasApi = p.engine.kind !== 'html' || !!S.ui.video.audioTracks || !!p.engine.hls;
    const titles = {};
    tracks.forEach((t) => { titles[t.id] = t.title || ''; });
    const subTracks = allSubtitleTracks();
    subTracks.forEach((t) => { titles[t.id] = t.title || ''; });
    const s = p.subs;
    const cues = s.native ? s.nativeCues : s.cues;
    const sup = levelProbeSupported(S.ui.video);
    const sync = s.sync;
    return {
      audio: {
        groups: groupAudioTracks(tracks, audioPreference(), titles),
        note: hasApi ? 'Une seule piste audio dans ce flux.' : 'Ce navigateur n’expose pas les pistes audio d’un fichier lu directement.',
        canTranscode: !tracks.length && !hasApi && p.choice && p.choice.engine === 'direct',
      },
      subs: {
        sections: sectionSubtitleTracks(subTracks, [wantedSubLang(activeLangPrefs())], titles), selectedId: s.selectedId, offset: s.offset, rate: s.rateId, rateHint: s.rateHint,
        style: { ...s.style, mode: effectiveSubMode() }, styleOpen: s.styleOpen, loading: s.loading,
        sync: {
          canAuto: !!s.selectedId && cues.length > 0 && sup.ok && p.engine.kind === 'html', reason: !s.selectedId ? 'Choisis d’abord une piste de sous-titres.' : !cues.length ? 'Pas de texte à caler pour cette piste.' : sup.reason || (p.engine.kind !== 'html' ? 'Indisponible avec mpv.' : ''),
          state: sync.state, message: sync.message, seconds: sync.probe ? sync.probe.seconds() : 0, target: AUTOSYNC_TARGET,
        },
      },
    };
  }
  if (name === 'settings') {
    const v = p.view;
    const st = p.engine.state();
    const web = v.web === 'direct' ? { html: '<b class="lp-tag is-sync">Lecture directe</b>' } : v.web === 'convert' ? { html: '<b class="lp-tag is-warn">Conversion</b>' } : null;
    const rows = [
      ['Résolution', [v.quality, v.sourceType].filter(Boolean).join(' · ') || 'Inconnue'],
      ['Codec', [v.codec, ...v.hdr].filter(Boolean).join(' · ') || 'Inconnu'],
      ['Débit', [v.bitrateLabel, v.sizeLabel].filter(Boolean).join(' · ') || 'Inconnu'],
      ['Langue', v.langs.map((l) => l.label + (l.verified ? ' ✓' : '')).join(', ') || 'Inconnue'],
      ['Fournisseur', v.provider || v.statusLabel],
    ];
    if (web) rows.push(['Lecture', web]);
    if (p.choice) rows.push(['Moteur', p.choice.label]);
    if (p.audioMode) rows.push(['Son', { html: '<b class="lp-tag ' + (p.audioMode === 'app' ? 'is-sync' : 'is-warn') + '">' + (p.audioMode === 'app' ? 'Décodé par l’app' : 'Sans son') + '</b>' }]);
    return {
      rate: st.rate, source: rows, aspect: p.aspect, thumbs: storeGet(THUMBS_KEY) !== '0', thumbsAvailable: thumbSourceOf(p).mode !== 'none', autoPip: storeGet(AUTOPIP_KEY) === '1', pipAvailable: p.engine.supportsPip(), autoPipAvailable: p.engine.kind !== 'mpv' && p.engine.supportsPip(),
      miniAvailable: canMinimize(), miniOnExit: miniOnExitEnabled(storeGet(MINI_ON_EXIT_KEY)),
      canMark: markAllowed(p),
    };
  }
  if (name === 'episodes') {
    const s = p.panelSeason ?? p.cur.season ?? 1;
    const all = (p.episodes.get(s) || []).map((e) => {
      const pr = userStore.getProgress(p.req.key, s, e.episode);
      return { ...e, watched: userStore.isWatched(p.req.key, s, e.episode), progress: pr && pr.duration ? pr.position / pr.duration : 0 };
    });
    return {
      seasons: p.seasons, season: s, episodes: filterEpisodes(all, p.epQuery), loading: !!p.episodesLoading, error: !!p.episodesError, current: p.cur, query: p.epQuery, searchOpen: !!(p.epSearchOpen || p.epQuery),
      logo: p.meta.logo, backdrop: p.meta.backdrop ? IMG('w780', p.meta.backdrop) : '', poster: p.meta.poster ? IMG('w342', p.meta.poster) : '', title: p.meta.title, total: all.length, watchedCount: all.filter((e) => e.watched).length,
    };
  }
  if (name === 'info') {
    const v = p.view;
    const eps = p.episodes.get(p.cur.season);
    const ep = eps && eps.find((e) => e.episode === p.cur.episode);
    const [title, sub] = headingFor(p);
    const rows = [
      ['Moteur', p.choice ? p.choice.label : '…'],
      ['Conversion', p.choice && p.choice.engine === 'hls' ? CONVERSION_LABEL[p.conversion || 'unknown'] : 'Aucune (lecture directe)'],
      ...(p.audioMode ? [['Son', AUDIO_MODE_LABEL[p.audioMode] + (p.audioMode === 'app' ? '' : ' · ' + p.audioNote)]] : []),
      ['Qualité', [v.quality, v.sourceType, v.codec, ...v.hdr].filter(Boolean).join(' · ')],
      ['Origine', v.origins.map((o) => o.name).join(', ') || 'Inconnue'],
      ['Audio', v.audio || 'Inconnu'],
      ['Taille', [v.sizeLabel, v.bitrateLabel, v.durationLabel && '≈ ' + v.durationLabel].filter(Boolean).join(' · ') || 'Inconnue'],
      ['Statut', v.statusLabel],
      ['Fichier', v.filename || '—'],
    ];
    if (v.releaseGroup) rows.push(['Release', v.releaseGroup]);
    if (p.probeTracks.height) rows.push(['Vidéo', p.probeTracks.width + '×' + p.probeTracks.height + ' · ' + (p.probeTracks.videoCodec || '').toUpperCase()]);
    if (p.choice) rows.push(['Pourquoi ce moteur', p.choice.reason]);
    // Le serveur de streaming ne sert plus qu'à la conversion HLS (web) : sinon, lecture directe du lien débridé.
    if (p.debridVia) rows.push(['Débridé par', p.debridVia]);
    rows.push(['Serveur de streaming', p.choice && p.choice.viaServer ? serverBase() : isOfflineView(p.view) ? 'Non utilisé · fichier téléchargé' : 'Non utilisé · lecture directe du lien débridé']);
    const m = p.model;
    return {
      title, episode: sub, synopsis: (ep && ep.overview) || p.meta.overview, rating: m && m.vote ? Number(m.vote).toFixed(1) + ' / 10' : '',
      cast: m && Array.isArray(m.cast) ? m.cast.slice(0, 12) : [], rows,
    };
  }
  return {};
}

// ---------- Clavier ----------

export function onKey(e) {
  if (!S.P || S.ui.root.hidden) return;
  // Saisie d'une réaction ou d'une réponse dans une bulle : aucun raccourci du lecteur (Échap est géré par chaque champ).
  if (e.target instanceof Element && (e.target.closest('.lp-react') || e.target.closest('.lp-notemenu') || e.target.closest('.lp-bubble') || e.target.closest('.lp-mk') || e.target.closest('.lp-mk-h'))) return;
  const modal = document.getElementById('modal');
  if (modal && !modal.hidden) return; // une fenêtre de l'application (note, etc.) gère ses propres touches
  // Salon d'attente ouvert par-dessus le lecteur : aucun raccourci de lecture.
  if (document.body.classList.contains('has-party-lobby')) return;
  const t = e.target instanceof Element ? e.target : null;
  // Panneau et bandeau du salon : Échap y replie d'abord leur menu (ou rend le focus), et leurs cases et boutons radio gardent
  // Espace et les flèches. Sans cela, Échap quittait le lecteur, donc le salon.
  if (t && t.closest('.lp-party, .ps-band') && (e.key === 'Escape' || t.closest('input:not([type="text"]), select'))) return;
  // Recherche d'épisode : Échap referme le champ (et vide le filtre) sans fermer le panneau (ODY-202).
  if (e.key === 'Escape' && t && t.closest('.lp-search')) { e.preventDefault(); e.stopImmediatePropagation(); onAction('ep-search'); return; }
  // Mini-lecteur : aucun raccourci global, sauf « I » pour agrandir (jamais pendant une saisie).
  if (miniState.mini) {
    const field = !!(t && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    if ((e.key === 'i' || e.key === 'I') && !field && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); expandPlayer(); }
    return;
  }
  // Échap referme d'abord le marquage de segment (poignées sur la barre).
  if (e.key === 'Escape' && S.ui.isMarkOpen()) { e.preventDefault(); e.stopImmediatePropagation(); S.ui.closeMark(true); return; }
  const typing = !!(t && t.closest('input[type="text"], textarea, select'));
  const onButton = !!(t && t.closest('button'));
  // Le sélecteur de sources (dans un panneau) gère lui-même ses flèches ; Échap le ferme.
  if (S.ui.panel === 'sources' && e.key !== 'Escape' && e.key !== 'Backspace' && /^(Arrow|Home$|End$)/.test(e.key)) return;
  const action = keyToAction(e.key, { panelOpen: !!S.ui.panel, typing, onButton }, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
  S.ui.wake();
  if (!action) return;
  if (action.type === 'wake') return;
  if (action.type === 'nav') { e.preventDefault(); e.stopImmediatePropagation(); S.ui.navPanel(action.dir); return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  // Lecteur externe (view sans engine) : seule la fermeture (back) est traitée.
  if ((!S.P.view || !S.P.engine) && action.type !== 'back') return;
  const st = S.P.view && S.P.engine ? S.P.engine.state() : null;
  switch (action.type) {
    case 'toggle-play': togglePlay(); break;
    case 'seek': seekBy(action.by); break;
    case 'volume': { S.P.engine.setMuted(false); const v = stepVolume(st.volume, action.by); S.P.engine.setVolume(v); rememberVolume(v); S.ui.toast('Volume ' + Math.round(v * 100) + ' %', 900); break; }
    case 'fullscreen': toggleFullscreen(); break;
    case 'mute': S.P.engine.setMuted(!st.muted); break;
    case 'skip': onAction('skip'); break;
    case 'pip': togglePip(); break;
    case 'panel': S.ui.togglePanel(action.name); break;
    case 'mini': if (!minimizePlayer()) S.ui.toast('Réduction indisponible ici'); break;
    case 'next': onAction('next'); break;
    case 'back':
      switch (backStep({ panelOpen: !!S.ui.panel, shellFullscreen: !!S.shell && S.shellFullscreen, docFullscreen: !!document.fullscreenElement, shellPip: !!S.shell && S.shellPip })) {
        case 'panel': S.ui.closePanel(); break;
        case 'shell-pip': togglePip(); break;
        case 'shell-fullscreen': toggleFullscreen(); break;
        case 'doc-fullscreen': document.exitFullscreen().catch(() => {}); break;
        default: leavePlayer();
      }
      break;
    default: break;
  }
}
