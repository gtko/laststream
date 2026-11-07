// scrubUrl / scrubText partagés : cas portés des tests de laststream-app (préréglage application) et de lastaddon
// (préréglage Worker), plus l'union des deux comportements. Toutes les adresses sont factices.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACEHOLDERS, scrubText, scrubUrl, tryScrubUrl, type ScrubOptions } from '../src/scrub.js';

const CFG = 'eyJ' + 'a'.repeat(120);
const SECRET = 'SECRET-FAKE-123';
const MAGNET = 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=film';

/** Préréglage de laststream-app. */
const APP = 'https://app.example';
const appHash = (hash: string): string => {
  if (!hash) return '';
  if (/^#\/reset\/.+/.test(hash)) return '#/reset/[jeton]';
  if (/^#\/friend\/.+/.test(hash)) return '#/friend/[pseudo]';
  return hash.replace(/\?.*$/, '');
};
const app: ScrubOptions = {
  origin: APP,
  resolveRelative: true,
  hash: appHash,
  placeholders: { redacted: '[retiré]', debridUrl: '[url retirée]', magnetUrl: '[url retirée]', magnetText: '[magnet retiré]', removedUrl: '[url retirée]' },
};

/** Préréglage de lastaddon (Worker) : les placeholders par défaut. */
const HOST = 'https://addon.example.test';
const worker: ScrubOptions = { origin: HOST };

describe('scrubUrl (préréglage application)', () => {
  const u = (raw: string): string | null => tryScrubUrl(raw, app);

  it('retire la query string (tokens, clés, mots de passe)', () => {
    expect(u('https://app.example/api/user?token=abc&apikey=xyz&password=p')).toBe('https://app.example/api/user');
  });
  it('garde origine, chemin et route (#/…), sans le paramètre « ? » de la route', () => {
    expect(u('https://app.example/#/movie/tt123?still')).toBe('https://app.example/#/movie/tt123');
  });
  it('masque le jeton de réinitialisation et le pseudo d’un ami', () => {
    expect(u('https://app.example/#/reset/AbCdEf123456')).toBe('https://app.example/#/reset/[jeton]');
    expect(u('https://app.example/#/friend/Alice?x=1')).toBe('https://app.example/#/friend/[pseudo]');
  });
  it('remplace un segment de plus de 40 caractères par [config], garde 40 exactement', () => {
    expect(u(`https://app.example/_ss/${'a'.repeat(60)}/x`)).toBe('https://app.example/_ss/[config]/x');
    expect(u(`https://app.example/${'b'.repeat(40)}`)).toBe(`https://app.example/${'b'.repeat(40)}`);
  });
  it('URL hors de l’application : seul l’hôte est gardé', () => {
    expect(u(`https://addon.example/${CFG}/manifest.json?k=1`)).toBe('[host]');
    expect(u('https://image.tmdb.org/t/p/w500/abc.jpg')).toBe('https://image.tmdb.org');
  });
  it('débrideurs, magnet et flux complets supprimés', () => {
    for (const raw of [
      'https://api.alldebrid.com/v4/magnet/upload?agent=x',
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      'https://realdebrid.example/x',
      'https://api.torbox.app/v1/api/torrents',
      'https://www.premiumize.me/api/transfer/list',
      `https://addon.example/alldebrid/${CFG}/x`,
      'magnet:?xt=urn:btih:0123456789abcdef&dn=film',
      'https://cdn.example/video/film.mp4?sig=1',
      'https://cdn.example/hls/master.m3u8',
      'https://app.example/stream/x.MKV',
    ]) {
      expect(u(raw)).toBeNull();
    }
  });
  it('schémas autres que http(s) et stremio supprimés', () => {
    expect(u('chrome-extension://abcdef/content.js')).toBeNull();
    expect(u('blob:https://app.example/1234')).toBeNull();
  });
  it('adresse littérale : [ip] ; localhost et *.local : [host]', () => {
    expect(u('https://192.168.1.10:8096/Items?api_key=1')).toBe('[ip]');
    expect(u('http://[::1]:3000/x')).toBe('[ip]');
    expect(u('http://localhost:8080/x')).toBe('[host]');
    expect(u('http://nas.local/x')).toBe('[host]');
  });
  it('hôte hors liste blanche : [host] ; hôte autorisé ou workers.dev du projet : hôte seul', () => {
    expect(u('https://torrentio.strem.fun/providers=yts/manifest.json')).toBe('[host]');
    expect(u('https://api.mdblist.com/x')).toBe('https://api.mdblist.com');
    expect(u('https://laststream.gtux-prog.workers.dev/api/x?k=1')).toBe('https://laststream.gtux-prog.workers.dev');
  });
  it('stremio:// et stremio: réduits à l’hôte', () => {
    expect(u('stremio://torrentio.strem.fun/providers=yts/manifest.json')).toBe('[host]');
    expect(u('stremio:addon.example/cfg')).toBe('[host]');
  });
  it('adresse relative : résolue sur l’application, query retirée', () => {
    expect(u('/api/x?apikey=1')).toBe('https://app.example/api/x');
  });
  it('la version avec placeholder remplace ce qui est supprimé', () => {
    expect(scrubUrl('https://api.torbox.app/v1/api/torrents', app)).toBe('[url retirée]');
  });
});

describe('scrubUrl (préréglage Worker)', () => {
  it('supprime la chaîne de requête, masque le segment de configuration', () => {
    expect(scrubUrl(`${HOST}/stream/movie/tt1.json?apikey=${SECRET}&x=1`, worker)).toBe(`${HOST}/stream/movie/tt1.json`);
    expect(scrubUrl(`${HOST}/${CFG}/stream/series/tt1:1:2.json`, worker)).toBe(`${HOST}/[config]/stream/series/tt1:1:2.json`);
  });
  it('retire le fragment d’une URL du Worker (aucun rappel de hash)', () => {
    expect(scrubUrl(`${HOST}/a#/reset/TOKEN123`, worker)).toBe(`${HOST}/a`);
  });
  it('hôte autorisé : origine seule, sans identifiants, chemin ni fragment', () => {
    expect(scrubUrl('https://user:pass@api.themoviedb.org:8443/3/movie/550#frag', worker)).toBe('https://api.themoviedb.org:8443');
  });
  it('débrideur, magnet, schéma non web', () => {
    expect(scrubUrl('https://api.alldebrid.example.test/v4/magnet/upload?apikey=' + SECRET, worker)).toBe('[debrid-url]');
    expect(scrubUrl('https://api.torbox.example.test/v1/api/user/me', worker)).toBe('[debrid-url]');
    expect(scrubUrl(MAGNET, worker)).toBe('[magnet]');
    expect(scrubUrl('ftp://addon.example.test/file', worker)).toBe('[redacted]');
  });
  it('chemin relatif : requête coupée, segment de configuration masqué, non résolu', () => {
    expect(scrubUrl(`/stream/${CFG}/x.json?token=${SECRET}`, worker)).toBe('/stream/[config]/x.json');
  });
  it('valeur illisible : supprimée', () => {
    expect(scrubUrl('pas une url ?token=1', worker)).toBe('[redacted]');
    expect(scrubUrl('', worker)).toBe('[redacted]');
  });
  it('sans origine : aucune URL absolue ne garde son chemin', () => {
    expect(scrubUrl(`${HOST}/stream/movie/tt1.json`)).toBe('[host]');
  });
  it('URL relative au schéma (« //hôte ») : traitée comme une URL https', () => {
    expect(scrubUrl('//torrentio.strem.fun/x', worker)).toBe('[host]');
  });
  it('segment de plus de 40 caractères masqué quel que soit son charset', () => {
    expect(scrubUrl(`${HOST}/${'x,'.repeat(25)}/manifest.json`, worker)).toBe(`${HOST}/[config]/manifest.json`);
  });
  it('flux complet sur l’origine du Worker : supprimé (union des deux anciennes versions)', () => {
    expect(scrubUrl(`${HOST}/proxy/film.mp4`, worker)).toBe('[redacted]');
    expect(scrubUrl('/proxy/film.m3u8', worker)).toBe('[redacted]');
  });
});

describe('scrubText (préréglage application)', () => {
  const t = (text: string): string => scrubText(text, app);

  it('masque le jeton d’invité (?t=) et les adresses WebSocket', () => {
    expect(t('erreur /party/R1/ws?t=SECRETTOK.sig&name=Lea')).toBe('erreur /party/R1/ws?t=[retiré]&name=Lea');
    const out = t('WebSocket connection to wss://addon.example/party/R1/ws?t=SECRETTOK.sig&name=Lea failed');
    expect(out).not.toContain('SECRETTOK');
  });
  it('réécrit les URL d’un message et garde la ponctuation finale', () => {
    expect(t('Échec de chargement de https://addon.example/abc/manifest.json?key=1.')).toBe('Échec de chargement de [host].');
  });
  it('URL de débrideur : remplacée ; magnet : remplacé', () => {
    expect(t('Lien: https://api.alldebrid.com/v4/x?apikey=K')).toBe('Lien: [url retirée]');
    expect(t('Source: magnet:?xt=urn:btih:ABC&dn=film')).toBe('Source: [magnet retiré]');
  });
  it('clés secrètes masquées (clé=valeur, clé: valeur et JSON)', () => {
    expect(t('token=abc123 password: hunter2')).toBe('token=[retiré] password: [retiré]');
    expect(t('{"apikey":"K123"}')).toBe('{"apikey":"[retiré]"}');
  });
  it('URL jusqu’au premier espace : une clé derrière « | » ne fuit pas', () => {
    expect(t('Échec https://torrentio.strem.fun/providers=yts|realdebrid=KEY123/manifest.json ok')).toBe('Échec [url retirée] ok');
    expect(t('Échec https://torrentio.strem.fun/providers=yts|x=1/manifest.json ok')).toBe('Échec [host] ok');
  });
  it('clés de débrideur en texte libre masquées', () => {
    const out = t('realdebrid=KEY1 torbox=KEY2 premiumize=KEY3 alldebrid=KEY4 debridoptions=nodownloadlinks&x=1');
    expect(out).not.toMatch(/KEY[1-4]/);
    expect(out).toContain('debridoptions=[retiré]&x=1');
  });
  it('segment de plus de 40 caractères masqué, 40 exactement gardé', () => {
    expect(t(`chemin /${'a'.repeat(50)} fin`)).toBe('chemin /[config] fin');
    expect(t(`chemin /${'b'.repeat(40)} fin`)).toBe(`chemin /${'b'.repeat(40)} fin`);
  });
  it('stremio:// dans un message réduit à l’hôte, configuration comprise', () => {
    expect(t(`ajout stremio://addon.example/SECRETCFG${'x'.repeat(60)}/manifest.json fini`)).toBe('ajout [host] fini');
  });
  it('texte sans donnée sensible : inchangé', () => {
    expect(t('Erreur réseau : délai dépassé')).toBe('Erreur réseau : délai dépassé');
  });
  it('aucune config d’addon ne ressort, quelle que soit sa forme', () => {
    const marker = 'SECRETCFG';
    for (const url of [
      `https://addon.example/${marker}${'x'.repeat(60)}/manifest.json`,
      `https://addon.example/configure/${marker}${'y'.repeat(60)}/manifest.json`,
      `https://addon.example/manifest.json?config=${marker}`,
      `https://app.example/_ss/${marker}${'z'.repeat(60)}/x`,
    ]) {
      expect(t(`Erreur ${url}`)).not.toContain(marker);
    }
  });
});

describe('scrubText (préréglage Worker)', () => {
  const t = (text: string): string => scrubText(text, worker);

  it('masque le jeton d’invité (?t=) dans un chemin relatif', () => {
    expect(t('erreur /party/abcdefghijklmnop/ws?t=' + SECRET + '&name=Lea')).toBe('erreur /party/abcdefghijklmnop/ws?t=[redacted]&name=Lea');
    expect(t('echec ' + HOST + '/party/abc/ws?t=' + SECRET + '&name=Lea')).not.toContain(SECRET);
  });
  it('épure les URL contenues dans un message', () => {
    expect(t(`échec sur ${HOST}/${CFG}/manifest.json?apikey=${SECRET}`)).toBe(`échec sur ${HOST}/[config]/manifest.json`);
  });
  it('remplace les clés d’API et jetons en paramètres', () => {
    expect(t(`apikey=${SECRET} et token=${SECRET}`)).toBe('apikey=[redacted] et token=[redacted]');
    expect(t(`access_token=${SECRET}&x=1`)).toBe('access_token=[redacted]&x=1');
  });
  it('remplace les magnets et les liens débridés', () => {
    expect(t(`ajout ${MAGNET} puis https://api.alldebrid.example.test/v4/x?apikey=${SECRET}`)).toBe('ajout [magnet] puis [debrid-url]');
  });
  it('masque l’en-tête Bearer', () => {
    expect(t(`Bearer ${SECRET}`)).toBe('Bearer [redacted]');
  });
  it('masque un segment de configuration dans un nom de transaction', () => {
    expect(t(`GET /${CFG}/manifest.json`)).toBe('GET /[config]/manifest.json');
    expect(t(`GET /${'x,'.repeat(25)}/y`)).toBe('GET /[config]/y');
  });
  it('laisse intact un texte sans donnée sensible', () => {
    expect(t('Erreur interne TypeError')).toBe('Erreur interne TypeError');
  });
});

describe('union des deux anciennes versions (le plus strict)', () => {
  it('motifs de l’application appliqués au Worker : clés de débrideur, stremio:, wss://, JSON', () => {
    expect(scrubText('realdebrid=KEY1&x=1', worker)).toBe('realdebrid=[redacted]&x=1');
    expect(scrubText('wss://other.example.test/ws?t=ABC', worker)).toBe('[redacted]');
    expect(scrubText('{"password":"hunter2"}', worker)).toBe('{"password":"[redacted]"}');
  });
  it('motifs du Worker appliqués à l’application : Bearer, access_token, magnet sans « ? »', () => {
    expect(scrubText('Bearer ABC', app)).toBe('Bearer [retiré]');
    expect(scrubText('access_token=ABC&x=1', app)).toBe('access_token=[retiré]&x=1');
    expect(scrubText('magnet:xt=urn:btih:ABC', app)).toBe('[magnet retiré]');
    expect(scrubText('client_secret=ABC', app)).toBe('client_secret=[retiré]');
  });
  it('valeur secrète : rien ne fuit après « < » (password=ab<cd)', () => {
    const out = scrubText('password=ab<cd');
    expect(out).not.toContain('ab');
    expect(out).not.toContain('cd');
  });
  it('valeur secrète : rien ne fuit après « } » (token=ab}cd)', () => {
    const out = scrubText('token=ab}cd');
    expect(out).not.toContain('ab');
    expect(out).not.toContain('cd');
  });
  it('placeholders par défaut exposés', () => {
    expect(DEFAULT_PLACEHOLDERS.redacted).toBe('[redacted]');
  });
});
