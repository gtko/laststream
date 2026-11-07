import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApp, serverRelease } from '../src/app.js';
import {
  collectGitState,
  compareTags,
  decideLock,
  evaluateGuard,
  formatLockValue,
  latestTag,
  LockError,
  parseReleaseTag,
  parseVersionArg,
  planRelease,
  runDeploy,
  shellQuote,
  withDeployLock,
  wranglerKv,
  type GitRunner,
  type GitState,
  type KvLike,
  type RunResult,
} from '../scripts/lib/deploy-guard.mjs';

// Aucun appel réel à git ni à wrangler : git est simulé par une table commande → résultat, KV par une Map.

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const ko = (stderr = 'erreur'): RunResult => ({ status: 1, stdout: '', stderr });

interface FakeRepo { branch?: string; dirty?: string; head?: string; upstream?: string; tag?: string | null; remoteTag?: boolean; fetchOk?: boolean; tags?: string[]; log?: string }

function fakeGit(repo: FakeRepo = {}, calls: string[][] = []): GitRunner {
  const { branch = 'main', dirty = '', head = SHA, upstream = SHA, tag = 'v1.2.3', remoteTag = true, fetchOk = true, tags = ['v1.2.2'], log = 'LAST-1 : un\nLAST-2 : deux' } = repo;
  return (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'fetch') return fetchOk ? ok() : ko('réseau coupé');
    if (line.startsWith('status --porcelain')) return ok(dirty);
    if (line === 'rev-parse HEAD') return ok(`${head}\n`);
    if (line.startsWith('rev-parse origin/')) return ok(`${upstream}\n`);
    if (line === 'rev-parse --abbrev-ref HEAD') return ok(`${branch}\n`);
    if (args[0] === 'describe') return tag === null ? ko('fatal: no tag exactly matches') : ok(`${tag}\n`);
    if (args[0] === 'ls-remote') return ok(remoteTag ? `${head}\trefs/tags/${args[3]?.replace('refs/tags/', '')}\n` : '');
    if (line === 'tag --list v*') return ok(tags.join('\n'));
    if (args[0] === 'log') return ok(log);
    throw new Error(`commande git inattendue : ${line}`);
  };
}

const state = (patch: Partial<GitState> = {}): GitState => ({ dirty: [], branch: 'main', head: SHA, upstream: SHA, tag: 'v1.2.3', tagOnRemote: true, errors: [], ...patch });
const RULES = { branch: 'main', requireTag: true };

describe('étiquettes', () => {
  it('parseReleaseTag accepte vX.Y.Z et rien d\'autre', () => {
    expect(parseReleaseTag('v1.20.3')).toEqual({ tag: 'v1.20.3', major: 1, minor: 20, patch: 3 });
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc1', 'v1.2.3.4', 'release-1', '', undefined]) expect(parseReleaseTag(bad)).toBeNull();
  });

  it('parseVersionArg accepte x.y.z avec ou sans « v »', () => {
    expect(parseVersionArg('0.2.0')).toBe('v0.2.0');
    expect(parseVersionArg('v0.2.0')).toBe('v0.2.0');
    expect(parseVersionArg('0.2')).toBeNull();
    expect(parseVersionArg(undefined)).toBeNull();
  });

  it('compare en semver, pas en texte', () => {
    expect(compareTags('v1.10.0', 'v1.9.0')).toBeGreaterThan(0);
    expect(latestTag(['v1.9.0', 'v1.10.0', 'v0.0.1', 'autre'])).toBe('v1.10.0');
    expect(latestTag([])).toBeUndefined();
  });
});

