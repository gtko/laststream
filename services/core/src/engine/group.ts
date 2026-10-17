import type { FrVariant, Hdr, Lang, ParsedRelease } from '../types.js';
import { type Candidate, fileIdxOf, infoHashOf, isDirect, seedersOf, sizeOf } from './types.js';

/** Une copie de la release : une source (hash ou URL directe) qui peut la fournir. */
export interface CopyRef {
  infoHash?: string;
  fileIdx?: number;
  url?: string;
  filename?: string;
  size?: number;
  sourceName: string;
  cached?: boolean;
}

/** Représentant d'un groupe : métadonnées fusionnées et toutes ses copies, ordonnées (cachées d'abord). */
export type GroupedCandidate = Candidate & { copies: CopyRef[] };

const VIDEO_EXTENSION = /\.(mkv|mp4|avi|m4v|webm|mov|wmv)$/i;
const CHANNELS_PATTERN = /^(\d+)(?:\.(\d+))?$/;
/** Tolérance de taille entre deux copies, rapportée à la plus grande des deux (±0,5 %). */
const SIZE_TOLERANCE = 0.005;
/** Rang des variantes FR : exactes (comme EXACT_FR_VARIANTS de score.ts) > VFQ > sous-titres seuls. */
const FR_VARIANT_RANK: Record<FrVariant, number> = {
  VFF: 2,
  TRUEFRENCH: 2,
  VF2: 2,
  FRENCH: 2,
  VFQ: 1,
  VOSTFR: 0,
  SUBFRENCH: 0,
};

/** Union-find (compression de chemin), même principe que dedupe.ts. */
class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let current = index;
    while (this.parent[current] !== current) {
      this.parent[current] = this.parent[this.parent[current]];
      current = this.parent[current];
    }
    return current;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

/** Nom normalisé : sans extension vidéo, minuscules, lettres et chiffres seulement. */
function normalizedName(c: Candidate): string | undefined {
  const name = c.raw.filename ?? c.raw.title ?? c.parsed.title;
  if (!name) return undefined;
  const normalized = name.replace(VIDEO_EXTENSION, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return normalized.length > 0 ? normalized : undefined;
}

/** Clé d'un hash (+ fichier s'il existe) : même clé ⇒ même copie exacte. */
function hashKey(hash: string, fileIdx: number | undefined): string {
  return `hash:${hash.toLowerCase()}${fileIdx === undefined ? '' : `:${fileIdx}`}`;
}

/** Clés d'identité : deux candidats qui partagent une clé désignent la même release. */
function identityKeys(c: Candidate): string[] {
  const keys: string[] = [];
  const hash = infoHashOf(c);
  if (hash !== undefined) keys.push(hashKey(hash, fileIdxOf(c)));
  if (isDirect(c) && c.raw.url !== undefined) keys.push(`url:${c.raw.url}`);
  const name = normalizedName(c);
  if (name !== undefined) keys.push(`name:${name}`);
  return keys;
}

/** Groupe de release normalisé ; absent ⇒ pas de rapprochement par taille (on ne groupe pas sans groupe connu). */
function releaseGroup(c: Candidate): string | undefined {
  const group = c.parsed.group?.trim().toLowerCase();
  return group === undefined || group === '' ? undefined : group;
}

function sizesClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= SIZE_TOLERANCE * Math.max(a, b);
}

/** Vrai si `a` est un meilleur représentant que `b` : cached > seeders > URL directe. À égalité, le premier gagne. */
function isBetter(a: Candidate, b: Candidate): boolean {
  const cachedA = a.cached === true;
  const cachedB = b.cached === true;
  if (cachedA !== cachedB) return cachedA;
  const seedersA = seedersOf(a) ?? -1;
  const seedersB = seedersOf(b) ?? -1;
  if (seedersA !== seedersB) return seedersA > seedersB;
  const directA = isDirect(a);
  const directB = isDirect(b);
  if (directA !== directB) return directA;
  return false;
}

/** Ordre des copies : cachées d'abord, puis seeders décroissants (inconnus en dernier), puis directes en fin. */
function compareForCopies(a: Candidate, b: Candidate): number {
  const cachedA = a.cached === true;
  const cachedB = b.cached === true;
  if (cachedA !== cachedB) return cachedA ? -1 : 1;
  const seedersDiff = (seedersOf(b) ?? -1) - (seedersOf(a) ?? -1);
  if (seedersDiff !== 0) return seedersDiff;
  const directA = isDirect(a);
  if (directA !== isDirect(b)) return directA ? 1 : -1;
  return 0;
}

function copyOf(c: Candidate): CopyRef {
  const copy: CopyRef = { sourceName: c.raw.sourceName };
  const hash = infoHashOf(c);
  if (hash !== undefined) copy.infoHash = hash;
  const fileIdx = fileIdxOf(c);
  if (fileIdx !== undefined) copy.fileIdx = fileIdx;
  if (isDirect(c) && c.raw.url !== undefined) copy.url = c.raw.url;
  if (c.raw.filename !== undefined) copy.filename = c.raw.filename;
  const size = sizeOf(c);
  if (size !== undefined) copy.size = size;
  if (c.cached !== undefined) copy.cached = c.cached;
  return copy;
}

