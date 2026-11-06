import { auth, isKidProfile } from '../data/auth';
import { requireBase } from '../data/config';
import { getLangPrefs } from '../data/langPrefs';
import { getSession } from '../data/session';
import {
  createParty, createPartyInviteLink, endParty, joinParty, type CreatePartyMedia, type Fingerprint, type JoinTicket, type PartyMedia, type PartyRoom, type PartyVisibility,
} from '../data/socialApi';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { PartyClient, type SocketLike } from './client';
import { PartyController, type PlayerLike } from './controller';
import {
  audioKnown, chooseCompatibleSource, compatWarning, fileCodecsOf, guestStatuses, isCompatibleSource, isStreamable, verdictOf, type FileCodecs, type GuestVerdict, type SourceLike,
} from './compat';
import { codecCacheKey, getCodecs, probeSource, probeUrl, putCodecs } from './headerCodecs';
import { fingerprintOf, pickByFingerprint, type FingerprintSource } from './fingerprint';
import { partyErrorText } from './protocol';
import type { RangeSource } from '../relay/host';
import { RelayError } from '../relay/protocol';
import { HostRelaySession, type RelayStats } from '../relay/session';
import { urlRangeSource } from '../relay/sources';
import { buildPartySubtitles, type LoadedSubtitle } from './subtitles';
import { partyCreateErrorText } from './createError';

/* Lien entre le salon (client WebSocket, contrôleur de synchronisation) et le lecteur. Un seul salon actif à la fois.
 * Le lecteur (player/session.js) appelle `sessionOpened`, `viewReady`, `tick`, `sessionClosed` ; l'interface appelle
 * `create`, `join`, `leave`. Aucun lien de lecture ne passe jamais par ici : seulement l'identité du titre et l'empreinte. */

/** Ce que le lecteur expose du titre en cours de lecture. */
export interface SessionAdapter {
  req: { type: 'movie' | 'tv'; id: string; name: string; season?: number | null; episode?: number | null; key: string };
  cur: { season?: number | null; episode?: number | null };
  view: (FingerprintSource & { index?: number }) | null;
  poster: string;
  /** Moteur de lecture (HtmlEngine, MpvEngine ou NativeEngine) ; sa position est mesurable quand `ready`. */
  engine: EngineLike | null;
  ready: boolean;
  /**
   * Lien HTTP(S) lu directement par cet appareil (débridé ou direct d'addon) pour le partage aux invités ; null pour un torrent,
   * un magnet ou un proxy. Jamais affiché, jamais envoyé au salon, jamais journalisé.
   */
  relayUrl?: () => string | null;
  /** Sources déjà chargées du titre (classées), pour proposer une source compatible avec tous les invités. */
  sources?: () => readonly SourceLike[];
  /** Bascule demandée par le salon en cours de rechargement : le lecteur suit le salon, il ne s'aligne pas sur lui. */
  switching?: boolean;
  /** Lien lisible d'une source (débridé ou direct seulement, jamais torrent) pour en lire l'en-tête ; null sinon. */
  resolveUrl?: (view: SourceLike, signal: AbortSignal) => Promise<string | null>;
  /** Sous-titre texte choisi et chargé par le lecteur (langue et cues), pour le partager aux invités ; null sinon. */
  subtitle?: () => LoadedSubtitle | null;
}

/** Résultat de la bascule vers une source compatible. `audioUnverified` : le son de cette source n'est pas connu. */
export type SwitchResult = { status: 'switched'; audioUnverified: boolean } | { status: 'none' };

interface EngineLike {
  kind: string;
  state(): { time: number; duration: number; paused: boolean; buffering?: boolean; rate?: number };
  play(): void;
  pause(): void;
  seek(t: number): void;
  setRate(r: number): void;
}

export interface LaunchOptions {
  resume: 'none';
  /** Choix de la source : la version la plus proche de l'empreinte du salon. */
  prefer: (views: readonly FingerprintSource[]) => FingerprintSource | null;
}

