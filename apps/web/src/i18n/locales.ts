/*
 * Langues de l'interface (LAST-1658) : l'union des langues d'interface de Stremio (dépôt Stremio/stremio-translations),
 * Jellyfin (sélecteur de jellyfin-web, displaySettings) et Plex (projet Transifex « app.plex.tv »), relevée le 2026-11-27.
 * Le français est la langue source : les textes du code sont en français et servent de clés aux catalogues
 * (src/i18n/locales/<code>.json). Une langue n'est proposée que si son catalogue existe (voir `availableLocales`).
 * `base` : variante régionale qui reprend le catalogue d'une autre langue (fr-CA → fr, en-GB → en) en gardant ses formats
 * de date et de nombre ; elle n'a besoin d'un catalogue que pour ses écarts.
 */

export interface LocaleInfo {
  /** Code BCP 47, aussi nom du catalogue. */
  code: string;
  /** Nom de la langue dans cette langue (affiché dans le sélecteur). */
  name: string;
  /** Écriture de droite à gauche. */
  rtl?: boolean;
  /** Langue dont le catalogue est repris quand celui de la variante manque. */
  base?: string;
}

export const SOURCE_LOCALE = 'fr';

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'be', name: 'Беларуская' },
  { code: 'bg', name: 'Български' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'ca', name: 'Català' },
  { code: 'cs', name: 'Čeština' },
  { code: 'cy', name: 'Cymraeg' },
  { code: 'da', name: 'Dansk' },
  { code: 'de', name: 'Deutsch' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'en', name: 'English' },
  { code: 'en-GB', name: 'English (United Kingdom)', base: 'en' },
  { code: 'eo', name: 'Esperanto' },
  { code: 'es', name: 'Español (España)' },
  { code: 'es-419', name: 'Español (Latinoamérica)', base: 'es' },
  { code: 'et', name: 'Eesti' },
  { code: 'eu', name: 'Euskara' },
  { code: 'fa', name: 'فارسی', rtl: true },
  { code: 'fi', name: 'Suomi' },
  { code: 'fil', name: 'Filipino' },
  { code: 'fr', name: 'Français' },
  { code: 'fr-CA', name: 'Français (Canada)', base: 'fr' },
  { code: 'gl', name: 'Galego' },
  { code: 'gsw', name: 'Schwiizerdütsch', base: 'de' },
  { code: 'he', name: 'עברית', rtl: true },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'hr', name: 'Hrvatski' },
  { code: 'hu', name: 'Magyar' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'is', name: 'Íslenska' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'kk', name: 'Қазақ тілі' },
  { code: 'ko', name: '한국어' },
  { code: 'lt', name: 'Lietuvių' },
  { code: 'lv', name: 'Latviešu' },
  { code: 'mk', name: 'Македонски' },
  { code: 'ml', name: 'മലയാളം' },
  { code: 'mr', name: 'मराठी' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'my', name: 'မြန်မာ' },
  { code: 'nb', name: 'Norsk bokmål' },
  { code: 'ne', name: 'नेपाली' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'nn', name: 'Norsk nynorsk', base: 'nb' },
  { code: 'pa', name: 'ਪੰਜਾਬੀ' },
  { code: 'pl', name: 'Polski' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'pt-PT', name: 'Português (Portugal)', base: 'pt-BR' },
  { code: 'ro', name: 'Română' },
  { code: 'ru', name: 'Русский' },
  { code: 'sk', name: 'Slovenčina' },
  { code: 'sl', name: 'Slovenščina' },
  { code: 'sq', name: 'Shqip' },
  { code: 'sr', name: 'Српски' },
  { code: 'sv', name: 'Svenska' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'th', name: 'ไทย' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'uk', name: 'Українська' },
  { code: 'ur', name: 'اردو', rtl: true },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文（台灣）' },
  { code: 'zh-HK', name: '繁體中文（香港）', base: 'zh-TW' },
];

const BY_CODE = new Map(LOCALES.map((l) => [l.code.toLowerCase(), l]));

/** Code de langue reconnu, sinon null. Insensible à la casse ; « _ » accepté pour « - ». */
export function localeInfo(code: string | null | undefined): LocaleInfo | null {
  if (!code) return null;
  return BY_CODE.get(String(code).replace(/_/g, '-').toLowerCase()) ?? null;
}

/** Repli d'une langue de base vers sa variante proposée (le navigateur dit « pt », « zh », « es-MX »…). */
const BASE_DEFAULT: Record<string, string> = {
  pt: 'pt-BR', zh: 'zh-CN', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW', 'zh-sg': 'zh-CN', 'zh-mo': 'zh-HK',
  no: 'nb', tl: 'fil', iw: 'he', in: 'id',
};
const LATAM = /^es-(?!es$)[a-z0-9]+$/;

/**
 * Langue proposée la plus proche d'une préférence du navigateur (« de-AT » → de, « es-MX » → es-419, « pt » → pt-BR),
 * limitée à `allowed` (codes proposés). Null si aucune.
 */
export function matchLocale(pref: string, allowed: ReadonlySet<string>): string | null {
  const raw = String(pref || '').replace(/_/g, '-').toLowerCase();
  if (!raw) return null;
  const ok = (code: string | undefined): string | null => {
    const info = code ? localeInfo(code) : null;
    return info && allowed.has(info.code) ? info.code : null;
  };
  const parts = raw.split('-');
  const lang = parts[0];
  const script = parts.find((p, i) => i > 0 && p.length === 4);
  return ok(raw)
    ?? (LATAM.test(raw) ? ok('es-419') : null)
    ?? (script ? ok(BASE_DEFAULT[lang + '-' + script]) : null)
    ?? ok(BASE_DEFAULT[raw])
    ?? ok(lang)
    ?? ok(BASE_DEFAULT[lang])
    ?? null;
}