/** Supprime les copies identiques (même hash+fichier, ou même URL). La première (la meilleure) est gardée. */
function dedupeCopies(copies: CopyRef[]): CopyRef[] {
  const seen = new Set<string>();
  return copies.filter((copy) => {
    const keys: string[] = [];
    if (copy.infoHash !== undefined) keys.push(hashKey(copy.infoHash, copy.fileIdx));
    if (copy.url !== undefined) keys.push(`url:${copy.url}`);
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Valeur la plus riche selon `rank` ; à égalité, la première gagne. */
function richest<T>(values: (T | undefined)[], rank: (value: T) => number): T | undefined {
  let best: T | undefined;
  let bestRank = -Infinity;
  for (const value of values) {
    if (value === undefined) continue;
    const current = rank(value);
    if (current > bestRank) {
      best = value;
      bestRank = current;
    }
  }
  return best;
}

/** Nombre de canaux : « 5.1 » vaut 6, « 2.0 » vaut 2 ; une forme non numérique vaut 0. */
function channelCount(channels: string): number {
  const match = CHANNELS_PATTERN.exec(channels.trim());
  return match === null ? 0 : Number(match[1]) + Number(match[2] ?? 0);
}

/** Drapeau fusionné : vrai si un membre est vrai, faux si un membre est faux, sinon absent. */
function mergeFlag(values: (boolean | undefined)[]): boolean | undefined {
  if (values.includes(true)) return true;
  return values.includes(false) ? false : undefined;
}

/** Hors langue préférée seulement si tous les membres le sont ; un membre en langue préférée suffit. */
function mergeLanguageFallback(members: Candidate[]): boolean | undefined {
  if (members.every((c) => c.languageFallback === true)) return true;
  return members.some((c) => c.languageFallback === false) ? false : undefined;
}

function buildGroup(members: Candidate[]): GroupedCandidate {
  const representative = members.reduce((best, c) => (isBetter(c, best) ? c : best));
  const parsedList: ParsedRelease[] = members.map((c) => c.parsed);

  const parsed: ParsedRelease = {
    ...representative.parsed,
    languages: unique<Lang>(parsedList.flatMap((p) => p.languages)),
    audio: unique(parsedList.flatMap((p) => p.audio)),
    hdr: unique<Hdr>(parsedList.flatMap((p) => p.hdr)),
    multi: parsedList.some((p) => p.multi),
    subsFr: parsedList.some((p) => p.subsFr),
  };
  const channels = richest(
    parsedList.map((p) => p.channels),
    (value) => channelCount(value),
  );
  if (channels !== undefined) parsed.channels = channels;
  const frVariant = richest(
    parsedList.map((p) => p.frVariant),
    (value) => FR_VARIANT_RANK[value],
  );
  if (frVariant !== undefined) parsed.frVariant = frVariant;

  const copies = dedupeCopies([...members].sort(compareForCopies).map(copyOf));
  const merged: GroupedCandidate = { raw: representative.raw, parsed, copies };
  const cached = mergeFlag(members.map((c) => c.cached));
  if (cached !== undefined) merged.cached = cached;
  const languageFallback = mergeLanguageFallback(members);
  if (languageFallback !== undefined) merged.languageFallback = languageFallback;
  return merged;
}

/**
 * Regroupe les candidats qui désignent la même release. Deux candidats sont la même release si :
 * - ils partagent un hash (+ fichier), une URL directe, ou un nom normalisé identique (sans extension vidéo) ;
 * - ou leur taille est à ±0,5 % près, avec même groupe de release et même résolution.
 * Chaque groupe devient un représentant (meilleur : cached > seeders > URL directe) avec les métadonnées
 * fusionnées et la liste de ses copies. L'ordre d'arrivée des groupes est conservé. Les entrées ne sont pas modifiées.
 */
export function groupCopies(cands: Candidate[]): GroupedCandidate[] {
  const sets = new DisjointSet(cands.length);

  const firstByKey = new Map<string, number>();
  cands.forEach((c, index) => {
    for (const key of identityKeys(c)) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, index);
      else sets.union(index, first);
    }
  });

  // Rapprochement par taille, seulement à l'intérieur d'un même paquet (groupe, résolution).
  const buckets = new Map<string, { index: number; bytes: number }[]>();
  cands.forEach((c, index) => {
    const group = releaseGroup(c);
    const bytes = sizeOf(c);
    if (group === undefined || bytes === undefined || bytes <= 0) return;
    const key = `${group}\u0000${c.parsed.resolution}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [{ index, bytes }]);
    else bucket.push({ index, bytes });
  });
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (sizesClose(a.bytes, b.bytes)) sets.union(a.index, b.index);
      }
    }
  }

  // Un groupe par racine. Les membres sont ajoutés dans l'ordre d'arrivée : la première apparition ordonne les groupes.
  const membersByRoot = new Map<number, Candidate[]>();
  cands.forEach((c, index) => {
    const root = sets.find(index);
    const members = membersByRoot.get(root);
    if (members === undefined) membersByRoot.set(root, [c]);
    else members.push(c);
  });
  return [...membersByRoot.values()].map((members) => buildGroup(members));
}
