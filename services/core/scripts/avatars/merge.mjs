#!/usr/bin/env node
/**
 * Assemble les lots d'avatars par collections en une sortie unique (voir docs du contrat « avatars par collections »).
 *
 * Entrées, pour chaque lot présent (jeux, anime, series, libres) :
 * - .avatars-build/<lot>/collections.json : liste de collections (champs du catalogue, `characters` complets, ordre =
 *   popularité décroissante) ;
 * - .avatars-build/<lot>/i/<colId>/<charId>.webp : vignette de chaque personnage.
 *
 * Sorties :
 * - .avatars-build/out/catalog.json (familles fixes, collections, « featured ») ;
 * - .avatars-build/out/c/<colId>.json (personnages, du plus connu au moins connu) ;
 * - .avatars-build/out/i/<colId>/<charId>.webp (liens durs, ou copies si le système refuse les liens) ;
 * - src/user/avatar-collections.ts (identifiants de toutes les collections et de celles autorisées aux enfants).
 *
 * Règles :
 * - un lot absent est signalé et ignoré ; sans aucun lot, rien n'est écrit (le fichier généré est conservé) ;
 * - toute erreur de validation (identifiant, famille, aperçu hors des personnages, image manquante, doublon) arrête le
 *   script avec code 1, sans rien écrire ;
 * - `previews` absent : les 8 premiers personnages. `total` : nombre de personnages publiés.
 *
 * Usage : node scripts/avatars/merge.mjs
 * Sans dépendance (Node ESM).
 */
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Dossier de build (gitignoré) et fichier TypeScript généré. */
export const DEFAULT_BUILD_DIR = join(ROOT, '.avatars-build');
export const DEFAULT_TS_FILE = join(ROOT, 'src', 'user', 'avatar-collections.ts');

/** Lots produits par les scripts lot_*.py, dans l'ordre d'assemblage. */
export const LOTS = ['jeux', 'anime', 'series', 'libres'];

/** Familles fixes du catalogue (contrat, §2). */
export const FAMILIES = [
  { id: 'heroes', label: 'Super-héros' },
  { id: 'disney', label: 'Disney et films' },
  { id: 'anime', label: 'Anime' },
  { id: 'series', label: 'Séries et dessins animés' },
  { id: 'games', label: 'Jeux vidéo' },
  { id: 'free', label: 'Illustrés' },
];

export const PREVIEW_COUNT = 8;
export const FEATURED_COUNT = 24;

/**
 * Collections « connues » : le premier aperçu de chacune alimente « Les plus choisis » (featured), dans cet ordre.
 * Les identifiants absents du build sont ignorés.
 */
export const FEATURED_ORDER = [
  'pokemon-officiel',
  'marvel-heros',
  'lilo-stitch',
  'reine-des-neiges',
  'star-wars',
  'naruto',
  'demon-slayer-kimetsu-no-yaiba',
  'lol',
  'simpsons',
  'mickey-amis',
  'spy-x-family',
  'dicebear-lorelei',
  'dc-heros',
  'roi-lion',
  'minecraft',
  'dragon-ball',
  'attack-on-titan',
  'death-note',
  'dota2',
  'genshin',
  'rick-morty',
  'harry-potter',
  'amiibo-mario',
  'dicebear-adventurer',
];

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_ERRORS_SHOWN = 50;

