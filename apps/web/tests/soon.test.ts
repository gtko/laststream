import { describe, expect, it } from 'vitest';

describe('carte Bientôt', () => {
  it('reconnaît les titres génériques et formate le compte à rebours', async () => {
    const { isPlaceholderTitle, countdownText } = await import('../src/ui/soon.js');
    expect(isPlaceholderTitle('Épisode 4')).toBe(true);
    expect(isPlaceholderTitle('episode 12')).toBe(true);
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('Le grand retour')).toBe(false);
    expect(countdownText(local(0))).toBe('Ce soir');
    expect(countdownText(local(0), '21 h 00')).toBe('21 h 00');
    expect(countdownText(local(1))).toBe('Demain');
    expect(countdownText(local(6))).toBe('Dans 6 jours');
    expect(countdownText(local(90))).toBe('Dans 3 mois');
    expect(countdownText(local(-2))).toBe('');
  });

  const local = (n: number) => { const d = new Date(Date.now() + n * 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  it('affiche « Sorti » sur la pastille d’un épisode déjà diffusé (ODY-253)', async () => {
    const { soonBadgeText } = await import('../src/ui/soon.js');
    expect(soonBadgeText(local(-1))).toBe('Sorti');
    expect(soonBadgeText(local(-5))).toBe('Sorti');
    expect(soonBadgeText(local(0))).toBe('Ce soir');
    expect(soonBadgeText(local(1))).toBe('Demain');
    expect(soonBadgeText('')).toBe('');
  });

  it('une émission déjà sortie a la même carte qu’une série à venir : pastille de date, badge, affiche (ODY-253)', async () => {
    const { soonItemHTML } = await import('../src/ui/soon.js');
    const o = { season: 1, episode: 1, epTitle: 'Épisode 1', backdrop: '/bd.jpg', poster: '/po.jpg', name: 'Wanted' };
    const past = soonItemHTML({ ...o, airDate: local(-1) }, 'tv:1');
    const soon = soonItemHTML({ ...o, airDate: local(0) }, 'tv:2');
    for (const html of [past, soon]) {
      expect(html).toContain('class="soon-date"');
      expect(html).toContain('class="soon-poster"');
      expect(html).toContain('class="soon-count');
      expect(html).toContain('class="soon-code">S1 · É1');
    }
    expect(past).toContain('>Sorti</span>');
    expect(past).toContain('data-open="tv:1"');
    expect(soon).toContain('>Ce soir</span>');
    // fond de la série seul : pas d'affiche coupée en repli, le dégradé reste
    expect(past).not.toContain('data-fb');
  });

  it('une vignette d’épisode qui ne charge pas se replie sur le fond de la série', async () => {
    const { soonItemHTML } = await import('../src/ui/soon.js');
    const html = soonItemHTML({ airDate: local(0), season: 1, episode: 2, epTitle: 'Un titre', still: '/st.jpg', backdrop: '/bd.jpg', poster: '/po.jpg', name: 'Série' }, 'tv:4');
    expect(html).toContain('data-still data-fb="https://image.tmdb.org/t/p/w780/bd.jpg"');
  });

  it('une émission sans aucun visuel garde la carte (dégradé et nom) sans image', async () => {
    const { soonItemHTML } = await import('../src/ui/soon.js');
    const html = soonItemHTML({ airDate: local(-1), season: 2, episode: 3, epTitle: '', name: 'Sans image' }, 'tv:3');
    expect(html).not.toContain('<img');
    expect(html).toContain('class="soon-series">Sans image</span>');
    expect(html).toContain('>Sorti</span>');
  });
});
