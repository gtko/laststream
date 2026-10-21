import {
  base64Of,
  getMolotovPlay,
  postMolotovHeartbeat,
  postMolotovLicense,
  type MolotovPlay,
} from '../data/molotovApi';
import { isShellEnvironment } from './shell';
import type { ShakaModule, ShakaPlayer } from 'shaka-player/dist/shaka-player.compiled.js';

/* Lecture Molotov : DASH + Widevine (Shaka Player).
 *
 * Le manifeste vient d'Akamai (`Access-Control-Allow-Origin: *`) : il se charge tel quel. La licence, elle, est
 * chiffrée côté Fubo : la requête EME part du lecteur, donc du navigateur — bloquée par CORS sur tous les hôtes. On
 * intercepte donc la requête de licence (filtre de Shaka) et on la fait nous-mêmes par le relais serveur, qui renvoie
 * les octets de la licence (schéma personnalisé `lslicense:`).
 *
 * Plateformes sans CDM Widevine (coque Windows : WebView2 + libmpv) : la lecture est impossible ici. L'interface le dit
 * et propose d'ouvrir l'application Molotov dans le navigateur. */

const HEARTBEAT_MS = 15_000;
const LICENSE_SCHEME = 'lslicense';

export interface MolotovPlaybackOptions {
  /** Identifiant de la chaîne chez Molotov. */
  channelId: string;
  /** Élément média de la page (le lecteur de la TV). */
  mediaElement: HTMLMediaElement;
  /** Échec : raison courte pour l'interface. */
  onError: (reason: string) => void;
  /** Fin normale de la préparation (la lecture démarre). */
  onReady?: () => void;
}

let player: ShakaPlayer | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let current: MolotovPlay | null = null;
/** Incrémenté à chaque lancement : deux clics rapides ne doivent pas se marcher dessus. */
let generation = 0;

/**
 * La plateforme sait-elle lire un flux Molotov ? La coque Windows n'a ni CDM Widevine (ni WebView2 ni libmpv n'en
 * embarquent) : ni le manifeste DASH ni la licence ne peuvent y passer.
 */
function molotovPlatformSupported(): boolean {
  return !isShellEnvironment();
}

/** Le navigateur expose-t-il un CDM Widevine ? (EME : `requestMediaKeySystemAccess`). */
async function widevineAvailable(): Promise<boolean> {
  const nav = globalThis.navigator as Navigator | undefined;
  if (!nav || typeof nav.requestMediaKeySystemAccess !== 'function') return false;
  try {
    await nav.requestMediaKeySystemAccess('com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
    }]);
    return true;
  } catch {
    return false;
  }
}

/** Shaka Player (chargé à la demande : c'est un gros module, hors paquet principal). */
async function loadShaka(): Promise<ShakaModule> {
  const mod = await import('shaka-player/dist/shaka-player.compiled.js');
  const shaka = ((mod as { default?: ShakaModule }).default ?? mod) as ShakaModule;
  try { shaka.polyfill.installAll(); } catch { /* polyfills déjà posés */ }
  return shaka;
}

/** Octets de la licence : le relais serveur relaie la challenge et rend la licence brute. */
async function fetchLicenseBytes(challenge: Uint8Array): Promise<Uint8Array> {
  const drm = current?.drm;
  if (!drm || !drm.licenseUrl || !drm.licenseToken) throw new Error('molotov_no_drm');
  const buffer = await postMolotovLicense({ licenseUrl: drm.licenseUrl, token: drm.licenseToken, challenge: base64Of(challenge) });
  return new Uint8Array(buffer);
}

/**
 * Prépare et lance la lecture d'une chaîne Molotov.
 * Les erreurs sont signalées par `onError` avec une raison courte : `unsupported`, `no_widevine`, `network`, `read`.
 */
export async function startMolotovPlayback(opts: MolotovPlaybackOptions): Promise<void> {
  const gen = ++generation;
  const stale = (): boolean => gen !== generation;
  stopPlayer();
  if (!molotovPlatformSupported()) {
    opts.onError('unsupported');
    return;
  }
  if (!(await widevineAvailable())) {
    if (stale()) return;
    opts.onError('no_widevine');
    return;
  }
  let play: MolotovPlay;
  try {
    play = await getMolotovPlay(opts.channelId);
  } catch {
    if (stale()) return;
    opts.onError('network');
    return;
  }
  if (stale()) return;
  current = play;
  if (!play.drm) {
    opts.onError('no_widevine');
    return;
  }
  let shaka: ShakaModule;
  try {
    shaka = await loadShaka();
  } catch {
    if (stale()) return;
    opts.onError('read');
    return;
  }
  if (stale()) return;
  try {
    const p = new shaka.Player(opts.mediaElement);
    player = p;
    p.addEventListener('error', () => opts.onError('read'));
    // La licence est décrite ici (URL et jeton) ; la requête est interceptée plus bas pour passer par notre transport.
    p.configure({
      drm: {
        servers: {
          'com.widevine.alpha': {
            url: play.drm.licenseUrl,
            headers: {
              'Content-Type': 'application/octet-stream',
              Authorization: 'Bearer ' + play.drm.licenseToken,
            },
          },
        },
      },
      streaming: { lowLatencyMode: false, bufferingGoal: 20, rebufferingGoal: 10 },
    });
    const net = p.getNetworkingEngine();
    net.registerRequestFilter('LICENSE', (_type, request) => {
      request.uris = [LICENSE_SCHEME + '://license'];
    });
    net.registerScheme(LICENSE_SCHEME, async (uri, request) => {
      const challenge = new Uint8Array(request.body ?? new ArrayBuffer(0));
      const data = await fetchLicenseBytes(challenge);
      return { uri, originalUri: uri, data, headers: {} };
    });
    await p.load(play.manifestUrl);
    await opts.mediaElement.play().catch(() => undefined);
    startHeartbeat(play, opts.mediaElement);
    opts.onReady?.();
  } catch {
    destroyMolotov();
    opts.onError('read');
  }
}

/** Progression : un heartbeat toutes les ~15 s (le cœur de la lecture Molotov). */
function startHeartbeat(play: MolotovPlay, media: HTMLMediaElement): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = (): void => {
    const progress = (media.currentTime || 0) * 1000;
    postMolotovHeartbeat(play, progress).catch(() => undefined);
  };
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}

/** Arrête la lecture Molotov (à la sortie de l'écran ou du lecteur). */
export function destroyMolotov(): void {
  generation += 1; // annule les lancements en cours
  stopPlayer();
}

/** Arrête le lecteur courant sans toucher au compteur de génération. */
function stopPlayer(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  current = null;
  const p = player;
  player = null;
  if (p) {
    try { void p.destroy(); } catch { /* déjà détruit */ }
  }
}
