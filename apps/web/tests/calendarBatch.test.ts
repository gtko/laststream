// Calendrier : au plus CAL_CONCURRENCY suivis en vol, et route groupée optionnelle (fetchCalendarBatch) avec repli.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE = 'http://localhost:7000';
const CFG = 'CFG_calendar-test';
const batchCalls: string[] = [];
/** Statut de `POST lt/calendar/batch` côté faux serveur : 404 tant que la route n'existe pas. */
let batchStatus = 404;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let cal: typeof import('../src/ui/calendar.js');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(String(url));
    if (u.pathname === '/' + CFG + '/lt/calendar/batch') {
      batchCalls.push(u.pathname);
      return batchStatus === 200 ? json({ events: [{ date: '2026-10-05', kind: 'episode', key: 'tv:1', title: 'Série', label: 'S1 É1' }] }) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
  }));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  await import('../src/ui/ctxmenu.js');
  cal = await import('../src/ui/calendar.js');
});

beforeEach(() => {
  batchCalls.length = 0;
});

describe('settleLimited', () => {
  it('au plus n appels en vol, résultats dans l’ordre, une erreur n’en touche pas d’autres', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await cal.settleLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x: number) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (x === 4) throw new Error('boom');
      return x * 10;
    });

    expect(max).toBe(3);
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(out[6]).toEqual({ status: 'fulfilled', value: 70 });
  });
});

describe('fetchCalendarBatch', () => {
  it('route absente (404) : null, puis plus jamais redemandée pendant la session', async () => {
    batchStatus = 404;
    const follows = [{ type: 'tv', id: 1, title: 'Série' }];
    expect(await cal.fetchCalendarBatch(follows, '2026-10-01', '2026-10-31')).toBeNull();
    expect(await cal.fetchCalendarBatch(follows, '2026-10-01', '2026-10-31')).toBeNull();
    expect(batchCalls).toHaveLength(1);
  });

  it('route présente : ses événements sont renvoyés', async () => {
    vi.resetModules();
    batchStatus = 200;
    const fresh = await import('../src/ui/calendar.js');
    const events = await fresh.fetchCalendarBatch([{ type: 'tv', id: 1 }], '2026-10-01', '2026-10-31');
    expect(events).toEqual([expect.objectContaining({ key: 'tv:1', date: '2026-10-05' })]);
    expect(batchCalls).toHaveLength(1);
  });
});
