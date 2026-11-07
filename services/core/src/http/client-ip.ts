import type { Ctx } from './app-env.js';

/** Adresse du client vue par l'hôte : socket entrante (adaptateur Node) ou IP fournie par Cloudflare ; undefined sinon (requête simulée). */
function socketAddress(c: Ctx): string | undefined {
  return c.env?.incoming?.socket?.remoteAddress ?? c.env?.clientIp;
}

/**
 * IP du client derrière `hops` relais de confiance : le dernier saut de X-Forwarded-For est celui qu'a ajouté le
 * relais le plus proche. Sans relais de confiance, c'est l'adresse de la socket (en-têtes libres ignorés).
 */
export function clientAddress(c: Ctx, trustedHops: number): string | undefined {
  const socket = socketAddress(c);
  if (trustedHops <= 0) return socket;
  const forwarded = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .reverse();
  // Sans socket (requête simulée), la chaîne ne contient que les sauts annoncés : le premier est le plus proche.
  const chain = socket === undefined ? forwarded : [socket, ...forwarded];
  const index = socket === undefined ? trustedHops - 1 : trustedHops;
  return chain[Math.min(index, chain.length - 1)];
}
