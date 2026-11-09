import { assertNotDebrid, DebridEgressBlockedError, guardedFetch } from '../egress/debrid-guard.js';
import { pruneStreams, type TvCatalog } from './tv-catalog.js';

/**
 * Test de santé des flux de la TV en direct (Cron du Worker, sans AllDebrid ni aucun service tiers) : pour chaque URL,
 * lecture du manifeste HLS puis d'un morceau du premier segment. Un flux en échec plusieurs passages de suite est retiré
 * du catalogue public ; il y revient dès qu'un passage suivant réussit (les flux retirés restent sondés).
 *
 * Un refus d'accès (401, 403, 451) est une panne comme une autre : les flux du catalogue ne sont pas géobloqués, une chaîne
 * qui refuse le test ne se lit pas non plus chez l'utilisateur. Seuls une limite de débit (429) et un refus du proxy (407),
 * qui ne disent rien du flux, restent sans verdict.
 */

export type StreamVerdict = 'ok' | 'down' | 'unknown';

/**
 * url → [échecs consécutifs, date du dernier contrôle en s, date du dernier succès en s]. La troisième valeur n'existe
 * qu'après un premier succès ; les entrées anciennes à deux éléments restent valides.
 */
type HealthEntry = [number, number, number?];
export type HealthMap = Record<string, HealthEntry>;

const HEADERS = { 'user-agent': 'Mozilla/5.0 Laststream', accept: '*/*' };
const REQUEST_TIMEOUT_MS = 8000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const SEGMENT_RANGE = 'bytes=0-1023';
const MAX_PLAYLIST_DEPTH = 2;
/** Réponses qui ne disent rien du flux (limite de débit, proxy) : sans verdict. */
const INCONCLUSIVE_STATUS = new Set([407, 429]);

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

/**
 * AllDebrid suspend les comptes appelés depuis des IP de serveurs : aucun appel vers ses hôtes, jamais. La garde de
 * sortie (egress/debrid-guard.ts) refuse et signale l'incident à Sentry ; le flux reste sans verdict.
 */
const forbidden = (href: string): boolean => {
  try {
    assertNotDebrid(href, 'tv-health');
    return false;
  } catch (error) {
    if (error instanceof DebridEgressBlockedError) return true;
    throw error;
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

/** Verdict d'un flux : ok, down (échec franc, refus d'accès, délai, DNS, manifeste vide ou page d'erreur), unknown (limite de débit). */
export async function checkStream(fetcher: typeof fetch, url: string): Promise<StreamVerdict> {
  try {
    // Garde de sortie : chaque saut (redirections comprises) est contrôlé avant l'envoi.
    return await inspect(guardedFetch(fetcher, 'tv-health'), url, 0);
  } catch (error) {
    // Hôte de débridage refusé par la garde (déjà signalé) : le flux n'est pas en cause.
    if (error instanceof DebridEgressBlockedError) return 'unknown';
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
  /** Bilan du passage, gardé dans probe.json (tv-build.ts). */
  report: HealthReport;
}

export interface HealthChange {
  id: string;
  name: string;
}

/** Bilan d'un passage de contrôle : chaînes retirées (état courant du catalogue) et chaînes remises pendant ce passage. */
export interface HealthReport {
  /** Date du passage, en ms. */
  at: number;
  /** Flux contrôlés pendant ce passage. */
  checked: number;
  /** Disjoncteur déclenché : les pannes de ce passage ont été ignorées (listes après retour arrière). */
  tripped: boolean;
  /** Chaînes absentes du catalogue : aucun flux vivant (principal ni repli). */
  removed: HealthChange[];
  /** Chaînes présentes dont le flux principal était écarté avant ce passage et ne l'est plus. */
  restored: HealthChange[];
}

/** Entrée de santé : la date du dernier succès n'est écrite qu'une fois connue (entrées anciennes inchangées). */
const entryOf = (fails: number, checkedAt: number, lastOk: number | undefined): HealthEntry =>
  lastOk === undefined ? [fails, checkedAt] : [fails, checkedAt, lastOk];

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
  const nowMs = (options.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
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
    const downs = new Map<string, HealthEntry | undefined>();
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
          if (verdict === 'ok') health[url] = [0, nowSec, nowSec];
          else if (verdict === 'down') {
            downs.set(url, before);
            health[url] = entryOf(fails + 1, nowSec, before?.[2]);
          } else health[url] = entryOf(fails, nowSec, before?.[2]); // refus d'accès : ni échec ni succès
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
  // Avant le retrait : pruneStreams modifie les chaînes en place (repli promu comme flux principal).
  const entering = catalog.channels.map((channel) => ({ id: channel.id, name: channel.name, url: channel.url }));
  const removed = pruneStreams(catalog, dead);
  const surviving = new Set(catalog.channels.map((channel) => channel.id));
  const failedBefore = (url: string): boolean => (previous?.[url]?.[0] ?? 0) >= threshold;
  const report: HealthReport = {
    at: nowMs,
    checked,
    tripped,
    removed: entering.filter((c) => !surviving.has(c.id)).map(({ id, name }) => ({ id, name })),
    restored: entering.filter((c) => surviving.has(c.id) && failedBefore(c.url) && !dead.has(c.url)).map(({ id, name }) => ({ id, name })),
  };
  return { health, removed, dead: dead.size, checked, tripped, report };
}
