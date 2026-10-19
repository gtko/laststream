import { cleanReportText, filterChat } from './filter.js';
import {
  CHAT_HISTORY,
  CLOSE,
  GUEST_NAMES_MAX,
  INVITES_PER_WINDOW,
  INVITE_WINDOW_MS,
  type ChatLine,
  type ClientMessage,
  EMPTY_ROOM_TTL_MS,
  ENTRIES_PER_WINDOW,
  ENTRY_WINDOW_MS,
  RESERVATION_MS,
  GUEST_NAME_MAX,
  HOST_GRACE_MS,
  type Identity,
  MAX_GUESTS,
  MAX_REPORTS,
  type Participant,
  type StoredChatLine,
  type PlaybackState,
  REACTIONS,
  ROOM_MAX_AGE_MS,
  RTC_MAX_DATA_BYTES,
  type ReportEntry,
  type RoomData,
  type RoomInfo,
  type RtcRelay,
  type ServerMessage,
} from './protocol.js';
import { GUEST_KEY_PREFIX } from './guest.js';
import { canonicalName } from './names.js';
import { expectedPosition } from './sync.js';

/**
 * Cœur du salon : machine à états pure (aucune socket, aucune horloge, aucun stockage). Le Durable Object PartyRoom lui
 * confie les messages et applique les effets rendus (envoi, fermeture, fin) ; les tests l'exercent sans réseau.
 */

export type Effect =
  | { kind: 'send'; to: string; msg: ServerMessage }
  | { kind: 'broadcast'; msg: ServerMessage; except?: string }
  | { kind: 'close'; to: string; code: number; reason: string }
  /** Signalisation WebRTC : envoi au seul pair `peerId` (identifiant de connexion, voir Participant.peerId). */
  | { kind: 'peer'; peerId: string; msg: RtcRelay }
  /** Le salon est terminé : fermer toutes les connexions et effacer l'état. */
  | { kind: 'end' };

export type StoreKey = 'room' | 'chat' | 'reports';

export interface Member extends Identity {
  /** Identifie la connexion : la fermeture d'une ancienne connexion (remplacée) ne retire pas la nouvelle. Sert de peerId. */
  connId: string;
  joinedAt: number;
}

export type JoinCheck = 'ok' | 'room_full' | 'banned' | 'guest_limit' | 'name_taken' | 'name_changed';

/** Droit d'obtenir ou de renouveler le lien d'invitation partagé (hôte connecté seulement). */
export type LinkVerdict = { ok: true; epoch: number; exp: number } | { ok: false; reason: 'forbidden' | 'not_found' | 'rate_limited' };

/** Entrée d'un invité par le lien partagé : pseudo attribué (suffixé s'il est pris) ou motif de refus. */
export type EntryVerdict = { ok: true; name: string; exp: number } | { ok: false; reason: 'link_revoked' | 'room_full' | 'guest_limit' | 'rate_limited' | 'not_found' | 'name_taken' | 'name_banned' };

/** Résultat d'une demande d'invitation : `ok` consomme un jeton du débit. */
export type InviteVerdict = 'ok' | 'forbidden' | 'not_found' | 'guests_full' | 'rate_limited';

/**
 * Fermeture WebSocket d'un refus d'invité : code 4xxx propre à chaque motif, lu par le navigateur (contrairement à un code HTTP
 * d'échec de mise à niveau). `undefined` si l'invité est admis.
 */
export function guestRefusal(check: JoinCheck): { code: number; reason: string } | undefined {
  switch (check) {
    case 'ok':
      return undefined;
    case 'banned':
      return { code: CLOSE.banned, reason: 'banned' };
    case 'room_full':
      return { code: CLOSE.full, reason: 'full' };
    case 'guest_limit':
      return { code: CLOSE.full, reason: 'guest_limit' };
    case 'name_taken':
      return { code: CLOSE.nameTaken, reason: 'name_taken' };
    case 'name_changed':
      return { code: CLOSE.nameChanged, reason: 'name_changed' };
  }
}

