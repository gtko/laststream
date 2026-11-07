import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  collectGitState,
  decideLock,
  evaluateGuard,
  formatLockValue,
  LockError,
  parseReleaseTag,
  parseVersionArg,
  planRelease,
  runDeploy,
  withDeployLock,
  wranglerKv,
} from '../scripts/lib/deploy-guard.mjs';

// Aucun appel réel à git ni à wrangler : git est simulé par une table commande → résultat, KV par une Map.

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const ko = (stderr = 'erreur') => ({ status: 1, stdout: '', stderr });

function fakeGit({ branch = 'master', dirty = '', head = SHA, upstream = SHA, tag = 'v1.2.3', remoteTag = true, fetchOk = true, tags = ['v1.2.2'], log = 'LAST-1 : un\nLAST-2 : deux' } = {}) {
  return (args) => {
    const line = args.join(' ');
    if (args[0] === 'fetch') return fetchOk ? ok() : ko('réseau coupé');
    if (line.startsWith('status --porcelain')) return ok(dirty);
    if (line === 'rev-parse HEAD') return ok(`${head}\n`);
    if (line.startsWith('rev-parse origin/')) return ok(`${upstream}\n`);
    if (line === 'rev-parse --abbrev-ref HEAD') return ok(`${branch}\n`);
    if (args[0] === 'describe') return tag === null ? ko('fatal: no tag exactly matches') : ok(`${tag}\n`);
    if (args[0] === 'ls-remote') return ok(remoteTag ? `${head}\trefs/tags/x\n` : '');
    if (line === 'tag --list v*') return ok(tags.join('\n'));
    if (args[0] === 'log') return ok(log);
    throw new Error(`commande git inattendue : ${line}`);
  };
}

const state = (patch = {}) => ({ dirty: [], branch: 'master', head: SHA, upstream: SHA, tag: 'v1.2.3', tagOnRemote: true, errors: [], ...patch });
const RULES = { branch: 'master', requireTag: true };

function memoryKv(initial) {
  const store = new Map(initial === undefined ? [] : [['deploy-lock:test', initial]]);
  const calls = [];
  return {
    store,
    calls,
    kv: {
      get: async (key) => { calls.push(`get ${key}`); return store.get(key) ?? null; },
      put: async (key, value, ttl) => { calls.push(`put ${key} ttl=${ttl}`); store.set(key, value); },
      delete: async (key) => { calls.push(`delete ${key}`); store.delete(key); },
    },
  };
}

const NOW = Date.parse('2026-10-26T10:00:00Z');
const heldBy = (offsetMs) => formatLockValue({ host: 'pc-a', pid: 42, now: NOW + offsetMs, sha: SHA, tag: 'v1.2.2', token: 'autre' });

describe('étiquettes', () => {
  it('parseReleaseTag accepte vX.Y.Z et rien d\'autre', () => {
    assert.deepEqual(parseReleaseTag('v1.20.3'), { tag: 'v1.20.3', major: 1, minor: 20, patch: 3 });
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc1', 'v1.2.3.4', '', undefined]) assert.equal(parseReleaseTag(bad), null);
  });

  it('parseVersionArg accepte x.y.z avec ou sans « v »', () => {
    assert.equal(parseVersionArg('0.2.0'), 'v0.2.0');
    assert.equal(parseVersionArg('v0.2.0'), 'v0.2.0');
    assert.equal(parseVersionArg('0.2'), null);
  });
});

