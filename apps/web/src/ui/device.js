/* Type d'appareil (ODY-234) : aucune détection TV n'existait côté web. Une TV Android est reconnue à l'app native et à un
 * agent utilisateur de téléviseur ou à l'absence de pointeur ; une TV ou un projecteur LG (webOS, LAST-1643) à son agent
 * utilisateur seul (la Magic Remote est un pointeur) ; localStorage['laststream.ui.tv']==='1' force le mode TV (rendu bureau,
 * tests). Le mode s'applique via <html data-device="tv">, sur lequel s'appuient les styles dédiés. */
import { isAndroidApp } from '../data/config';

const TV_FORCE_KEY = 'laststream.ui.tv';
const TV_UA = /Android TV|GoogleTV|AFT|BRAVIA|SMART-TV/i;
/** webOS de LG : « Web0S » (avec un zéro) dans l'agent utilisateur des TV et projecteurs, « webOS » sur les plus anciens. */
const WEBOS_UA = /Web0S|webOS/;

function forced() {
  try { return localStorage.getItem(TV_FORCE_KEY) === '1'; } catch (_) { return false; }
}

/** TV ou projecteur LG (webOS) : app Laststream (apps/webos) ou navigateur de la TV. */
export function isWebOs() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (WEBOS_UA.test(ua)) return true;
  try { return typeof window !== 'undefined' && !!(/** @type {any} */ (window).PalmSystem); } catch (_) { return false; }
}

export function isTvDevice() {
  if (forced()) return true;
  if (isWebOs()) return true;
  if (!isAndroidApp()) return false;
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (TV_UA.test(ua)) return true;
  try { return !!(typeof matchMedia === 'function' && matchMedia('(pointer: none)').matches); } catch (_) { return false; }
}

export function applyDeviceMode() {
  const root = document.documentElement;
  if (isTvDevice()) root.dataset.device = 'tv'; else delete root.dataset.device;
}
