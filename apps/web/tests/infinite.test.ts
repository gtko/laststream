import { beforeEach, describe, expect, it, vi } from 'vitest';

let fire: (() => void) | null = null;
class FakeIO {
  cb: (e: Array<{ isIntersecting: boolean }>) => void;
  constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { this.cb = cb; fire = () => this.cb([{ isIntersecting: true }]); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  fire = null;
  vi.stubGlobal('IntersectionObserver', FakeIO);
});

describe('défilement infini', () => {
  it('charge la page suivante à l’approche de la fin, avec squelettes, puis « Fin de la liste »', async () => {
    const { infiniteList } = await import('../src/ui/infinite.js');
    const host = document.getElementById('host')!;
    const resolvers: Array<(v: { html: string; done: boolean }) => void> = [];
    const seen: number[] = [];
    const list = infiniteList({
      host,
      skeletons: 2,
      load: (page: number) => new Promise((resolve) => { seen.push(page); resolvers.push(resolve); }),
    });
    expect(host.querySelectorAll('[data-inf-sk]')).toHaveLength(2); // squelettes pendant le chargement
    resolvers[0]({ html: '<i class="item"></i><i class="item"></i>', done: false });
    await list.ready;
    expect(host.querySelectorAll('.item')).toHaveLength(2);
    expect(host.querySelectorAll('[data-inf-sk]')).toHaveLength(0);
    expect(document.querySelector('.inf-end')!.hasAttribute('hidden')).toBe(true);
    // La sentinelle approche : page 2, qui est la dernière.
    fire!();
    fire!(); // un second déclenchement pendant le chargement n'en lance pas un autre
    expect(seen).toEqual([1, 2]);
    resolvers[1]({ html: '<i class="item"></i>', done: true });
    await tick();
    expect(host.querySelectorAll('.item')).toHaveLength(3);
    expect(document.querySelector('.inf-end')!.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.inf-end')!.textContent).toBe('Fin de la liste');
    fire!();
    await tick();
    expect(seen).toEqual([1, 2]); // plus rien à charger
  });

  it('offre un lien « Charger plus » au clavier et relance après une erreur', async () => {
    const { infiniteList } = await import('../src/ui/infinite.js');
    const host = document.getElementById('host')!;
    let calls = 0;
    const list = infiniteList({
      host,
      load: async () => { calls += 1; if (calls === 2) throw new Error('réseau'); return { html: '<i class="item"></i>', done: calls >= 3 }; },
    });
    await list.ready;
    const link = document.querySelector('.inf-more') as HTMLAnchorElement;
    expect(link.getAttribute('role')).toBe('button');
    link.click();
    await tick();
    expect(link.textContent).toBe('Réessayer'); // la page 2 a échoué
    link.click();
    await tick();
    expect(host.querySelectorAll('.item')).toHaveLength(2);
    expect(document.querySelector('.inf-end')!.hasAttribute('hidden')).toBe(false);
  });

  it('mémorise le contenu pour le retour en arrière', async () => {
    const { infiniteList, stopInfinite } = await import('../src/ui/infinite.js');
    const host = document.getElementById('host')!;
    let loads = 0;
    const make = (restore: boolean) => infiniteList({ host, key: '#/browse/test', restore, load: async (page: number) => { loads += 1; return { html: '<i class="item p' + page + '"></i>', done: page >= 2 }; } });
    const a = make(false);
    await a.ready;
    fire!();
    await tick();
    expect(host.querySelectorAll('.item')).toHaveLength(2);
    stopInfinite();
    host.innerHTML = '';
    const before = loads;
    const b = make(true);
    await b.ready;
    expect(loads).toBe(before); // rien rechargé
    expect(host.querySelectorAll('.item')).toHaveLength(2);
    expect(document.querySelector('.inf-end')!.hasAttribute('hidden')).toBe(false);
  });
});