describe('evaluateGuard : refus ou accord', () => {
  it('accepte master propre, à jour, sur un tag publié', () => {
    assert.deepEqual(evaluateGuard(state(), RULES), []);
  });

  it('refuse un arbre sale, une autre branche (dont main), HEAD ≠ origin, aucun tag, tag absent d\'origin', () => {
    assert.match(evaluateGuard(state({ dirty: [' M src/index.js'] }), RULES).join(), /arbre suivi sale/);
    assert.match(evaluateGuard(state({ branch: 'feature/x' }), RULES).join(), /au lieu de « master »/);
    assert.match(evaluateGuard(state({ branch: 'main' }), RULES).join(), /au lieu de « master »/);
    assert.match(evaluateGuard(state({ head: OTHER }), RULES).join(), /différent de origin\/master/);
    assert.match(evaluateGuard(state({ tag: undefined }), RULES).join(), /pas exactement une étiquette/);
    assert.match(evaluateGuard(state({ tag: 'prod-1' }), RULES).join(), /forme vX\.Y\.Z/);
    assert.match(evaluateGuard(state({ tagOnRemote: false }), RULES).join(), /n'existe pas sur origin/);
  });

  it('accepte un HEAD détaché sur le tag s\'il est la pointe de origin/master, le refuse sinon', () => {
    assert.deepEqual(evaluateGuard(state({ branch: 'HEAD' }), RULES), []);
    assert.match(evaluateGuard(state({ branch: 'HEAD', head: OTHER }), RULES).join(), /différent de origin\/master/);
  });

  it('cumule les raisons et reprend les erreurs de collecte', () => {
    assert.equal(evaluateGuard(state({ dirty: ['M a'], branch: 'x', tag: undefined, errors: ['git fetch a échoué'] }), RULES).length, 4);
  });
});

describe('collectGitState (git simulé)', () => {
  it('lit l\'état complet ; un fetch en échec devient une raison de refus', () => {
    assert.deepEqual(evaluateGuard(collectGitState(fakeGit(), '/repo', RULES), RULES), []);
    assert.match(evaluateGuard(collectGitState(fakeGit({ fetchOk: false }), '/repo', RULES), RULES).join(), /git fetch origin master a échoué : réseau coupé/);
  });

  it('branche de feature sans tag, arbre sale : trois raisons', () => {
    const problems = evaluateGuard(collectGitState(fakeGit({ dirty: ' M a.js', tag: null, branch: 'feature/x' }), '/repo', RULES), RULES);
    assert.equal(problems.length, 3);
  });
});

describe('verrou', () => {
  const owner = { host: 'pc-b', pid: 7, sha: SHA, tag: 'v1.2.3' };

  it('décision : libre, tenu, expiré, illisible, forcé', () => {
    assert.equal(decideLock(null, NOW).acquire, true);
    assert.equal(decideLock(heldBy(0), NOW + 60_000).acquire, false);
    assert.equal(decideLock(heldBy(0), NOW + 16 * 60_000).acquire, true);
    assert.equal(decideLock('pas du json', NOW).acquire, false);
    assert.equal(decideLock(heldBy(0), NOW + 1000, true).acquire, true);
  });

  it('prend le verrou (TTL 15 min), exécute, le supprime ; libère aussi en cas d\'échec', async () => {
    const a = memoryKv();
    assert.equal(await withDeployLock({ kv: a.kv, key: 'deploy-lock:test', owner, now: () => NOW }, async () => 'fait'), 'fait');
    assert.equal(a.store.size, 0);
    assert.ok(a.calls.includes('put deploy-lock:test ttl=900'));
    const b = memoryKv();
    await assert.rejects(withDeployLock({ kv: b.kv, key: 'deploy-lock:test', owner, now: () => NOW }, async () => { throw new Error('wrangler a échoué'); }), /wrangler a échoué/);
    assert.equal(b.store.size, 0);
  });

  it('refuse sans rien écrire si un verrou valide existe', async () => {
    const { kv, calls } = memoryKv(heldBy(0));
    let ran = false;
    await assert.rejects(withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW + 1000 }, async () => { ran = true; }), LockError);
    assert.equal(ran, false);
    assert.equal(calls.some((c) => c.startsWith('put') || c.startsWith('delete')), false);
  });

  it('ne supprime pas le verrou si un autre l\'a repris entre-temps', async () => {
    const { kv, store } = memoryKv();
    await withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW }, async () => { store.set('deploy-lock:test', heldBy(5000)); });
    assert.equal(store.get('deploy-lock:test'), heldBy(5000));
  });

  it('libère le verrou sur SIGINT puis quitte avec 130', async () => {
    const { kv, store } = memoryKv();
    const proc = Object.assign(new EventEmitter(), { exitCode: undefined, exit(code) { this.exitCode = code; } });
    let finish = () => undefined;
    const running = withDeployLock({ kv, key: 'deploy-lock:test', owner, now: () => NOW, proc }, () => new Promise((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.size, 1);
    proc.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.size, 0);
    assert.equal(proc.exitCode, 130);
    finish();
    await running;
  });
});