/** Fenêtres de débit par participant : `max` messages par `windowMs`. Au-delà de 2 fois la limite, la connexion est fermée. */
const LIMITS: Readonly<Record<string, { max: number; windowMs: number }>> = {
  ping: { max: 20, windowMs: 10_000 },
  sync: { max: 10, windowMs: 10_000 },
  ctl: { max: 30, windowMs: 10_000 },
  chat: { max: 5, windowMs: 10_000 },
  react: { max: 10, windowMs: 10_000 },
  report: { max: 5, windowMs: 60_000 },
  admin: { max: 20, windowMs: 10_000 },
  // Négociation WebRTC : quelques offres, réponses et candidats ICE par pair.
  rtc: { max: 60, windowMs: 10_000 },
  // Négociation du maillage invité à invité (jusqu'à 8 pairs : hello, offre, réponse et une dizaine de candidats par pair).
  mesh: { max: 200, windowMs: 10_000 },
};

/** Écart (s) à partir duquel le rapport de position de l'hôte corrige l'état diffusé. */
const HOST_SYNC_TOLERANCE_SEC = 0.75;

export class RoomCore {
  readonly members = new Map<string, Member>();
  /** Parties de l'état modifiées depuis le dernier enregistrement (le DO les écrit puis vide l'ensemble). */
  readonly dirty = new Set<StoreKey>();
  /** Signalements nouveaux, pas encore transmis à l'administration (le Durable Object les vide après envoi). */
  readonly fresh: { entry: ReportEntry; againstId: string }[] = [];
  private readonly hits = new Map<string, number[]>();
  /** Instants des invitations émises (fenêtre glissante, en mémoire du Durable Object). */
  private inviteHits: number[] = [];
  private seq = 0;

  constructor(
    readonly data: RoomData,
    readonly chat: StoredChatLine[],
    readonly reports: ReportEntry[],
    private readonly clock: () => number,
  ) {}

  get hostId(): string {
    return this.data.meta.hostId;
  }

  /** Modération du serveur : retire un message de l'historique (et ses signalements) et prévient les participants. */
  removeMessage(messageId: string): { removed: boolean; effects: Effect[] } {
    const index = this.chat.findIndex((line) => line.id === messageId);
    if (index === -1) return { removed: false, effects: [] };
    this.chat.splice(index, 1);
    this.dirty.add('chat');
    const kept = this.reports.filter((report) => report.messageId !== messageId);
    if (kept.length !== this.reports.length) {
      this.reports.splice(0, this.reports.length, ...kept);
      this.dirty.add('reports');
    }
    return { removed: true, effects: [{ kind: 'broadcast', msg: { t: 'removed', messageId } }] };
  }

  info(): RoomInfo {
    const { meta } = this.data;
    return {
      id: meta.id,
      visibility: meta.visibility,
      title: meta.title,
      poster: meta.poster,
      language: meta.language,
      media: meta.media,
      fingerprint: meta.fingerprint,
      host: meta.hostName,
      participants: this.members.size,
      maxParticipants: meta.maxParticipants,
      createdAt: meta.createdAt,
    };
  }

  /** Description du salon envoyée aux participants (sans le nombre, qui évolue). */
  private roomView(): Omit<RoomInfo, 'participants'> {
    const { participants: _count, ...view } = this.info();
    void _count;
    return view;
  }

  /** Un compte déjà connecté peut se reconnecter même si le salon est plein (sa connexion est remplacée). */
  canJoin(accountId: string): JoinCheck {
    if (this.data.banned.includes(accountId)) return 'banned';
    if (!this.members.has(accountId) && this.members.size >= this.data.meta.maxParticipants) return 'room_full';
    return 'ok';
  }

  /** Nombre d'invités sans compte connectés. */
  guestCount(): number {
    let count = 0;
    for (const member of this.members.values()) if (member.guest === true) count += 1;
    return count;
  }

