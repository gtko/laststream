// Magasin Windows (ODY-201) : pont `download-*` de la coque, simulé par un faux transport et un disque en mémoire.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetShell, type ShellTransport } from '../../src/player/shell';
import {
  createShellDownloadStore,
  getShellDownloadFolder,
  getShellDownloadPath,
  isShellDownloadStoreAvailable,
  pickShellDownloadFolder,
  shellFileId,
} from '../../src/downloads/shellStore';
import { DownloadError } from '../../src/downloads/types';

/* Rien ne sort du transport injecté : aucun chemin réel, aucune URL. Le disque suit le protocole des commandes `download-*`. */

const FOLDER = 'C:\\Users\\test\\Videos\\Laststream';
const FREE = 1_000_000;
const SILENT = Symbol('silent');

interface Sent {
  event: string;
  args: Record<string, unknown>;
}
type Handler = (event: string, args: Record<string, unknown>) => unknown;
interface Entry {
  part?: Uint8Array;
  final?: { path: string; bytes: Uint8Array };
}
type Disk = Map<string, Entry>;

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const getShellOf = (t: ShellTransport) => async () => t;

/** Faux transport WebView2 : chaque commande est enregistrée, puis jouée par `handler` ; sa réponse arrive en microtâche. */
function fakeShell(handler: Handler, kind: ShellTransport['kind'] = 'webview2') {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const sent: Sent[] = [];
  const emit = (event: string, payload: unknown): void => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  };
  const transport: ShellTransport = {
    kind,
    info: {},
    send(event, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      sent.push({ event, args: a });
      const reply = handler(event, a);
      if (reply !== SILENT) queueMicrotask(() => emit(event, reply));
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
  };
  return { transport, sent, emit, listenerCount: (event: string) => listeners.get(event)?.length ?? 0 };
}

/** Disque en mémoire : même comportement que la coque pour les méthodes `download-*`. */
function diskHandler(disk: Disk, opts: { full?: boolean } = {}): Handler {
  const sizeOf = (e: Entry | undefined): number => e?.part?.byteLength ?? e?.final?.bytes.byteLength ?? 0;
  return (event, a) => {
    const id = a.id as string;
    const e: Entry = disk.get(id) ?? {};
    switch (event) {
      case 'download-folder-get':
        return { ok: true, path: FOLDER, isDefault: true };
      case 'download-folder-pick':
        return { ok: true, path: null };
      case 'download-open':
        if (!e.final && !e.part) disk.set(id, { part: new Uint8Array(0) });
        return e.final
          ? { ok: true, size: e.final.bytes.byteLength, finalized: true }
          : { ok: true, size: sizeOf(disk.get(id)) };
      case 'download-size':
        return { ok: true, size: sizeOf(e) };
      case 'download-write': {
        if (opts.full) return { ok: false, code: 'store_full', message: `disque plein ${FOLDER}` };
        const data = Uint8Array.from(atob(String(a.data)), (c) => c.charCodeAt(0));
        const offset = a.offset as number;
        const size = sizeOf(e);
        if (offset > size) return { ok: false, code: 'bad_range' };
        const next = new Uint8Array(Math.max(size, offset + data.byteLength));
        next.set(e.part ?? new Uint8Array(0));
        next.set(data, offset);
        disk.set(id, { part: next });
        return { ok: true, size: next.byteLength };
      }
      case 'download-truncate': {
        const len = a.len as number;
        if (!e.part || len > e.part.byteLength) return { ok: false, code: 'bad_range' };
        disk.set(id, { part: e.part.slice(0, len) });
        return { ok: true, size: len };
      }
      case 'download-finalize': {
        if (!e.part) return { ok: false, code: 'not_found' };
        const path = `${FOLDER}\\${id}.mkv`;
        disk.set(id, { final: { path, bytes: e.part } });
        return { ok: true, path, size: e.part.byteLength };
      }
      case 'download-path':
        return e.final ? { ok: true, path: e.final.path } : { ok: false, code: 'not_found' };
      case 'download-remove':
        disk.delete(id);
        return { ok: true };
      case 'download-usage': {
        let used = 0;
        for (const v of disk.values()) used += sizeOf(v);
        return { ok: true, used, available: FREE };
      }
      default:
        return SILENT;
    }
  };
}

