// Filtre de confidentialité Sentry : URL, texte, fils d'Ariane et événements. Toutes les adresses sont factices.
import type { Breadcrumb, ErrorEvent } from '@sentry/browser';
import { describe, expect, it } from 'vitest';
import { isNoise, scrubBreadcrumb, scrubEvent, scrubText, scrubUrl } from '../src/observability/scrub';

const APP = 'https://app.example';
const CFG = 'eyJ' + 'a'.repeat(120); // configuration d'addon encodée en base64 (ici factice)

const ev = (e: Record<string, unknown>): ErrorEvent => e as unknown as ErrorEvent;
const crumb = (c: Record<string, unknown>): Breadcrumb => c as unknown as Breadcrumb;

describe('scrubUrl : adresses', () => {
  it('retire la query string (tokens, clés, mots de passe)', () => {
    expect(scrubUrl('https://app.example/api/user?token=abc&apikey=xyz&password=p', APP)).toBe('https://app.example/api/user');
  });

  it('garde origine, chemin et route (#/…), sans le paramètre « ? » de la route', () => {
    expect(scrubUrl('https://app.example/#/movie/tt123?still', APP)).toBe('https://app.example/#/movie/tt123');
  });

  it('masque le jeton de réinitialisation du mot de passe (#/reset/…)', () => {
    expect(scrubUrl('https://app.example/#/reset/AbCdEf123456', APP)).toBe('https://app.example/#/reset/[jeton]');
  });

  it('masque le pseudo d’un ami dans la route (#/friend/…)', () => {
    expect(scrubUrl('https://app.example/#/friend/Alice?x=1', APP)).toBe('https://app.example/#/friend/[pseudo]');
  });

  it('remplace un segment de chemin de plus de 40 caractères par [config]', () => {
    expect(scrubUrl(`https://app.example/_ss/${'a'.repeat(60)}/x`, APP)).toBe('https://app.example/_ss/[config]/x');
  });

  it('garde un segment de exactement 40 caractères', () => {
    expect(scrubUrl(`https://app.example/${'b'.repeat(40)}`, APP)).toBe(`https://app.example/${'b'.repeat(40)}`);
  });

  it('URL hors de l’application : seul l’hôte est gardé', () => {
    expect(scrubUrl(`https://addon.example/${CFG}/manifest.json?k=1`, APP)).toBe('[host]');
    expect(scrubUrl('https://image.tmdb.org/t/p/w500/abc.jpg', APP)).toBe('https://image.tmdb.org');
  });

  it('débrideurs supprimés', () => {
    expect(scrubUrl('https://api.alldebrid.com/v4/magnet/upload?agent=x', APP)).toBeNull();
    expect(scrubUrl('https://api.real-debrid.com/rest/1.0/unrestrict/link', APP)).toBeNull();
    expect(scrubUrl('https://realdebrid.example/x', APP)).toBeNull();
    expect(scrubUrl('https://api.torbox.app/v1/api/torrents', APP)).toBeNull();
    expect(scrubUrl('https://www.premiumize.me/api/transfer/list', APP)).toBeNull();
    expect(scrubUrl(`https://addon.example/alldebrid/${CFG}/x`, APP)).toBeNull();
  });

  it('magnet : supprimé', () => {
    expect(scrubUrl('magnet:?xt=urn:btih:0123456789abcdef&dn=film', APP)).toBeNull();
  });

  it('flux complets (.m3u8, .mkv, .mp4) supprimés, même hors application', () => {
    expect(scrubUrl('https://cdn.example/video/film.mp4?sig=1', APP)).toBeNull();
    expect(scrubUrl('https://cdn.example/hls/master.m3u8', APP)).toBeNull();
    expect(scrubUrl('https://app.example/stream/x.MKV', APP)).toBeNull();
  });

  it('schémas autres que http(s) supprimés', () => {
    expect(scrubUrl('chrome-extension://abcdef/content.js', APP)).toBeNull();
    expect(scrubUrl('blob:https://app.example/1234', APP)).toBeNull();
  });

  it('adresse littérale IPv4 ou IPv6 : [ip]', () => {
    expect(scrubUrl('https://192.168.1.10:8096/Items?api_key=1', APP)).toBe('[ip]');
    expect(scrubUrl('http://[::1]:3000/x', APP)).toBe('[ip]');
  });

  it('localhost et *.local : [host]', () => {
    expect(scrubUrl('http://localhost:8080/x', APP)).toBe('[host]');
    expect(scrubUrl('http://nas.local/x', APP)).toBe('[host]');
  });

  it('hôte hors liste blanche : [host] ; hôte autorisé ou workers.dev du projet : hôte seul', () => {
    expect(scrubUrl('https://torrentio.strem.fun/providers=yts/manifest.json', APP)).toBe('[host]');
    expect(scrubUrl('https://api.mdblist.com/x', APP)).toBe('https://api.mdblist.com');
    expect(scrubUrl('https://lastaddon-core.gtux-prog.workers.dev/api/x?k=1', APP)).toBe('https://lastaddon-core.gtux-prog.workers.dev');
  });

  it('stremio:// et stremio: réduits à l’hôte', () => {
    expect(scrubUrl('stremio://torrentio.strem.fun/providers=yts/manifest.json', APP)).toBe('[host]');
    expect(scrubUrl('stremio:addon.example/cfg', APP)).toBe('[host]');
  });

  it('adresse relative : résolue sur l’application, query retirée', () => {
    expect(scrubUrl('/api/x?apikey=1', APP)).toBe('https://app.example/api/x');
  });
});

