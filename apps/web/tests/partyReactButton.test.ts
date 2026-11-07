// « Réagir » en salon (LAST-1615, lot L6) : le bouton reste visible sans notes disponibles (profil sans compte, titre sans id TMDB).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let partyBridge: typeof import('../src/party/bridge')['partyBridge'];
let startNotes: typeof import('../src/player/sessionSocial.js')['startNotes'];
let S: any;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ partyBridge } = await import('../src/party/bridge'));
  ({ startNotes } = await import('../src/player/sessionSocial.js'));
  ({ S } = await import('../src/player/sessionState.js'));
});

afterEach(() => { partyBridge.client = null; });

describe('startNotes : bouton « Réagir »', () => {
  it('en salon actif, il reste visible même quand les notes ne sont pas permises', () => {
    const setNotesAvailable = vi.fn();
    (S as any).ui = { setNotesAvailable };
    partyBridge.client = { status: 'open', on: () => () => undefined } as never;
    startNotes({} as never); // hors mode serveur : notesAllowed() est faux
    expect(setNotesAvailable).toHaveBeenLastCalledWith(true);
  });
  it('hors salon, sans notes : il reste masqué', () => {
    const setNotesAvailable = vi.fn();
    (S as any).ui = { setNotesAvailable };
    partyBridge.client = null;
    startNotes({} as never);
    expect(setNotesAvailable).toHaveBeenLastCalledWith(false);
  });
});
