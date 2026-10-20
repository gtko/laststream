import type { SqlDb } from './sql.js';

/**
 * Handles des profils (`Nom#TAG`) et identifiants publics (`pid`) des profils non enfants. Le handle sert à retrouver
 * un profil pour l'ajouter en ami ; le `pid` est le seul identifiant exposé aux autres comptes (jamais l'id interne).
 * Les profils enfants n'ont ni handle ni pid. Tirages par `crypto.getRandomValues`, injectables pour les tests.
 */

/** Alphabet du tag : 31 symboles, sans 0 O 1 I L. 31^4 = 923 521 tags par nom. */
export const HANDLE_TAG_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const HANDLE_TAG_LENGTH = 4;
/** Alphabet base32 (RFC 4648) du pid : 16 caractères, soit 80 bits aléatoires. */
export const PID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PID_LENGTH = 16;
/** Nom de repli quand le nom du profil ne contient aucun caractère admis (ex. « ??? »). */
export const FALLBACK_HANDLE_NAME = 'Profil';
/** Tirages successifs tolérés avant abandon. Une collision répétée n'arrive pas en pratique. */
const MAX_ALLOCATION_ATTEMPTS = 64;
const HANDLE_NAME_MIN_LENGTH = 2;
const HANDLE_NAME_MAX_LENGTH = 20;
/** Nom admis dans un handle : 2 à 20 caractères (lettres Unicode, chiffres, espace, `_`, `-`). */
const HANDLE_NAME_PATTERN = /^[\p{L}\p{N} _-]{2,20}$/u;
/** Saisie du tag : quatre caractères ASCII alphanumériques (avant mise en majuscules). */
const HANDLE_TAG_INPUT_PATTERN = /^[0-9A-Za-z]{4}$/;

/** Remplit `bytes` d'octets aléatoires. */
export type RandomBytes = (bytes: Uint8Array) => void;

/** Source par défaut : Web Crypto (disponible sous Node et sous les Workers). */
const cryptoRandomBytes: RandomBytes = (bytes) => {
  globalThis.crypto.getRandomValues(bytes);
};

interface Handle {
  /** Nom d'affichage, casse conservée. */
  name: string;
  tag: string;
  /** `Nom#TAG`. */
  full: string;
}

export interface ParsedHandle extends Handle {
  /** Nom normalisé (minuscules, espaces simples) : clé d'unicité avec le tag. */
  key: string;
}

/** Normalise un nom pour l'unicité : forme NFC, espaces réduits, minuscules. */
export function normalizeHandleName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Vrai si `name` (sans espace de bord) est un nom de handle valide. */
export function isValidHandleName(name: string): boolean {
  return HANDLE_NAME_PATTERN.test(name);
}

/**
 * Nom de handle dérivé du nom du profil. Le nom du profil peut contenir d'autres caractères (ou dépasser 20) : on ne
 * garde que les lettres, chiffres, espaces, `_` et `-`, puis on tronque à 20 caractères.
 */
export function handleNameFromProfileName(profileName: string): string {
  const cleaned = profileName.normalize('NFC').replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const name = [...cleaned].slice(0, HANDLE_NAME_MAX_LENGTH).join('').trim();
  return [...name].length >= HANDLE_NAME_MIN_LENGTH ? name : FALLBACK_HANDLE_NAME;
}

/**
 * Tire `length` symboles de `alphabet`. Les octets au-delà du plus grand multiple de la taille de l'alphabet sont
 * rejetés : chaque symbole a exactement la même probabilité.
 */
function randomSymbols(alphabet: string, length: number, random: RandomBytes): string {
  const limit = 256 - (256 % alphabet.length);
  const byte = new Uint8Array(1);
  let out = '';
  while (out.length < length) {
    random(byte);
    const value = byte[0] ?? 0;
    if (value < limit) out += alphabet[value % alphabet.length];
  }
  return out;
}

/** Tag aléatoire de 4 caractères de l'alphabet des tags. */
export function generateHandleTag(random: RandomBytes = cryptoRandomBytes): string {
  return randomSymbols(HANDLE_TAG_ALPHABET, HANDLE_TAG_LENGTH, random);
}

/** Identifiant public aléatoire (16 caractères base32). */
export function generatePid(random: RandomBytes = cryptoRandomBytes): string {
  return randomSymbols(PID_ALPHABET, PID_LENGTH, random);
}

/**
 * Lit une saisie « Nom#TAG ». La casse est indifférente (tag mis en majuscules). Renvoie `null` si la forme est
 * mauvaise, si le nom sort de la plage admise, ou si le tag contient un caractère hors de l'alphabet.
 */