const writesOf = (sent: Sent[]) => sent.filter((s) => s.event === 'download-write');

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { chrome?: unknown }).chrome;
});

describe('magasin de la coque : fichier', () => {
  it('écrit les morceaux à leurs offsets successifs, tronque et relit la taille', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const sink = await store.open('tt1');
    await sink.write(0, bytes(1, 2, 3));
    await sink.write(3, bytes(4, 5));
    expect(await sink.size()).toBe(5);
    expect(await store.size('tt1')).toBe(5);
    await sink.truncate(3);
    expect(await store.size('tt1')).toBe(3);
    expect(writesOf(shell.sent).map((s) => s.args.offset)).toEqual([0, 3]);
  });

  it('reprise : après une coupure, sink.size() donne le point de reprise', async () => {
    const disk: Disk = new Map();
    const first = fakeShell(diskHandler(disk));
    const sink1 = await createShellDownloadStore(first.transport).open('r1');
    await sink1.write(0, bytes(1, 2, 3, 4));
    await sink1.close();

    const second = fakeShell(diskHandler(disk));
    const store2 = createShellDownloadStore(second.transport);
    const sink2 = await store2.open('r1');
    const resume = await sink2.size();
    expect(resume).toBe(4);
    await sink2.write(resume, bytes(5, 6));
    expect(await store2.size('r1')).toBe(6);
    expect(writesOf(second.sent)[0].args.offset).toBe(4);
  });

  it('offset au-delà de la taille : erreur store_failed, message sans chemin', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const sink = await createShellDownloadStore(shell.transport).open('o1');
    const err = (await sink.write(5, bytes(1)).catch((e: unknown) => e)) as DownloadError;
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('store_failed');
    expect(err.message).toBe('store_failed');
  });

  it('disque plein : store_full, sans chemin dans le message', async () => {
    const shell = fakeShell(diskHandler(new Map(), { full: true }));
    const sink = await createShellDownloadStore(shell.transport).open('f1');
    const err = (await sink.write(0, bytes(1)).catch((e: unknown) => e)) as DownloadError;
    expect(err.code).toBe('store_full');
    expect(err.message).toBe('store_full');
    expect(err.message).not.toContain('Laststream');
  });

  it('base64 exact pour un morceau de plus de 32 Kio, octets 0x00 et 0xFF compris', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const data = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 37 + 11) % 256);
    data[0] = 0x00;
    data[1] = 0xff;
    data[40_000] = 0x00;
    data[data.length - 1] = 0xff;
    const sink = await store.open('big');
    await sink.write(0, data);
    const sentData = String(writesOf(shell.sent)[0].args.data);
    expect(Uint8Array.from(atob(sentData), (c) => c.charCodeAt(0))).toEqual(data);
    expect(await sink.size()).toBe(70_000);
  });

  it('identifiants envoyés : préfixe dl-, encodage exact, seulement [a-z0-9._-]', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    await store.size('tt1:1:2');
    await store.size('tt1_1_2');
    const ids = shell.sent.map((s) => s.args.id as string);
    // Le `_` lui-même est échappé : 'tt1_1_2' ne peut pas imiter 'tt1:1:2', les deux restent distincts.
    expect(ids).toEqual(['dl-tt1_003a1_003a2', 'dl-tt1_005f1_005f2']);
    for (const id of ids) expect(id).toMatch(/^dl-[a-z0-9._-]{1,125}$/);
  });

  it('injectif et insensible à la casse : des ids distincts ne donnent jamais le même nom de fichier', () => {
    const inputs = ['Ab', 'ab', 'A', 'a', 'a:', 'a_003a', 'a_005f003a', '_0041', 'tt1:1:2', 'tt1_1_2', 'x.', 'x', '.', '..', '_'];
    const encoded = inputs.map((id) => shellFileId(id));
    expect(new Set(encoded).size).toBe(inputs.length);
    expect(new Set(encoded.map((e) => e.toLowerCase())).size).toBe(inputs.length);
    expect(shellFileId('Ab')).toBe('dl-_0041b');
    expect(shellFileId('ab')).toBe('dl-ab');
  });

  it('shellFileId ne produit que [a-z0-9._-] ; les noms réservés Windows ne sortent jamais tels quels', () => {
    const weird = ['CON', 'con', 'NUL', 'AUX', 'COM1', 'LPT9', '..', '.', 'a/b', 'a\\b', 'é€😀', 'a b', 'a*?"<>|', '\u0000x'];
    for (const id of weird) expect(shellFileId(id)).toMatch(/^dl-[a-z0-9._-]+$/);
    expect(shellFileId('con')).toBe('dl-con');
    expect(shellFileId('con')).toMatch(/^dl-[A-Za-z0-9._-]{1,125}$/);
  });

  it('identifiant dont l’encodage dépasse 128 caractères : store_failed, la coque n’est jamais appelée', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const tooLong = 'A'.repeat(26); // 26 caractères, 133 une fois encodés (préfixe dl- compris)
    const err = (await store.open(tooLong).catch((e: unknown) => e)) as DownloadError;
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('store_failed');
    expect(err.message).toBe('store_failed');
    await expect(store.size(tooLong)).rejects.toMatchObject({ code: 'store_failed' });
    await expect(store.remove(tooLong)).rejects.toMatchObject({ code: 'store_failed' });
    expect(shell.sent).toHaveLength(0);
  });

  it('identifiant de 128 caractères tout juste (encodé) : accepté', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    expect(await createShellDownloadStore(shell.transport).size('A'.repeat(25))).toBe(0);
    expect(shell.sent[0].args.id).toHaveLength(128);
  });

  it('fichier finalisé à l’ouverture : écriture et troncature refusées sans appel, finalize ne refait rien', async () => {
    const disk: Disk = new Map();
    const first = fakeShell(diskHandler(disk));
    const sink1 = await createShellDownloadStore(first.transport).open('fin1');
    await sink1.write(0, bytes(1, 2));
    await sink1.finalize();

    const second = fakeShell(diskHandler(disk));
    const sink2 = await createShellDownloadStore(second.transport).open('fin1');
    expect(second.sent.map((s) => s.event)).toEqual(['download-open']);
    await expect(sink2.write(2, bytes(3))).rejects.toMatchObject({ code: 'store_failed' });
    await expect(sink2.truncate(1)).rejects.toMatchObject({ code: 'store_failed' });
    await sink2.finalize();
    expect(second.sent.map((s) => s.event)).toEqual(['download-open']);
    expect(await sink2.size()).toBe(2);
  });

  it('une seule commande en vol : la suivante part après la réponse de la précédente', async () => {
    const disk: Disk = new Map();
    const inner = diskHandler(disk);
    let held: unknown = null;
    const shell = fakeShell((event, a) => {
      if (event === 'download-write' && held === null) {
        held = inner(event, a);
        return SILENT;
      }
      return inner(event, a);
    });
    const sink = await createShellDownloadStore(shell.transport).open('s1');
    const first = sink.write(0, bytes(1));
    const second = sink.write(1, bytes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(writesOf(shell.sent)).toHaveLength(1);
    shell.emit('download-write', held);
    await first;
    await second;
    expect(writesOf(shell.sent)).toHaveLength(2);
    expect(await sink.size()).toBe(2);
  });

  it('une réponse d’une autre méthode est ignorée tant que la bonne n’est pas arrivée', async () => {
    const inner = diskHandler(new Map());
    const holder: { emit?: (event: string, payload: unknown) => void } = {};
    const shell = fakeShell((event, a) => {
      if (event === 'download-size') holder.emit?.('download-usage', { ok: true, used: 999, available: 1 });
      return inner(event, a);
    });
    holder.emit = shell.emit;
    expect(await createShellDownloadStore(shell.transport).size('x')).toBe(0);
  });

  it('finalize mémorise le chemin : getShellDownloadPath le rend sans nouvel appel', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const sink = await store.open('t5');
    await sink.write(0, bytes(1, 2));
    await sink.finalize();
    expect(await getShellDownloadPath('t5', getShellOf(shell.transport))).toBe(`${FOLDER}\\dl-t5.mkv`);
    expect(shell.sent.some((s) => s.event === 'download-path')).toBe(false);
  });

  it('après finalize, une écriture est refusée sans appel à la coque', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const sink = await createShellDownloadStore(shell.transport).open('t6');
    await sink.write(0, bytes(1));
    await sink.finalize();
    const before = shell.sent.length;
    await expect(sink.write(1, bytes(2))).rejects.toMatchObject({ code: 'store_failed' });
    expect(shell.sent.length).toBe(before);
  });

  it('getShellDownloadPath interroge la coque quand le chemin n’est pas connu (nouvelle session)', async () => {
    const disk: Disk = new Map();
    const first = fakeShell(diskHandler(disk));
    const sink = await createShellDownloadStore(first.transport).open('t7');
    await sink.write(0, bytes(1));
    await sink.finalize();

    const second = fakeShell(diskHandler(disk));
    expect(await getShellDownloadPath('t7', getShellOf(second.transport))).toBe(`${FOLDER}\\dl-t7.mkv`);
    expect(second.sent.map((s) => s.event)).toEqual(['download-path']);
    expect(await getShellDownloadPath('absent', getShellOf(second.transport))).toBeNull();
  });

  it('remove supprime le fichier, est idempotent et oublie le chemin', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const sink = await store.open('t8');
    await sink.write(0, bytes(1, 2));
    await sink.finalize();
    await store.remove('t8');
    await store.remove('t8');
    expect(await store.size('t8')).toBe(0);
    expect(await getShellDownloadPath('t8', getShellOf(shell.transport))).toBeNull();
  });

  it('usage : octets occupés et espace libre renvoyés par la coque', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const a = await store.open('ua');
    await a.write(0, bytes(1, 2, 3));
    const b = await store.open('ub');
    await b.write(0, bytes(4, 5));
    expect(await store.usage()).toEqual({ used: 5, available: FREE });
  });

  it('délai dépassé : store_failed, puis pont coupé jusqu’à la réponse tardive', async () => {
    vi.useFakeTimers();
    const disk: Disk = new Map();
    const inner = diskHandler(disk);
    let stalled = false;
    let held: unknown = null;
    const shell = fakeShell((event, a) => {
      if (event === 'download-write' && !stalled) {
        stalled = true;
        held = inner(event, a);
        return SILENT;
      }
      return inner(event, a);
    });
    const store = createShellDownloadStore(shell.transport);
    const sink = await store.open('d1');
    const pending = expect(sink.write(0, bytes(1, 2))).rejects.toMatchObject({ code: 'store_failed' });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    const before = shell.sent.length;
    await expect(store.size('d1')).rejects.toMatchObject({ code: 'store_failed' });
    expect(shell.sent.length).toBe(before);

    shell.emit('download-write', held);
    expect(await store.size('d1')).toBe(2);
  });

  it('sans transport (hors coque) : store_failed, rien n’est touché', async () => {
    const store = createShellDownloadStore();
    await expect(store.size('n1')).rejects.toMatchObject({ code: 'store_failed' });
    await expect(getShellDownloadPath('n1')).rejects.toMatchObject({ code: 'store_failed' });
    expect(await isShellDownloadStoreAvailable()).toBe(false);
  });

  it('n’appelle jamais le pont réel de la fenêtre quand un transport est injecté', async () => {
    const postMessage = vi.fn();
    (window as unknown as { chrome?: unknown }).chrome = { webview: { postMessage, addEventListener: () => undefined } };
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    const sink = await store.open('i1');
    await sink.write(0, bytes(1));
    await store.usage();
    expect(postMessage).not.toHaveBeenCalled();
    expect(shell.sent).toHaveLength(3);
  });

  it('un seul écouteur par réponse et par transport, même avec plusieurs magasins', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    const store = createShellDownloadStore(shell.transport);
    await store.size('a');
    await createShellDownloadStore(shell.transport).size('b');
    await store.usage();
    expect(shell.listenerCount('download-size')).toBe(1);
    expect(shell.listenerCount('download-usage')).toBe(1);
  });
});

