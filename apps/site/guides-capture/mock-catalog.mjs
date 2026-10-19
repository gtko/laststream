// Catalogue factice des captures : titres inventés en français, affiches et fonds = images du site
// (guides-capture/posters, copie des anciennes affiches du site). Servi uniquement par page.route() dans le navigateur de test : aucun appel TMDB,
// aucune clé, aucune image tierce. Les formes de réponse suivent celles lues par l'app (ui/catalog.js,
// ui/registry.js, data/rows.ts, lastAddon src/lt/top10.ts).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const POSTERS = resolve(here, 'posters'); // copie locale : les affiches ont quitté public/assets
const THEMES = new Set(['anime', 'famille', 'fantasy', 'horreur', 'noir', 'ocean', 'scifi', 'western']);
const imageCache = new Map();

/** Image du site pour un chemin TMDB factice (`/<thème>-<id>.jpg` ou `/<thème>-<id>-fond.jpg`). */
export function posterBuffer(pathname) {
  const name = pathname.split('/').pop() || '';
  const theme = name.split('-')[0];
  const file = THEMES.has(theme) ? theme : 'noir';
  if (!imageCache.has(file)) imageCache.set(file, readFileSync(join(POSTERS, `${file}-800.webp`)));
  return imageCache.get(file);
}

const GENRE_NAME = {
  12: 'Aventure', 14: 'Fantastique', 16: 'Animation', 18: 'Drame', 27: 'Horreur', 35: 'Comédie', 37: 'Western',
  53: 'Thriller', 80: 'Crime', 878: 'Science-Fiction', 9648: 'Mystère', 10749: 'Romance', 10751: 'Familial',
  10759: 'Action & Aventure', 10762: 'Jeunesse', 10765: 'Sci-Fi & Fantastique',
};
const CERT_AGE = { U: 0, 10: 10, 12: 12, 16: 16, 18: 18 };
const ALWAYS_EMPTY = ['with_companies', 'with_networks', 'with_keywords', 'with_watch_providers', 'with_type', 'with_status'];

