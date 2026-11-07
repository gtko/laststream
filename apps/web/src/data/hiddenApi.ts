import type { HiddenBackend, HiddenEntry } from './homeFilters';
import { HIDDEN_PAGE, listHidden, putHidden, removeHidden, type HiddenItemDto } from './socialApi';

/* Titres masqués sur le serveur : lecture paginée (500 par page, du plus récent au plus ancien), écritures par lots. */

const MAX_PAGES = 60; // 20 000 titres au plus, par pages de 500 : garde-fou contre un curseur qui ne finirait pas

function toEntry(i: HiddenItemDto): HiddenEntry | null {
  if (!/^(movie|tv):\d+$/.test(i.key)) return null;
  return { key: i.key, title: i.title ?? '', poster: i.poster ?? '', addedAt: Number.isFinite(i.addedAt) ? i.addedAt : 0 };
}

export const apiHiddenBackend: HiddenBackend = {
  async load(profileId) {
    const out: HiddenEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listHidden(profileId, { limit: HIDDEN_PAGE, cursor });
      for (const item of res.items) {
        const e = toEntry(item);
        if (e) out.push(e);
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out.reverse(); // du plus ancien au plus récent, comme le stockage local
  },
  async put(profileId, entries) {
    await putHidden(profileId, entries.map((e) => ({ key: e.key, title: e.title, ...(e.poster ? { poster: e.poster } : {}), addedAt: e.addedAt })));
    return true;
  },
  async remove(profileId, keys) {
    await removeHidden(profileId, keys);
    return true;
  },
};
