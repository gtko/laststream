/*
 * Avatars illustrés des profils : DiceBear (MIT) généré localement en SVG, aucune requête réseau. Un profil garde
 * `avatar: "dicebear:<style>:<graine>"` en plus de sa couleur, qui reste le repli (initiale sur fond coloré).
 * Seuls les styles dont la licence de l'illustration autorise l'usage (CC0, CC BY 4.0 avec crédit, libre pour usage
 * personnel et commercial avec crédit) sont proposés : voir LICENSE de chaque paquet @dicebear/<style>.
 */

import { HERO_FAMILIES, HERO_FAMILY_IDS, type HeroFamily } from './heroes/render';

export type { HeroFamily } from './heroes/render';
export { HERO_FAMILIES } from './heroes/render';

export type AvatarFamily = 'personnages' | 'illustres' | 'robots' | 'fun';
export type AvatarLicense = 'cc0' | 'cc-by' | 'libre';
export type AvatarTab = 'heroes' | 'enfants' | AvatarFamily;

export interface AvatarStyle {
  /** Nom du paquet @dicebear/<id> (minuscules et tirets). */
  id: string;
  label: string;
  family: AvatarFamily;
  /** Convient particulièrement aux enfants (onglet « Enfants »). */
  kid: boolean;
  license: AvatarLicense;
  /** Illustrateur (crédit). */
  creator: string;
  /** Page source de l'illustration. */
  source: string;
}

const CC0 = 'cc0';
const BY = 'cc-by';
const FREE = 'libre';
const LISA = 'Lisa Wischofsky';
const STANLEY = 'Pablo Stanley';
const DICEBEAR = 'DiceBear';
const FIGMA = 'https://www.figma.com/community/file/';

const s = (id: string, label: string, family: AvatarFamily, license: AvatarLicense, creator: string, source: string, kid = false): AvatarStyle =>
  ({ id, label, family, kid, license, creator, source });

export const AVATAR_STYLES: readonly AvatarStyle[] = [
  // Personnages
  s('lorelei', 'Lorelei', 'personnages', CC0, LISA, FIGMA + '1198749693280469639'),
  s('notionists', 'Notionists', 'personnages', CC0, 'Zoish', 'https://heyzoish.gumroad.com/l/notionists'),
  s('notionists-neutral', 'Notionists (visages)', 'personnages', CC0, 'Zoish', 'https://heyzoish.gumroad.com/l/notionists'),
  s('open-peeps', 'Open Peeps', 'personnages', CC0, STANLEY, 'https://www.openpeeps.com/'),
  s('personas', 'Personas', 'personnages', BY, 'Draftbit', 'https://personas.draftbit.com/'),
  s('micah', 'Micah', 'personnages', BY, 'Micah Lanier', FIGMA + '829741575478342595'),
  s('avataaars', 'Avataaars', 'personnages', FREE, STANLEY, 'https://avataaars.com/'),
  s('avataaars-neutral', 'Avataaars (visages)', 'personnages', FREE, STANLEY, 'https://avataaars.com/'),
  s('adventurer', 'Aventurier', 'personnages', BY, LISA, FIGMA + '1184595184137881796'),
  s('big-ears', 'Grandes oreilles', 'personnages', BY, 'The Visual Team', FIGMA + '986078800058673824'),
  s('dylan', 'Dylan', 'personnages', BY, 'Natalia Spivak', FIGMA + '1356575240759683500'),
  // Illustrés
  s('lorelei-neutral', 'Lorelei (visages)', 'illustres', CC0, LISA, FIGMA + '1198749693280469639'),
  s('adventurer-neutral', 'Aventurier (visages)', 'illustres', BY, LISA, FIGMA + '1184595184137881796'),
  s('big-ears-neutral', 'Grandes oreilles (visages)', 'illustres', BY, 'The Visual Team', FIGMA + '986078800058673824'),
  s('big-smile', 'Grand sourire', 'illustres', BY, 'Ashley Seo', FIGMA + '881358461963645496', true),
  s('croodles', 'Croodles', 'illustres', BY, 'Vijay Verma', FIGMA + '966199982810283152', true),
  s('croodles-neutral', 'Croodles (visages)', 'illustres', BY, 'Vijay Verma', FIGMA + '966199982810283152', true),
  s('toon-head', 'Toon', 'illustres', BY, 'Johan Melin', FIGMA + '1589627891082866389', true),
  s('miniavs', 'Miniavs', 'illustres', BY, 'Webpixels', FIGMA + '923211396597067458', true),
  // Robots
  s('bottts', 'Robots', 'robots', FREE, STANLEY, 'https://bottts.com/', true),
  s('bottts-neutral', 'Robots (visages)', 'robots', FREE, STANLEY, 'https://bottts.com/', true),
  s('pixel-art', 'Pixel art', 'robots', CC0, DICEBEAR, FIGMA + '1198754108850888330', true),
  s('pixel-art-neutral', 'Pixel art (visages)', 'robots', CC0, DICEBEAR, FIGMA + '1198754108850888330'),
  // Fun
  s('fun-emoji', 'Fun emoji', 'fun', BY, 'Davis Uche', FIGMA + '968125295144990435', true),
  s('thumbs', 'Pouces', 'fun', CC0, DICEBEAR, 'https://www.dicebear.com', true),
  s('shapes', 'Formes', 'fun', CC0, DICEBEAR, 'https://www.dicebear.com', true),
  s('glass', 'Verre', 'fun', CC0, DICEBEAR, 'https://www.dicebear.com'),
  s('rings', 'Anneaux', 'fun', CC0, DICEBEAR, 'https://www.dicebear.com'),
  s('identicon', 'Identicon', 'fun', CC0, DICEBEAR, 'https://www.dicebear.com'),
];

