/* Pistes audio et sous-titres : choix automatique, sous-titres externes, second sous-titre, calage et synchro automatique. */
import { addonUrl, isConfigured } from '../data/config';
import { wantedSubLang } from '../data/langPrefs';
import { episodeStreamId } from '../data/sources';
import { createLevelProbe, levelProbeSupported } from './audiolevel.js';
import { fetchExternalSubtitles } from './extsubs';
import { beginSubsLoad, endSubsLoad, isCurrentSubsLoad } from './subsLoad';
import { autoSubsToast } from './langPolicy';
import { learnAnnouncement, secondaryFailureMsg } from './langAnnounce';
import { isOfflineView } from './offlinePlay';
import { fileKey, getMemory, getSubSync, setSubSync } from './memory';
import { toNativeSubtitles } from './native';
import { embeddedSubtitleUrl, fetchOpenSubParams, serverAlive, serverBase, subtitlesVttUrl } from './server';
import { parseSubtitles } from './subs';
import { RATE_CHOICES, findSync, suggestRate, syncTrusted } from './subsync';
import { normalizeLang } from './tracks';
import { partyBridge } from '../party/bridge';
import { localFailure } from './sessionFailover.js';
import { playView } from './sessionPlay.js';
import { nudgeTick } from './sessionTick.js';
import { S, activeLangPrefs, originalLangOf } from './sessionState.js';


// ---------- Événements moteur ----------

export function onReady() {
  if (!S.P) return;
  // Fichier téléchargé que le navigateur ouvre sans décoder l'image (HEVC, AV1 sans matériel) : message explicite au lieu d'un écran noir.
  if (isOfflineView(S.P.view) && S.P.engine.kind === 'html' && S.ui.video.videoWidth === 0) { localFailure('video'); return; }
  if (S.P.engine.kind === 'native') { ensureExternalSubs(true); scheduleNativeApply(); return; } // pistes appliquées une fois la liste connue
  if (!S.P.defaultsDone) setTimeout(() => S.P && applyDefaultTracks(true), 700);
}

export function onTracks() {
  if (!S.P) return;
  if (S.P.engine.kind === 'native') { if (S.P.applier.done) lateTracks(); else scheduleNativeApply(); S.ui.refreshPanel(); return; }
  if (!S.P.defaultsDone) applyDefaultTracks(false);
  else lateTracks();
  S.ui.refreshPanel();
}

export function allSubtitleTracks() {
  const s = S.P.subs;
  const fromEngine = S.P.engine.subtitleTracks();
  const embedded = fromEngine.length ? fromEngine : S.P.probeTracks.subtitles.filter((t) => /^(ass|ssa)$/.test(t.codec)).map((t) => ({
    ...t, url: embeddedSubtitleUrl(S.P.mediaBase || serverBase(), S.P.hlsId, t.engineId, S.P.hlsQuery || ''),
  }));
  return [...embedded.map((t) => ({ ...t, selected: t.id === s.selectedId })), ...s.external.map((t) => ({ ...t, selected: t.id === s.selectedId }))];
}

/** Mode des sous-titres en vigueur : l'interrupteur des réglages (source de vérité) puis « Auto / Toujours » du panneau. */
export function effectiveSubMode() {
  if (!activeLangPrefs().subsOn) return 'off';
  return S.P && S.P.subs.style.mode === 'always' ? 'always' : 'auto';
}

/** Contexte du choix de pistes : langue d'origine du titre, mémoire de ce titre, capacités du moteur. */
export function trackContext() {
  const p = S.P;
  const mem = getMemory(p.req.key);
  const lp = activeLangPrefs();
  return {
    originalLang: originalLangOf(p),
    unknownAudioLang: p.view && p.view.hasFrench && (lp.audio === 'fr' || lp.native === 'fr') ? 'fr' : '',
    alwaysSubs: effectiveSubMode() === 'always',
    rememberedAudio: mem.audio || '',
    rememberedSub: mem.sub || '',
    // Second sous-titre : piste texte dont on a l'adresse (calque de la page) ou piste embarquée affichée par mpv ; jamais en natif Android.
    canSecondary: (t) => p.engine.kind !== 'native' && (!!t.url || (p.engine.kind === 'mpv' && t.origin === 'embedded')),
  };
}

