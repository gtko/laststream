declare module "*.css";
declare module "*/collections/focale.json" { const data: unknown; export default data; }
interface ImportMetaEnv { readonly VITE_SENTRY_DSN?: string; }
/** Version de l'application (package.json), injectée par Vite (`define`). */
declare const __APP_VERSION__: string;
/** Identité du build (sha git court + horodatage), injectée par Vite ; 'dev' hors build. Comparée à /version.json. */
declare const __BUILD_ID__: string;

/* Shaka Player (module compilé) : types minimaux, ceux qu'utilise le lecteur Molotov (src/player/molotov.ts). */
declare module "shaka-player/dist/shaka-player.compiled.js" {
  export interface ShakaRequest {
    uris: string[];
    method: string;
    headers: Record<string, string>;
    body?: ArrayBuffer | null;
  }
  export interface ShakaResponse {
    uri: string;
    originalUri: string;
    data: Uint8Array;
    headers: Record<string, string>;
  }
  export interface ShakaNetworkingEngine {
    registerRequestFilter(type: string, filter: (type: string, request: ShakaRequest) => void): void;
    registerScheme(scheme: string, handler: (uri: string, request: ShakaRequest) => Promise<ShakaResponse>, priority?: number): void;
  }
  export interface ShakaPlayer {
    configure(config: Record<string, unknown>): void;
    load(uri: string): Promise<void>;
    destroy(): Promise<void>;
    getNetworkingEngine(): ShakaNetworkingEngine;
    addEventListener(name: string, listener: (event: Event) => void): void;
  }
  export interface ShakaModule {
    polyfill: { installAll(): void };
    Player: new (mediaElement?: HTMLMediaElement | null) => ShakaPlayer;
  }
  const shaka: ShakaModule;
  export default shaka;
}
