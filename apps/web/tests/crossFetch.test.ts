import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ on: false, request: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.on, isPluginAvailable: () => true },
  CapacitorHttp: { request: native.request },
  registerPlugin: () => ({}),
}));

import { appFetch, needsNativeHttp } from '../src/data/crossFetch';

afterEach(() => { native.on = false; native.request.mockReset(); vi.restoreAllMocks(); });

describe('appFetch (interface chargée depuis le serveur)', () => {
  it('hors application native : fetch ordinaire', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await appFetch('https://autre.test/x');
    expect(f).toHaveBeenCalledTimes(1);
    expect(native.request).not.toHaveBeenCalled();
  });

  it('application native, même origine que la page (serveur Laststream) : fetch ordinaire, sans CORS', async () => {
    native.on = true;
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await appFetch(`${location.origin}/health`);
    expect(f).toHaveBeenCalledTimes(1);
    expect(needsNativeHttp(`${location.origin}/health`)).toBe(false);
  });

  it('application native, serveur perso d’une autre origine (PC en http) : requête native, sans contenu mixte ni CORS', async () => {
    native.on = true;
    const f = vi.spyOn(globalThis, 'fetch');
    native.request.mockResolvedValue({ status: 429, headers: { 'Retry-After': '2' }, data: { error: 'slow' } });
    const res = await appFetch('http://192.168.1.20:7000/lt/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(f).not.toHaveBeenCalled();
    expect(native.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://192.168.1.20:7000/lt/x', method: 'POST', data: { a: 1 } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    await expect(res.json()).resolves.toEqual({ error: 'slow' });
  });

  it('204 sans corps, et annulation par signal', async () => {
    native.on = true;
    native.request.mockResolvedValue({ status: 204, headers: {}, data: '' });
    expect((await appFetch('http://192.168.1.20:7000/u')).status).toBe(204);
    const ctl = new AbortController();
    ctl.abort();
    await expect(appFetch('http://192.168.1.20:7000/u', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