describe('scrubText : texte libre', () => {
  it('masque le jeton d’invité d’un salon (?t=) et les adresses WebSocket', () => {
    expect(scrubText('erreur /party/R1/ws?t=SECRETTOK.sig&name=Lea', APP)).toBe('erreur /party/R1/ws?t=[retiré]&name=Lea');
    const out = scrubText('WebSocket connection to wss://addon.example/party/R1/ws?t=SECRETTOK.sig&name=Lea failed', APP);
    expect(out).not.toContain('SECRETTOK');
    expect(out).not.toContain('SECRETTOK.sig');
  });

  it('réécrit les URL d’un message et garde la ponctuation finale', () => {
    expect(scrubText('Échec de chargement de https://addon.example/abc/manifest.json?key=1.', APP))
      .toBe('Échec de chargement de [host].');
  });

  it('URL de débrideur dans un message : remplacée', () => {
    expect(scrubText('Lien: https://api.alldebrid.com/v4/x?apikey=K', APP)).toBe('Lien: [url retirée]');
  });

  it('magnet dans un message : remplacé', () => {
    expect(scrubText('Source: magnet:?xt=urn:btih:ABC&dn=film', APP)).toBe('Source: [magnet retiré]');
  });

  it('clés secrètes masquées (forme clé=valeur, clé: valeur et JSON)', () => {
    expect(scrubText('token=abc123 password: hunter2', APP)).toBe('token=[retiré] password: [retiré]');
    expect(scrubText('{"apikey":"K123"}', APP)).toBe('{"apikey":"[retiré]"}');
  });

  it('URL jusqu’au premier espace : une clé derrière « | » ne fuit pas', () => {
    expect(scrubText('Échec https://torrentio.strem.fun/providers=yts|realdebrid=KEY123/manifest.json ok', APP)).toBe('Échec [url retirée] ok');
    expect(scrubText('Échec https://torrentio.strem.fun/providers=yts|x=1/manifest.json ok', APP)).toBe('Échec [host] ok');
  });

  it('clés de débrideur en texte libre masquées (realdebrid, torbox, premiumize, alldebrid, debridoptions)', () => {
    const out = scrubText('realdebrid=KEY1 torbox=KEY2 premiumize=KEY3 alldebrid=KEY4 debridoptions=nodownloadlinks&x=1', APP);
    expect(out).not.toMatch(/KEY[1-4]/);
    expect(out).toContain('debridoptions=[retiré]&x=1');
  });

  it('segment de chemin de plus de 40 caractères masqué, 40 exactement gardé', () => {
    expect(scrubText(`chemin /${'a'.repeat(50)} fin`, APP)).toBe('chemin /[config] fin');
    expect(scrubText(`chemin /${'b'.repeat(40)} fin`, APP)).toBe(`chemin /${'b'.repeat(40)} fin`);
  });

  it('stremio:// dans un message réduit à l’hôte, configuration comprise', () => {
    const cfg = 'SECRETCFG' + 'x'.repeat(60);
    expect(scrubText(`ajout stremio://addon.example/${cfg}/manifest.json fini`, APP)).toBe('ajout [host] fini');
  });

  it('texte sans donnée sensible : inchangé', () => {
    expect(scrubText('Erreur réseau : délai dépassé', APP)).toBe('Erreur réseau : délai dépassé');
  });

  it('aucune config d’addon ne ressort, quelle que soit sa forme', () => {
    const marker = 'SECRETCFG';
    const variants = [
      `https://addon.example/${marker}${'x'.repeat(60)}/manifest.json`,
      `https://addon.example/configure/${marker}${'y'.repeat(60)}/manifest.json`,
      `https://addon.example/manifest.json?config=${marker}`,
      `https://app.example/_ss/${marker}${'z'.repeat(60)}/x`,
    ];
    for (const url of variants) {
      expect(scrubText(`Erreur ${url}`, APP)).not.toContain(marker);
    }
  });
});