/** Licences d'illustration acceptées. Tout style dont la licence n'y figure pas n'est jamais proposé. */
export const ALLOWED_LICENSES: readonly AvatarLicense[] = ['cc0', 'cc-by', 'libre'];
export const LICENSE_LABEL: Record<AvatarLicense, string> = {
  cc0: 'CC0 1.0 (domaine public)',
  'cc-by': 'CC BY 4.0',
  libre: 'Libre pour un usage personnel et commercial',
};
export const LICENSE_URL: Record<AvatarLicense, string> = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  'cc-by': 'https://creativecommons.org/licenses/by/4.0/',
  libre: 'https://www.dicebear.com/licenses/',
};

/** Styles réellement utilisables : licence autorisée. */
export const usableStyles = (): AvatarStyle[] => AVATAR_STYLES.filter((st) => ALLOWED_LICENSES.includes(st.license));

export const AVATAR_TABS: ReadonlyArray<{ id: AvatarTab; label: string }> = [
  { id: 'heroes', label: 'Héros' },
  { id: 'enfants', label: 'Enfants' },
  { id: 'personnages', label: 'Personnages' },
  { id: 'illustres', label: 'Illustrés' },
  { id: 'robots', label: 'Robots' },
  { id: 'fun', label: 'Fun' },
];

/** Graines fixes : mêmes avatars à chaque ouverture (déterministe). */
export const DEFAULT_SEEDS: readonly string[] = [
  'Mimi', 'Tigrou', 'Luna', 'Oscar', 'Zoe', 'Maya', 'Leo', 'Nina',
  'Pixel', 'Coco', 'Jade', 'Milo', 'Sacha', 'Lola', 'Noa', 'Felix',
];

/** Couleurs de fond (palette de l'app : corail, violet, turquoise, jaune, bleu, rose, vert, ardoise), sans le #. */
export const AVATAR_BACKGROUNDS: readonly string[] = ['ff5a36', '7b5bf5', '19c3a6', 'f5b700', '3b82f6', 'ec4899', '22c55e', '94a3b8'];

/** Même format que le serveur (user/avatar.ts) : dicebear:<style>:<graine> (les Héros ont HERO_PATTERN). */
export const AVATAR_PATTERN = /^dicebear:[a-z][a-z0-9-]{1,23}:[A-Za-z0-9_-]{1,40}$/;
export const SEED_MAX = 40;

/** Avatars « Héros » (générateur maison laststream-heroes) : hero:<famille>:<graine>, famille = heros | vilains | scifi | fantasy. */
export const HERO_PATTERN = /^hero:(heros|vilains|scifi|fantasy):[A-Za-z0-9_-]{1,40}$/;
export const formatHero = (family: HeroFamily, seed: string): string => `hero:${family}:${seed}`;

export interface ParsedHero { family: HeroFamily; seed: string }

/** Lit un avatar « Héros » stocké ; null si le format est invalide ou la famille inconnue. */
export function parseHero(value: unknown): ParsedHero | null {
  if (typeof value !== 'string' || !HERO_PATTERN.test(value)) return null;
  const [, family, seed] = value.split(':') as [string, HeroFamily, string];
  return HERO_FAMILY_IDS.includes(family) ? { family, seed } : null;
}

