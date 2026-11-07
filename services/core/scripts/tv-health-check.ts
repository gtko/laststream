/*
 * Test de santé des flux de la TV en direct contre les sources réelles (voir src/lt/tv-health.ts) : construit le
 * catalogue public puis lit, pour chaque chaîne, le manifeste HLS et un morceau du premier segment.
 * Aucune clé requise ; le test part de cette machine (IP locale), donc sans le géoblocage vu depuis Cloudflare.
 * Usage : npm run tv:health [-- --countries=FR,BE --limit=200 --list]
 */
import { buildCatalogStreaming, DEFAULT_TV_COUNTRIES } from '../src/lt/tv-build.js';
import { checkStream, type StreamVerdict } from '../src/lt/tv-health.js';

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const countries = arg('countries')?.split(',') ?? [...DEFAULT_TV_COUNTRIES];
const limit = Number(arg('limit') ?? '0');
const list = process.argv.includes('--list');
const CONCURRENCY = 16;

const catalog = await buildCatalogStreaming({ countries });
const channels = limit > 0 ? catalog.channels.slice(0, limit) : catalog.channels;
const verdicts = new Map<string, StreamVerdict>();
let next = 0;
const worker = async (): Promise<void> => {
  while (next < channels.length) {
    const channel = channels[next++];
    if (channel === undefined) break;
    verdicts.set(channel.id, await checkStream(fetch, channel.url));
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const by = (verdict: StreamVerdict): string[] => channels.filter((c) => verdicts.get(c.id) === verdict).map((c) => `${c.name} (${c.country}, ${c.source})`);
const [ok, down, unknown] = [by('ok'), by('down'), by('unknown')];
console.log(`Chaînes testées (flux principal) : ${channels.length} sur ${catalog.channels.length} (pays ${countries.join(', ')})`);
console.log(`Fonctionnent : ${ok.length} · en panne : ${down.length} · sans verdict (accès refusé) : ${unknown.length}`);
if (list) {
  console.log(`\nEn panne :\n${down.join('\n')}\n\nSans verdict :\n${unknown.join('\n')}`);
}
