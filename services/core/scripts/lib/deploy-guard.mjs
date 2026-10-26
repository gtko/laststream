// Garde de déploiement et verrou entre sessions (LAST-150). Copie identique dans lastaddon et laststream-edge :
// toute modification se reporte dans les deux dépôts (scripts/lib/deploy-guard.mjs).
// Les fonctions reçoivent leurs dépendances (git, KV, horloge) : aucun appel réel dans les tests.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
/** Durée de vie du verrou : un déploiement dure quelques minutes, 15 min couvrent le pire cas. */
export const LOCK_TTL_SECONDS = 900;

/** Étiquette de release « vX.Y.Z » (rien d'autre : ni préfixe, ni suffixe de pré-version). */
export function parseReleaseTag(text) {
  const match = TAG_PATTERN.exec(String(text ?? '').trim());
  if (match === null) return null;
  return { tag: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Argument de `npm run release -- <x.y.z>` (le « v » est accepté) → étiquette « vX.Y.Z », ou null. */
export function parseVersionArg(text) {
  const raw = String(text ?? '').trim();
  return parseReleaseTag(raw.startsWith('v') ? raw : `v${raw}`)?.tag ?? null;
}

/** Comparaison semver de deux étiquettes « vX.Y.Z » : négatif si a < b. */
export function compareTags(a, b) {
  const left = parseReleaseTag(a);
  const right = parseReleaseTag(b);
  if (left === null || right === null) throw new Error(`Étiquette invalide : ${left === null ? a : b}`);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** La plus haute étiquette « vX.Y.Z » d'une liste, ou undefined. */
export function latestTag(tags) {
  return tags.filter((tag) => parseReleaseTag(tag) !== null).sort(compareTags).at(-1);
}

/**
 * Décision de refus à partir de l'état git. Renvoie la liste des raisons de refus (vide : on peut déployer).
 * state : { dirty: string[], branch, head, upstream, tag, tagOnRemote, errors: string[] }
 * rules : { branch, requireTag }
 */
export function evaluateGuard(state, rules) {
  const problems = [...(state.errors ?? [])];
  if (state.dirty.length > 0) {
    problems.push(`arbre suivi sale (${state.dirty.length} fichier(s) modifié(s) : ${state.dirty.slice(0, 5).join(', ')}${state.dirty.length > 5 ? ', …' : ''})`);
  }
  // HEAD détaché (git checkout vX.Y.Z) est le cas normal d'un déploiement depuis un tag : accepté parce que HEAD doit alors
  // être égal à origin/<branche> (contrôle suivant), donc la pointe de la branche de référence.
  if (state.branch !== rules.branch && state.branch !== 'HEAD') {
    problems.push(`branche « ${state.branch ?? 'inconnue'} » au lieu de « ${rules.branch} »`);
  }
  if (state.head !== undefined && state.upstream !== undefined && state.head !== state.upstream) {
    problems.push(`HEAD (${state.head.slice(0, 7)}) différent de origin/${rules.branch} (${state.upstream.slice(0, 7)}) : mettre à jour ou pousser`);
  }
  if (rules.requireTag) {
    if (state.tag === undefined || parseReleaseTag(state.tag) === null) {
      problems.push(state.tag === undefined ? 'HEAD n\'est pas exactement une étiquette vX.Y.Z (créer la release : npm run release -- <x.y.z>)' : `l'étiquette « ${state.tag} » n'a pas la forme vX.Y.Z`);
    } else if (state.tagOnRemote === false) {
      problems.push(`l'étiquette ${state.tag} n'existe pas sur origin (la pousser)`);
    }
  }
  return problems;
}

/**
 * Lit l'état git d'un dépôt. run(args, cwd) → { status, stdout, stderr } : `git` réel en production, simulé en test.
 * `git fetch` d'abord : sans lui, la comparaison avec origin serait faite sur une copie périmée.
 */
export function collectGitState(run, cwd, { branch, requireTag }) {
  const errors = [];
  const git = (...args) => run(args, cwd);
  const text = (result) => (result.status === 0 ? result.stdout.trim() : undefined);

  const fetched = git('fetch', '--tags', '--quiet', 'origin', branch);
  if (fetched.status !== 0) errors.push(`git fetch origin ${branch} a échoué : ${fetched.stderr.trim() || 'erreur inconnue'}`);

  const status = git('status', '--porcelain', '--untracked-files=no');
  if (status.status !== 0) errors.push('git status a échoué');
  const dirty = status.status === 0 ? status.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '') : [];

  const head = text(git('rev-parse', 'HEAD'));
  const upstream = text(git('rev-parse', `origin/${branch}`));
  const current = text(git('rev-parse', '--abbrev-ref', 'HEAD'));
  if (head === undefined) errors.push('HEAD introuvable (dépôt git ?)');
  if (upstream === undefined) errors.push(`origin/${branch} introuvable`);

  let tag;
  let tagOnRemote;
  if (requireTag) {
    tag = text(git('describe', '--exact-match', '--tags', 'HEAD'));
    if (tag !== undefined) {
      const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
      tagOnRemote = remote.status === 0 ? remote.stdout.trim() !== '' : undefined;
      if (remote.status !== 0) errors.push('git ls-remote --tags origin a échoué');
    }
  }
  return { dirty, branch: current, head, upstream, tag, tagOnRemote, errors };
}

/** Contenu du verrou (JSON). `token` identifie le propriétaire : on ne supprime que son propre verrou. */
export function formatLockValue({ host, pid, now, sha, tag, ttlSeconds = LOCK_TTL_SECONDS, token }) {
  return JSON.stringify({ host, pid, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSeconds * 1000).toISOString(), sha, tag, token });
}

export function parseLockValue(raw) {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' ? value : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

/**
 * Verrou présent et non expiré ? raw : valeur lue (null : absente). Le TTL de KV peut traîner : on vérifie aussi expiresAt.
 * Un contenu illisible compte comme un verrou tenu (propriétaire inconnu) : seul --force-unlock le lève.
 */
export function decideLock(raw, now, forceUnlock = false) {
  const holder = parseLockValue(raw);
  if (holder === null) return { acquire: true };
  if (forceUnlock) return { acquire: true, overridden: holder };
  const expires = typeof holder.expiresAt === 'string' ? Date.parse(holder.expiresAt) : Number.NaN;
  if (!holder.invalid && Number.isFinite(expires) && expires <= now) return { acquire: true, expired: holder };
  return { acquire: false, holder };
}

export function describeHolder(holder) {
  if (holder.invalid === true) return 'contenu illisible';
  return `${holder.host ?? '?'} (pid ${holder.pid ?? '?'}) depuis ${holder.startedAt ?? '?'}, ${holder.tag ?? '?'} ${String(holder.sha ?? '').slice(0, 7)}, expire ${holder.expiresAt ?? '?'}`;
}

export class LockError extends Error {}

/**
 * Exécute task() sous verrou. kv : { get(key) → string|null, put(key, value, ttlSeconds), delete(key) }.
 * Le verrou est libéré à la fin, succès ou échec (finally), et sur SIGINT/SIGTERM (proc.on).
 * KV est cohérent à terme : relecture après écriture pour détecter une course, mais ce n'est pas un verrou strict
 * (deux démarrages à la même seconde peuvent encore se croiser ; voir docs/deploiement.md).
 */
export async function withDeployLock({ kv, key, owner, now = () => Date.now(), forceUnlock = false, log = () => undefined, proc }, task) {
  const decision = decideLock(await kv.get(key), now(), forceUnlock);
  if (!decision.acquire) {
    throw new LockError(`un autre déploiement est en cours : ${describeHolder(decision.holder)}. Attendre son expiration (15 min) ou relancer avec --force-unlock si le propriétaire est mort.`);
  }
  if (decision.overridden !== undefined) log(`--force-unlock : verrou de ${describeHolder(decision.overridden)} écrasé.`);
  if (decision.expired !== undefined) log(`verrou expiré de ${describeHolder(decision.expired)} ignoré.`);

  const token = randomUUID();
  await kv.put(key, formatLockValue({ ...owner, now: now(), token }), LOCK_TTL_SECONDS);
  const written = parseLockValue(await kv.get(key));
  if (written?.token !== token) {
    throw new LockError(`verrou pris en parallèle par un autre déploiement : ${written === null ? 'illisible' : describeHolder(written)}.`);
  }
  log(`verrou ${key} pris (${LOCK_TTL_SECONDS / 60} min).`);

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      // Ne supprime que son propre verrou : un --force-unlock d'un autre déploiement reste en place.
      const current = parseLockValue(await kv.get(key));
      if (current === null || current.token === token) await kv.delete(key);
      log(`verrou ${key} libéré.`);
    } catch (error) {
      log(`ATTENTION : verrou ${key} non libéré (${error instanceof Error ? error.message : String(error)}) ; il expirera seul.`);
    }
  };
  const onSignal = (signal) => {
    void release().finally(() => proc.exit(signal === 'SIGINT' ? 130 : 143));
  };
  proc?.on('SIGINT', onSignal);
  proc?.on('SIGTERM', onSignal);
  try {
    return await task();
  } finally {
    proc?.off('SIGINT', onSignal);
    proc?.off('SIGTERM', onSignal);
    await release();
  }
}

