import { auth } from './auth';
import { call } from './userApi';

/* Client du forum communautaire (`/user/forum/*`, LAST-1651) : chaque appel agit au nom du profil actif (X-Profile-Id,
 * X-Profile-Token si PIN), comme le social. Aucun texte n'est affiché ici. */

type ForumRole = 'owner' | 'mod' | 'member';
type PostHidden = '' | 'author' | 'mod' | 'auto';
export const FORUM_REACTIONS = ['👍', '❤️', '😂', '😮', '🎬', '🙏', '🔥', '👀'] as const;
export type ReportReason = 'spam' | 'harassment' | 'piracy' | 'spoiler' | 'off_topic' | 'other';

export interface ForumAuthor {
  pid: string;
  handle?: { name: string; tag: string; full: string };
  avatarColor?: string;
  avatar?: string;
  role: ForumRole;
}
interface ForumMe {
  pid: string;
  role: ForumRole;
  bannedUntil?: number | null;
}
interface ForumCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  staffOnly: boolean;
  topicCount: number;
  postCount: number;
  lastPostAt: number | null;
}
export interface ForumTopic {
  id: string;
  categoryId: string;
  title: string;
  author: ForumAuthor;
  createdAt: number;
  lastPostAt: number;
  lastPoster: ForumAuthor;
  replyCount: number;
  pinned: boolean;
  locked: boolean;
  hidden: boolean;
  event?: ForumEvent;
}
/** Séance d'une watch party (catégorie watch-parties). */
export interface ForumEvent {
  startsAt: number;
  roomId: string | null;
  going: number;
  mine?: boolean;
}
export interface ForumPost {
  id: string;
  author: ForumAuthor;
  body: string;
  createdAt: number;
  editedAt?: number;
  hidden: PostHidden;
  reactions: { emoji: string; count: number; mine: boolean }[];
  canEdit: boolean;
  reported: boolean;
}
export interface ForumTopicDetail extends ForumTopic {
  attendees?: ForumAuthor[];
  /** Sujet alimenté par le bouton feedback de l'app : membres concernés ; références Sentry pour l'équipe seulement. */
  feedback?: { reporters: number; sentryEventIds?: string[] };
  posts: ForumPost[];
  more: boolean;
}
interface ForumPulse {
  stats: { topics: number; posts: number; members: number; postsToday: number };
  recent: (ForumTopic & { excerpt: string })[];
  trending: (ForumTopic & { heat: number })[];
  activeMembers: { author: ForumAuthor; posts: number }[];
  events: ForumTopic[];
}
export interface ForumHome {
  me: ForumMe;
  categories: ForumCategory[];
  pulse: ForumPulse;
  openReports?: number;
}
export interface ForumReport {
  postId: string;
  topicId: string;
  topicTitle: string;
  author: ForumAuthor;
  body: string;
  hidden: PostHidden;
  count: number;
  reasons: ReportReason[];
  details: string[];
  firstAt: number;
}
export interface ForumBan {
  pid: string;
  author: ForumAuthor;
  until: number | null;
  reason?: string;
  createdAt: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
function forum<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const pid = auth.profile?.id;
  return call<T>('/forum' + path, { method, body, profileId: pid, headers: pid ? { 'x-profile-id': pid } : undefined });
}
const enc = encodeURIComponent;

export const home = () => forum<ForumHome>('GET', '');
export const topics = (categoryId: string, before?: number) =>
  forum<{ topics: ForumTopic[]; more: boolean }>('GET', '/categories/' + enc(categoryId) + '/topics' + (before ? '?before=' + before : ''));
export const search = (q: string) => forum<{ topics: ForumTopic[] }>('GET', '/search?q=' + enc(q));
export const topic = (id: string, after?: number) => forum<{ topic: ForumTopicDetail }>('GET', '/topics/' + enc(id) + (after ? '?after=' + after : ''));
export const createTopic = (categoryId: string, title: string, body: string, startsAt?: number) =>
  forum<{ topic: ForumTopic }>('POST', '/topics', startsAt === undefined ? { categoryId, title, body } : { categoryId, title, body, startsAt });
export const rsvp = (topicId: string, on: boolean) => forum<{ event: ForumEvent }>('PUT', '/topics/' + enc(topicId) + '/rsvp', { on });
/** Ouvre (ou retrouve) le salon de visionnage d'une séance : auteur du sujet ou équipe. */
export const openEvent = (topicId: string) => forum<{ roomId: string }>('POST', '/topics/' + enc(topicId) + '/open');
export const reply = (topicId: string, body: string) => forum<{ post: ForumPost; topic: ForumTopic }>('POST', '/topics/' + enc(topicId) + '/posts', { body });
export const editPost = (postId: string, body: string) => forum<{ post: ForumPost }>('PATCH', '/posts/' + enc(postId), { body });
export const deletePost = (postId: string) => forum<{ topicRemoved: boolean }>('DELETE', '/posts/' + enc(postId));
export const react = (postId: string, emoji: string, on: boolean) => forum<{ reactions: ForumPost['reactions'] }>('PUT', '/posts/' + enc(postId) + '/reactions', { emoji, on });
/** Feedback de l'app (LAST-1654) : sujet ouvert, ou réponse dans le sujet de même empreinte (`grouped`). */
export const sendForumFeedback = (input: {
  kind: 'bug' | 'idea';
  code?: string;
  title?: string;
  message: string;
  version?: string;
  platform?: string;
  sentryEventId?: string;
}) => forum<{ topic: ForumTopic; grouped: boolean; reporters: number }>('POST', '/feedback', JSON.parse(JSON.stringify(input)));
export const report = (postId: string, reason: ReportReason, details?: string) =>
  forum<void>('POST', '/posts/' + enc(postId) + '/report', details ? { reason, details } : { reason });

// ---- Équipe ----
export const setTopic = (id: string, flags: { pinned?: boolean; locked?: boolean; hidden?: boolean; categoryId?: string; title?: string }) =>
  forum<{ topic: ForumTopic }>('PATCH', '/topics/' + enc(id), flags);
export const moderatePost = (postId: string, hide: boolean) => forum<void>('POST', '/posts/' + enc(postId) + '/moderate', { hide });
export const reports = () => forum<{ reports: ForumReport[] }>('GET', '/mod/reports');
export const dismissReports = (postId: string) => forum<void>('POST', '/mod/reports/' + enc(postId) + '/dismiss');
export const bans = () => forum<{ bans: ForumBan[] }>('GET', '/mod/bans');
export const ban = (pid: string, days: number | null, reason?: string) => forum<{ until: number | null }>('PUT', '/mod/bans/' + enc(pid), reason ? { days, reason } : { days });
export const unban = (pid: string) => forum<void>('DELETE', '/mod/bans/' + enc(pid));
export const moderators = () => forum<{ moderators: ForumAuthor[] }>('GET', '/mod/moderators');
export const addModerator = (handle: string) => forum<{ moderator: ForumAuthor }>('POST', '/mod/moderators', { handle });
export const removeModerator = (pid: string) => forum<void>('DELETE', '/mod/moderators/' + enc(pid));
