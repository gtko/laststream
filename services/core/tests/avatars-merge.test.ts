import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Scripts Node sans types : chargés à l'exécution (pas d'import statique, donc pas de typage à reprendre).
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'avatars');
type Merge = {
  mergeAvatarBuild(options: { buildDir: string; tsFile: string; lots?: string[]; now?: Date; log?: (message: string) => void }): Promise<{
    collections: number;
    characters: number;
    images: number;
    featured: number;
    written: boolean;
  }>;
  MergeError: new (...args: never[]) => Error & { errors: string[] };
};
const loadMerge = async (): Promise<Merge> => (await import(pathToFileURL(join(SCRIPTS, 'merge.mjs')).href)) as Merge;

const NOW = new Date('2026-10-20T12:00:00Z');
const IMAGE = Buffer.from('RIFF0000WEBPVP8 fixture');

let root: string;
let buildDir: string;
let tsFile: string;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'avatars-merge-'));
  buildDir = join(root, '.avatars-build');
  tsFile = join(root, 'src', 'user', 'avatar-collections.ts');
  mkdirSync(dirname(tsFile), { recursive: true });
  for (const lot of ['jeux', 'anime', 'series', 'libres']) mkdirSync(join(buildDir, lot), { recursive: true });
  writeFileSync(tsFile, '// fichier initial, conservé quand aucun lot n’est prêt\n');
  logs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Écrit une image de test pour un personnage. */
function image(lot: string, colId: string, charId: string): void {
  const file = join(buildDir, lot, 'i', colId, `${charId}.webp`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([IMAGE, Buffer.from(`${colId}/${charId}`)]));
}

function lol(): Record<string, unknown> {
  const names = ['ahri', 'yasuo', 'jinx', 'lux', 'garen', 'teemo', 'ezreal', 'thresh', 'kayn', 'zed'];
  return {
    id: 'lol',
    family: 'games',
    name: 'League of Legends',
    source: 'Riot Data Dragon',
    license: 'propriétaire Riot',
    free: false,
    kid: false,
    aliases: ['league of legends'],
    characters: names.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  };
}

function lorelei(): Record<string, unknown> {
  const seeds = Array.from({ length: 12 }, (_, index) => `s${String(index + 1).padStart(2, '0')}`);
  return {
    id: 'dicebear-lorelei',
    family: 'free',
    name: 'DiceBear Lorelei',
    source: 'DiceBear',
    license: 'CC BY 4.0',
    free: true,
    kid: true,
    characters: seeds.map((id) => ({ id, name: `Graine ${id}` })),
  };
}

/** Lot « jeux » avec LoL, et lot « libres » avec Lorelei ; images écrites pour chaque personnage. */
function fixtureLots(): void {
  writeFileSync(join(buildDir, 'jeux', 'collections.json'), JSON.stringify([lol()]));
  for (const character of (lol().characters as { id: string }[])) image('jeux', 'lol', character.id);
  writeFileSync(join(buildDir, 'libres', 'collections.json'), JSON.stringify([lorelei()]));
  for (const character of (lorelei().characters as { id: string }[])) image('libres', 'dicebear-lorelei', character.id);
}