/** Ce que le moteur courant sait faire pour appliquer un choix de pistes. */
function trackSink() {
  const p = S.P;
  if (p.engine.kind === 'native') {
    return { setAudio: (id) => p.engine.setAudioTrack(id), setSub: (id) => p.engine.setSubtitleTrack(id === null ? null : id), setSecondary: () => {} };
  }
  return { setAudio: (id) => p.engine.setAudioTrack(id), setSub: (id) => selectSubtitle(id, true), setSecondary: (id) => selectSecondary(id) };
}

/** Message discret quand des sous-titres viennent d'être activés automatiquement (une fois par lecture). */
function announceAuto(pick) {
  const p = S.P;
  if (!p || !pick || p.autoToast) return;
  const lp = activeLangPrefs();
  const main = normalizeLang(lp.native || lp.audio);
  // Sous-titres forcés d'un audio dans la langue principale : rien à annoncer.
  if (pick.audioLang && pick.audioLang === main && !lp.learn && !lp.subsAlways && effectiveSubMode() !== 'always') return;
  const msg = autoSubsToast(pick);
  if (!msg) return;
  p.autoToast = true;
  toastBusy(p, msg, 4500);
}

/** Message qui occupe l'unique emplacement de toast : l'annonce du mode apprentissage attend qu'il soit passé. */
export function toastBusy(p, msg, ms, action) {
  p.toastBusyUntil = Date.now() + ms;
  S.ui.toast(msg, ms, action);
}

/** Passage en transcodage (HLS, toutes les pistes audio), depuis le panneau Audio ou le message du mode apprentissage. */
export function forceTranscoding() {
  const p = S.P;
  if (!p || isOfflineView(p.view)) return; // fichier téléchargé : pas de transcodage
  p.forceHls = true;
  S.ui.closePanel(true);
  S.ui.toast('Passage en transcodage…');
  p.tried = new Set();
  const st = p.engine.state();
  playView(p.view, st.time > 5 ? st.time : 0);
}

/** Action « Transcodage » d'un message sur la langue audio non modifiable ; aucune si on est déjà en transcodage. */
export const transcodeAction = () => (S.P && !S.P.forceHls ? { label: 'Transcodage', run: forceTranscoding } : undefined);

/**
 * Mode apprentissage : un seul message groupé par lecture (langue audio ou sous-titres absents, second sous-titre indisponible,
 * audio non modifiable), même sans sous-titres activés. Attend la fin de la recherche des sous-titres externes (sinon « pas de
 * sous-titres » serait faux) et le passage des toasts de démarrage.
 */
function announceLearn() {
  const p = S.P;
  if (!p || p.learnToast || !p.applier.pick) return;
  const lp = activeLangPrefs();
  const audioUnknown = lp.learn && p.engine.kind === 'html' && !p.engine.audioTracks().length;
  const view = p.view;
  const a = learnAnnouncement(p.applier.pick, lp, { engineKind: p.engine.kind, audioUnknown, subsOff: !lp.subsOn, extSettled: !!p.extSettled, probeAudio: p.probeTracks.audio, directNotified: !!p.directNotified });
  if (a.wait) return;
  p.learnToast = true;
  if (!a.msg) return;
  const show = () => { if (S.P === p && p.view === view) S.ui.toast(a.msg, 6000, a.offerTranscode ? transcodeAction() : undefined); };
  const wait = (p.toastBusyUntil || 0) - Date.now();
  if (wait > 0) { clearTimeout(p.learnShowTimer); p.learnShowTimer = setTimeout(show, wait + 100); } else show();
}

/** Filet : si la recherche externe ne conclut jamais, on annonce quand même après 10 s. */
function armLearnTimer(p) {
  clearTimeout(p.learnTimer);
  p.learnTimer = setTimeout(() => { if (S.P === p) { p.extSettled = true; announceLearn(); } }, 10000);
}

/** Piste audio et sous-titres initiaux d'après les langues du profil, une seule fois par source (quand le moteur a annoncé ses pistes). */
function applyDefaultTracks(force) {
  const p = S.P;
  if (!p || p.defaultsDone) return;
  const audio = p.engine.audioTracks();
  const subs = allSubtitleTracks();
  if (!audio.length && !subs.length && !force) return;
  p.defaultsDone = true;
  const pick = p.applier.apply(audio, subs, activeLangPrefs(), trackContext(), trackSink(), true);
  let audioLang = pick ? pick.audioLang : '';
  if (!audio.length) audioLang = p.view.hasFrench ? 'fr' : '';
  p.audioLang = audioLang;
  p.autoAppliedAt = Date.now();
  announceAuto(pick);
  armLearnTimer(p);
  ensureExternalSubs(true);
  announceLearn();
}