// [id, titre, thème d'affiche, genres, classification FR, date de sortie, minutes, note, votes, synopsis]
// Règle des captures : fantasy, horreur, noir et western sont classés 16+ (hors profil enfant de 12 ans) ; les titres
// visibles par un enfant ont une affiche famille, anime ou ocean.
const MOVIE_ROWS = [
  [1001, 'Les Gardiens du phare', 'ocean', [12, 14], '12', '2025-03-14', 118, 7.6, 1840, 'Sur une île battue par les tempêtes, deux gardiens découvrent que le phare veille sur bien plus qu’une côte.'],
  [1002, 'Nuit polaire', 'noir', [53, 80], '16', '2024-11-06', 104, 7.1, 980, 'Isolée dans une station arctique, une enquêtrice doit découvrir qui a éteint les lumières.'],
  [1003, 'Le Dernier Cartographe', 'fantasy', [14, 12], '16', '2025-05-21', 131, 7.9, 2310, 'Un cartographe part dessiner une terre qui disparaît chaque nuit sur ses propres cartes.'],
  [1004, 'Rivages de cendre', 'horreur', [27, 9648], '18', '2025-10-02', 96, 6.9, 1210, 'Dans un village côtier, les habitants refusent de quitter la plage après la tombée de la nuit.'],
  [1005, 'L’Écho du désert', 'western', [37, 18], '16', '2024-09-18', 122, 7.3, 760, 'Vingt ans après une fusillade, un fils retrouve la trace de l’homme qui a tué son père.'],
  [1006, 'Le Chant des marées', 'ocean', [18, 10749], '12', '2025-06-11', 109, 7.0, 640, 'Une chanteuse de port et un pêcheur taciturne se retrouvent à bord du même navire pour une dernière saison.'],
  [1007, 'Horizon vert', 'scifi', [878, 12], '12', '2025-02-12', 112, 7.4, 1530, 'Sur une planète lointaine, une colonie tente de faire pousser une forêt sous un ciel couleur d’ambre.'],
  [1008, 'Les Clés de Sélène', 'fantasy', [14, 10751], '16', '2024-12-18', 99, 7.2, 720, 'Trois enfants trouvent un trousseau capable d’ouvrir les portes entre les mondes.'],
  [1009, 'Petit Renard et la forêt', 'famille', [16, 10751], 'U', '2024-10-23', 82, 7.8, 620, 'Petit Renard quitte son terrier pour ramener une graine magique avant le premier hiver.'],
  [1010, 'Kiko et le dragon de papier', 'anime', [16, 12], 'U', '2025-04-09', 90, 8.0, 890, 'Kiko plie un dragon de papier qui prend vie et l’emmène à travers les nuages.'],
  [1011, 'Les Aventuriers de la lune', 'famille', [10751, 12], '10', '2025-07-02', 97, 7.0, 540, 'Quatre amis construisent une fusée en carton pour rejoindre leur grand-père sur la Lune.'],
  [1012, 'Mini Pirates', 'ocean', [16, 10751], 'U', '2025-01-15', 78, 6.9, 430, 'Un équipage de souris part à la recherche d’un trésor englouti au fond d’une baignoire.'],
  [1013, 'Le Bâtisseur d’étoiles', 'anime', [16, 878], '10', '2024-08-21', 104, 7.5, 510, 'Un jeune mécanicien conçoit un télescope capable de capter les voix des planètes.'],
  [1014, 'Lou et la baleine bleue', 'ocean', [16, 10751], 'U', '2025-03-28', 84, 7.2, 380, 'Lou aide une baleine égarée à retrouver le chant de sa famille.'],
  [1015, 'Pépite et le dragon', 'fantasy', [16, 14], '16', '2024-12-04', 92, 7.1, 470, 'Une petite fille apprivoise un dragon qui n’a jamais su voler.'],
  [1016, 'Zoé et les robots', 'famille', [16, 878], '10', '2025-09-10', 86, 6.8, 360, 'Zoé répare les robots abandonnés de sa ville et découvre qu’ils cachent un secret.'],
  [1017, 'Le Carnet magique de Nina', 'famille', [10751, 14], 'U', '2025-05-07', 88, 7.0, 300, 'Chaque page du carnet de Nina change le monde autour d’elle, mais jamais dans le bon sens.'],
  [1018, 'Pili le petit cheval', 'western', [10751, 37], '16', '2024-07-03', 79, 6.7, 260, 'Pili rêve de galoper jusqu’à la mer, malgré les conseils prudents du troupeau.'],
  [1019, 'La Maison des brumes', 'horreur', [27], '16', '2025-08-30', 101, 6.6, 890, 'Une famille emménage dans une maison dont les fenêtres ne donnent jamais sur le même paysage.'],
  [1020, 'Le Silence du marché', 'noir', [80, 18], '16', '2024-10-09', 110, 7.2, 1100, 'Un commissaire enquête sur une série de disparitions dans un marché couvert de Lyon.'],
  [1021, 'Le Jardin des lucioles', 'famille', [16, 10751], 'U', '2025-04-02', 81, 7.3, 410, 'Une fillette découvre que les lucioles du jardin racontent l’histoire de la ville.'],
  [1022, 'Tom et la cabane sur la falaise', 'famille', [10751, 35], 'U', '2024-12-25', 90, 6.9, 330, 'Tom héberge sa cousine dans une cabane perchée, et l’été devient une suite d’aventures.'],
  [1023, 'La Course des cerfs-volants', 'famille', [10751, 12], '10', '2025-06-25', 95, 6.8, 290, 'Un concours de cerfs-volants oppose deux villages voisins sur une colline venteuse.'],
];

