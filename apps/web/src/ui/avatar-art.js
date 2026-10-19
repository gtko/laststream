/*
 * Rendu des avatars illustrés. DiceBear : SVG généré localement, aucune requête réseau ; le code DiceBear et les styles
 * sont chargés à la demande (import dynamique) : l'accueil n'est pas alourdi. Collections (col:<col>:<char>) : vignette
 * WebP servie par lastAddon, posée en <img> sur la couleur du profil. Repli : l'initiale sur la couleur du profil reste
 * affichée tant que l'illustration n'est pas prête (ou si elle échoue).
 */
import { AVATAR_BACKGROUNDS, parseAvatar, parseColAvatar, parseHero } from '../data/avatars';
import { avatarImageUrl } from '../data/avatar-catalog';
import { heroDataUri } from '../data/heroes/render';

/** Avatars déjà générés : valeur « dicebear:style:graine » -> URI data: du SVG. */
const cache = new Map();
let corePromise = null;
let collectionPromise = null;

const camel = (id) => id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
const loadCore = () => corePromise || (corePromise = import('@dicebear/core'));
const loadCollection = () => collectionPromise || (collectionPromise = import('@dicebear/collection/async'));

/**
 * Échelle de la figure dans son cadre : plusieurs styles débordent de leur viewBox (corps, cheveux, oreilles), ce qui les
 * rognait dans la tuile. À 70 %, la figure entière reste visible avec une marge, centrée (DiceBear garde le centrage).
 */
export const AVATAR_SCALE = 70;

/** Le SVG occupe toute la tuile (width/height 100 %) ; le viewBox garde les proportions. */
export const fitSvg = (svg) => svg.replace(/<svg\b([^>]*)>/, (_m, attrs) => '<svg' + attrs.replace(/\s(?:width|height)="[^"]*"/g, '') + ' width="100%" height="100%">');

/** SVG de l'avatar en URI data:, ou '' si la valeur est invalide / non autorisée / non générable. Mis en cache. */
export async function avatarUri(value) {
  const hero = heroUri(value);
  if (hero) return hero;
  const parsed = parseAvatar(value);
  if (!parsed) return '';
  const hit = cache.get(value);
  if (hit) return hit;
  try {
    const [core, coll] = await Promise.all([loadCore(), loadCollection()]);
    const loader = coll[camel(parsed.style.id)];
    if (typeof loader !== 'function') return '';
    const style = await loader();
    const svg = fitSvg(core.createAvatar(style, { seed: parsed.seed, backgroundColor: [...AVATAR_BACKGROUNDS], scale: AVATAR_SCALE }).toString());
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    cache.set(value, uri);
    return uri;
  } catch {
    return '';
  }
}

/** Avatar « Héros » (hero:<famille>:<graine>) : dessiné tout de suite, en local, sans chargement ; '' si ce n'est pas un Héros. */
function heroUri(value) {
  const hit = cache.get(value);
  if (hit) return hit;
  const hero = parseHero(value);
  if (!hero) return '';
  const uri = heroDataUri(hero.family, hero.seed);
  cache.set(value, uri);
  return uri;
}

/** URI déjà en cache (rendu synchrone), sinon '' ; les Héros sont générés à la volée. */
export const cachedAvatarUri = (value) => heroUri(value) || cache.get(value) || '';

/** Vide le cache (tests). */
export const resetAvatarCache = () => cache.clear();

const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Attributs HTML d'un élément avatar : couleur de repli, et illustration si elle est déjà en cache. À placer dans la balise :
 * `<span class="pf-av"` + avatarAttrs(avatar, color) + `>`. Les éléments sans cache sont complétés par hydrateAvatars().
 * Un avatar « collection » n'a jamais d'illustration en cache : son <img> est ajouté par hydrateAvatars().
 */
export function avatarAttrs(avatar, color) {
  const bg = 'background:' + attrEsc(color || '#94a3b8');
  if (parseColAvatar(avatar)) return ' data-avatar="' + attrEsc(avatar) + '" style="' + bg + '"';
  if (!parseAvatar(avatar) && !parseHero(avatar)) return ' style="' + bg + '"';
  const uri = cachedAvatarUri(avatar);
  return ' data-avatar="' + attrEsc(avatar) + '"' + (uri ? ' data-art="1"' : '') +
    ' style="' + bg + (uri ? ';background-image:url(&quot;' + attrEsc(uri) + '&quot;)' : '') + '"';
}

/**
 * Pose la vignette d'une collection dans l'élément, sur sa couleur de fond. Pendant le chargement, l'initiale reste visible
 * (data-art-pending) ; à l'échec, l'<img> est retiré et l'élément garde l'initiale (data-art-failed, sans nouvelle tentative
 * automatique). Sans adresse lastAddon, rien n'est posé.
 */
function attachColArt(node, value) {
  const col = parseColAvatar(value);
  const src = col ? avatarImageUrl(col.colId, col.charId) : '';
  if (!src || !node.isConnected) return;
  const img = document.createElement('img');
  img.setAttribute('alt', '');
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;';
  if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
  img.addEventListener('load', () => {
    delete node.dataset.artPending;
    node.dataset.art = '1';
  });
  img.addEventListener('error', () => {
    img.remove();
    delete node.dataset.artPending;
    delete node.dataset.art;
    node.dataset.artFailed = '1';
  });
  node.dataset.artPending = '1';
  node.append(img);
  img.src = src;
}

/** Complète les éléments [data-avatar] d'un conteneur dont l'illustration n'est pas encore posée. */
export async function hydrateAvatars(root = document) {
  const nodes = Array.from(root.querySelectorAll('[data-avatar]:not([data-art]):not([data-art-pending]):not([data-art-failed])'));
  await Promise.all(nodes.map(async (node) => {
    if (parseColAvatar(node.dataset.avatar)) {
      attachColArt(node, node.dataset.avatar);
      return;
    }
    const uri = await avatarUri(node.dataset.avatar);
    if (!uri || !node.isConnected) return;
    node.style.backgroundImage = 'url("' + uri + '")';
    node.dataset.art = '1';
  }));
}

// Tout élément [data-avatar] ajouté à la page (écran des profils, barre, amis, salon) reçoit son illustration.
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    const run = () => { pending = false; void hydrateAvatars(document); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 0);
  };
  const start = () => new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
}
