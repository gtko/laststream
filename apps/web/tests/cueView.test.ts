import { describe, expect, it, vi } from 'vitest';
import { createCueView, cueTexts, type CueSubs } from '../src/player/cueView';
import { cueHtml, parseSubtitles } from '../src/player/subs';

const srt = '1\n00:00:01,000 --> 00:00:03,000\nBonjour <i>toi</i>\n\n2\n00:00:05,000 --> 00:00:07,000\nÀ tout à l’heure\n';

function subs(over: Partial<CueSubs> = {}): CueSubs {
  return {
    cues: parseSubtitles(srt), cues2: [], nativeCues: null, native: false, native2: false, secondaryId: null,
    offset: 0, shift: 0, shift2: 0, rate: 1, style: { size: 100 }, ...over,
  };
}

describe('sous-titre affiché au bon temps (LAST-142)', () => {
  it('la cue apparaît à son début, disparaît à sa fin', () => {
    const s = subs();
    expect(cueTexts(s, 'html', 0.5)).toEqual(['', '']);
    expect(cueTexts(s, 'html', 1)[0]).toBe('Bonjour <i>toi</i>');
    expect(cueTexts(s, 'html', 2.9)[0]).toBe('Bonjour <i>toi</i>');
    expect(cueTexts(s, 'html', 3.1)[0]).toBe('');
    expect(cueTexts(s, 'html', 6)[0]).toBe('À tout à l’heure');
  });

  it('le décalage et la vitesse déplacent la cue', () => {
    expect(cueTexts(subs({ shift: 2 }), 'html', 1.5)[0]).toBe('');
    expect(cueTexts(subs({ shift: 2 }), 'html', 3.5)[0]).toBe('Bonjour <i>toi</i>');
    expect(cueTexts(subs({ rate: 2 }), 'html', 4)[0]).toBe('Bonjour <i>toi</i>'); // 4 s de vidéo = 2 s de sous-titre
  });

  it('second sous-titre à son propre décalage ; rien pour le lecteur natif ni pour mpv avec piste intégrée', () => {
    const second = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
    expect(cueTexts(subs({ cues2: second, secondaryId: 'en' }), 'html', 1.2)).toEqual(['Bonjour <i>toi</i>', 'Hello']);
    expect(cueTexts(subs(), 'native', 1.2)).toEqual(['', '']);
    expect(cueTexts(subs({ native: true }), 'mpv', 1.2)[0]).toBe('');
    expect(cueTexts(subs({ native: true, nativeCues: parseSubtitles(srt) }), 'html', 1.2)[0]).toBe('Bonjour <i>toi</i>');
  });

  it('le HTML d’une cue n’est recalculé que si le texte change, et l’interface n’est touchée que si l’affichage change', () => {
    const toHtml = vi.fn(cueHtml);
    const view = createCueView(toHtml);
    const push = vi.fn();
    const s = subs();
    for (const t of [0.2, 0.45, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75]) view.render(s, 'html', t, push);
    expect(toHtml).toHaveBeenCalledTimes(1); // une seule cue sur ces 10 relevés
    expect(push).toHaveBeenCalledTimes(2); // premier affichage (vide), puis la cue
    expect(push).toHaveBeenLastCalledWith('Bonjour <i>toi</i>', s.style, '');
    view.render(s, 'html', 3.5, push);
    expect(push).toHaveBeenLastCalledWith('', s.style, '');
    expect(toHtml).toHaveBeenCalledTimes(1);
  });

  it('un nouveau style est poussé même si la cue ne change pas ; forget force le prochain affichage', () => {
    const view = createCueView();
    const push = vi.fn();
    const s = subs();
    view.render(s, 'html', 1.5, push);
    view.render(s, 'html', 1.6, push);
    expect(push).toHaveBeenCalledTimes(1);
    s.style = { size: 120 };
    view.render(s, 'html', 1.7, push);
    expect(push).toHaveBeenCalledTimes(2);
    view.forget();
    view.render(s, 'html', 1.8, push);
    expect(push).toHaveBeenCalledTimes(3);
  });
});
