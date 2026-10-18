import { spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs: number;
  /** Octets maximaux lus sur stdout ; au-delà, le processus est tué. */
  maxStdout?: number;
  /** Données écrites sur stdin. */
  stdin?: Uint8Array;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  /** Fin de stderr (au plus 256 Ko). */
  stderr: string;
  /** Vrai si le processus a été tué (délai dépassé ou sortie trop grande). */
  killed: boolean;
}

const STDERR_TAIL = 256 * 1024;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/** Lance un processus sans shell, le tue au délai ou au plafond de sortie. N'écrit rien dans les journaux. */
export function runProcess(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    let killed = false;
    let settled = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(kill, options.timeoutMs);
    const maxStdout = options.maxStdout ?? NO_LIMIT;
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxStdout) {
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('latin1');
      if (stderr.length > STDERR_TAIL * 2) stderr = stderr.slice(-STDERR_TAIL);
    });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.slice(-STDERR_TAIL), killed });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => undefined);
    if (options.stdin !== undefined) child.stdin.end(Buffer.from(options.stdin.buffer, options.stdin.byteOffset, options.stdin.byteLength));
    else child.stdin.end();
  });
}