export function parseHandle(input: string): ParsedHandle | null {
  const parts = input.trim().split('#');
  if (parts.length !== 2) return null;
  const name = (parts[0] ?? '').trim();
  const rawTag = parts[1] ?? '';
  if (!isValidHandleName(name) || !HANDLE_TAG_INPUT_PATTERN.test(rawTag)) return null;
  const tag = rawTag.toUpperCase();
  for (const symbol of tag) {
    if (!HANDLE_TAG_ALPHABET.includes(symbol)) return null;
  }
  return { name, key: normalizeHandleName(name), tag, full: `${name}#${tag}` };
}

function isPidTaken(db: SqlDb, pid: string): boolean {
  return db.prepare('SELECT 1 AS taken FROM profiles WHERE pid = ? LIMIT 1').get(pid) !== undefined;
}

function isTagTaken(db: SqlDb, key: string, tag: string, profileId: string): boolean {
  return db.prepare('SELECT 1 AS taken FROM profiles WHERE handle_key = ? AND handle_tag = ? AND id <> ? LIMIT 1').get(key, tag, profileId) !== undefined;
}

/** Pid non utilisé, par retirages successifs. */
function allocatePid(db: SqlDb, random: RandomBytes): string {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const pid = generatePid(random);
    if (!isPidTaken(db, pid)) return pid;
  }
  throw new Error('attribution du pid impossible (collisions répétées)');
}

/** Tag non utilisé pour ce nom normalisé, par retirages successifs. */
function allocateTag(db: SqlDb, key: string, profileId: string, random: RandomBytes): string {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const tag = generateHandleTag(random);
    if (!isTagTaken(db, key, tag, profileId)) return tag;
  }
  throw new Error('attribution du tag impossible (collisions répétées)');
}

/**
 * Nouveau tag pour un profil déjà identifié (changement volontaire) : différent de l'actuel et non pris pour ce nom
 * normalisé. Renvoie le tag sans l'écrire ; l'appelant l'enregistre dans sa propre transaction.
 */
export function drawNewHandleTag(db: SqlDb, profileId: string, key: string, currentTag: string, random: RandomBytes = cryptoRandomBytes): string {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const tag = generateHandleTag(random);
    if (tag !== currentTag && !isTagTaken(db, key, tag, profileId)) return tag;
  }
  throw new Error('attribution du tag impossible (collisions répétées)');
}

/**
 * Aligne l'identité sociale d'un profil sur son état après création ou modification :
 * - profil enfant : identité retirée (aucun handle ni pid) ;
 * - profil adulte sans identité (création, ou passage de enfant à adulte) : pid et handle attribués ;
 * - profil adulte déjà identifié (renommage) : le tag est gardé, sauf collision avec un autre profil de même nom.
 * Ne fait rien si le profil n'appartient pas au compte. N'ouvre pas de transaction : à appeler dans la transaction
 * de l'écriture du profil.
 */
export function syncProfileIdentity(
  db: SqlDb,
  accountId: string,
  profileId: string,
  profileName: string,
  isKid: boolean,
  random: RandomBytes = cryptoRandomBytes,
): void {
  const row = db.prepare('SELECT pid, handle_tag FROM profiles WHERE id = ? AND account_id = ?').get(profileId, accountId) as
    | { pid: string | null; handle_tag: string | null }
    | undefined;
  if (row === undefined) return;
  if (isKid) {
    if (row.pid !== null) clearIdentity(db, profileId, row.pid);
    return;
  }
  const name = handleNameFromProfileName(profileName);
  const key = normalizeHandleName(name);
  if (row.pid === null) {
    const pid = allocatePid(db, random);
    const tag = allocateTag(db, key, profileId, random);
    db.prepare('UPDATE profiles SET pid = ?, handle_name = ?, handle_key = ?, handle_tag = ? WHERE id = ?').run(pid, name, key, tag, profileId);
    return;
  }
  const keptTag = row.handle_tag;
  const tag = keptTag !== null && !isTagTaken(db, key, keptTag, profileId) ? keptTag : allocateTag(db, key, profileId, random);
  db.prepare('UPDATE profiles SET handle_name = ?, handle_key = ?, handle_tag = ? WHERE id = ?').run(name, key, tag, profileId);
}

/**
 * Attribue pid et handle à chaque profil adulte existant (migration v14). Les profils enfants sont ignorés. Ordre :
 * création, pour que le résultat soit déterministe à collisions égales.
 */
