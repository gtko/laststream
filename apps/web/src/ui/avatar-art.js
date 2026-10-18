/*
 * Rendu des avatars illustrés (DiceBear, SVG généré localement, aucune requête réseau). Le code DiceBear et les styles
 * sont chargés à la demande (import dynamique) : l'accueil n'est pas alourdi. Repli : l'initiale sur la couleur du
 * profil reste affichée tant que l'illustration n'est pas prête (ou si elle échoue).
 */
import { AVATAR_BACKGROUNDS, parseAvatar } from '../data/avatars';

/** Avatars déjà générés : valeur « dicebear:style:graine » -> URI data: du SVG. */
const cache = new Map();
let corePromise = null;
let collectionPromise = null;

const camel = (id) => id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
const loadCore = () => corePromise || (corePromise = import('@dicebear/core'));
const loadCollection = () => collectionPromise || (collectionPromise = import('@dicebear/collection/async'));

/** SVG de l'avatar en URI data:, ou '' si la valeur est invalide / non autorisée / non générable. Mis en cache. */
export async function avatarUri(value) {
  const parsed = parseAvatar(value);
  if (!parsed) return '';
  const hit = cache.get(value);
  if (hit) return hit;
  try {
    const [core, coll] = await Promise.all([loadCore(), loadCollection()]);
    const loader = coll[camel(parsed.style.id)];
    if (typeof loader !== 'function') return '';
    const style = await loader();
    const svg = core.createAvatar(style, { seed: parsed.seed, backgroundColor: [...AVATAR_BACKGROUNDS], size: 128 }).toString();
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    cache.set(value, uri);
    return uri;
  } catch {
    return '';
  }
}

/** URI déjà en cache (rendu synchrone), sinon ''. */
export const cachedAvatarUri = (value) => cache.get(value) || '';

/** Vide le cache (tests). */
export const resetAvatarCache = () => cache.clear();

const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Attributs HTML d'un élément avatar : couleur de repli, et illustration si elle est déjà en cache. À placer dans la balise :
 * `<span class="pf-av"` + avatarAttrs(avatar, color) + `>`. Les éléments sans cache sont complétés par hydrateAvatars().
 */
export function avatarAttrs(avatar, color) {
  const bg = 'background:' + attrEsc(color || '#94a3b8');
  const parsed = parseAvatar(avatar);
  if (!parsed) return ' style="' + bg + '"';
  const uri = cachedAvatarUri(avatar);
  return ' data-avatar="' + attrEsc(avatar) + '"' + (uri ? ' data-art="1"' : '') +
    ' style="' + bg + (uri ? ';background-image:url(&quot;' + attrEsc(uri) + '&quot;)' : '') + '"';
}

/** Complète les éléments [data-avatar] d'un conteneur dont l'illustration n'est pas encore posée. */
export async function hydrateAvatars(root = document) {
  const nodes = Array.from(root.querySelectorAll('[data-avatar]:not([data-art])'));
  await Promise.all(nodes.map(async (node) => {
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
