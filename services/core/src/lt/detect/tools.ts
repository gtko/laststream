import { type EnvLike, runtimeEnv } from '../../platform/index.js';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { projectRoot } from '../../user/db.js';
import { runProcess } from './proc.js';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  /** Vrai si ffmpeg a le muxer chromaprint (empreinte native) ; sinon empreinte spectrale interne. */
  chromaprint: boolean;
  /** D'où viennent les binaires : variable d'environnement, PATH ou dossier de l'application. */
  origin: 'env' | 'path' | 'bundled';
}

const EXE = process.platform === 'win32' ? '.exe' : '';

async function works(binary: string): Promise<boolean> {
  const result = await runProcess(binary, ['-version'], { timeoutMs: 8000, maxStdout: 64 * 1024 });
  return result.code === 0;
}

async function hasChromaprint(ffmpeg: string): Promise<boolean> {
  const result = await runProcess(ffmpeg, ['-hide_banner', '-muxers'], { timeoutMs: 8000, maxStdout: 256 * 1024 });
  return result.code === 0 && /\bchromaprint\b/.test(result.stdout.toString('latin1'));
}

/** Premier fichier existant du nom donné dans une liste de dossiers. */
function findIn(directories: readonly string[], name: string): string | undefined {
  for (const directory of directories) {
    const candidate = join(directory, name + EXE);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Localise ffmpeg et ffprobe : LASTADDON_FFMPEG / LASTADDON_FFPROBE, puis le PATH, puis le dossier de l'application
 * (bin/ à la racine, ou à côté). Retourne undefined si aucun couple n'est utilisable.
 */
export async function locateTools(env: EnvLike = runtimeEnv().all()): Promise<MediaTools | undefined> {
  const root = projectRoot();
  const bundledDirs = [join(root, 'bin'), root, join(root, '..')];
  const pathDirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((entry) => entry !== '');
  const attempts: { ffmpeg: string | undefined; ffprobe: string | undefined; origin: MediaTools['origin'] }[] = [
    { ffmpeg: env.LASTADDON_FFMPEG?.trim() || undefined, ffprobe: env.LASTADDON_FFPROBE?.trim() || undefined, origin: 'env' },
    { ffmpeg: findIn(pathDirs, 'ffmpeg'), ffprobe: findIn(pathDirs, 'ffprobe'), origin: 'path' },
    { ffmpeg: findIn(bundledDirs, 'ffmpeg'), ffprobe: findIn(bundledDirs, 'ffprobe'), origin: 'bundled' },
  ];
  for (const { ffmpeg, ffprobe, origin } of attempts) {
    if (ffmpeg === undefined) continue;
    // ffprobe voisin de ffmpeg à défaut de variable dédiée.
    const probe = ffprobe ?? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext: string | undefined) => `ffprobe${ext ?? ''}`);
    if (!(await works(ffmpeg)) || !(await works(probe))) continue;
    return { ffmpeg, ffprobe: probe, chromaprint: await hasChromaprint(ffmpeg), origin };
  }
  return undefined;
}
