// Fenêtre « Envoyer un feedback » (LAST-1654) : entrées du menu et du lecteur, erreur jointe, envoi, confirmation.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ available: true, forum: true, sentry: true, sent: [] as Record<string, unknown>[] }));
vi.mock('../src/data/feedback', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/feedback')>();
  return {
    ...real,
    feedbackAvailable: () => state.available,
    forumAvailable: () => state.forum,
    sentryActive: () => state.sentry,
    sendFeedback: (input: Record<string, unknown>) => {
      state.sent.push(input);
      return Promise.resolve({ sentry: true, forum: input.forum ? { topicId: 'T9', grouped: true, reporters: 4 } : null });
    },
  };
});

let openFeedback: (o?: Record<string, unknown>) => { close: (silent?: boolean) => void } | null;
let noteError: typeof import('../src/data/feedback').noteError;
beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ openFeedback } = await import('../src/ui/feedback.js'));
  ({ noteError } = await import('../src/data/feedback'));
});
beforeEach(() => {
  state.available = true;
  state.forum = true;
  state.sentry = true;
  state.sent = [];
});
afterEach(() => {
  document.querySelectorAll('.sh-veil').forEach((v) => v.remove());
});

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const flush = () => new Promise((r) => setTimeout(r, 0));
const submit = () => $('.fb').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

describe('fenêtre de feedback', () => {
  it('depuis le menu : Bug / Idée / Autre, case forum selon le type, contexte technique visible', () => {
    openFeedback({ error: null });
    expect($('.sh-title').textContent).toBe('Envoyer un feedback');
    expect(Array.from(document.querySelectorAll('.fb-kind')).map((b) => b.textContent)).toEqual(['Bug', 'Idée', 'Autre']);
    expect($('[data-fb-cat]').textContent).toBe('« Remontée de bugs »');
    $('[data-kind="idea"]').click();
    expect($('[data-fb-cat]').textContent).toBe('« Idées et demandes »');
    $('[data-kind="other"]').click();
    expect($('[data-fb-forum]').hidden).toBe(true);
    expect($('.fb-ctx summary').textContent).toBe('Détails techniques joints');
  });

  it('message vide refusé sans erreur ni motif', async () => {
    openFeedback({ error: null });
    submit();
    await flush();
    expect($('.fb-fail').hidden).toBe(false);
    expect(state.sent).toHaveLength(0);
  });

  it('depuis une erreur : type Bug imposé, erreur affichée, envoi puis lien vers le sujet du forum', async () => {
    const err = noteError({ where: 'player', title: 'Lecture impossible', message: 'La source ne répond plus (HTTP 503).' });
    openFeedback({ error: err, player: true });
    expect($('.sh-title').textContent).toBe('Signaler un problème');
    expect(document.querySelector('.fb-kinds')).toBeNull();
    expect($('.fb-error').textContent).toContain('player:lecture-impossible:http-503');
    submit();
    await flush();
    expect(state.sent[0]).toMatchObject({ kind: 'bug', error: err, forum: true });
    expect($('.fb').textContent).toContain('4 membres concernés');
    expect($<HTMLAnchorElement>('[data-fb-topic]').getAttribute('href')).toBe('#/forum/t/T9');
  });

  it('lecteur sans erreur : motifs en un geste, envoyés avec le message', async () => {
    openFeedback({ player: true, error: null });
    $('[data-reason="Sous-titres décalés"]').click();
    expect($('[data-reason="Sous-titres décalés"]').getAttribute('aria-pressed')).toBe('true');
    submit();
    await flush();
    expect(state.sent[0]).toMatchObject({ kind: 'bug', reason: 'Sous-titres décalés', message: '' });
  });

  it('forum indisponible (auto-hébergé) : pas de case forum ; aucune destination : rien ne s’ouvre', () => {
    state.forum = false;
    openFeedback({ error: null });
    expect(document.querySelector('[data-fb-forum]')).toBeNull();
    document.querySelectorAll('.sh-veil').forEach((v) => v.remove());
    state.available = false;
    expect(openFeedback({ error: null })).toBeNull();
    expect(document.querySelector('.sh-veil')).toBeNull();
  });
});
