/* Chargement des données des espaces Plateforme et Système. Même contrat que `ctx.fetch` de admin.js (`{ status, value, error }`
 * rangé sous une clé de `ctx.S`, `quiet` garde l'affichage pendant l'actualisation, une réponse périmée est ignorée), mais sans
 * toucher à la table d'état de admin.js : chaque espace ajoute ses clés ici. */
import { adminErr } from './common.js';

const tokens = new Map();

/** Charge `fn()` dans `ctx.S[key]`, puis redessine la section si elle est encore affichée. Renvoie une promesse (jamais rejetée). */
export async function loadInto(ctx, key, fn, quiet = false) {
  const token = (tokens.get(key) || 0) + 1;
  tokens.set(key, token);
  const current = ctx.S[key];
  if (!quiet || !current || current.status !== 'ready') {
    ctx.S[key] = { status: 'loading', value: null, error: '' };
    if (ctx.isCurrent()) ctx.paint();
  }
  try {
    const value = await fn();
    if (token !== tokens.get(key)) return;
    ctx.S[key] = { status: 'ready', value, error: '' };
  } catch (err) {
    if (token !== tokens.get(key)) return;
    ctx.S[key] = { status: 'error', value: null, error: adminErr(err) };
  }
  if (ctx.isCurrent()) ctx.paint();
}