/** Vrai pour tout avatar stocké reconnu : DiceBear autorisé ou Héros. */
export const isValidAvatar = (value: unknown): boolean => parseAvatar(value) !== null || parseHero(value) !== null;

/** Graines fixes des Héros : 48 noms originaux, puis deux séries de variantes (« Plus »). Déterministe. */
const HERO_NAMES: readonly string[] = [
  'Aegis', 'Blaze', 'Cyra', 'Dax', 'Ember', 'Flux', 'Gale', 'Halo', 'Ion', 'Jinx', 'Kaze', 'Lyra',
  'Mako', 'Nova', 'Onyx', 'Pyra', 'Quill', 'Rune', 'Sable', 'Titan', 'Umbra', 'Vega', 'Wren', 'Xeno',
  'Yara', 'Zephyr', 'Apex', 'Bolt', 'Cinder', 'Drift', 'Echo', 'Fable', 'Glint', 'Havoc', 'Iris', 'Jolt',
  'Kilo', 'Lumen', 'Mirage', 'Nimbus', 'Orbit', 'Pulse', 'Quasar', 'Riot', 'Spark', 'Talon', 'Vortex', 'Warden',
];
export const HERO_SEEDS: readonly string[] = [...HERO_NAMES, ...HERO_NAMES.map((n) => n + '-2'), ...HERO_NAMES.map((n) => n + '-3')];

export const formatAvatar = (style: string, seed: string): string => `dicebear:${style}:${seed}`;

/** Graine saisie par l'utilisateur, ramenée aux caractères acceptés (sans accents ni espaces), ou ''. */
export function cleanSeed(raw: string): string {
  return raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, SEED_MAX);
}

export function randomSeed(rng: () => number = Math.random): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += chars[Math.floor(rng() * chars.length)];
  return out;
}

export interface ParsedAvatar { style: AvatarStyle; seed: string }

/** Lit un avatar stocké ; null si le format est invalide, le style inconnu ou sa licence non autorisée. */
export function parseAvatar(value: unknown): ParsedAvatar | null {
  if (typeof value !== 'string' || !AVATAR_PATTERN.test(value)) return null;
  const [, id, seed] = value.split(':');
  const style = usableStyles().find((st) => st.id === id);
  return style ? { style, seed } : null;
}

export function stylesForTab(tab: AvatarTab): AvatarStyle[] {
  const all = usableStyles();
  return tab === 'enfants' ? all.filter((st) => st.kid) : all.filter((st) => st.family === tab);
}

export interface AvatarTile { style: { id: string; label: string }; seed: string; value: string }

/**
 * Avatars d'un onglet : si `word` (recherche ou « Au hasard ») est donné, cette graine est montrée dans chaque style de
 * l'onglet en premier, puis les graines fixes. Déterministe.
 */
export function tabTiles(tab: AvatarTab, word = '', sub: HeroFamily = 'heros'): AvatarTile[] {
  const seed = cleanSeed(word);
  if (tab === 'heroes') {
    const label = HERO_FAMILIES.find((f) => f.id === sub)?.label ?? sub;
    const seeds = seed ? [seed, ...HERO_SEEDS.filter((d) => d !== seed)] : [...HERO_SEEDS];
    return seeds.map((sd) => ({ style: { id: sub, label }, seed: sd, value: formatHero(sub, sd) }));
  }
  const styles = stylesForTab(tab);
  const seeds = seed ? [seed, ...DEFAULT_SEEDS.filter((d) => d !== seed)] : [...DEFAULT_SEEDS];
  const tiles: AvatarTile[] = [];
  for (const sd of seeds) for (const st of styles) tiles.push({ style: st, seed: sd, value: formatAvatar(st.id, sd) });
  return tiles;
}

/** Nombre d'avatars proposés au total (tous onglets confondus, sans doublon). */
export const avatarCount = (): number => usableStyles().length * DEFAULT_SEEDS.length + HERO_FAMILY_IDS.length * HERO_SEEDS.length;

/** Crédits à afficher : un par illustrateur et licence, avec les styles concernés (CC BY et licences à attribution). */
export interface AvatarCredit { creator: string; license: AvatarLicense; styles: string[]; sources: string[] }
export function avatarCredits(): AvatarCredit[] {
  const map = new Map<string, AvatarCredit>();
  for (const st of usableStyles()) {
    const key = st.creator + '|' + st.license;
    const cur = map.get(key) ?? { creator: st.creator, license: st.license, styles: [], sources: [] };
    cur.styles.push(st.label);
    if (!cur.sources.includes(st.source)) cur.sources.push(st.source);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.creator.localeCompare(b.creator, 'fr'));
}
