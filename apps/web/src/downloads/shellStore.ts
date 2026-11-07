/* Magasin Windows (ODY-201) : chaque fichier vit dans le dossier de téléchargement de la coque (laststream-shell-ng), qui fait
 * toute l'E/S. Le JS ne fournit jamais de chemin : la coque le construit à partir de l'identifiant (commandes `download-*`).
 * Erreurs (le message ne porte que le code de la coque, jamais de chemin) : `store_full` → 'store_full', `io` → 'store_denied',
 * `no_folder` → 'store_folder', délai ou pont muet → 'store_timeout', le reste → 'store_failed'.
 *
 * Corrélation : la réponse porte le nom de la méthode, sans identifiant de requête. Une seule commande est donc en vol à la fois
 * (file), et seule la réponse de la commande en attente est acceptée. Un délai dépassé laisse une réponse « orpheline » attendue :
 * une commande d'une AUTRE méthode part quand même (sa réponse ne peut pas être confondue), mais une commande de la même méthode
 * attend que la réponse tardive soit arrivée (sinon elle lui serait attribuée), au plus `ORPHAN_WAIT_MS`. Ainsi « Réessayer » ne
 * reste jamais bloqué par un pont coupé. */
import { connectShell, isShellEnvironment, type ShellTransport } from '../player/shell';
import { DownloadError, type DownloadErrorCode, type DownloadSink, type DownloadStore } from './types';

type GetShell = () => Promise<ShellTransport | null>;
/** Transport injecté (tests) ou fabrique du transport (défaut : pont réel de la coque, s'il existe). */
type ShellSource = ShellTransport | GetShell;

type Reply = Record<string, unknown>;

const CALL_TIMEOUT_MS = 30_000;
/** Opérations longues : écrire 8 Mio sous un antivirus, supprimer ou finaliser (`sync_data` d'un fichier de plusieurs Go). */
const METHOD_TIMEOUT_MS: Record<string, number> = {
  'download-write': 120_000,
  'download-remove': 120_000,
  'download-finalize': 15 * 60_000,
};
/** Attente maximale de la réponse tardive d'une commande coupée par un délai, avant de renoncer à une commande de même méthode. */
const ORPHAN_WAIT_MS = 60_000;
/** Le choix d'un dossier attend l'utilisateur : délai long. */
const PICK_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2_500;
/** Octets par tranche de `String.fromCharCode` (un spread sur 8 Mo dépasserait la pile). */
const BASE64_STEP = 0x8000;

const REPLIES = [
  'download-folder-get',
  'download-folder-pick',
  'download-open',
  'download-write',
  'download-truncate',
  'download-size',
  'download-finalize',
  'download-path',
  'download-remove',
  'download-usage',
] as const;

interface Pending {
  method: string;
  resolve(payload: unknown): void;
}

interface Bridge {
  pending: Pending | null;
  /** Commandes coupées par un délai, par méthode : leurs réponses tardives sont encore attendues (et ignorées). */
  orphans: Map<string, number>;
  /** Commandes de même méthode qu'une orpheline : réveillées à chaque réponse tardive reçue. */
  waiters: Set<() => void>;
  /** Chemins finalisés pendant cette connexion (identifiant → chemin renvoyé par `download-finalize`). */
  paths: Map<string, string>;
  queue: Promise<unknown>;
}

/** Un seul jeu d'écouteurs et d'état par transport : `on` ne se désabonne pas. */
const bridges = new WeakMap<ShellTransport, Bridge>();

function onReply(b: Bridge, name: string, payload: unknown): void {
  const p = b.pending;
  if (p && p.method === name) {
    b.pending = null;
    p.resolve(payload);
    return;
  }
  const late = b.orphans.get(name) ?? 0;
  if (late > 0) {
    if (late === 1) b.orphans.delete(name);
    else b.orphans.set(name, late - 1);
    for (const wake of [...b.waiters]) wake();
  }
}

function bridgeOf(t: ShellTransport): Bridge {
  const known = bridges.get(t);
  if (known) return known;
  const b: Bridge = { pending: null, orphans: new Map(), waiters: new Set(), paths: new Map(), queue: Promise.resolve() };
  for (const name of REPLIES) t.on(name, (payload) => onReply(b, name, payload));
  bridges.set(t, b);
  return b;
}

const timeoutError = (cause: string): DownloadError => new DownloadError('store_timeout', false, cause);

