/* Classement des résultats de recherche TMDB (search/multi). Fonctions pures, sans DOM ni réseau.
 * Score d'un titre = correspondance du titre (exacte 100, préfixe 60, tous les mots 35, contient 20)
 * + popularité + votes, pénalité si très peu de votes, léger bonus pour une sortie récente.
 * Les personnes sont classées à part (correspondance + popularité), après les titres. */

const DAY_MS = 86400000;

/** Forme comparable d'un titre : minuscules, sans accents, sans ponctuation, espaces simples. */
export function normTitle(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Type d'un résultat : 'movie', 'tv', 'person' ou '' (inconnu). */
export function kindOf(r) {
  if (!r) return '';
  if (r.media_type === 'movie' || r.media_type === 'tv' || r.media_type === 'person') return r.media_type;
  if (r.media_type) return '';
  return r.title !== undefined ? 'movie' : r.name !== undefined ? 'tv' : '';
}

/** Clé d'unicité d'un résultat : type + identifiant TMDB. */
export const resultKey = (r) => kindOf(r) + ':' + (r ? r.id : '');

/** Correspondance du titre (titre et titre original) : 100 exact, 60 préfixe, 35 tous les mots, 20 contient, 0 sinon. */
export function titleMatch(r, query) {
  const q = normTitle(query);
  if (!q || !r) return 0;
  const qWords = q.split(' ');
  const titles = [r.title != null ? r.title : r.name, r.original_title != null ? r.original_title : r.original_name]
    .map(normTitle)
    .filter(Boolean);
  let best = 0;
  for (const t of titles) {
    let s = 0;
    if (t === q) s = 100;
    else if (t.startsWith(q)) s = 60;
    else if (qWords.every((w) => t.split(' ').includes(w))) s = 35;
    else if (t.includes(q)) s = 20;
    if (s > best) best = s;
  }
  return best;
}

/** Score d'un résultat ; `today` au format AAAA-MM-JJ. */
export function scoreResult(r, query, today) {
  const kind = kindOf(r);
  const pop = Number(r.popularity) || 0;
  const match = titleMatch(r, query);
  if (kind === 'person') return match + 12 * Math.log10(1 + pop);
  const votes = Number(r.vote_count) || 0;
  let s = match + 12 * Math.log10(1 + pop) + 6 * Math.log10(1 + votes);
  if (votes < 5) s -= 25;
  const date = String(r.release_date || r.first_air_date || '').slice(0, 10);
  if (date) {
    const ageDays = (Date.parse(today) - Date.parse(date)) / DAY_MS;
    if (ageDays >= 0 && ageDays < 730) s += 3;
  }
  return s;
}

/**
 * Classe les résultats : titres (films et séries) d'abord, puis personnes, chacun par score décroissant.
 * Dédoublonnage par type + id (la première occurrence est gardée). À score égal, l'ordre TMDB est conservé.
 * Ne filtre pas l'affiche, la date ni le profil enfant : c'est le rôle de filterResults dans search.js.
 * @param {object[]} results  résultats bruts de search/multi
 * @param {string} query      requête saisie
 * @param {{today?: string}} [opts]  date de référence (AAAA-MM-JJ), défaut : aujourd'hui (UTC)
 * @returns {object[]} les mêmes objets, réordonnés
 */
export function rankResults(results, query, opts) {
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const media = [];
  const people = [];
  let idx = 0;
  for (const r of results || []) {
    const kind = kindOf(r);
    if (!kind || r.id == null) continue;
    const key = resultKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { r, s: scoreResult(r, query, today), i: idx++ };
    (kind === 'person' ? people : media).push(entry);
  }
  const byScore = (a, b) => (b.s - a.s) || (a.i - b.i);
  return [...media.sort(byScore), ...people.sort(byScore)].map((e) => e.r);
}