/** Sous-titres externes arrivés après le démarrage : complètent ce qui manquait, sans rien changer à un choix déjà fait. */
function lateTracks() {
  const p = S.P;
  if (!p || !p.defaultsDone) return;
  const pick = p.applier.late(p.engine.audioTracks(), p.engine.kind === 'native' ? p.engine.subtitleTracks() : allSubtitleTracks(), activeLangPrefs(), trackContext(), trackSink());
  if (pick) { p.autoAppliedAt = Date.now(); announceAuto(pick); }
  announceLearn();
}

/** Lecteur natif Android : la liste des pistes n'est complète qu'un instant après le début ; on applique une fois, sans double sous-titre. */
function scheduleNativeApply() {
  const p = S.P;
  if (!p || p.applier.done) return;
  clearTimeout(p.nativeApplyTimer);
  p.nativeApplyTimer = setTimeout(() => {
    if (!S.P || S.P !== p || p.applier.done) return;
    const audio = p.engine.audioTracks();
    const subs = p.engine.subtitleTracks();
    if (!audio.length && !subs.length) return;
    p.defaultsDone = true;
    const pick = p.applier.apply(audio, subs, activeLangPrefs(), trackContext(), trackSink(), true);
    p.audioLang = pick ? pick.audioLang : '';
    p.autoAppliedAt = Date.now();
    announceAuto(pick);
    armLearnTimer(p);
    announceLearn();
  }, 700);
}

/** Sous-titres externes (lastAddon, OpenSubtitles) ; `force` relance la recherche à la demande. */
export async function ensureExternalSubs(auto, force) {
  const p = S.P;
  if (!p) return;
  const loadSeq = beginSubsLoad(p.subs, p.view.index, force);
  if (loadSeq === null) return;
  S.ui.refreshPanel();
  const token = p.token;
  const view = p.view;
  try {
    let params = null;
    // Fichier téléchargé : sous-titres de l'addon seulement s'il y a du réseau (jamais le serveur de streaming).
    if (isOfflineView(view) && navigator.onLine === false) return;
    if (p.mediaUrl && !isOfflineView(view) && (await serverAlive())) params = await fetchOpenSubParams(p.mediaUrl);
    const id = p.imdb ? (p.req.type === 'tv' ? episodeStreamId(p.imdb, p.req.season, p.req.episode, p.req.streamId) : p.imdb) : '';
    if (!id) return;
    const type = p.req.type === 'tv' ? 'series' : 'movie';
    const addon = isConfigured() ? addonUrl('subtitles/' + type + '/' + id + '.json') : null;
    const list = await fetchExternalSubtitles({ type, id, hash: params && params.hash, size: (params && params.size) || view.sizeBytes || null, filename: view.filename }, addon, wantedSubLang(activeLangPrefs()));
    if (!S.P || S.P.token !== token || S.P.view !== view || !isCurrentSubsLoad(p.subs, loadSeq)) return;
    p.subs.external = list;
    p.subs.loadedFor = view.index;
    if (p.engine.kind === 'native') { p.engine.addSubtitles(toNativeSubtitles(list, wantedSubLang(activeLangPrefs()))); return; }
    if (auto && p.defaultsDone) lateTracks();
  } finally {
    if (S.P && S.P.token === token && endSubsLoad(p.subs, loadSeq)) {
      S.ui.refreshPanel();
      if (S.P.view === view && !p.extSettled) {
        // Natif : les sous-titres ajoutés n'apparaissent dans la liste du lecteur qu'un instant plus tard ; on ne conclut qu'alors.
        if (p.engine.kind === 'native') {
          clearTimeout(p.learnNativeTimer);
          p.learnNativeTimer = setTimeout(() => { if (S.P === p && p.view === view) { p.extSettled = true; announceLearn(); } }, 1500);
        } else { p.extSettled = true; announceLearn(); }
      }
    }
  }
}

