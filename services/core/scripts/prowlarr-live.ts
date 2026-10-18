/**
 * Vérification live de la recherche sur le Prowlarr local (hors suite de tests). Le Prowlarr installé sur cette machine
 * est détecté par detectLocalProwlarr (clé lue dans config.xml, jamais affichée), puis searchProwlarr interroge ses
 * indexeurs avec le code de src/ tel quel. TMDB, Cinemeta et AllDebrid ne sont pas appelés : les titres sont en dur.
 * N'imprime que des compteurs (par indexeur, par type d'épisode) : aucune URL, aucun magnet, aucune clé.
 * Lancement (cwd = racine du worktree) : npx tsx scripts/prowlarr-live.ts
 */
import { readFileSync } from 'node:fs';
import { parseRawStream } from '../src/parse/index.js';
import type { ReleaseScope } from '../src/parse/scope.js';
import { maskSecrets } from '../src/sources/http.js';
import type { TitleInfo } from '../src/sources/indexers.js';
import { detectLocalProwlarr, LOCAL_PROWLARR_NAME, localProwlarrStatus } from '../src/sources/local-prowlarr.js';
import { defaultIndexerHealth } from '../src/sources/indexer-health.js';
import { discoverProwlarrIndexers, searchProwlarr, type ProwlarrSource } from '../src/sources/prowlarr.js';
import type { TitleVariants } from '../src/sources/query-titles.js';
import type { ContentRef, RawStream } from '../src/types.js';

/** Budget de chaque recherche (ms, défaut 60 s ; PROWLARR_LIVE_BUDGET_MS) : au-delà, les résultats partiels sont gardés. */
const BUDGET_MS = Number(process.env.PROWLARR_LIVE_BUDGET_MS ?? 60_000);

interface Case {
  label: string;
  ref: ContentRef;
  titles: TitleVariants;
  titleInfo: TitleInfo;
  /** Saison et épisode demandés (série) : absents pour un film. */
  season?: number;
  episode?: number;
}

const CASES: Case[] = [
  {
    label: 'a) Dune: Part Two (2024), film',
    ref: { type: 'movie', id: 'tt15239678', imdbId: 'tt15239678' },
    titles: { titles: ['Dune: Part Two', 'Dune : Deuxième partie'], year: 2024, en: 'Dune: Part Two', fr: 'Dune : Deuxième partie' },
    titleInfo: { title: 'Dune: Part Two', year: 2024 },
  },
  {
    label: 'b) Breaking Bad S04E04',
    ref: { type: 'series', id: 'tt0903747:4:4', imdbId: 'tt0903747', season: 4, episode: 4 },
    titles: { titles: ['Breaking Bad'] },
    titleInfo: { title: 'Breaking Bad' },
    season: 4,
    episode: 4,
  },
  {
    label: 'c) Frieren S01E05 (Sousou no Frieren)',
    ref: { type: 'series', id: 'tt22248376:1:5', imdbId: 'tt22248376', season: 1, episode: 5 },
    titles: { titles: ['Frieren', 'Sousou no Frieren'] },
    titleInfo: { title: 'Frieren' },
    season: 1,
    episode: 5,
  },
  {
    label: 'd) Lupin S03E01',
    ref: { type: 'series', id: 'tt8097030:3:1', imdbId: 'tt8097030', season: 3, episode: 1 },
    titles: { titles: ['Lupin'] },
    titleInfo: { title: 'Lupin' },
    season: 3,
    episode: 1,
  },
];

/** Type d'épisode d'une release, par rapport à l'épisode demandé. */
type Kind = 'exact' | 'pack-saison' | 'integrale' | 'absolu-seul' | 'autre';

function kindOf(scope: ReleaseScope, season: number, episode: number): Kind {
  if (scope.episode !== undefined) return scope.season === season && scope.episode === episode ? 'exact' : 'autre';
  if (scope.pack === 'season') return scope.season === season ? 'pack-saison' : 'autre';
  if (scope.pack === 'complete') return 'integrale';
  if (scope.absolute !== undefined) return 'absolu-seul';
  return 'autre';
}

/** Compteurs par indexeur (premier indexeur de la release, sinon son nom de source). */
function perIndexer(streams: RawStream[]): string {
  const counts = new Map<string, number>();
  for (const stream of streams) {
    const name = stream.indexers?.[0] ?? stream.sourceName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return 'aucun';
  return [...counts].map(([name, count]) => `${name} ${count}`).join(' · ');
}

/** Répartition des épisodes (séries) : exact, pack de saison, intégrale/multi-saisons, numérotation absolue, autre. */
function episodeBreakdown(streams: RawStream[], season: number, episode: number): string {
  const counts: Record<Kind, number> = { exact: 0, 'pack-saison': 0, integrale: 0, 'absolu-seul': 0, autre: 0 };
  for (const stream of streams) {
    counts[kindOf(parseRawStream(stream).scope ?? {}, season, episode)] += 1;
  }
  return `épisode exact ${counts.exact} · pack saison ${counts['pack-saison']} · intégrale ${counts.integrale} · numérotation absolue seule ${counts['absolu-seul']} · autre saison/épisode ou sans portée ${counts.autre}`;
}

async function main(): Promise<void> {
  const local = await detectLocalProwlarr({ env: process.env, readFile: (path) => readFileSync(path, 'utf8') });
  console.log(localProwlarrStatus(local).label);
  if (local === null) return;

  const source: ProwlarrSource = { name: LOCAL_PROWLARR_NAME, baseUrl: local.baseUrl, apiKey: local.apiKey };
  const indexers = await discoverProwlarrIndexers(source, {});
  console.log(`indexeurs : ${indexers.map((indexer) => `${indexer.name} (${indexer.privacy})`).join(' · ') || 'aucun'}`);
  for (const item of CASES) {
    const started = Date.now();
    try {
      const streams = await searchProwlarr(source, item.ref, {
        titleInfo: item.titleInfo,
        titles: item.titles,
        budgetMs: BUDGET_MS,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\n== ${item.label} : ${streams.length} résultat(s) en ${seconds} s`);
      console.log(`   par indexeur : ${perIndexer(streams)}`);
      // Statut de santé après la recherche : distingue « 0 résultat » d'une erreur d'indexeur.
      const health = indexers.map((indexer) => {
        const snapshot = defaultIndexerHealth.get(LOCAL_PROWLARR_NAME, indexer.id);
        if (snapshot === undefined) return `${indexer.name} unknown`;
        const code = snapshot.lastErrorCode === undefined ? '' : `, ${snapshot.lastErrorCode}`;
        return `${indexer.name} ${snapshot.status} (${snapshot.errorCount}/${snapshot.count} échecs${code})`;
      });
      console.log(`   état : ${health.join(' · ')}`);
      if (item.season !== undefined && item.episode !== undefined) {
        console.log(`   ${episodeBreakdown(streams, item.season, item.episode)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'erreur inattendue';
      console.log(`\n== ${item.label} : erreur (${maskSecrets(message, [local.apiKey])})`);
    }
  }
}

await main();
