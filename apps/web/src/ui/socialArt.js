/* Images d'un titre pour les cartes du chat (ODY-244) : un message de partage ne porte pas toujours d'image (anciens
 * messages, appareil sans affiche). On retrouve alors l'affiche et le fond du titre par son identifiant TMDB, avec un cache
 * mémoire et un cache local (les chemins d'images changent peu). Aucun appel ne lève : sans image, la carte garde son repli. */
import { tmdb } from '../data/lt';

const KEY = 'ls:social-art:v1';
const MAX_ENTRIES = 300;
const PATH = /^\/[\w-]+\.(?:jpe?g|png|webp)$/i;

const mem = new Map();
const pending = new Map();
const failed = new Set();
let loaded = false;

const kindOf = (t) => (t === 'series' || t === 'tv' ? 'tv' : 'movie');
const keyOf = (type, id) => kindOf(type) + ':' + id;
const pathOf = (p) => (typeof p === 'string' && PATH.test(p) ? p : '');

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object') mem.set(k, { poster: pathOf(v.poster), backdrop: pathOf(v.backdrop) });
      }
    }
  } catch { /* cache illisible : on repart de zéro */ }
}

function save() {
  try {
    const entries = [...mem.entries()].slice(-MAX_ENTRIES);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* stockage plein ou indisponible */ }
}

/** Images déjà connues d'un titre (cache), sans réseau : { poster, backdrop } (chemins TMDB, '' si inconnu) ou null. */
export function cachedArt(type, tmdbId) {
  load();
  return mem.get(keyOf(type, tmdbId)) || null;
}

/**
 * Retrouve l'affiche et le fond d'un titre. Toujours résolu : { poster, backdrop } (chemins TMDB, '' si introuvable).
 * Un échec réseau n'est pas mis en cache durablement (seulement pour la session, pour ne pas insister).
 */
export function resolveArt(type, tmdbId) {
  const id = Number(tmdbId);
  const none = { poster: '', backdrop: '' };
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(none);
  const k = keyOf(type, id);
  const hit = cachedArt(type, id);
  if (hit) return Promise.resolve(hit);
  if (failed.has(k)) return Promise.resolve(none);
  if (pending.has(k)) return pending.get(k);
  const p = Promise.resolve()
    .then(() => tmdb(kindOf(type) + '/' + id))
    .then((raw) => {
      const art = { poster: pathOf(raw && raw.poster_path), backdrop: pathOf(raw && raw.backdrop_path) };
      if (art.poster || art.backdrop) {
        mem.set(k, art);
        save();
      } else {
        failed.add(k);
      }
      return art;
    })
    .catch(() => {
      failed.add(k);
      return none;
    })
    .finally(() => { pending.delete(k); });
  pending.set(k, p);
  return p;
}

/** Remet les caches à zéro (tests). */
export function resetArt() {
  mem.clear();
  pending.clear();
  failed.clear();
  loaded = false;
  try { localStorage.removeItem(KEY); } catch { /* sans effet */ }
}