/** Attend (au plus `ORPHAN_WAIT_MS`) que plus aucune réponse tardive de `method` ne soit attendue ; faux si elle ne vient pas. */
function orphansCleared(b: Bridge, method: string): Promise<boolean> {
  if (!b.orphans.has(method)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      b.waiters.delete(check);
      resolve(ok);
    };
    const check = (): void => {
      if (!b.orphans.has(method)) done(true);
    };
    const timer = setTimeout(() => done(false), ORPHAN_WAIT_MS);
    b.waiters.add(check);
  });
}

/** Une commande, après les précédentes. Résout la réponse brute de la coque (`{ok, ...}`). */
function call(
  t: ShellTransport,
  method: string,
  params?: object,
  timeoutMs = METHOD_TIMEOUT_MS[method] ?? CALL_TIMEOUT_MS,
): Promise<unknown> {
  const b = bridgeOf(t);
  const run = async (): Promise<unknown> => {
    if (!(await orphansCleared(b, method))) throw timeoutError('orphan');
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = {
        method,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      };
      const timer = setTimeout(() => {
        if (b.pending !== pending) return;
        b.pending = null;
        b.orphans.set(method, (b.orphans.get(method) ?? 0) + 1);
        reject(timeoutError('timeout'));
      }, timeoutMs);
      b.pending = pending;
      try {
        t.send(method, params);
      } catch {
        clearTimeout(timer);
        b.pending = null;
        reject(new DownloadError('store_failed', false));
      }
    });
  };
  const result = b.queue.then(run);
  b.queue = result.catch(() => undefined);
  return result;
}

