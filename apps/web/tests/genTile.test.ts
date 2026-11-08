// Tuile « En vedette » générée (TMDB) : structure, échappement, variantes par genre. Aucun réseau.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/lt', () => ({ tmdb: vi.fn(async () => ({ results: [] })) }));

function mountDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('genTile', () => {
  it('personne : fond, portrait, kicker, titre et sous-titre échappés', async () => {
    mountDom();
    const { genTile } = await import('../src/ui/collections.js');
    const h = genTile({ id: 'gen-cast-500', kind: 'cast', title: 'A <b>&"', kicker: 'Acteur', portrait: 'https://x/p.jpg', backdrops: ['https://x/b.jpg'], subtitle: 'Inception · Tenet' });
    expect(h).toContain('href="#/collection/gen-cast-500"');
    expect(h).toContain('data-folder="gen-cast-500"');
    expect(h).toContain('ct-gen-cast');
    expect(h).toContain('gt-portrait');
    expect(h).toContain('gt-bg');
    expect(h).toContain('aria-label="Acteur : A &lt;b&gt;&amp;&quot;"');
    expect(h).not.toContain('<b>');
    expect(h).not.toContain('data-gif');
    expect(h).toContain('Inception · Tenet');
  });

  it('décennie : mosaïque et filigrane ; sans image, le dégradé reste', async () => {
    mountDom();
    const { genTile } = await import('../src/ui/collections.js');
    const h = genTile({ id: 'gen-decade-1980', kind: 'decade', title: 'Années 80', kicker: 'Décennie', backdrops: ['a', 'b', 'c'] });
    expect(h).toContain('gt-n3');
    expect(h).toContain('>80s<');
    const bare = genTile({ id: 'gen-kw-1', kind: 'keyword', title: 'Cyberpunk', kicker: 'Thème', backdrops: [] });
    expect(bare).toContain('gt-n0');
    expect(bare).not.toContain('<img');
    expect(bare).toContain('--c1:');
  });
});
