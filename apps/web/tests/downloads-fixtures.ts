// Sources de test des téléchargements (ODY-204) : flux Stremio construits comme lastAddon les livre, sans réseau.
import type { Stream } from '../src/data/stream';
import { toSourceView, type SourceView } from '../src/sources/info';

/** Lien d'addon avec une clé de débrideur : il ne doit jamais sortir du gestionnaire. */
export const HTTP_URL = 'https://media.example.test/films/dune.mkv?apikey=cle-secrete-123';
export const HLS_URL = 'https://media.example.test/live/dune/index.m3u8?apikey=cle-secrete-123';

export interface StreamOpts {
  /** Nom de l'addon affiché avant la qualité (« Lumio »). */
  origin?: string;
  resolution?: '2160p' | '1080p' | '720p' | '480p' | 'SD';
  languages?: string[];
  filename?: string;
  size?: number;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
}

/** Flux HTTP(S) d'un addon (lien direct, sans torrent). */
export function httpStream(o: StreamOpts = {}): Stream {
  const resolution = o.resolution ?? '1080p';
  return {
    name: o.origin ? `${o.origin}\n${resolution}` : resolution,
    url: o.url ?? HTTP_URL,
    ...(o.infoHash ? { infoHash: o.infoHash } : {}),
    ...(o.fileIdx !== undefined ? { fileIdx: o.fileIdx } : {}),
    laststream: {
      resolution,
      height: resolution === '2160p' ? 2160 : resolution === '720p' ? 720 : 1080,
      source: 'WEB-DL',
      codec: 'h264',
      hdr: [],
      languages: o.languages ?? ['fr'],
      cached: false,
      score: 50,
      estBitrateKbps: 8000,
      ...(o.filename !== undefined ? { filename: o.filename } : {}),
      ...(o.size !== undefined ? { sizeBytes: o.size } : {}),
    },
  };
}

/** Torrent livré sans lien (`lastDebrid = "client"`) : débridé sur l'appareil seulement. */
export function clientStream(infoHash: string, o: StreamOpts = {}): Stream {
  return {
    name: o.origin ? `${o.origin}\n1080p` : '1080p',
    infoHash,
    behaviorHints: { lastDebrid: 'client' },
    laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'h264', hdr: [], languages: ['fr'], cached: false, score: 50, estBitrateKbps: 8000 },
  };
}

export function viewOf(stream: Stream, index = 0): SourceView {
  return toSourceView(stream, index);
}