// [id, nom, thème, genres, classification FR, date de première diffusion, saisons, minutes par épisode, note, votes, pays, synopsis]
const SERIES_ROWS = [
  [2001, 'La Côte des Murmures', 'ocean', [18, 10765], '12', '2024-04-03', 3, 48, 8.1, 1700, 'FR', 'Dans un port breton, une enquête sur un naufrage réveille les secrets de quatre familles.'],
  [2002, 'Station Orion', 'scifi', [10765], '12', '2025-01-17', 2, 52, 7.9, 2200, 'US', 'Les équipiers d’une station spatiale découvrent un signal venu de l’intérieur de leur propre base.'],
  [2003, 'Le Visionnaire', 'fantasy', [10759, 10765], '16', '2023-10-09', 4, 55, 8.3, 3100, 'US', 'Un peintre qui voit l’avenir tente de changer le destin d’un royaume en guerre.'],
  [2004, 'Les Ombres de Brume', 'horreur', [9648, 18], '16', '2025-06-12', 1, 44, 7.5, 1200, 'FR', 'Dans une vallée sans route, les habitants disparaissent un par un à l’aube.'],
  [2005, 'Ruelles de Lyon', 'noir', [80, 18], '16', '2024-02-19', 2, 50, 7.7, 980, 'FR', 'Une avocate et un ancien policier reprennent une affaire classée dans les traboules.'],
  [2006, 'Le Ranch des Sept Vents', 'western', [37, 18], '16', '2022-08-30', 5, 50, 7.6, 1400, 'US', 'Une famille d’éleveurs lutte pour garder ses terres face à un promoteur sans scrupules.'],
  [2007, 'Les Petits Explorateurs', 'famille', [10762, 16], 'U', '2023-05-01', 3, 22, 7.4, 320, 'FR', 'Quatre enfants partent cartographier le jardin de leur école, qui cache des animaux étonnants.'],
  [2008, 'Pirates de l’île Corail', 'ocean', [10762, 16], '10', '2024-07-14', 2, 24, 7.2, 280, 'FR', 'Une bande de jeunes marins protège les récifs d’une île où vivent des tortues géantes.'],
  [2009, 'Le Club des Racines', 'anime', [16, 10762], 'U', '2025-03-03', 1, 20, 7.0, 210, 'JP', 'Au pied d’un vieil arbre, un club d’enfants apprend à parler aux plantes.'],
  [2010, 'Kanata, apprentie magicienne', 'anime', [16, 10765], '10', '2024-09-28', 2, 23, 8.0, 450, 'JP', 'Kanata découvre une école de magie cachée sous la bibliothèque municipale.'],
];

const MOVIES = MOVIE_ROWS.map(([id, title, theme, genres, cert, date, runtime, vote, votes, overview]) => ({
  id, type: 'movie', title, theme, genres, cert, date, runtime, vote, votes, overview, origin: 'FR',
}));
const SERIES = SERIES_ROWS.map(([id, name, theme, genres, cert, date, seasons, runtime, vote, votes, origin, overview]) => ({
  id, type: 'tv', title: name, theme, genres, cert, date, seasons, runtime, vote, votes, origin, overview,
}));
const find = (type, id) => (type === 'movie' ? MOVIES : SERIES).find((it) => it.id === Number(id));

// Identifiant IMDb factice (tt…) : c'est lui qui sert à chercher les sources (flux Stremio `tt…`). Seul le film 1001
// en a un, pour le guide « Ajouter une source » ; les autres titres restent sans identifiant IMDb, comme avant.
const IMDB_IDS = { 'movie:1001': 'tt9001001' };
const imdbOf = (it) => IMDB_IDS[`${it.type}:${it.id}`] ?? null;

const interleave = (a, b) => {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
};

const poster = (it) => `/${it.theme}-${it.id}.jpg`;
const fond = (it) => `/${it.theme}-${it.id}-fond.jpg`;

