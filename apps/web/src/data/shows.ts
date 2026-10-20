/* Émissions TV : rapprochement des titres du guide TV (EPG) avec des émissions TMDB, prochaines diffusions, soirée.
 * Logique pure, testée ; les appels réseau sont dans showsApi.ts. */

import { pad2 } from './format';

export interface EpgProgram {
  channelId: string;
  start: number;
  stop: number;
  title: string;
  desc?: string;
  icon?: string;
  category?: string;
}

/** Chaîne du guide : `epgId` est l'identifiant demandé à /lt/tv/epg ; `playId` celui de la chaîne du catalogue (lecture). */
export interface GuideChannel {
  epgId: string;
  playId: string | null;
  name: string;
  logo: string;
  num: number | null;
}

export interface Airing {
  channel: GuideChannel;
  start: number;
  stop: number;
  /** Titre tel qu'au guide. */
  title: string;
  desc: string;
  icon: string;
  /** Genre au guide (« Divertissement », « Film »…) ; chaîne vide si absent. */
  category: string;
}

export interface SeedShow {
  name: string;
  aliases?: string[];
  /** Plateforme de streaming connue quand l'émission n'est pas diffusée à la télévision. */
  streaming?: string;
}

/** Émissions françaises suivies d'office (titre → recherche TMDB) en plus de ce que TMDB propose. */
export const SEED_SHOWS: SeedShow[] = [
  { name: 'La France a un incroyable talent', aliases: ['Incroyable talent', 'La France a un incroyable talent la finale'] },
  { name: 'LOL : qui rit, sort !', aliases: ['LOL qui rit sort', 'LOL'], streaming: 'Prime Video' },
  { name: 'Koh-Lanta', aliases: ['Koh Lanta'] },
  { name: 'The Voice', aliases: ['The Voice la plus belle voix', 'The Voice Kids'] },
  { name: 'Quotidien' },
  { name: 'Top Chef' },
  { name: 'Fort Boyard' },
  { name: 'Les Reines du shopping' },
  { name: 'Danse avec les stars' },
  { name: 'Les 12 coups de midi' },
  { name: 'Questions pour un champion' },
  { name: 'N’oubliez pas les paroles' },
  { name: 'Burger Quiz' },
  { name: 'Tout le monde veut prendre sa place' },
  { name: 'Le Meilleur Pâtissier' },
  { name: 'Cauchemar en cuisine' },
  { name: 'L’amour est dans le pré' },
  { name: 'Mask Singer' },
  { name: 'Star Academy' },
  { name: 'Pékin Express' },
  { name: 'Les Marseillais' },
  { name: 'Touche pas à mon poste', aliases: ['TPMP'] },
  { name: 'C à vous' },
  { name: 'On n’est pas couché' },
  { name: 'Zone interdite' },
  { name: 'Capital' },
  { name: 'Secrets d’histoire' },
  { name: 'Vendredi tout est permis' },
  { name: 'Slam' },
  { name: 'Des chiffres et des lettres' },
  { name: 'Les Grosses Têtes' },
  { name: 'Le Grand Bêtisier', aliases: ['Bêtisier'] },
  { name: 'Rendez-vous en terre inconnue' },
  { name: 'Bienvenue chez nous' },
  { name: 'Les Anges' },
];

const ARTICLES = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'the', 'des']);

