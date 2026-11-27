import { pad2 } from './format';
import { certLteFor } from './kid';
import { t } from '../i18n';

/*
 * Registre des rangées de l'accueil (style Netflix) : chaque rangée est une définition (identifiant, titre, forme de tuile,
 * source TMDB, rangée réservée aux enfants ou aux adultes, saison). L'interface les charge à la demande, dans l'ordre.
 */

type RowKind = 'poster' | 'landscape' | 'top10' | 'logoCard';
export type Params = Record<string, string>;

export interface RowCtx {
  region: string;
  /** AAAA-MM-JJ. */
  today: string;
  /** 1 à 12. */
  month: number;
  /** Âge maximal du profil enfant, null pour un profil adulte. */
  kidMaxAge: number | null;
}

type Fetcher =
  | { k: 'discover'; type: 'movie' | 'tv'; params: (c: RowCtx) => Params }
  | { k: 'list'; path: string; type?: 'movie' | 'tv' }
  /** Top 10 : tendances de la semaine filtrées côté serveur (titres disponibles dans la région, lt/top10.ts). */
  | { k: 'top10'; type: 'movie' | 'tv' }
  | { k: 'collections'; ids: number[] }
  /** Classiques libres : films libres de droits partout, servis par lastAddon (lt/libres.ts), lisibles sans aucune source. */
  | { k: 'libres' }
  | { k: 'provider'; slug: string; type: 'movie' | 'tv' | 'both'; params?: (c: RowCtx) => Params }
  | { k: 'because'; source: 'watched' | 'rated'; index: number }
  | { k: 'person'; index: number };

export interface RowDef {
  id: string;
  title: string;
  kind: RowKind;
  fetch: Fetcher;
  /** Rangée du profil enfant (sinon adulte). */
  kid?: boolean;
  /** Rubrique que le parent peut activer ou non (profil enfant). */
  section?: string;
  /** Paramètres TMDB hors liste blanche historique : la rangée n'apparaît que si le serveur les applique. */
  needs?: string[];
  when?: (c: RowCtx) => boolean;
  minItems?: number;
  /** Pas de lien « Tout voir ». */
  noBrowse?: boolean;
  /** Rangée de titres à venir : exemptée de la règle « déjà sorti ». */
  upcoming?: boolean;
  /** Films uniquement en salle (« Au cinéma en ce moment »). */
  cinema?: boolean;
}

export const MIN_ITEMS = 8;

/** Genres « bruit » : actualités (10763), talk-shows (10767) et téléréalité (10764). */
const NOISE_GENRES: readonly number[] = [10763, 10767, 10764];
/** Votes minimum pour une rangée générique : films 200, séries 100. */
const MIN_VOTES = { movie: 200, tv: 100 } as const;

/** Un titre de liste générique est écarté s'il relève du bruit (sauf rangée dédiée) ou s'il a trop peu de votes. */
export function passesQuality(item: { type: 'movie' | 'tv'; genreIds?: number[]; votes?: number }): boolean {
  if ((item.genreIds ?? []).some((g) => NOISE_GENRES.includes(g))) return false;
  return item.votes === undefined || item.votes >= MIN_VOTES[item.type];
}

/** Premier titre de `candidates` pas déjà utilisé comme graine d'une autre rangée personnalisée. */
export function pickSeed<T extends { key: string }>(candidates: T[], used: ReadonlySet<string>): T | undefined {
  return candidates.find((c) => !used.has(c.key));
}
export const ROW_MAX = 20;
/** Un titre apparaît au plus deux fois sur la page. */
const MAX_REPEAT = 2;

