/* Adresses des pages d'un addon (ODY-252) : catalogue `#/addon/<slug>/<type>/<catalogue>` et fiche `#/addon/<slug>/<type>/meta/<id>`.
 * Le slug est une empreinte FNV-1a 64 bits (16 caractères hexadécimaux) de la clé de l'addon : l'adresse de l'addon, qui peut contenir
 * un jeton, n'apparaît donc jamais dans la barre d'adresse. Ce n'est pas un chiffrement : le slug sert à retrouver la clé dans le
 * registre local (`resolveAddonSlug`). Les segments de type, de catalogue et d'identifiant sont encodés (`encodeURIComponent`).
 * Module sans DOM ni réseau (la lecture du registre est locale). */
import { readAddonCatalogs } from '../data/addonCatalog';

const enc = encodeURIComponent;
const PREFIX = '#/addon/';
const SLUG = /^[0-9a-f]{16}$/;

/** Empreinte FNV-1a 64 bits de la clé (UTF-8), en 16 caractères hexadécimaux. Synchrone et stable d'une session à l'autre. */
export function addonSlug(addonKey) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(addonKey)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

/** Route d'un catalogue d'addon. */
export function addonCatalogHash(addonKey, type, catId) {
  return `${PREFIX}${addonSlug(addonKey)}/${enc(type)}/${enc(catId)}`;
}

/** Route d'une fiche d'addon. */
export function addonMetaHash(addonKey, type, id) {
  return `${PREFIX}${addonSlug(addonKey)}/${enc(type)}/meta/${enc(id)}`;
}

/** Clé du registre dont le slug vaut `slug` ; null si le slug est mal formé ou si l'addon n'est plus dans le registre. */
export function resolveAddonSlug(slug, registry = readAddonCatalogs()) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  return Object.keys(registry).find((key) => addonSlug(key) === slug) ?? null;
}

const decodeSegment = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/**
 * Lit une route d'addon (avec ou sans `#` en tête). Renvoie `{kind:'catalog', addonSlug, type, catId}`,
 * `{kind:'meta', addonSlug, type, id}`, ou null si la route n'est pas une route d'addon valide. Le slug n'est pas résolu ici.
 */
export function parseAddonHash(path) {
  if (typeof path !== 'string') return null;
  const m = /^#?\/addon\/([^/]+)\/(.*)$/.exec(path);
  if (!m || !SLUG.test(m[1])) return null;
  const slug = m[1];
  const parts = m[2].split('/');
  if (parts.length === 2) {
    const type = decodeSegment(parts[0]);
    const catId = decodeSegment(parts[1]);
    return type && catId ? { kind: 'catalog', addonSlug: slug, type, catId } : null;
  }
  if (parts.length === 3 && parts[1] === 'meta') {
    const type = decodeSegment(parts[0]);
    const id = decodeSegment(parts[2]);
    return type && id ? { kind: 'meta', addonSlug: slug, type, id } : null;
  }
  return null;
}
