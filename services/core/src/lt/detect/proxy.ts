import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type EnvLike, platform, runtimeEnv } from '../../platform/index.js';
import { isLiteralSafe } from '../guard.js';
import type { LocalUrlPolicy } from './media-url.js';

/** Plafond d'octets téléchargés par job : 400 Mo par défaut (audio entrelacé avec la vidéo), LASTADDON_SKIP_DETECT_MAX_MB le règle. */
export const DEFAULT_JOB_MB = 400;

export function jobByteBudget(env: EnvLike = runtimeEnv().all()): number {
  const mb = Number(env.LASTADDON_SKIP_DETECT_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_JOB_MB) * 1024 * 1024;
}
const MAX_HOPS = 4;

/** Compteur d'octets partagé par toutes les sources d'un job. */
export class ByteBudget {
  used = 0;
  exceeded = false;
  constructor(readonly limit: number = jobByteBudget()) {}
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

export interface SourceProxy {
  /** URL locale à donner à ffmpeg/ffprobe : l'URL réelle (et son jeton) ne figure jamais dans leurs arguments. */
  url: string;
  close(): Promise<void>;
}

const FORWARDED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const REDIRECT = new Set([301, 302, 303, 307, 308]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function serve(
  target: URL,
  budget: ByteBudget,
  allowLocal: LocalUrlPolicy,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const headers: Record<string, string> = { 'user-agent': 'lastaddon-skip-detect' };
  const range = headerValue(req.headers.range);
  if (range !== undefined) headers.range = range;
  let url = target;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    // Chaque saut est revérifié (littéral ici, DNS à la connexion par l'agent épinglé).
    if (!allowLocal(url) && !isLiteralSafe(url)) {
      res.writeHead(403).end();
      return;
    }
    const { http } = platform();
    if (http.stream === undefined) {
      res.writeHead(501).end();
      return;
    }
    const upstream = await http.stream(url, {
      method,
      headers,
      allowLocal: allowLocal(url),
      headersTimeoutMs: 15_000,
      bodyTimeoutMs: 20_000,
    });
    const location = headerValue(upstream.headers.location);
    if (REDIRECT.has(upstream.statusCode) && location !== undefined) {
      await upstream.dump();
      url = new URL(location, url);
      continue;
    }
    const out: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = headerValue(upstream.headers[name]);
      if (value !== undefined) out[name] = value;
    }
    res.writeHead(upstream.statusCode, out);
    if (method === 'HEAD') {
      await upstream.dump();
      res.end();
      return;
    }
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        budget.used += chunk.length;
        if (budget.used > budget.limit) {
          budget.exceeded = true;
          callback(new Error('budget'));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(upstream.body, counter, res);
    return;
  }
  res.writeHead(502).end();
}

/**
 * Relais local qui compte les octets lus : ffmpeg lit http://127.0.0.1:port/ (Range transmis), le relais suit les
 * redirections avec contrôle d'adresse et coupe la lecture quand le budget du job est épuisé.
 */
export async function openSource(target: URL, budget: ByteBudget, allowLocal: LocalUrlPolicy): Promise<SourceProxy> {
  const server: Server = createServer((req, res) => {
    serve(target, budget, allowLocal, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/media`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