describe('dossier et disponibilité', () => {
  it('lit le dossier de téléchargement et renvoie le choix de l’utilisateur (null si annulé)', async () => {
    const shell = fakeShell(diskHandler(new Map()));
    expect(await getShellDownloadFolder(getShellOf(shell.transport))).toEqual({ path: FOLDER, isDefault: true });
    expect(await pickShellDownloadFolder(getShellOf(shell.transport))).toBeNull();
    expect(shell.sent.map((s) => s.event)).toEqual(['download-folder-get', 'download-folder-pick']);
  });

  it('disponible seulement sur WebView2 et si la coque répond à la commande', async () => {
    const qt = fakeShell(() => SILENT, 'qt');
    expect(await isShellDownloadStoreAvailable(getShellOf(qt.transport))).toBe(false);
    expect(qt.sent).toHaveLength(0);

    const ok = fakeShell(diskHandler(new Map()));
    expect(await isShellDownloadStoreAvailable(getShellOf(ok.transport))).toBe(true);
  });

  it('coque ancienne (aucune réponse) : indisponible après le délai de sonde', async () => {
    vi.useFakeTimers();
    const old = fakeShell(() => SILENT);
    const probe = isShellDownloadStoreAvailable(getShellOf(old.transport));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await probe).toBe(false);
  });

  it('sonde derrière un choix de dossier en cours : indisponible après le délai de sonde, sans attendre le choix', async () => {
    vi.useFakeTimers();
    const inner = diskHandler(new Map());
    const shell = fakeShell((event, a) => (event === 'download-folder-pick' ? SILENT : inner(event, a)));
    const getShell = getShellOf(shell.transport);
    const picked = pickShellDownloadFolder(getShell).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.sent.map((s) => s.event)).toEqual(['download-folder-pick']);
    const probe = isShellDownloadStoreAvailable(getShell);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await probe).toBe(false);
    // Le choix expire à son délai long : la file se libère, et la sonde attendue n'est jamais partie.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await picked).toMatchObject({ code: 'store_failed' });
    expect(shell.sent.map((s) => s.event)).toEqual(['download-folder-pick']);
  });

  it('branchement de la coque en erreur : erreur de stockage, jamais une erreur brute', async () => {
    const broken = async (): Promise<null> => {
      throw new Error('boom');
    };
    await expect(createShellDownloadStore(broken).size('e1')).rejects.toMatchObject({ code: 'store_failed' });
    expect(await isShellDownloadStoreAvailable(broken)).toBe(false);
  });
});