  /**
   * Un invité sans compte peut entrer : pas exclu, salon pas plein, au plus MAX_GUESTS invités connectés, et un pseudo
   * qui ne porte pas déjà un autre participant (sinon kick/mute/transfert par pseudo seraient ambigus). Un invité déjà
   * connecté (même jeton) peut se reconnecter.
   */
  canJoinGuest(identity: Identity): JoinCheck {
    if (this.data.banned.includes(identity.accountId)) return 'banned';
    if (this.data.bannedNames?.includes(canonicalName(identity.username))) return 'banned';
    // Une invitation garde le pseudo de sa première connexion, y compris après une déconnexion.
    const known = this.data.guestNames?.[identity.accountId];
    if (known !== undefined && known !== identity.username) return 'name_changed';
    const reconnect = this.members.has(identity.accountId);
    // Les jetons de séance obtenus récemment mais pas encore connectés comptent dans les plafonds (sauf le sien).
    const pending = this.pendingKeys().filter((key) => key !== identity.accountId).length;
    if (!reconnect && this.guestCount() + pending >= MAX_GUESTS) return 'guest_limit';
    if (!reconnect && this.members.size + pending >= this.data.meta.maxParticipants) return 'room_full';
    // Comparaison sur la forme canonique (casse, diacritiques, caractères confondables) : pas de sosie de l'hôte ni d'un participant.
    const wanted = canonicalName(identity.username);
    if (wanted === canonicalName(this.data.meta.hostName) && identity.accountId !== this.hostId) return 'name_taken';
    for (const member of this.members.values()) {
      if (member.accountId !== identity.accountId && canonicalName(member.username) === wanted) return 'name_taken';
    }
    return 'ok';
  }

  private participant(member: Member): Participant {
    return {
      username: member.username,
      avatarColor: member.avatarColor,
      ...(member.avatar ? { avatar: member.avatar } : {}),
      host: member.accountId === this.hostId,
      muted: this.data.muted.includes(member.accountId),
      joinedAt: member.joinedAt,
      peerId: member.connId,
      ...(member.guest === true ? { guest: true as const } : {}),
    };
  }

  /** Accepte une connexion (après canJoin). Remplace une éventuelle connexion précédente du même compte. */
  join(member: Member): Effect[] {
    const effects: Effect[] = [];
    // Une ancienne connexion du même compte est fermée par l'hôte du cœur (code CLOSE.replaced) avant cet appel.
    const previous = this.members.get(member.accountId);
    this.members.set(member.accountId, member);
    if (member.guest === true) this.rememberGuest(member);
    this.data.emptySince = null;
    if (member.accountId === this.hostId) this.data.hostAbsentSince = null;
    this.dirty.add('room');
    const now = this.clock();
    effects.push({
      kind: 'send',
      to: member.accountId,
      msg: {
        t: 'welcome',
        you: { username: member.username, host: member.accountId === this.hostId, muted: this.data.muted.includes(member.accountId), peerId: member.connId },
        // Un invité ne reçoit ni l'URL de l'affiche (lien de média) ni l'empreinte de version (nom, taille, hash).
        room: member.guest === true ? { ...this.roomView(), poster: null, fingerprint: null } : this.roomView(),
        state: this.data.state,
        serverTime: now,
        participants: [...this.members.values()].map((m) => this.participant(m)),
        chat: this.chat.map(publicLine),
      },
    });
    if (previous === undefined) effects.push({ kind: 'broadcast', msg: { t: 'join', participant: this.participant(member) }, except: member.accountId });
    return effects;
  }

  /** Déconnexion : sans effet si la connexion a déjà été remplacée par une plus récente. */
  leave(accountId: string, connId: string): Effect[] {
    const member = this.members.get(accountId);
    if (member === undefined || member.connId !== connId) return [];
    this.members.delete(accountId);
    const now = this.clock();
    if (accountId === this.hostId) this.data.hostAbsentSince = now;
    if (this.members.size === 0) this.data.emptySince = now;
    this.dirty.add('room');
    return [{ kind: 'broadcast', msg: { t: 'leave', user: member.username } }];
  }