function toList(it) {
  const common = {
    id: it.id,
    media_type: it.type,
    genre_ids: it.genres,
    overview: it.overview,
    poster_path: poster(it),
    backdrop_path: fond(it),
    vote_average: it.vote,
    vote_count: it.votes,
    popularity: Math.round(it.votes / 20),
    original_language: 'fr',
  };
  if (it.type === 'movie') return { ...common, title: it.title, original_title: it.title, release_date: it.date };
  return { ...common, name: it.title, original_name: it.title, first_air_date: it.date, origin_country: [it.origin] };
}

const trailer = (it) => ({
  id: `trailer-${it.type}-${it.id}`,
  key: `mock${it.type}${it.id}`,
  name: 'Bande-annonce',
  site: 'YouTube',
  size: 1080,
  type: 'Trailer',
  official: true,
  iso_639_1: 'fr',
  iso_3166_1: 'FR',
  published_at: `${it.date}T00:00:00.000Z`,
});

function detail(it) {
  const common = {
    id: it.id,
    overview: it.overview,
    tagline: '',
    status: 'Released',
    original_language: 'fr',
    poster_path: poster(it),
    backdrop_path: fond(it),
    genres: it.genres.map((g) => ({ id: g, name: GENRE_NAME[g] || '' })),
    vote_average: it.vote,
    vote_count: it.votes,
    popularity: Math.round(it.votes / 20),
    imdb_id: imdbOf(it),
    external_ids: imdbOf(it) ? { imdb_id: imdbOf(it) } : {},
    images: { logos: [], posters: [], backdrops: [] },
    videos: { results: [trailer(it)] },
    'watch/providers': { results: {} },
  };
  if (it.type === 'movie') {
    return {
      ...common,
      title: it.title,
      original_title: it.title,
      release_date: it.date,
      runtime: it.runtime,
      release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 4, release_date: `${it.date}T00:00:00.000Z`, certification: it.cert }] }] },
    };
  }
  return {
    ...common,
    name: it.title,
    original_name: it.title,
    first_air_date: it.date,
    episode_run_time: [it.runtime],
    number_of_seasons: it.seasons,
    origin_country: [it.origin],
    next_episode_to_air: null,
    seasons: Array.from({ length: it.seasons }, (_, i) => ({ id: it.id * 10 + i, season_number: i + 1, name: `Saison ${i + 1}`, episode_count: 8, air_date: it.date, poster_path: null })),
    content_ratings: { results: [{ iso_3166_1: 'FR', rating: it.cert }] },
  };
}

/** Âge minimal d'une valeur `certification.lte` (FR : U, 10, 12, 16, 18). */
const lteAge = (v) => (v === 'U' ? 0 : Number(v));

function passes(it, p) {
  const genres = (key) => String(p[key]).split(/[|,]/).map(Number);
  if (p['with_genres'] && !it.genres.some((g) => genres('with_genres').includes(g))) return false;
  if (p['without_genres'] && it.genres.some((g) => genres('without_genres').includes(g))) return false;
  if (p['certification.lte'] !== undefined && CERT_AGE[it.cert] > lteAge(p['certification.lte'])) return false;
  if (p['with_runtime.lte'] !== undefined && it.runtime > Number(p['with_runtime.lte'])) return false;
  if (p['with_runtime.gte'] !== undefined && it.runtime < Number(p['with_runtime.gte'])) return false;
  if (p['vote_average.gte'] !== undefined && it.vote < Number(p['vote_average.gte'])) return false;
  if (p['vote_count.gte'] !== undefined && it.votes < Number(p['vote_count.gte'])) return false;
  if (p['vote_count.lte'] !== undefined && it.votes > Number(p['vote_count.lte'])) return false;
  if (p['with_origin_country'] && !String(p['with_origin_country']).split(/[|,]/).includes(it.origin)) return false;
  const dateKey = it.type === 'movie' ? 'primary_release_date' : 'first_air_date';
  if (p[`${dateKey}.gte`] && it.date < p[`${dateKey}.gte`]) return false;
  if (p[`${dateKey}.lte`] && it.date > p[`${dateKey}.lte`]) return false;
  return true;
}

