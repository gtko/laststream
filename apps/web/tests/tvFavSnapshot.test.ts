// Favoris et « Reprendre la dernière chaîne » : un instantané sans URL, source de rechange ni box (ancien format) n'est
// ni affiché, ni compté, ni repris. Une chaîne avec URL, source de rechange ou box reste exploitable.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { favStorageKey, isPlayableSnapshot } from '../src/data/tvChannelList';

type TvModule = typeof import('../src/ui/tv.js');
let tvMod: TvModule;

const live = (id: string, name: string) => ({
  id, name, logo: '', group: 'France', cat: 'Généraliste', source: 'freetv', fast: false,
  url: 'https://up.example/' + id.replace(/\W/g, '') + '.m3u8', sig: null, epgId: id, flaky: false, alternatives: [],
});
// Ancien format : chaîne d'une source retirée, sans URL, sans rechange et sans box.
const OLD = { id: 'ancienne:1', name: 'Ancienne chaîne', logo: '', group: '', cat: '', source: 'retiree', fast: false, sig: null };

beforeAll(async () => {
  // tv.js lit des éléments du DOM à l'import (modale, détail) : on monte la page comme les autres tests TV.
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  // player.js d'abord : tv.js importe (par shows.js) player.js ; dans l'autre sens, playerEl n'est pas encore défini.
  await import('../src/ui/player.js');
  tvMod = await import('../src/ui/tv.js');
});

describe('isPlayableSnapshot', () => {
  it('garde une chaîne avec URL, source de rechange ou box ; écarte le reste', () => {
    expect(isPlayableSnapshot(live('a', 'A'))).toBe(true);
    expect(isPlayableSnapshot({ id: 'b', box: { id: 'b', url: 'http://box.lan/b.m3u8' } })).toBe(true);
    expect(isPlayableSnapshot({ id: 'c', alternatives: [{ url: 'https://c.example/alt.m3u8', sig: null }] })).toBe(true);
    expect(isPlayableSnapshot(OLD)).toBe(false);
    expect(isPlayableSnapshot({ id: 'd', url: '', alternatives: [{ sig: null }] })).toBe(false);
    expect(isPlayableSnapshot(null)).toBe(false);
    expect(isPlayableSnapshot(undefined)).toBe(false);
  });
});

describe('favoris dont l’instantané n’a pas d’URL', () => {
  beforeEach(() => {
    localStorage.clear();
    tvMod.tv.byId.clear();
    tvMod.tv.user = [];
    tvMod.tv.boxOnly = [];
    tvMod.tv.cat = 'Favoris';
  });

  it('n’apparaît pas dans Favoris et n’est pas compté', () => {
    tvMod.tv.byId.set('fr:TF1.fr', live('fr:TF1.fr', 'TF1'));
    localStorage.setItem(favStorageKey(), JSON.stringify([OLD.id, 'fr:TF1.fr']));
    localStorage.setItem(tvMod.FAV_SNAP_KEY, JSON.stringify({ [OLD.id]: OLD }));
    expect(tvMod.tvFilter().map((c: { id: string }) => c.id)).toEqual(['fr:TF1.fr']);
    expect(tvMod.catCount('Favoris')).toBe(1);
  });

  it('un favori hors catalogue mais avec un instantané exploitable reste affiché et compté', () => {
    localStorage.setItem(favStorageKey(), JSON.stringify(['fr:M6.fr']));
    localStorage.setItem(tvMod.FAV_SNAP_KEY, JSON.stringify({ 'fr:M6.fr': live('fr:M6.fr', 'M6') }));
    expect(tvMod.tvFilter().map((c: { id: string }) => c.id)).toEqual(['fr:M6.fr']);
    expect(tvMod.catCount('Favoris')).toBe(1);
  });
});

describe('« Reprendre la dernière chaîne »', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('dernière chaîne sans URL : le bouton « Reprendre » n’est pas proposé', () => {
    localStorage.setItem('ls_tv_last', JSON.stringify(OLD));
    expect(tvMod.tvPageHTML()).not.toContain('Reprendre la dernière chaîne');
  });

  it('dernière chaîne avec URL : le bouton est proposé', () => {
    localStorage.setItem('ls_tv_last', JSON.stringify(live('fr:TF1.fr', 'TF1')));
    expect(tvMod.tvPageHTML()).toContain('Reprendre la dernière chaîne');
  });
});
