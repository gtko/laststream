/*
 * Adresses d'images acceptées dans l'interface (billets de parrainage, arrivée du foyer) : https seulement, et seulement chez
 * les hébergeurs connus (affiches TMDB, fonds fanart.tv) ou sur le serveur de l'app. Une autre adresse donne '' : l'écran
 * affiche alors son repli (dégradé, initiale), jamais une image inventée. Les images viennent de sites tiers : ne pas élargir.
 */
import { shareBase } from './shareBase';

/**
 * Hôtes d'images tiers autorisés, en https : exactement la liste du serveur (lastaddon `image-hosts.ts`) : affiches TMDB,
 * fonds fanart.tv, affiches des métadonnées Stremio (metahub).
 */
export const IMAGE_HOSTS: readonly string[] = [
  'image.tmdb.org',
  'assets.fanart.tv',
  'images.metahub.space',
  'episodes.metahub.space',
  'live.metahub.space',
];

/** Forme générale : https, sans espace, guillemet, chevron ni antislash (la valeur finit dans un attribut HTML). */
const HTTPS_SHAPE = /^https:\/\/[^\s"'<>\\]+$/;

/** Origine https du serveur de l'app (là où vivent ses liens et ses images), '' sinon. */
export function serverImageOrigin(): string {
  try {
    const url = new URL(shareBase());
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

/**
 * `value` si c'est une adresse https d'un hôte autorisé (`IMAGE_HOSTS`, ou l'origine `server` du serveur de l'app), sinon ''.
 * La comparaison porte sur l'origine : un port, un identifiant (`https://image.tmdb.org@autre…`) ou un sous-domaine
 * inconnu fait échouer la règle.
 */
export function safeImageUrl(value: unknown, server: string = serverImageOrigin()): string {
  if (typeof value !== 'string' || !HTTPS_SHAPE.test(value)) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  // Pas d'identifiants dans l'adresse (le serveur les refuse aussi).
  if (url.username !== '' || url.password !== '') return '';
  const origin = url.origin;
  const hosted = IMAGE_HOSTS.some((host) => origin === 'https://' + host);
  return hosted || (server !== '' && origin === server) ? value : '';
}
