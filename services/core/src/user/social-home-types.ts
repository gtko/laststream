// Copie temporaire du protocole v0.3.0 (LAST-191) : remplacée par l'import @laststream/protocol/social une fois le tag publié
// Ami affiché sur l'accueil : identité publique et surnom posé par le lecteur, rien de l'état de présence ni des réglages.
export type HomeFriend = { pid: string; handle: { name: string; tag: string; full: string }; avatarColor: string; avatar?: string; nickname?: string };
export interface HomeMedia { type: 'movie' | 'series'; tmdbId: number; title?: string; poster?: string; season?: number; episode?: number }
export interface HomeWatchingItem { friend: HomeFriend; media: HomeMedia; pos: number; duration?: number; finished: boolean; live: boolean; updatedAt: number }
export interface HomeWatchingResponse { items: HomeWatchingItem[] }
export interface HomeTitleProgress { friend: HomeFriend; type: HomeMedia['type']; tmdbId: number; season?: number; episode?: number; pos: number; duration?: number; finished: boolean; updatedAt: number }
export interface HomeProgressResponse { items: HomeTitleProgress[] }