export async function selectSubtitle(id, quiet) {
  const p = S.P;
  if (!p) return;
  const s = p.subs;
  if (s.swapped) clearSecondary();
  s.selectedId = id || null;
  s.cues = [];
  s.nativeCues = [];
  s.native = false;
  s.offset = 0;
  s.rate = 1;
  s.rateId = 'none';
  s.shift = 0;
  s.rateHint = '';
  stopAutoSync();
  partyBridge.refreshSubtitles();
  if (!id) {
    p.engine.setSubtitleTrack(null);
    if (!quiet) S.ui.toast('Sous-titres désactivés');
    S.ui.refreshPanel();
    return;
  }
  const track = allSubtitleTracks().find((t) => t.id === id);
  if (!track) return;
  s.syncKey = fileKey(p.view.filename || p.meta.title, p.view.sizeBytes) + '#' + (track.url || track.id);
  if (track.origin === 'embedded' && !track.url) {
    p.engine.setSubtitleTrack(track.id);
    s.native = true; // mpv les affiche lui-même ; hls.js : cues relues dans le calque (recalées par hls.js sur le fichier)
  } else {
    p.engine.setSubtitleTrack(null);
    // Les sous-titres extraits par le serveur gardent l'heure du fichier d'origine, dont le premier paquet n'est pas toujours à 0.
    if (track.origin === 'embedded') s.shift = -p.probeTracks.startTime;
    try {
      const up = !isOfflineView(p.view) && (await serverAlive());
      const base = serverBase();
      const via = up && track.origin === 'external' ? subtitlesVttUrl(base, track.url) : track.url;
      let text = '';
      try { text = await (await fetch(via)).text(); } catch (_) { text = await (await fetch(track.url)).text(); }
      if (S.P === p && s.selectedId === id) {
        s.cues = parseSubtitles(text, track.url);
        if (!s.cues.length) S.ui.toast('Ce sous-titre est vide ou illisible');
        else initialSync(track);
      }
    } catch (_) {
      if (S.P === p) S.ui.toast('Impossible de charger ce sous-titre');
    }
  }
  if (!quiet) S.ui.toast('Sous-titres : ' + track.label);
  partyBridge.refreshSubtitles();
  S.ui.refreshPanel();
  nudgeTick();
}

/** Retire le second sous-titre (et rend à mpv ses deux sous-titres dans l'ordre normal). */
export function clearSecondary() {
  const p = S.P;
  if (!p) return;
  const s = p.subs;
  if (s.secondaryId && p.engine.supportsSecondary && p.engine.supportsSecondary()) p.engine.setSecondarySubtitleTrack(null);
  Object.assign(s, { secondaryId: null, cues2: [], native2: false, shift2: 0, swapped: false });
  nudgeTick();
}

/**
 * Second sous-titre (mode apprentissage) : la langue apprise reste le sous-titre principal (en haut) et la langue principale
 * passe dessous. mpv affiche lui-même les pistes embarquées (le second en haut : on échange alors les deux emplacements) ;
 * sinon la page affiche les cues des pistes dont on a l'adresse.
 */
export async function selectSecondary(id) {
  const p = S.P;
  if (!p) return;
  const s = p.subs;
  if (!id) { clearSecondary(); S.ui.refreshPanel(); return; }
  const tracks = allSubtitleTracks();
  const track = tracks.find((t) => t.id === id);
  if (!track) return;
  const first = tracks.find((t) => t.id === s.selectedId);
  const fail = (kind) => { if (S.P === p && s.secondaryId === id) { s.secondaryId = null; S.ui.toast(secondaryFailureMsg(kind), 5000); } };
  s.secondaryId = id;
  s.cues2 = [];
  s.native2 = false;
  s.shift2 = 0;
  s.swapped = false;
  if (track.origin === 'embedded' && !track.url) {
    if (!(p.engine.supportsSecondary && p.engine.supportsSecondary())) { fail('unsupported'); return; }
    s.native2 = true;
    if (first && first.origin === 'embedded' && !first.url && s.native) {
      // Les deux pistes sont affichées par mpv : le second sous-titre y est en haut, donc la langue apprise.
      p.engine.setSubtitleTrack(track.id);
      p.engine.setSecondarySubtitleTrack(first.id);
      s.swapped = true;
    } else {
      p.engine.setSecondarySubtitleTrack(track.id);
    }
    S.ui.refreshPanel();
    return;
  }
  if (track.origin === 'embedded') s.shift2 = -p.probeTracks.startTime;
  try {
    const up = !isOfflineView(p.view) && (await serverAlive());
    const via = up && track.origin === 'external' ? subtitlesVttUrl(serverBase(), track.url) : track.url;
    let text = '';
    try { text = await (await fetch(via)).text(); } catch (_) { text = await (await fetch(track.url)).text(); }
    if (S.P === p && s.secondaryId === id) {
      s.cues2 = parseSubtitles(text, track.url);
      if (!s.cues2.length) fail('empty');
    }
  } catch (_) {
    fail('load');
  }
  S.ui.refreshPanel();
  nudgeTick();
}

