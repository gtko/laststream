import { auth, isKidProfile } from '../data/auth';
import { requireBase } from '../data/config';
import { getLangPrefs } from '../data/langPrefs';
import { getSession } from '../data/session';
import {
  createParty, createPartyInvite, endParty, joinParty, type Fingerprint, type JoinTicket, type PartyMedia, type PartyRoom, type PartyVisibility,
} from '../data/socialApi';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { PartyClient, type SocketLike } from './client';
import { PartyController, type PlayerLike } from './controller';
import { fingerprintOf, pickByFingerprint, type FingerprintSource } from './fingerprint';
import { partyErrorText } from './protocol';
import type { RangeSource } from '../relay/host';
import { RelayError } from '../relay/protocol';
import { HostRelaySession, type RelayStats } from '../relay/session';
import { urlRangeSource } from '../relay/sources';

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
}

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
  const media: PartyMedia = { type, tmdbId: Number(a.req.id), ...(type === 'series' ? { season: a.cur.season ?? a.req.season ?? 1, episode: a.cur.episode ?? a.req.episode ?? 1 } : {}) };
  const fp = fingerprintOf(a.view);
  return {
    profileId, visibility, title: a.req.name, poster: a.poster || null, language, media, ...(fp ? { fingerprint: fp } : {}),
  };
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
  adapter: (() => SessionAdapter | null) | null = null;
  private listeners = new Set<Listener>();
  private announced = '';
  /** Partage de la lecture aux invités : session hôte active, et lien qu'elle sert (comparé, jamais affiché). */
  private relay: HostRelaySession | null = null;
  private relayKey = '';
  /** La source refuse la lecture depuis ce navigateur (CORS) : l'hôte le voit, et les invités reçoivent le même motif. */
  private refusedRelay = false;

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

  /** Rejoint un salon existant (le lecteur est lancé par l'appelant si besoin, voir `joinAndPlay`). */
  async connect(roomId: string, profileId: string): Promise<void> {
    this.leave();
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
    client.on('participants', () => this.emit());
    client.on('welcome', (w) => { this.room = w.room; this.controller?.reset(); this.emit(); });
    client.on('host', () => { this.controller?.reset(); this.emit(); });
    client.on('media', (m) => this.onMedia(m));
    client.on('end', (reason) => { this.endReason = reason; this.emit(); });
    client.on('error', (code) => { this.lastError = partyErrorText(code); this.emit(); });
    client.start();
    this.emit();
  }

  lastError = '';

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
    this.announced = '';
    this.stopRelay();
    if (c) c.close();
    this.emit();
  }

  /** Invitation d'un invité pour le salon courant (hôte seulement) : renvoie l'identifiant du salon et le jeton. */
  async createInvite(): Promise<{ roomId: string; token: string; expiresAt: string }> {
    const c = this.client;
    const roomId = c?.room?.id ?? '';
    if (!c || !c.isHost || !roomId) throw new UserApiError(0, 'not_host');
    const inv = await createPartyInvite(roomId, this.profileId);
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
    if (this.pending && !this.client && this.available()) {
      const { visibility } = this.pending;
      this.pending = null;
      this.create(a, visibility).then((room) => { this.onCreated?.(room); this.emit(); }, (err) => { this.lastError = err instanceof UserApiError && err.code === 'too_many_rooms' ? 'Trois salons ouverts au plus.' : 'Création du salon impossible.'; this.emit(); });
      return;
    }
    const c = this.client;
    if (!c || !c.room) return;
    this.controller?.reset();
    if (c.isHost) {
      // Le lecteur de l'hôte vient de démarrer : son état s'aligne sur le salon à la prochaine mesure.
      this.controller?.arm();
      const m = c.room.media;
      const s = a.cur.season ?? null;
      const e = a.cur.episode ?? null;
      const differs = a.req.type === 'tv' && (s !== (m.season ?? null) || e !== (m.episode ?? null));
      const tag = a.req.key + ':' + s + ':' + e;
      if (differs && s !== null && e !== null && this.announced !== tag) {
        this.announced = tag;
        c.changeEpisode(s, e, fingerprintOf(a.view) ?? undefined);
      }
    } else {
      c.requestSync();
    }
  }

  /** Appelé à chaque pas de la boucle du lecteur (~100 ms). */
  tick(a: SessionAdapter): void {
    if (!this.controller) return;
    this.controller.tick(playerOf(a));
    this.syncRelay(a);
  }

  /** Le lecteur se ferme : sortir du salon (pas pour un simple changement d'épisode, `silent`). */
  sessionClosed(silent: boolean): void {
    if (!silent) this.leave();
  }
}

export const partyBridge = new PartyBridge();
