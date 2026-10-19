import { AdminStore } from '../../user/admin-store.js';
import { MetaStore } from '../../user/meta-store.js';
import { existsSync } from 'node:fs';
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
  let stores: { users: UserStore; skips: SkipSegmentStore; social: SocialStore; admin: AdminStore; meta: MetaStore; close(): void } | undefined;
  const open = () => {
    if (stores === undefined) {
      const db = openUserDb(options.path ?? userDbPath());
      stores = {
        users: new UserStore(db),
        skips: new SkipSegmentStore(db),
        social: new SocialStore(db),
        admin: new AdminStore(db),
        meta: new MetaStore(db),
        close: () => db.close(),
      };
    }
    return stores;
  };
  let users: ReturnType<typeof asyncRepo<UserStore>> | undefined;
  let skips: ReturnType<typeof asyncRepo<SkipSegmentStore>> | undefined;
  let social: ReturnType<typeof asyncRepo<SocialStore>> | undefined;
  let admin: ReturnType<typeof asyncRepo<AdminStore>> | undefined;
  let meta: ReturnType<typeof asyncRepo<MetaStore>> | undefined;
  return {
    users: () => (users ??= asyncRepo(open().users)),
    skips: () => (skips ??= asyncRepo(open().skips)),
    social: () => (social ??= asyncRepo(open().social)),
    admin: () => (admin ??= asyncRepo(open().admin)),
    meta: () => (meta ??= asyncRepo(open().meta)),
    hasData: () => stores !== undefined || existsSync(options.path ?? userDbPath()),
    close: () => {
      stores?.close();
      stores = undefined;
      users = undefined;
      skips = undefined;
      social = undefined;
      admin = undefined;
      meta = undefined;
    },
  };
}
