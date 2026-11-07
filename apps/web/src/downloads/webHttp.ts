/* Transport HTTP des téléchargements web (ODY-199) : `fetch` du navigateur, lien débridé lu par plages depuis l'appareil.
 * Ce que le web impose, et que `fetchChunks` (transfer.ts) ne sait pas voir seul :
 *  - CORS : sans `Access-Control-Allow-Origin`, `fetch` lève la même erreur qu'une coupure. Un sondage `no-cors` les distingue :
 *    si l'hôte répond (réponse opaque), le navigateur bloque le lien ; on répond alors `BLOCKED_STATUS` (jamais retenté,
 *    `DownloadError('content')`), au lieu de gaspiller les tentatives réseau ;
 *  - `Content-Range` et `ETag` ne sont lisibles qu'avec `Access-Control-Expose-Headers` : à défaut, `Content-Range` est déduit
 *    de la plage demandée (taille inconnue) ; sans `ETag`, la reprise se valide par `Content-Range` seul ;
 *  - un serveur sans `Range` répond 200 avec tout le fichier : la lecture s'arrête sur les en-têtes (`content-length`) ou dès
 *    que le plafond `MAX_FULL_BODY_BYTES` est dépassé, jamais de fichier entier en mémoire.
 * Seuls les hôtes des débrideurs sont contactés (`allowHost` pour les tests). Ni lien, ni corps, ni en-tête n'est journalisé. */
import { parseDebridUrl } from '../sources/debrid/hosts';
import { MAX_FULL_BODY_BYTES, type HttpFn } from './types';

/** Statut synthétique : le navigateur ne peut pas lire ce lien (hôte refusé, CORS) ; `fetchChunks` le classe en `content`. */
export const BLOCKED_STATUS = 0;
/** Statut synthétique d'un lien que le navigateur ne peut plus lire en cours de téléchargement : `fetchChunks` le classe `link_expired` (le lien est re-résolu). */
const EXPIRED_STATUS = 410;

/** Sans octet reçu pendant ce délai, la requête est abandonnée (réseau coupé sans erreur, ex. veille de l'appareil). */
const IDLE_TIMEOUT_MS = 30_000;

export interface WebHttpOptions {
  fetchImpl?: typeof fetch;
  /** Hôtes autorisés ; par défaut ceux des débrideurs, en https. */
  allowHost?: (url: URL) => boolean;
  idleTimeoutMs?: number;
  /** `navigator.onLine` (injectable) : hors ligne, une erreur de `fetch` est une coupure, pas un blocage CORS. */
  online?: () => boolean;
}

/** Même règle que le reste de l'app : https, domaine de débrideur, ni identifiants ni port atypique. */
const defaultAllow = (url: URL): boolean => parseDebridUrl(url.href) !== null;

const blocked = (status = BLOCKED_STATUS): { status: number; headers: Record<string, string>; body: Uint8Array } => ({
  status,
  headers: {},
  body: new Uint8Array(0),
});

const concat = (parts: Uint8Array[], total: number): Uint8Array => {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function createWebDownloadHttp(opts: WebHttpOptions = {}): HttpFn {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const allow = opts.allowHost ?? defaultAllow;
  const allowedUrl = (raw: string): boolean => {
    try {
      return allow(new URL(raw));
    } catch {
      return false;
    }
  };
  const idleMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const online = opts.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);

  /** L'hôte répond-il à une requête `no-cors` ? Alors c'est CORS qui bloque la lecture. */
  const reachable = async (url: string, signal: AbortSignal | undefined): Promise<boolean> => {
    const probe = new AbortController();
    const onAbort = (): void => probe.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => probe.abort(), idleMs);
    try {
      await fetchImpl(url, { mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: probe.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      probe.abort(); // le corps du fichier n'est jamais lu
    }
  };

  return async (req) => {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      return blocked();
    }
    if (!allow(parsed)) return blocked();

    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort();
    if (req.signal?.aborted) throw new Error('aborted');
    req.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? idleMs);
    };

    try {
      arm();
      const asked = /^bytes=(\d+)-/.exec(req.headers?.Range ?? req.headers?.range ?? '');
      const send = (): Promise<Response> =>
        fetchImpl(req.url, {
          method: req.method ?? 'GET',
          headers: req.headers,
          body: req.body,
          signal: ctl.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        });
      let res: Response;
      try {
        res = await send();
      } catch (err) {
        // Une erreur de `fetch` (TypeError) dont l'hôte répond pourtant au sondage `no-cors` : CORS refuse la lecture. Au premier
        // morceau c'est un blocage définitif ; plus tard l'hôte autorisait CORS, c'est donc un lien périmé (réponse d'erreur sans
        // en-têtes CORS) à re-résoudre. Annulation, délai ou hors ligne n'en sont pas. L'hôte doit répondre au sondage ET refuser
        // une seconde fois la vraie requête.
        const firstChunk = !asked || Number(asked[1]) === 0;
        if (req.signal?.aborted || !(err instanceof TypeError) || !online() || !(await reachable(req.url, req.signal))) throw err;
        try {
          res = await send();
        } catch (again) {
          if (req.signal?.aborted || !(again instanceof TypeError)) throw again;
          return blocked(firstChunk ? BLOCKED_STATUS : EXPIRED_STATUS);
        }
      }

      // Une redirection ne doit pas mener hors des hôtes autorisés : le corps n'est pas lu.
      if (res.url !== '' && !allowedUrl(res.url)) {
        ctl.abort();
        return blocked();
      }

      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

      // Serveur sans `Range` : on ne lit pas un fichier entier plus gros que le plafond.
      const declared = Number(headers['content-length']);
      if (res.status === 200 && asked && declared > MAX_FULL_BODY_BYTES) {
        ctl.abort();
        return { status: 200, headers, body: new Uint8Array(0) };
      }

      const reader = res.body?.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          parts.push(value);
          total += value.length;
          if (res.status === 200 && asked && total > MAX_FULL_BODY_BYTES) {
            ctl.abort();
            return { status: 200, headers: { ...headers, 'content-length': String(total) }, body: new Uint8Array(0) };
          }
        }
      }
      const body = parts.length === 0 ? new Uint8Array(0) : concat(parts, total);

      // En-têtes non exposés par CORS : déduits de la plage demandée (la taille du fichier reste inconnue).
      if (asked) {
        const first = Number(asked[1]);
        if (res.status === 206 && headers['content-range'] === undefined && body.length > 0) {
          headers['content-range'] = `bytes ${first}-${first + body.length - 1}/*`;
        } else if (res.status === 416 && headers['content-range'] === undefined) {
          headers['content-range'] = `bytes */${first}`;
        }
      }
      return { status: res.status, headers, body };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  };
}