  /** Mémorise le pseudo d'un invité pour ses reconnexions, borné à GUEST_NAMES_MAX entrées (les plus anciennes sont oubliées). */
  private rememberGuest(member: Member): void {
    const names: Record<string, string> = { ...(this.data.guestNames ?? {}) };
    delete names[member.accountId];
    names[member.accountId] = member.username;
    this.data.guestNames = this.trimGuestNames(names);
    // L'invité s'est connecté : sa réservation est réalisée.
    if (this.data.guestReserved?.[member.accountId] !== undefined) {
      const { [member.accountId]: _done, ...rest } = this.data.guestReserved;
      void _done;
      this.data.guestReserved = rest;
    }
  }

  /** Borne les pseudos retenus à GUEST_NAMES_MAX en oubliant les plus anciens, sans jamais évincer un invité connecté ni une réservation en cours. */
  private trimGuestNames(names: Record<string, string>): Record<string, string> {
    const protectedKeys = new Set<string>([...this.members.keys(), ...this.pendingKeys()]);
    for (const key of Object.keys(names)) {
      if (Object.keys(names).length <= GUEST_NAMES_MAX) break;
      if (!protectedKeys.has(key)) delete names[key];
    }
    return names;
  }

  /** Réservations en cours : jetons de séance obtenus il y a moins de RESERVATION_MS et pas encore connectés. */
  private pendingKeys(): string[] {
    const now = this.clock();
    return Object.entries(this.data.guestReserved ?? {})
      .filter(([key, at]) => now - at < RESERVATION_MS && !this.members.has(key))
      .map(([key]) => key);
  }

  /** Oublie les réservations expirées : le pseudo et la place sont libérés (le jeton, lui, n'a pas servi). */
  private pruneReservations(): void {
    const reserved = this.data.guestReserved;
    if (reserved === undefined) return;
    const now = this.clock();
    const kept: Record<string, number> = {};
    const names = { ...(this.data.guestNames ?? {}) };
    let changed = false;
    for (const [key, at] of Object.entries(reserved)) {
      if (now - at < RESERVATION_MS || this.members.has(key)) {
        if (now - at < RESERVATION_MS) kept[key] = at;
        continue;
      }
      delete names[key];
      changed = true;
    }
    if (!changed && Object.keys(kept).length === Object.keys(reserved).length) return;
    this.data.guestReserved = kept;
    this.data.guestNames = names;
    this.dirty.add('room');
  }

  /**
   * Droit d'émettre une invitation : hôte connecté seulement, moins de quatre invités connectés, et au plus INVITES_PER_WINDOW
   * jetons par INVITE_WINDOW_MS pour le salon. Un jeton accordé est compté tout de suite.
   */
  inviteVerdict(requesterId: string): InviteVerdict {
    if (requesterId !== this.hostId || !this.members.has(requesterId)) return 'forbidden';
    if (this.guestCount() >= MAX_GUESTS) return 'guests_full';
    const now = this.clock();
    const recent = this.inviteHits.filter((at) => now - at < INVITE_WINDOW_MS);
    this.inviteHits = recent;
    if (recent.length >= INVITES_PER_WINDOW) return 'rate_limited';
    recent.push(now);
    return 'ok';
  }

  /** Échéance du lien partagé et des jetons de séance : fin du salon. */
  linkExpiry(): number {
    return this.data.meta.createdAt + ROOM_MAX_AGE_MS;
  }

  /**
   * Lien d'invitation partagé (hôte connecté seulement). `rotate` incrémente la génération : les liens précédents ne
   * font plus entrer personne (les invités déjà entrés gardent leur jeton de séance). Seules les rotations sont comptées
   * dans le débit d'invitations du salon.
   */
  inviteLink(requesterId: string, rotate: boolean): LinkVerdict {
    if (requesterId !== this.hostId || !this.members.has(requesterId)) return { ok: false, reason: 'forbidden' };
    if (rotate) {
      const now = this.clock();
      const recent = this.inviteHits.filter((at) => now - at < INVITE_WINDOW_MS);
      this.inviteHits = recent;
      if (recent.length >= INVITES_PER_WINDOW) return { ok: false, reason: 'rate_limited' };
      recent.push(now);
      this.data.inviteEpoch = (this.data.inviteEpoch ?? 0) + 1;
      this.dirty.add('room');
    }
    return { ok: true, epoch: this.data.inviteEpoch ?? 0, exp: this.linkExpiry() };
  }

