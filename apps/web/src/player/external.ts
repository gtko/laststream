/* Lecteur externe : choix du lecteur par appareil, schémas d'URL des apps iOS, coque Windows (VLC ou lecteur système),
 * intent Android, plugin Capacitor « Autre application » et playlist .m3u. Fonctions testées (tests/external.test.ts). */
import { isIOS } from './appDownload';
import { isAndroidApp } from '../data/config';
import { getExternalPlayer } from '../data/prefs';
import { connectShell, isShellEnvironment } from './shell';

/** Où tourne l'app : coque Windows, app Android (Capacitor), iPhone ou iPad, Chrome Android, autre navigateur. */
export type Platform = 'ios' | 'android-app' | 'shell' | 'web-android' | 'web';

export interface PlayerOption { id: string; label: string; disabled?: boolean; hint?: string }

/** Ce qu'il faut faire pour lancer le lecteur choisi : navigation, appel de la coque, téléchargement ou plugin. */
export type LaunchPlan =
  | { kind: 'href'; href: string }
  | { kind: 'shell'; method: 'play-external'; params: string }
  | { kind: 'm3u'; content: string; filename: string }
  | { kind: 'plugin'; url: string; title: string }
  | { kind: 'unsupported' };

interface Scheme { id: string; label: string; build(url: string, title: string): string }

// Schémas d'URL à VÉRIFIER SUR APPAREIL : formats relevés dans les documentations des apps, non testés sur un iPhone réel.
const SCHEMES: readonly Scheme[] = [
  { id: 'vlc', label: 'VLC', build: (url) => `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}` },
  { id: 'infuse', label: 'Infuse', build: (url) => `infuse://x-callback-url/play?url=${encodeURIComponent(url)}` },
  { id: 'outplayer', label: 'Outplayer', build: (url) => `outplayer://${url}` },
  { id: 'nplayer', label: 'nPlayer', build: (url) => `nplayer-${url}` },
  { id: 'vidhub', label: 'VidHub', build: (url) => `open-vidhub://x-callback-url/open?url=${encodeURIComponent(url)}` },
  { id: 'senplayer', label: 'SenPlayer', build: (url) => `SenPlayer://x-callback-url/play?url=${encodeURIComponent(url)}` },
];

interface CapacitorWindow {
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, { open?: (options: { url: string; title: string }) => unknown } | undefined>;
}

function capacitorWindow(): CapacitorWindow | undefined {
  try { return (window as unknown as { Capacitor?: CapacitorWindow }).Capacitor; } catch { return undefined; }
}

/** Le plugin « ExternalPlayer » (sélecteur « Autre application ») existe-t-il dans cette version de l'app ? */
function hasAndroidPlugin(): boolean {
  try { return capacitorWindow()?.isPluginAvailable?.('ExternalPlayer') === true; } catch { return false; }
}

/** Où tourne l'app : coque Windows, app Android (Capacitor), iPhone ou iPad, Chrome Android, autre navigateur. */
export function detectPlatform(): Platform {
  if (isShellEnvironment()) return 'shell';
  if (isAndroidApp()) return 'android-app';
  if (isIOS()) return 'ios';
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /android/i.test(ua) ? 'web-android' : 'web';
}

/** Lecteurs proposés sur cette plateforme, dans l'ordre d'affichage. */
export function playerOptions(platform: Platform): PlayerOption[] {
  switch (platform) {
    case 'ios':
      return [
        { id: 'auto', label: 'Intégré, sinon lecteur externe' },
        { id: 'builtin', label: 'Intégré (Safari)' },
        ...SCHEMES.map(({ id, label }) => ({ id, label })),
      ];
    case 'shell':
      return [
        { id: 'builtin', label: 'Intégré (mpv)' },
        { id: 'vlc', label: 'VLC' },
        { id: 'system', label: 'Lecteur par défaut du système' },
      ];
    case 'android-app': {
      const plugin = hasAndroidPlugin();
      const chooser: PlayerOption = { id: 'chooser', label: 'Autre application…', disabled: !plugin };
      if (!plugin) chooser.hint = 'Nécessite la mise à jour de l’app';
      return [{ id: 'builtin', label: 'Intégré (libVLC)' }, chooser];
    }
    case 'web-android':
      return [
        { id: 'builtin', label: 'Intégré' },
        { id: 'intent', label: 'Autre application' },
        { id: 'm3u', label: 'Télécharger une playlist (.m3u)' },
      ];
    case 'web':
      return [
        { id: 'builtin', label: 'Intégré' },
        { id: 'm3u', label: 'Télécharger une playlist (.m3u)' },
      ];
  }
}

/** Choix par défaut : « auto » sur iPhone et iPad (intégré, sinon lecteur externe) ; intégré ailleurs. */
export const defaultPlayer = (platform: Platform): string => (platform === 'ios' ? 'auto' : 'builtin');

