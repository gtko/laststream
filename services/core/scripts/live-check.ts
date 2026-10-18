/**
 * Vérification live (hors suite de tests) : Prowlarr, TMDB et AllDebrid réels, avec le code de src/ tel quel.
 * Lancement (cwd = racine du worktree) :
 *   op run --env-file=C:/Users/grego/Projets/laststream/prototype-home/.env.op -- npx tsx scripts/live-check.ts
 * N'imprime que des statuts et des compteurs. Toute sortie passe par redact().
 */
import { randomBytes } from 'node:crypto';
import { type Config, parseConfig } from '../src/config/schema.js';
import { type PipelineContext, type PipelineResult, getStreams } from '../src/pipeline.js';
import { defaultPlayState } from '../src/play/state.js';
import { type PlayCopy, decodeCopiesToken } from '../src/play/token.js';
import { AllDebridClient } from '../src/sources/alldebrid.js';
import { HosterClient } from '../src/sources/hosters.js';
import { type ProwlarrSource, discoverProwlarrIndexers, searchProwlarr } from '../src/sources/prowlarr.js';
import { getTitleVariants } from '../src/sources/query-titles.js';
import { resolveInfoHashes } from '../src/torrent/enrich.js';
import type { ContentRef, RawStream, StremioStream } from '../src/types.js';

const PROWLARR_URL = 'http://localhost:9696';
const MOVIE: ContentRef = { type: 'movie', id: 'tt15239678', imdbId: 'tt15239678' };
const SERIES: ContentRef = { type: 'series', id: 'tt0944947:1:1', imdbId: 'tt0944947', season: 1, episode: 1 };
/** Taille du lot de lecture .torrent du pipeline (RESOLVE_TOP_N, non exporté). */
const RESOLVE_TOP_N = 12;
const TIMEOUT_MS = 15_000;

const secretValues = [process.env.PROWLARR_API_KEY, process.env.TMDB_TOKEN, process.env.ALLDEBRID_API_KEY].filter(
  (value): value is string => typeof value === 'string' && value.length > 0,
);

/** Filtre de sortie : valeurs secrètes, paramètres clé/jeton, URL et magnets sont masqués. */
function redact(text: string): string {
  let out = text;
  for (const value of secretValues) out = out.split(value).join('[masqué]');
  out = out.replace(/magnet:\?\S+/gi, '[magnet masqué]');
  out = out.replace(/https?:\/\/\S+/gi, '[url masquée]');
  out = out.replace(
    /\b(apikey|api[_-]?key|x-api-key|passkey|token|bearer|secret|authorization)\b(\s*[=:]\s*|\s+)[^\s,;'"&]+/gi,
    (_match, key: string) => `${key}=[masqué]`,
  );
  return out;
}

function line(text: string): void {
  console.log(redact(text));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code;
  return 'unknown';
}

function elapsed(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
}

function percent(part: number, total: number): string {
  return total === 0 ? '0 %' : `${Math.round((part / total) * 100)} %`;
}

/** Durées des requêtes sortantes par famille (libellé sans hôte ni requête), et durées des étapes du pipeline. */
interface Tally { count: number; total: number; max: number }
let requestTally = new Map<string, Tally>();
let stageTally: { stage: string; ms: number }[] = [];

function familyOf(url: string): string {
  const u = new URL(url);
  if (u.port === '9696' || u.hostname === 'localhost') {
    return u.pathname.startsWith('/api/v1/search') ? 'Prowlarr recherche' : 'Prowlarr indexeurs';
  }
  if (u.hostname.endsWith('themoviedb.org')) return 'TMDB';
  if (u.hostname.endsWith('strem.io')) return 'Cinemeta';
  if (u.hostname.endsWith('alldebrid.com')) return `AllDebrid ${u.pathname}`;
  return 'autre (.torrent, liens)';
}

/** fetch qui mesure chaque requête par famille ; ne journalise ni URL ni réponse. */
function timedFetch(base: typeof fetch): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const started = Date.now();
    try {
      return await base(input, init);
    } finally {
      const family = familyOf(url);
      const tally = requestTally.get(family) ?? { count: 0, total: 0, max: 0 };
      const ms = Date.now() - started;
      tally.count += 1;
      tally.total += ms;
      tally.max = Math.max(tally.max, ms);
      requestTally.set(family, tally);
    }
  };
}