describe('runDeploy : déroulé complet (git, KV et wrangler simulés)', () => {
  const cfg = { name: 'laststream-edge', branch: 'master', lockKey: 'deploy-lock:test' };
  const run = ({ dryRun = false, repo, kv = memoryKv() } = {}) => {
    const out = [];
    const err = [];
    const deployed = [];
    const code = runDeploy(cfg, { dryRun, forceUnlock: false }, {
      git: fakeGit(repo), cwd: '/repo', kv: kv.kv, owner: { host: 'h', pid: 1 }, now: () => NOW,
      log: (l) => out.push(l), error: (l) => err.push(l), deploy: (info) => { deployed.push(info); return 0; },
    });
    return { code, out, err, deployed, kv };
  };

  it('déploie depuis un tag propre avec le tag et le SHA, puis libère le verrou', async () => {
    const r = run();
    assert.equal(await r.code, 0);
    assert.deepEqual(r.deployed, [{ tag: 'v1.2.3', sha: SHA, uiSha: undefined }]);
    assert.equal(r.kv.store.size, 0);
  });

  it('refuse sur une branche de feature sans tag : ni déploiement ni accès au verrou', async () => {
    const r = run({ repo: { branch: 'feature/x', tag: null } });
    assert.equal(await r.code, 1);
    assert.match(r.err.join('\n'), /REFUSÉ/);
    assert.deepEqual(r.deployed, []);
    assert.deepEqual(r.kv.calls, []);
  });

  it('refuse si le verrou est tenu par un autre', async () => {
    const r = run({ kv: memoryKv(heldBy(0)) });
    assert.equal(await r.code, 1);
    assert.match(r.err.join('\n'), /un autre déploiement est en cours/);
    assert.deepEqual(r.deployed, []);
  });

  it('--dry-run : verrou lu mais jamais écrit, rien déployé', async () => {
    const r = run({ dryRun: true });
    assert.equal(await r.code, 0);
    assert.deepEqual(r.deployed, []);
    assert.ok(r.kv.calls.every((c) => c.startsWith('get')));
  });

  it('libère le verrou quand le déploiement lève une erreur', async () => {
    const kv = memoryKv();
    const code = await runDeploy(cfg, { dryRun: false, forceUnlock: false }, {
      git: fakeGit(), cwd: '/repo', kv: kv.kv, owner: { host: 'h', pid: 1 }, now: () => NOW, log: () => undefined, error: () => undefined,
      deploy: () => { throw new Error('boum'); },
    });
    assert.equal(code, 1);
    assert.equal(kv.store.size, 0);
  });
});

