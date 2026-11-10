// Site statique (Workers Assets). www.laststream.app -> 301 vers la racine, avant tout autre traitement.
// Routes dynamiques : /api/android et /api/windows -> latest.json de l'app (même origine, pas de CORS).
const ROOT = 'https://laststream.app';
const BASE = 'https://app.laststream.app/app/';
const PLATFORMS = { '/api/android': 'android', '/api/windows': 'windows' };
// APK Android : publié sur chaque release GitHub du dépôt (workflow Release), plus sur app.laststream.app.
const GITHUB_RELEASES = 'https://github.com/gtko/laststream/releases/download/';

/** Adresse de téléchargement admise pour la plateforme : app.laststream.app, ou release GitHub pour l'APK Android. */
export function allowedUrl(platform, url) {
  if (typeof url !== 'string' || url.includes('..')) return false;
  if (url.startsWith(BASE + platform + '/')) return true;
  return platform === 'android' && url.startsWith(GITHUB_RELEASES) && url.endsWith('.apk');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.laststream.app') {
      return new Response(null, { status: 301, headers: { Location: ROOT + url.pathname + url.search } });
    }
    const platform = PLATFORMS[url.pathname];
    if (platform) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
      try {
        const r = await env.APP.fetch(BASE + platform + '/latest.json');
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        const out = { versionName: j.versionName, size: j.size, url: j.url, sha256: j.sha256, notes: j.notes };
        if (!allowedUrl(platform, out.url)) throw new Error('url');
        return Response.json(out, { headers: { 'cache-control': 'public, max-age=300' } });
      } catch {
        return Response.json({ error: 'unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
