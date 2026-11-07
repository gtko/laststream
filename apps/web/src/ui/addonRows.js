/* Rangées « catalogues d'addon » de l'accueil (ODY-252) et conversion des fiches d'addon en titres d'affichage.
 * Une rangée par catalogue affiché sur l'accueil (catalogDisplay === 'home') d'un addon du registre dont l'accueil est activé.
 * Aucun addon activé : aucune rangée. Lecture depuis l'appareil (fetchCatalogPage). Une rangée vide ou en erreur est masquée
 * sans message. Module sans DOM (hors écriture de l'aperçu en sessionStorage). */
import { catalogDisplay, fetchCatalogPage, readAddonCatalogs } from '../data/addonCatalog';
import { addonCatalogHash, addonMetaHash, addonSlug } from './addonRoutes.js';

const enc = encodeURIComponent;

/** Préfixe des aperçus de fiche gardés en sessionStorage (`<préfixe><slug>:<type>:<id>`, slug de l'addon : voir `addonSlug`). */
const ADDON_PREVIEW_PREFIX = 'laststream.addonMetaPreview:';
/** Clé sessionStorage de l'aperçu d'une fiche, propre à l'addon : un autre addon au même type et id ne le reprend pas. */
export const addonPreviewKey = (slug, type, id) => ADDON_PREVIEW_PREFIX + slug + ':' + type + ':' + id;

const TYPE_LABELS = new Map([['movie', 'Film'], ['series', 'Série'], ['tv', 'Série'], ['channel', 'Chaîne']]);
/** Libellé français d'un type de catalogue d'addon (le type brut sinon). */
export const addonTypeLabel = (type) => TYPE_LABELS.get(type) ?? type;

/** Adresse d'image gardée seulement si elle est http(s). */
const safeImage = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : '');
const yearOf = (v) => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const m = /\d{4}/.exec(s);
  return m ? m[0] : '';
};

/** Champs d'une fiche gardés pour l'affichage (texte court, nombres, listes de textes) : le reste est écarté. */
export function previewOf(meta) {
  const out = {};
  for (const k of ['id', 'name', 'type', 'poster', 'background', 'logo', 'description', 'releaseInfo', 'runtime', 'imdbRating', 'genres', 'director', 'cast']) {
    const v = meta[k];
    if (typeof v === 'string') out[k] = v.slice(0, k === 'description' ? 1000 : 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'string').slice(0, 30).map((x) => x.slice(0, 120));
      if (list.length) out[k] = list;
    }
  }
  for (const k of ['poster', 'background', 'logo']) if (k in out) out[k] = safeImage(out[k]);
  return out;
}

/** Titre d'affichage d'une fiche d'addon : clé stable, lien vers la fiche, aperçu. Aucune adresse d'addon n'y figure. */
export function addonItemOf(meta, addonKey, type) {
  const genres = Array.isArray(meta.genres) ? meta.genres.filter((g) => typeof g === 'string') : [];
  return {
    key: `addon:${addonSlug(addonKey)}:${enc(type)}:${enc(meta.id)}`,
    slug: addonSlug(addonKey),
    id: meta.id,
    type,
    name: meta.name,
    poster: safeImage(meta.poster),
    backdrop: safeImage(meta.background),
    year: yearOf(meta.releaseInfo ?? meta.year),
    genre: genres[0] || '',
    genreIds: [],
    originCountry: [],
    href: addonMetaHash(addonKey, type, meta.id),
    preview: previewOf(meta),
  };
}

/** Garde l'aperçu d'une fiche pour que la page de fiche l'affiche sans attendre. Stockage indisponible : rien. */
export function rememberMetaPreview(item) {
  try {
    globalThis.sessionStorage?.setItem(addonPreviewKey(item.slug, item.type, item.id), JSON.stringify(item.preview));
  } catch {
    // Stockage plein ou bloqué : la fiche se chargera sans aperçu.
  }
}

/** Identifiant de rangée d'accueil d'un catalogue d'addon (sans caractère d'espacement ni guillemet dans l'attribut `id`). */
export function addonRowId(addonKey, type, catId) {
  return `addon:${addonSlug(addonKey)}:${enc(type)}:${enc(catId)}`;
}

/** Rangées d'accueil des catalogues d'addon : une par catalogue `home` d'un addon du registre. [] si aucun. */
export function addonHomeRows() {
  const rows = [];
  for (const [addonKey, entry] of Object.entries(readAddonCatalogs())) {
    if (!entry.home) continue;
    for (const cat of entry.catalogs) {
      if (catalogDisplay(cat) !== 'home') continue;
      rows.push({
        id: addonRowId(addonKey, cat.type, cat.id),
        title: `${cat.name} · ${entry.name}`,
        kind: 'poster',
        fetch: { k: 'addon', addonKey, type: cat.type, catId: cat.id },
        minItems: 1,
        browseHref: addonCatalogHash(addonKey, cat.type, cat.id),
      });
    }
  }
  return rows;
}

/**
 * Première page d'une rangée d'addon. Null si l'addon ou le catalogue n'est plus dans le registre, si le catalogue n'est pas
 * affiché sur l'accueil, s'il est vide ou en erreur (rangée masquée). Les pages suivantes sont vides : la rangée n'en lit qu'une.
 * `http` est injectable pour les tests ; par défaut, le transport de l'appareil.
 */
export async function resolveAddonRow(def, page = 1, http) {
  if (page > 1) return { title: def.title, raw: 0, items: [] };
  const { addonKey, type, catId } = def.fetch;
  const entry = readAddonCatalogs()[addonKey];
  const cat = entry ? entry.catalogs.find((c) => c.type === type && c.id === catId) : undefined;
  if (!entry || !cat || catalogDisplay(cat) !== 'home') return null;
  const res = await fetchCatalogPage(entry, cat, {}, http);
  if (res.error || !res.metas.length) return null;
  return { title: def.title, raw: res.metas.length, items: res.metas.map((m) => addonItemOf(m, addonKey, type)) };
}
