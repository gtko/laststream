// Bannière des annonces (application utilisateur) : première annonce non fermée, fermeture mémorisée (50 au plus), absente sur
// #/admin, erreur réseau sans effet, texte échappé (jamais de HTML), stockage indisponible toléré.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISMISSED_KEY, initAnnouncementBanner, pickAnnouncement, readDismissed, rememberDismissed,
} from '../src/ui/announcement-banner.js';

const A = { id: 'a1', title: 'Maintenance', message: 'Ce soir à 22 h.', level: 'warning' };
const B = { id: 'b2', title: 'Nouveauté', message: 'Les sous-titres sont plus rapides.', level: 'info' };
const load = (list: unknown[]) => async () => list as never;
const banners = () => Array.from(document.querySelectorAll<HTMLElement>('.ann-banner'));
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="detail" hidden></div>';
  localStorage.clear();
  location.hash = '#/';
});

describe('choix de l’annonce (fonctions pures)', () => {
  it('première annonce valide non fermée, dans l’ordre reçu', () => {
    expect(pickAnnouncement([A, B], ['a1'])).toEqual(B);
    expect(pickAnnouncement([A, B], [])).toEqual(A);
    expect(pickAnnouncement([A], ['a1'])).toBeNull();
    expect(pickAnnouncement([{ title: 'sans id' }, B], [])).toEqual(B);
    expect(pickAnnouncement(undefined as never, [])).toBeNull();
  });
});

describe('mémorisation des fermetures', () => {
  it('stockage : ids seulement, 50 au plus, les plus récents gardés', () => {
    for (let i = 0; i < 55; i += 1) rememberDismissed('id-' + i);
    const list = readDismissed();
    expect(list).toHaveLength(50);
    expect(list[0]).toBe('id-5');
    expect(list.at(-1)).toBe('id-54');
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(list);
  });

  it('valeur corrompue ou stockage indisponible : aucune exception', () => {
    localStorage.setItem(DISMISSED_KEY, '{pas du json');
    expect(readDismissed()).toEqual([]);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(readDismissed(broken)).toEqual([]);
    expect(() => rememberDismissed('a1', broken)).not.toThrow();
  });
});

describe('bannière', () => {
  it('affiche la première annonce, avec son niveau, en texte seulement', async () => {
    await initAnnouncementBanner({ load: load([A]) });
    const [el] = banners();
    expect(el).toBeDefined();
    expect(el.classList.contains('is-warning')).toBe(true);
    expect(el.querySelector('.ann-title')!.textContent).toBe('Maintenance');
    expect(el.querySelector('.ann-msg')!.textContent).toBe('Ce soir à 22 h.');
    expect(el.querySelector('.ann-kind')!.textContent).toBe('Attention');
    expect(el.querySelector('button.ann-close')!.getAttribute('aria-label')).toBe('Fermer l’annonce');
  });

  it('une annonce d’information porte la classe is-info', async () => {
    await initAnnouncementBanner({ load: load([B]) });
    expect(banners()[0].classList.contains('is-info')).toBe(true);
  });

  it('fermeture mémorisée : l’annonce ne revient pas au démarrage suivant, la suivante s’affiche', async () => {
    await initAnnouncementBanner({ load: load([A, B]) });
    expect(banners()[0].querySelector('.ann-title')!.textContent).toBe('Maintenance');
    (banners()[0].querySelector('.ann-close') as HTMLElement).click();
    expect(readDismissed()).toEqual(['a1']);
    expect(banners()[0].querySelector('.ann-title')!.textContent).toBe('Nouveauté');

    document.body.innerHTML = '<div id="app"></div>';
    await initAnnouncementBanner({ load: load([A, B]) });
    expect(banners()[0].querySelector('.ann-title')!.textContent).toBe('Nouveauté');
  });

  it('toutes fermées : plus rien à l’écran', async () => {
    await initAnnouncementBanner({ load: load([A]) });
    (banners()[0].querySelector('.ann-close') as HTMLElement).click();
    expect(banners()).toHaveLength(0);
    document.body.innerHTML = '<div id="app"></div>';
    await initAnnouncementBanner({ load: load([A]) });
    expect(banners()).toHaveLength(0);
  });

  it('hauteur publiée dans --ann-h pendant l’affichage, remise à 0 à la fermeture', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(48);
    try {
      await initAnnouncementBanner({ load: load([A]) });
      expect(document.documentElement.style.getPropertyValue('--ann-h')).toBe('48px');
      banners()[0].querySelector<HTMLButtonElement>('.ann-close')!.click();
      await settle();
      expect(banners()).toHaveLength(0);
      expect(document.documentElement.style.getPropertyValue('--ann-h')).toBe('0px');
    } finally {
      spy.mockRestore();
    }
  });

  it('jamais sur #/admin ; réapparaît en quittant la console', async () => {
    location.hash = '#/admin';
    await initAnnouncementBanner({ load: load([A]) });
    expect(banners()).toHaveLength(0);
    location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(banners()).toHaveLength(1);
    location.hash = '#/admin';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(banners()).toHaveLength(0);
  });

  it('texte échappé : une annonce ne peut pas injecter de balise ni de script', async () => {
    const hostile = { id: 'x1', title: '<img src=x onerror="window.__pwned=1">', message: '<script>window.__pwned=1</script>', level: 'info' };
    await initAnnouncementBanner({ load: load([hostile]) });
    const [el] = banners();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('.ann-title')!.textContent).toBe(hostile.title);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('erreur réseau : rien à afficher, aucune exception', async () => {
    await expect(initAnnouncementBanner({ load: async () => { throw new Error('network'); } })).resolves.toBeNull();
    expect(banners()).toHaveLength(0);
  });

  it('liste vide : rien à afficher', async () => {
    await initAnnouncementBanner({ load: load([]) });
    expect(banners()).toHaveLength(0);
  });

  it('stockage indisponible : la bannière s’affiche quand même', async () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    await initAnnouncementBanner({ load: load([A]), storage: broken });
    expect(banners()).toHaveLength(1);
  });

  it('ne bloque pas le démarrage : l’appel réseau n’est attendu par personne', async () => {
    let resolved = false;
    const slow = async () => { await settle(); resolved = true; return [A]; };
    const p = initAnnouncementBanner({ load: slow });
    expect(resolved).toBe(false);
    await p;
    expect(banners()).toHaveLength(1);
  });
});