const codeOf = (raw: unknown): string | undefined => {
  const c = (raw as Reply | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

/** Code de la coque → code du gestionnaire : ce que l'utilisateur peut corriger garde sa propre cause. */
const SHELL_CODES: Record<string, DownloadErrorCode> = { store_full: 'store_full', io: 'store_denied', no_folder: 'store_folder' };

/** Erreur de stockage pour une réponse `{ok: false}` : seul le code est gardé (jamais de message, donc jamais de chemin). */
function failure(raw: unknown): DownloadError {
  const code = codeOf(raw);
  return new DownloadError((code !== undefined && SHELL_CODES[code]) || 'store_failed', false, code);
}

/** Réponse `{ok: true, ...}`, sinon erreur de stockage. */
function expectOk(raw: unknown): Reply {
  const r = (raw ?? null) as Reply | null;
  if (r && typeof r === 'object' && r.ok === true) return r;
  throw failure(raw);
}

/** Entier positif (ou nul) d'un champ de réponse, sinon erreur de stockage. */
function numberField(r: Reply, key: string): number {
  const v = r[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new DownloadError('store_failed', false);
  return v;
}

const sizeOf = (raw: unknown): number => numberField(expectOk(raw), 'size');

/** Longueur maximale d'un identifiant de fichier encodé, préfixe `dl-` compris (contrainte de la coque). */
const MAX_FILE_ID = 128;

/**
 * Identifiant accepté par la coque : `dl-` suivi de `[a-z0-9._-]`, devenu un nom de fichier NTFS (insensible à la casse). Le préfixe
 * `dl-` rend les noms réservés (`con`, `nul`…) et `.`/`..` impossibles, et la coque ne touche que ses propres fichiers dans le dossier
 * choisi par l'utilisateur. Seuls `[a-z0-9.-]` restent tels quels ; toute autre unité de code (majuscules, `:` de `tt1:1:2`, `_`)
 * devient `_` suivi de quatre chiffres hexa, donc l'encodage est injectif même sans distinguer la casse.
 * Au-delà de 128 caractères encodés : erreur de stockage (`store_failed`), la coque n'est pas appelée.
 */
export function shellFileId(id: string): string {
  const fid = `dl-${id.replace(/[^a-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
  if (fid.length > MAX_FILE_ID) throw new DownloadError('store_failed', false);
  return fid;
}

/** Base64 d'un morceau, par tranches. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_STEP) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_STEP));
  return btoa(binary);
}

/** `p`, ou `fallback` si `ms` s'écoule d'abord (l'attente dans la file compte). */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Fabrique par défaut : le pont réel de la coque WebView2 ; hors coque, null (rien n'est tenté). */
const defaultShell: GetShell = () => (isShellEnvironment() ? connectShell() : Promise.resolve(null));

/** Transport WebView2 prêt, sinon erreur de stockage (Qt et hors coque ne portent pas ces commandes). */
async function webviewOf(getShell: GetShell): Promise<ShellTransport> {
  let t: ShellTransport | null;
  try {
    t = await getShell();
  } catch {
    throw new DownloadError('store_failed', false);
  }
  if (!t || t.kind !== 'webview2') throw new DownloadError('store_failed', false);
  return t;
}

export function createShellDownloadStore(source: ShellSource = defaultShell): DownloadStore {
  const getShell: GetShell = typeof source === 'function' ? source : async () => source;
  const ready = (): Promise<ShellTransport> => webviewOf(getShell);

  const sinkFor = (t: ShellTransport, id: string, finalized: boolean): DownloadSink => {
    // Après finalisation (connue à l'ouverture ou faite ici), le fichier n'accepte plus d'écriture.
    let done = finalized;
    const writable = (): void => {
      if (done) throw new DownloadError('store_failed', false);
    };
    return {
      size: async () => sizeOf(await call(t, 'download-size', { id: shellFileId(id) })),
      async write(offset, chunk) {
        writable();
        expectOk(await call(t, 'download-write', { id: shellFileId(id), offset, data: toBase64(chunk) }));
      },
      async truncate(len) {
        writable();
        expectOk(await call(t, 'download-truncate', { id: shellFileId(id), len }));
      },
      async finalize() {
        if (done) return;
        const r = expectOk(await call(t, 'download-finalize', { id: shellFileId(id) }));
        done = true;
        if (typeof r.path === 'string') bridgeOf(t).paths.set(id, r.path);
      },
      // Rien à libérer côté JS : la coque ouvre et ferme le fichier à chaque commande.
      close: async () => undefined,
    };
  };

  return {
    async open(id) {
      const t = await ready();
      const r = expectOk(await call(t, 'download-open', { id: shellFileId(id) }));
      return sinkFor(t, id, r.finalized === true);
    },
    async size(id) {
      return sizeOf(await call(await ready(), 'download-size', { id: shellFileId(id) }));
    },
    async remove(id) {
      const t = await ready();
      expectOk(await call(t, 'download-remove', { id: shellFileId(id) }));
      bridgeOf(t).paths.delete(id);
    },
    async usage() {
      const r = expectOk(await call(await ready(), 'download-usage'));
      return { used: numberField(r, 'used'), available: typeof r.available === 'number' ? r.available : undefined };
    },
  };
}

/** Chemin du fichier finalisé (pour `loadfile` de mpv) ; null si la coque ne le connaît pas. Mémorisé à la finalisation. */
export async function getShellDownloadPath(id: string, getShell: GetShell = defaultShell): Promise<string | null> {
  const t = await webviewOf(getShell);
  const known = bridgeOf(t).paths.get(id);
  if (known !== undefined) return known;
  const raw = await call(t, 'download-path', { id: shellFileId(id) });
  if (codeOf(raw) === 'not_found') return null;
  const path = expectOk(raw).path;
  if (typeof path !== 'string') throw new DownloadError('store_failed', false);
  return path;
}

/** Dossier de téléchargement de la coque (créé au besoin) et indique s'il s'agit du dossier par défaut. */
export async function getShellDownloadFolder(getShell: GetShell = defaultShell): Promise<{ path: string; isDefault: boolean }> {
  const r = expectOk(await call(await webviewOf(getShell), 'download-folder-get'));
  if (typeof r.path !== 'string') throw new DownloadError('store_failed', false);
  return { path: r.path, isDefault: r.isDefault === true };
}

/**
 * Choix d'un dossier par l'utilisateur (persisté par la coque) ; null s'il annule.
 * L'appel gèle la file de commandes du pont pendant le dialogue (délai : 10 min) : toute autre opération du magasin attend.
 * L'UI doit refuser ce choix tant que des téléchargements sont actifs ou en pause : changer de dossier orpheline les `.part`.
 */
export async function pickShellDownloadFolder(getShell: GetShell = defaultShell): Promise<string | null> {
  const r = expectOk(await call(await webviewOf(getShell), 'download-folder-pick', undefined, PICK_TIMEOUT_MS));
  return typeof r.path === 'string' ? r.path : null;
}

/** Vrai seulement sur WebView2 et si la coque répond à `download-folder-get` (une coque ancienne ne répond pas : faux).
 * Le délai de sonde couvre aussi l'attente dans la file : un choix de dossier en cours ne doit pas retarder la réponse. */
export async function isShellDownloadStoreAvailable(getShell: GetShell = defaultShell): Promise<boolean> {
  let t: ShellTransport | null;
  try {
    t = await getShell();
  } catch {
    return false;
  }
  if (!t || t.kind !== 'webview2') return false;
  const answered = call(t, 'download-folder-get', undefined, PROBE_TIMEOUT_MS).then(
    (raw) => (raw as Reply | null)?.ok === true,
    () => false,
  );
  return withDeadline(answered, PROBE_TIMEOUT_MS, false);
}
