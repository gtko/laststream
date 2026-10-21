import { pruneStreams, type TvCatalog } from './tv-catalog.js';

/**
 * Test de santé des flux de la TV en direct (Cron du Worker, sans AllDebrid ni aucun service tiers) : pour chaque URL,
 * lecture du manifeste HLS puis d'un morceau du premier segment. Un flux en échec plusieurs passages de suite est retiré
 * du catalogue public ; il y revient dès qu'un passage suivant réussit (les flux retirés restent sondés).
 *
 * Le test part des IP de Cloudflare, parfois hors de France : un refus d'accès (401, 403, 429, 451) peut être un
 * géoblocage et ne compte donc ni comme une panne ni comme un succès.
 */

export type StreamVerdict = 'ok' | 'down' | 'unknown';

/** url → [échecs consécutifs, date du dernier contrôle en s]. */
export type HealthMap = Record<string, [number, number]>;

const HEADERS = { 'user-agent': 'Mozilla/5.0 Laststream', accept: '*/*' };
const REQUEST_TIMEOUT_MS = 8000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const SEGMENT_RANGE = 'bytes=0-1023';
const MAX_PLAYLIST_DEPTH = 2;
/** Refus qui peuvent venir du lieu de l'appel (géoblocage, jeton, limite de débit) : sans verdict. */
const INCONCLUSIVE_STATUS = new Set([401, 403, 407, 429, 451]);

function statusVerdict(status: number): StreamVerdict {
  if (status < 400) return 'ok';
  return INCONCLUSIVE_STATUS.has(status) ? 'unknown' : 'down';
}

const startsWithManifest = (bytes: Uint8Array): boolean => {
  const text = new TextDecoder().decode(bytes.subarray(0, 16));
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart().startsWith('#EXTM3U');
};

/**
 * Début du corps : le premier morceau seulement, sauf pour un manifeste HLS lu jusqu'à `MAX_MANIFEST_BYTES`.
 * Le flux est fermé dans tous les cas (un direct n'a pas de fin).
 */
async function readStart(res: Response): Promise<{ bytes: Uint8Array; manifest: boolean }> {
  const reader = res.body?.getReader();
  if (reader === undefined) return { bytes: new Uint8Array(), manifest: false };
  try {
    const first = await reader.read();
    if (first.done || first.value.byteLength === 0) return { bytes: new Uint8Array(), manifest: false };
    if (!startsWithManifest(first.value)) return { bytes: first.value, manifest: false };
    const parts: Uint8Array[] = [first.value];
    let size = first.value.byteLength;
    while (size < MAX_MANIFEST_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      size += next.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return { bytes, manifest: true };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Première URI de variante (manifeste maître) ou de segment (manifeste média). */
function firstUri(text: string): { uri: string; master: boolean } | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const master = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'));
  let afterVariant = !master;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) afterVariant = true;
    else if (line !== '' && !line.startsWith('#') && afterVariant) return { uri: line, master };
  }
  return undefined;
}

/** Octets d'une page (HTML, JSON) plutôt que d'un média : les CDN servent des segments sous n'importe quel type MIME. */
function looksLikePage(bytes: Uint8Array, type: string): boolean {
  if (type.includes('text/html')) return true;
  const first = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().charAt(0);
  return first === '<' || first === '{';
}

/** AllDebrid suspend les comptes appelés depuis des IP de serveurs : aucun appel vers ses hôtes, jamais. */
const FORBIDDEN_HOST = /(^|\.)(alldebrid\.[a-z]+|debrid\.it)$/i;
const forbidden = (href: string): boolean => {
  try {
    return FORBIDDEN_HOST.test(new URL(href).hostname);
  } catch {
    return false;
  }
};

