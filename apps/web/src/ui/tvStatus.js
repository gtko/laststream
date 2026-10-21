/* État du lecteur TV affiché en haut de l'écran : « Connexion à la chaîne… », « En direct », « Son seul — pas d'image »,
 * « Chaîne indisponible » + raison courte. La logique est pure (événements -> état -> libellé) ; player.js fournit les
 * échantillons de lecture (position, présence d'image, pause) et les événements de début et d'échec. */

/** Délai au-delà duquel un son qui avance sans image devient « Son seul — pas d'image ». */
export const AUDIO_ONLY_MS = 5000;

/** Raisons courtes d'un échec de chaîne. */
const REASONS = {
  network: 'Problème réseau',
  refused: 'Flux refusé (accès ou CORS)',
  format: 'Format non pris en charge',
  read: 'Erreur de lecture',
  box: 'Chaîne de ta box : disponible sur le réseau de la box',
  molotov: 'Lecture Molotov indisponible sur cette plateforme',
  molotov_drm: 'Molotov : DRM Widevine indisponible ici',
};

export const LABELS = {
  connecting: 'Connexion à la chaîne…',
  live: 'En direct',
  audio: "Son seul — pas d'image",
  failed: 'Chaîne indisponible',
};

export function initialStatus() {
  return { phase: 'idle', time: -1, since: null, reason: '' };
}

/**
 * Événements : `{ type: 'connect' }` (tentative de flux), `{ type: 'sample', now, time, hasVideo, paused }` (échantillon
 * de lecture, ~1 s), `{ type: 'fail', reason }` (flux abandonné), `{ type: 'stop' }` (lecteur fermé).
 */
export function reduceTvStatus(state, ev) {
  switch (ev && ev.type) {
    case 'connect': return { phase: 'connecting', time: -1, since: null, reason: '' };
    case 'stop': return initialStatus();
    case 'fail': return { phase: 'failed', time: state.time, since: null, reason: REASONS[ev.reason] ? ev.reason : 'read' };
    case 'sample': return sample(state, ev);
    default: return state;
  }
}

function sample(state, ev) {
  // Hors lecture, ou échec déjà affiché : un échantillon ne change rien (l'échec reste jusqu'à la prochaine tentative).
  if (state.phase === 'idle' || state.phase === 'failed' || ev.paused) return state;
  const time = Number(ev.time) || 0;
  const advancing = state.time >= 0 && time > state.time;
  const next = { ...state, time };
  if (!advancing) return next;
  if (ev.hasVideo) return { ...next, phase: 'live', since: null };
  // Le son avance sans image : on attend AUDIO_ONLY_MS avant de l'annoncer (une image peut arriver juste après).
  const since = state.since == null ? ev.now : state.since;
  return { ...next, phase: ev.now - since >= AUDIO_ONLY_MS ? 'audio' : 'connecting', since };
}

/** Ce qui s'affiche pour un état : ton (classe CSS), libellé, raison (échec seulement). */
export function statusView(state) {
  switch (state && state.phase) {
    case 'connecting': return { tone: 'loading', text: LABELS.connecting, reason: '' };
    case 'live': return { tone: 'live', text: LABELS.live, reason: '' };
    case 'audio': return { tone: 'warn', text: LABELS.audio, reason: '' };
    case 'failed': return { tone: 'error', text: LABELS.failed, reason: REASONS[state.reason] || REASONS.read };
    default: return { tone: '', text: '', reason: '', hidden: true };
  }
}

/**
 * Ce qui s'affiche dans la pastille du haut : seulement l'attente, le son seul et l'échec. « En direct » n'y figure pas
 * (le badge DIRECT est dans la barre de contrôle), pour ne pas encombrer l'image pendant une lecture normale.
 */
export function pillView(state) {
  const v = statusView(state);
  return v.tone === 'live' ? { tone: '', text: '', reason: '', hidden: true } : v;
}

/** Raison d'un échec de lecteur externe (mpv : erreur texte ; natif : code). Renvoie une clé de REASONS. */
export function reasonOfExternal(err) {
  const msg = typeof err === 'string' ? err : String((err && (err.message || err.code)) || '');
  if (/40[13]|forbidden|denied|refus/i.test(msg)) return 'refused';
  if (/format|unrecogni|unsupported|codec|decod|demux|not supported/i.test(msg)) return 'format';
  if (/network|r[ée]seau|timeout|timed out|connect|resolve|loading failed|http|socket/i.test(msg)) return 'network';
  return 'read';
}

/**
 * Raison d'une erreur hls.js (`types` = H.ErrorTypes). Sur le web, une erreur réseau sans code HTTP est le plus souvent
 * un refus CORS : on le dit.
 */
export function reasonOfHls(d, types, web) {
  if (!d) return 'read';
  if (d.type === types.NETWORK_ERROR) {
    const code = d.response ? Number(d.response.code) : null;
    if (code === 401 || code === 403) return 'refused';
    if (web && (code == null || code === 0)) return 'refused';
    return 'network';
  }
  if (d.type === types.MEDIA_ERROR) return 'format';
  return 'read';
}

/** Dessine l'état dans `el` (pastille ou spinner, libellé, raison). Ne redessine pas un état inchangé : pas de bavardage aria-live. */
export function renderTvStatus(el, view) {
  if (!el) return;
  const key = view.hidden ? '' : [view.tone, view.text, view.reason].join('|');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.hidden = !!view.hidden;
  el.dataset.tone = view.tone || '';
  el.replaceChildren();
  if (view.hidden) return;
  const mark = document.createElement('span');
  mark.className = view.tone === 'loading' ? 'ps-spin' : 'ps-dot';
  mark.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'ps-text';
  text.textContent = view.text;
  el.append(mark, text);
  if (view.reason) {
    const reason = document.createElement('span');
    reason.className = 'ps-reason';
    reason.textContent = view.reason;
    el.append(reason);
  }
}
