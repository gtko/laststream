import { isLiteralSafe } from '../../lt/guard.js';
import { UnsafeTargetError } from '../../sources/http.js';
import type { HttpClient } from '../types.js';

/** DNS sur HTTPS (Cloudflare) : un Worker n'a pas de résolveur système. */
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 3000;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

interface DohAnswer {
  Answer?: { type: number; data: string }[];
}

async function query(hostname: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) });
  if (!response.ok) throw new Error('résolution DNS refusée');
  const body = (await response.json()) as DohAnswer;
  const wanted = type === 'A' ? DNS_TYPE_A : DNS_TYPE_AAAA;
  return (body.Answer ?? []).filter((answer) => answer.type === wanted).map((answer) => answer.data);
}

/** Adresses (IPv4 et IPv6) d'un hôte, par DNS sur HTTPS. */
async function resolveHost(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([query(hostname, 'A'), query(hostname, 'AAAA').catch(() => [])]);
  return [...v4, ...v6];
}

/** Cible littéralement sûre ? (schéma http(s), pas d'identifiants, pas d'IP privée ni de nom local). */
function assertSafe(input: Parameters<typeof fetch>[0]): void {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError();
  }
  if (!isLiteralSafe(url)) throw new UnsafeTargetError();
}

/**
 * Client HTTP d'un Worker : `fetch` de la plateforme, avec contrôle littéral de la cible (lt/guard.ts : schéma, adresse
 * IP privée, nom local) avant chaque requête. Pas d'agent à DNS épinglé : Cloudflare n'ouvre pas de connexion vers les
 * réseaux privés. Pas de relais en flux (`stream`) : il ne sert qu'à ffmpeg, absent ici.
 */
export const workersHttpClient: HttpClient = {
  fetch: (input, init) => {
    assertSafe(input);
    return fetch(input, init);
  },
  resolveHost,
  pinnedDispatcher: () => undefined,
};