export function backfillProfileIdentities(db: SqlDb, random: RandomBytes = cryptoRandomBytes): void {
  const rows = db.prepare('SELECT id, account_id, name FROM profiles WHERE is_kid = 0 ORDER BY created_at, id').all() as {
    id: string;
    account_id: string;
    name: string;
  }[];
  for (const row of rows) {
    syncProfileIdentity(db, row.account_id, row.id, row.name, false, random);
  }
}

/**
 * Révocation de l'amitié legacy (compte↔compte, table `friendships`) entre deux profils : elle n'est supprimée que si les
 * deux profils sont les profils principaux de leurs comptes (c'est la seule paire que la v2 reflète). Sinon, rien.
 * Sans elle, un ex-ami retirerait en v2 mais garderait l'accès legacy à la bibliothèque et à la présence.
 */
export function revokeLegacyFriendship(db: SqlDb, pidA: string, pidB: string): void {
  const rowA = db.prepare('SELECT account_id FROM profiles WHERE pid = ?').get(pidA) as { account_id: string } | undefined;
  const rowB = db.prepare('SELECT account_id FROM profiles WHERE pid = ?').get(pidB) as { account_id: string } | undefined;
  if (rowA === undefined || rowB === undefined || rowA.account_id === rowB.account_id) return;
  if (principalPidOf(db, rowA.account_id) !== pidA || principalPidOf(db, rowB.account_id) !== pidB) return;
  const low = rowA.account_id < rowB.account_id ? rowA.account_id : rowB.account_id;
  const high = rowA.account_id < rowB.account_id ? rowB.account_id : rowA.account_id;
  db.prepare('DELETE FROM friendships WHERE low_id = ? AND high_id = ?').run(low, high);
}

/**
 * Révoque l'amitié legacy entre `pid` et chacun de ses amis v2 (acceptés ou en attente). À appeler avant la disparition
 * du profil (suppression, ou perte d'identité par passage en enfant), tant que son pid existe encore.
 */
function revokeLegacyFriendshipsOf(db: SqlDb, pid: string): void {
  const rows = db
    .prepare('SELECT CASE WHEN low_pid = ? THEN high_pid ELSE low_pid END AS other FROM profile_friendships WHERE low_pid = ? OR high_pid = ?')
    .all(pid, pid, pid) as { other: string }[];
  for (const row of rows) revokeLegacyFriendship(db, pid, row.other);
}

/** Profil principal d'un compte (premier profil non enfant créé, même règle que la migration v14), `undefined` sinon. */
function principalPidOf(db: SqlDb, accountId: string): string | undefined {
  const row = db
    .prepare('SELECT pid FROM profiles WHERE account_id = ? AND is_kid = 0 AND pid IS NOT NULL ORDER BY created_at, id LIMIT 1')
    .get(accountId) as { pid: string } | undefined;
  return row?.pid;
}

/**
 * Amitié d'invitation en v2 : le parrain et le filleul deviennent amis (amitié acceptée) entre leurs profils principaux.
 * À l'inscription, le filleul n'a pas encore de profil ; le lien est donc posé quand le profil principal de l'un ou l'autre
 * existe. Appelée à la création du premier profil adulte d'un compte : elle couvre le filleul qui crée son profil après
 * le parrain, et le parrain qui crée le sien après le filleul. Les liens d'invitation (`invites`) restent la source.
 * Rien ne se passe si l'un des deux comptes n'a pas de profil principal.
 */
export function linkInvitedPrincipals(db: SqlDb, accountId: string, now: number): void {
  const pairs: { inviter: string; invitee: string }[] = [];
  const invitedBy = db.prepare('SELECT inviter_id FROM invites WHERE used_by = ? AND inviter_id IS NOT NULL').get(accountId) as
    | { inviter_id: string }
    | undefined;
  if (invitedBy !== undefined) pairs.push({ inviter: invitedBy.inviter_id, invitee: accountId });
  const invitees = db.prepare('SELECT used_by FROM invites WHERE inviter_id = ? AND used_by IS NOT NULL').all(accountId) as { used_by: string }[];
  for (const row of invitees) pairs.push({ inviter: accountId, invitee: row.used_by });
  for (const { inviter, invitee } of pairs) {
    const a = principalPidOf(db, inviter);
    const b = principalPidOf(db, invitee);
    if (a === undefined || b === undefined) continue;
    const low = a < b ? a : b;
    const high = a < b ? b : a;
    // ON CONFLICT : une paire déjà liée n'est ni dupliquée ni modifiée.
    db.prepare(
      `INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at, accepted_at) VALUES (?, ?, ?, 'accepted', ?, ?)
       ON CONFLICT (low_pid, high_pid) DO NOTHING`,
    ).run(low, high, a, now, now);
  }
}

