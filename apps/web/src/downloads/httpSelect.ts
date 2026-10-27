/* Transport HTTP des téléchargements selon la plateforme (LAST-182).
 * Coque Windows : `fetch` du WebView2 est soumis à CORS, et les hôtes des débrideurs ne l'autorisent pas (BLOCKED_STATUS).
 * Leurs liens passent donc par le pont natif de la coque (plages bornées, comme la lecture : relay/sources.ts).
 * Les liens directs d'addon aussi (LAST-501) : ils redirigent souvent vers un débrideur, ce que `fetch` refuse (CORS). Seuls ceux
 * qu'accepte le transfert natif (`isNativeLinkUrl` : https:443, sans identifiants, hôte public) partent au pont, qui revalide chaque
 * redirection ; les autres restent sur `fetch`, qui les refuse. Android et web : `fetch`, inchangé.
 * Réponses du pont : un statut HTTP refusé (`bad_status`, 4xx/5xx) est rendu tel quel à transfer.ts (lien périmé, réseau) ; un refus
 * définitif (hôte, redirection, plage, taille, méthode) est un blocage (BLOCKED_STATUS, classé `content`) ; le reste (délai, réseau,
 * occupé, morceau invalide) reste une exception transitoire. Aucun lien dans les erreurs ni dans les journaux. */
import { parseDebridUrl } from '../sources/debrid/hosts';
import { shellHttp, type HttpFn, type HttpResponse } from '../sources/debrid/http';
import { shellRangeHttp } from '../sources/debrid/nativeRange';
import { DebridError } from '../sources/debrid/types';
import { isAddonLinkUrl, isNativeLinkUrl } from './linkHosts';
import { BLOCKED_STATUS, createWebDownloadHttp } from './webHttp';

/** Plateforme qui choisit le transport. `shell` seulement sans transfert de plateforme enregistré (voir service.ts). */
export type DownloadHttpKind = 'android' | 'shell' | 'web';

export interface DownloadHttpDeps {
  /** `fetch` du navigateur (défaut : global). */
  fetchImpl?: typeof fetch;
  /** Transport de la coque pour les hôtes des débrideurs (défaut : pont `native-range`, repli `native-http`). */
  shell?: HttpFn;
}

/** Délai total d'une requête au pont : le pont l'applique à toute la requête, pas à chaque morceau (une plage de 8 Mio doit tenir). */
const BRIDGE_TIMEOUT_MS = 60_000;

/** Refus définitifs du pont : rendus comme blocage, jamais réessayés. */
const BLOCKING_CODES: ReadonlySet<string> = new Set(['host_not_allowed', 'redirect_not_allowed', 'range_unsupported', 'too_large', 'method_not_allowed']);

/** Statut d'erreur HTTP (4xx ou 5xx) : seul statut du pont rendu tel quel. Un 2xx ou 3xx ne l'est jamais (un corps vide serait lu comme fin de fichier). */
const isErrorStatus = (status: number | undefined): status is number => status !== undefined && status >= 400 && status <= 599;

const responseOf = (status: number): HttpResponse => ({ status, headers: {}, body: new Uint8Array(0) });

/** Erreur du pont → réponse quand elle est définitive ; sinon l'exception d'origine, transitoire (réessayée par le gestionnaire). */
function bridgeOutcome(err: unknown): HttpResponse {
  if (err instanceof DebridError) {
    if (err.code === 'bad_status' && isErrorStatus(err.status)) return responseOf(err.status);
    if (BLOCKING_CODES.has(err.code)) return responseOf(BLOCKED_STATUS);
  }
  throw err;
}

/** Pont natif : délai total par requête (60 s par défaut, `req.timeoutMs` s'il est donné), erreurs définitives rendues en réponse. */
function bridgeTransport(bridge: HttpFn): HttpFn {
  return async (req) => {
    try {
      return await bridge({ ...req, timeoutMs: req.timeoutMs ?? BRIDGE_TIMEOUT_MS });
    } catch (err) {
      return bridgeOutcome(err);
    }
  };
}

/** Lien lu par le pont de la coque : hôte de débrideur, ou lien direct d'addon accepté par le transfert natif. */
function viaBridge(raw: string): boolean {
  if (parseDebridUrl(raw) !== null) return true;
  try {
    return isNativeLinkUrl(new URL(raw));
  } catch {
    return false;
  }
}

export function createDownloadHttp(kind: DownloadHttpKind, deps: DownloadHttpDeps = {}): HttpFn {
  const web = createWebDownloadHttp({ allowHost: isAddonLinkUrl, fetchImpl: deps.fetchImpl });
  if (kind !== 'shell') return web;
  const bridge = bridgeTransport(deps.shell ?? shellRangeHttp(shellHttp()));
  return (req) => (viaBridge(req.url) ? bridge(req) : web(req));
}
