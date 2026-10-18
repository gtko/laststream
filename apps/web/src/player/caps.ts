import { detectCaps } from './engine';
import { isNativePlayer } from './native';
import { isShellEnvironment } from './shell';
import type { MediaCaps } from './server';

/* Capacités réelles du navigateur (MediaSource.isTypeSupported, canPlayType), calculées une fois. */

let cached: MediaCaps | null = null;

export function browserCaps(): MediaCaps {
  if (cached) return cached;
  const v = document.createElement('video');
  const ms = (globalThis as { MediaSource?: { isTypeSupported?: (m: string) => boolean } }).MediaSource;
  const chromium = !!(globalThis as { chrome?: unknown }).chrome;
  let channels = 2;
  if (/firefox/i.test(navigator.userAgent)) channels = 6;
  else if (!chromium) {
    try { channels = new AudioContext().destination.maxChannelCount || 2; } catch { channels = 2; }
  }
  const support = (mime: string): string => (ms?.isTypeSupported?.(mime) ? 'probably' : v.canPlayType(mime));
  cached = detectCaps(support, { chromium, maxChannels: channels });
  return cached;
}

/** Coque Windows (mpv) ou application Android (libVLC) : le lecteur lit tout, aucune règle de lecture directe. */
export const inShell = (): boolean => isShellEnvironment() || isNativePlayer();

export function resetCapsCache(): void { cached = null; }