  /**
   * Entrée d'un invité avec le lien partagé : génération du lien à jour, salon pas plein (participants maximum du salon),
   * pas plus de MAX_GUESTS invités, débit des entrées du lien. Le pseudo est rendu unique (suffixe « 2 », « 3 »…) face aux
   * participants, à l'hôte et aux pseudos déjà attribués ; l'invité est enregistré sous ce pseudo, si bien que son jeton de
   * séance, lié à lui, ne sert qu'avec ce pseudo.
   */
  enterGuest(guestId: string, wanted: string, epoch: number): EntryVerdict {
    if (epoch !== (this.data.inviteEpoch ?? 0)) return { ok: false, reason: 'link_revoked' };
    this.pruneReservations();
    const pending = this.pendingKeys().length;
    if (this.members.size + pending >= this.data.meta.maxParticipants) return { ok: false, reason: 'room_full' };
    if (this.guestCount() + pending >= MAX_GUESTS) return { ok: false, reason: 'guest_limit' };
    const now = this.clock();
    // Compteur d'entrées conservé dans l'état du salon : il survit à l'éviction du Durable Object.
    const recent = (this.data.entryHits ?? []).filter((at) => now - at < ENTRY_WINDOW_MS);
    if (recent.length >= ENTRIES_PER_WINDOW) return { ok: false, reason: 'rate_limited' };
    recent.push(now);
    this.data.entryHits = recent;
    this.dirty.add('room');
    // Un pseudo canoniquement égal à celui de l'hôte ou d'un compte présent est refusé (pas de sosie) ; face à un autre invité, suffixe.
    const wantedKey = canonicalName(wanted);
    if (this.data.bannedNames?.includes(wantedKey)) return { ok: false, reason: 'name_banned' };
    if (wantedKey === canonicalName(this.data.meta.hostName)) return { ok: false, reason: 'name_taken' };
    for (const member of this.members.values()) if (member.guest !== true && canonicalName(member.username) === wantedKey) return { ok: false, reason: 'name_taken' };
    const taken = new Set<string>();
    for (const member of this.members.values()) taken.add(canonicalName(member.username));
    for (const name of Object.values(this.data.guestNames ?? {})) taken.add(canonicalName(name));
    let name = wanted;
    for (let n = 2; taken.has(canonicalName(name)); n += 1) {
      const suffix = ` ${n}`;
      name = `${Array.from(wanted)
        .slice(0, GUEST_NAME_MAX - suffix.length)
        .join('')
        .trimEnd()}${suffix}`;
    }
    const names: Record<string, string> = { ...(this.data.guestNames ?? {}) };
    names[`${GUEST_KEY_PREFIX}${guestId}`] = name;
    this.data.guestNames = this.trimGuestNames(names);
    this.data.guestReserved = { ...(this.data.guestReserved ?? {}), [`${GUEST_KEY_PREFIX}${guestId}`]: now };
    this.data.linkGuests = [...(this.data.linkGuests ?? []).filter((key) => key !== `${GUEST_KEY_PREFIX}${guestId}`), `${GUEST_KEY_PREFIX}${guestId}`].slice(-GUEST_NAMES_MAX);
    this.dirty.add('room');
    return { ok: true, name, exp: this.linkExpiry() };
  }

  /** Limite de débit : `true` si le message est admis. */
  private allow(accountId: string, kind: keyof typeof LIMITS): 'ok' | 'limited' | 'abusive' {
    const limit = LIMITS[kind];
    if (limit === undefined) return 'ok';
    const now = this.clock();
    const key = `${accountId}|${kind}`;
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < limit.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (recent.length > limit.max * 2) return 'abusive';
    return recent.length > limit.max ? 'limited' : 'ok';
  }

  private err(to: string, code: string): Effect[] {
    return [{ kind: 'send', to, msg: { t: 'error', code } }];
  }

  private nextState(playing: boolean, pos: number): PlaybackState {
    return { playing, pos, at: this.clock(), rev: this.data.state.rev + 1 };
  }

