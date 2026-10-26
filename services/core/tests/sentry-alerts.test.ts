import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** Script testé en sous-processus : jamais contre Sentry, seulement contre un faux serveur local (127.0.0.1). */
const SCRIPT = fileURLToPath(new URL('../scripts/sentry-alerts.mjs', import.meta.url));
/** Jeton fictif : il ne doit jamais apparaître dans la sortie du script. */
const TOKEN = 'token-de-test-sans-valeur-reelle-0001';
const ALERT_NAMES = ['Laststream : nouvelle issue', 'Laststream : pic d’événements', 'Laststream : DebridEgressBlockedError'];

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
}

interface Workflow {
  name: string;
  project: string;
  body: Record<string, unknown>;
}

let server: Server;
let apiUrl = '';
let recorded: Recorded[] = [];
/** Detectors par slug de projet. */
let detectors = new Map<string, Array<{ id: string; type: string; name: string }>>();
/** Workflows stockés par identifiant. */
let workflows = new Map<string, Workflow>();
let nextId = 1;
/** Statut d'échec imposé aux écritures (POST/PUT), ou à toutes les requêtes (failAll). */
let failWrites: number | null = null;
let failAll: number | null = null;

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

/** Faux API Sentry (moteur workflows) : liste des detectors et des workflows, création, mise à jour. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const url = new URL(req.url ?? '', 'http://127.0.0.1');
  const path = url.pathname;
  const body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  const method = req.method ?? '';
  recorded.push({ method, path, query: url.searchParams, auth: req.headers.authorization, body });
  // Le faux serveur renvoie volontairement le jeton dans le corps d'erreur : le script doit l'expurger.
  if (failAll !== null) return reply(res, failAll, { detail: `refus pour ${TOKEN}` });
  if (failWrites !== null && method !== 'GET') return reply(res, failWrites, { detail: 'You do not have permission to perform this action.' });
  const match = /^\/api\/0\/organizations\/([^/]+)\/(detectors|workflows)\/(?:(\d+)\/)?$/.exec(path);
  if (match === null || match[1] !== 'laststream-test') return reply(res, 404, { detail: 'introuvable' });
  const project = url.searchParams.get('project') ?? '';
  const id = match[3];
  if (match[2] === 'detectors' && method === 'GET') return reply(res, 200, detectors.get(project) ?? []);
  if (match[2] === 'workflows') {
    if (method === 'GET' && id === undefined) {
      const list = [...workflows.entries()].filter(([, w]) => w.project === project);
      return reply(res, 200, list.map(([wid, w]) => ({ id: wid, name: w.name, enabled: true, detectorIds: w.body.detector_ids })));
    }
    if (body !== undefined && method === 'POST' && id === undefined) {
      const wid = String(nextId++);
      const detectorId = String((body.detector_ids as number[])[0]);
      const owner = [...detectors.entries()].find(([, list]) => list.some((d) => d.id === detectorId));
      workflows.set(wid, { name: String(body.name), project: owner?.[0] ?? '', body });
      return reply(res, 201, { id: wid, name: body.name });
    }
    if (body !== undefined && method === 'PUT' && id !== undefined && workflows.has(id)) {
      const previous = workflows.get(id) as Workflow;
      workflows.set(id, { name: String(body.name), project: previous.project, body });
      return reply(res, 200, { id, name: body.name });
    }
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
  workflows = new Map();
  nextId = 1;
  failWrites = null;
  failAll = null;
  detectors = new Map([
    ['lastaddon-core', [{ id: '101', type: 'error', name: 'Error Monitor' }]],
    ['laststream-web', [{ id: '202', type: 'error', name: 'Error Monitor' }]],
  ]);
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
const LIVE = { ...CONFIG, SENTRY_API_URL: '', SENTRY_AUTH_TOKEN: TOKEN };
const live = () => ({ ...LIVE, SENTRY_API_URL: apiUrl });
const noToken = (r: { stdout: string; stderr: string }) => !r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN);

describe('scripts/sentry-alerts.mjs : --dry-run', () => {
  it('affiche les requêtes sans jamais contacter l’API (même avec un jeton)', async () => {
    const result = await run(['--dry-run'], live());
    expect(result.code).toBe(0);
    expect(recorded).toEqual([]);
    expect(result.stdout).toContain(`GET ${apiUrl}/api/0/organizations/laststream-test/detectors/?project=lastaddon-core`);
    expect(result.stdout).toContain(`POST ${apiUrl}/api/0/organizations/laststream-test/workflows/`);
    expect(result.stdout).toContain('/workflows/<id>/');
    for (const name of ALERT_NAMES) expect(result.stdout).toContain(name);
    for (const token of ['first_seen_event', 'event_frequency_count', 'exception.type', 'DebridEgressBlockedError']) {
      expect(result.stdout).toContain(token);
    }
    expect(result.stdout).not.toContain('/rules/');
    expect(noToken(result)).toBe(true);
  });

  it('ne demande pas le jeton (rien n’est envoyé)', async () => {
    const result = await run(['--dry-run'], CONFIG);
    expect(result.code).toBe(0);
  });

  it('--dry-run et --check ensemble : refusé', async () => {
    const result = await run(['--dry-run', '--check'], live());
    expect(result.code).toBe(1);
    expect(recorded).toEqual([]);
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
    const result = await run([], { ...live(), SENTRY_PROJECT_WEB: '../autre' });
    expect(result.code).toBe(1);
    expect(recorded).toEqual([]);
  });

  it('URL d’API en clair vers un hôte distant : refusée (le jeton ne part pas en http)', async () => {
    const result = await run([], { ...live(), SENTRY_API_URL: 'http://sentry.example.test' });
    expect(result.code).toBe(1);
  });
});

describe('scripts/sentry-alerts.mjs : création et mise à jour idempotentes', () => {
  it('première exécution : detector trouvé, trois workflows créés par projet, jeton en en-tête', async () => {
    const result = await run([], live());
    expect(result.code).toBe(0);
    const posts = recorded.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(6);
    expect(recorded.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(noToken(result)).toBe(true);
    for (const [project, detectorId] of [['lastaddon-core', 101], ['laststream-web', 202]] as const) {
      const mine = posts.filter((r) => (r.body?.detector_ids as number[])[0] === detectorId);
      expect(mine.map((r) => r.body?.name).sort()).toEqual([...ALERT_NAMES].sort());
      expect(mine.every((r) => (r.body?.detector_ids as number[]).length === 1)).toBe(true);
      const detectorCall = recorded.find((r) => r.path.endsWith('/detectors/') && r.query.get('project') === project);
      expect(detectorCall?.query.get('type')).toBe('error');
    }
  });

  it('seconde exécution : aucune création, PUT sur les mêmes workflows (idempotent)', async () => {
    await run([], live());
    recorded = [];
    const result = await run([], live());
    expect(result.code).toBe(0);
    expect(recorded.filter((r) => r.method === 'POST')).toEqual([]);
    const puts = recorded.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(6);
    expect(puts.every((r) => /\/workflows\/\d+\/$/.test(r.path) && r.body?.id === r.path.split('/').at(-2))).toBe(true);
    expect(workflows.size).toBe(6);
  });

  it('un workflow du même nom dans un autre projet n’est pas réutilisé (filtre par projet)', async () => {
    workflows.set('900', { name: ALERT_NAMES[0] as string, project: 'autre-projet', body: { name: ALERT_NAMES[0], detector_ids: [999] } });
    const result = await run([], live());
    expect(result.code).toBe(0);
    expect(recorded.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(recorded.filter((r) => r.method === 'POST')).toHaveLength(6);
    expect(workflows.get('900')?.body.detector_ids).toEqual([999]);
  });

  it('alerte « pic d’événements » : seuil, fenêtre, fréquence et action e-mail propriétaires dans le corps', async () => {
    await run([], live());
    const spike = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('pic'));
    expect(spike?.body?.config).toEqual({ frequency: 30 });
    expect(spike?.body?.enabled).toBe(true);
    expect(spike?.body?.triggers).toEqual({
      logicType: 'any-short',
      conditions: [{ type: 'event_frequency_count', comparison: { value: 100, interval: '1h' }, conditionResult: true }],
    });
    expect(spike?.body?.action_filters).toEqual([
      {
        logicType: 'all',
        conditions: [],
        actions: [
          {
            type: 'email',
            integrationId: null,
            data: { fallthroughType: 'AllMembers' },
            config: { targetType: 'issue_owners', targetDisplay: null, targetIdentifier: '' },
            status: 'active',
          },
        ],
      },
    ]);
  });

  it('alerte « nouvelle issue » : déclencheur first_seen_event', async () => {
    await run([], live());
    const fresh = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('nouvelle'));
    expect(fresh?.body?.triggers).toEqual({
      logicType: 'any-short',
      conditions: [{ type: 'first_seen_event', comparison: true, conditionResult: true }],
    });
  });

  it('alerte DebridEgressBlockedError : filtre sur l’attribut exception.type', async () => {
    await run([], live());
    const debrid = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('DebridEgressBlockedError'));
    const filters = debrid?.body?.action_filters as Array<{ conditions: unknown[] }>;
    expect(filters[0]?.conditions).toEqual([
      { type: 'event_attribute', comparison: { attribute: 'exception.type', match: 'eq', value: 'DebridEgressBlockedError' }, conditionResult: true },
    ]);
  });
});

describe('scripts/sentry-alerts.mjs : erreurs', () => {
  it('detector d’erreurs introuvable : erreur claire, aucune écriture', async () => {
    detectors.set('laststream-web', [{ id: '303', type: 'metric_issue', name: 'Latence' }]);
    const result = await run([], live());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('detector');
    expect(result.stderr).toContain('laststream-web');
    expect(noToken(result)).toBe(true);
    // Le premier projet est déjà traité, le second ne reçoit aucune écriture.
    expect(recorded.filter((r) => r.method !== 'GET' && (r.body?.detector_ids as number[])[0] === 303)).toEqual([]);
  });

  it.each([401, 403])('réponse %i à l’écriture : message indiquant le scope alerts:write', async (status) => {
    failWrites = status;
    const result = await run([], live());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('alerts:write');
    expect(result.stderr).toContain(String(status));
    expect(noToken(result)).toBe(true);
  });

  it('corps d’erreur affiché pour diagnostic, jeton expurgé', async () => {
    failAll = 400;
    const result = await run([], live());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Réponse :');
    expect(result.stderr).toContain('refus pour [jeton]');
    expect(noToken(result)).toBe(true);
  });

  it('404 : indice sur l’organisation et la région', async () => {
    const result = await run([], { ...live(), SENTRY_ORG: 'inconnue' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SENTRY_API_URL');
  });
});

describe('scripts/sentry-alerts.mjs : --check', () => {
  it('lit seulement (GET) et affiche detectors et alertes existantes', async () => {
    await run([], live());
    recorded = [];
    const result = await run(['--check'], live());
    expect(result.code).toBe(0);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.method === 'GET')).toBe(true);
    expect(result.stdout).toContain('detector 101');
    expect(result.stdout).toContain('detector 202');
    for (const name of ALERT_NAMES) expect(result.stdout).toContain(`présente : ${name}`);
    expect(noToken(result)).toBe(true);
  });

  it('alertes absentes signalées', async () => {
    const result = await run(['--check'], live());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`absente  : ${ALERT_NAMES[0]}`);
    expect(recorded.every((r) => r.method === 'GET')).toBe(true);
  });

  it('403 en lecture : erreur avec le scope', async () => {
    failAll = 403;
    const result = await run(['--check'], live());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('alerts:');
    expect(noToken(result)).toBe(true);
  });

  it('sans jeton : sortie 1', async () => {
    const result = await run(['--check'], { ...CONFIG, SENTRY_API_URL: apiUrl });
    expect(result.code).toBe(1);
    expect(recorded).toEqual([]);
  });
});
