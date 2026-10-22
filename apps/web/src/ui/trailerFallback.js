/* Repli des bandes-annonces : quand YouTube refuse la vidéo (bloquée dans le pays, intégration interdite, supprimée), on
   passe à la candidate suivante au lieu d'afficher « Vidéo non disponible ». Mémoire des échecs : data/trailerHealth.ts. */
import { isTrailerFailed, isUnplayableError, markTrailerFailed, parseYoutubeError } from '../data/trailerHealth';

/** Délai sans erreur après lequel l'iframe est considérée saine (si elle n'envoie aucun état de lecture). */
const REVEAL_MS = 3000;

/**
 * Marque `failedKey` en échec sur cet appareil, retire la vidéo de `d.trailers` et met à jour `d.trailer` / `d.trailerVO`
 * (vides s'il ne reste rien). Renvoie la candidate suivante `{ key, vo }` ou null. `d` peut être absent : l'échec est
 * seulement mémorisé.
 */
export function nextTrailer(d, failedKey) {
  markTrailerFailed(failedKey);
  if (!d) return null;
  const rest = (Array.isArray(d.trailers) ? d.trailers : []).filter((t) => t.key !== failedKey && !isTrailerFailed(t.key));
  d.trailers = rest;
  const next = rest[0] || null;
  d.trailer = next ? next.key : '';
  d.trailerVO = next ? next.vo : false;
  return next;
}

/**
 * Surveille l'iframe YouTube (API IFrame, `enablejsapi=1`) : `onFail(code)` à la première erreur de lecture, `onPlaying()`
 * une seule fois à la première lecture ou mise en mémoire tampon, ou après `revealMs` sans erreur. À appeler après le
 * `load` de l'iframe. Renvoie une fonction d'annulation (idempotente).
 * @param {HTMLIFrameElement} iframe
 * @param {{ onFail?: (code: number | null) => void, onPlaying?: () => void, revealMs?: number }} [o]
 * @returns {() => void}
 */
export function guardEmbed(iframe, o = {}) {
  const { onFail, onPlaying, revealMs = REVEAL_MS } = o;
  let off = false;
  let revealed = false;
  let timer = 0;
  const cancel = () => {
    if (off) return;
    off = true;
    clearTimeout(timer);
    window.removeEventListener('message', onMsg);
  };
  const reveal = () => {
    if (off || revealed) return;
    revealed = true;
    clearTimeout(timer);
    if (onPlaying) onPlaying();
  };
  function onMsg(e) {
    if (off || !iframe || !iframe.contentWindow || e.source !== iframe.contentWindow) return;
    const code = parseYoutubeError(e.data);
    if (isUnplayableError(code)) {
      cancel();
      if (onFail) onFail(code);
      return;
    }
    if (revealed || typeof e.data !== 'string') return;
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    const st = d && d.info && d.info.playerState;
    if (st === 1 || st === 3) reveal();
  }
  window.addEventListener('message', onMsg);
  timer = setTimeout(reveal, revealMs);
  try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); } catch (_) { /* iframe fermée */ }
  return cancel;
}

/**
 * Garde d'un iframe d'aperçu ou de lecture : à chaque chargement, surveille l'erreur ; sur échec, passe à la candidate
 * suivante (`srcFor(key)` donne la nouvelle adresse) ou, s'il n'y en a plus, appelle `onExhausted()`.
 * `d` : détail portant `trailers` ; `key` : vidéo en cours. Rappels : `onReveal()` quand la vidéo joue vraiment,
 * `onSwap(next)` avant le changement d'adresse, `onReload()` à chaque chargement suivant un changement.
 * Renvoie la fonction d'arrêt.
 * @param {HTMLIFrameElement} iframe
 * @param {any} d
 * @param {string} key
 * @param {{ srcFor: (key: string) => string, onReveal?: () => void, onSwap?: (next: { key: string, vo: boolean }) => void,
 *   onReload?: (iframe: HTMLIFrameElement) => void, onExhausted?: () => void, revealMs?: number }} o
 * @returns {() => void}
 */
export function guardAmbient(iframe, d, key, o) {
  const { srcFor, onReveal, onSwap, onReload, onExhausted, revealMs } = o;
  let cur = key;
  let cancel = () => {};
  let dead = false;
  let swapped = false;
  const arm = () => {
    if (dead) return;
    cancel();
    if (swapped && onReload) onReload(iframe);
    cancel = guardEmbed(iframe, {
      revealMs,
      onPlaying: () => { if (!dead && onReveal) onReveal(); },
      onFail: () => {
        if (dead) return;
        const next = nextTrailer(d, cur);
        if (!next) {
          dead = true;
          iframe.removeEventListener('load', arm);
          if (onExhausted) onExhausted();
          return;
        }
        cur = next.key;
        swapped = true;
        if (onSwap) onSwap(next);
        iframe.src = srcFor(next.key);
      },
    });
  };
  iframe.addEventListener('load', arm);
  return () => {
    dead = true;
    cancel();
    iframe.removeEventListener('load', arm);
  };
}

/**
 * Retire de `root` les boutons « Bande-annonce » (`[data-trailer]` et `[data-vid]`). Avec `keys`, seuls les `[data-vid]`
 * de ces vidéos partent (les lignes « Bonus » d'une fiche restent).
 */
export function hideTrailerButtons(root, keys) {
  if (!root) return;
  if (keys) {
    root.querySelectorAll('[data-vid]').forEach((b) => { if (keys.includes(b.dataset.vid)) b.remove(); });
    return;
  }
  root.querySelectorAll('[data-trailer], [data-vid]').forEach((b) => b.remove());
}