export type LaunchFn = (request: { type: 'movie' | 'tv'; id: string; name: string; season: number | null; episode: number | null; key: string }, opts: LaunchOptions) => Promise<unknown>;

/** Accès aux salons publics : jamais pour un profil enfant. */
export const canBrowsePublicParties = (isKid: boolean): boolean => !isKid;
/** Types de salon qu'un profil peut créer (un enfant : privé seulement, par lien). */
export const partyVisibilityChoices = (isKid: boolean): PartyVisibility[] => (isKid ? ['private'] : ['private', 'public']);
/** Le salon est-il accessible à ce profil ? (un enfant ne rejoint pas un salon public) */
export const canJoinRoom = (room: Pick<PartyRoom, 'visibility'>, isKid: boolean): boolean => !(isKid && room.visibility === 'public');

/** Cible de lecture d'un salon (fiche, saison, épisode) ; null si le titre n'a pas d'identifiant TMDB. */
export function requestOfRoom(room: PartyRoom, media: PartyMedia = room.media): { type: 'movie' | 'tv'; id: string; name: string; season: number | null; episode: number | null; key: string } | null {
  if (media.tmdbId == null) return null;
  const type = media.type === 'series' ? 'tv' : 'movie';
  return { type, id: String(media.tmdbId), name: room.title, season: type === 'tv' ? media.season ?? 1 : null, episode: type === 'tv' ? media.episode ?? 1 : null, key: type + ':' + media.tmdbId };
}

/** Corps de création d'un salon pour la lecture en cours. */
export function roomBodyOf(a: SessionAdapter, visibility: PartyVisibility, profileId: string, language: string) {
  const type = a.req.type === 'tv' ? 'series' : 'movie';
  const media: CreatePartyMedia = { type, tmdbId: Number(a.req.id), ...(type === 'series' ? { season: a.cur.season ?? a.req.season ?? 1, episode: a.cur.episode ?? a.req.episode ?? 1 } : {}) };
  const fp = fingerprintOf(a.view);
  return {
    profileId, visibility, title: a.req.name, poster: a.poster || null, language, media, ...(fp ? { fingerprint: fp } : {}),
  };
}

/** Corps de création d'un salon d'attente : le titre est connu, mais aucune lecture n'a démarré (donc pas d'empreinte de version). */
export function lobbyBodyOf(req: { type: 'movie' | 'tv'; id: string; name: string; season?: number | null; episode?: number | null }, poster: string | null, visibility: PartyVisibility, profileId: string, language: string) {
  const type = req.type === 'tv' ? 'series' : 'movie';
  const media: CreatePartyMedia = { type, tmdbId: Number(req.id), ...(type === 'series' ? { season: req.season ?? 1, episode: req.episode ?? 1 } : {}) };
  return { profileId, visibility, title: req.name, poster, language, media };
}

/** Adaptateur moteur -> `PlayerLike` pour le contrôleur. */
export function playerOf(a: SessionAdapter | null): PlayerLike | null {
  const e = a?.engine;
  if (!a || !e) return null;
  return {
    ready: () => a.ready,
    time: () => e.state().time || 0,
    duration: () => e.state().duration || 0,
    paused: () => !!e.state().paused,
    buffering: () => !!e.state().buffering,
    rate: () => e.state().rate || 1,
    play: () => { e.play(); },
    pause: () => { e.pause(); },
    seek: (t) => { e.seek(t); },
    setRate: (r) => { e.setRate(r); },
    // libVLC : la vitesse est rapportée dans son état ; si elle manque, la correction passe par des sauts.
    canRate: e.kind !== 'native' || typeof e.state().rate === 'number',
  };
}

type Listener = () => void;

/** Adresse WebSocket d'un ticket : `wsPath` est relatif à l'adresse du serveur (http -> ws, https -> wss). */
export const socketUrl = (base: string, wsPath: string): string => base.replace(/\/+$/, '').replace(/^http/i, 'ws') + wsPath;

/** Plafond du départ d'un salon : passé ce délai sans source prête, le participant se déclare prêt pour ne pas bloquer le salon. */
const LAUNCH_HOLD_MAX_MS = 45_000;