describe('evaluateGuard : refus ou accord', () => {
  it('accepte main propre, à jour, sur un tag publié', () => {
    expect(evaluateGuard(state(), RULES)).toEqual([]);
  });

  it('refuse un arbre suivi sale', () => {
    expect(evaluateGuard(state({ dirty: [' M src/app.ts'] }), RULES).join()).toMatch(/arbre suivi sale/);
  });

  it('refuse une autre branche (et master pour lastaddon, main pour l\'edge)', () => {
    expect(evaluateGuard(state({ branch: 'feature/x' }), RULES).join()).toMatch(/branche « feature\/x » au lieu de « main »/);
    expect(evaluateGuard(state({ branch: 'main' }), { branch: 'master', requireTag: true }).join()).toMatch(/au lieu de « master »/);
  });

  it('accepte un HEAD détaché sur le tag s\'il est la pointe de origin/<branche>, le refuse sinon', () => {
    expect(evaluateGuard(state({ branch: 'HEAD' }), RULES)).toEqual([]);
    expect(evaluateGuard(state({ branch: 'HEAD', head: OTHER }), RULES).join()).toMatch(/différent de origin\/main/);
  });

  it('refuse HEAD différent de origin/<branche>', () => {
    expect(evaluateGuard(state({ head: OTHER }), RULES).join()).toMatch(/différent de origin\/main/);
  });

  it('refuse sans tag exact, avec un tag mal formé, ou un tag absent d\'origin', () => {
    expect(evaluateGuard(state({ tag: undefined }), RULES).join()).toMatch(/pas exactement une étiquette/);
    expect(evaluateGuard(state({ tag: 'prod-1' }), RULES).join()).toMatch(/forme vX\.Y\.Z/);
    expect(evaluateGuard(state({ tagOnRemote: false }), RULES).join()).toMatch(/n'existe pas sur origin/);
  });

  it('sans exigence de tag (interface), un tag absent ne bloque pas', () => {
    expect(evaluateGuard(state({ tag: undefined }), { branch: 'main', requireTag: false })).toEqual([]);
  });

  it('cumule les raisons et reprend les erreurs de collecte', () => {
    const problems = evaluateGuard(state({ dirty: ['M a'], branch: 'x', tag: undefined, errors: ['git fetch origin main a échoué : réseau'] }), RULES);
    expect(problems.length).toBe(4);
  });
});

describe('collectGitState (git simulé)', () => {
  it('fetch d\'abord, puis lit l\'état ; tag vérifié sur origin', () => {
    const calls: string[][] = [];
    const result = collectGitState(fakeGit({}, calls), '/repo', RULES);
    expect(calls[0]).toEqual(['fetch', '--tags', '--quiet', 'origin', 'main']);
    expect(result).toMatchObject({ dirty: [], branch: 'main', head: SHA, upstream: SHA, tag: 'v1.2.3', tagOnRemote: true, errors: [] });
    expect(calls.some((c) => c[0] === 'describe' && c.includes('--exact-match') && c.includes('--tags'))).toBe(true);
  });

  it('un fetch en échec devient une raison de refus', () => {
    const problems = evaluateGuard(collectGitState(fakeGit({ fetchOk: false }), '/repo', RULES), RULES);
    expect(problems.join()).toMatch(/git fetch origin main a échoué : réseau coupé/);
  });

  it('un arbre sale et l\'absence de tag exact sont détectés de bout en bout', () => {
    const problems = evaluateGuard(collectGitState(fakeGit({ dirty: ' M a.ts\n M b.ts', tag: null, branch: 'feature/x' }), '/repo', RULES), RULES);
    expect(problems).toHaveLength(3);
  });
});

/** KV en mémoire avec trace des appels. */
function memoryKv(initial?: string) {
  const store = new Map<string, string>(initial === undefined ? [] : [['deploy-lock:test', initial]]);
  const calls: string[] = [];
  const kv: KvLike = {
    get: (key) => { calls.push(`get ${key}`); return Promise.resolve(store.get(key) ?? null); },
    put: (key, value, ttl) => { calls.push(`put ${key} ttl=${ttl}`); store.set(key, value); return Promise.resolve(); },
    delete: (key) => { calls.push(`delete ${key}`); store.delete(key); return Promise.resolve(); },
  };
  return { kv, store, calls };
}

const NOW = Date.parse('2026-10-26T10:00:00Z');
const heldBy = (offsetMs: number) => formatLockValue({ host: 'pc-a', pid: 42, now: NOW + offsetMs, sha: SHA, tag: 'v1.2.2', token: 'autre' });

describe('verrou : décision', () => {
  it('libre si absent', () => {
    expect(decideLock(null, NOW)).toEqual({ acquire: true });
  });

  it('refusé si présent et non expiré', () => {
    const decision = decideLock(heldBy(0), NOW + 60_000);
    expect(decision.acquire).toBe(false);
    expect(decision.holder?.host).toBe('pc-a');
  });

  it('pris s\'il est expiré (le TTL de KV peut traîner)', () => {
    expect(decideLock(heldBy(0), NOW + 15 * 60_000).acquire).toBe(true);
    expect(decideLock(heldBy(0), NOW + 16 * 60_000)).toMatchObject({ acquire: true, expired: { host: 'pc-a' } });
  });

  it('contenu illisible : tenu, sauf --force-unlock', () => {
    expect(decideLock('pas du json', NOW).acquire).toBe(false);
    expect(decideLock('pas du json', NOW, true).acquire).toBe(true);
  });

  it('--force-unlock écrase un verrou valide', () => {
    expect(decideLock(heldBy(0), NOW + 1000, true)).toMatchObject({ acquire: true, overridden: { host: 'pc-a' } });
  });
});

describe('withDeployLock', () => {
  const owner = { host: 'pc-b', pid: 7, sha: SHA, tag: 'v1.2.3' };

  it('prend le verrou (TTL 15 min), exécute, puis le supprime', async () => {
    const { kv, store, calls } = memoryKv();
    const result = await withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW }, () => {
      expect(JSON.parse(store.get('deploy-lock:test') ?? '{}')).toMatchObject({ host: 'pc-b', pid: 7, sha: SHA, tag: 'v1.2.3' });
      return Promise.resolve('fait');
    });
    expect(result).toBe('fait');
    expect(store.size).toBe(0);
    expect(calls).toContain('put deploy-lock:test ttl=900');
  });

  it('libère le verrou même si le déploiement échoue (finally)', async () => {
    const { kv, store } = memoryKv();
    await expect(withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW }, () => Promise.reject(new Error('wrangler a échoué')))).rejects.toThrow('wrangler a échoué');
    expect(store.size).toBe(0);
  });

  it('refuse sans rien écrire si un verrou valide existe', async () => {
    const { kv, store, calls } = memoryKv(heldBy(0));
    let ran = false;
    await expect(withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW + 1000 }, () => { ran = true; return Promise.resolve(); })).rejects.toBeInstanceOf(LockError);
    expect(ran).toBe(false);
    expect(calls.some((c) => c.startsWith('put') || c.startsWith('delete'))).toBe(false);
    expect(store.get('deploy-lock:test')).toBe(heldBy(0));
  });

  it('reprend un verrou expiré', async () => {
    const { kv } = memoryKv(heldBy(0));
    const logs: string[] = [];
    await withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW + 20 * 60_000, log: (l) => logs.push(l) }, () => Promise.resolve());
    expect(logs.join()).toMatch(/expiré/);
  });

  it('--force-unlock écrase le verrou d\'un autre', async () => {
    const { kv, store } = memoryKv(heldBy(0));
    await withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW + 1000, forceUnlock: true }, () => Promise.resolve());
    expect(store.size).toBe(0);
  });

  it('ne supprime pas le verrou si un autre l\'a repris entre-temps', async () => {
    const { kv, store } = memoryKv();
    await withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW }, () => {
      store.set('deploy-lock:test', heldBy(5000));
      return Promise.resolve();
    });
    expect(store.get('deploy-lock:test')).toBe(heldBy(5000));
  });

  it('détecte une course : la relecture ne retrouve pas son jeton', async () => {
    const { kv, store } = memoryKv();
    const racing: KvLike = { ...kv, put: async (key, value, ttl) => { await kv.put(key, value, ttl); store.set(key, heldBy(0)); } };
    await expect(withDeployLock({ kv: racing, key: 'deploy-lock:test', owner, now: () => NOW }, () => Promise.resolve())).rejects.toThrow(/en parallèle/);
  });

  it('une libération qui échoue n\'efface pas le résultat du déploiement', async () => {
    const { kv } = memoryKv();
    const logs: string[] = [];
    const broken: KvLike = { ...kv, delete: () => Promise.reject(new Error('KV indisponible')) };
    await expect(withDeployLock({ kv: broken, key: 'deploy-lock:test', owner, now: () => NOW, log: (l) => logs.push(l) }, () => Promise.resolve(1))).resolves.toBe(1);
    expect(logs.join()).toMatch(/non libéré/);
  });

  it('libère le verrou sur SIGINT puis quitte avec 130', async () => {
    const { kv, store } = memoryKv();
    const proc = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined, exit(code: number) { this.exitCode = code; } });
    let finish: () => void = () => undefined;
    const running = withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW, proc }, () => new Promise<void>((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.size).toBe(1);
    proc.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.size).toBe(0);
    expect(proc.exitCode).toBe(130);
    finish();
    await running;
  });
});

