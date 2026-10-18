import { trackLang, audioTrackLabel, codecLabel, langName, type AudioTrack, type SubtitleTrack } from './tracks';
import { setShellServerAddress } from './server';

/* Coque Windows (Qt + mpv) : détection du transport et conversion des données mpv.
 * Protocole des messages (mpv-command, mpv-set-prop, mpv-observe-prop, mpv-prop-change) repris de stremio-video / ShellVideo. */

export interface ShellTransport {
  send(event: string, args?: unknown): void;
  on(event: string, fn: (args: unknown) => void): void;
}

interface QtWindow {
  qt?: { webChannelTransport?: unknown };
  QWebChannel?: new (transport: unknown, cb: (channel: { objects: Record<string, unknown> }) => void) => unknown;
}

export function isShellEnvironment(win: QtWindow = window as unknown as QtWindow): boolean {
  return typeof win.qt !== 'undefined' && !!win.qt?.webChannelTransport;
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

let connecting: Promise<ShellTransport | null> | null = null;

/** Se connecte au canal Qt de la coque ; null hors coque ou si la connexion échoue (repli : lecture dans le navigateur). */
export function connectShell(): Promise<ShellTransport | null> {
  if (!isShellEnvironment()) return Promise.resolve(null);
  if (connecting) return connecting;
  const win = window as unknown as QtWindow;
  connecting = (async () => {
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
      const listeners = new Map<string, Array<(a: unknown) => void>>();
      t.event.connect((ev, args) => {
        let a = args;
        if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* texte simple */ } }
        (listeners.get(ev) ?? []).forEach((fn) => fn(a));
      });
      if (typeof t.serverAddress === 'string') setShellServerAddress(t.serverAddress);
      const transport: ShellTransport = {
        send: (event, args) => t.onEvent(event, args),
        on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
      };
      transport.on('server-address', (a) => { if (typeof a === 'string') setShellServerAddress(a); });
      return transport;
    } catch {
      return null;
    }
  })();
  return connecting;
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
