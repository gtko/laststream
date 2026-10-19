// Hôte (RangeServer) et invité (RangeClient) reliés par un canal en mémoire : plages exactes, découpage, contrôle de flux,
// annulation, occupation, erreurs propagées sans URL, reprises, délais, cache, limites et statistiques.
import { describe, expect, it } from 'vitest';
import { RangeClient, type DownloadStats } from './guest';
import { RangeServer, type RangeSource, type UploadStats } from './host';
import { memoryChannelPair, type MemoryChannel } from './memory';
import { CHUNK_BYTES, MAX_RANGE_BYTES, RelayError, decodeFrame, encodeReq, toBytes, type RelayFrame } from './protocol';

const MIB = 1024 * 1024;

/** Octets pseudo-aléatoires déterministes (xorshift32). */
function seededBytes(n: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function mismatches(got: Uint8Array, want: Uint8Array, offset = 0): number {
  let bad = 0;
  for (let i = 0; i < got.byteLength; i += 1) if (got[i] !== want[offset + i]) bad += 1;
  return bad;
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('délai du test dépassé');
    await new Promise((r) => setTimeout(r, 2));
  }
}

interface SourceOpts {
  delayMs?: number;
  failReads?: number;
  error?: () => Error;
  mime?: string;
  sizeFails?: boolean;
}

function fakeSource(bytes: Uint8Array, opts: SourceOpts = {}): { source: RangeSource; calls: { reads: number } } {
  const calls = { reads: 0 };
  let failures = opts.failReads ?? 0;
  const source: RangeSource = {
    mime: opts.mime,
    size: async () => {
      if (opts.sizeFails) throw new Error('https://example.invalid/size');
      return bytes.byteLength;
    },
    read: async (start: number, end: number) => {
      calls.reads += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (failures > 0) {
        failures -= 1;
        throw opts.error ? opts.error() : new Error('échec de lecture');
      }
      return bytes.slice(start, end);
    },
  };
  return { source, calls };
}

function link(source: RangeSource, serverOpts: ConstructorParameters<typeof RangeServer>[2] = {}, clientOpts: ConstructorParameters<typeof RangeClient>[1] = {}, latencyMs = 0) {
  const [hostCh, guestCh] = memoryChannelPair(latencyMs);
  const server = new RangeServer(source, hostCh, serverOpts);
  const client = new RangeClient(guestCh, { retryDelayMs: 1, ...clientOpts });
  return { hostCh, guestCh, server, client };
}

describe('plages de bout en bout', () => {
  it('fichier de 3 Mo : lecture complète exacte octet par octet, taille et type via INFO', async () => {
    const bytes = seededBytes(3 * MIB);
    const { source } = fakeSource(bytes, { mime: 'video/mp4' });
    const { client } = link(source);
    expect(await client.size()).toBe(3 * MIB);
    expect(await client.info()).toEqual({ size: 3 * MIB, mime: 'video/mp4' });
    const got = await client.read(0, bytes.byteLength);
    expect(got.byteLength).toBe(bytes.byteLength);
    expect(mismatches(got, bytes)).toBe(0);
  });

  it('plage partielle découpée en requêtes de 1 Mo : exacte', async () => {
    const bytes = seededBytes(3 * MIB, 42);
    const { source } = fakeSource(bytes);
    const { client } = link(source, {}, { requestBytes: MIB });
    const got = await client.read(1000, 2_500_000);
    expect(got.byteLength).toBe(2_500_000 - 1000);
    expect(mismatches(got, bytes, 1000)).toBe(0);
  });

  it('contrôle de flux : tampon d’envoi borné, reprise à bufferedamountlow, données exactes', async () => {
    const bytes = seededBytes(3 * MIB, 7);
    const { source } = fakeSource(bytes);
    const { hostCh, client } = link(source, { highWaterBytes: MIB, lowWaterBytes: 256 * 1024 }, {}, 1);
    const got = await client.read(0, bytes.byteLength);
    expect(mismatches(got, bytes)).toBe(0);
    expect(hostCh.peakBuffered).toBeLessThanOrEqual(MIB + CHUNK_BYTES + 64);
    expect(hostCh.lowEvents).toBeGreaterThan(0);
  });
});

