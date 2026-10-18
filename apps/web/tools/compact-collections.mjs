#!/usr/bin/env node
/* Compacte le catalogue de collections de Focale (MIT, © 2026 Shika34) pour l'application :
 *   node tools/compact-collections.mjs <nuvio-collections-fr.json> [sortie]
 * Ne garde que les sources TMDB (les sources `trakt` et `addon` sont ignorées : pas de clé Trakt, aucun addon tiers),
 * retire les champs inutiles (identifiants de sources, valeurs nulles) et masque les dossiers sans source TMDB.
 * La sortie (src/data/collections/focale.json) est chargée à la demande par import dynamique. */
import fs from 'node:fs';
import path from 'node:path';

const [input, output = 'src/data/collections/focale.json'] = process.argv.slice(2);
if (!input) { console.error('usage : node tools/compact-collections.mjs <entrée.json> [sortie.json]'); process.exit(1); }

// Dossiers de « Découvrir » dont les sources sont Trakt/addon : on garde leur visuel (marqués `hidden`, absents des
// collections) pour que la page Découvrir les remplace par une requête TMDB (« Meilleures séries ») ou par nos recommandations.
const KEEP_ART = new Set(['folder-25429024', 'folder-XUX2DKEX']);
const KINDS = new Set(['DISCOVER', 'LIST', 'COLLECTION', 'COMPANY']);
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const out = { source: 'Focale (MIT, © 2026 Shika34) et Kaptain', categories: [] };
let folders = 0; let sources = 0; let dropped = 0;

for (const col of raw) {
  const cat = { id: col.id, title: col.title, folders: [] };
  for (const f of col.folders || []) {
    const srcs = [];
    for (const s of f.sources || []) {
      if (s.provider !== 'tmdb' || !KINDS.has(s.tmdbSourceType)) { dropped += 1; continue; }
      const filters = {};
      for (const [k, v] of Object.entries(s.filters || {})) if (v !== null && v !== '' && v !== undefined) filters[k] = v;
      const src = { kind: s.tmdbSourceType, media: s.mediaType === 'TV' ? 'tv' : 'movie' };
      if (s.title || s.name) src.name = s.title || s.name;
      if (s.sortBy) src.sort = s.sortBy;
      if (s.tmdbId) src.id = s.tmdbId;
      if (Object.keys(filters).length) src.filters = filters;
      srcs.push(src);
    }
    const artOnly = !srcs.length && KEEP_ART.has(f.id);
    if (!srcs.length && !artOnly) continue;
    const folder = { id: f.id, title: f.title };
    if (artOnly) folder.hidden = true;
    if (f.coverImageUrl) folder.cover = f.coverImageUrl;
    if (f.focusGifUrl && f.focusGifEnabled !== false) folder.gif = f.focusGifUrl;
    if (f.titleLogoUrl) folder.logo = f.titleLogoUrl;
    if (f.heroBackdropUrl) folder.hero = f.heroBackdropUrl;
    folder.sources = srcs;
    cat.folders.push(folder);
    if (!artOnly) { folders += 1; sources += srcs.length; }
  }
  if (cat.folders.length) out.categories.push(cat);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(out));
console.log(`${out.categories.length} catégories, ${folders} dossiers, ${sources} sources TMDB (${dropped} sources trakt/addon ignorées) -> ${output} (${(fs.statSync(output).size / 1024).toFixed(0)} Ko)`);
