// LAST-120 : un contenu externe (pseudo, annonce, nom, saison…) ne devient jamais du HTML actif dans les rendus innerHTML.
import { describe, expect, it } from 'vitest';

const PAYLOAD = '<img src=x onerror=alert(1)>';

// `dom.js` et `player.js` lisent la page à l'import : on pose le squelette minimal avant de charger les modules.
document.body.innerHTML = '<div id="app"></div><div id="player"></div><div id="detail" hidden></div><div id="modal" hidden><div class="modal"><div id="modal-body"></div></div><button id="modal-close"></button></div><div id="toast"></div>';

const NOW_ISO = '2026-10-19T00:00:00.000Z';

describe('console admin : rendu de la section courante (paint)', () => {
  it('annonce au titre et au message HTML : aucune image créée, texte littéral', async () => {
    const { __admin } = await import('../src/ui/admin.js');
    const { state } = await import('../src/ui/state.js');
    const detailEl = document.getElementById('detail') as HTMLElement;
    detailEl.innerHTML = '<div id="adm-content"></div>';
    (state as unknown as { kind: string }).kind = 'admin';
    const S = __admin.S as unknown as Record<string, unknown>;
    S.sec = 'announcements';
    S.announcements = {
      status: 'ready', error: '',
      value: { announcements: [{ id: 'a1', title: PAYLOAD, message: PAYLOAD, level: 'info', startsAt: null, endsAt: null, active: true, createdAt: NOW_ISO, updatedAt: NOW_ISO }] },
    };
    __admin.paint();
    expect(detailEl.querySelectorAll('img')).toHaveLength(0);
    expect(detailEl.textContent).toContain(PAYLOAD);
  });

  it('pseudo de compte HTML : aucune image créée, texte littéral', async () => {
    const { __admin } = await import('../src/ui/admin.js');
    const { state } = await import('../src/ui/state.js');
    const detailEl = document.getElementById('detail') as HTMLElement;
    detailEl.innerHTML = '<div id="adm-content"></div>';
    (state as unknown as { kind: string }).kind = 'admin';
    const S = __admin.S as unknown as Record<string, unknown>;
    S.sec = 'accounts';
    S.acc = {
      status: 'ready', error: '',
      value: {
        accounts: [{ id: 'u1', username: PAYLOAD, status: 'active', isOwner: false, profileCount: 1, lastActivityAt: NOW_ISO, referrer: PAYLOAD, online: false, invitesUsed: 0, inviteQuota: 0, sessionCount: 0 }],
        nextCursor: null, total: 1,
      },
    };
    __admin.paint();
    expect(detailEl.querySelectorAll('img')).toHaveLength(0);
    expect(detailEl.textContent).toContain(PAYLOAD);
  });
});

describe('rangée « Cette semaine dans tes suivis » (soonItemHTML)', () => {
  it('nom, saison, épisode et titre d’épisode HTML : aucune image créée, texte littéral', async () => {
    const { soonItemHTML } = await import('../src/ui/soon.js');
    const host = document.createElement('div');
    host.innerHTML = soonItemHTML({ name: PAYLOAD, season: PAYLOAD, episode: PAYLOAD, epTitle: PAYLOAD, airDate: '2026-10-26', backdrop: '', poster: '', still: '', logo: '' }, 'tv:1');
    document.body.appendChild(host);
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect(host.textContent).toContain(PAYLOAD);
  });
});