export function makeCtx(region: string, kidMaxAge: number | null, now = new Date()): RowCtx {
  return { region, today: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`, month: now.getMonth() + 1, kidMaxAge };
}

const daysAgo = (today: string, n: number): string => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
const POP: Params = { sort_by: 'popularity.desc', include_adult: 'false' };
/** Disponible dans le pays : fournisseur (abonnement, gratuit, publicité, location ou achat) dans la région. */
const AVAIL = (c: RowCtx): Params => ({ watch_region: c.region, with_watch_monetization_types: 'flatrate|free|ads|rent|buy' });

const movie = (id: string, title: string, params: (c: RowCtx) => Params, extra: Partial<RowDef> = {}): RowDef =>
  ({ id, title, kind: 'poster', fetch: { k: 'discover', type: 'movie', params: (c) => ({ ...POP, ...AVAIL(c), 'vote_count.gte': '200', ...params(c) }) }, ...extra });
const tv = (id: string, title: string, params: (c: RowCtx) => Params, extra: Partial<RowDef> = {}): RowDef =>
  ({ id, title, kind: 'poster', fetch: { k: 'discover', type: 'tv', params: (c) => ({ ...POP, ...AVAIL(c), without_genres: '10763,10767,10764', 'vote_count.gte': '100', ...params(c) }) }, ...extra });
const list = (id: string, title: string, path: string, extra: Partial<RowDef> = {}): RowDef =>
  ({ id, title, kind: 'poster', fetch: { k: 'list', path }, ...extra });

const inMonths = (...months: number[]) => (c: RowCtx): boolean => months.includes(c.month);

/** Rangées du profil adulte, dans l'ordre d'affichage (après les rangées fixes du haut de l'accueil). */
export const ADULT_ROWS: RowDef[] = [
  { ...movie('films', t('Films populaires'), () => ({})) },
  { ...tv('series', t('Séries populaires'), () => ({})) },
  { id: 'libres', title: t('Classiques libres'), kind: 'poster', fetch: { k: 'libres' }, minItems: 6 },
  { id: 'because-w-0', title: '', kind: 'poster', fetch: { k: 'because', source: 'watched', index: 0 } },
  { id: 'because-r-0', title: '', kind: 'poster', fetch: { k: 'because', source: 'rated', index: 0 } },
  { id: 'top-series', title: t('Top 10 séries de la semaine'), kind: 'top10', fetch: { k: 'top10', type: 'tv' }, minItems: 10 },
  { ...list('cinema', t('Au cinéma en ce moment'), 'movie/now_playing', { cinema: true, upcoming: true, minItems: 6 }) },
  { id: 'top-films', title: t('Top 10 films'), kind: 'top10', fetch: { k: 'top10', type: 'movie' }, minItems: 10 },
  { id: 'because-w-1', title: '', kind: 'poster', fetch: { k: 'because', source: 'watched', index: 1 } },
  { ...list('trending-day', t('Tendances aujourd’hui'), 'trending/all/day') },
  { id: 'new-netflix', title: t('Nouveautés sur Netflix'), kind: 'landscape', fetch: { k: 'provider', slug: 'netflix', type: 'both', params: (c) => ({ sort_by: 'primary_release_date.desc', 'primary_release_date.lte': c.today, 'primary_release_date.gte': daysAgo(c.today, 120) }) } },
  { ...list('soon-streaming', t('Bientôt en streaming'), 'movie/upcoming', { upcoming: true }) },
  { id: 'person-0', title: '', kind: 'poster', fetch: { k: 'person', index: 0 } },
  { ...movie('critics', t('Acclamés par la critique'), () => ({ sort_by: 'vote_average.desc', 'vote_average.gte': '7.8', 'vote_count.gte': '2000' }), { needs: ['vote_average.gte'] }) },
  { id: 'new-prime', title: t('Nouveautés sur Prime Video'), kind: 'landscape', fetch: { k: 'provider', slug: 'prime-video', type: 'both', params: (c) => ({ sort_by: 'primary_release_date.desc', 'primary_release_date.lte': c.today, 'primary_release_date.gte': daysAgo(c.today, 120) }) } },
  { ...movie('blockbusters', t('Blockbusters'), () => ({ sort_by: 'revenue.desc', 'vote_count.gte': '1000' })) },
  { ...movie('halloween', t('Spécial Halloween'), () => ({ with_keywords: '3335', with_genres: '27|53' }), { when: inMonths(10), needs: ['with_keywords'] }) },
  { ...movie('noel', t('Films de Noël'), () => ({ with_keywords: '207317' }), { when: inMonths(12), needs: ['with_keywords'] }) },
  { id: 'because-w-2', title: '', kind: 'poster', fetch: { k: 'because', source: 'watched', index: 2 } },
  { ...movie('fr-comedies', t('Comédies françaises'), () => ({ with_original_language: 'fr', with_genres: '35', 'vote_count.gte': '100' })) },
  { ...movie('fr-cinema', t('Cinéma français'), () => ({ with_original_language: 'fr', 'vote_count.gte': '200' })) },
  { ...tv('fr-series', t('Séries françaises'), () => ({ with_original_language: 'fr', 'vote_count.gte': '30' })) },
  { id: 'new-disney', title: t('Nouveautés sur Disney+'), kind: 'landscape', fetch: { k: 'provider', slug: 'disney-plus', type: 'both', params: (c) => ({ sort_by: 'primary_release_date.desc', 'primary_release_date.lte': c.today, 'primary_release_date.gte': daysAgo(c.today, 120) }) } },
  { ...movie('thrillers', t('Polars et thrillers'), () => ({ with_genres: '80|53', 'vote_count.gte': '300' })) },
  { ...movie('gems', t('Pépites méconnues'), () => ({ sort_by: 'vote_average.desc', 'vote_average.gte': '7.3', 'vote_count.gte': '150', 'vote_count.lte': '1500' }), { needs: ['vote_average.gte', 'vote_count.lte'] }) },
  { ...movie('psycho', t('Thrillers psychologiques'), () => ({ with_genres: '53,9648', 'vote_count.gte': '300' })) },
  { id: 'because-r-1', title: '', kind: 'poster', fetch: { k: 'because', source: 'rated', index: 1 } },
  { ...movie('scifi', t('Science-fiction'), () => ({ with_genres: '878', 'vote_count.gte': '300' })) },
  { id: 'new-canal', title: t('Nouveautés sur Canal+'), kind: 'landscape', fetch: { k: 'provider', slug: 'canal-plus', type: 'both', params: (c) => ({ sort_by: 'primary_release_date.desc', 'primary_release_date.lte': c.today, 'primary_release_date.gte': daysAgo(c.today, 120) }) } },
  { ...movie('fantasy', t('Fantastique'), () => ({ with_genres: '14', 'vote_count.gte': '300' })) },
  { ...movie('horror', t('Horreur'), () => ({ with_genres: '27', 'vote_count.gte': '300' })) },
  { ...movie('action', t('Action et aventure'), () => ({ with_genres: '28|12', 'vote_count.gte': '300' })) },
  { ...movie('feelgood', t('Feel good'), () => ({ with_genres: '35,10751', sort_by: 'vote_average.desc', 'vote_count.gte': '800' })) },
  { ...movie('comedy', t('Comédies'), () => ({ with_genres: '35', 'vote_count.gte': '300' })) },
  { ...movie('romance', t('Romance'), () => ({ with_genres: '10749', 'vote_count.gte': '300' })) },
  { ...movie('drama', t('Drames'), () => ({ with_genres: '18', 'vote_count.gte': '500' })) },
  { ...movie('true-story', t('Basé sur une histoire vraie'), () => ({ with_keywords: '9672', 'vote_count.gte': '200' }), { needs: ['with_keywords'] }) },
  { ...movie('novels', t('Adaptations de romans'), () => ({ with_keywords: '818', 'vote_count.gte': '200' }), { needs: ['with_keywords'] }) },
  { ...tv('miniseries', t('Mini-séries'), () => ({ with_type: '2', 'vote_count.gte': '100' }), { needs: ['with_type'] }) },
  { ...tv('ended', t('Séries terminées à binger'), () => ({ with_status: '3', sort_by: 'vote_average.desc', 'vote_average.gte': '7.5', 'vote_count.gte': '300' }), { needs: ['with_status', 'vote_average.gte'] }) },
  { ...tv('korean', t('Séries coréennes'), () => ({ with_original_language: 'ko', 'vote_count.gte': '50' })) },
  { ...tv('anime', t('Anime'), () => ({ with_genres: '16', with_original_language: 'ja', 'vote_count.gte': '100' })) },
  { ...movie('docs', t('Documentaires'), () => ({ with_genres: '99', 'vote_count.gte': '100' })) },
  { ...tv('docuseries', t('Docu-séries'), () => ({ with_genres: '99', 'vote_count.gte': '50' })) },
  { ...movie('standup', t('Stand-up'), () => ({ with_keywords: '9716' }), { needs: ['with_keywords'] }) },
  { id: 'sagas', title: t('Sagas cultes'), kind: 'poster', fetch: { k: 'collections', ids: [10, 1241, 119, 645, 87359, 9485, 86311, 328, 2344, 295, 84, 10194, 263] }, noBrowse: true },
  { ...movie('a24', 'A24', () => ({ with_companies: '41077' }), { needs: ['with_companies'] }) },
  { ...movie('short', t('Films de moins de 90 minutes'), () => ({ 'with_runtime.lte': '90', 'with_runtime.gte': '60', 'vote_count.gte': '500' }), { needs: ['with_runtime.lte'] }) },
  { ...movie('y80', t('Années 80'), () => ({ 'primary_release_date.gte': '1980-01-01', 'primary_release_date.lte': '1989-12-31', sort_by: 'vote_count.desc' })) },
  { ...movie('y90', t('Années 90'), () => ({ 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31', sort_by: 'vote_count.desc' })) },
  { ...movie('y00', t('Années 2000'), () => ({ 'primary_release_date.gte': '2000-01-01', 'primary_release_date.lte': '2009-12-31', sort_by: 'vote_count.desc' })) },
  { ...movie('europe', t('Cinéma européen'), () => ({ with_origin_country: 'DE|IT|ES|SE|DK|BE|PL|GB', 'vote_count.gte': '200', sort_by: 'vote_average.desc' }), { needs: ['with_origin_country'] }) },
  { id: 'person-1', title: '', kind: 'poster', fetch: { k: 'person', index: 1 } },
  { id: 'person-2', title: '', kind: 'poster', fetch: { k: 'person', index: 2 } },
];

/** Base des requêtes enfant : certification du pays (borne = âge du profil) et genres jeunesse. */
export function kidBase(c: RowCtx, type: 'movie' | 'tv', genres?: string, maxAge?: number): Params {
  const p: Params = { include_adult: 'false', certification_country: c.region, with_genres: genres ?? (type === 'tv' ? '10762|16|10751' : '16|10751'), sort_by: 'popularity.desc' };
  const lte = certLteFor(c.region, maxAge ?? c.kidMaxAge ?? 12);
  if (lte) p['certification.lte'] = lte;
  return p;
}

const kmovie = (id: string, title: string, section: string, extra: (c: RowCtx) => Params, genres?: string, def: Partial<RowDef> = {}): RowDef =>
  ({ id, title, kind: 'poster', kid: true, section, fetch: { k: 'discover', type: 'movie', params: (c) => ({ ...kidBase(c, 'movie', genres), ...extra(c) }) }, ...def });
const ktv = (id: string, title: string, section: string, extra: (c: RowCtx) => Params, genres?: string, def: Partial<RowDef> = {}): RowDef =>
  ({ id, title, kind: 'poster', kid: true, section, fetch: { k: 'discover', type: 'tv', params: (c) => ({ ...kidBase(c, 'tv', genres), ...extra(c) }) }, ...def });
const company = (id: string, title: string, companyId: string): RowDef =>
  kmovie(id, title, 'disney', () => ({ with_companies: companyId, 'vote_count.gte': '200' }), '16|10751|12|14', { needs: ['with_companies'] });

/** Rangées du profil enfant. Chaque rangée appartient à une rubrique que le parent peut désactiver. */
export const KID_ROWS: RowDef[] = [
  kmovie('dessins', t('Dessins animés'), 'dessins', () => ({}), '16'),
  kmovie('famille', t('Films en famille'), 'famille', () => ({}), '10751'),
  ktv('jeunesse-series', t('Séries jeunesse'), 'series', () => ({})),
  kmovie('nouveautes', t('Nouveautés jeunesse'), 'nouveautes', (c) => ({ sort_by: 'primary_release_date.desc', 'primary_release_date.lte': c.today, 'vote_count.gte': '20' })),
  kmovie('toddlers', t('Pour les tout-petits'), 'series', () => ({ 'vote_count.gte': '20' }), '10762|16', { fetch: { k: 'discover', type: 'tv', params: (c) => ({ ...kidBase(c, 'tv', '10762', 0), 'vote_count.gte': '20' }) } }),
  company('disney', 'Disney', '2'),
  company('pixar', t('Pixar'), '3'),
  company('dreamworks', t('DreamWorks Animation'), '521'),
  company('illumination', t('Illumination'), '6704'),
  company('ghibli', t('Studio Ghibli'), '10342'),
  kmovie('classics', t('Classiques animés'), 'dessins', () => ({ 'primary_release_date.lte': '1999-12-31', sort_by: 'vote_count.desc' }), '16'),
  kmovie('adventures', t('Aventures'), 'famille', () => ({ 'vote_count.gte': '200' }), '12,16|12,10751'),
  kmovie('family-comedies', t('Comédies familiales'), 'famille', () => ({ 'vote_count.gte': '200' }), '35,10751'),
  kmovie('heroes', t('Super-héros pour les jeunes'), 'famille', () => ({ with_keywords: '9715' }), '16|10751|28', { needs: ['with_keywords'] }),
  kmovie('fairy', t('Princesses et contes'), 'famille', () => ({ with_keywords: '3205|13084' }), '16|10751|14', { needs: ['with_keywords'] }),
  kmovie('animals', t('Animaux'), 'dessins', () => ({ with_keywords: '1956' }), '16|10751', { needs: ['with_keywords'] }),
  kmovie('lego', 'LEGO', 'disney', () => ({ with_keywords: '155226' }), '16|10751|12', { needs: ['with_keywords'] }),
  ktv('kid-anime', t('Animés jeunesse'), 'anime', () => ({ with_original_language: 'ja' }), '16'),
  kmovie('xmas', t('Films de Noël'), 'nouveautes', () => ({ with_keywords: '207317' }), '16|10751|35', { when: inMonths(12), needs: ['with_keywords'] }),
  kmovie('halloween-kids', t('Halloween jeunesse'), 'nouveautes', () => ({ with_keywords: '3335' }), '16|10751|14', { when: inMonths(10), needs: ['with_keywords'] }),
  ktv('top-kids', t('Top jeunesse'), 'series', () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': '300' })),
  { id: 'kid-disney-plus', title: t('Disney+ jeunesse'), kind: 'landscape', kid: true, section: 'plateformes', fetch: { k: 'provider', slug: 'disney-plus', type: 'both' } },
  { id: 'kid-netflix', title: t('Netflix jeunesse'), kind: 'landscape', kid: true, section: 'plateformes', fetch: { k: 'provider', slug: 'netflix', type: 'both' } },
];

/** Pages du menu principal (Films, Séries, Documentaires) : rangées propres à la page, absentes de l'accueil. */
const HUB_EXTRA_ROWS: RowDef[] = [
  { ...tv('tv-drama', t('Séries dramatiques'), () => ({ with_genres: '18' })) },
  { ...tv('tv-crime', t('Séries policières'), () => ({ with_genres: '80' })) },
  { ...tv('tv-comedy', t('Séries comiques'), () => ({ with_genres: '35' })) },
  { ...tv('tv-scifi', t('Science-fiction et fantastique'), () => ({ with_genres: '10765' })) },
  { ...movie('docs-recent', t('Documentaires récents'), (c) => ({ with_genres: '99', sort_by: 'primary_release_date.desc', 'primary_release_date.lte': c.today, 'primary_release_date.gte': daysAgo(c.today, 1100) })) },
  { ...movie('docs-fr', t('Documentaires français'), () => ({ with_genres: '99', with_original_language: 'fr' })) },
  { ...movie('docs-crime', t('Enquêtes et faits divers'), () => ({ with_genres: '99,80' })) },
  { ...movie('docs-history', t('Histoire'), () => ({ with_genres: '99,36' })) },
  { ...movie('docs-music', t('Musique'), () => ({ with_genres: '99,10402' })) },
  { ...tv('docuseries-crime', t('Docu-séries : enquêtes'), () => ({ with_genres: '99,80', 'vote_count.gte': '50' })) },
];

export type HubId = 'films' | 'series' | 'documentaires';

/** Rangées de chaque page du menu principal, dans l'ordre d'affichage. */
export const HUBS: Record<HubId, { title: string; rows: readonly string[] }> = {
  films: { title: t('Films'), rows: ['films', 'top-films', 'cinema', 'libres', 'critics', 'blockbusters', 'fr-cinema', 'action', 'comedy', 'drama', 'thrillers', 'scifi', 'horror', 'gems'] },
  series: { title: t('Séries'), rows: ['series', 'top-series', 'fr-series', 'tv-drama', 'tv-crime', 'tv-comedy', 'tv-scifi', 'ended', 'miniseries', 'korean', 'anime'] },
  documentaires: { title: t('Documentaires'), rows: ['docs', 'docuseries', 'docs-recent', 'docs-fr', 'docs-crime', 'docs-history', 'docs-music', 'docuseries-crime'] },
};

export const rowById = (id: string): RowDef | undefined => [...ADULT_ROWS, ...KID_ROWS, ...HUB_EXTRA_ROWS].find((r) => r.id === id);

/** Rangées à afficher pour le profil, dans l'ordre (saison et rubriques autorisées appliquées). */
export function activeRows(c: RowCtx, kid: boolean, sectionOk: (id: string) => boolean): RowDef[] {
  const pool = kid ? KID_ROWS : ADULT_ROWS;
  return pool.filter((r) => (!r.when || r.when(c)) && (!kid || !r.section || sectionOk(r.section)));
}

/**
 * Sondes : requête avec une valeur impossible pour vérifier que lastAddon applique le paramètre.
 * mode « empty » : aucun résultat attendu ; « lowTop » : le premier résultat (tri par votes) a au plus 5 votes.
 */
export const PROBES: Record<string, { type: 'movie' | 'tv'; params: Params; mode: 'empty' | 'lowTop' }> = {
  with_keywords: { type: 'movie', params: { with_keywords: '999999999' }, mode: 'empty' },
  with_companies: { type: 'movie', params: { with_companies: '999999999' }, mode: 'empty' },
  with_networks: { type: 'tv', params: { with_networks: '999999999' }, mode: 'empty' },
  with_origin_country: { type: 'movie', params: { with_origin_country: 'ZZ' }, mode: 'empty' },
  'vote_average.gte': { type: 'movie', params: { 'vote_average.gte': '11' }, mode: 'empty' },
  'vote_count.lte': { type: 'movie', params: { 'vote_count.lte': '5', sort_by: 'vote_count.desc' }, mode: 'lowTop' },
  'with_runtime.lte': { type: 'movie', params: { 'with_runtime.lte': '1', 'vote_count.gte': '500' }, mode: 'empty' },
  with_type: { type: 'tv', params: { with_type: '9' }, mode: 'empty' },
  with_status: { type: 'tv', params: { with_status: '9' }, mode: 'empty' },
};

/**
 * Ajoute un titre aux compteurs d'apparition ; faux s'il est déjà sur la page MAX_REPEAT fois.
 * Les rangées appellent `canShow` pour filtrer puis `commit` pour les titres réellement affichés.
 */
export class Appearances {
  private counts = new Map<string, number>();
  canShow(key: string): boolean {
    return (this.counts.get(key) ?? 0) < MAX_REPEAT;
  }
  commit(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/** Nombre de titres du Top 10 (numérotés 1 à 10, sans trou même quand le filtre en retire). */
export const TOP_COUNT = 10;
/** Pages de la source lues au plus pour compléter une rangée dont le filtre a retiré des titres. */
export const ROW_PAGES_MAX = 3;

/** Une page de rangée : `raw` titres reçus de la source (0 : fin de la source), `items` titres retenus. */
export interface RowPage<T> {
  title: string;
  raw: number;
  items: T[];
}

/**
 * Remplit une rangée jusqu'à `want` titres en lisant les pages suivantes quand le filtre en a retiré (au plus `maxPages`).
 * `load` renvoie null si la rangée n'existe pas ; `accept` filtre chaque lot (disponibilité, répétitions…).
 */
export async function fillRow<T extends { key: string }>(
  load: (page: number) => Promise<RowPage<T> | null>,
  want: number,
  accept: (fresh: T[]) => Promise<T[]>,
  maxPages = ROW_PAGES_MAX,
): Promise<{ title: string; items: T[] } | null> {
  const out: T[] = [];
  const seen = new Set<string>();
  let title = '';
  for (let page = 1; page <= maxPages && out.length < want; page++) {
    const res = await load(page);
    if (!res) return page === 1 ? null : { title, items: out.slice(0, want) };
    if (page === 1) title = res.title;
    const fresh = res.items.filter((it) => !seen.has(it.key));
    fresh.forEach((it) => seen.add(it.key));
    out.push(...(await accept(fresh)));
    if (res.raw === 0) break;
  }
  return { title, items: out.slice(0, want) };
}

/** Rang (1 à 10) de chaque titre d'un Top 10 : le rang suit l'ordre d'affichage après filtrage. */
export function rankTop<T>(items: readonly T[]): Array<{ item: T; rank: number }> {
  return items.slice(0, TOP_COUNT).map((item, i) => ({ item, rank: i + 1 }));
}