class PartyBridge {
  client: PartyClient | null = null;
  controller: PartyController | null = null;
  room: PartyRoom | null = null;
  profileId = '';
  /** Salon à créer dès que la source choisie est connue (bouton « Watch party » de la fiche). */
  pending: { visibility: PartyVisibility } | null = null;
  /** Dernier motif de fin (exclusion, salon terminé…), pour l'interface. */
  endReason = '';
  launcher: LaunchFn | null = null;
  /** Salon créé depuis la fiche (création différée) : l'interface copie le lien et ouvre le panneau. */
  onCreated: ((room: PartyRoom) => void) | null = null;
  /** Amis à inviter dès la création du salon (choisis dans la boîte « Watch party » de la fiche). */
  pendingInvites: string[] = [];
  onInvites: ((room: PartyRoom, pids: string[]) => void) | null = null;
  /** Création différée en échec : `retry` la relance (après saisie du code du profil, par exemple). */
  onCreateError: ((err: unknown, retry: () => void, cancel: () => void) => void) | null = null;
  adapter: (() => SessionAdapter | null) | null = null;
  /**
   * Bascule la lecture sur une source déjà chargée, à la même position ; `allow` filtre les sources de repli de cette
   * bascule. Fourni par le lecteur ; renvoie vrai si la bascule a lieu.
   */
  switcher: ((view: SourceLike, allow: (view: SourceLike) => boolean) => boolean) | null = null;
  private listeners = new Set<Listener>();
  private announced = '';
  /** Partage de la lecture aux invités : session hôte active, et lien qu'elle sert (comparé, jamais affiché). */
  private relay: HostRelaySession | null = null;
  private relayKey = '';
  /** La source refuse la lecture depuis ce navigateur (CORS) : l'hôte le voit, et les invités reçoivent le même motif. */
  private refusedRelay = false;
  /** Codecs lus dans l'en-tête du fichier relayé, pour le relais `relay` (URL en mémoire seulement, jamais affichée). */
  private header: { relay: string; codecs: FileCodecs } | null = null;
  /** Dernier titre vu par le lecteur (tick ou viewReady) : sert à ouvrir le partage dès qu'un invité arrive. Vidé à la fermeture du lecteur. */
  private lastAdapter: SessionAdapter | null = null;

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(): void {
    this.listeners.forEach((f) => { try { f(); } catch { /* ignoré */ } });
  }

  isActive(): boolean { return this.client !== null && this.client.status !== 'closed'; }
  isHost(): boolean { return !!this.client?.isHost; }
  /** Un invité ne change pas d'épisode (seul l'hôte passe à l'épisode suivant) ; la pause, la reprise et les sauts sont partagés. */
  guestLocked(): boolean { return this.isActive() && !this.isHost(); }

  /** Le salon peut-il être créé depuis ce profil (compte serveur, connecté) ? */
  available(): boolean {
    return auth.status === 'ready' && auth.profile !== null && getSession() !== null;
  }

  // ---- Création et connexion ----
  /** Crée un salon pour la lecture en cours et s'y connecte comme hôte. */
  async create(a: SessionAdapter, visibility: PartyVisibility): Promise<PartyRoom> {
    const kid = isKidProfile();
    const vis = kid ? 'private' : visibility;
    const profileId = userStore.currentProfile().id;
    const body = roomBodyOf(a, vis, profileId, getLangPrefs().audio === 'original' ? 'fr' : getLangPrefs().audio);
    const { room } = await createParty(body);
    await this.connect(room.id, profileId);
    // La lecture en cours de l'hôte fait foi pour le salon neuf.
    this.controller?.arm();
    return room;
  }

  /** Crée un salon d'attente (avant toute lecture) pour un titre et s'y connecte comme hôte ; la lecture démarre au départ du salon. */
  async createLobby(req: { type: 'movie' | 'tv'; id: string; name: string; season?: number | null; episode?: number | null }, poster: string | null, visibility: PartyVisibility): Promise<PartyRoom> {
    const kid = isKidProfile();
    const profileId = userStore.currentProfile().id;
    const lang = getLangPrefs().audio === 'original' ? 'fr' : getLangPrefs().audio;
    const { room } = await createParty(lobbyBodyOf(req, poster, kid ? 'private' : visibility, profileId, lang));
    await this.connect(room.id, profileId);
    return room;
  }