function printTimings(label: string): void {
  line(`  étapes (${label}) : ${stageTally.map((entry) => `${entry.stage} ${(entry.ms / 1000).toFixed(1)} s`).join(' ; ')}`);
  const families = [...requestTally].sort((a, b) => b[1].max - a[1].max);
  for (const [family, tally] of families) {
    line(`  requêtes ${family} : ${tally.count} (max ${(tally.max / 1000).toFixed(1)} s, cumul ${(tally.total / 1000).toFixed(1)} s)`);
  }
  requestTally = new Map();
  stageTally = [];
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('délai dépassé'), { code: 'timeout' })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function countByIndexer(streams: RawStream[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stream of streams) {
    const name = stream.indexers?.[0] ?? stream.sourceName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function copiesOf(stream: StremioStream): number {
  const meta = stream.laststream ?? {};
  return typeof meta.copies === 'number' ? meta.copies : 1;
}

function verifiedOf(stream: StremioStream): number {
  const meta = stream.laststream ?? {};
  return Array.isArray(meta.verifiedLanguages) ? meta.verifiedLanguages.length : 0;
}

function buildConfig(prowlarrKey: string, tmdbToken: string, debridKey: string): Config {
  return parseConfig({
    preset: 'essentiel',
    services: tmdbToken === '' ? {} : { tmdbToken },
    sources: prowlarrKey === '' ? [] : [{ type: 'prowlarr', name: 'Prowlarr', baseUrl: PROWLARR_URL, apiKey: prowlarrKey }],
    ...(debridKey === '' ? {} : { debrid: { service: 'alldebrid', apiKey: debridKey } }),
  });
}

/** Résolution de la copie 1 comme la route /play : lien direct, hébergeur débridé, ou infoHash via AllDebrid. */
async function simulateResolve(copy: PlayCopy, debrid: AllDebridClient | undefined): Promise<string> {
  if (copy.url !== undefined && copy.kind !== 'hoster') return 'ok (lien direct, sans débrideur)';
  if (debrid === undefined) return 'échec, code=no_debrid';
  if (copy.privateTorrent === true) return 'échec, code=no_copy (torrent privé, octets non chargés)';
  try {
    const work: Promise<{ url: string }> =
      copy.kind === 'hoster' && copy.url !== undefined
        ? new HosterClient(debrid).unlock(copy.url)
        : copy.infoHash === undefined
          ? Promise.reject(Object.assign(new Error('copie sans infoHash'), { code: 'unknown' }))
          : debrid.resolve(copy.infoHash, copy.fileIdx, { filename: copy.filename, size: copy.size });
    const link = await withTimeout(work, TIMEOUT_MS);
    return `ok (protocole ${new URL(link.url).protocol.replace(':', '')})`;
  } catch (err) {
    return `échec, code=${errorCode(err)}`;
  }
}

async function main(): Promise<void> {
  const totalStart = Date.now();
  const prowlarrKey = process.env.PROWLARR_API_KEY ?? '';
  const tmdbToken = process.env.TMDB_TOKEN ?? '';
  const debridKey = process.env.ALLDEBRID_API_KEY ?? '';
  line(
    `Clés présentes : Prowlarr ${prowlarrKey ? 'oui' : 'NON'}, TMDB ${tmdbToken ? 'oui' : 'NON'}, AllDebrid ${debridKey ? 'oui' : 'NON'}`,
  );

  const source: ProwlarrSource = { name: 'Prowlarr', baseUrl: PROWLARR_URL, apiKey: prowlarrKey };

  // 1. Indexeurs Prowlarr, par confidentialité.
  try {
    const indexers = await discoverProwlarrIndexers(source, { timeoutMs: TIMEOUT_MS });
    const byPrivacy = (privacy: string): number => indexers.filter((item) => item.privacy === privacy).length;
    line(
      `Indexeurs : ${indexers.length} (public ${byPrivacy('public')}, privé ${byPrivacy('private')}, semi-privé ${byPrivacy('semiPrivate')})`,
    );
  } catch (err) {
    line(`Indexeurs : échec (${describe(err)})`);
  }

  // 2. Titres variantes (TMDB) pour le film et la série.
  const movieTitles = await getTitleVariants(MOVIE, { tmdbToken: tmdbToken || undefined, timeoutMs: TIMEOUT_MS });
  const seriesTitles = await getTitleVariants(SERIES, { tmdbToken: tmdbToken || undefined, timeoutMs: TIMEOUT_MS });
  line(
    `Titres variantes : film ${movieTitles.titles.length} (${movieTitles.titles.join(' / ')}), série ${seriesTitles.titles.length}`,
  );

  // 3. Recherche Prowlarr brute (film), puis part d'infoHash avant/après resolveInfoHashes.
  let raw: RawStream[] = [];
  try {
    const started = Date.now();
    raw = await searchProwlarr(source, MOVIE, { titles: movieTitles, timeoutMs: TIMEOUT_MS });
    const perIndexer = [...countByIndexer(raw)].map(([name, count]) => `${name} ${count}`).join(', ') || 'aucun';
    line(`Prowlarr (film) : ${raw.length} résultats en ${elapsed(started)} ; par indexeur : ${perIndexer}`);
  } catch (err) {
    line(`Prowlarr (film) : échec (${describe(err)})`);
  }
  if (raw.length > 0) {
    const before = raw.filter((stream) => stream.infoHash !== undefined).length;
    const enriched = await resolveInfoHashes(raw, { topN: RESOLVE_TOP_N, timeoutMs: TIMEOUT_MS });
    const after = enriched.filter((stream) => stream.infoHash !== undefined).length;
    line(
      `infoHash : avant resolveInfoHashes ${before}/${raw.length} (${percent(before, raw.length)}), après ${after}/${raw.length} (${percent(after, raw.length)})`,
    );
  }

  // 4. Pipeline complet (getStreams) avec une configuration construite en mémoire.
  let config: Config | undefined;
  try {
    config = buildConfig(prowlarrKey, tmdbToken, debridKey);
  } catch (err) {
    line(`Configuration : invalide (${describe(err)})`);
  }
  if (config === undefined) {
    line(`Temps total : ${elapsed(totalStart)}`);
    return;
  }

  // Secret de signature des jetons : en mémoire, jamais affiché.
  const secret = randomBytes(32).toString('hex');
  const debrid = debridKey === '' ? undefined : new AllDebridClient(debridKey, { fetch: timedFetch(fetch) });
  const ctx: PipelineContext = {
    playBaseUrl: 'http://live-check.invalid',
    configToken: 'live-check',
    secret,
    fetch: timedFetch(fetch),
    stageTimer: (stage, ms) => stageTally.push({ stage, ms }),
    debrid,
    hosters: debrid === undefined ? undefined : new HosterClient(debrid),
    hostHealth: defaultPlayState.hostHealth,
    torrentCache: defaultPlayState.torrentCache,
    packStore: defaultPlayState.packStore,
  };

  let first: PipelineResult | undefined;
  const firstStart = Date.now();
  try {
    first = await getStreams(config, MOVIE, ctx);
    const verified = first.streams.filter((stream) => verifiedOf(stream) > 0).length;
    const grouped = first.streams.filter((stream) => copiesOf(stream) >= 2).length;
    line(`getStreams (film) : ${first.streams.length} streams finaux en ${elapsed(firstStart)}`);
    line(`  groupes avec ≥2 copies : ${grouped} ; vérifiés ✓ : ${verified} ; erreurs de source : ${first.errors.length}`);
    printTimings('film, 1er appel');
    if (first.errors.length > 0) {
      line(`  erreurs : ${first.errors.map((entry) => `${entry.source} (${entry.error})`).join(' ; ')}`);
    }
  } catch (err) {
    line(`getStreams (film) : échec (${describe(err)})`);
  }

  const secondStart = Date.now();
  try {
    requestTally = new Map();
    stageTally = [];
    const second = await getStreams(config, MOVIE, ctx);
    line(`getStreams (film, 2e appel) : ${second.streams.length} streams en ${elapsed(secondStart)}`);
  } catch (err) {
    line(`getStreams (film, 2e appel) : échec (${describe(err)})`);
  }

  printTimings('film, 2e appel');
  const seriesStart = Date.now();
  try {
    const series = await getStreams(config, SERIES, ctx);
    line(
      `getStreams (série S01E01) : ${series.streams.length} streams finaux, ${series.errors.length} erreurs de source, ${elapsed(seriesStart)}`,
    );
    printTimings('série');
  } catch (err) {
    line(`getStreams (série S01E01) : échec (${describe(err)})`);
  }

  // 5. Lecture : jeton du premier flux du film, puis résolution simulée de la copie 1.
  const firstStream = first?.streams[0];
  if (firstStream === undefined) {
    line('Lecture : aucun flux 1, simulation sautée');
  } else {
    let copy: PlayCopy | undefined;
    try {
      const match = firstStream.url === undefined ? null : /\/play\/c\/([^/?#]+)/.exec(firstStream.url);
      if (match?.[1] !== undefined) {
        const decoded = decodeCopiesToken(decodeURIComponent(match[1]), secret);
        if (decoded === null) {
          line('Jeton du flux 1 : décodage échoué');
        } else {
          copy = decoded.copies[0];
          line(`Jeton du flux 1 : décodé, ${decoded.copies.length} copie(s)`);
        }
      } else if (firstStream.infoHash !== undefined) {
        copy = { infoHash: firstStream.infoHash, fileIdx: firstStream.fileIdx };
        line('Flux 1 : infoHash direct (pas de jeton de copies)');
      } else {
        line('Flux 1 : ni jeton ni infoHash');
      }
    } catch (err) {
      line(`Jeton du flux 1 : échec (${describe(err)})`);
    }
    if (copy !== undefined) {
      line(`Résolution simulée de la copie 1 : ${await simulateResolve(copy, debrid)}`);
    }
  }

  line(`Temps total : ${elapsed(totalStart)}`);
}

main().catch((err: unknown) => {
  line(`erreur inattendue : ${describe(err)}`);
  process.exitCode = 1;
});