describe('runDeploy : déroulé complet (git, KV et wrangler simulés)', () => {
  const cfg = { name: 'lastaddon', branch: 'main', lockKey: 'deploy-lock:test' };
  const run = (opts: { dryRun?: boolean; repo?: FakeRepo; uiRepo?: FakeRepo; kv?: ReturnType<typeof memoryKv>; withUi?: boolean }) => {
    const kv = opts.kv ?? memoryKv();
    const out: string[] = [];
    const err: string[] = [];
    const deployed: unknown[] = [];
    const git: GitRunner = (args, cwd) => (cwd === '/ui' ? fakeGit({ tag: null, ...opts.uiRepo })(args, cwd) : fakeGit(opts.repo)(args, cwd));
    const code = runDeploy(cfg, { dryRun: opts.dryRun ?? false, forceUnlock: false }, {
      git, cwd: '/repo', kv: kv.kv, ...(opts.withUi === true ? { uiRepo: '/ui' } : {}), owner: { host: 'h', pid: 1 }, now: () => NOW,
      log: (l) => out.push(l), error: (l) => err.push(l),
      deploy: (info) => { deployed.push(info); return 0; },
    });
    return { code, out, err, deployed, kv };
  };

  it('déploie depuis un tag propre, avec le tag et les SHA', async () => {
    const r = run({ withUi: true });
    expect(await r.code).toBe(0);
    expect(r.deployed).toEqual([{ tag: 'v1.2.3', sha: SHA, uiSha: SHA }]);
    expect(r.kv.store.size).toBe(0);
  });

  it('refuse sur une branche de feature sans tag, sans toucher au verrou ni déployer', async () => {
    const r = run({ repo: { branch: 'feature/x', tag: null } });
    expect(await r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/REFUSÉ/);
    expect(r.deployed).toEqual([]);
    expect(r.kv.calls).toEqual([]);
  });

  it('refuse si laststream-app est sale ou pas sur main à jour', async () => {
    const r = run({ withUi: true, uiRepo: { dirty: ' M src/a.ts', branch: 'feature/ui', upstream: OTHER } });
    expect(await r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/laststream-app : arbre suivi sale/);
    expect(r.err.join('\n')).toMatch(/laststream-app : branche « feature\/ui »/);
    expect(r.deployed).toEqual([]);
  });

  it('refuse si le verrou est tenu par un autre', async () => {
    const r = run({ kv: memoryKv(heldBy(0)) });
    expect(await r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/un autre déploiement est en cours/);
    expect(r.deployed).toEqual([]);
  });

  it('--dry-run : vérifications réussies, verrou lu mais jamais écrit, rien déployé', async () => {
    const r = run({ dryRun: true });
    expect(await r.code).toBe(0);
    expect(r.deployed).toEqual([]);
    expect(r.kv.calls.every((c) => c.startsWith('get'))).toBe(true);
  });

  it('--dry-run refuse aussi quand la garde échoue', async () => {
    const r = run({ dryRun: true, repo: { dirty: ' M a' } });
    expect(await r.code).toBe(1);
  });

  it('libère le verrou quand le déploiement renvoie une erreur', async () => {
    const kv = memoryKv();
    const code = await runDeploy(cfg, { dryRun: false, forceUnlock: false }, {
      git: fakeGit(), cwd: '/repo', kv: kv.kv, owner: { host: 'h', pid: 1 }, now: () => NOW, log: () => undefined, error: () => undefined,
      deploy: () => { throw new Error('boum'); },
    });
    expect(code).toBe(1);
    expect(kv.store.size).toBe(0);
  });
});

