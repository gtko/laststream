import { describe, expect, it } from 'vitest';

describe('carte Bientôt', () => {
  it('reconnaît les titres génériques et formate le compte à rebours', async () => {
    const { isPlaceholderTitle, countdownText } = await import('../src/ui/soon.js');
    expect(isPlaceholderTitle('Épisode 4')).toBe(true);
    expect(isPlaceholderTitle('episode 12')).toBe(true);
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('Le grand retour')).toBe(false);
    const iso = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const local = (n: number) => { const d = new Date(Date.now() + n * 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    void iso;
    expect(countdownText(local(0))).toBe('Ce soir');
    expect(countdownText(local(0), '21 h 00')).toBe('21 h 00');
    expect(countdownText(local(1))).toBe('Demain');
    expect(countdownText(local(6))).toBe('Dans 6 jours');
    expect(countdownText(local(90))).toBe('Dans 3 mois');
    expect(countdownText(local(-2))).toBe('');
  });
});