/** Calage d'une piste chargée : celui mémorisé pour ce fichier, sinon une correction de vitesse suggérée. */
function initialSync(track) {
  const p = S.P;
  const s = p.subs;
  const [file, sub] = s.syncKey.split('#');
  const saved = getSubSync(file, sub);
  if (saved) {
    s.offset = saved.offset;
    s.rate = saved.rate;
    s.rateId = (RATE_CHOICES.find((r) => Math.abs(r.ratio - saved.rate) < 1e-4) || RATE_CHOICES[0]).id;
    s.rateHint = 'Calage mémorisé pour ce fichier.';
    return;
  }
  const last = s.cues.length ? Math.max(...s.cues.map((c) => c.end)) : 0;
  const dur = p.engine.state().duration || p.probeTracks.durationSec || 0;
  const guess = suggestRate(last, dur);
  if (guess.id !== 'none') {
    s.rate = guess.ratio;
    s.rateId = guess.id;
    s.rateHint = 'Vitesse corrigée automatiquement (' + guess.label + ') : ces sous-titres semblent calés pour une autre cadence.';
    S.ui.toast('Sous-titres : vitesse corrigée (' + guess.label + ')', 4500);
  }
  void track;
}

export function saveSync() {
  const s = S.P.subs;
  if (!s.syncKey) return;
  const [file, sub] = s.syncKey.split('#');
  setSubSync(file, sub, { offset: s.offset, rate: s.rate });
}

// ---------- Synchronisation automatique (parole ↔ sous-titres) ----------

export function stopAutoSync() {
  const sy = S.P && S.P.subs.sync;
  if (sy && sy.probe) sy.probe.stop();
  if (S.P) S.P.subs.sync = { state: 'idle', message: '' };
}

export function startAutoSync() {
  const p = S.P;
  const sup = levelProbeSupported(S.ui.video);
  if (!sup.ok) { p.subs.sync = { state: 'idle', message: sup.reason }; S.ui.refreshPanel(); return; }
  const probe = createLevelProbe(S.ui.video);
  if (!probe.ok) { p.subs.sync = { state: 'idle', message: probe.reason }; S.ui.refreshPanel(); return; }
  probe.start();
  p.subs.sync = { state: 'collecting', probe, message: '' };
  p.engine.play();
  S.ui.toast('Analyse lancée : laisse la lecture avancer', 3500);
  S.ui.refreshPanel();
}

export function finishAutoSync() {
  const p = S.P;
  const sy = p.subs.sync;
  if (!sy.probe) return;
  const samples = sy.probe.samples;
  sy.probe.stop();
  const cues = p.subs.native ? p.subs.nativeCues : p.subs.cues;
  const res = findSync(samples, cues, { rates: [1, RATE_CHOICES[1].ratio, RATE_CHOICES[2].ratio] });
  if (syncTrusted(res)) {
    p.subs.offset = Math.round((res.offset - p.subs.shift) * 10) / 10;
    p.subs.rate = res.rate;
    p.subs.rateId = (RATE_CHOICES.find((r) => Math.abs(r.ratio - res.rate) < 1e-4) || RATE_CHOICES[0]).id;
    saveSync();
    const sign = p.subs.offset > 0 ? '+' : '';
    p.subs.sync = { state: 'idle', message: 'Calé automatiquement : ' + sign + p.subs.offset.toFixed(1).replace('.', ',') + ' s' + (res.rate !== 1 ? ' et vitesse corrigée' : '') + '.' };
    S.ui.toast('Sous-titres calés (' + sign + p.subs.offset.toFixed(1).replace('.', ',') + ' s)', 4000);
  } else {
    p.subs.sync = { state: 'idle', message: 'Résultat peu fiable : réessaie sur une scène avec beaucoup de dialogues.' };
  }
  S.ui.refreshPanel();
}