describe('format des données', () => {
  it('DATA : morceaux de 64 Ko, offsets contigus, drapeau de fin sur le dernier seulement', async () => {
    const bytes = seededBytes(300_000, 3);
    const { source } = fakeSource(bytes);
    const [hostCh, guestCh] = memoryChannelPair(0);
    new RangeServer(source, hostCh);
    const frames: RelayFrame[] = [];
    guestCh.addEventListener('message', (ev) => {
      const f = decodeFrame(toBytes(ev.data) ?? new Uint8Array(0));
      if (f) frames.push(f);
    });
    guestCh.send(encodeReq(7, 0, 200_000));
    await until(() => frames.some((f) => f.t === 'data' && f.fin));
    const data = frames.filter((f): f is Extract<RelayFrame, { t: 'data' }> => f.t === 'data');
    expect(data.map((f) => f.payload.byteLength)).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 200_000 - 3 * CHUNK_BYTES]);
    let expectOffset = 0;
    for (const f of data) {
      expect(f.reqId).toBe(7);
      expect(f.offset).toBe(expectOffset);
      expect(f.fin).toBe(expectOffset + f.payload.byteLength === 200_000);
      expect(mismatches(f.payload, bytes, expectOffset)).toBe(0);
      expectOffset += f.payload.byteLength;
    }
    expect(expectOffset).toBe(200_000);
  });

  it('requêtes invalides : too_large au-delà de 8 Mo, bad_request pour une plage vide', async () => {
    const { source } = fakeSource(seededBytes(1000));
    const [hostCh, guestCh] = memoryChannelPair(0);
    new RangeServer(source, hostCh);
    const replies: RelayFrame[] = [];
    guestCh.addEventListener('message', (ev) => {
      const f = decodeFrame(toBytes(ev.data) ?? new Uint8Array(0));
      if (f) replies.push(f);
    });
    guestCh.send(encodeReq(1, 0, MAX_RANGE_BYTES + 1));
    guestCh.send(encodeReq(2, 10, 10));
    await until(() => replies.length === 2);
    expect(replies).toEqual([
      { t: 'err', reqId: 1, code: 'too_large' },
      { t: 'err', reqId: 2, code: 'bad_request' },
    ]);
  });
});

describe('annulation', () => {
  it('l’invité annule : la lecture échoue en cancelled et l’hôte cesse d’envoyer', async () => {
    const bytes = seededBytes(4 * MIB, 11);
    const ctl = new AbortController();
    const { source, calls } = fakeSource(bytes, { delayMs: 5 });
    const inner = source.read;
    source.read = (start, end, signal) => {
      if (calls.reads === 1) ctl.abort();
      return inner(start, end, signal);
    };
    const { server, client } = link(source);
    await expect(client.read(0, bytes.byteLength, ctl.signal)).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => server.stats().active === 0);
    const sent = server.stats().bytesSent;
    expect(sent).toBeLessThan(bytes.byteLength);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.stats().bytesSent).toBe(sent);
  });
});