  /** Participant désigné par son pseudo ; à pseudo égal, un compte l'emporte sur un invité (un invité ne peut pas usurper un compte). */
  private findByName(username: string): Member | undefined {
    let guest: Member | undefined;
    for (const member of this.members.values()) {
      if (member.username !== username) continue;
      if (member.guest !== true) return member;
      guest ??= member;
    }
    return guest;
  }

  /** Traite un message d'un participant connecté. */
  handle(accountId: string, message: ClientMessage): Effect[] {
    const member = this.members.get(accountId);
    if (member === undefined) return [];
    const kind = rateKind(message);
    const verdict = this.allow(accountId, kind);
    if (verdict === 'abusive') return [{ kind: 'close', to: accountId, code: CLOSE.rateLimited, reason: 'rate_limited' }];
    if (verdict === 'limited') return this.err(accountId, 'rate_limited');
    const now = this.clock();
    const isHost = accountId === this.hostId;

    switch (message.t) {
      case 'ping':
        return [{ kind: 'send', to: accountId, msg: { t: 'pong', c: message.c, s: now } }];
      case 'sync':
        return [{ kind: 'send', to: accountId, msg: { t: 'state', state: this.data.state, serverTime: now, by: this.data.meta.hostName } }];
      case 'ctl': {
        const current = this.data.state;
        if (message.action === 'sync') {
          // Rapport périodique de l'hôte (horloge de référence) : on ne rediffuse que si la position diffère de ce que les autres suivent.
          if (!isHost) return this.err(accountId, 'not_host');
          if (Math.abs(message.pos - expectedPosition(current, now)) <= HOST_SYNC_TOLERANCE_SEC) return [];
          this.data.state = this.nextState(current.playing, message.pos);
        } else {
          // Lecture partagée : play, pause et seek viennent de n'importe quel participant (hôte ou invité).
          this.data.state = this.nextState(message.action === 'seek' ? current.playing : message.action === 'play', message.pos);
        }
        this.dirty.add('room');
        return [{ kind: 'broadcast', msg: { t: 'state', state: this.data.state, serverTime: now, by: member.username } }];
      }
      case 'episode': {
        if (!isHost) return this.err(accountId, 'not_host');
        const meta = this.data.meta;
        if (meta.media.type !== 'series') return this.err(accountId, 'not_series');
        meta.media = { ...meta.media, season: message.season, episode: message.episode };
        meta.fingerprint = message.fingerprint;
        this.data.state = this.nextState(false, 0);
        this.dirty.add('room');
        const media: Extract<ServerMessage, { t: 'media' }> = { t: 'media', media: meta.media, fingerprint: meta.fingerprint, state: this.data.state, serverTime: now };
        // Un invité ne reçoit pas l'empreinte de version (nom de fichier, taille, hash) : envoi par destinataire, sans diffusion.
        return [...this.members.values()].map((m): Effect => ({ kind: 'send', to: m.accountId, msg: m.guest === true ? { ...media, fingerprint: null } : media }));
      }
      case 'chat': {
        if (this.data.muted.includes(accountId)) return this.err(accountId, 'muted');
        const filtered = filterChat(message.text);
        if (!filtered.ok) return this.err(accountId, 'empty_message');
        const line: StoredChatLine = { id: `${now.toString(36)}${(this.seq++).toString(36)}`, from: member.username, fromId: accountId, text: filtered.text, at: now };
        this.chat.push(line);
        if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
        this.dirty.add('chat');
        return [{ kind: 'broadcast', msg: { t: 'chat', line: publicLine(line) } }];
      }
      case 'react': {
        if (this.data.muted.includes(accountId)) return this.err(accountId, 'muted');
        if (!(REACTIONS as readonly string[]).includes(message.emoji)) return this.err(accountId, 'invalid_reaction');
        return [{ kind: 'broadcast', msg: { t: 'react', user: member.username, emoji: message.emoji, at: now } }];
      }
      case 'report': {
        const line = this.chat.find((entry) => entry.id === message.messageId);
        if (line === undefined) return this.err(accountId, 'message_not_found');
        if (line.fromId === accountId) return this.err(accountId, 'cannot_report_self');
        const already = this.reports.some((r) => r.messageId === line.id && r.by === member.username);
        if (!already) {
          const entry: ReportEntry = {
            messageId: line.id,
            by: member.username,
            against: line.from,
            text: cleanReportText(line.text),
            reason: message.reason === null ? null : cleanReportText(message.reason) || null,
            at: now,
          };
          this.reports.push(entry);
          this.fresh.push({ entry, againstId: line.fromId });
          if (this.reports.length > MAX_REPORTS) this.reports.splice(0, this.reports.length - MAX_REPORTS);
          this.dirty.add('reports');
        }
        const effects: Effect[] = [{ kind: 'send', to: accountId, msg: { t: 'reported', messageId: line.id } }];
        if (!already && this.hostId !== accountId && this.members.has(this.hostId)) {
          effects.push({ kind: 'send', to: this.hostId, msg: { t: 'reported', messageId: line.id, by: member.username, against: line.from, text: line.text } });
        }
        return effects;
      }
      case 'kick': {
        if (!isHost) return this.err(accountId, 'not_host');
        const target = this.findByName(message.user);
        if (target === undefined) return this.err(accountId, 'user_not_found');
        if (target.accountId === accountId) return this.err(accountId, 'cannot_target_self');
        if (!this.data.banned.includes(target.accountId)) this.data.banned.push(target.accountId);
        this.members.delete(target.accountId);
        this.dirty.add('room');
        const effects: Effect[] = [
          { kind: 'close', to: target.accountId, code: CLOSE.kicked, reason: 'kicked' },
          { kind: 'broadcast', msg: { t: 'leave', user: target.username } },
        ];
        // Invité entré par le lien partagé : il pourrait revenir sous un nouvel identifiant avec le même lien. Le lien est donc
        // renouvelé (l'ancien meurt, les invités déjà connectés restent) et le pseudo canonique est banni du salon.
        if (target.guest === true && this.data.linkGuests?.includes(target.accountId)) {
          this.data.inviteEpoch = (this.data.inviteEpoch ?? 0) + 1;
          const banned = canonicalName(target.username);
          this.data.bannedNames = [...(this.data.bannedNames ?? []).filter((n) => n !== banned), banned].slice(-GUEST_NAMES_MAX);
          effects.push({ kind: 'send', to: this.hostId, msg: { t: 'link_renewed' } });
        }
        return effects;
      }
      case 'mute': {
        if (!isHost) return this.err(accountId, 'not_host');
        const target = this.findByName(message.user);
        if (target === undefined) return this.err(accountId, 'user_not_found');
        if (target.accountId === accountId) return this.err(accountId, 'cannot_target_self');
        const muted = this.data.muted.filter((id) => id !== target.accountId);
        if (message.muted) muted.push(target.accountId);
        this.data.muted = muted;
        this.dirty.add('room');
        return [{ kind: 'broadcast', msg: { t: 'muted', user: target.username, muted: message.muted } }];
      }
      case 'transfer': {
        if (!isHost) return this.err(accountId, 'not_host');
        const target = this.findByName(message.user);
        if (target === undefined) return this.err(accountId, 'user_not_found');
        if (target.accountId === accountId) return this.err(accountId, 'cannot_target_self');
        if (target.guest === true) return this.err(accountId, 'guest_cannot_host');
        this.setHost(target);
        return [{ kind: 'broadcast', msg: { t: 'host', user: target.username } }];
      }
      case 'end':
        if (!isHost) return this.err(accountId, 'not_host');
        return [{ kind: 'broadcast', msg: { t: 'ended', reason: 'host_ended' } }, { kind: 'end' }];
      case 'rtc': {
        // Signalisation WebRTC : relayée au seul pair visé, jamais diffusée ni conservée.
        if (message.bytes > RTC_MAX_DATA_BYTES) return this.err(accountId, 'rtc_too_large');
        if (message.to === member.connId) return this.err(accountId, 'cannot_target_self');
        const peer = [...this.members.values()].find((other) => other.connId === message.to);
        if (peer === undefined) return this.err(accountId, 'peer_not_found');
        // Maillage : seulement entre invités, et seulement des types de signalisation connus (liste blanche).
        if (isMeshSignal(message)) {
          if (typeof message.data.t !== 'string' || !MESH_SIGNAL_TYPES.has(message.data.t)) return this.err(accountId, 'invalid_message');
          if (member.guest !== true || peer.guest !== true) return this.err(accountId, 'mesh_guests_only');
        }
        return [{ kind: 'peer', peerId: peer.connId, msg: { type: 'rtc', from: member.connId, data: message.data } }];
      }
    }
  }

