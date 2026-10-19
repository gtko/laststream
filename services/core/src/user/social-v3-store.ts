import { randomBytes, randomUUID } from 'node:crypto';
import { generateInviteCode } from './social-store.js';
import { handleOf, MESSAGES_PER_MINUTE, type FriendView, type Handle, type MessageView, type TargetError, SocialV2Store } from './social-v2-store.js';
import type { SqlDb } from './sql.js';

/**
 * Partage (S3b) : messages de partage multiples, liens publics et listes partagées. Même base que les autres stores
 * (SQLite Node ou Durable Object), requêtes paramétrées, identifiants publics seulement (pid).
 *
 * Règles : un partage ne va qu'à des amis acceptés (les groupes sont ignorés tant qu'ils n'existent pas). Un lien public
 * ne révèle ni le pid de son auteur, ni sa bibliothèque, ni sa position sauf pour un moment. Une invitation jointe à un
 * lien est réservée (état « envoyé ») à sa création et consommée seulement à l'inscription (redeemInvite).
 * Une liste a un propriétaire (membre comme les autres, retiré seulement avec la liste) et des membres, amis du
 * propriétaire : un membre qui n'est plus ami est écarté de la liste à la lecture suivante.
 */

/** Destinataires d'un partage : 20 au plus par envoi. */
export const MAX_SHARE_RECIPIENTS = 20;
/** Membres d'une liste, propriétaire compris. */
export const MAX_LIST_MEMBERS = 50;
/** Listes possédées par un profil, éléments par liste. */
export const MAX_OWNED_LISTS = 50;
export const MAX_LIST_ITEMS = 1000;
const WINDOW_MS = 60_000;
const SENT_MESSAGES_SQL = 'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM messages WHERE from_pid = ? AND created_at > ?';

/** Contenu structuré d'un message de partage ; le texte du message (`body`) reste le repli lisible. */
export type SharePayload =
  | { kind: 'title'; type: 'movie' | 'series'; tmdbId: number; title: string; poster?: string; year?: number; rating?: number }
  | { kind: 'moment'; type: 'movie' | 'series'; tmdbId: number; season?: number; episode?: number; title: string; pos: number; still?: string };

export type SharedMessageView = MessageView & { payload: SharePayload };

export type ShareOutcome = { result: TargetError } | { result: 'limit_reached'; retryAfterSec: number } | { result: 'sent'; messages: SharedMessageView[] };

export interface ShareLinkInput {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  poster?: string;
  pos?: number;
  note?: string;
  withInvite: boolean;
}

/** Vue publique d'un lien : aucun pid, aucune bibliothèque. `pos` seulement pour un moment, `inviteCode` seulement si libre. */
export interface ShareLinkView {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  poster?: string;
  pos?: number;
  from: { handle: Handle; avatarColor: string };
  note?: string;
  inviteCode?: string;
}

export type ShareLinkOutcome = { result: 'invite_quota_reached' } | { result: 'ok'; code: string; inviteCode?: string };

export interface SharedItemView {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  poster?: string;
  addedBy: string;
  addedAt: number;
}

export interface SharedListDetail {
  id: string;
  name: string;
  members: FriendView[];
  items: SharedItemView[];
}

export interface SharedListSummary {
  id: string;
  name: string;
  members: FriendView[];
  count: number;
}

export interface ListItemInput {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  poster?: string;
}

/** Résultat d'une écriture sur une liste. `audience` : profils à prévenir (membres avant et après la modification). */
export type ListWrite<T extends object = object> =
  | ({ result: 'ok'; audience: string[] } & T)
  | { result: 'not_found' | 'owner_only' | 'unknown' | 'not_friend' | 'too_many_members' | 'list_limit_reached' | 'list_full' | 'item_exists' | 'item_not_found' };

interface ListRow {
  id: string;
  owner_pid: string;
  name: string;
  created_at: number;
}

interface ItemRow {
  type: string;
  tmdb_id: number;
  title: string;
  poster: string | null;
  added_by: string;
  added_at: number;
}

function unique(pids: readonly string[] | undefined): string[] {
  return [...new Set(pids ?? [])];
}

