import { asyncRepo, type UserBackend } from '../../user/repo.js';
import { SkipSegmentStore } from '../../user/skip-segments.js';
import { SocialStore } from '../../user/social-store.js';
import { UserStore } from '../../user/store.js';
import { openUserDb, userDbPath } from './user-db.js';

/**
 * Dépôts Node : une seule base node:sqlite (fichier LASTADDON_DATA_DIR/laststream.db, ou `path`), ouverte au premier
 * appel — une application sans routes /user ni segments de saut n'écrit jamais de fichier.
 */
export function createNodeUserBackend(options: { path?: string } = {}): UserBackend {
  let stores: { users: UserStore; skips: SkipSegmentStore; social: SocialStore; close(): void } | undefined;
  const open = () => {
    if (stores === undefined) {
      const db = openUserDb(options.path ?? userDbPath());
      stores = { users: new UserStore(db), skips: new SkipSegmentStore(db), social: new SocialStore(db), close: () => db.close() };
    }
    return stores;
  };
  let users: ReturnType<typeof asyncRepo<UserStore>> | undefined;
  let skips: ReturnType<typeof asyncRepo<SkipSegmentStore>> | undefined;
  let social: ReturnType<typeof asyncRepo<SocialStore>> | undefined;
  return {
    users: () => (users ??= asyncRepo(open().users)),
    skips: () => (skips ??= asyncRepo(open().skips)),
    social: () => (social ??= asyncRepo(open().social)),
    close: () => {
      stores?.close();
      stores = undefined;
      users = undefined;
      skips = undefined;
      social = undefined;
    },
  };
}
