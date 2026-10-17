import { type HostHealth, hostFromUrl } from '../play/hosts.js';
import type { HosterClient, LinkInfo } from '../sources/hosters.js';
import type { Candidate } from './types.js';

/** Étape de vérification des liens d'hébergeurs, placée avant le moteur (filtre, classement). */
export interface HosterStepOptions {
  client: Pick<HosterClient, 'getHosts' | 'hosterFor' | 'linkInfos'>;
  /** Nombre maximal de liens d'hébergeur contrôlés (les premiers de la liste reçue). Défaut 8. */
  topN?: number;
  /** Hôtes marqués en panne : leurs candidats sont écartés sans contrôle. */
  hostHealth?: Pick<HostHealth, 'isDown'>;
  /** Budget total de l'étape, en millisecondes. Défaut 5 000. Dépassé : liste reçue inchangée. */
  budgetMs?: number;
}

const DEFAULT_TOP_N = 8;
const DEFAULT_BUDGET_MS = 5_000;

/** Ce qui est décidé pour un candidat d'hébergeur avant le contrôle réseau. */
interface HosterCandidate {
  index: number;
  url: string;
  hoster: string;
}

/**
 * Vérifie les liens d'hébergeurs (AllDebrid /v4/link/infos) et les enrichit : nom de fichier, taille, hébergeur,
 * `directVerified` pour les liens vivants. Un lien mort est retiré ; un hôte marqué en panne est écarté.
 * Les candidats sans lien d'hébergeur, les liens au-delà de topN et les liens dont le contrôle a échoué restent
 * inchangés. Les candidats reçus ne sont jamais modifiés. Ne lève jamais.
 */
export async function enrichHosterLinks(cands: Candidate[], opts: HosterStepOptions): Promise<Candidate[]> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  return withBudget(() => enrich(cands, opts, topN), budgetMs, cands);
}

async function enrich(cands: Candidate[], opts: HosterStepOptions, topN: number): Promise<Candidate[]> {
  const { client, hostHealth } = opts;
  if (!cands.some((cand) => typeof cand.raw.url === 'string')) return cands;

  try {
    await client.getHosts();
  } catch {
    return cands;
  }

  const dropped = new Set<number>();
  const toCheck: HosterCandidate[] = [];
  cands.forEach((cand, index) => {
    const url = cand.raw.url;
    if (url === undefined) return;
    const hoster = client.hosterFor(url);
    if (hoster === undefined) return;
    const host = hostFromUrl(url);
    if (host !== undefined && hostHealth?.isDown(host) === true) {
      dropped.add(index);
      return;
    }
    if (toCheck.length < topN) toCheck.push({ index, url, hoster: hoster.name });
  });
  if (dropped.size === 0 && toCheck.length === 0) return cands;

  const infos = toCheck.length > 0 ? await client.linkInfos(toCheck.map((item) => item.url)) : new Map<string, LinkInfo>();
  const checked = new Map<number, { info: LinkInfo; hoster: string }>();
  for (const item of toCheck) {
    const info = infos.get(item.url);
    if (info !== undefined) checked.set(item.index, { info, hoster: item.hoster });
  }

  const out: Candidate[] = [];
  cands.forEach((cand, index) => {
    if (dropped.has(index)) return;
    const verdict = checked.get(index);
    if (verdict === undefined) {
      out.push(cand);
      return;
    }
    if (!verdict.info.alive) return;
    out.push(verified(cand, verdict.info, verdict.hoster));
  });
  return out;
}

/** Copie du candidat enrichie par le contrôle ; les champs déjà renseignés par le parseur ne sont pas écrasés. */
function verified(cand: Candidate, info: LinkInfo, hoster: string): Candidate {
  const raw = { ...cand.raw };
  if (raw.filename === undefined && info.filename !== undefined) raw.filename = info.filename;
  if (raw.sizeBytes === undefined && info.size !== undefined) raw.sizeBytes = info.size;
  const parsed =
    cand.parsed.sizeBytes === undefined && info.size !== undefined ? { ...cand.parsed, sizeBytes: info.size } : cand.parsed;
  return { ...cand, raw, parsed, directVerified: true, hoster };
}

/** Résout `work` au plus tard après `budgetMs` ; sinon, ou en cas d'erreur, `fallback`. Ne rejette jamais. */
function withBudget<T>(work: () => Promise<T>, budgetMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), budgetMs);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