describe('wranglerKv (commandes simulées)', () => {
  it('lit via list puis get, écrit avec TTL et fichier, supprime en remote ; une erreur ne passe pas pour « libre »', async () => {
    const seen = [];
    const kv = wranglerKv({
      binding: 'LASTSTREAM_ROUTE',
      tempFile: () => '/tmp/lock.json',
      run: (args) => {
        seen.push(args);
        if (args[2] === 'list') return ok('[{"name":"deploy-lock:x"}]');
        if (args[2] === 'get') return ok('valeur\n');
        return ok();
      },
    });
    assert.equal(await kv.get('deploy-lock:x'), 'valeur');
    await kv.put('deploy-lock:x', '{}', 900);
    await kv.delete('deploy-lock:x');
    assert.ok(seen.every((args) => args.includes('--remote') && args.includes('LASTSTREAM_ROUTE')));
    assert.deepEqual(seen[2], ['kv', 'key', 'put', 'deploy-lock:x', '--path', '/tmp/lock.json', '--binding', 'LASTSTREAM_ROUTE', '--remote', '--ttl', '900']);
    const broken = wranglerKv({ binding: 'B', tempFile: () => '', run: () => ko('not authenticated') });
    await assert.rejects(broken.get('deploy-lock:x'), /not authenticated/);
  });
});

describe('planRelease (git simulé)', () => {
  it('prépare le tag suivant avec les titres de commits depuis le précédent', () => {
    const plan = planRelease(fakeGit({ tags: ['v1.2.2', 'v1.2.10', 'v1.2.9'], remoteTag: false }), '/repo', { branch: 'master', versionArg: '1.3.0' });
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.previous, 'v1.2.10');
    assert.equal(plan.notes, 'Release v1.3.0 (depuis v1.2.10)\n\n- LAST-1 : un\n- LAST-2 : deux\n');
  });

  it('refuse une version invalide, existante, non croissante ou une branche sale', () => {
    assert.match(planRelease(fakeGit(), '/r', { branch: 'master', versionArg: 'abc' }).problems.join(), /invalide/);
    assert.match(planRelease(fakeGit({ tags: ['v1.2.3'] }), '/r', { branch: 'master', versionArg: '1.2.3' }).problems.join(), /existe déjà/);
    assert.match(planRelease(fakeGit({ tags: ['v1.2.3'], remoteTag: false }), '/r', { branch: 'master', versionArg: '1.2.0' }).problems.join(), /pas supérieure/);
    assert.equal(planRelease(fakeGit({ branch: 'dev', dirty: ' M a', remoteTag: false }), '/r', { branch: 'master', versionArg: '9.0.0' }).problems.length, 2);
  });
});

describe('mono-repo : tags préfixés par service (edge-v…)', () => {
  // Plusieurs services peuvent étiqueter le même commit : seul le tag du service compte.
  function monoGit(onHead, listed = [], calls = []) {
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
  const EDGE = { branch: 'main', requireTag: true, tagPrefix: 'edge-' };

  it('collectGitState retient le tag edge parmi ceux de HEAD, sans describe', () => {
    const calls = [];
    const result = collectGitState(monoGit(['core-v0.4.4', 'edge-v0.1.2'], [], calls), '/mono', EDGE);
    assert.equal(result.tag, 'edge-v0.1.2');
    assert.deepEqual(evaluateGuard(result, EDGE), []);
    assert.equal(calls.some((c) => c[0] === 'describe'), false);
  });

  it('HEAD étiqueté pour un autre service seulement : déploiement refusé', () => {
    const result = collectGitState(monoGit(['core-v0.4.4']), '/mono', EDGE);
    assert.equal(result.tag, undefined);
    assert.match(evaluateGuard(result, EDGE).join(), /étiquette edge-vX\.Y\.Z/);
    assert.equal(parseReleaseTag('core-v0.4.4', 'edge-'), null);
    assert.equal(parseVersionArg('0.1.2', 'edge-'), 'edge-v0.1.2');
  });

  it('planRelease : tags edge-v*, notes limitées à services/edge', () => {
    const calls = [];
    const plan = planRelease(monoGit([], ['edge-v0.1.1'], calls), '/mono', { branch: 'main', versionArg: '0.1.2', tagPrefix: 'edge-', paths: ['services/edge'] });
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.tag, 'edge-v0.1.2');
    assert.deepEqual(calls.find((c) => c[0] === 'log'), ['log', '--no-merges', '--pretty=format:%s', 'edge-v0.1.1..HEAD', '--', 'services/edge']);
  });
});
