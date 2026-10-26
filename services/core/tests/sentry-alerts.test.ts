import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** Script testé en sous-processus : jamais contre Sentry, seulement contre un faux serveur local (127.0.0.1). */
const SCRIPT = fileURLToPath(new URL('../scripts/sentry-alerts.mjs', import.meta.url));
/** Jeton fictif : il ne doit jamais apparaître dans la sortie du script. */
const TOKEN = 'token-de-test-sans-valeur-reelle-0001';
const BASES = ['Laststream : nouvelle issue', 'Laststream : pic d’événements', 'Laststream : DebridEgressBlockedError'];
const namesFor = (project: string) => BASES.map((base) => `${base} (${project})`);
const ALL_NAMES = [...namesFor('lastaddon-core'), ...namesFor('laststream-web')];

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
}

interface Workflow {
  name: string;
  body: Record<string, unknown>;
}

interface Detector {
  id: string;
  projectId: string;
  type: string;
  name: string;
}

let server: Server;
let apiUrl = '';
let recorded: Recorded[] = [];
/** Detectors par slug de projet. */
let detectors = new Map<string, Detector[]>();
/** Identifiants numériques des projets. */
const PROJECT_IDS: Record<string, string> = { 'lastaddon-core': '11', 'laststream-web': '22' };
/** Workflows stockés par identifiant ; rattachés à un projet par leurs detector_ids. */
let workflows = new Map<string, Workflow>();
let nextId = 1;
/** Statut d'échec imposé aux écritures (POST/PUT), ou à toutes les requêtes (failAll). */
let failWrites: number | null = null;
let failAll: number | null = null;
/** Le faux serveur ignore les filtres `project` et `type` (comportement observé sur le vrai Sentry). */
let ignoreFilters = false;
/** La lecture de l'identifiant du projet est refusée (jeton sans project:read). */
let projectsForbidden = false;

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

