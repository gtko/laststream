import { trackLang, audioTrackLabel, codecLabel, langName, type AudioTrack, type SubtitleTrack } from './tracks';
import { setShellServerAddress } from './server';

/* Coque Windows : détection du transport et conversion des données mpv.
 *
 * Deux coques :
 *  - laststream-shell-ng (Rust, WebView2) : `window.chrome.webview` (postMessage / événement `message`). Aucun QWebChannel :
 *    comme stremio-web, on parle directement le protocole JSON de la coque. Messages envoyés : `{ id: 0, type: 6, args: [événement, ...] }`
 *    et `{ id: 0, type: 3 }` pour la poignée de main ; reçus : `{ type: 3, data: { transport: { properties } } }` (propriétés de la coque)
 *    et `{ type: 1, args: [événement, charge] }` (signaux : mpv-prop-change, mpv-event-ended, win-visibility-changed…).
 *  - laststream-shell (Qt, QtWebEngine) : `window.qt.webChannelTransport` + QWebChannel (script `qrc:///qtwebchannel/qwebchannel.js`,
 *    fourni par Qt dans cette coque, donc rien à embarquer).
 * Événements mpv (mpv-command, mpv-set-prop, mpv-observe-prop, mpv-prop-change) : repris de stremio-video / ShellVideo. */

export interface ShellTransport {
  kind: 'webview2' | 'qt';
  send(event: string, args?: unknown): void;
  on(event: string, fn: (args: unknown) => void): void;
  /** Propriétés annoncées par la coque (version, adresse du serveur de streaming, sous-titres ASS natifs…). */
  info: Record<string, string>;
}

export const MSG_SIGNAL = 1;
export const MSG_INIT = 3;
export const MSG_INVOKE = 6;

export interface WebviewLike {
  postMessage(message: string): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

export interface ShellWindow {
  chrome?: { webview?: WebviewLike };
  qt?: { webChannelTransport?: { onmessage?: (ev: unknown) => void } };
  QWebChannel?: new (transport: unknown, cb: (channel: { objects: Record<string, unknown> }) => void) => unknown;
}

const asShellWindow = (): ShellWindow => window as unknown as ShellWindow;

/** WebView2 (laststream-shell-ng) ou Qt WebChannel (laststream-shell). */
export function isShellEnvironment(win: ShellWindow = asShellWindow()): boolean {
  return typeof win.chrome?.webview?.postMessage === 'function' || (typeof win.qt !== 'undefined' && !!win.qt?.webChannelTransport);
}

/** Message d'appel d'une méthode de la coque : `["mpv-command", ["stop"]]` → `{ id: 0, type: 6, args: [...] }`. */
export function encodeInvoke(event: string, args?: unknown): string {
  return JSON.stringify({ id: 0, type: MSG_INVOKE, args: args === undefined ? [event] : [event, args] });
}

export type ShellMessage =
  | { kind: 'init'; info: Record<string, string> }
  | { kind: 'signal'; event: string; payload: unknown }
  | null;

/** Lit un message de la coque (chaîne JSON ou objet) ; null s'il n'est pas reconnu. */
export function decodeMessage(data: unknown): ShellMessage {
  let m: unknown = data;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return null; } }
  const r = m as { type?: number; data?: { transport?: { properties?: unknown } }; args?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  if (r.type === MSG_INIT) {
    const props = r.data?.transport?.properties;
    const info: Record<string, string> = {};
    if (Array.isArray(props)) {
      for (const p of props) if (Array.isArray(p) && p.length >= 4 && typeof p[1] === 'string' && p[1]) info[p[1]] = String(p[3]);
    }
    return { kind: 'init', info };
  }
  if (r.type === MSG_SIGNAL && Array.isArray(r.args) && typeof r.args[0] === 'string') return { kind: 'signal', event: r.args[0], payload: r.args[1] };
  return null;
}

function emitter() {
  const listeners = new Map<string, Array<(a: unknown) => void>>();
  return {
    on: (event: string, fn: (a: unknown) => void): void => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
    emit: (event: string, payload: unknown): void => { (listeners.get(event) ?? []).forEach((fn) => { try { fn(payload); } catch { /* un écouteur ne casse pas les autres */ } }); },
  };
}