describe('merge.mjs : assemblage des lots', () => {
  it('produit le catalogue, les personnages, les vignettes et le fichier généré', async () => {
    const { mergeAvatarBuild } = await loadMerge();
    fixtureLots();
    const summary = await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: (m) => logs.push(m) });
    expect(summary).toEqual({ collections: 2, characters: 22, images: 22, featured: 2, written: true });

    const out = join(buildDir, 'out');
    const catalog = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    expect(catalog.version).toBe('2026-10-20');
    expect(catalog.families.map((family: { id: string }) => family.id)).toEqual(['heroes', 'disney', 'anime', 'series', 'games', 'free']);
    expect(catalog.collections).toEqual([
      {
        id: 'lol',
        family: 'games',
        name: 'League of Legends',
        source: 'Riot Data Dragon',
        license: 'propriétaire Riot',
        free: false,
        kid: false,
        total: 10,
        aliases: ['league of legends'],
        previews: ['ahri', 'yasuo', 'jinx', 'lux', 'garen', 'teemo', 'ezreal', 'thresh'],
      },
      {
        id: 'dicebear-lorelei',
        family: 'free',
        name: 'DiceBear Lorelei',
        source: 'DiceBear',
        license: 'CC BY 4.0',
        free: true,
        kid: true,
        total: 12,
        aliases: [],
        previews: ['s01', 's02', 's03', 's04', 's05', 's06', 's07', 's08'],
      },
    ]);
    // « featured » suit l'ordre curé : LoL avant Lorelei, premier aperçu de chacune.
    expect(catalog.featured).toEqual(['col:lol:ahri', 'col:dicebear-lorelei:s01']);

    const character = JSON.parse(readFileSync(join(out, 'c', 'lol.json'), 'utf8'));
    expect(character).toEqual({ id: 'lol', characters: expect.arrayContaining([{ id: 'ahri', name: 'Ahri' }]) });
    expect(character.characters[0]).toEqual({ id: 'ahri', name: 'Ahri' });
    expect(readFileSync(join(out, 'i', 'lol', 'ahri.webp'))).toEqual(Buffer.concat([IMAGE, Buffer.from('lol/ahri')]));

    const generated = readFileSync(tsFile, 'utf8');
    expect(generated).toContain('généré par scripts/avatars/merge.mjs');
    expect(generated).toMatch(/ALL_AVATAR_COLLECTIONS[\s\S]*'dicebear-lorelei',[\s\S]*'lol',/);
    const kidSection = generated.slice(generated.indexOf('KID_AVATAR_COLLECTIONS'));
    expect(kidSection).toContain("'dicebear-lorelei',");
    expect(kidSection).not.toContain("'lol',");
  });

  it('un lot absent est signalé et ignoré ; sans aucun lot, rien n est écrit', async () => {
    const { mergeAvatarBuild } = await loadMerge();
    const summary = await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: (m) => logs.push(m) });
    expect(summary).toMatchObject({ collections: 0, written: false });
    expect(logs.some((line) => line.includes('lot absent, ignoré : jeux'))).toBe(true);
    expect(existsSync(join(buildDir, 'out'))).toBe(false);
    expect(readFileSync(tsFile, 'utf8')).toBe('// fichier initial, conservé quand aucun lot n’est prêt\n');
  });

  it('une validation qui échoue n écrit rien et liste les erreurs', async () => {
    const { mergeAvatarBuild, MergeError } = await loadMerge();
    const bad = { ...lol(), family: 'inconnue', previews: ['ahri', 'personnage-absent'] };
    writeFileSync(join(buildDir, 'jeux', 'collections.json'), JSON.stringify([bad]));
    for (const character of (lol().characters as { id: string }[])) image('jeux', 'lol', character.id);
    const error = await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: () => {} }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MergeError);
    expect((error as InstanceType<Merge['MergeError']>).errors).toEqual([
      'jeux/lol : famille inconnue (voir FAMILIES)',
      'jeux/lol : previews : identifiant absent de characters',
    ]);
    expect(existsSync(join(buildDir, 'out'))).toBe(false);
    expect(readFileSync(tsFile, 'utf8')).toContain('fichier initial');
  });

  it('une image manquante est une erreur de validation', async () => {
    const { mergeAvatarBuild, MergeError } = await loadMerge();
    fixtureLots();
    rmSync(join(buildDir, 'libres', 'i', 'dicebear-lorelei', 's05.webp'));
    const error = await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: () => {} }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MergeError);
    expect((error as InstanceType<Merge['MergeError']>).errors).toEqual(['libres/dicebear-lorelei : 1 image(s) absente(s) (ex. s05)']);
    expect(existsSync(join(buildDir, 'out'))).toBe(false);
  });

  it('un identifiant de collection mal formé ou en double est refusé', async () => {
    const { mergeAvatarBuild, MergeError } = await loadMerge();
    writeFileSync(join(buildDir, 'jeux', 'collections.json'), JSON.stringify([{ ...lol(), id: 'LoL' }]));
    const invalid = await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: () => {} }).catch((err: unknown) => err);
    expect((invalid as InstanceType<Merge['MergeError']>).errors).toEqual(['jeux : identifiant de collection invalide']);

    writeFileSync(join(buildDir, 'jeux', 'collections.json'), JSON.stringify([lol(), lol()]));
    for (const character of (lol().characters as { id: string }[])) image('jeux', 'lol', character.id);
    const duplicate = await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: () => {} }).catch((err: unknown) => err);
    expect(duplicate).toBeInstanceOf(MergeError);
    expect((duplicate as InstanceType<Merge['MergeError']>).errors[0]).toContain('identifiant déjà utilisé');
  });

  it('previews explicites conservés ; featured ignore les collections absentes', async () => {
    const { mergeAvatarBuild } = await loadMerge();
    writeFileSync(join(buildDir, 'jeux', 'collections.json'), JSON.stringify([{ ...lol(), previews: ['zed', 'kayn'] }]));
    for (const character of (lol().characters as { id: string }[])) image('jeux', 'lol', character.id);
    await mergeAvatarBuild({ buildDir, tsFile, now: NOW, log: () => {} });
    const catalog = JSON.parse(readFileSync(join(buildDir, 'out', 'catalog.json'), 'utf8'));
    expect(catalog.collections[0].previews).toEqual(['zed', 'kayn']);
    expect(catalog.featured).toEqual(['col:lol:zed']);
  });
});

