/**
 * Refus d'une connexion WebSocket par code de fermeture. La mise à niveau réussit, puis le serveur ferme aussitôt avec le code
 * et le motif : le navigateur les transmet à l'application (un échec HTTP n'en porte aucun). Exécution Workers seulement
 * (WebSocketPair) ; sous Node, les routes du salon répondent 501 avant d'arriver ici.
 */

interface PairServerSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
}

declare const WebSocketPair: new () => { 0: unknown; 1: PairServerSocket };

export function refusedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
}
