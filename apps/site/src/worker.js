// Site statique (Workers Assets). Seule route dynamique : /api/android -> latest.json de l'app (même origine, pas de CORS).
const UPSTREAM = 'https://laststream.gtux-prog.workers.dev/app/android/latest.json';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/android') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
      try {
        const r = await fetch(UPSTREAM, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        const out = { versionName: j.versionName, size: j.size, url: j.url, sha256: j.sha256, notes: j.notes };
        if (typeof out.url !== 'string' || !out.url.startsWith('https://laststream.gtux-prog.workers.dev/app/android/')) throw new Error('url');
        return Response.json(out, { headers: { 'cache-control': 'public, max-age=300' } });
      } catch {
        return Response.json({ error: 'unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
