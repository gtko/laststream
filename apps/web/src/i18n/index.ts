/*
 * Traduction de l'interface (LAST-1658).
 *
 * Le français est la langue source : chaque texte affiché passe par `t('Texte en français')`, et ce texte sert de clé
 * aux catalogues `src/i18n/locales/<code>.json` ({ "Texte en français": "Translated text" }). Sans catalogue (français,
 * tests), `t` rend le texte source. Une clé absente du catalogue retombe sur la langue de base (en-GB → en), puis sur
 * le français.
 *
 *   t('Bonjour {name}', { name })           remplace {name} par String(name), jamais échappé ici
 *   tn(n, 'un titre', '{n} titres')         pluriel selon les règles de la langue (Intl.PluralRules) ; {n} = n formaté
 *   tc('bouton', 'Lire')                    même texte français, sens différent : clé « bouton\u0004Lire »
 *
 * Un pluriel est rangé dans le catalogue sous la clé `one\u0005other` (les deux formes françaises) avec pour valeur
 * un objet { one, few, many, other… } (catégories CLDR de la langue cible).
 *
 * Le catalogue est chargé une fois, avant l'interface (src/boot.ts → initI18n puis import de main.js) : `t` reste donc
 * synchrone et peut servir dans les constantes de module.
 */
import { LOCALES, SOURCE_LOCALE, localeInfo, matchLocale, type LocaleInfo } from './locales';

export { LOCALES, SOURCE_LOCALE, localeInfo };
export type { LocaleInfo };

export type Params = Record<string, string | number | null | undefined>;
type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
type Catalog = Record<string, string | PluralForms>;

/** Choix de langue de l'appareil : code BCP 47, ou absent = automatique (langue du navigateur). */
export const UI_LANG_KEY = 'laststream.uilang';
export const CTX_SEP = '\u0004';
export const PLURAL_SEP = '\u0005';

/** Catalogues présents dans le build, chargés à la demande (un fichier JS par langue). */
const LOADERS = import.meta.glob<{ default: Catalog }>('./locales/*.json');
const loaderFor = (code: string) => LOADERS['./locales/' + code + '.json'];

let current = SOURCE_LOCALE;
let catalogs: Catalog[] = [];
let plural: Intl.PluralRules | null = null;

/** Langues proposées : le français et celles dont le catalogue (ou celui de leur langue de base) existe. */
export function availableLocales(): LocaleInfo[] {
  return LOCALES.filter((l) => l.code === SOURCE_LOCALE || (l.base === SOURCE_LOCALE) || loaderFor(l.code) || (l.base && loaderFor(l.base)));
}

/** Langue de l'interface en cours (code BCP 47). */
export const getLocale = (): string => current;

/** Code pour Intl (dates, nombres, noms de langues) : la langue de l'interface. */
export const intlLocale = (): string => current;

/** Écriture de droite à gauche pour la langue en cours. */
export const isRtl = (): boolean => !!localeInfo(current)?.rtl;

/** Choix enregistré sur l'appareil ('' = automatique). */
export function getLocaleSetting(): string {
  try { return localStorage.getItem(UI_LANG_KEY) || ''; } catch { return ''; }
}

/** Enregistre le choix ('' = automatique). Prend effet au prochain chargement de l'interface. */
export function setLocaleSetting(code: string): void {
  try {
    if (code && localeInfo(code)) localStorage.setItem(UI_LANG_KEY, localeInfo(code)!.code);
    else localStorage.removeItem(UI_LANG_KEY);
  } catch { /* stockage indisponible */ }
}

/** Langue à utiliser : le choix de l'appareil s'il est proposé, sinon la première langue du navigateur qui l'est, sinon l'anglais. */
export function resolveLocale(setting: string, prefs: readonly string[]): string {
  const allowed = new Set(availableLocales().map((l) => l.code));
  const chosen = matchLocale(setting, allowed);
  if (chosen) return chosen;
  for (const p of prefs) {
    const m = matchLocale(p, allowed);
    if (m) return m;
  }
  return allowed.has('en') ? 'en' : SOURCE_LOCALE;
}

const browserPrefs = (): string[] => {
  if (typeof navigator === 'undefined') return [];
  const list = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
  return list.filter(Boolean) as string[];
};

/** `?lang=xx` dans l'URL : langue imposée pour ce chargement seulement (captures, vérifications), sans l'enregistrer. */
const urlLocale = (): string => {
  try { return new URLSearchParams(location.search).get('lang') || ''; } catch { return ''; }
};

/** Installe une langue avec ses catalogues (tests, ou après chargement). */
export function useLocale(code: string, list: Catalog[] = []): void {
  current = localeInfo(code)?.code ?? SOURCE_LOCALE;
  catalogs = list;
  try { plural = new Intl.PluralRules(current); } catch { plural = null; }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = current;
    document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
  }
}

/** Charge la langue de l'appareil et ses catalogues. À attendre avant le premier rendu (src/boot.ts). */
export async function initI18n(): Promise<string> {
  const code = resolveLocale(urlLocale() || getLocaleSetting(), browserPrefs());
  const chain: string[] = [];
  for (let c: string | undefined = code; c && c !== SOURCE_LOCALE; c = localeInfo(c)?.base) chain.push(c);
  const list = await Promise.all(chain.map(async (c) => {
    const load = loaderFor(c);
    if (!load) return null;
    try { return (await load()).default; } catch { return null; }
  }));
  useLocale(code, list.filter((x): x is Catalog => !!x));
  return current;
}

function lookup(key: string): string | PluralForms | undefined {
  for (const cat of catalogs) {
    const v = cat[key];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

const fill = (text: string, params?: Params | null): string => {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
};

/**
 * Marque un texte à traduire sans le traduire : il reste l'identifiant français (onglet, catégorie) et sera passé à t()
 * à l'affichage. Sert seulement à l'extraction des clés (scripts/i18n.mjs).
 */
export const N_ = <T extends string>(src: T): T => src;

/** Texte traduit. `src` : le texte français (clé). */
export function t(src: string, params?: Params | null): string {
  const v = catalogs.length ? lookup(src) : undefined;
  return fill(typeof v === 'string' ? v : src, params);
}

/** Texte traduit avec un contexte, pour un même texte français de sens différent. */
export function tc(ctx: string, src: string, params?: Params | null): string {
  const v = catalogs.length ? lookup(ctx + CTX_SEP + src) : undefined;
  return fill(typeof v === 'string' ? v : src, params);
}

/** Nombre formaté dans la langue de l'interface. */
export function fmtNum(n: number, opts?: Intl.NumberFormatOptions): string {
  try { return n.toLocaleString(current, opts); } catch { return String(n); }
}

/**
 * Pluriel : `one` (français : 0 et 1) ou `other`, traduits selon les catégories de la langue. {n} vaut le nombre formaté,
 * les autres paramètres s'ajoutent.
 */
export function tn(n: number, one: string, other: string, params?: Params | null): string {
  const all = { n: fmtNum(n), ...(params || {}) };
  const v = catalogs.length ? lookup(one + PLURAL_SEP + other) : undefined;
  if (v && typeof v === 'object') {
    const cat = plural ? plural.select(n) : 'other';
    const form = v[cat] ?? v.other;
    if (form) return fill(form, all);
  }
  return fill(Math.abs(n) < 2 ? one : other, all);
}

/** Nom d'une langue, d'une région… dans la langue de l'interface (Intl.DisplayNames), sinon le code. */
export function displayName(type: Intl.DisplayNamesType, code: string): string {
  try { return new Intl.DisplayNames([current], { type }).of(code) || code; } catch { return code; }
}
