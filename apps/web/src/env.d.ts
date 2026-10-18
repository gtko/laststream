declare module "*.css";
declare module "*/collections/focale.json" { const data: unknown; export default data; }
interface ImportMetaEnv { readonly VITE_SENTRY_DSN?: string; }
/** Version de l'application (package.json), injectée par Vite (`define`). */
declare const __APP_VERSION__: string;
