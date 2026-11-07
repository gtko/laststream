import { encodeCopiesToken, type PlayCopy } from '../play/token.js';
import type { ParsedRelease, StremioStream } from '../types.js';
import { bitrateMbps } from './filter.js';
import type { StreamOrigin } from '../types.js';
import { renderTemplate, type StreamView, type TemplateId } from './templates.js';
import { fileIdxOf, infoHashOf, isDirect, type Ranked, seedersOf, sizeOf } from './types.js';

/** Copie jouable d'un groupe : un hash (+ fichier), ou un lien d'hébergeur à débrider. */
export interface PlayableCopy {
  infoHash?: string;
  fileIdx?: number;
  /** Lien d'hébergeur (avec `hoster`) : jamais une URL directe ordinaire ni un downloadUrl. */
  url?: string;
  filename?: string;
  size?: number;
  /** Nom de l'hébergeur débridé quand `url` est un lien d'hébergeur. */
  hoster?: string;
  /** Torrent privé : guid du release (clé du cache serveur des octets .torrent). Jamais une URL ni une passkey. */
  guid?: string;
  privateTorrent?: boolean;
  cached?: boolean;
}

/** Candidat classé prêt à formater : `copies` (groupe) et `indexers` (toutes les copies) sont facultatifs. */
export interface FormatItem extends Ranked {
  copies?: PlayableCopy[];
  indexers?: string[];
  /** Provenances de toutes les copies (addons amont, indexeurs), sans doublon. */
  origins?: StreamOrigin[];
}

export interface FormatOptions {
  /** Base publique du endpoint de lecture (ex. https://addon.example.com). */
  playBaseUrl: string;
  configToken: string;
  /** Secret de signature des jetons de lecture. Ne jamais journaliser. */
  secret: string;
  /** Gabarit d'affichage (défaut : détaillé). */
  template?: TemplateId;
  /** Durée réelle du contenu en secondes : débit réel = taille / durée. */
  runtimeSeconds?: number;
  /** Âge minimum FR de la certification du contenu, si connu. */
  certificationFr?: number;
  /** Date de sortie ISO du contenu (AAAA-MM-JJ), portée par le jeton. */
  releaseDate?: string;
  maxResults: number;
  /** Vrai si le débrideur est configuré : les torrents et les liens d'hébergeur passent alors par /play. */
  hasDebrid: boolean;
  /**
   * Mode « client » : le serveur n'appelle pas AllDebrid. Un torrent est livré sans URL (infoHash, fileIdx, nom de fichier
   * et taille), marqué `behaviorHints.lastDebrid = "client"` ; l'appareil vérifie le cache et débride. Aucune URL /play.
   */
  clientDebrid?: boolean;
  season?: number;
  episode?: number;
}

/**
 * Cible de livraison : URL directe ou lecture débridée (jeton de copies, résolu par /play via AllDebrid).
 * Jamais de P2P : un stream renvoyé ne porte jamais d'infoHash à lire en direct (politique « débrideur obligatoire »).
 */
type Target =
  | { kind: 'direct'; url: string }
  | { kind: 'play'; url: string; direct: boolean }
  | { kind: 'client'; copies: PlayCopy[] };

/** Copies d'un même groupe transmises à l'appareil (au plus). */
const MAX_CLIENT_COPIES = 5;
const UPSTREAM_HINT_KEYS = ['proxyHeaders', 'headers'] as const;
/** HEVC/AV1 et audio DTS/TrueHD ne sont pas lus par les navigateurs ; les REMUX sont des conteneurs lourds. */
const NOT_WEB_READY_AUDIO = /dts|truehd/i;
const RESOLUTION_LABEL: Record<ParsedRelease['resolution'], string> = {
  '2160p': '4K',
  '1440p': '1440p',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p',
  SD: 'SD',
  unknown: '?',
};

const present = (value: string | undefined): value is string => typeof value === 'string' && value.length > 0;

