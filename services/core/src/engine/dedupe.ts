import { type Candidate, fileIdxOf, infoHashOf, isDirect, seedersOf, sizeOf } from './types.js';

const MIB = 1024 ** 2;
const VIDEO_EXTENSION = /\.(mkv|mp4|avi|m4v|webm|mov|wmv)$/i;

/** Nom normalisé : sans extension vidéo, minuscules, lettres et chiffres seulement. */
function normalizedName(c: Candidate): string | undefined {
  const name = c.raw.filename ?? c.raw.title ?? c.parsed.title;
  if (!name) return undefined;
  const normalized = name.replace(VIDEO_EXTENSION, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return normalized.length > 0 ? normalized : undefined;
}

function hashKey(c: Candidate): string | undefined {
  const hash = infoHashOf(c);
  if (hash === undefined) return undefined;
  const fileIdx = fileIdxOf(c);
  return `hash:${hash.toLowerCase()}${fileIdx === undefined ? '' : `:${fileIdx}`}`;
}

/** Clé nom + taille arrondie au Mo. Sans taille connue, pas de clé : on ne fusionne pas sur le nom seul. */
function nameKey(c: Candidate): string | undefined {
  const name = normalizedName(c);
  const bytes = sizeOf(c);
  if (name === undefined || bytes === undefined) return undefined;
  return `name:${name}:${Math.round(bytes / MIB)}`;
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

/**
 * Supprime les doublons : même infoHash (+ même fileIdx s'il existe), ou même nom normalisé + taille arrondie au Mo.
 * Chaque groupe garde son meilleur représentant. L'ordre d'arrivée est conservé.
 */
export function dedupe(cands: Candidate[]): Candidate[] {
  const parent = cands.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  };

  const firstByKey = new Map<string, number>();
  cands.forEach((c, index) => {
    for (const key of [hashKey(c), nameKey(c)]) {
      if (key === undefined) continue;
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, index);
      else union(index, first);
    }
  });

  // Meilleur représentant par groupe. Un candidat ne remplace le représentant que s'il est strictement meilleur.
  const bestByRoot = new Map<number, number>();
  cands.forEach((c, index) => {
    const root = find(index);
    const current = bestByRoot.get(root);
    if (current === undefined || isBetter(c, cands[current])) bestByRoot.set(root, index);
  });

  return [...bestByRoot.values()].sort((a, b) => a - b).map((index) => cands[index]);
}