  private setHost(member: Member): void {
    this.data.meta.hostId = member.accountId;
    this.data.meta.hostName = member.username;
    this.data.muted = this.data.muted.filter((id) => id !== member.accountId);
    this.data.hostAbsentSince = null;
    this.dirty.add('room');
  }

  /** Fin de salon demandée de l'extérieur (route DELETE) : prévient et ferme. */
  end(reason: string): Effect[] {
    return [{ kind: 'broadcast', msg: { t: 'ended', reason } }, { kind: 'end' }];
  }

  /**
   * Maintenance à l'alarme : fin du salon trop ancien ou resté vide, promotion d'un nouvel hôte si l'hôte est absent depuis
   * trop longtemps. `next` : prochain instant (ms) où rappeler tick, ou null.
   */
  tick(): { effects: Effect[]; next: number | null } {
    const now = this.clock();
    const { data } = this;
    if (now - data.meta.createdAt >= ROOM_MAX_AGE_MS) return { effects: this.end('expired'), next: null };
    this.pruneReservations();
    if (this.members.size === 0) {
      const since = data.emptySince ?? now;
      if (data.emptySince === null) {
        data.emptySince = now;
        this.dirty.add('room');
      }
      if (now - since >= EMPTY_ROOM_TTL_MS) return { effects: this.end('empty'), next: null };
      return { effects: [], next: since + EMPTY_ROOM_TTL_MS };
    }
    const effects: Effect[] = [];
    if (!this.members.has(this.hostId)) {
      const since = data.hostAbsentSince ?? now;
      if (data.hostAbsentSince === null) {
        data.hostAbsentSince = now;
        this.dirty.add('room');
      }
      if (now - since >= HOST_GRACE_MS) {
        // Un invité ne devient jamais hôte.
        const successor = [...this.members.values()].filter((m) => m.guest !== true).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (successor !== undefined) {
          this.setHost(successor);
          effects.push({ kind: 'broadcast', msg: { t: 'host', user: successor.username } });
        }
      } else {
        return { effects, next: since + HOST_GRACE_MS };
      }
    }
    return { effects, next: data.meta.createdAt + ROOM_MAX_AGE_MS };
  }

