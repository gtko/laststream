import {
  getAutoplay, getBandwidthSetting, getRegion, getSkipPref, setAutoplay, setBandwidthSetting, setRegion, setSkipPref,
} from './prefs';
import { readTheme, resolveTheme, saveTheme } from './theme';

/** Préférences synchronisées avec les réglages du profil (GET/PUT /user/profiles/:id/settings). */
export type PrefsSnapshot = Record<string, unknown>;

export function snapshotPrefs(): PrefsSnapshot {
  const t = readTheme();
  return {
    theme: { id: t.id, accent: t.accent },
    region: getRegion().code,
    autoplay: getAutoplay(),
    bandwidth: getBandwidthSetting(),
    skipIntro: getSkipPref('intro'),
    skipRecap: getSkipPref('recap'),
    skipNext: getSkipPref('nextEpisode'),
  };
}

/** Applique les réglages du serveur au stockage local. Renvoie vrai si au moins une valeur a été appliquée. */
export function applyPrefs(s: PrefsSnapshot): boolean {
  let any = false;
  if (s.theme && typeof s.theme === 'object') {
    const th = s.theme as { id?: unknown; accent?: unknown };
    saveTheme(resolveTheme(th.id, th.accent));
    any = true;
  }
  if (typeof s.region === 'string') { setRegion(s.region); any = true; }
  if (typeof s.autoplay === 'boolean') { setAutoplay(s.autoplay); any = true; }
  if (s.bandwidth === 'auto' || typeof s.bandwidth === 'number') { setBandwidthSetting(s.bandwidth as 'auto' | number); any = true; }
  if (typeof s.skipIntro === 'boolean') { setSkipPref('intro', s.skipIntro); any = true; }
  if (typeof s.skipRecap === 'boolean') { setSkipPref('recap', s.skipRecap); any = true; }
  if (typeof s.skipNext === 'boolean') { setSkipPref('nextEpisode', s.skipNext); any = true; }
  return any;
}