async function inspect(fetcher: typeof fetch, url: string, depth: number): Promise<StreamVerdict> {
  if (forbidden(url)) return 'unknown';
  const res = await fetcher(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => undefined);
    return statusVerdict(res.status);
  }
  if (forbidden(res.url)) {
    await res.body?.cancel().catch(() => undefined);
    return 'unknown';
  }
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const { bytes, manifest } = await readStart(res);
  if (!manifest) {
    // Flux direct (TS, audio, DASH…) : un contenu non vide qui n'est pas une page d'erreur.
    return bytes.byteLength > 0 && !looksLikePage(bytes, type) ? 'ok' : 'down';
  }
  const next = firstUri(new TextDecoder().decode(bytes));
  if (next === undefined) return 'down'; // manifeste sans segment
  let target: URL;
  try {
    target = new URL(next.uri, res.url || url);
  } catch {
    return 'down';
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return 'down';
  if (forbidden(target.href)) return 'unknown';
  if (next.master) return depth + 1 >= MAX_PLAYLIST_DEPTH ? 'down' : inspect(fetcher, target.href, depth + 1);
  const segment = await fetcher(target.href, {
    headers: { ...HEADERS, range: SEGMENT_RANGE },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (segment.status >= 400) {
    await segment.body?.cancel().catch(() => undefined);
    return statusVerdict(segment.status);
  }
  const segmentType = (segment.headers.get('content-type') ?? '').toLowerCase();
  const start = await readStart(segment);
  return start.bytes.byteLength > 0 && !looksLikePage(start.bytes, segmentType) ? 'ok' : 'down';
}

/** Verdict d'un flux : ok, down (échec franc, délai, DNS, manifeste vide ou page d'erreur), unknown (refus d'accès). */
export async function checkStream(fetcher: typeof fetch, url: string): Promise<StreamVerdict> {
  try {
    return await inspect(fetcher, url, 0);
  } catch (error) {
    // Limite de sous-requêtes du Worker atteinte : ce n'est pas la faute du flux.
    return /subrequest/i.test(error instanceof Error ? error.message : '') ? 'unknown' : 'down';
  }
}

export interface HealthOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Lancer des contrôles. Faux : seuls les résultats déjà enregistrés servent au retrait. */
  check?: boolean;
  /** Échecs consécutifs avant retrait (3 passages du Cron ≈ 18 h). */
  threshold?: number;
  /** Un flux contrôlé depuis moins longtemps n'est pas recontrôlé (s). */
  ttlSec?: number;
  /** Plafond de sous-requêtes et durée maximale des contrôles d'un passage. */
  maxRequests?: number;
  budgetMs?: number;
  concurrency?: number;
}

export interface HealthResult {
  health: HealthMap;
  /** Chaînes retirées du catalogue (aucun flux vivant). */
  removed: number;
  /** URL de flux écartées (en échec au-delà du seuil). */
  dead: number;
  /** Flux contrôlés pendant ce passage. */
  checked: number;
  /** Disjoncteur : trop de pannes d'un coup (réseau du Worker en cause ?), les pannes de ce passage sont ignorées. */
  tripped: boolean;
}

/**
 * Au moins `BREAKER_MIN` flux principaux connus sains dont plus de `BREAKER_RATIO` tombent d'un coup : c'est le
 * test lui-même (réseau du Worker) qui est suspect. Les flux déjà en échec et les replis, souvent morts, ne comptent pas.
 */
const BREAKER_MIN = 20;
const BREAKER_RATIO = 0.5;

const HEALTH_THRESHOLD = 3;

/**
 * Contrôle les flux du catalogue puis retire ceux en échec depuis `threshold` contrôles consécutifs. D'abord les flux
 * principaux (jamais contrôlés, puis déjà en échec, puis les plus anciens) ; les replis (deux premiers) seulement pour
 * les chaînes dont le principal est en échec. Ce qui n'est pas contrôlé faute de budget l'est aux passages suivants.
 */
export async function applyHealth(catalog: TvCatalog, previous: HealthMap | undefined, options: HealthOptions = {}): Promise<HealthResult> {
  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
  const threshold = options.threshold ?? HEALTH_THRESHOLD;
  const ttl = options.ttlSec ?? 5 * 3600;
  const health: HealthMap = {};
  for (const channel of catalog.channels) {
    for (const url of [channel.url, ...channel.alternatives.map((alt) => alt.url)]) {
      const entry = previous?.[url];
      if (entry !== undefined) health[url] = entry;
    }
  }

  let checked = 0;
  let tripped = false;
  if (options.check === true) {
    const fetcher = options.fetch ?? fetch;
    let requests = 0;
    const counting = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests += 1;
      return fetcher(input, init);
    }) as typeof fetch;
    const maxRequests = options.maxRequests ?? 4000;
    const deadline = Date.now() + (options.budgetMs ?? 6 * 60_000);
    const stale = (url: string): boolean => {
      const entry = health[url];
      return entry === undefined || nowSec - entry[1] >= ttl;
    };
    const downs = new Map<string, [number, number] | undefined>();
    let steady = 0;
    let steadyDown = 0;
    const run = async (urls: string[], main: boolean): Promise<void> => {
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < urls.length && Date.now() < deadline && requests < maxRequests) {
          const url = urls[next++];
          if (url === undefined) break;
          const verdict = await checkStream(counting, url);
          checked += 1;
          const before = health[url];
          const fails = before?.[0] ?? 0;
          // Seuls comptent les flux connus pour fonctionner : au premier passage, un catalogue à moitié mort est normal.
          if (main && before !== undefined && fails === 0 && verdict !== 'unknown') {
            steady += 1;
            if (verdict === 'down') steadyDown += 1;
          }
          if (verdict === 'ok') health[url] = [0, nowSec];
          else if (verdict === 'down') {
            downs.set(url, before);
            health[url] = [fails + 1, nowSec];
          } else health[url] = [fails, nowSec];
        }
      };
      await Promise.all(Array.from({ length: options.concurrency ?? 16 }, () => worker()));
    };
    // Plus urgent d'abord : jamais contrôlé, puis déjà en échec (confirmation ou retour), puis le plus ancien.
    const rank = (url: string): number => {
      const entry = health[url];
      return entry === undefined ? 0 : entry[0] > 0 ? 1 : 2;
    };
    const order = (a: string, b: string): number => rank(a) - rank(b) || (health[a]?.[1] ?? 0) - (health[b]?.[1] ?? 0);
    await run([...new Set(catalog.channels.map((channel) => channel.url))].filter(stale).sort(order), true);
    const fallbacks = new Set<string>();
    for (const channel of catalog.channels) {
      if ((health[channel.url]?.[0] ?? 0) === 0) continue;
      for (const alt of channel.alternatives.slice(0, 2)) fallbacks.add(alt.url);
    }
    await run([...fallbacks].filter(stale).sort(order), false);
    if (steady >= BREAKER_MIN && steadyDown / steady > BREAKER_RATIO) {
      tripped = true;
      for (const [url, before] of downs) {
        if (before === undefined) delete health[url];
        else health[url] = before;
      }
    }
  }

  const dead = new Set(Object.entries(health).filter(([, entry]) => entry[0] >= threshold).map(([url]) => url));
  return { health, removed: pruneStreams(catalog, dead), dead: dead.size, checked, tripped };
}
