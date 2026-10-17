/*
 * Vérification live du catalogue TV contre les sources réelles (Free-TV, iptv-org, Pluto TV, Samsung TV Plus, EPG).
 * Aucune clé requise. Usage : npm run tv:live
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { encodeConfig } from '../src/config/codec.js';

interface Stats {
  counts: Record<string, number>;
  reliability: Record<string, number>;
  total: number;
  epgCoverage: number;
  epgStats: { url: string; ok: boolean; programmes: number }[];
}

interface Facets {
  countries: { code: string; name: string; count: number }[];
}

interface Channel {
  id: string;
  country: string;
}

const SECRET = 'tv-live-check-secret-with-more-than-32-chars';
const app = createApp({ secret: SECRET, allowPlain: false });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}/${encodeConfig({ services: {} }, SECRET)}/lt/tv`;

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) throw new Error(`${path} : statut ${res.status}`);
  return (await res.json()) as T;
};

try {
  const stats = await getJson<Stats>('stats');
  const facets = await getJson<Facets>('facets');
  const fr = facets.countries.find((c) => c.code === 'FR')?.count ?? 0;
  // Couverture EPG des chaînes françaises : une chaîne est couverte si l'API EPG renvoie un programme pour elle.
  const french = (await getJson<Channel[]>('channels')).filter((c) => c.country === 'FR').map((c) => c.id);
  const now = Math.floor(Date.now() / 1000);
  const covered = new Set<string>();
  for (let i = 0; i < french.length; i += 60) {
    const ids = french.slice(i, i + 60).map((id) => encodeURIComponent(id)).join(',');
    const programmes = await getJson<{ channelId: string }[]>(`epg?ids=${ids}&from=${now - 3600}&to=${now + 7 * 3600}`);
    for (const programme of programmes) covered.add(programme.channelId);
  }
  const frCoverage = french.length ? Math.round((covered.size / french.length) * 100) : 0;
  console.log(`Chaînes : ${stats.total} (fiables ${stats.reliability.high}, fiabilité basse ${stats.reliability.low})`);
  console.log(`Par source : ${Object.entries(stats.counts).map(([source, n]) => `${source} ${n}`).join(', ')}`);
  console.log(`Top 10 pays : ${facets.countries.slice(0, 10).map((c) => `${c.code} ${c.count}`).join(', ')}`);
  console.log(`Chaînes françaises (FR) : ${fr}`);
  console.log(`Avec EPG : ${stats.epgCoverage} % du catalogue, ${frCoverage} % des chaînes françaises (${covered.size}/${french.length})`);
  console.log(`Sources EPG : ${stats.epgStats.map((s) => `${s.url} ${s.ok ? 'ok' : 'échec'} (${s.programmes})`).join(' | ')}`);
} finally {
  server.close();
}
