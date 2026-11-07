import { isAndroidApp } from '../data/config';
import { isShellEnvironment } from './shell';
import type { RemoteState } from './castLogic';

/* Chromecast (LAST-347) : SDK Google Cast (Web Sender) chargé à la demande, jamais au démarrage, avec le récepteur par défaut
 * (Default Media Receiver). Le SDK ne marche que dans Chrome (bureau, Android) : ailleurs (application Android, coque Windows,
 * Firefox, Safari) il n'est pas chargé et le bouton « Caster » reste caché. Types minimaux ci-dessous : pas de dépendance @types. */

export const CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
/** Délai au-delà duquel un SDK qui ne répond pas est tenu pour absent. */
const SDK_TIMEOUT_MS = 10_000;

interface CastSession {
  getCastDevice(): { friendlyName?: string };
  loadMedia(req: unknown): Promise<unknown>;
}
interface CastContext {
  setOptions(o: Record<string, unknown>): void;
  getCastState(): string;
  getCurrentSession(): CastSession | null;
  requestSession(): Promise<unknown>;
  endCurrentSession(stopCasting: boolean): void;
  addEventListener(type: string, fn: (e: { castState?: string }) => void): void;
}
interface RemotePlayer { isConnected: boolean; currentTime: number; duration: number; isPaused: boolean; playerState: string | null }
interface RemoteController {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  playOrPause(): void;
  seek(): void;
}
interface CastFramework {
  CastContext: { getInstance(): CastContext };
  CastContextEventType: { CAST_STATE_CHANGED: string };
  CastState: { NO_DEVICES_AVAILABLE: string };
  RemotePlayer: new () => RemotePlayer;
  RemotePlayerController: new (player: RemotePlayer) => RemoteController;
  RemotePlayerEventType: { ANY_CHANGE: string };
}
interface ChromeCast {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  Image: new (url: string) => unknown;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    StreamType: { BUFFERED: string };
    MediaInfo: new (url: string, contentType: string) => Record<string, unknown>;
    GenericMediaMetadata: new () => Record<string, unknown>;
    LoadRequest: new (info: unknown) => Record<string, unknown>;
  };
}
export interface CastWindow {
  cast?: { framework?: CastFramework };
  chrome?: { cast?: ChromeCast };
  __onGCastApiAvailable?: (ok: boolean) => void;
}

const win = (): CastWindow => globalThis as unknown as CastWindow;

/** Le SDK peut-il exister ici ? Navigateurs Chromium seulement (le SDK dit ensuite s'il marche), hors application Android et coque Windows (WebView2 a aussi `window.chrome`). */
export function castPossible(): boolean {
  if (isAndroidApp() || isShellEnvironment()) return false;
  return typeof win().chrome === 'object' && /Chrome\//.test(navigator.userAgent);
}

let sdk: Promise<CastFramework | null> | null = null;
let remote: { player: RemotePlayer; ctl: RemoteController } | null = null;

/** Charge le SDK une fois et configure le récepteur par défaut ; null si le SDK est absent, refusé ou trop lent. */
export function loadCastSdk(): Promise<CastFramework | null> {
  if (sdk) return sdk;
  if (!castPossible()) return Promise.resolve(null);
  sdk = new Promise<CastFramework | null>((resolve) => {
    const w = win();
    const timer = setTimeout(() => resolve(null), SDK_TIMEOUT_MS);
    const ready = (ok: boolean) => {
      clearTimeout(timer);
      const fw = w.cast && w.cast.framework;
      const cc = w.chrome && w.chrome.cast;
      if (!ok || !fw || !cc) { resolve(null); return; }
      try {
        fw.CastContext.getInstance().setOptions({ receiverApplicationId: cc.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: cc.AutoJoinPolicy.ORIGIN_SCOPED });
        resolve(fw);
      } catch { resolve(null); }
    };
    // SDK déjà présent (autre chargement) : prêt tout de suite ; sinon il appelle __onGCastApiAvailable une fois chargé.
    if (w.cast && w.cast.framework) { ready(true); return; }
    w.__onGCastApiAvailable = ready;
    const s = document.createElement('script');
    s.src = CAST_SDK_URL;
    s.async = true;
    s.onerror = () => { clearTimeout(timer); resolve(null); };
    document.head.appendChild(s);
  });
  return sdk;
}

/** Suit la présence d'un appareil Cast sur le réseau : `fn(true)` quand au moins un est visible. Sans SDK, `fn(false)` une fois. */
export async function watchCastAvailability(fn: (available: boolean) => void): Promise<void> {
  const fw = await loadCastSdk();
  if (!fw) { fn(false); return; }
  const ctx = fw.CastContext.getInstance();
  const update = (state: string) => fn(state !== fw.CastState.NO_DEVICES_AVAILABLE);
  ctx.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, (e) => update(e.castState || ctx.getCastState()));
  update(ctx.getCastState());
}

