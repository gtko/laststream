import { originSummary, sourceKeyOf, type SourceView } from './info';

/* Identité d'une release, indépendante du fournisseur qui la propose : plusieurs addons (ou débrideurs) servent souvent le même
 * fichier. Sert à regrouper les doublons dans la liste des sources et à essayer, au repli, la même release chez un autre
 * fournisseur avant de changer de version. Fonctions pures, testées. */

/** Écart de taille toléré entre deux annonces d'un même fichier (les addons arrondissent parfois la taille). */
const SIZE_TOLERANCE = 0.005;
/** En dessous, une taille identique ne suffit pas à reconnaître un fichier (échantillons, bandes-annonces). */
const SIZE_ONLY_MIN_BYTES = 100e6;

/** Nom de fichier comparable : casse, séparateurs (points, espaces, tirets bas) et extension ignorés. */
export function normalizedFilename(name: string): string {
  const base = String(name ?? '').trim().toLowerCase().replace(/^.*[\\/]/, '');
  return base.replace(/[\s._-]+/g, '.').replace(/\.(mkv|mp4|avi|m4v|ts|m2ts|mov|webm)$/i, '').replace(/^\.+|\.+$/g, '');
}

const hashOf = (v: SourceView): string => (v.stream.infoHash ?? '').toLowerCase();

function sizesMatch(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) <= Math.max(a, b) * SIZE_TOLERANCE;
}

/**
 * Vrai si deux sources désignent le même fichier : même torrent (hash d'info, et même fichier du torrent quand les deux le
 * précisent), ou même nom de fichier avec une taille compatible (ou inconnue d'un côté), ou à défaut de nom la même taille
 * exacte d'un gros fichier dans la même qualité.
 */
export function sameRelease(a: SourceView, b: SourceView): boolean {
  const ha = hashOf(a);
  const hb = hashOf(b);
  if (ha && hb && ha === hb) {
    const fa = a.stream.fileIdx;
    const fb = b.stream.fileIdx;
    return fa === undefined || fa === null || fb === undefined || fb === null || fa === fb;
  }
  const na = normalizedFilename(a.filename);
  const nb = normalizedFilename(b.filename);
  if (na && nb) {
    if (na !== nb) return false;
    return !(a.sizeBytes > 0 && b.sizeBytes > 0) || sizesMatch(a.sizeBytes, b.sizeBytes);
  }
  return a.sizeBytes >= SIZE_ONLY_MIN_BYTES && a.sizeBytes === b.sizeBytes && a.quality === b.quality;
}

/** Fournisseur affiché : addon d'origine (« Lumpi », « StreamFusion »), puis le débrideur s'il diffère ; vide si inconnu. */
export function providerOf(v: SourceView): string {
  const parts: string[] = [];
  const origin = originSummary(v.origins, 1);
  if (origin) parts.push(origin);
  const debrid = (v.provider ?? '').trim();
  if (debrid && !parts.some((p) => p.toLowerCase().includes(debrid.toLowerCase()))) parts.push(debrid);
  if (!parts.length && v.viaDevice) parts.push('via ton appareil');
  return parts.join(' · ');
}

/** Clé de fournisseur, pour compter les fournisseurs distincts d'une même release. */
const providerKey = (v: SourceView): string => (v.origins[0]?.name || v.provider || sourceKeyOf(v)).toLowerCase();

/** Infos techniques d'une ligne : codec, HDR, audio, débit, seeders (ce qui est connu seulement). */
export function sourceDetail(v: SourceView): string {
  const seeders = typeof v.seeders === 'number' && v.seeders >= 0 ? v.seeders + (v.seeders > 1 ? ' seeders' : ' seeder') : '';
  return [v.sourceType, v.codec, v.hdr.join(' '), v.audio, v.bitrateLabel, seeders].filter((x) => !!x && x.trim()).join(' · ');
}

/** Nom du fichier, à défaut le groupe de release ; vide si aucun n'est connu. */
export const releaseName = (v: SourceView): string => (v.filename || v.releaseGroup || '').trim();

export interface ReleaseGroup {
  /** Source affichée pour la release. */
  lead: SourceView;
  /** Toutes les sources de la release (lead compris), dans l'ordre reçu. */
  members: SourceView[];
  /** Nombre d'autres fournisseurs distincts qui proposent cette release. */
  others: number;
}

/**
 * Regroupe les sources par release. L'ordre des groupes suit celui de `views` (premier membre rencontré). La source affichée
 * d'un groupe est `prefer(members)` si elle en renvoie une, sinon le premier membre.
 */
export function groupReleases(views: readonly SourceView[], prefer?: (members: SourceView[]) => SourceView | undefined): ReleaseGroup[] {
  const groups: SourceView[][] = [];
  for (const v of views) {
    const g = groups.find((members) => members.some((m) => sameRelease(m, v)));
    if (g) g.push(v); else groups.push([v]);
  }
  return groups.map((members) => {
    const lead = prefer?.(members) ?? members[0];
    const others = new Set(members.map(providerKey));
    others.delete(providerKey(lead));
    return { lead, members, others: others.size };
  });
}