/**
 * Après le départ d'un membre d'un groupe (ligne déjà retirée) : le groupe devenu vide est supprimé ; si le membre parti
 * en était le propriétaire (`created_by`), la propriété passe au plus ancien membre restant.
 */
export function settleGroupAfterLeave(db: SqlDb, groupId: string, leaverPid: string): void {
  const first = db
    .prepare('SELECT pid FROM social_group_members WHERE group_id = ? ORDER BY joined_at, pid LIMIT 1')
    .get(groupId) as { pid: string } | undefined;
  if (first === undefined) {
    db.prepare('DELETE FROM social_groups WHERE id = ?').run(groupId);
    return;
  }
  db.prepare('UPDATE social_groups SET created_by = ? WHERE id = ? AND created_by = ?').run(first.pid, groupId, leaverPid);
}

/**
 * Supprime toutes les données sociales qui référencent le pid d'un profil (clés étrangères sur `profiles(pid)`, migrations
 * 14 à 22) : amitiés, présence, relations, messages, réactions, votes, notes, blocages, demandes de rejoindre, préférences,
 * activité, liens publics (l'invitation réservée est libérée), listes partagées possédées (avec leurs éléments et membres),
 * éléments ajoutés et appartenances aux listes d'autrui, appartenances aux groupes (groupe vide supprimé, propriété
 * transmise au plus ancien membre). À appeler avant de vider ou supprimer le pid.
 */
export function purgeSocialData(db: SqlDb, pid: string): void {
  revokeLegacyFriendshipsOf(db, pid);
  db.prepare('DELETE FROM profile_friendships WHERE low_pid = ? OR high_pid = ?').run(pid, pid);
  db.prepare('DELETE FROM profile_presence WHERE profile_pid = ?').run(pid);
  db.prepare('DELETE FROM profile_relations WHERE owner_pid = ? OR target_pid = ?').run(pid, pid);
  db.prepare('DELETE FROM messages WHERE from_pid = ? OR to_pid = ?').run(pid, pid);
  db.prepare('DELETE FROM message_reactions WHERE pid = ?').run(pid);
  db.prepare('DELETE FROM poll_votes WHERE pid = ?').run(pid);
  db.prepare('DELETE FROM activity WHERE pid = ?').run(pid);
  // Liens publics : l'invitation réservée par un lien non consommé redevient libre.
  db.prepare(
    'UPDATE invites SET sent_at = NULL WHERE used_at IS NULL AND id IN (SELECT invite_id FROM share_links WHERE author_pid = ? AND invite_id IS NOT NULL)',
  ).run(pid);
  db.prepare('DELETE FROM share_links WHERE author_pid = ?').run(pid);
  // Listes partagées : celles que ce profil possède disparaissent avec leurs éléments et leurs membres.
  db.prepare('DELETE FROM shared_list_items WHERE list_id IN (SELECT id FROM shared_lists WHERE owner_pid = ?)').run(pid);
  db.prepare('DELETE FROM shared_list_members WHERE list_id IN (SELECT id FROM shared_lists WHERE owner_pid = ?)').run(pid);
  db.prepare('DELETE FROM shared_lists WHERE owner_pid = ?').run(pid);
  db.prepare('DELETE FROM shared_list_items WHERE added_by = ?').run(pid);
  db.prepare('DELETE FROM shared_list_members WHERE pid = ?').run(pid);
  const groups = db.prepare('SELECT group_id FROM social_group_members WHERE pid = ?').all(pid) as { group_id: string }[];
  db.prepare('DELETE FROM social_group_members WHERE pid = ?').run(pid);
  for (const group of groups) settleGroupAfterLeave(db, group.group_id, pid);
  db.prepare('DELETE FROM notes WHERE author_pid = ?').run(pid);
  db.prepare('DELETE FROM blocks WHERE blocker_pid = ? OR blocked_pid = ?').run(pid, pid);
  db.prepare('DELETE FROM join_requests WHERE requester_pid = ? OR host_pid = ?').run(pid, pid);
  db.prepare('DELETE FROM social_prefs WHERE profile_pid = ?').run(pid);
}

/**
 * Retire l'identité sociale d'un profil devenu enfant : toutes ses données sociales disparaissent (voir `purgeSocialData` ;
 * les clés étrangères sur pid interdiraient sinon de vider le pid), puis le pid et le handle sont mis à NULL.
 */
function clearIdentity(db: SqlDb, profileId: string, pid: string): void {
  purgeSocialData(db, pid);
  db.prepare('UPDATE profiles SET pid = NULL, handle_name = NULL, handle_key = NULL, handle_tag = NULL WHERE id = ?').run(profileId);
}