describe('pont réel de la coque (WebView2)', () => {
  it('pont réel : commande encodée par le transport, réponse reconnue par son nom', async () => {
    const inner = diskHandler(new Map());
    const listeners: Array<(ev: { data: unknown }) => void> = [];
    const deliver = (data: unknown): void => {
      for (const fn of listeners) fn({ data });
    };
    const postMessage = vi.fn((message: string) => {
      const m = JSON.parse(message) as { type: number; args?: [string, Record<string, unknown>?] };
      queueMicrotask(() => {
        if (m.type === 3) {
          deliver(JSON.stringify({ type: 3, data: { transport: { properties: [] } } }));
          return;
        }
        const [event, args] = m.args ?? [];
        deliver({ type: 1, args: [event, inner(event ?? '', args ?? {})] });
      });
    });
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: {
        postMessage,
        addEventListener: (_type: string, fn: (ev: { data: unknown }) => void) => {
          listeners.push(fn);
        },
      },
    };
    try {
      const store = createShellDownloadStore();
      expect(await store.size('real1')).toBe(0);
      expect(await store.usage()).toEqual({ used: 0, available: FREE });
      const sent = postMessage.mock.calls.map(([raw]) => JSON.parse(raw) as { id: number; type: number; args?: unknown[] });
      expect(sent[0]).toEqual({ id: 0, type: 3 });
      expect(sent[1]).toEqual({ id: 0, type: 6, args: ['download-size', { id: 'dl-real1' }] });
      expect(sent[2]).toEqual({ id: 0, type: 6, args: ['download-usage'] });
    } finally {
      resetShell();
    }
  });
});