/** Quote un argument pour `shell: true` (Windows : npx.cmd). Les arguments sûrs restent tels quels. */
export function shellQuote(arg) {
  return /^[\w./:@=,+-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * KV adossé à wrangler (--remote). run(args) → { status, stdout, stderr } pour la commande `wrangler kv key …`.
 * Lecture : `list --prefix` d'abord pour distinguer « clé absente » d'une vraie erreur réseau ou d'authentification.
 */
export function wranglerKv({ binding, run, tempFile }) {
  const base = ['kv', 'key'];
  const fail = (what, result) => new Error(`wrangler kv ${what} a échoué : ${(result.stderr || result.stdout).trim().slice(-300)}`);
  return {
    async get(key) {
      const listed = run([...base, 'list', '--binding', binding, '--remote', '--prefix', key]);
      if (listed.status !== 0) throw fail('key list', listed);
      let names;
      try {
        names = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['))).map((entry) => entry.name);
      } catch {
        throw new Error('réponse de wrangler kv key list illisible');
      }
      if (!names.includes(key)) return null;
      const got = run([...base, 'get', key, '--binding', binding, '--remote', '--text']);
      if (got.status !== 0) throw fail('key get', got);
      return got.stdout.trim();
    },
    async put(key, value, ttlSeconds) {
      const path = tempFile(value);
      const put = run([...base, 'put', key, '--path', path, '--binding', binding, '--remote', '--ttl', String(ttlSeconds)]);
      if (put.status !== 0) throw fail('key put', put);
    },
    async delete(key) {
      const del = run([...base, 'delete', key, '--binding', binding, '--remote']);
      if (del.status !== 0) throw fail('key delete', del);
    },
  };
}

/**
 * Déroulé commun d'un déploiement. cfg : { name, branch, lockKey }.
 * deps : { git(args, cwd), cwd, kv, uiRepo? (dossier du dépôt de l'interface), deploy({ tag, sha, uiSha }) → code, log, error, now, proc, owner }.
 * Renvoie le code de sortie (0 : déployé, ou vérifications réussies en --dry-run).
 */
export async function runDeploy(cfg, options, deps) {
  const { log, error } = deps;
  const rules = { branch: cfg.branch, requireTag: true };
  const state = collectGitState(deps.git, deps.cwd, rules);
  const problems = evaluateGuard(state, rules).map((problem) => `${cfg.name} : ${problem}`);

  let uiSha;
  if (deps.uiRepo !== undefined) {
    const uiRules = { branch: 'main', requireTag: false };
    const uiState = collectGitState(deps.git, deps.uiRepo, uiRules);
    problems.push(...evaluateGuard(uiState, uiRules).map((problem) => `laststream-app : ${problem}`));
    uiSha = uiState.head;
  }

  if (problems.length > 0) {
    error(`Déploiement REFUSÉ (${cfg.name}) :`);
    for (const problem of problems) error(`  - ${problem}`);
    return 1;
  }

  const tag = state.tag;
  const sha = state.head;
  log(`Garde OK : ${cfg.name} ${tag} (${sha.slice(0, 7)})${uiSha === undefined ? '' : `, laststream-app main ${uiSha.slice(0, 7)}`}.`);

  const lockOptions = { kv: deps.kv, key: cfg.lockKey, owner: { ...deps.owner, sha, tag }, now: deps.now, forceUnlock: options.forceUnlock, log, proc: deps.proc };
  try {
    if (options.dryRun) {
      const decision = decideLock(await deps.kv.get(cfg.lockKey), (deps.now ?? Date.now)(), options.forceUnlock);
      if (!decision.acquire) throw new LockError(`un autre déploiement est en cours : ${describeHolder(decision.holder)}.`);
      log(`--dry-run : vérifications réussies, verrou libre, rien n'est déployé.`);
      return 0;
    }
    return await withDeployLock(lockOptions, () => deps.deploy({ tag, sha, uiSha }));
  } catch (caught) {
    if (caught instanceof LockError) {
      error(`Déploiement REFUSÉ (${cfg.name}) : ${caught.message}`);
      return 1;
    }
    error(`Déploiement interrompu (${cfg.name}) : ${caught instanceof Error ? caught.message : String(caught)}`);
    return 1;
  }
}

/** Notes de release : titres des commits depuis l'étiquette précédente. */
export function releaseNotes({ tag, previous, subjects }) {
  const lines = subjects.map((subject) => subject.trim()).filter((subject) => subject !== '').map((subject) => `- ${subject}`);
  const header = previous === undefined ? `Release ${tag}` : `Release ${tag} (depuis ${previous})`;
  return `${header}\n\n${lines.length === 0 ? '- (aucun commit)' : lines.join('\n')}\n`;
}

/**
 * Création d'une release. Renvoie { problems, notes, tag, previous }. Ne touche à rien (le script exécute ensuite).
 * run(args, cwd) comme collectGitState.
 */
export function planRelease(run, cwd, { branch, versionArg }) {
  const tag = parseVersionArg(versionArg);
  const problems = [];
  if (tag === null) problems.push(`version « ${versionArg ?? ''} » invalide (attendu x.y.z)`);
  const rules = { branch, requireTag: false };
  const state = collectGitState(run, cwd, rules);
  problems.push(...evaluateGuard(state, rules));
  if (tag === null) return { problems };

  const tagsResult = run(['tag', '--list', 'v*'], cwd);
  const tags = tagsResult.status === 0 ? tagsResult.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
  if (tagsResult.status !== 0) problems.push('git tag --list a échoué');
  if (tags.includes(tag)) problems.push(`l'étiquette ${tag} existe déjà`);
  const previous = latestTag(tags);
  if (previous !== undefined && !tags.includes(tag) && compareTags(tag, previous) <= 0) {
    problems.push(`${tag} n'est pas supérieure à la dernière étiquette ${previous}`);
  }
  const remote = run(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], cwd);
  if (remote.status === 0 && remote.stdout.trim() !== '') problems.push(`l'étiquette ${tag} existe déjà sur origin`);

  const range = previous === undefined ? ['HEAD'] : [`${previous}..HEAD`];
  const log = run(['log', '--no-merges', '--pretty=format:%s', ...range], cwd);
  if (log.status !== 0) problems.push('git log a échoué');
  const subjects = log.status === 0 ? log.stdout.split('\n') : [];
  return { problems, tag, previous, sha: state.head, notes: releaseNotes({ tag, previous, subjects }) };
}

// --- Entrées/sorties réelles (jamais appelées par les tests) ---

/** Lance git sans shell. */
export function realGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}

/** Lance `npx <wrangler> <args>` (shell requis sous Windows pour npx.cmd). */
export function realWrangler(wranglerSpec, args, cwd, { inherit = false } = {}) {
  const result = spawnSync('npx', ['--yes', wranglerSpec, ...args].map(shellQuote), { cwd, encoding: 'utf8', shell: true, stdio: inherit ? 'inherit' : 'pipe' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}

/** KV réel via wrangler : la valeur passe par un fichier temporaire (pas de guillemets à échapper), supprimé ensuite. */
export function realKv({ binding, wranglerSpec, cwd }) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-lock-'));
  const kv = wranglerKv({
    binding,
    run: (args) => realWrangler(wranglerSpec, args, cwd),
    tempFile: (content) => {
      const path = join(dir, 'lock.json');
      writeFileSync(path, content);
      return path;
    },
  });
  return { ...kv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