const allDetectors = () => [...detectors.values()].flat();
const detectorIdsOf = (w: Workflow) => ((w.body.detector_ids as number[]) ?? []).map(String);

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
  const projectMatch = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/$/.exec(path);
  if (projectMatch !== null) {
    const known = projectMatch[1] === 'laststream-test' && PROJECT_IDS[projectMatch[2] as string] !== undefined;
    if (!known || projectsForbidden) return reply(res, projectsForbidden ? 403 : 404, { detail: 'refus' });
    return reply(res, 200, { id: PROJECT_IDS[projectMatch[2] as string], slug: projectMatch[2] });
  }
  const match = /^\/api\/0\/organizations\/([^/]+)\/(detectors|workflows)\/(?:(\d+)\/)?$/.exec(path);
  if (match === null || match[1] !== 'laststream-test') return reply(res, 404, { detail: 'introuvable' });
  const project = url.searchParams.get('project') ?? '';
  const id = match[3];
  if (match[2] === 'detectors' && method === 'GET') {
    const type = url.searchParams.get('type');
    const pool = ignoreFilters ? allDetectors() : (detectors.get(project) ?? []);
    return reply(res, 200, pool.filter((d) => ignoreFilters || type === null || d.type === type));
  }
  if (match[2] === 'workflows') {
    if (method === 'GET' && id !== undefined) {
      const found = workflows.get(id);
      if (found === undefined) return reply(res, 404, { detail: 'introuvable' });
      return reply(res, 200, { id, name: found.name, actionFilters: found.body.action_filters });
    }
    if (method === 'GET' && id === undefined) {
      const projectDetectorIds = new Set((detectors.get(project) ?? []).map((d) => d.id));
      const list = [...workflows.entries()].filter(([, w]) => ignoreFilters || detectorIdsOf(w).some((d) => projectDetectorIds.has(d)));
      return reply(res, 200, list.map(([wid, w]) => ({ id: wid, name: w.name, enabled: true, detectorIds: detectorIdsOf(w) })));
    }
    if (body !== undefined && method === 'POST' && id === undefined) {
      const wid = String(nextId++);
      workflows.set(wid, { name: String(body.name), body });
      return reply(res, 201, { id: wid, name: body.name });
    }
    if (body !== undefined && method === 'PUT' && id !== undefined && workflows.has(id)) {
      workflows.set(id, { name: String(body.name), body });
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
  ignoreFilters = false;
  projectsForbidden = false;
  detectors = new Map([
    [
      'lastaddon-core',
      [
        { id: '100', projectId: '11', type: 'error', name: 'Error Monitor' },
        { id: '101', projectId: '11', type: 'issue_stream', name: 'Issue Stream' },
      ],
    ],
    [
      'laststream-web',
      [
        { id: '200', projectId: '22', type: 'error', name: 'Error Monitor' },
        { id: '202', projectId: '22', type: 'issue_stream', name: 'Issue Stream' },
      ],
    ],
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
const live = () => ({ ...CONFIG, SENTRY_API_URL: apiUrl, SENTRY_AUTH_TOKEN: TOKEN });
const noToken = (r: { stdout: string; stderr: string }) => !r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN);
const writes = () => recorded.filter((r) => r.method !== 'GET');

describe('scripts/sentry-alerts.mjs : --dry-run', () => {
  it('affiche les requêtes sans jamais contacter l’API (même avec un jeton)', async () => {
    const result = await run(['--dry-run'], live());
    expect(result.code).toBe(0);
    expect(recorded).toEqual([]);
    expect(result.stdout).toContain(`GET ${apiUrl}/api/0/organizations/laststream-test/detectors/?project=lastaddon-core`);
    expect(result.stdout).toContain(`POST ${apiUrl}/api/0/organizations/laststream-test/workflows/`);
    expect(result.stdout).toContain('/workflows/<id>/');
    for (const name of ALL_NAMES) expect(result.stdout).toContain(name);
    for (const token of ['first_seen_event', 'every_event', 'event_frequency_count', 'exception.type', 'DebridEgressBlockedError']) {
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
  it('première exécution : noms suffixés par projet, detector issue_stream de chaque projet, jeton en en-tête', async () => {
    const result = await run([], live());
    expect(result.code).toBe(0);
    const posts = recorded.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(6);
    expect(recorded.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(noToken(result)).toBe(true);
    for (const [project, detectorId] of [['lastaddon-core', 101], ['laststream-web', 202]] as const) {
      const mine = posts.filter((r) => (r.body?.detector_ids as number[])[0] === detectorId);
      expect(mine.map((r) => r.body?.name).sort()).toEqual(namesFor(project).sort());
      const detectorCall = recorded.find((r) => r.path.endsWith('/detectors/') && r.query.get('project') === project);
      expect(detectorCall?.query.get('type')).toBe('issue_stream');
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

  it('toutes les lectures précèdent la première écriture', async () => {
    await run([], live());
    const firstWrite = recorded.findIndex((r) => r.method !== 'GET');
    const lastRead = recorded.map((r) => r.method).lastIndexOf('GET');
    expect(firstWrite).toBeGreaterThan(-1);
    expect(lastRead).toBeLessThan(firstWrite);
  });

  it('alerte « pic d’événements » : every_event en déclencheur, seuil et fenêtre en filtre, action e-mail propriétaires', async () => {
    await run([], live());
    const spike = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('pic'));
    expect(spike?.body?.config).toEqual({ frequency: 30 });
    expect(spike?.body?.enabled).toBe(true);
    expect(spike?.body?.triggers).toEqual({
      logicType: 'any-short',
      conditions: [{ type: 'every_event', comparison: true, conditionResult: true }],
    });
    expect(spike?.body?.action_filters).toEqual([
      {
        logicType: 'all',
        conditions: [{ type: 'event_frequency_count', comparison: { value: 100, interval: '1h' }, conditionResult: true }],
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

  it('alerte DebridEgressBlockedError : chaque événement (every_event) filtré sur exception.type', async () => {
    await run([], live());
    const debrid = recorded.find((r) => r.method === 'POST' && (r.body?.name as string).includes('DebridEgressBlockedError'));
    expect(debrid?.body?.triggers).toEqual({
      logicType: 'any-short',
      conditions: [{ type: 'every_event', comparison: true, conditionResult: true }],
    });
    const filters = debrid?.body?.action_filters as Array<{ conditions: unknown[] }>;
    expect(filters[0]?.conditions).toEqual([
      { type: 'event_attribute', comparison: { attribute: 'exception.type', match: 'eq', value: 'DebridEgressBlockedError' }, conditionResult: true },
    ]);
  });
});

describe('scripts/sentry-alerts.mjs : filtres de l’API ignorés', () => {
  it('le serveur renvoie tout : le detector et les alertes de l’autre projet ne sont pas touchés', async () => {
    // Alertes de l’autre projet portant le même nom de base : elles ne doivent jamais être modifiées.
    workflows.set('900', { name: namesFor('lastaddon-core')[0] as string, body: { name: 'x', detector_ids: [101] } });
    workflows.set('901', { name: namesFor('laststream-web')[0] as string, body: { name: 'y', detector_ids: [202] } });
    workflows.set('902', { name: 'Autre projet', body: { name: 'z', detector_ids: [999] } });
    nextId = 1000;
    ignoreFilters = true;
    const result = await run([], live());
    expect(result.code).toBe(0);
    const puts = recorded.filter((r) => r.method === 'PUT').map((r) => r.path);
    expect(puts.sort()).toEqual(['/api/0/organizations/laststream-test/workflows/900/', '/api/0/organizations/laststream-test/workflows/901/']);
    expect(workflows.get('902')?.body.detector_ids).toEqual([999]);
    // Chaque création vise le detector de son propre projet.
    for (const post of recorded.filter((r) => r.method === 'POST')) {
      const name = post.body?.name as string;
      const expected = name.endsWith('(lastaddon-core)') ? 101 : 202;
      expect((post.body?.detector_ids as number[])[0]).toBe(expected);
    }
    expect(recorded.filter((r) => r.method === 'POST')).toHaveLength(4);
  });

  it('serveur sans filtre et identifiant de projet illisible : detector ambigu, abandon avant toute écriture', async () => {
    ignoreFilters = true;
    projectsForbidden = true;
    const result = await run([], live());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Plusieurs detectors');
    expect(writes()).toEqual([]);
  });

  it('--check ne compte que les detectors issue_stream du projet', async () => {
    ignoreFilters = true;
    const result = await run(['--check'], live());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('lastaddon-core : 1 detector(s) issue_stream');
    expect(result.stdout).toContain('detector 101');
    expect(result.stdout).not.toContain('detector 100');
    expect(result.stdout.split('laststream-web : ')[0]).not.toContain('detector 202');
  });
});

describe('scripts/sentry-alerts.mjs : doublon DebridEgressBlockedError', () => {
  const coveringFilters = [
    {
      logicType: 'all',
      conditions: [{ type: 'event_attribute', comparison: { attribute: 'exception.type', match: 'eq', value: 'DebridEgressBlockedError' } }],
      actions: [],
    },
  ];

  it('alerte du même detector qui filtre déjà ce type : la nôtre n’est pas créée, « couverte par » indiqué', async () => {
    workflows.set('900', {
      name: 'ODY-227 : appel serveur vers AllDebrid / débrideur bloqué',
      body: { name: 'ODY-227', detector_ids: [101], action_filters: coveringFilters },
    });
    nextId = 1000;
    const result = await run([], live());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('couverte par « ODY-227 : appel serveur vers AllDebrid / débrideur bloqué »');
    expect(recorded.find((r) => r.method === 'GET' && r.path.endsWith('/workflows/900/'))).toBeDefined();
    const posts = recorded.filter((r) => r.method === 'POST').map((r) => r.body?.name);
    // serveur : 2 créations ; web (sans alerte existante) : 3.
    expect(posts).toHaveLength(5);
    expect(posts).not.toContain(namesFor('lastaddon-core')[2]);
    expect(posts).toContain(namesFor('laststream-web')[2]);
  });

  it('couverture sur un autre detector : ignorée (même si le serveur renvoie tout)', async () => {
    ignoreFilters = true;
    workflows.set('900', { name: 'ODY-227 autre projet', body: { name: 'a', detector_ids: [202], action_filters: coveringFilters } });
    nextId = 1000;
    const result = await run([], live());
    expect(result.code).toBe(0);
    // couvre le web (detector 202) mais pas le serveur (101)
    expect(result.stdout).toContain(`couverte par « ODY-227 autre projet » : laststream-web`);
    const posts = recorded.filter((r) => r.method === 'POST').map((r) => r.body?.name);
    expect(posts).toContain(namesFor('lastaddon-core')[2]);
    expect(posts).not.toContain(namesFor('laststream-web')[2]);
  });

  it('alerte existante sans ce filtre : la nôtre est créée', async () => {
    workflows.set('900', {
      name: 'Autre alerte',
      body: { name: 'Autre alerte', detector_ids: [101], action_filters: [{ logicType: 'all', conditions: [], actions: [] }] },
    });
    nextId = 1000;
    const result = await run([], live());
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('couverte par');
    expect(recorded.filter((r) => r.method === 'POST')).toHaveLength(6);
  });

  it('notre propre alerte déjà présente est mise à jour, même si elle filtre ce type', async () => {
    await run([], live());
    recorded = [];
    const result = await run([], live());
    expect(result.stdout).not.toContain('couverte par');
    expect(recorded.filter((r) => r.method === 'PUT')).toHaveLength(6);
  });
});

describe('scripts/sentry-alerts.mjs : erreurs', () => {
  it('detector issue_stream introuvable : erreur claire, aucune écriture même pour l’autre projet', async () => {
    detectors.set('laststream-web', [{ id: '303', projectId: '22', type: 'error', name: 'Error Monitor' }]);
    const result = await run([], live());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('detector');
    expect(result.stderr).toContain('laststream-web');
    expect(noToken(result)).toBe(true);
    expect(writes()).toEqual([]);
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
    for (const name of ALL_NAMES) expect(result.stdout).toContain(`présente : ${name}`);
    expect(noToken(result)).toBe(true);
  });

  it('alertes absentes signalées', async () => {
    const result = await run(['--check'], live());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`absente  : ${ALL_NAMES[0]}`);
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
