import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** Script testé en sous-processus : jamais contre Sentry, seulement contre un faux serveur local (127.0.0.1). */
const SCRIPT = fileURLToPath(new URL('../scripts/sentry-alerts.mjs', import.meta.url));
/** Jeton fictif : il ne doit jamais apparaître dans la sortie du script. */
const TOKEN = 'token-de-test-sans-valeur-reelle-0001';
const RULE_NAMES = ['Laststream : nouvelle issue', 'Laststream : pic d’événements', 'Laststream : DebridEgressBlockedError'];

interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
}

let server: Server;
let apiUrl = '';
let recorded: Recorded[] = [];
/** Règles stockées par projet (clé : chemin du projet) : identifiant et corps. */
let store = new Map<string, Map<string, { name: string; body: Record<string, unknown> }>>();
let nextId = 1;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Faux API Sentry : liste, création et mise à jour des règles d'alerte d'un projet. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const path = (req.url ?? '').split('?')[0];
  const auth = req.headers.authorization;
  const body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  recorded.push({ method: req.method ?? '', path, auth, body });
  const match = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/rules\/(?:(\d+)\/)?$/.exec(path);
  if (match === null) return reply(res, 404, { detail: 'introuvable' });
  const project = `${match[1]}/${match[2]}`;
  const rules = store.get(project) ?? new Map<string, { name: string; body: Record<string, unknown> }>();
  store.set(project, rules);
  const id = match[3];
  if (req.method === 'GET' && id === undefined) {
    return reply(res, 200, [...rules.entries()].map(([ruleId, rule]) => ({ id: ruleId, name: rule.name })));
  }
  if (req.method === 'POST' && id === undefined && body !== undefined) {
    const ruleId = String(nextId++);
    rules.set(ruleId, { name: String(body.name), body });
    return reply(res, 201, { id: ruleId, name: body.name });
  }
  if (req.method === 'PUT' && id !== undefined && body !== undefined && rules.has(id)) {
    rules.set(id, { name: String(body.name), body });
    return reply(res, 200, { id, name: body.name });
  }
  return reply(res, 404, { detail: 'introuvable' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, { detail: 'erreur du faux serveur' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  recorded = [];
  store = new Map();
  nextId = 1;
});

/** Lance le script avec un environnement minimal (pas de variables SENTRY_* de la machine). */
function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      ...env,
    };
    execFile(process.execPath, [SCRIPT, ...args], { env: childEnv, timeout: 20_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

const CONFIG = {
  SENTRY_ORG: 'laststream-test',
  SENTRY_PROJECT_SERVER: 'lastaddon-core',
  SENTRY_PROJECT_WEB: 'laststream-web',
};

describe('scripts/sentry-alerts.mjs : --dry-run', () => {
  it('affiche les requêtes sans jamais contacter l’API (même avec un jeton)', async () => {
    const result = await run(['--dry-run'], { ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    expect(recorded).toEqual([]);
    expect(result.stdout).toContain(`GET ${apiUrl}/api/0/projects/laststream-test/lastaddon-core/rules/`);
    expect(result.stdout).toContain(`GET ${apiUrl}/api/0/projects/laststream-test/laststream-web/rules/`);
    for (const name of RULE_NAMES) expect(result.stdout).toContain(name);
    expect(result.stdout).toContain('EventFrequencyCondition');
    expect(result.stdout).toContain('FirstSeenEventCondition');
    expect(result.stdout).toContain('DebridEgressBlockedError');
    expect(result.stdout.includes(TOKEN)).toBe(false);
  });

  it('ne demande pas le jeton (rien n’est envoyé)', async () => {
    const result = await run(['--dry-run'], CONFIG);
    expect(result.code).toBe(0);
  });
});

describe('scripts/sentry-alerts.mjs : configuration', () => {
  it('organisation manquante : sortie 1 et nom de la variable, sans appel', async () => {
    const result = await run([], { SENTRY_PROJECT_SERVER: 'a', SENTRY_PROJECT_WEB: 'b', SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SENTRY_ORG');
    expect(recorded).toEqual([]);
  });

  it('exécution réelle sans jeton : sortie 1, rien n’est envoyé', async () => {
    const result = await run([], { ...CONFIG, SENTRY_API_URL: apiUrl });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SENTRY_AUTH_TOKEN');
    expect(recorded).toEqual([]);
  });

  it('slug de projet invalide (chemin injecté) : sortie 1, rien n’est envoyé', async () => {
    const result = await run([], { ...CONFIG, SENTRY_PROJECT_WEB: '../autre', SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(recorded).toEqual([]);
  });

  it('URL d’API en clair vers un hôte distant : refusée (le jeton ne part pas en http)', async () => {
    const result = await run([], { ...CONFIG, SENTRY_API_URL: 'http://sentry.example.test', SENTRY_AUTH_TOKEN: TOKEN });
    expect(result.code).toBe(1);
  });
});

describe('scripts/sentry-alerts.mjs : création et mise à jour idempotentes', () => {
  it('première exécution : trois règles créées par projet, jeton en en-tête Authorization', async () => {
    const result = await run([], { ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    const posts = recorded.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(6);
    expect(recorded.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN)).toBe(false);
    for (const project of ['lastaddon-core', 'laststream-web']) {
      const names = [...(store.get(`laststream-test/${project}`)?.values() ?? [])].map((rule) => rule.name);
      expect(names.sort()).toEqual([...RULE_NAMES].sort());
    }
  });

  it('seconde exécution : aucune création, mise à jour des mêmes règles (idempotent)', async () => {
    await run([], { ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    recorded = [];
    const result = await run([], { ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    expect(recorded.filter((r) => r.method === 'POST')).toEqual([]);
    expect(recorded.filter((r) => r.method === 'PUT')).toHaveLength(6);
    for (const project of ['lastaddon-core', 'laststream-web']) {
      expect(store.get(`laststream-test/${project}`)?.size).toBe(3);
    }
  });

  it('règle « pic d’événements » : seuil et fenêtre dans le corps envoyé', async () => {
    await run([], { ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    const spike = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('pic'));
    expect(spike?.body?.conditions).toEqual([
      { id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition', value: 100, comparisonType: 'count', interval: '1h' },
    ]);
    expect(spike?.body?.actionMatch).toBe('all');
    expect(spike?.body?.actions).toEqual([
      { id: 'sentry.mail.actions.NotifyEmailAction', targetType: 'IssueOwners', fallthroughType: 'AllMembers' },
    ]);
  });

  it('règle DebridEgressBlockedError : filtre sur l’attribut exception.type (pas sur un champ « type » inexistant)', async () => {
    await run([], { ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
    const debrid = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('DebridEgressBlockedError'));
    expect(debrid?.body?.filters).toEqual([
      { id: 'sentry.rules.filters.event_attribute.EventAttributeFilter', attribute: 'exception.type', match: 'eq', value: 'DebridEgressBlockedError' },
    ]);
  });
});
