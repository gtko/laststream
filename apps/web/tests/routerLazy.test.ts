// Routeur et vues chargées à la demande (LAST-129) : une vue en retard ne s'affiche pas, un échec de chargement se voit.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let releaseStats!: () => void;
let statsGate: Promise<void>;
const showStats = vi.fn();
const showSearch = vi.fn();

vi.mock('../src/ui/stats.js', async () => {
  await statsGate;
  return { showStats };
});
vi.mock('../src/ui/search.js', () => ({ showSearch }));
// Module qui n'arrive pas (réseau coupé, fichier retiré après une mise en ligne).
vi.mock('../src/ui/hidden.js', () => {
  throw new Error('chunk introuvable');
});

type Router = typeof import('../src/ui/router.js');
let router: Router;

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  window.scrollTo = () => undefined;
});

beforeEach(async () => {
  vi.resetModules();
  showStats.mockClear();
  showSearch.mockClear();
  statsGate = new Promise<void>((r) => { releaseStats = r; });
  location.hash = '';
  document.getElementById('detail')!.innerHTML = '';
  router = await import('../src/ui/router.js');
});

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('routeur : vues chargées à la demande', () => {
  it('vue A en chargement puis navigation vers B : A ne s’affiche pas', async () => {
    location.hash = '#/stats';
    router.route();
    location.hash = '#/calendar';
    router.route();
    releaseStats();
    await flush();
    expect(document.getElementById('detail')!.innerHTML).not.toBe('');
    expect(showSearch).not.toHaveBeenCalled();
    expect(showStats).not.toHaveBeenCalled();
  });

  it('vue A en chargement puis retour à l’accueil : A ne s’affiche pas', async () => {
    location.hash = '#/stats';
    router.route();
    location.hash = '';
    router.route();
    releaseStats();
    await flush();
    expect(showStats).not.toHaveBeenCalled();
  });

  it('sans navigation, la vue chargée s’affiche', async () => {
    location.hash = '#/stats';
    router.route();
    releaseStats();
    await flush();
    expect(showStats).toHaveBeenCalledTimes(1);
  });

  it('échec d’import : état d’erreur avec Réessayer, qui rejoue la route', async () => {
    location.hash = '#/hidden';
    router.route();
    await flush();
    const detail = document.getElementById('detail')!;
    expect(detail.textContent).toContain('Impossible de charger cette page.');
    const btn = detail.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('Réessayer');
    detail.insertAdjacentHTML('beforeend', '<i id="marque"></i>');
    btn.click(); // la route est rejouée : l'import échoue encore ici, l'état d'erreur est redessiné
    await flush();
    expect(detail.querySelector('#marque')).toBeNull();
    expect(detail.querySelector('button')).not.toBeNull();
  });

  it('échec d’une vue abandonnée : pas d’état d’erreur sur la page suivante', async () => {
    location.hash = '#/hidden';
    router.route();
    location.hash = '#/search';
    router.route();
    await flush();
    expect(document.getElementById('detail')!.textContent).not.toContain('Impossible de charger');
  });
});