describe('upload.mjs : mode --dry-run', () => {
  /** Copie du script dans une arborescence temporaire : sa racine (donc .avatars-build) est alors ce dossier. */
  function copyScript(): string {
    const script = join(root, 'scripts', 'avatars', 'upload.mjs');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(join(SCRIPTS, 'upload.mjs'), script);
    return script;
  }

  function dryRun(script: string): Promise<{ stdout: string; code: number }> {
    return new Promise((resolveRun) => {
      execFile(process.execPath, [script, '--dry-run'], (error, stdout, stderr) => {
        resolveRun({ stdout: `${stdout}${stderr}`, code: error ? (error as { code?: number }).code ?? 1 : 0 });
      });
    });
  }

  it('liste les clés du dossier out, sans rien envoyer, et saute celles déjà au journal', async () => {
    const script = copyScript();
    const out = join(root, '.avatars-build', 'out');
    mkdirSync(join(out, 'c'), { recursive: true });
    mkdirSync(join(out, 'i', 'lol'), { recursive: true });
    writeFileSync(join(out, 'catalog.json'), '{"families":[]}');
    writeFileSync(join(out, 'c', 'lol.json'), '{"id":"lol","characters":[]}');
    writeFileSync(join(out, 'i', 'lol', 'ahri.webp'), 'webp');
    writeFileSync(join(out, 'ignore.txt'), 'pas une clé prévue');

    let result = await dryRun(script);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('c/lol.json\tapplication/json\t');
    expect(result.stdout).toContain('i/lol/ahri.webp\timage/webp\t4');
    expect(result.stdout).toContain('catalog.json\tapplication/json');
    expect(result.stdout).toContain('ignoré (type non prévu) : ignore.txt');
    expect(result.stdout).toContain('dry-run : 3 clé(s)');
    expect(result.stdout).toContain('à envoyer : 3');

    const journal = Object.fromEntries(
      ['catalog.json', 'c/lol.json', 'i/lol/ahri.webp'].map((key) => {
        const size = readFileSync(join(out, ...key.split('/'))).length;
        return [key, { size, mtimeMs: statSync(join(out, ...key.split('/'))).mtimeMs }];
      }),
    );
    writeFileSync(join(root, '.avatars-build', 'uploaded.json'), JSON.stringify(journal));
    result = await dryRun(script);
    expect(result.stdout).toContain('à envoyer : 0');
  });

  it('sans sortie de merge : échec clair, sans appel réseau', async () => {
    const script = copyScript();
    const result = await dryRun(script);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("out/catalog.json introuvable : lancer d'abord node scripts/avatars/merge.mjs");
  });
});