function listResponse(items, page) {
  const first = page <= 1;
  return { page, total_pages: 1, total_results: first ? items.length : 0, results: first ? items.map(toList) : [] };
}

function discover(type, p) {
  if (ALWAYS_EMPTY.some((k) => p[k] !== undefined)) return listResponse([], Number(p.page || 1));
  const pool = (type === 'movie' ? MOVIES : SERIES).filter((it) => passes(it, p));
  return listResponse(pool, Number(p.page || 1));
}

function tmdb(path, p) {
  const page = Number(p.page || 1);
  const det = /^(movie|tv)\/(\d+)(?:\/(.+))?$/.exec(path);
  if (det) {
    const it = find(det[1], det[2]);
    if (!it) return { status: 404, body: { success: false, status_code: 34 } };
    const sub = det[3] || '';
    if (sub === '') return detail(it);
    if (sub === 'images') return { id: it.id, logos: [], posters: [], backdrops: [] };
    if (sub === 'videos') return { id: it.id, results: [trailer(it)] };
    if (sub === 'watch/providers') return { id: it.id, results: {} };
    if (sub === 'external_ids') return { id: it.id, imdb_id: imdbOf(it), tvdb_id: null };
    if (sub === 'recommendations' || sub === 'similar') {
      const same = (det[1] === 'movie' ? MOVIES : SERIES).filter((x) => x.id !== it.id);
      return listResponse(same, page);
    }
    if (sub.startsWith('season/')) return { season_number: Number(sub.split('/')[1]), episodes: [] };
    return { id: it.id, results: [] };
  }
  if (path.startsWith('discover/')) return discover(path.split('/')[1], p);
  if (path.startsWith('trending/')) {
    const t = path.split('/')[1];
    const pool = t === 'all' ? interleave(MOVIES, SERIES) : t === 'movie' ? MOVIES : t === 'tv' ? SERIES : [];
    return listResponse(pool, page);
  }
  const list = /^(movie|tv)\/(.+)$/.exec(path);
  if (list) {
    // Sorties à venir : aucune donnée inventée pour l'instant (la rangée « Prochainement » reste absente).
    if (list[2] === 'upcoming') return listResponse([], page);
    return listResponse(list[1] === 'movie' ? MOVIES : SERIES, page);
  }
  if (path.startsWith('collection/')) return { id: Number(path.split('/')[1]), name: '', parts: [] };
  if (path.startsWith('person/')) return { id: Number(path.split('/')[1]) || 0, name: '', cast: [], crew: [], combined_credits: { cast: [], crew: [] }, results: [] };
  return listResponse([], page);
}

function top10(scope, p) {
  const page = Number(p.page || 1);
  const pool = scope === 'movie' ? MOVIES : scope === 'tv' ? SERIES : interleave(MOVIES, SERIES);
  const first = page <= 1;
  return { page, raw: first ? 20 : 0, results: first ? pool.slice(0, 10).map(toList) : [] };
}

/**
 * Réponse factice pour une URL de l'API lastAddon (`/lt/tmdb/...` ou `/lt/top10/...`), ou null si l'URL n'est pas
 * une route catalogue. Renvoie { status, body }.
 */
export function catalogResponse(pathname, searchParams) {
  const m = /\/lt\/(tmdb|top10)\/(.+)$/.exec(pathname);
  if (!m) return null;
  const p = Object.fromEntries(searchParams);
  const out = m[1] === 'top10' ? top10(m[2], p) : tmdb(decodeURI(m[2]), p);
  if (out && typeof out === 'object' && 'status' in out && 'body' in out) return out;
  return { status: 200, body: out };
}