/** Lecteur retenu sur cet appareil : le réglage s'il est proposé et utilisable ici, sinon le défaut de la plateforme. */
export function currentPlayer(platform: Platform = detectPlatform()): string {
  const id = getExternalPlayer();
  return playerOptions(platform).some((o) => o.id === id && !o.disabled) ? id : defaultPlayer(platform);
}

/** Vrai si le choix ouvre une autre application (ni « intégré », ni « auto »). */
export const isExternalChoice = (id: string): boolean => id !== 'builtin' && id !== 'auto';

/** Playlist M3U d'une seule entrée. Le titre ne garde pas de retour à la ligne. */
export function buildM3u(url: string, title: string): string {
  return `#EXTM3U\n#EXTINF:-1,${title.replace(/[\r\n]+/g, ' ')}\n${url.replace(/[\r\n]+/g, '')}\n`;
}

/** Nom de fichier sans caractères interdits (Windows, Android, iOS), 120 caractères au plus. */
function fileBase(title: string): string {
  return title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'lecture';
}

// Format attendu par la coque Windows (laststream-shell-ng, external_player.rs : M3U_DATA_URI_PREFIX).
const M3U_DATA_URI_PREFIX = 'data:application/octet-stream;charset=utf-8;base64,';
const m3uDataUri = (m3u: string): string =>
  M3U_DATA_URI_PREFIX + btoa(String.fromCharCode(...new TextEncoder().encode(m3u)));

/** Intent Android : garde le schéma réel (http ou https) de l'URL. */
function intentHref(url: string, title: string): string {
  // Le fragment (#…) de l'URL est retiré : un « # » avant « #Intent » tronquerait l'intent.
  const bare = url.split('#')[0];
  const m = /^(https?):\/\//i.exec(bare);
  const scheme = m ? m[1].toLowerCase() : 'https';
  const rest = m ? bare.slice(m[0].length) : bare;
  return `intent://${rest}#Intent;scheme=${scheme};type=video/*;S.title=${encodeURIComponent(title)};end`;
}

/** Plan de lancement du lecteur `playerId` pour cette URL. `vlc` et `system` ne sont proposés que dans la coque, `vlc` (schéma iOS) ailleurs. */
export function planLaunch(playerId: string, url: string, title: string, platform: Platform = detectPlatform()): LaunchPlan {
  if (playerId === 'm3u') return { kind: 'm3u', content: buildM3u(url, title), filename: `${fileBase(title)}.m3u` };
  if (platform === 'shell') {
    if (playerId === 'vlc') return { kind: 'shell', method: 'play-external', params: `vlc://${url}` };
    if (playerId === 'system') return { kind: 'shell', method: 'play-external', params: m3uDataUri(buildM3u(url, title)) };
    return { kind: 'unsupported' };
  }
  if (platform === 'ios') {
    const scheme = SCHEMES.find((s) => s.id === playerId);
    return scheme ? { kind: 'href', href: scheme.build(url, title) } : { kind: 'unsupported' };
  }
  if (platform === 'android-app' && playerId === 'chooser') return { kind: 'plugin', url, title };
  if (platform === 'web-android' && playerId === 'intent') return { kind: 'href', href: intentHref(url, title) };
  return { kind: 'unsupported' };
}

/** Téléchargement d'un fichier texte : lien `<a download>` cliqué, URL révoquée ensuite. */
function downloadText(content: string, filename: string): void {
  const objectUrl = URL.createObjectURL(new Blob([content], { type: 'audio/x-mpegurl' }));
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/** Ouvre l'URL par le sélecteur d'applications Android. False si le plugin est absent. */
function openWithPlugin(url: string, title: string): boolean {
  try {
    const plugin = capacitorWindow()?.Plugins?.ExternalPlayer;
    if (!plugin || typeof plugin.open !== 'function') return false;
    void Promise.resolve(plugin.open({ url, title })).catch(() => undefined);
    return true;
  } catch { return false; }
}

/** Lance le plan. Renvoie vrai si une action a été tentée (navigation, envoi à la coque, téléchargement, plugin). */
export function launch(plan: LaunchPlan): boolean {
  switch (plan.kind) {
    case 'href':
      window.location.href = plan.href;
      return true;
    case 'shell':
      if (!isShellEnvironment()) return false;
      void connectShell().then((t) => { t?.send(plan.method, plan.params); });
      return true;
    case 'm3u':
      downloadText(plan.content, plan.filename);
      return true;
    case 'plugin':
      return openWithPlugin(plan.url, plan.title);
    case 'unsupported':
      return false;
  }
}

const UNPLAYABLE_EXT = /\.(mkv|avi|wmv|flv|ts|m2ts)$/i;

/** Conteneur que le lecteur intégré de iOS ne lit pas (MKV, AVI, WMV, FLV, MPEG-TS) : d'après le nom, ou le chemin de l'URL sans sa query. */
export function looksUnplayableOnIOS(url: string, name: string): boolean {
  const path = url.split(/[?#]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return UNPLAYABLE_EXT.test(path) || UNPLAYABLE_EXT.test(name) || /\bmkv\b/i.test(name);
}