describe('scrubBreadcrumb : fils d’Ariane', () => {
  it('fetch vers un hôte tiers : seulement l’hôte et le statut', () => {
    const out = scrubBreadcrumb(crumb({
      category: 'fetch',
      data: { url: `https://addon.example/${CFG}/manifest.json?k=1`, method: 'GET', status_code: 200, request_body_size: 0 },
    }), APP);
    expect(out?.data).toEqual({ host: '[host]', status_code: 200 });
  });

  it('fetch tiers avec un message : le message est filtré aussi', () => {
    const out = scrubBreadcrumb(crumb({
      category: 'fetch',
      message: `GET https://addon.example/${CFG}/x?k=1 échoué`,
      data: { url: 'https://addon.example/x?k=1', status_code: 500 },
    }), APP);
    expect(out?.message).toBe('GET [host] échoué');
    expect(out?.data).toEqual({ host: '[host]', status_code: 500 });
  });

  it('xhr vers un débrideur : hôte et statut seulement, jamais le chemin', () => {
    const out = scrubBreadcrumb(crumb({
      category: 'xhr',
      data: { url: 'https://api.torbox.app/v1/api/torrents?apikey=K', method: 'POST', status_code: 401 },
    }), APP);
    expect(out?.data).toEqual({ host: '[host]', status_code: 401 });
  });

  it('fetch vers l’application : URL sans query, méthode gardée', () => {
    const out = scrubBreadcrumb(crumb({
      category: 'xhr',
      data: { url: 'https://app.example/api/library?token=x', method: 'GET', status_code: 200 },
    }), APP);
    expect(out?.data).toMatchObject({ url: 'https://app.example/api/library', method: 'GET', status_code: 200 });
  });

  it('fetch sans URL : écarté', () => {
    expect(scrubBreadcrumb(crumb({ category: 'fetch', data: {} }), APP)).toBeNull();
  });

  it('navigation : départ et arrivée sans query', () => {
    const out = scrubBreadcrumb(crumb({
      category: 'navigation',
      data: { from: '/#/tv-live?x=1', to: '/#/movie/tt1' },
    }), APP);
    expect(out?.data).toEqual({ from: 'https://app.example/#/tv-live', to: 'https://app.example/#/movie/tt1' });
  });

  it('console, clics et saisies : écartés (breadcrumbs désactivés côté client)', () => {
    expect(scrubBreadcrumb(crumb({ category: 'console', message: 'Erreur https://addon.example/x?apikey=1' }), APP)).toBeNull();
    expect(scrubBreadcrumb(crumb({ category: 'console', data: { arguments: ['ok'] } }), APP)).toBeNull();
    expect(scrubBreadcrumb(crumb({ category: 'ui.click', message: 'button#play' }), APP)).toBeNull();
    expect(scrubBreadcrumb(crumb({ category: 'ui.input', message: 'input#password' }), APP)).toBeNull();
  });
});