/** Erreurs de validation : message lisible, sans écriture. */
export class MergeError extends Error {
  constructor(errors) {
    super(`${errors.length} erreur(s) de validation`);
    this.name = 'MergeError';
    this.errors = errors;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** Valide une collection brute d'un lot. Renvoie la collection normalisée, ou undefined (erreurs ajoutées à `errors`). */
function normalizeCollection(raw, lot, errors, seenCollections) {
  if (!isPlainObject(raw)) {
    errors.push(`${lot} : entrée de collection qui n'est pas un objet`);
    return undefined;
  }
  const id = raw.id;
  if (typeof id !== 'string' || !SLUG.test(id)) {
    errors.push(`${lot} : identifiant de collection invalide`);
    return undefined;
  }
  const where = `${lot}/${id}`;
  let ok = true;
  const fail = (message) => {
    errors.push(`${where} : ${message}`);
    ok = false;
  };
  if (seenCollections.has(id)) fail('identifiant déjà utilisé par un autre lot ou une autre collection');
  seenCollections.add(id);
  if (!FAMILIES.some((family) => family.id === raw.family)) fail('famille inconnue (voir FAMILIES)');
  if (!isText(raw.name, 120)) fail('nom manquant ou trop long');
  for (const field of ['source', 'license']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > 200)) fail(`${field} : texte attendu`);
  }
  for (const field of ['free', 'kid']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') fail(`${field} : booléen attendu`);
  }
  for (const field of ['group', 'style']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > 60)) fail(`${field} : texte attendu`);
  }
  if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.some((alias) => !isText(alias, 120)))) {
    fail('aliases : liste de textes attendue');
  }

  const characters = [];
  const characterIds = new Set();
  if (!Array.isArray(raw.characters) || raw.characters.length === 0) {
    fail('characters : liste non vide attendue');
  } else {
    for (const character of raw.characters) {
      if (!isPlainObject(character) || typeof character.id !== 'string' || !SLUG.test(character.id)) {
        fail('personnage : identifiant invalide');
        continue;
      }
      if (characterIds.has(character.id)) {
        fail(`personnage en double : ${character.id}`);
        continue;
      }
      if (!isText(character.name, 120)) {
        fail(`personnage ${character.id} : nom manquant`);
        continue;
      }
      characterIds.add(character.id);
      characters.push({ id: character.id, name: character.name });
    }
  }

  let previews;
  if (raw.previews === undefined) {
    previews = characters.slice(0, PREVIEW_COUNT).map((character) => character.id);
  } else if (!Array.isArray(raw.previews) || raw.previews.length > PREVIEW_COUNT || new Set(raw.previews).size !== raw.previews.length) {
    fail(`previews : au plus ${PREVIEW_COUNT} identifiants distincts attendus`);
  } else if (raw.previews.some((preview) => !characterIds.has(preview))) {
    fail('previews : identifiant absent de characters');
  } else {
    previews = [...raw.previews];
  }

  if (!ok || previews === undefined) return undefined;
  return {
    lot,
    id,
    family: raw.family,
    name: raw.name,
    source: raw.source ?? '',
    license: raw.license ?? '',
    free: raw.free ?? false,
    kid: raw.kid ?? false,
    total: characters.length,
    aliases: raw.aliases ?? [],
    ...(raw.group === undefined ? {} : { group: raw.group }),
    ...(raw.style === undefined ? {} : { style: raw.style }),
    previews,
    characters,
  };
}