/** Minuscules sans accents ni ponctuation, mots séparés par une espace : base des comparaisons de texte du guide. */
export function foldText(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** « La France a un incroyable talent » → « france a un incroyable talent » (sans accents, ponctuation ni article initial). */
export function titleKey(s: unknown): string {
  const words = foldText(s).split(' ').filter(Boolean);
  while (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.join(' ');
}

/** Titre de programme sans « Saison 2 », « Épisode 5 », « S2E5 », parenthèses, « inédit »… ; `head` en est la première partie (avant « : » ou « - »). */
function splitProgram(raw: string): { full: string; head: string } {
  let t = String(raw ?? '');
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  t = t.replace(/\b(?:s|saison|season)\s*\d+\s*(?:e|ep|episode|épisode)?\s*\d*\b/gi, ' ');
  t = t.replace(/\b(?:épisode|episode|ep\.?)\s*\d+(?:\s*\/\s*\d+)?/gi, ' ');
  t = t.replace(/\b(?:inédit|inedit|rediffusion|replay|en direct)\b/gi, ' ');
  return { full: t, head: t.split(/\s[:\-–—]\s|:\s|\s[-–—]\s/)[0] };
}

/** Variantes normalisées d'un titre de programme : sans « Saison 2 », « Épisode 5 », « S2E5 », parenthèses, « inédit »… */
export function programKeys(raw: string): string[] {
  const { full, head } = splitProgram(raw);
  return [...new Set([titleKey(full), titleKey(head)].filter(Boolean))];
}

/** Premières parties de titre trop génériques pour nommer une émission : « Documentaire : Le Mont Blanc » garde son titre complet. */
const GENERIC_HEADS = new Set(['documentaire', 'magazine', 'divertissement', 'meteo', 'programmes de la nuit', 'journal', 'reportage', 'emission', 'speciale', 'inedit', 'film', 'serie', 'jeu']);

/** Partie du titre qui nomme l'émission : la première (avant « : » ou « - »), sauf si elle est générique : alors le titre complet. */
function showPart(raw: string): string {
  const { full, head } = splitProgram(raw);
  return GENERIC_HEADS.has(titleKey(head)) ? full : head;
}

const tidy = (s: string): string => s.replace(/\s+/g, ' ').replace(/[\s:\-–—]+$/, '').trim();

/** Clé de regroupement d'une émission du guide : sa partie nommante normalisée (« Koh-Lanta : La légende » → « koh lanta »). */
export function showKey(raw: string): string {
  return titleKey(showPart(raw)) || titleKey(splitProgram(raw).full);
}

/** Nom d'affichage d'une émission du guide, casse d'origine (« Koh-Lanta : La légende - Épisode 3 » → « Koh-Lanta »). */
export function showName(raw: string): string {
  return tidy(showPart(raw)) || tidy(splitProgram(raw).full);
}

/** Identifiant d'une émission du guide sans fiche TMDB, à partir de sa clé : `epg:` suivi de la clé, espaces en tirets. */
export const epgIdOf = (key: string): string => 'epg:' + key.replace(/ /g, '-');

const SHOW_CATEGORY = /\b(?:divertissement|jeux?|magazine|documentaire|talk|reality|varietes?|emissions?|game|dating)\b|realite/;
const FICTION_CATEGORY = /\b(?:series?|telefilm|films?|cinema|animation|anime|dessin|jeunesse|enfants|clips?)\b/;

/**
 * Genre au guide (texte XMLTV, FR ou EN) d'une émission : divertissement, jeu, magazine, documentaire, talk-show, téléréalité,
 * variétés… Faux pour la fiction (films, séries, animation, jeunesse), l’information, la météo, le sport, les genres inconnus
 * et les genres vides. Un magazine reste une émission (« Magazine de cinéma ») ; une série documentaire n’en est pas une.
 */
export function isShowCategory(cat: string | null | undefined): boolean {
  const c = foldText(cat);
  if (!SHOW_CATEGORY.test(c)) return false;
  return /\bmagazine/.test(c) || !FICTION_CATEGORY.test(c);
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ? 1 : 2;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i) ? 1 : 2;
}

/** Le titre de programme `program` correspond-il à l'émission `show` (et ses alias) ? */
export function titleMatches(program: string, show: string, aliases: readonly string[] = []): boolean {
  const progs = programKeys(program);
  if (!progs.length) return false;
  const names = [show, ...aliases].map(titleKey).filter(Boolean);
  return names.some((n) => progs.some((p) => {
    if (p === n) return true;
    if (n.length < 5) return false; // « Slam », « LOL » : égalité stricte seulement
    if (p.startsWith(n + ' ')) return true; // « Koh-Lanta : La légende » → Koh-Lanta
    return n.length >= 10 && p.length >= 10 && distance(p, n) <= 1; // coquille d'une lettre
  }));
}

/** Programmes d'une émission au guide : en cours et à venir, du plus proche au plus lointain. */
export function airingsFor(
  show: { name: string; aliases?: readonly string[] },
  programs: readonly EpgProgram[],
  channelOf: (p: EpgProgram) => GuideChannel | undefined,
  now: number,
): Airing[] {
  const out: Airing[] = [];
  programs.forEach((p) => {
    if (p.stop <= now || !titleMatches(p.title, show.name, show.aliases)) return;
    const channel = channelOf(p);
    if (channel) out.push({ channel, start: p.start, stop: p.stop, title: p.title, desc: p.desc ?? '', icon: p.icon ?? '', category: p.category ?? '' });
  });
  return out.sort((a, b) => a.start - b.start || (a.channel.num ?? 99) - (b.channel.num ?? 99));
}

export const hhmm = (sec: number): string => { const d = new Date(sec * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export const localDate = (sec: number): string => { const d = new Date(sec * 1000); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

/** Libellé relatif du jour : « Aujourd’hui », « Demain », « samedi 24 octobre ». */
export function dayLabel(sec: number, nowSec: number): string {
  const d = localDate(sec);
  const today = localDate(nowSec);
  if (d === today) return 'Aujourd’hui';
  if (d === localDate(nowSec + 86400)) return 'Demain';
  return new Date(sec * 1000).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export const isLiveNow = (a: { start: number; stop: number }, now: number): boolean => a.start <= now && now < a.stop;
export const progressPct = (a: { start: number; stop: number }, now: number): number => Math.max(0, Math.min(100, Math.round(((now - a.start) / Math.max(1, a.stop - a.start)) * 100)));

/** Créneaux sans intérêt pour « Ce soir à la TV ». */
/** Chaînes d'information et parlementaires (FR : LCP, BFM TV, CNews, LCI, franceinfo) : pas de « soirée » à proposer. */
const NEWS_NUMS = new Set([13, 15, 16, 26, 27]);
const FILLER = /^(no data|m[ée]t[ée]o|publicit|programmes? de la nuit|t[ée]l[ée]-?achat|bande-annonce|ma[iî]tre|le (?:19|20)h|jt|journal|info|flash)/i;

/**
 * Le programme de la soirée de chaque chaîne : celui qui occupe le plus de temps entre 20 h 45 et 22 h 45 le jour `date`
 * (AAAA-MM-JJ), hors météo, journaux et programmes de nuit. Un seul programme par chaîne, dans l'ordre des chaînes.
 */
export function primeTime(
  programs: readonly EpgProgram[],
  channelOf: (p: EpgProgram) => GuideChannel | undefined,
  date: string,
): Airing[] {
  const best = new Map<string, { a: Airing; overlap: number }>();
  programs.forEach((p) => {
    if (localDate(p.start) !== date && localDate(p.stop - 1) !== date) return;
    if (FILLER.test(p.title.trim())) return;
    const channel = channelOf(p);
    if (!channel || (channel.num != null && NEWS_NUMS.has(channel.num))) return;
    const [y, m, d] = date.split('-').map(Number);
    const from = new Date(y, m - 1, d, 20, 45).getTime() / 1000;
    const to = new Date(y, m - 1, d, 22, 45).getTime() / 1000;
    const overlap = Math.min(p.stop, to) - Math.max(p.start, from);
    if (overlap < 20 * 60) return;
    const cur = best.get(channel.epgId);
    if (!cur || overlap > cur.overlap) best.set(channel.epgId, { a: { channel, start: p.start, stop: p.stop, title: p.title, desc: p.desc ?? '', icon: p.icon ?? '', category: p.category ?? '' }, overlap });
  });
  return [...best.values()].map((x) => x.a).sort((a, b) => (a.channel.num ?? 99) - (b.channel.num ?? 99) || a.start - b.start);
}

/** Index nom normalisé → entrée, pour rapprocher un titre de programme d'une émission connue (affiche TMDB). */
export function matchKnown<T extends { name: string; aliases?: readonly string[] }>(title: string, known: readonly T[]): T | null {
  return known.find((k) => titleMatches(title, k.name, k.aliases)) ?? null;
}


/** Alias connus d'une émission (liste d'émissions suivies d'office) et plateforme de streaming éventuelle. */
export function seedFor(name: string): SeedShow | null {
  return SEED_SHOWS.find((s) => titleMatches(name, s.name, s.aliases)) ?? null;
}