/** Transport WebView2 : poignée de main puis signaux. Résout null si la coque ne répond pas dans le délai. */
export function createWebviewTransport(win: ShellWindow, timeoutMs = 2500): Promise<ShellTransport | null> {
  const wv = win.chrome?.webview;
  if (!wv) return Promise.resolve(null);
  // La coque injecte un relais `qt.webChannelTransport.onmessage` appelé à chaque message : il doit exister.
  if (win.qt?.webChannelTransport && typeof win.qt.webChannelTransport.onmessage !== 'function') win.qt.webChannelTransport.onmessage = () => undefined;
  const bus = emitter();
  return new Promise((resolve) => {
    let done = false;
    const transport: ShellTransport = {
      kind: 'webview2',
      info: {},
      send: (event, args) => { try { wv.postMessage(encodeInvoke(event, args)); } catch { /* coque fermée */ } },
      on: bus.on,
    };
    const finish = (ok: boolean): void => { if (!done) { done = true; clearTimeout(timer); resolve(ok ? transport : null); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    wv.addEventListener('message', (ev) => {
      const m = decodeMessage(ev.data);
      if (!m) return;
      if (m.kind === 'init') {
        transport.info = m.info;
        if (m.info.streamingServerUrl) setShellServerAddress(m.info.streamingServerUrl);
        finish(true);
      } else {
        bus.emit(m.event, m.payload);
      }
    });
    try { wv.postMessage(JSON.stringify({ id: 0, type: MSG_INIT })); } catch { finish(false); }
  });
}

function loadScript(src: string, timeoutMs = 2500): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    s.src = src;
    s.onload = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('script')); };
    document.head.appendChild(s);
  });
}

async function createQtTransport(win: ShellWindow): Promise<ShellTransport | null> {
  try {
    if (!win.QWebChannel) await loadScript('qrc:///qtwebchannel/qwebchannel.js');
    const Channel = win.QWebChannel;
    if (!Channel) return null;
    const t = await new Promise<{ onEvent: (ev: string, args: unknown) => void; event: { connect: (fn: (ev: string, args: unknown) => void) => void }; serverAddress?: string } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);
      new Channel(win.qt?.webChannelTransport, (ch) => {
        clearTimeout(timer);
        resolve((ch.objects.transport as never) ?? null);
      });
    });
    if (!t) return null;
    const bus = emitter();
    t.event.connect((ev, args) => {
      let a = args;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* texte simple */ } }
      bus.emit(ev, a);
    });
    if (typeof t.serverAddress === 'string') setShellServerAddress(t.serverAddress);
    const transport: ShellTransport = { kind: 'qt', info: {}, send: (event, args) => t.onEvent(event, args), on: bus.on };
    transport.on('server-address', (a) => { if (typeof a === 'string') setShellServerAddress(a); });
    return transport;
  } catch {
    return null;
  }
}

let connecting: Promise<ShellTransport | null> | null = null;
let announced = false;

/** Se connecte à la coque ; null hors coque ou si la connexion échoue (repli : lecture dans le navigateur). */
export function connectShell(win: ShellWindow = asShellWindow()): Promise<ShellTransport | null> {
  if (!isShellEnvironment(win)) return Promise.resolve(null);
  if (connecting) return connecting;
  connecting = win.chrome?.webview ? createWebviewTransport(win) : createQtTransport(win);
  return connecting;
}

export function resetShell(): void {
  connecting = null;
  announced = false;
}

// ---------- Événements envoyés à la coque ----------

/** La page est affichée : la coque peut retirer son écran de démarrage (`app-ready`). Une seule fois. */
export function announceShellReady(win: ShellWindow = asShellWindow()): Promise<boolean> {
  if (announced) return Promise.resolve(false);
  announced = true;
  return connectShell(win).then((t) => { if (t) t.send('app-ready'); return !!t; });
}

/** Erreur fatale au démarrage : la coque masque son écran de démarrage et la journalise. */
export function reportShellError(message: string, win: ShellWindow = asShellWindow()): void {
  void connectShell(win).then((t) => { if (t) t.send('app-error', message); });
}