/** Lit et valide les collections des lots présents. Les lots absents sont signalés par `log`. */
async function readCollections(buildDir, lots, errors, log) {
  const collections = [];
  const seen = new Set();
  for (const lot of lots) {
    const file = join(buildDir, lot, 'collections.json');
    if (!existsSync(file)) {
      log(`lot absent, ignoré : ${lot}`);
      continue;
    }
    let list;
    try {
      list = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      errors.push(`${lot}/collections.json : JSON invalide`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${lot}/collections.json : tableau attendu`);
      continue;
    }
    for (const raw of list) {
      const collection = normalizeCollection(raw, lot, errors, seen);
      if (collection !== undefined) collections.push(collection);
    }
  }
  return collections;
}

/** Vérifie que chaque personnage a son image : une image manquante est une erreur de validation. */
function checkImages(buildDir, collections, errors) {
  for (const collection of collections) {
    const missing = collection.characters.filter((character) => !existsSync(imageSource(buildDir, collection, character.id)));
    if (missing.length > 0) {
      const sample = missing.slice(0, 3).map((character) => character.id).join(', ');
      errors.push(`${collection.lot}/${collection.id} : ${missing.length} image(s) absente(s) (ex. ${sample})`);
    }
  }
}

function imageSource(buildDir, collection, characterId) {
  return join(buildDir, collection.lot, 'i', collection.id, `${characterId}.webp`);
}

/** Lien dur vers l'image source (même volume), ou copie si le système refuse le lien. */
async function publishImage(source, target) {
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

/** Fichier TypeScript des identifiants de collections (même contenu que le fichier initial, trié). */
export function renderCollectionsTs(collections) {
  const ids = collections.map((collection) => collection.id).sort();
  const kidIds = collections
    .filter((collection) => collection.kid)
    .map((collection) => collection.id)
    .sort();
  const list = (values) => values.map((value) => `  '${value}',`).join('\n');
  return `// Fichier généré par scripts/avatars/merge.mjs : ne pas modifier à la main.
// Identifiants des collections d'avatars (\`col:<colId>:<charId>\`) : toutes celles publiées, et celles autorisées aux profils enfants.

/** Toutes les collections publiées (catalogue : /avatars/catalog.json). */
export const ALL_AVATAR_COLLECTIONS: ReadonlySet<string> = new Set<string>([
${list(ids)}
]);

/** Collections autorisées aux profils enfants (\`kid: true\` dans le catalogue). */
export const KID_AVATAR_COLLECTIONS: ReadonlySet<string> = new Set<string>([
${list(kidIds)}
]);
`;
}

/** Catalogue au format du contrat : familles fixes, collections (sans personnages), « featured ». */
export function buildCatalog(collections, now) {
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  const featured = [];
  for (const id of FEATURED_ORDER) {
    const collection = byId.get(id);
    const first = collection?.previews[0];
    if (first !== undefined) featured.push(`col:${collection.id}:${first}`);
  }
  return {
    version: now.toISOString().slice(0, 10),
    families: FAMILIES,
    collections: collections.map((collection) => {
      const { lot: _lot, characters: _characters, ...fields } = collection;
      return fields;
    }),
    featured: featured.slice(0, FEATURED_COUNT),
  };
}

/**
 * Assemble les lots. Renvoie un résumé ; lève MergeError si la validation échoue (aucune écriture dans ce cas).
 * Options : `buildDir`, `tsFile`, `lots`, `now` (date de version), `log` (messages de progression).
 */
export async function mergeAvatarBuild({ buildDir = DEFAULT_BUILD_DIR, tsFile = DEFAULT_TS_FILE, lots = LOTS, now = new Date(), log = console.log } = {}) {
  const errors = [];
  const collections = await readCollections(buildDir, lots, errors, log);
  if (errors.length === 0) checkImages(buildDir, collections, errors);
  if (errors.length > 0) throw new MergeError(errors);
  if (collections.length === 0) {
    log('aucun lot prêt (collections.json absent) : rien écrit, le fichier généré est conservé');
    return { collections: 0, characters: 0, images: 0, featured: 0, written: false };
  }

  const out = join(buildDir, 'out');
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'c'), { recursive: true });
  await mkdir(join(out, 'i'), { recursive: true });

  const catalog = buildCatalog(collections, now);
  await writeFile(join(out, 'catalog.json'), `${JSON.stringify(catalog)}\n`);
  let images = 0;
  for (const collection of collections) {
    await writeFile(join(out, 'c', `${collection.id}.json`), `${JSON.stringify({ id: collection.id, characters: collection.characters })}\n`);
    await mkdir(join(out, 'i', collection.id), { recursive: true });
    for (const character of collection.characters) {
      await publishImage(imageSource(buildDir, collection, character.id), join(out, 'i', collection.id, `${character.id}.webp`));
      images += 1;
    }
  }
  await mkdir(dirname(tsFile), { recursive: true });
  await writeFile(tsFile, renderCollectionsTs(collections));

  const characters = collections.reduce((sum, collection) => sum + collection.characters.length, 0);
  return { collections: collections.length, characters, images, featured: catalog.featured.length, written: true };
}

/** Message d'erreur de validation, tronqué pour rester lisible. */
function formatErrors(errors) {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).map((message) => `  - ${message}`);
  if (errors.length > MAX_ERRORS_SHOWN) shown.push(`  … et ${errors.length - MAX_ERRORS_SHOWN} autre(s)`);
  return shown.join('\n');
}

async function main() {
  try {
    const summary = await mergeAvatarBuild();
    if (summary.written) {
      console.log(
        `avatars : ${summary.collections} collection(s), ${summary.characters} personnage(s), ${summary.images} image(s), ${summary.featured} « featured ».`,
      );
      console.log(`sortie : ${join(DEFAULT_BUILD_DIR, 'out')}`);
      console.log(`fichier généré : ${DEFAULT_TS_FILE}`);
    }
  } catch (err) {
    if (err instanceof MergeError) {
      console.error(`merge.mjs : validation échouée, rien écrit.\n${formatErrors(err.errors)}`);
    } else {
      console.error(`merge.mjs : ${err instanceof Error ? err.message : 'erreur inconnue'}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