describe('wranglerKv (commandes simulées)', () => {
  it('lit via list puis get, écrit avec TTL et fichier, supprime en remote', async () => {
    const seen: string[][] = [];
    const kv = wranglerKv({
      binding: 'CACHE',
      tempFile: () => '/tmp/lock.json',
      run: (args) => {
        seen.push(args);
        if (args[2] === 'list') return ok('[{"name":"deploy-lock:x"}]');
        if (args[2] === 'get') return ok('valeur\n');
        return ok();
      },
    });
    expect(await kv.get('deploy-lock:x')).toBe('valeur');
    await kv.put('deploy-lock:x', '{}', 900);
    await kv.delete('deploy-lock:x');
    expect(seen.every((args) => args.includes('--remote') && args.includes('CACHE'))).toBe(true);
    expect(seen[2]).toEqual(['kv', 'key', 'put', 'deploy-lock:x', '--path', '/tmp/lock.json', '--binding', 'CACHE', '--remote', '--ttl', '900']);
  });

  it('clé absente de la liste : null, sans appel get', async () => {
    const seen: string[][] = [];
    const kv = wranglerKv({ binding: 'CACHE', tempFile: () => '', run: (args) => { seen.push(args); return ok('[]'); } });
    expect(await kv.get('deploy-lock:x')).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('une erreur wrangler (authentification, réseau) ne passe pas pour « verrou libre »', async () => {
    const kv = wranglerKv({ binding: 'CACHE', tempFile: () => '', run: () => ko('not authenticated') });
    await expect(kv.get('deploy-lock:x')).rejects.toThrow(/not authenticated/);
  });
});

describe('planRelease (git simulé)', () => {
  it('prépare le tag suivant avec les titres de commits depuis le précédent', () => {
    const plan = planRelease(fakeGit({ tags: ['v1.2.2', 'v1.2.10', 'v1.2.9'], remoteTag: false }), '/repo', { branch: 'main', versionArg: '1.3.0' });
    expect(plan.problems).toEqual([]);
    expect(plan).toMatchObject({ tag: 'v1.3.0', previous: 'v1.2.10', sha: SHA });
    expect(plan.notes).toBe('Release v1.3.0 (depuis v1.2.10)\n\n- LAST-1 : un\n- LAST-2 : deux\n');
  });

  it('refuse une version invalide, existante, non croissante ou une branche sale', () => {
    expect(planRelease(fakeGit(), '/r', { branch: 'main', versionArg: 'abc' }).problems.join()).toMatch(/invalide/);
    expect(planRelease(fakeGit({ tags: ['v1.2.3'] }), '/r', { branch: 'main', versionArg: '1.2.3' }).problems.join()).toMatch(/existe déjà/);
    expect(planRelease(fakeGit({ tags: ['v1.2.3'], remoteTag: false }), '/r', { branch: 'main', versionArg: '1.2.0' }).problems.join()).toMatch(/pas supérieure/);
    expect(planRelease(fakeGit({ branch: 'dev', dirty: ' M a', remoteTag: false }), '/r', { branch: 'main', versionArg: '9.0.0' }).problems).toHaveLength(2);
  });
});

describe('shellQuote', () => {
  it('laisse les arguments sûrs et entoure les autres', () => {
    expect(shellQuote('LASTADDON_RELEASE:v1.2.3')).toBe('LASTADDON_RELEASE:v1.2.3');
    expect(shellQuote('v1.2.3 abcdef')).toBe('"v1.2.3 abcdef"');
    expect(shellQuote('a"b')).toBe('"a\\"b"');
  });
});

describe('serverRelease : version déployée', () => {
  it('sans variable : version du manifeste (repli)', () => {
    expect(serverRelease()).toBe('lastaddon-core@0.1.0');
    expect(serverRelease(undefined)).toBe('lastaddon-core@0.1.0');
  });

  it('avec le tag injecté au déploiement : /health et Sentry le portent', () => {
    expect(serverRelease('v0.4.2')).toBe('lastaddon-core@v0.4.2');
    expect(serverRelease(' v0.4.2\n')).toBe('lastaddon-core@v0.4.2');
  });

  it('valeur invalide ou non texte : repli', () => {
    for (const bad of ['', 'main', '1.2.3', 'v1.2', 42, null, {}]) expect(serverRelease(bad)).toBe('lastaddon-core@0.1.0');
  });
});

describe('/health : release injectée au déploiement', () => {
  it('porte le tag de LASTADDON_RELEASE, et le manifeste sans elle', async () => {
    try {
      process.env.LASTADDON_RELEASE = 'v0.9.0';
      const app = createApp({ secret: 'release-test-secret', allowPlain: false });
      const tagged = (await (await app.request('/health')).json()) as { release: string };
      expect(tagged.release).toBe('lastaddon-core@v0.9.0');
    } finally {
      delete process.env.LASTADDON_RELEASE;
    }
    const plain = (await (await createApp({ secret: 'release-test-secret', allowPlain: false }).request('/health')).json()) as { release: string };
    expect(plain.release).toBe('lastaddon-core@0.1.0');
  });
});

describe('mono-repo : tags préfixés par service (core-v…, edge-v…)', () => {
  // Plusieurs services peuvent étiqueter le même commit : seul le tag du service compte.
  function monoGit(onHead: string[], listed: string[] = [], calls: string[][] = []): GitRunner {
    return (args) => {
      calls.push(args);
      const line = args.join(' ');
      if (args[0] === 'fetch') return ok();
      if (line.startsWith('status --porcelain')) return ok('');
      if (line === 'rev-parse HEAD' || line.startsWith('rev-parse origin/')) return ok(`${SHA}\n`);
      if (line === 'rev-parse --abbrev-ref HEAD') return ok('main\n');
      if (line === 'tag --points-at HEAD') return ok(onHead.join('\n'));
      // Sur origin : les tags déjà posés (HEAD ou liste), pas celui que la release va créer.
      if (args[0] === 'ls-remote') return ok([...onHead, ...listed].includes(args[3].replace('refs/tags/', '')) ? `${SHA}\t${args[3]}\n` : '');
      if (args[0] === 'tag' && args[1] === '--list') return ok(listed.join('\n'));
      if (args[0] === 'log') return ok('LAST-9 : neuf');
      throw new Error(`commande git inattendue : ${line}`);
    };
  }
  const CORE = { branch: 'main', requireTag: true, tagPrefix: 'core-' };

  it('parse, compare et choisit les tags du préfixe seulement', () => {
    expect(parseReleaseTag('core-v0.4.3', 'core-')).toEqual({ tag: 'core-v0.4.3', major: 0, minor: 4, patch: 3 });
    for (const bad of ['v0.4.3', 'edge-v0.4.3', 'core-0.4.3', 'core-v0.4']) expect(parseReleaseTag(bad, 'core-')).toBeNull();
    expect(parseVersionArg('0.4.4', 'core-')).toBe('core-v0.4.4');
    expect(parseVersionArg('core-v0.4.4', 'core-')).toBe('core-v0.4.4');
    expect(latestTag(['core-v0.4.9', 'edge-v2.0.0', 'core-v0.4.10', 'v9.0.0'], 'core-')).toBe('core-v0.4.10');
    expect(compareTags('core-v1.10.0', 'core-v1.9.0', 'core-')).toBeGreaterThan(0);
  });

  it('collectGitState retient le tag du service parmi ceux de HEAD, sans describe', () => {
    const calls: string[][] = [];
    const result = collectGitState(monoGit(['edge-v0.1.2', 'core-v0.4.4', 'site-v1.0.2'], [], calls), '/mono', CORE);
    expect(result.tag).toBe('core-v0.4.4');
    expect(evaluateGuard(result, CORE)).toEqual([]);
    expect(calls.some((c) => c[0] === 'describe')).toBe(false);
  });

  it('HEAD étiqueté pour un autre service seulement : déploiement refusé', () => {
    const result = collectGitState(monoGit(['edge-v0.1.2']), '/mono', CORE);
    expect(result.tag).toBeUndefined();
    expect(evaluateGuard(result, CORE).join()).toMatch(/étiquette core-vX\.Y\.Z/);
    expect(evaluateGuard({ ...result, tag: 'v0.4.4' }, CORE).join()).toMatch(/n'a pas la forme core-vX\.Y\.Z/);
  });

  it('planRelease : tags du préfixe, notes limitées aux dossiers du service', () => {
    const calls: string[][] = [];
    const plan = planRelease(monoGit([], ['core-v0.4.3', 'core-v0.4.2'], calls), '/mono', { branch: 'main', versionArg: '0.4.4', tagPrefix: 'core-', paths: ['services/core', 'apps/web'] });
    expect(plan.problems).toEqual([]);
    expect(plan).toMatchObject({ tag: 'core-v0.4.4', previous: 'core-v0.4.3' });
    expect(calls).toContainEqual(['tag', '--list', 'core-v*']);
    expect(calls.find((c) => c[0] === 'log')).toEqual(['log', '--no-merges', '--pretty=format:%s', 'core-v0.4.3..HEAD', '--', 'services/core', 'apps/web']);
    expect(planRelease(monoGit([], ['core-v0.4.3']), '/mono', { branch: 'main', versionArg: '0.4.3', tagPrefix: 'core-' }).problems.join()).toMatch(/existe déjà/);
  });
});
