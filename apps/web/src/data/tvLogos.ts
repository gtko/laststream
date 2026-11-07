/* TV en direct : logos des chaînes. La playlist d'une box (Freebox) n'a pas d'attribut tvg-logo : on retrouve le logo par
 * correspondance avec le catalogue serveur (logos iptv-org), puis, à défaut, on dessine une pastille (initiales + numéro) sur
 * une couleur dérivée du nom. Logique pure, testée. */
import { NATIONAL, normText } from './tvRank';

export interface LogoChannel {
  id?: string;
  name?: string;
  logo?: string;
  epgId?: string;
  tvgId?: string;
  num?: number | null;
  box?: { num?: number } | null;
}

/** Mots de qualité ou de variante qui ne font pas partie du nom (« France 2 HD », « TF1 (auto) », « M6 (standard) »). */
const NOISE = /\b(hd|fhd|uhd|sd|4k|hevc|h264|h265|auto|standard|bas ?debit|low|backup|direct|live|multiplex)\b/g;

/** Alias courants : clé normalisée → clé canonique (appliqués après le nettoyage). */
const ALIASES: Record<string, string> = {
  franceinfotv: 'franceinfo', franceinfo: 'franceinfo', cnewstv: 'cnews', lequipetv: 'lequipe', lequipe21: 'lequipe',
  canalplus: 'canalplus', canal: 'canalplus', arte: 'arte', artefr: 'arte', artefrench: 'arte', nrj: 'nrj12', rmcdecouvertetv: 'rmcdecouverte',
  tf1seriefilms: 'tf1seriesfilms', tf1series: 'tf1seriesfilms', bfm: 'bfmtv', bfmtvfr: 'bfmtv',
};

/** Nom sans parenthèses, qualité, numéro de tête (« 2 - France 2 HD (auto) » → « france 2 »). */
export function cleanName(name: unknown): string {
  let s = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  s = s.replace(/^\s*\d{1,4}\s*[-–.:]\s+/, '');
  s = s.replace(/\.[a-z]{2}\b/g, ' ');
  s = s.replace(NOISE, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const tntKeyOf = (norm: string): string => {
  for (const e of NATIONAL.FR) if (e.keys.includes(norm)) return `n${e.num}`;
  return '';
};

/** Clé de rapprochement d'un nom : numéro TNT officiel (« n2 ») si la chaîne en fait partie, sinon nom normalisé (« k:bfmtv »). */
export function logoKey(name: unknown): string {
  const norm = normText(cleanName(name));
  if (!norm) return '';
  const tnt = tntKeyOf(norm) || tntKeyOf(ALIASES[norm] ?? '');
  if (tnt) return tnt;
  return `k${ALIASES[norm] ?? norm}`;
}

/** Clé d'un identifiant de guide (« France2.fr », « fr:TF1.fr ») : sans préfixe ni suffixe de pays. */
function idKey(id: unknown): string {
  const raw = String(id ?? '').replace(/^[a-z]{2,6}:/i, '').replace(/\.[a-z]{2}$/i, '');
  return logoKey(raw);
}

/** Clés d'une chaîne, de la plus fiable à la moins fiable. */
function keysOf(c: LogoChannel): string[] {
  const out: string[] = [];
  const add = (k: string) => { if (k && !out.includes(k)) out.push(k); };
  add(logoKey(c.name));
  add(idKey(c.epgId));
  add(idKey(c.tvgId));
  add(idKey(c.id));
  return out;
}

/** Numéro TNT d'une chaîne dont le nom contient celui d'une chaîne officielle (« FR TF1 Direct » portant le numéro 1). */
function tntByNumber(c: LogoChannel): string {
  const num = Number(c.num || (c.box && c.box.num) || 0);
  if (!num) return '';
  const norm = normText(cleanName(c.name));
  const e = NATIONAL.FR.find((x) => x.num === num);
  return e && norm && e.keys.some((k) => k.length >= 3 && norm.includes(k)) ? `n${num}` : '';
}

const isUrl = (u: unknown): u is string => typeof u === 'string' && /^(https?:\/\/|data:image\/)/i.test(u);

export type LogoIndex = Map<string, string>;

/** Index clé → logo à partir des chaînes du catalogue qui en ont un (la première rencontrée gagne ; https avant http). */
export function buildLogoIndex(catalog: Iterable<LogoChannel>): LogoIndex {
  const idx: LogoIndex = new Map();
  for (const c of catalog) {
    if (!isUrl(c.logo)) continue;
    for (const k of keysOf(c)) {
      const cur = idx.get(k);
      if (!cur || (!/^https:/i.test(cur) && /^https:/i.test(c.logo))) idx.set(k, c.logo);
    }
  }
  return idx;
}

/** Logo d'une chaîne : le sien, sinon celui du catalogue par nom, identifiant du guide ou numéro TNT ; chaîne vide si rien. */
export function findLogo(c: LogoChannel, idx: LogoIndex | null | undefined): string {
  if (isUrl(c.logo)) return c.logo;
  if (!idx || !idx.size) return '';
  for (const k of keysOf(c)) {
    const hit = idx.get(k);
    if (hit) return hit;
  }
  const t = tntByNumber(c);
  return (t && idx.get(t)) || '';
}

// ---------- Pastille de repli ----------

export interface LogoBadge {
  /** Initiales (1 à 3 caractères). */
  text: string;
  /** Numéro de la chaîne, ou chaîne vide. */
  num: string;
  /** Couleur de fond (teinte dérivée du nom) et de texte. */
  bg: string;
  fg: string;
  hue: number;
}

const hash = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
};

/** Initiales d'un nom : « France 2 » → « F2 », « RMC Découverte » → « RD », « TF1 » → « TF1 », « Arte » → « AR ». */
export function initials(name: unknown): string {
  const words = cleanName(name).split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  const last = words[words.length - 1];
  // « FAST Sport 10 » → « F10 » : le numéro distingue les chaînes d'une même série.
  if (words.length > 2 && /^\d{1,2}$/.test(last)) return (words[0][0] + last).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

/** Pastille de repli : jamais vide, couleur stable pour un même nom, texte lisible (contraste élevé). */
export function badgeOf(c: LogoChannel): LogoBadge {
  const base = normText(cleanName(c.name)) || normText(c.id) || '?';
  const hue = hash(base) % 360;
  const num = Number(c.num || (c.box && c.box.num) || 0);
  return { text: initials(c.name), num: num > 0 ? String(num) : '', bg: `hsl(${hue} 52% 32%)`, fg: '#fff', hue };
}