/** Plein écran de la fenêtre (la coque agit sur la fenêtre, pas sur un élément de la page). */
export function setShellFullscreen(t: ShellTransport, fullscreen: boolean): void {
  t.send('win-set-visibility', { fullscreen });
}

/** Image dans l'image de la coque : petite fenêtre sans bordure, toujours au premier plan (la coque répond `win-pip-changed`). */
export function setShellPip(t: ShellTransport, pip: boolean): void {
  t.send('win-set-pip', { pip });
}

/** Début d'un déplacement de la fenêtre (image dans l'image, sans barre de titre). */
export function startShellDrag(t: ShellTransport): void {
  t.send('win-drag');
}

/** Ce que fait « Retour » / Échap dans le lecteur : ferme le panneau, quitte le plein écran (coque ou page), sinon ferme le lecteur. */
export function backStep(ctx: { panelOpen: boolean; shellFullscreen: boolean; docFullscreen: boolean; shellPip?: boolean }): 'panel' | 'shell-pip' | 'shell-fullscreen' | 'doc-fullscreen' | 'close' {
  if (ctx.panelOpen) return 'panel';
  if (ctx.shellPip) return 'shell-pip';
  if (ctx.shellFullscreen) return 'shell-fullscreen';
  if (ctx.docFullscreen) return 'doc-fullscreen';
  return 'close';
}

/** Ouvre une adresse web dans le navigateur du système (http, https, ftp… filtrés par la coque). */
export function openExternal(t: ShellTransport, url: string): void {
  t.send('open-external', url);
}

// ---------- Conversion des pistes mpv ----------

export interface MpvTrack {
  id: number;
  type: string;
  lang?: string;
  title?: string;
  codec?: string;
  'audio-channels'?: number;
  selected?: boolean;
  external?: boolean;
  forced?: boolean;
}

const IMAGE = new Set(['pgs', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'dvdsub']);

export function mpvAudioTracks(list: readonly MpvTrack[]): AudioTrack[] {
  return list.filter((t) => t.type === 'audio').map((t) => {
    const lang = trackLang(t.lang, t.title);
    return { id: String(t.id), title: t.title || '', lang, codec: (t.codec ?? '').toLowerCase(), channels: t['audio-channels'] ?? 0, selected: !!t.selected, label: audioTrackLabel({ lang, title: t.title, codec: t.codec, channels: t['audio-channels'] }) };
  });
}

export function mpvSubtitleTracks(list: readonly MpvTrack[]): SubtitleTrack[] {
  return list.filter((t) => t.type === 'sub').map((t): SubtitleTrack => {
    const lang = trackLang(t.lang, t.title);
    const codec = (t.codec ?? '').toLowerCase();
    return {
      id: String(t.id), title: t.title || '', lang, codec, forced: !!t.forced, origin: 'embedded', renderable: true, engineId: t.id, selected: !!t.selected,
      label: (lang ? langName(lang) : t.title || 'Sous-titres') + (t.forced ? ' (forcés)' : '') + (codec ? ' · ' + codecLabel(codec) : '') + (IMAGE.has(codec) ? '' : ''),
    };
  });
}

/** Version mpv « 0.39.0 » ≥ « 0.39 » : la syntaxe de `loadfile` change à partir de 0.39. */
export function mpvVersionAtLeast(version: string, min: string): boolean {
  const p = (v: string): number[] => v.replace(/^mpv\s*/i, '').split('.').slice(0, 2).map((x) => parseInt(x, 10) || 0);
  const [a0, a1] = p(version);
  const [b0, b1] = p(min);
  return a0 > b0 || (a0 === b0 && a1 >= b1);
}

/** Arguments de `loadfile` : démarrage à `startAt` secondes. */
export function loadfileArgs(url: string, startAt: number, newSyntax: boolean): string[] {
  if (!(startAt > 0)) return [url];
  return newSyntax ? [url, 'replace', '-1', 'start=+' + startAt] : [url, 'replace', 'start=+' + startAt];
}