function pairOf(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

export class SocialV3Store {
  private readonly views: SocialV2Store;

  constructor(private readonly db: SqlDb) {
    this.views = new SocialV2Store(db);
  }

  // Partage multiple

  /**
   * Envoie le même partage à plusieurs amis (un message par destinataire, avec son payload). Tout ou rien : un seul refus
   * (soi-même, profil inconnu, pas ami) annule l'envoi. Le quota de messages par minute compte chaque destinataire.
   */
  shareTo(fromPid: string, recipients: readonly string[], payload: SharePayload, body: string, now: number): ShareOutcome {
    return this.db.transaction((): ShareOutcome => {
      for (const pid of recipients) {
        if (pid === fromPid) return { result: 'self' };
        if (this.views.card(pid) === undefined) return { result: 'unknown' };
        if (!this.isFriend(fromPid, pid)) return { result: 'not_friend' };
      }
      const recent = this.db.prepare(SENT_MESSAGES_SQL).get(fromPid, now - WINDOW_MS) as unknown as { n: number; oldest: number | null } | undefined;
      if (Number(recent?.n ?? 0) + recipients.length > MESSAGES_PER_MINUTE) {
        const oldest = Number(recent?.oldest ?? now);
        return { result: 'limit_reached', retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
      }
      const json = JSON.stringify(payload);
      const messages: SharedMessageView[] = [];
      for (const pid of recipients) {
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO messages (id, from_pid, to_pid, body, context, created_at, read_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)')
          .run(id, fromPid, pid, body, now);
        this.db.prepare('INSERT INTO message_payloads (message_id, payload) VALUES (?, ?)').run(id, json);
        messages.push({ id, from: fromPid, to: pid, body, createdAt: now, payload });
      }
      return { result: 'sent', messages };
    });
  }

  /** Titre d'un média de l'index des fiches (sans donnée personnelle) ; `undefined` si le média n'y est pas. */
  titleOfMedia(type: 'movie' | 'series', tmdbId: number): string | undefined {
    const row = this.db.prepare('SELECT title FROM meta_index WHERE type = ? AND tmdb_id = ?').get(type, tmdbId) as unknown as { title: string } | undefined;
    return row?.title;
  }

  // Liens publics

  /**
   * Crée un lien public. Avec `withInvite`, réserve un emplacement d'invitation libre du compte (état « envoyé ») : le
   * lien en porte le code. Plus d'emplacement libre (quota atteint) : rien n'est créé.
   */
  createShareLink(accountId: string, authorPid: string, input: ShareLinkInput, now: number): ShareLinkOutcome {
    return this.db.transaction((): ShareLinkOutcome => {
      let inviteId: string | null = null;
      let inviteCode: string | undefined;
      if (input.withInvite) {
        const slot = this.reserveInvite(accountId, now);
        if (slot === undefined) return { result: 'invite_quota_reached' };
        inviteId = slot.id;
        inviteCode = slot.code;
      }
      // 16 octets aléatoires : code non devinable (22 caractères base64url).
      const code = randomBytes(16).toString('base64url');
      this.db
        .prepare(
          'INSERT INTO share_links (code, author_pid, type, tmdb_id, title, poster, pos, note, invite_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          code,
          authorPid,
          input.type,
          input.tmdbId,
          input.title,
          input.poster ?? null,
          input.pos ?? null,
          input.note ?? null,
          inviteId,
          now,
        );
      return inviteCode === undefined ? { result: 'ok', code } : { result: 'ok', code, inviteCode };
    });
  }

  /**
   * Lien public par son code, sans session. `undefined` si inconnu. L'invitation n'est donnée que si elle n'a pas encore
   * été consommée (inscription faite) ; son code reste celui de l'emplacement, à jour après une révocation.
   */
  shareLinkByCode(code: string): ShareLinkView | undefined {
    const row = this.db
      .prepare(
        `SELECT s.type, s.tmdb_id, s.title, s.poster, s.pos, s.note, p.handle_name, p.handle_tag, p.avatar_color,
                i.code AS invite_code, i.used_at AS invite_used_at
         FROM share_links s
         JOIN profiles p ON p.pid = s.author_pid
         LEFT JOIN invites i ON i.id = s.invite_id
         WHERE s.code = ?`,
      )
      .get(code) as unknown as
      | {
          type: 'movie' | 'series';
          tmdb_id: number;
          title: string;
          poster: string | null;
          pos: number | null;
          note: string | null;
          handle_name: string;
          handle_tag: string;
          avatar_color: string;
          invite_code: string | null;
          invite_used_at: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    const view: ShareLinkView = {
      type: row.type,
      tmdbId: Number(row.tmdb_id),
      title: row.title,
      from: { handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color },
    };
    if (row.poster !== null) view.poster = row.poster;
    if (row.pos !== null) view.pos = Number(row.pos);
    if (row.note !== null) view.note = row.note;
    if (row.invite_code !== null && row.invite_used_at === null) view.inviteCode = row.invite_code;
    return view;
  }

  /**
   * Emplacement d'invitation libre du compte, réservé pour un lien. Les emplacements sont créés à la demande, dans la limite
   * du quota : libres (ni envoyés, ni utilisés, ni réservés par un lien) ou nouveaux tant que le total reste sous le quota.
   */
  private reserveInvite(accountId: string, now: number): { id: string; code: string } | undefined {
    const quotaRow = this.db.prepare('SELECT invite_quota FROM accounts WHERE id = ?').get(accountId) as unknown as { invite_quota: number } | undefined;
    if (quotaRow === undefined) return undefined;
    const quota = Number(quotaRow.invite_quota);
    const rows = this.db
      .prepare('SELECT id, code, sent_at, used_at FROM invites WHERE inviter_id = ? ORDER BY rowid')
      .all(accountId) as unknown as { id: string; code: string; sent_at: string | null; used_at: string | null }[];
    const reserved = new Set(
      (this.db.prepare('SELECT invite_id FROM share_links WHERE invite_id IS NOT NULL').all() as unknown as { invite_id: string }[]).map((row) => row.invite_id),
    );
    const at = new Date(now).toISOString();
    const free = rows.find((row) => row.used_at === null && row.sent_at === null && !reserved.has(row.id));
    if (free !== undefined) {
      this.db.prepare('UPDATE invites SET sent_at = ? WHERE id = ?').run(at, free.id);
      return { id: free.id, code: free.code };
    }
    if (rows.length >= quota) return undefined;
    const id = randomUUID();
    const code = generateInviteCode();
    this.db.prepare('INSERT INTO invites (id, code, inviter_id, created_at, sent_at) VALUES (?, ?, ?, ?, ?)').run(id, code, accountId, at, at);
    return { id, code };
  }

  // Listes partagées

  /** Listes où `pid` est membre (propriétaire ou ami du propriétaire), les plus récentes d'abord. */
  listsOf(pid: string, now: number): SharedListSummary[] {
    const ids = this.db.prepare('SELECT list_id FROM shared_list_members WHERE pid = ?').all(pid) as unknown as { list_id: string }[];
    const lists: { row: ListRow; summary: SharedListSummary }[] = [];
    for (const { list_id: id } of ids) {
      const row = this.accessible(id, pid);
      if (row === undefined) continue;
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM shared_list_items WHERE list_id = ?').get(id) as unknown as { n: number };
      lists.push({ row, summary: { id, name: row.name, members: this.memberViews(id, row.owner_pid, pid, now), count: Number(count.n) } });
    }
    return lists.sort((a, b) => b.row.created_at - a.row.created_at).map((entry) => entry.summary);
  }

  /** Une liste (contenu et membres) si `pid` y a accès ; `undefined` sinon (même réponse qu'une liste inexistante). */
  listDetail(pid: string, listId: string, now: number): SharedListDetail | undefined {
    const row = this.accessible(listId, pid);
    if (row === undefined) return undefined;
    return { id: listId, name: row.name, members: this.memberViews(listId, row.owner_pid, pid, now), items: this.itemsOf(listId) };
  }

  /** Crée une liste dont `ownerPid` est propriétaire, avec des amis membres. Refus (rien écrit) si un membre n'est pas ami. */
  createList(ownerPid: string, name: string, memberPids: readonly string[], now: number): ListWrite<{ list: SharedListDetail }> {
    return this.db.transaction((): ListWrite<{ list: SharedListDetail }> => {
      const owned = this.db.prepare('SELECT COUNT(*) AS n FROM shared_lists WHERE owner_pid = ?').get(ownerPid) as unknown as { n: number };
      if (Number(owned.n) >= MAX_OWNED_LISTS) return { result: 'list_limit_reached' };
      const extra = unique(memberPids).filter((pid) => pid !== ownerPid);
      if (extra.length + 1 > MAX_LIST_MEMBERS) return { result: 'too_many_members' };
      const refusal = this.checkFriends(ownerPid, extra);
      if (refusal !== undefined) return { result: refusal };
      const id = randomUUID();
      this.db.prepare('INSERT INTO shared_lists (id, owner_pid, name, created_at) VALUES (?, ?, ?, ?)').run(id, ownerPid, name, now);
      this.db.prepare('INSERT INTO shared_list_members (list_id, pid) VALUES (?, ?)').run(id, ownerPid);
      for (const pid of extra) this.db.prepare('INSERT INTO shared_list_members (list_id, pid) VALUES (?, ?)').run(id, pid);
      const list = this.listDetail(ownerPid, id, now);
      if (list === undefined) return { result: 'not_found' };
      return { result: 'ok', list, audience: [ownerPid, ...extra] };
    });
  }

  /**
   * Renomme et modifie les membres (propriétaire seulement). Un membre ajouté doit être ami du propriétaire ; le propriétaire
   * ne peut pas être retiré. Tout est vérifié avant la première écriture.
   */
  updateList(pid: string, listId: string, patch: { name?: string; add?: string[]; remove?: string[] }, now: number): ListWrite<{ list: SharedListDetail }> {
    return this.db.transaction((): ListWrite<{ list: SharedListDetail }> => {
      const row = this.accessible(listId, pid);
      if (row === undefined) return { result: 'not_found' };
      if (row.owner_pid !== pid) return { result: 'owner_only' };
      const before = this.memberRows(listId);
      const adds = unique(patch.add).filter((member) => member !== pid);
      const removes = unique(patch.remove).filter((member) => member !== pid);
      const refusal = this.checkFriends(pid, adds);
      if (refusal !== undefined) return { result: refusal };
      const projected = before.filter((member) => !removes.includes(member)).length + adds.filter((member) => !before.includes(member)).length;
      if (projected > MAX_LIST_MEMBERS) return { result: 'too_many_members' };
      const audience = new Set(this.liveMembers(listId, pid));
      if (patch.name !== undefined) this.db.prepare('UPDATE shared_lists SET name = ? WHERE id = ?').run(patch.name, listId);
      for (const member of removes) this.db.prepare('DELETE FROM shared_list_members WHERE list_id = ? AND pid = ?').run(listId, member);
      for (const member of adds) this.db.prepare('INSERT OR IGNORE INTO shared_list_members (list_id, pid) VALUES (?, ?)').run(listId, member);
      for (const member of this.liveMembers(listId, pid)) audience.add(member);
      for (const member of removes) audience.add(member);
      const list = this.listDetail(pid, listId, now);
      if (list === undefined) return { result: 'not_found' };
      return { result: 'ok', list, audience: [...audience] };
    });
  }

  /** Supprime une liste (propriétaire seulement) avec ses membres et ses éléments. */
  deleteList(pid: string, listId: string): ListWrite {
    return this.db.transaction((): ListWrite => {
      const row = this.accessible(listId, pid);
      if (row === undefined) return { result: 'not_found' };
      if (row.owner_pid !== pid) return { result: 'owner_only' };
      const audience = this.liveMembers(listId, pid);
      this.db.prepare('DELETE FROM shared_list_items WHERE list_id = ?').run(listId);
      this.db.prepare('DELETE FROM shared_list_members WHERE list_id = ?').run(listId);
      this.db.prepare('DELETE FROM shared_lists WHERE id = ?').run(listId);
      return { result: 'ok', audience };
    });
  }

  /** Ajoute un titre à la liste (tout membre). Un titre déjà présent est refusé. */
  addItem(pid: string, listId: string, item: ListItemInput, now: number): ListWrite<{ item: SharedItemView }> {
    return this.db.transaction((): ListWrite<{ item: SharedItemView }> => {
      const row = this.accessible(listId, pid);
      if (row === undefined) return { result: 'not_found' };
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM shared_list_items WHERE list_id = ?').get(listId) as unknown as { n: number };
      if (Number(count.n) >= MAX_LIST_ITEMS) return { result: 'list_full' };
      const exists = this.db.prepare('SELECT 1 AS x FROM shared_list_items WHERE list_id = ? AND type = ? AND tmdb_id = ?').get(listId, item.type, item.tmdbId);
      if (exists !== undefined) return { result: 'item_exists' };
      this.db
        .prepare('INSERT INTO shared_list_items (list_id, type, tmdb_id, title, poster, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(listId, item.type, item.tmdbId, item.title, item.poster ?? null, pid, now);
      const audience = this.liveMembers(listId, row.owner_pid);
      return { result: 'ok', item: { type: item.type, tmdbId: item.tmdbId, title: item.title, poster: item.poster, addedBy: pid, addedAt: now }, audience };
    });
  }

  /** Retire un titre de la liste (tout membre). */
  removeItem(pid: string, listId: string, type: 'movie' | 'series', tmdbId: number): ListWrite {
    return this.db.transaction((): ListWrite => {
      const row = this.accessible(listId, pid);
      if (row === undefined) return { result: 'not_found' };
      const removed = Number(this.db.prepare('DELETE FROM shared_list_items WHERE list_id = ? AND type = ? AND tmdb_id = ?').run(listId, type, tmdbId).changes);
      if (removed === 0) return { result: 'item_not_found' };
      return { result: 'ok', audience: this.liveMembers(listId, row.owner_pid) };
    });
  }

  // Outils internes

  /** Vrai si `a` et `b` sont amis acceptés (le foyer n'est pas une amitié). */
  private isFriend(a: string, b: string): boolean {
    const { low, high } = pairOf(a, b);
    return this.db.prepare("SELECT 1 AS x FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'").get(low, high) !== undefined;
  }

  /** Premier refus parmi des membres proposés : inconnu, ou pas ami du propriétaire. `undefined` si tous sont amis. */
  private checkFriends(ownerPid: string, pids: readonly string[]): 'unknown' | 'not_friend' | undefined {
    for (const pid of pids) {
      if (this.views.card(pid) === undefined) return 'unknown';
      if (!this.isFriend(ownerPid, pid)) return 'not_friend';
    }
    return undefined;
  }

  /** Lignes de membres brutes (propriétaire compris, sans contrôle d'amitié), dans l'ordre d'ajout. */
  private memberRows(listId: string): string[] {
    return (this.db.prepare('SELECT pid FROM shared_list_members WHERE list_id = ? ORDER BY rowid').all(listId) as unknown as { pid: string }[]).map((row) => row.pid);
  }

  /** Membres effectifs : le propriétaire, et les membres qui sont encore amis du propriétaire. */
  private liveMembers(listId: string, ownerPid: string): string[] {
    return this.memberRows(listId).filter((pid) => pid === ownerPid || this.isFriend(ownerPid, pid));
  }

  /** La liste si `pid` en est membre effectif, sinon `undefined`. */
  private accessible(listId: string, pid: string): ListRow | undefined {
    const row = this.db.prepare('SELECT id, owner_pid, name, created_at FROM shared_lists WHERE id = ?').get(listId) as unknown as ListRow | undefined;
    if (row === undefined) return undefined;
    return this.liveMembers(listId, row.owner_pid).includes(pid) ? row : undefined;
  }

  /** Vues des membres pour `viewerPid` : profil public, et drapeau « foyer » si même compte. Membres inconnus ignorés. */
  private memberViews(listId: string, ownerPid: string, viewerPid: string, now: number): FriendView[] {
    const views: FriendView[] = [];
    for (const pid of this.liveMembers(listId, ownerPid)) {
      const view = this.views.subjectView(pid, now);
      if (view === undefined) continue;
      views.push({ ...view, household: this.sameAccount(viewerPid, pid) });
    }
    return views;
  }

  private sameAccount(a: string, b: string): boolean {
    return this.db
      .prepare('SELECT 1 AS x FROM profiles x JOIN profiles y ON y.account_id = x.account_id WHERE x.pid = ? AND y.pid = ?')
      .get(a, b) !== undefined;
  }

  private itemsOf(listId: string): SharedItemView[] {
    const rows = this.db
      .prepare('SELECT type, tmdb_id, title, poster, added_by, added_at FROM shared_list_items WHERE list_id = ? ORDER BY added_at, rowid')
      .all(listId) as unknown as ItemRow[];
    return rows.map((row) => {
      const view: SharedItemView = {
        type: row.type as 'movie' | 'series',
        tmdbId: Number(row.tmdb_id),
        title: row.title,
        addedBy: row.added_by,
        addedAt: Number(row.added_at),
      };
      if (row.poster !== null) view.poster = row.poster;
      return view;
    });
  }
}