export interface CastMedia {
  url: string;
  contentType: string;
  startAt: number;
  title: string;
  subtitle?: string;
  poster?: string;
}

/** Erreur du SDK : `cancel` quand l'utilisateur ferme le choix de l'appareil (rien à signaler). */
export class CastError extends Error {
  constructor(readonly code: string) { super('cast:' + code); }
}

/**
 * Ouvre (ou reprend) une session et charge la source sur le récepteur à `startAt` secondes. Renvoie le nom de l'appareil.
 * Le SDK rejette avec un code (`cancel`, `timeout`, `session_error`, `load_failed`…).
 */
export async function startCast(media: CastMedia): Promise<string> {
  const fw = await loadCastSdk();
  const cc = win().chrome && win().chrome!.cast;
  if (!fw || !cc) throw new CastError('unavailable');
  const ctx = fw.CastContext.getInstance();
  let session = ctx.getCurrentSession();
  if (!session) {
    try { await ctx.requestSession(); } catch (e) { throw new CastError(typeof e === 'string' ? e : 'session_error'); }
    session = ctx.getCurrentSession();
  }
  if (!session) throw new CastError('session_error');
  const info = new cc.media.MediaInfo(media.url, media.contentType);
  info.streamType = cc.media.StreamType.BUFFERED;
  const meta = new cc.media.GenericMediaMetadata();
  meta.title = media.title;
  if (media.subtitle) meta.subtitle = media.subtitle;
  if (media.poster) meta.images = [new cc.Image(media.poster)];
  info.metadata = meta;
  const req = new cc.media.LoadRequest(info);
  req.currentTime = media.startAt;
  req.autoplay = true;
  try { await session.loadMedia(req); } catch (e) { throw new CastError(typeof e === 'string' ? e : 'load_failed'); }
  return session.getCastDevice().friendlyName || '';
}

/** Instantané du lecteur distant, au format de castLogic. */
const snapshot = (pl: RemotePlayer): RemoteState => ({ time: pl.currentTime || 0, duration: pl.duration || 0, paused: !!pl.isPaused });

/**
 * Relevés du lecteur distant (≈ 1 par seconde pendant la lecture) : `onState` reçoit l'état, `onEnd` la fin de la session
 * (déconnexion depuis Chrome ou le téléviseur) ou du média (`finished`). Renvoie une fonction qui coupe l'écoute.
 */
export async function followRemote(onState: (s: RemoteState) => void, onEnd: (finished: boolean, last: RemoteState) => void): Promise<() => void> {
  const fw = await loadCastSdk();
  if (!fw) return () => undefined;
  if (!remote) { const player = new fw.RemotePlayer(); remote = { player, ctl: new fw.RemotePlayerController(player) }; }
  const { player, ctl } = remote;
  let on = true;
  let started = false;
  let last = snapshot(player);
  const type = fw.RemotePlayerEventType.ANY_CHANGE;
  const off = () => { on = false; ctl.removeEventListener(type, listener); };
  const listener = () => {
    if (!on) return;
    if (!player.isConnected) { off(); onEnd(false, last); return; }
    // IDLE après la lecture : média terminé (ou arrêté depuis le téléviseur). Avant le premier PLAYING, c'est le chargement.
    if (player.playerState === 'PLAYING' || player.playerState === 'BUFFERING') started = true;
    if (started && player.playerState === 'IDLE') { off(); onEnd(true, last); return; }
    if (player.duration > 0) { last = snapshot(player); onState(last); }
  };
  ctl.addEventListener(type, listener);
  return off;
}

/** Lecture / pause sur le téléviseur. */
export function remoteTogglePlay(): void {
  if (remote && remote.player.isConnected) remote.ctl.playOrPause();
}

/** Saut sur le téléviseur (secondes). */
export function remoteSeek(time: number): void {
  if (!remote || !remote.player.isConnected) return;
  remote.player.currentTime = Math.max(0, time);
  remote.ctl.seek();
}

/** Fin de la diffusion : la session se ferme et le récepteur s'arrête. */
export function stopCast(): void {
  const fw = win().cast && win().cast!.framework;
  if (!fw) return;
  try { fw.CastContext.getInstance().endCurrentSession(true); } catch { /* session déjà fermée */ }
}

/** Tests : oublie le SDK chargé et le lecteur distant. */
export function resetCastForTests(): void {
  sdk = null;
  remote = null;
}
