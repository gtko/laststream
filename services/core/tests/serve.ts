import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { App } from '../src/http/app-env.js';

/**
 * Sert une application Hono sur un vrai port (http.Server), comme le fait src/server.ts. Remplace `app.listen`
 * d'Express : l'appelant garde le Server (`once('listening')`, `address()`, `close()`).
 */
export function serveApp(app: App, port = 0, hostname?: string): Server {
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  server.listen(port, hostname);
  return server;
}