/** Copies d'un candidat non groupé : la copie unique du candidat lui-même. */
function ownCopy(item: FormatItem): PlayableCopy {
  const hash = infoHashOf(item);
  const copy: PlayableCopy = {};
  if (hash !== undefined) copy.infoHash = hash;
  const fileIdx = fileIdxOf(item);
  if (fileIdx !== undefined) copy.fileIdx = fileIdx;
  if (item.hoster !== undefined && isDirect(item)) {
    copy.url = item.raw.url;
    copy.hoster = item.hoster;
  }
  const filename = item.raw.filename || item.raw.title || undefined;
  if (filename !== undefined) copy.filename = filename;
  const size = sizeOf(item);
  if (size !== undefined) copy.size = size;
  return copy;
}

/**
 * Copies portables dans le jeton, dans l'ordre reçu (le pipeline range les copies cachées d'abord) :
 * les hashes et les liens d'hébergeur. Un lien direct ordinaire n'entre pas dans le jeton. Sans doublon.
 */
function playableCopies(item: FormatItem): PlayableCopy[] {
  const source = item.copies !== undefined && item.copies.length > 0 ? item.copies : [ownCopy(item)];
  const seen = new Set<string>();
  const out: PlayableCopy[] = [];
  for (const copy of source) {
    const hoster = copy.url !== undefined && copy.hoster !== undefined;
    if (copy.infoHash === undefined && !hoster) continue;
    const key = hoster ? `url:${copy.url}` : `hash:${copy.infoHash?.toLowerCase()}:${copy.fileIdx ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(copy);
  }
  return out;
}

/** Forme du jeton pour une copie. Un fichier attendu (nom, taille) n'est porté qu'avec un index de fichier. */
function toPlayCopy(copy: PlayableCopy): PlayCopy {
  const out: PlayCopy = {};
  if (copy.infoHash !== undefined) out.infoHash = copy.infoHash;
  if (copy.fileIdx !== undefined) out.fileIdx = copy.fileIdx;
  if (copy.url !== undefined && copy.hoster !== undefined) {
    out.url = copy.url;
    out.kind = 'hoster';
  }
  if (copy.fileIdx !== undefined) {
    if (copy.filename !== undefined && copy.filename.length <= 512) out.filename = copy.filename;
    if (copy.size !== undefined && Number.isSafeInteger(copy.size)) out.size = copy.size;
  }
  if (copy.privateTorrent === true && copy.infoHash !== undefined && copy.guid !== undefined) {
    out.guid = copy.guid;
    out.privateTorrent = true;
  }
  return out;
}

/** Cible d'un candidat. Undefined si le candidat n'est livrable ni en direct, ni en P2P, ni par le débrideur. */
function targetOf(item: FormatItem, opts: FormatOptions): Target | undefined {
  const url = item.raw.url;
  // Un lien direct reste direct, sauf lien d'hébergeur débridé (lecture via AllDebrid).
  if (url !== undefined && url.length > 0 && (item.hoster === undefined || !opts.hasDebrid)) {
    return { kind: 'direct', url };
  }
  // Mode client : torrent sans URL, résolu sur l'appareil. Un torrent privé (octets du .torrent côté serveur) n'est pas livrable.
  if (opts.clientDebrid === true) {
    const copies = playableCopies(item)
      .filter((copy) => copy.infoHash !== undefined && copy.privateTorrent !== true)
      .map(toPlayCopy);
    return copies.length === 0 ? undefined : { kind: 'client', copies };
  }
  // Sans débrideur : un torrent n'est pas livrable (jamais en P2P), seuls les liens HTTP directs restent.
  if (!opts.hasDebrid) return undefined;
  const copies = playableCopies(item).map(toPlayCopy);
  if (copies.length === 0) return undefined;
  const token = encodeCopiesToken(copies, {
    secret: opts.secret,
    season: opts.season,
    episode: opts.episode,
    releasedAt: opts.releaseDate,
    ageFr: opts.certificationFr,
  });
  const base = opts.playBaseUrl.replace(/\/+$/, '');
  const playUrl = `${base}/${encodeURIComponent(opts.configToken)}/play/c/${encodeURIComponent(token)}`;
  // Lien d'hébergeur : statut « lien direct » ; un torrent débridé reste un flux AllDebrid.
  return { kind: 'play', url: playUrl, direct: item.hoster !== undefined };
}

/** Langue audio : annoncée par le nom de release, vérifiée si la sonde l'a confirmée. */
function languagesOf(item: FormatItem): StreamView['languages'] {
  const verified = new Set(item.verifiedLanguages ?? []);
  const codes = [...new Set<string>([...item.parsed.languages, ...verified])];
  return codes.map((code) => ({ code, verified: verified.has(code) }));
}

/** Préférence du canal et des formats audio, en texte court : « 5.1 DDP ». Undefined si rien. */
function audioLabelOf(item: FormatItem): string | undefined {
  const label = [item.parsed.channels, ...item.parsed.audio].filter(present).join(' ');
  return label.length > 0 ? label : undefined;
}

/** Libellé de vue d'un candidat : tout ce que le gabarit affiche, sans logique d'affichage. */
function viewOf(item: FormatItem, opts: FormatOptions, target: Target, copyCount: number): StreamView {
  const { parsed } = item;
  const size = sizeOf(item);
  const view: StreamView = {
    resolutionLabel: RESOLUTION_LABEL[parsed.resolution],
    source: parsed.source === 'unknown' ? '' : parsed.source,
    hdr: parsed.hdr,
    languages: languagesOf(item),
    copies: copyCount,
    videoCodec: parsed.codec === 'unknown' ? undefined : parsed.codec,
    audioLabel: audioLabelOf(item),
    group: parsed.group,
    filename: item.raw.filename || item.raw.title || undefined,
    cached: item.cached === true,
    direct: target.kind === 'direct' || (target.kind === 'play' && target.direct),
    debrid: target.kind === 'client' || (target.kind === 'play' && !target.direct),
    seeders: seedersOf(item),
    fallbackLanguage: item.languageFallback === true,
    indexers: item.indexers ?? [],
    origins: item.origins,
    hoster: item.hoster,
  };
  view.sizeBytes = size;
  view.bitrateMbps = bitrateMbps(size, opts.runtimeSeconds);
  return view;
}

/** Libellé de langue et code de binge group. */
function languageInfo(parsed: ParsedRelease): { label: string; code: string } {
  if (parsed.frVariant !== undefined) return { label: parsed.frVariant, code: parsed.frVariant.toLowerCase() };
  if (parsed.multi || parsed.languages.includes('multi')) return { label: 'MULTi', code: 'multi' };
  if (parsed.languages.includes('fr')) return { label: 'VF', code: 'fr' };
  if (parsed.subsFr) return { label: 'VOSTFR', code: 'vostfr' };
  return { label: 'VO', code: 'vo' };
}

function notWebReady(parsed: ParsedRelease): boolean {
  return (
    parsed.codec === 'HEVC' ||
    parsed.codec === 'AV1' ||
    parsed.source === 'REMUX' ||
    parsed.audio.some((audio) => NOT_WEB_READY_AUDIO.test(audio))
  );
}

/** Débit moyen estimé en kb/s, ou null si la taille ou la durée manque. */
function estimateBitrateKbps(bytes: number | undefined, runtimeSeconds: number | undefined): number | null {
  if (bytes === undefined || runtimeSeconds === undefined || runtimeSeconds <= 0) return null;
  return Math.round((bytes * 8) / runtimeSeconds / 1000);
}

function behaviorHintsOf(item: FormatItem, target: Target): Record<string, unknown> {
  const { parsed } = item;
  const hints: Record<string, unknown> = {};
  const filename = item.raw.filename || item.raw.title;
  if (filename) hints.filename = filename;
  const size = sizeOf(item);
  if (size !== undefined) hints.videoSize = size;
  hints.bingeGroup = `lastaddon|${parsed.resolution}|${languageInfo(parsed).code}|${parsed.source}`;
  // Le conteneur .mkv n'est pas détecté : notWebReady reste à false pour lui.
  hints.notWebReady = notWebReady(parsed);
  // Les en-têtes amont ne servent que pour une URL directe amont.
  if (target.kind === 'direct' && item.raw.behaviorHints) {
    for (const key of UPSTREAM_HINT_KEYS) {
      const value = item.raw.behaviorHints[key];
      if (value !== undefined) hints[key] = value;
    }
  }
  return hints;
}

/** Objet `laststream` : données structurées pour les clients. Jamais d'URL (ni guid, ni downloadUrl) ici. */
function laststreamOf(item: FormatItem, opts: FormatOptions, copyCount: number, bitrate: number | undefined): Record<string, unknown> {
  const { parsed } = item;
  const size = sizeOf(item);
  return {
    resolution: parsed.resolution,
    height: parsed.height,
    source: parsed.source,
    codec: parsed.codec,
    hdr: parsed.hdr,
    languages: parsed.languages,
    frVariant: parsed.frVariant,
    sizeBytes: size,
    cached: item.cached === true,
    seeders: seedersOf(item),
    score: item.score,
    estBitrateKbps: estimateBitrateKbps(size, opts.runtimeSeconds),
    bitrateMbps: bitrate === undefined ? null : Math.round(bitrate * 10) / 10,
    copies: copyCount,
    verifiedLanguages: item.verifiedLanguages ?? [],
    certification: opts.certificationFr ?? null,
    indexers: item.indexers ?? [],
    origins: item.origins ?? (item.indexers ?? []).map((name) => ({ kind: 'indexer', name })),
    ...(item.languageFallback === true ? { languageFallback: true } : {}),
    // Série : pack « season » (saison entière) ou « complete » (intégrale) ; `episode` (numéro) si le nom donne l'épisode exact.
    ...(parsed.scope?.pack !== undefined ? { pack: parsed.scope.pack } : {}),
    ...(parsed.packSizeBytes !== undefined ? { packSizeBytes: parsed.packSizeBytes, sizeEstimated: true } : {}),
    ...(parsed.scope?.episode !== undefined ? { episode: parsed.scope.episode } : {}),
  };
}

/** Ce dont l'appareil a besoin pour débrider : copies (hash, fichier attendu), épisode visé. Jamais d'URL ni de secret. */
function clientInfoOf(copies: readonly PlayCopy[], opts: FormatOptions): Record<string, unknown> {
  return {
    copies: copies.slice(0, MAX_CLIENT_COPIES).map((copy) => ({
      infoHash: copy.infoHash,
      ...(copy.fileIdx !== undefined ? { fileIdx: copy.fileIdx } : {}),
      ...(copy.filename !== undefined ? { filename: copy.filename } : {}),
      ...(copy.size !== undefined ? { size: copy.size } : {}),
    })),
    ...(opts.season !== undefined ? { season: opts.season } : {}),
    ...(opts.episode !== undefined ? { episode: opts.episode } : {}),
  };
}

function formatOne(item: FormatItem, opts: FormatOptions): StremioStream | undefined {
  let target: Target | undefined;
  try {
    target = targetOf(item, opts);
  } catch {
    // Jeton impossible (aucune copie utilisable ne tient) : le flux est écarté, jamais de jeton partiel.
    return undefined;
  }
  if (target === undefined) return undefined;

  const copyCount = Math.max(item.copies?.length ?? 0, 1);
  const view = viewOf(item, opts, target, copyCount);
  const rendered = renderTemplate(opts.template ?? 'detaille', view);
  const stream: StremioStream = {
    name: rendered.name,
    description: rendered.description,
    behaviorHints: behaviorHintsOf(item, target),
    laststream: laststreamOf(item, opts, copyCount, view.bitrateMbps),
  };

  if (target.kind === 'client') {
    const lead = target.copies[0] as PlayCopy;
    stream.infoHash = lead.infoHash;
    if (lead.fileIdx !== undefined) stream.fileIdx = lead.fileIdx;
    stream.behaviorHints = { ...stream.behaviorHints, lastDebrid: 'client' };
    stream.laststream = { ...stream.laststream, client: clientInfoOf(target.copies, opts) };
    return stream;
  }
  stream.url = target.url;
  return stream;
}

/** Transforme les candidats classés en streams Stremio, tronqués à `maxResults`. */
export function formatStreams(items: readonly FormatItem[], opts: FormatOptions): StremioStream[] {
  const streams: StremioStream[] = [];
  // « En cache AllDebrid » d'abord (tri stable : l'ordre du classement est conservé à statut égal).
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.cached === true) - Number(a.item.cached === true) || a.index - b.index)
    .map(({ item }) => item);
  for (const item of ordered) {
    if (streams.length >= opts.maxResults) break;
    const stream = formatOne(item, opts);
    if (stream) streams.push(stream);
  }
  return streams;
}
