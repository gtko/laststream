export interface RunResult { status: number | null; stdout: string; stderr: string }
export type GitRunner = (args: string[], cwd: string) => RunResult;
export interface GitState {
  dirty: string[]; branch?: string; head?: string; upstream?: string; tag?: string; tagOnRemote?: boolean; errors: string[];
}
export interface LockHolder {
  host?: string; pid?: number; startedAt?: string; expiresAt?: string; sha?: string; tag?: string; token?: string; invalid?: boolean;
}
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface ProcLike {
  on(event: string, handler: (signal: string) => void): unknown;
  off(event: string, handler: (signal: string) => void): unknown;
  exit(code: number): never | void;
}
export const TAG_PATTERN: RegExp;
export const LOCK_TTL_SECONDS: number;
export function parseReleaseTag(text: unknown): { tag: string; major: number; minor: number; patch: number } | null;
export function parseVersionArg(text: unknown): string | null;
export function compareTags(a: string, b: string): number;
export function latestTag(tags: string[]): string | undefined;
export function evaluateGuard(state: GitState, rules: { branch: string; requireTag: boolean }): string[];
export function collectGitState(run: GitRunner, cwd: string, rules: { branch: string; requireTag: boolean }): GitState;
export function formatLockValue(value: { host: string; pid: number; now: number; sha?: string; tag?: string; ttlSeconds?: number; token: string }): string;
export function parseLockValue(raw: string | null | undefined): LockHolder | null;
export function decideLock(raw: string | null, now: number, forceUnlock?: boolean): { acquire: boolean; holder?: LockHolder; overridden?: LockHolder; expired?: LockHolder };
export function describeHolder(holder: LockHolder): string;
export class LockError extends Error {}
export function withDeployLock<T>(
  options: { kv: KvLike; key: string; owner: { host: string; pid: number; sha?: string; tag?: string }; now?: () => number; forceUnlock?: boolean; log?: (line: string) => void; proc?: ProcLike },
  task: () => Promise<T> | T,
): Promise<T>;
export function shellQuote(arg: string): string;
export function wranglerKv(options: { binding: string; run: (args: string[]) => RunResult; tempFile: (content: string) => string }): KvLike;
export function runDeploy(
  cfg: { name: string; branch: string; lockKey: string },
  options: { dryRun: boolean; forceUnlock: boolean },
  deps: {
    git: GitRunner; cwd: string; kv: KvLike; uiRepo?: string;
    deploy: (info: { tag: string; sha: string; uiSha?: string }) => Promise<number> | number;
    log: (line: string) => void; error: (line: string) => void; now?: () => number; proc?: ProcLike; owner: { host: string; pid: number };
  },
): Promise<number>;
export function releaseNotes(input: { tag: string; previous?: string; subjects: string[] }): string;
export function planRelease(run: GitRunner, cwd: string, options: { branch: string; versionArg?: string }): { problems: string[]; tag?: string; previous?: string; sha?: string; notes?: string };
export function realGit(args: string[], cwd: string): RunResult;
export function realWrangler(wranglerSpec: string, args: string[], cwd: string, options?: { inherit?: boolean }): RunResult;
export function realKv(options: { binding: string; wranglerSpec: string; cwd: string }): KvLike & { cleanup(): void };
