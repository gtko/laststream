import { shouldSave } from './progress';

/* Chromecast (LAST-347) : décisions sans le SDK Google Cast, testées. Le branchement au SDK est dans ./cast, celui à la session
 * dans ./sessionCast.js. Le Chromecast va chercher la source lui-même : il ne voit ni l'appareil, ni son serveur de streaming. */

/** Messages de refus, affichés tels quels. */
export const CAST_REFUSED = {
  local: 'Ce fichier est lu depuis cet appareil : le Chromecast ne peut pas y accéder.',
  proxied: 'Cette source passe par notre serveur : le Chromecast ne peut pas la lire. Essaie une autre source.',
  loopback: 'Cette source n’est joignable que depuis cet appareil : le Chromecast ne peut pas la lire.',
  scheme: 'Ce lien ne peut pas être envoyé au Chromecast.',
} as const;

/** Conteneurs que le récepteur par défaut lit souvent mal (pistes audio AC3/DTS, sous-titres intégrés) : envoi permis, avec un avis. */
const RISKY = /\.(mkv|avi|wmv|flv)$/i;
export const CAST_RISKY_NOTE = 'Format peu courant sur Chromecast : l’image ou le son peuvent manquer.';

export type CastTarget =
  | { ok: true; url: string; contentType: string; warn: string }
  | { ok: false; reason: string };

export interface CastSourceInfo {
  /** Lien lu par le lecteur (p.mediaUrl). */
  url: string;
  /** Lien réécrit par le serveur de streaming (en-têtes ajoutés) : son adresse n'est valable que pour cet appareil. */
  proxied?: boolean;
  /** Fichier téléchargé, lu depuis l'appareil. */
  offline?: boolean;
  /** Adresse du serveur de streaming (serverBase) : tout lien qui y pointe est refusé. */
  serverBase?: string;
}

/** Hôte de bouclage (127.0.0.0/8, localhost, ::1, 0.0.0.0) : joignable seulement depuis l'appareil qui lit. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Type MIME annoncé au récepteur, d'après l'extension du chemin (mp4 par défaut : le cas des liens débridés sans extension). */
export function castContentType(url: string): string {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* lien relatif : chemin brut */ }
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase();
  if (ext === 'm3u8') return 'application/x-mpegURL';
  if (ext === 'mpd') return 'application/dash+xml';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  return 'video/mp4';
}

const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ''; } };

/** Peut-on envoyer cette source au Chromecast ? Seul un lien http(s) public passe ; le reste est refusé avec un message clair. */
export function castTarget(src: CastSourceInfo): CastTarget {
  if (src.offline) return { ok: false, reason: CAST_REFUSED.local };
  if (src.proxied) return { ok: false, reason: CAST_REFUSED.proxied };
  let u: URL;
  try { u = new URL(src.url); } catch { return { ok: false, reason: /^(blob|data|file):/i.test(src.url) ? CAST_REFUSED.local : CAST_REFUSED.scheme }; }
  if (u.protocol === 'blob:' || u.protocol === 'data:' || u.protocol === 'file:') return { ok: false, reason: CAST_REFUSED.local };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: CAST_REFUSED.scheme };
  if (isLoopbackHost(u.hostname)) return { ok: false, reason: CAST_REFUSED.loopback };
  // Serveur de streaming (même sur le réseau local) : ses liens portent une session propre à cet appareil.
  const server = src.serverBase ? originOf(src.serverBase) : '';
  if (server && u.origin === server) return { ok: false, reason: CAST_REFUSED.proxied };
  return { ok: true, url: u.href, contentType: castContentType(u.href), warn: RISKY.test(u.pathname) ? CAST_RISKY_NOTE : '' };
}

/**
 * Position envoyée au Chromecast : celle de la lecture locale (exacte) ; si le lecteur n'a pas encore de position, la progression
 * enregistrée ; sinon le début. Jamais dans les 5 dernières secondes (le récepteur finirait aussitôt).
 */
export function castStartPosition(localTime: number, saved: { position: number; duration: number } | null | undefined, duration = 0): number {
  const dur = duration > 0 ? duration : saved && saved.duration > 0 ? saved.duration : 0;
  const clamp = (t: number) => (dur > 0 ? Math.min(t, Math.max(0, dur - 5)) : t);
  if (Number.isFinite(localTime) && localTime > 1) return clamp(localTime);
  if (saved && Number.isFinite(saved.position) && saved.position > 1) return clamp(saved.position);
  return 0;
}

/** État du lecteur distant, tel que le SDK le donne (secondes). */
export interface RemoteState {
  time: number;
  duration: number;
  paused: boolean;
}

/**
 * Écriture de la progression pendant la diffusion : même cadence que le lecteur local (shouldSave, toutes les 10 s) et même seuil
 * (rien sous 1 s). La mise en pause sur le téléviseur enregistre tout de suite, comme la pause locale.
 */
export function createCastProgress(save: (time: number, duration: number) => void, now: () => number = Date.now) {
  let lastSave = 0;
  let wasPaused = false;
  let last: RemoteState | null = null;
  const write = (s: RemoteState, force: boolean) => {
    if (!(s.time > 1) || !shouldSave(now(), lastSave, force, s.duration)) return false;
    lastSave = now();
    save(s.time, s.duration);
    return true;
  };
  return {
    /** Relevé du lecteur distant ; renvoie vrai si la progression a été écrite. */
    update(s: RemoteState): boolean {
      last = s;
      const pausedNow = s.paused && !wasPaused;
      wasPaused = s.paused;
      if (s.paused) return pausedNow ? write(s, true) : false;
      return write(s, false);
    },
    /** Écriture immédiate du dernier relevé (fin de la diffusion, « Reprendre ici », fermeture). */
    flush(): boolean { return last ? write(last, true) : false; },
    /** Dernier relevé reçu (null avant le premier). */
    last: (): RemoteState | null => last,
  };
}

/** Libellé de l'écran de diffusion. */
export const castingLabel = (device: string): string => 'Lecture sur ' + (device.trim() || 'le Chromecast');