describe('scrubEvent : événements', () => {
  it('bruit du navigateur écarté (ResizeObserver)', () => {
    expect(scrubEvent(ev({ message: 'ResizeObserver loop completed with undelivered notifications.' }), APP)).toBeNull();
  });

  it('annulation volontaire écartée (AbortError)', () => {
    expect(scrubEvent(ev({ exception: { values: [{ type: 'AbortError', value: 'The user aborted a request.' }] } }), APP)).toBeNull();
  });

  it('lecture média attendue écartée', () => {
    const cases = [
      { type: 'Error', value: 'The play() request was interrupted by a new load request.' },
      { type: 'NotAllowedError', value: "play() failed because the user didn't interact with the document first." },
      { type: 'NotSupportedError', value: 'The element has no supported sources.' },
    ];
    for (const value of cases) {
      expect(scrubEvent(ev({ exception: { values: [value] } }), APP)).toBeNull();
    }
  });

  it('erreur venant d’une extension navigateur (cadre le plus récent) écartée', () => {
    const out = scrubEvent(ev({
      exception: { values: [{ type: 'TypeError', value: 'x is undefined', stacktrace: { frames: [
        { filename: 'https://app.example/assets/index.js' },
        { filename: 'chrome-extension://abcdef/content.js' },
      ] } }] },
    }), APP);
    expect(out).toBeNull();
  });

  it('erreur de l’application appelée depuis une extension : gardée', () => {
    const out = scrubEvent(ev({
      exception: { values: [{ type: 'TypeError', value: 'boom', stacktrace: { frames: [
        { filename: 'chrome-extension://abcdef/x.js' },
        { filename: 'https://app.example/assets/index.js' },
      ] } }] },
    }), APP);
    expect(out).not.toBeNull();
    expect(isNoise(ev({ exception: { values: [{ type: 'TypeError', value: 'boom' }] } }))).toBe(false);
  });

  it('événement complet : rien de sensible ne sort', () => {
    const out = scrubEvent(ev({
      message: 'Échec https://addon.example/x/manifest.json?apikey=ZZ',
      request: { url: 'https://app.example/#/reset/TOKEN123', cookies: 'sid=1', query_string: 'a=1', headers: { 'User-Agent': 'UA' } },
      user: { id: 'acc-1', username: 'greg', email: 'g@example.com', ip_address: '1.2.3.4' },
      extra: { cfg: `https://addon.example/${CFG}/manifest.json?k=1` },
      exception: { values: [{ type: 'TypeError', value: 'Failed: https://api.alldebrid.com/x', stacktrace: { frames: [
        { filename: 'https://app.example/assets/index-1.js?v=2' },
      ] } }] },
    }), APP);
    expect(out).not.toBeNull();
    expect(out?.message).toBe('Échec [host]');
    expect(out?.request?.url).toBe('https://app.example/#/reset/[jeton]');
    expect(out?.request).not.toHaveProperty('cookies');
    expect(out?.request).not.toHaveProperty('query_string');
    expect(out?.user).toEqual({ id: 'acc-1' });
    expect(out?.extra).toEqual({ cfg: '[host]' });
    expect(out?.exception?.values?.[0]?.value).toBe('Failed: [url retirée]');
    expect(out?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('https://app.example/assets/index-1.js');
    const json = JSON.stringify(out);
    for (const secret of ['apikey', 'ZZ', 'TOKEN123', 'g@example.com', 'greg', '1.2.3.4', 'alldebrid', 'sid=1', '?']) {
      expect(json).not.toContain(secret);
    }
  });

  it('compte sans identifiant : aucune donnée utilisateur', () => {
    const out = scrubEvent(ev({ message: 'boom', user: { username: 'greg' } }), APP);
    expect(out?.user).toBeUndefined();
  });
});