  /** Position de lecture de ce lecteur (secondes), ou null s'il n'y a pas de lecture mesurable : jointe aux messages du chat et aux réactions. */
  position(): number | null {
    const a = this.adapter?.() ?? null;
    if (!a || !a.ready || !a.engine) return null;
    const t = a.engine.state().time;
    return Number.isFinite(t) && t >= 0 ? t : null;
  }

  /** Lance la lecture du titre du salon avec la source la plus proche de l'hôte (départ du salon d'attente). */
  async launchRoom(): Promise<void> {
    const room = this.client?.room ?? this.room;
    if (!room || !this.launcher) return;
    const req = requestOfRoom(room, this.client?.room?.media ?? room.media);
    if (!req) throw new UserApiError(0, 'media_unsupported');
    this.holdLaunch();
    try {
      await this.launcher(req, this.launchOptions());
    } catch (err) {
      this.releaseLaunch();
      throw err;
    }
  }

  /**
   * Départ du salon (compte à rebours écoulé) : ce participant se déclare non prêt, pour que le salon retienne la lecture le temps
   * que sa source se charge (`viewReady` le libère). Aucune attente pour un salon déjà en lecture (arrivée en cours de film), un
   * serveur sans réglages v3, ou le réglage « attendre les retardataires » à off. Passé LAUNCH_HOLD_MAX_MS, il se déclare prêt.
   */
  private holdLaunch(): void {
    const c = this.client;
    if (!c || !c.v3 || c.settings.waitLate === 'off' || c.state?.playing || this.launchTimer !== null) return;
    c.sendBuffering(false, 0);
    this.launchTimer = setTimeout(() => this.releaseLaunch(), LAUNCH_HOLD_MAX_MS);
  }

  /** Source prête (ou plafond atteint) : le salon ne retient plus ce participant. Sans effet hors départ. */
  private releaseLaunch(): void {
    if (this.launchTimer === null) return;
    clearTimeout(this.launchTimer);
    this.launchTimer = null;
    this.client?.sendBuffering(true, 0);
  }

  /** Rejoint un salon existant (le lecteur est lancé par l'appelant si besoin, voir `joinAndPlay`). */
  async connect(roomId: string, profileId: string, lobby = false): Promise<void> {
    this.leave(); // remet `lobby` à false : le drapeau se pose après, pour ne pas être perdu
    this.lobby = lobby;
    this.endReason = '';
    this.profileId = profileId;
    const first = await joinParty(roomId, profileId);
    this.room = first.room;
    let ticket: JoinTicket | null = first;
    const client = new PartyClient({
      connect: async () => {
        // Le premier ticket est déjà en main ; les suivants (reconnexion) sont demandés à chaque tentative.
        const t = ticket ?? (await joinParty(roomId, profileId));
        ticket = null;
        return new WebSocket(socketUrl(requireBase(), t.wsPath)) as unknown as SocketLike;
      },
    });
    this.client = client;
    this.controller = new PartyController(client);
    client.on('status', () => this.emit());
    client.on('participants', () => this.onParticipants(client));
    client.on('welcome', (w) => { this.room = w.room; this.controller?.reset(); this.emit(); });
    client.on('host', () => { this.controller?.reset(); this.emit(); });
    client.on('media', (m) => this.onMedia(m));
    client.on('end', (reason) => { this.endReason = reason; this.emit(); });
    client.on('error', (code) => { const text = partyErrorText(code); if (!text) return; this.lastError = text; this.emit(); });
    client.start();
    this.emit();
  }