  /** Prochain réveil nécessaire (ms) selon l'état courant, ou null. */
  nextWake(): number | null {
    const { data } = this;
    const expiry = data.meta.createdAt + ROOM_MAX_AGE_MS;
    if (this.members.size === 0) return Math.min(expiry, (data.emptySince ?? this.clock()) + EMPTY_ROOM_TTL_MS);
    if (!this.members.has(this.hostId)) return Math.min(expiry, (data.hostAbsentSince ?? this.clock()) + HOST_GRACE_MS);
    return expiry;
  }
}

function publicLine(line: StoredChatLine): ChatLine {
  return { id: line.id, from: line.from, text: line.text, at: line.at };
}

/** Types de signalisation du maillage invité à invité (`data.m === 'mesh'`) ; tout autre type est refusé par le salon. */
export const MESH_SIGNAL_TYPES: ReadonlySet<string> = new Set(['hello', 'offer', 'answer', 'ice']);

/** Vrai si la signalisation relayée appartient au maillage (étiquette `m: 'mesh'`). */
function isMeshSignal(message: ClientMessage): boolean {
  return message.t === 'rtc' && message.data.m === 'mesh';
}

function rateKind(message: ClientMessage): string {
  if (isMeshSignal(message)) return 'mesh';
  switch (message.t) {
    case 'kick':
    case 'mute':
    case 'transfer':
    case 'end':
    case 'episode':
      return 'admin';
    default:
      return message.t;
  }
}