describe('occupation et erreurs', () => {
  it('hôte occupé (1 requête max) : busy sans reprise, puis réussite avec reprises', async () => {
    const bytes = seededBytes(2 * MIB, 5);
    const { source } = fakeSource(bytes, { delayMs: 20 });
    const strict = link(source, { maxConcurrent: 1 }, { retries: 0, requestBytes: MIB });
    const settled = await Promise.allSettled([strict.client.read(0, MIB), strict.client.read(MIB, 2 * MIB)]);
    expect(settled[0].status).toBe('fulfilled');
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: { code: 'busy' } });

    const patient = link(fakeSource(bytes, { delayMs: 20 }).source, { maxConcurrent: 1 }, { retries: 6, retryDelayMs: 10, requestBytes: MIB });
    const [a, b] = await Promise.all([patient.client.read(0, MIB), patient.client.read(MIB, 2 * MIB)]);
    expect(mismatches(a, bytes, 0)).toBe(0);
    expect(mismatches(b, bytes, MIB)).toBe(0);
  });

  it('erreur de source : code source propagé, aucun contenu ni URL dans le message', async () => {
    const bytes = seededBytes(10_000);
    const { source } = fakeSource(bytes, { failReads: 99, error: () => new Error('https://example.invalid/secret?token=abc') });
    const { client } = link(source, {}, { retries: 0 });
    const err = await client.read(0, 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('source');
    expect(String((err as Error).message)).not.toMatch(/example|token|secret|https?:/);
  });

  it('reprise sur erreur transitoire : la plage est complétée et exacte', async () => {
    const bytes = seededBytes(2 * MIB, 9);
    const { source, calls } = fakeSource(bytes, { failReads: 1 });
    const { client } = link(source, {}, { retries: 2, retryDelayMs: 1, requestBytes: MIB });
    const got = await client.read(0, 2 * MIB);
    expect(mismatches(got, bytes)).toBe(0);
    expect(calls.reads).toBe(3);
  });

  it('hors du fichier : out_of_range, sans reprise', async () => {
    const bytes = seededBytes(5000);
    const { source, calls } = fakeSource(bytes);
    const { client } = link(source, {}, { retries: 3 });
    await expect(client.read(0, 5001)).rejects.toMatchObject({ code: 'out_of_range' });
    expect(calls.reads).toBe(0);
  });

  it('taille inconnue côté source : INFO rejeté avec source', async () => {
    const { source } = fakeSource(seededBytes(100), { sizeFails: true });
    const { client } = link(source, {}, { retries: 0 });
    const err = await client.size().catch((e: unknown) => e);
    expect((err as RelayError).code).toBe('source');
    expect(String((err as Error).message)).not.toMatch(/example/);
  });

  it('hôte muet : délai dépassé (timeout)', async () => {
    const [, guestCh] = memoryChannelPair(0);
    const client = new RangeClient(guestCh, { timeoutMs: 30, retries: 0 });
    await expect(client.read(0, 100)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('canal fermé pendant la lecture : closed, puis toute nouvelle lecture refusée', async () => {
    const bytes = seededBytes(2 * MIB);
    const { source } = fakeSource(bytes, { delayMs: 20 });
    const { guestCh, client } = link(source);
    const pending = client.read(0, 2 * MIB);
    setTimeout(() => guestCh.close(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    await expect(client.read(0, 10)).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('cache et statistiques', () => {
  it('une plage déjà reçue (même partielle) est servie sans repasser par l’hôte', async () => {
    const bytes = seededBytes(2 * MIB, 13);
    const { source, calls } = fakeSource(bytes);
    const { client } = link(source);
    await client.read(0, 100_000);
    const reads = calls.reads;
    const again = await client.read(10, 5000);
    expect(calls.reads).toBe(reads);
    expect(mismatches(again, bytes, 10)).toBe(0);
  });

  it('statistiques : octets envoyés côté hôte, reçus côté invité, émissions onStats', async () => {
    const bytes = seededBytes(3 * MIB, 21);
    const up: UploadStats[] = [];
    const down: DownloadStats[] = [];
    const { server, client } = link(fakeSource(bytes).source, { onStats: (s) => up.push(s) }, { onStats: (s) => down.push(s) });
    await client.read(0, bytes.byteLength);
    expect(server.stats().bytesSent).toBe(bytes.byteLength);
    expect(client.stats().bytesReceived).toBe(bytes.byteLength);
    expect(up.at(-1)?.bytesSent).toBe(bytes.byteLength);
    expect(down.length).toBeGreaterThan(0);
  });
});

describe('canal', () => {
  it('un canal en mémoire respecte son tampon : bufferedAmount décompté à la livraison', async () => {
    const [a, b] = memoryChannelPair(0);
    const got: number[] = [];
    b.addEventListener('message', (ev) => got.push((toBytes(ev.data) ?? new Uint8Array(0)).byteLength));
    a.send(new Uint8Array(100));
    expect(a.bufferedAmount).toBe(100);
    await until(() => got.length === 1);
    expect(a.bufferedAmount).toBe(0);
    expect(got).toEqual([100]);
    const closedSide: MemoryChannel = a;
    closedSide.close();
    expect(() => a.send(new Uint8Array(1))).toThrow();
  });
});
