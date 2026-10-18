import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Ctx } from '../http/app-env.js';
import type { MaintenanceSetting } from '../user/app-settings.js';

/** Durée de conservation en mémoire de l'état de maintenance (une requête sur ~5 s lit le Durable Object, pas chacune). */
export const MAINTENANCE_CACHE_MS = 5_000;
const OFF: MaintenanceSetting = { enabled: false, message: '' };

/** État de maintenance lu à travers un petit cache : l'écriture locale l'invalide tout de suite, les autres instances sous 5 s. */
export interface MaintenanceGate {
  current(): Promise<MaintenanceSetting>;
  /** Remplace l'état connu (après un changement des réglages). */
  set(next: MaintenanceSetting): void;
}

export function createMaintenanceGate(read: () => Promise<MaintenanceSetting>, now: () => number = Date.now): MaintenanceGate {
  let cached: { value: MaintenanceSetting; at: number } | undefined;
  return {
    async current() {
      if (cached !== undefined && now() - cached.at < MAINTENANCE_CACHE_MS) return cached.value;
      try {
        cached = { value: await read(), at: now() };
      } catch {
        // Lecture impossible : le service reste ouvert (ne jamais bloquer tout le monde sur une panne de lecture).
        cached = { value: cached?.value ?? OFF, at: now() };
      }
      return cached.value;
    },
    set(next) {
      cached = { value: next, at: now() };
    },
  };
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DEFAULT_MESSAGE = 'Le service est en maintenance. Merci de réessayer dans quelques instants.';

/** Réponse 503 de maintenance : page HTML pour un navigateur, JSON sinon. */
export function maintenanceResponse(c: Ctx, state: MaintenanceSetting): Response {
  const message = state.message === '' ? DEFAULT_MESSAGE : state.message;
  const headers = { 'Retry-After': '300', 'Cache-Control': 'no-store' };
  const accept = c.req.header('accept') ?? '';
  const htmlFirst = accept.includes('text/html') && !accept.startsWith('application/json');
  if (!htmlFirst) {
    return c.body(JSON.stringify({ error: 'maintenance', message }), 503, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  }
  const page = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.4rem}</style></head>
<body><main><h1>Maintenance en cours</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return c.body(page, 503, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
}

/** Chemins qui répondent même en maintenance : administration, sonde de santé, connexion (le propriétaire doit pouvoir entrer). */
function exempt(c: Ctx): boolean {
  const path = c.req.path;
  if (path === '/admin' || path.startsWith('/admin/')) return true;
  if (path === '/health') return true;
  // Écran d'inscription : doit pouvoir annoncer la maintenance au lieu d'échouer.
  if (c.req.method === 'GET' && (path === '/user/signup-info' || path === '/user/signup-info/')) return true;
  return c.req.method === 'POST' && (path === '/user/login' || path === '/user/login/');
}

/** Mode maintenance : tout répond 503 (JSON ou page) sauf /admin, /health et la connexion (refusée ensuite aux non-propriétaires). */
export function maintenanceMiddleware(gate: MaintenanceGate): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (exempt(c)) {
      await next();
      return;
    }
    const state = await gate.current();
    if (state.enabled) return maintenanceResponse(c, state);
    await next();
  };
}