  lastError = '';
  /** Le salon d'attente est ouvert : un changement de titre (vote) n'y lance pas la lecture, elle démarre au départ. */
  lobby = false;
  /** Préparation déjà déclarée (prêt) pour la connexion en cours : posée au lancement d'une lecture hors salon d'attente. */
  private readyDeclared = false;
  /** Départ en cours : minuteur du plafond, tant que ce participant retient le salon (voir `holdLaunch`). */
  private launchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Rejoint un salon et lance la lecture du titre (ou de l'épisode) en cours, avec la source la plus proche de l'hôte. */
  async joinAndPlay(roomId: string, profileId: string): Promise<void> {
    await this.connect(roomId, profileId);
    const room = this.room;
    if (!room) return;
    const req = requestOfRoom(room);
    if (!req) throw new UserApiError(0, 'media_unsupported');
    if (!this.launcher) return;
    await this.launcher(req, this.launchOptions());
  }

  private launchOptions(): LaunchOptions {
    return { resume: 'none', prefer: (views) => pickByFingerprint(views, this.client?.room?.fingerprint ?? this.room?.fingerprint ?? null) };
  }

  leave(): void {
    const c = this.client;
    this.client = null;
    this.controller = null;
    this.room = null;
    this.pending = null;
    this.pendingInvites = [];
    this.announced = '';
    this.readyDeclared = false;
    if (this.launchTimer !== null) clearTimeout(this.launchTimer);
    this.launchTimer = null;
    this.lobby = false;
    this.stopRelay();
    if (c) c.close();
    this.emit();
  }

  /**
   * Lien d'invitation partagé du salon courant (hôte seulement) : renvoie l'identifiant du salon et le jeton du lien, le même
   * à chaque appel. `rotate` (« Nouveau lien ») invalide les liens précédents.
   */
  async createInvite(rotate = false): Promise<{ roomId: string; token: string; expiresAt: string }> {
    const c = this.client;
    const roomId = c?.room?.id ?? '';
    if (!c || !c.isHost || !roomId) throw new UserApiError(0, 'not_host');
    const inv = await createPartyInviteLink(roomId, this.profileId, rotate);
    return { roomId, token: inv.token, expiresAt: inv.expiresAt };
  }

  /**
   * Attend le rôle d'hôte du salon courant (bienvenue reçue). Le créateur est l'hôte, mais sa connexion peut encore
   * s'établir : vrai dès que c'est le cas ; faux si la connexion se ferme, si le salon est quitté, ou après `ms`.
   */
  waitForHost(ms = 5000): Promise<boolean> {
    const c = this.client;
    if (!c) return Promise.resolve(false);
    if (c.isHost) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const offs: Array<() => void> = [];
      const finish = (ok: boolean) => {
        if (timer !== null) clearTimeout(timer);
        offs.forEach((off) => off());
        resolve(ok);
      };
      const check = () => {
        if (c.isHost) finish(true);
        else if (c.status === 'closed') finish(false);
      };
      offs.push(c.on('welcome', check), c.on('status', check));
      timer = setTimeout(() => finish(c.isHost), ms);
    });
  }

  /** Statistiques du partage aux invités (null si aucun partage en cours). */
  relayStats(): RelayStats | null {
    return this.relay ? this.relay.stats() : null;
  }

  /** Le navigateur de l'hôte ne peut pas lire ce lien (CORS) : le partage est en cours, mais les invités ne reçoivent rien. */
  relayRefused(): boolean {
    return this.relay !== null && this.refusedRelay;
  }

  /**
   * Hôte d'un salon avec au moins un invité, lecture prête, mais source sans lien relayable (torrent, proxy, lien protégé) : les
   * invités ne peuvent pas recevoir la lecture. Faux hors de ce cas.
   */
  relayUnavailable(): boolean {
    const c = this.client;
    if (!c || !c.isHost || !c.participants.some((p) => p.guest)) return false;
    const a = this.adapter?.() ?? null;
    if (!a || !a.ready) return false;
    return (a.relayUrl ? a.relayUrl() : null) === null;
  }

  /**
   * Renvoie aux invités les sous-titres texte de l'hôte : à appeler quand la piste choisie ou son chargement change (`[]` si
   * aucune piste texte). Sans partage en cours, rien ne part.
   */
  refreshSubtitles(): void {
    if (!this.relay) return;
    const a = this.adapter?.() ?? null;
    this.relay.setSubtitles(buildPartySubtitles(a?.subtitle?.() ?? null));
  }

  /**
   * Avertissement de compatibilité pour l'hôte (« 1 invité n’aura pas le son (DTS) »), ou null. Il n'existe que pendant le
   * partage aux invités, et ne concerne que ceux qui ont annoncé leurs capacités de décodage.
   */
  guestWarning(): string | null {
    const c = this.client;
    const relay = this.relay;
    const a = this.adapter?.() ?? null;
    if (!c || !c.isHost || !relay || !a) return null;
    return compatWarning(this.sharedFile(a), guestStatuses(c.participants, relay.guestCaps()));
  }

  /**
   * Verdict de chaque invité qui a annoncé ses capacités (« ok », « no-audio », « unplayable »), par nom de participant.
   * Vide hors partage : la pastille d'état du panneau n'a rien à dire des autres participants.
   */
  guestVerdicts(): Map<string, GuestVerdict> {
    const out = new Map<string, GuestVerdict>();
    const c = this.client;
    const relay = this.relay;
    const a = this.adapter?.() ?? null;
    if (!c || !c.isHost || !relay || !a) return out;
    const file = this.sharedFile(a);
    for (const g of guestStatuses(c.participants, relay.guestCaps())) {
      if (g.caps) out.set(g.id, verdictOf(file, g.caps));
    }
    return out;
  }

  /** Codecs du fichier relayé : ceux de l'en-tête quand on les a lus pour ce relais, sinon ceux du nom de la source. */
  private sharedFile(a: SessionAdapter): FileCodecs {
    return this.header && this.header.relay === this.relayKey ? this.header.codecs : fileCodecsOf(a.view);
  }

  /**
   * Passe la lecture à la meilleure source compatible avec tous les invités annoncés, à la même position. Les replis de
   * cette bascule restent limités aux sources compatibles (jamais de torrent).
   */
  async switchToCompatible(): Promise<SwitchResult> {
    const c = this.client;
    const relay = this.relay;
    const a = this.adapter?.() ?? null;
    if (!c || !c.isHost || !relay || !a || !a.sources || !this.switcher) return { status: 'none' };
    const statuses = guestStatuses(c.participants, relay.guestCaps());
    // Codecs lus dans l'en-tête des candidates sondées : ils servent aussi aux replis de cette bascule.
    const probed = new Map<SourceLike, FileCodecs>();
    const choice = await chooseCompatibleSource(a.sources(), statuses, a.view?.index ?? null, async (v, signal) => {
      const codecs = await this.candidateCodecs(a, v, signal);
      if (codecs) probed.set(v, codecs);
      return codecs;
    });
    if (!choice) return { status: 'none' };
    const allow = (view: SourceLike): boolean => isCompatibleSource(view, statuses, probed.get(view));
    if (!this.switcher(choice.view, allow)) return { status: 'none' };
    const audioUnverified = choice.codecs ? choice.codecs.audio === null : !audioKnown(choice.view);
    return { status: 'switched', audioUnverified };
  }

  /** Codecs d'une source candidate : cache d'abord, sinon en-tête lu sur son lien (résolu comme à la lecture). Jamais de torrent. */
  private async candidateCodecs(a: SessionAdapter, view: SourceLike, signal: AbortSignal): Promise<FileCodecs | null> {
    if (!isStreamable(view) || !a.resolveUrl) return null;
    const key = await codecCacheKey(view).catch(() => null);
    const cached = key ? getCodecs(key) : null;
    if (cached) return cached;
    const url = await a.resolveUrl(view, signal);
    if (!url || signal.aborted) return null;
    const codecs = await probeUrl(url);
    if (codecs && key) putCodecs(key, codecs);
    return codecs;
  }

  /**
   * En-tête du fichier lu par l'hôte, dès que le relais s'ouvre (cache d'abord). Le fichier sert aussi aux invités :
   * ses codecs remplacent ceux du nom dans l'avertissement.
   */
  private readHeader(a: SessionAdapter, url: string, source: RangeSource): void {
    void (async () => {
      const key = await codecCacheKey(a.view).catch(() => null);
      let codecs = key ? getCodecs(key) : null;
      if (!codecs) {
        codecs = await probeSource(source).catch(() => null);
        if (codecs && key) putCodecs(key, codecs);
      }
      if (codecs && this.relayKey === url) {
        this.header = { relay: url, codecs };
        this.emit();
      }
    })();
  }

  /**
   * Présence des participants changée : le partage s'ouvre ou se ferme tout de suite, sans attendre le pas suivant du lecteur.
   * Sinon le `hello` d'un invité qui vient d'arriver serait ignoré (aucune session hôte pour l'admettre encore).
   */
  private onParticipants(client: PartyClient): void {
    if (this.client === client && this.lastAdapter) this.syncRelay(this.lastAdapter);
    this.emit();
  }

  /**
   * Partage de la lecture : une session hôte existe seulement quand un invité est présent et que la lecture de l'hôte passe
   * par un lien HTTP(S) lu directement (débridé ou direct d'addon). Elle est reprise si le lien change (épisode suivant), et
   * fermée dès que la condition tombe.
   */
  private syncRelay(a: SessionAdapter): void {
    const c = this.client;
    const guests = !!c && c.isHost && c.participants.some((p) => p.guest);
    const url = guests && a.relayUrl ? a.relayUrl() : null;
    if (!c || !url) {
      this.stopRelay();
      return;
    }
    if (this.relay && this.relayKey === url) return;
    this.stopRelay();
    try {
      const source = this.watchedSource(urlRangeSource({ url }));
      this.relay = new HostRelaySession({ client: c, source });
      this.relayKey = url;
      this.relay.setSubtitles(buildPartySubtitles(a.subtitle?.() ?? null));
      this.readHeader(a, url, source);
      // Lecture d'essai : l'hôte apprend tout de suite si son navigateur peut partager ce lien (sans attendre un invité).
      void source.size().catch(() => undefined);
    } catch {
      this.relay = null;
    }
  }

  /** Source surveillée : son état de lecture (refus du navigateur ou non) alimente l'affichage de l'hôte. */
  private watchedSource(base: RangeSource): RangeSource {
    const mark = (refused: boolean): void => {
      if (this.refusedRelay === refused) return;
      this.refusedRelay = refused;
      this.emit();
    };
    const isRefusal = (err: unknown): boolean => err instanceof RelayError && err.code === 'unshareable';
    return {
      mime: base.mime,
      size: () => base.size().then((n) => { mark(false); return n; }, (err: unknown) => { mark(isRefusal(err)); throw err; }),
      read: (start, end, signal) => base.read(start, end, signal).then((b) => { mark(false); return b; }, (err: unknown) => { mark(isRefusal(err)); throw err; }),
    };
  }

  private stopRelay(): void {
    this.relay?.close();
    this.relay = null;
    this.relayKey = '';
    this.refusedRelay = false;
    this.header = null;
  }

  /** L'hôte termine le salon pour tout le monde. */
  async end(): Promise<void> {
    const c = this.client;
    const id = this.room?.id;
    if (c?.isHost && c.endRoom()) { this.leave(); return; }
    if (id) await endParty(id).catch(() => undefined);
    this.leave();
  }

  /** Changement d'épisode décidé par l'hôte : les invités lancent l'épisode avec leur propre source. */
  private onMedia(m: { media: PartyMedia; fingerprint: Fingerprint | null }): void {
    this.controller?.reset();
    this.emit();
    const room = this.room;
    if (this.lobby) return;
    if (!room || this.client?.isHost || !this.launcher) return;
    const a = this.adapter?.() ?? null;
    const sameEp = a && a.cur.season === (m.media.season ?? null) && a.cur.episode === (m.media.episode ?? null) && a.req.id === String(m.media.tmdbId);
    if (sameEp) return;
    const req = requestOfRoom(room, m.media);
    if (req) void this.launcher(req, this.launchOptions());
  }

  // ---- Appels du lecteur ----
  /** La source est chargée : création différée du salon (fiche), annonce du changement d'épisode (hôte), recalage (invité). */
  viewReady(a: SessionAdapter): void {
    this.lastAdapter = a;
    if (this.pending && !this.client && this.available()) {
      const { visibility } = this.pending;
      this.pending = null;
      this.create(a, visibility).then((room) => {
        const pids = this.pendingInvites;
        this.pendingInvites = [];
        this.onCreated?.(room);
        if (pids.length) this.onInvites?.(room, pids);
        this.emit();
      }, (err) => {
        this.lastError = partyCreateErrorText(err);
        const cancel = () => { this.pendingInvites = []; };
        // Rien ne reste armé : seul un nouvel essai explicite (code du profil saisi) réarme la création, si le lecteur est toujours le même.
        const retry = () => {
          if (this.client || this.adapter?.() !== a || !a.ready) { cancel(); return; }
          this.pending = { visibility };
          this.viewReady(a);
        };
        if (!(err instanceof UserApiError && err.code === 'pin_required') || !this.onCreateError) cancel();
        this.onCreateError?.(err, retry, cancel);
        this.emit();
      });
      return;
    }
    const c = this.client;
    if (!c || !c.room) return;
    this.controller?.reset();
    this.declareReady(c, a);
    // Source prête : le salon ne retient plus ce participant (départ, voir launchRoom).
    this.releaseLaunch();
    if (c.isHost) {
      // Le lecteur de l'hôte qui démarre ne réaligne pas le salon : un départ de salon d'attente le cale sur son état, comme les
      // autres participants. L'alignement sur le lecteur de l'hôte se fait à la création du salon et au changement d'épisode.
      const m = c.room.media;
      const s = a.cur.season ?? null;
      const e = a.cur.episode ?? null;
      const differs = a.req.type === 'tv' && (s !== (m.season ?? null) || e !== (m.episode ?? null));
      const tag = a.req.key + ':' + s + ':' + e;
      if (differs && s !== null && e !== null && this.announced !== tag) {
        this.announced = tag;
        // Épisode suivant décidé par l'hôte : son lecteur fait foi pour le salon à la prochaine mesure (sauf bascule).
        if (!a.switching) this.controller?.arm();
        c.changeEpisode(s, e, fingerprintOf(a.view) ?? undefined);
      }
    } else {
      c.requestSync();
    }
  }

  /**
   * Une lecture démarre pour ce participant : il se déclare prêt (le salon l'attend « en recherche » tant qu'il ne dit rien),
   * avec la qualité de sa source. Une seule fois par connexion ; les serveurs antérieurs ignorent ces messages.
   */
  private declareReady(c: PartyClient, a: SessionAdapter): void {
    if (this.readyDeclared) return;
    // Serveur sans réglages v3 (pas de champ `settings` dans le welcome) : ces messages seraient refusés, on ne les envoie pas.
    if (!c.v3) return;
    this.readyDeclared = true;
    const quality = (a.view as { quality?: unknown } | null)?.quality;
    c.sendReady(true, typeof quality === 'string' && quality !== '' ? quality.slice(0, 40) : null);
    c.sendStatus('ready');
  }

  /** Appelé à chaque pas de la boucle du lecteur (250 ms, ou 1 s boucle d'interface arrêtée). */
  tick(a: SessionAdapter): void {
    this.lastAdapter = a;
    if (!this.controller) return;
    this.controller.tick(playerOf(a));
    this.syncRelay(a);
  }

  /**
   * Le lecteur se ferme : sortir du salon (pas pour un simple changement d'épisode, `silent`). Son titre n'est plus partageable :
   * le titre gardé ici ne doit plus ouvrir de relais (il pointerait vers un lien déjà fermé).
   */
  sessionClosed(silent: boolean): void {
    this.lastAdapter = null;
    if (!silent) this.leave();
  }
}

export const partyBridge = new PartyBridge();
