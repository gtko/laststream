// Page de test du GuestPlayer : monte un RangeReader en mémoire sur un fichier servi par Vite (publicDir).
// Expose window.__relay pour que run.mjs pilote le lecteur via Playwright (headless uniquement).
import { GuestPlayer, type PlayerStats, type RangeReader, type RoomState } from '../../../src/relay/player/index.ts';

interface PlayerEvent {
  type: 'play' | 'pause' | 'seek';
  position: number;
}

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const events: PlayerEvent[] = [];
const errors: string[] = [];
const served = { reads: 0, bytes: 0 };
let endedCount = 0;
let lastStats: PlayerStats | null = null;

const player = new GuestPlayer({
  onUserPlay: (position) => events.push({ type: 'play', position }),
  onUserPause: (position) => events.push({ type: 'pause', position }),
  onUserSeek: (position) => events.push({ type: 'seek', position }),
  onStats: (stats) => {
    lastStats = stats;
  },
  onError: (error) => errors.push(String(error)),
  onEnded: () => {
    endedCount++;
  },
});

/** Empreinte des pixels du canvas : taux de pixels allumés, nombre de couleurs, hachage. */
function sample() {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2D indisponible');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  let hash = 0;
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r + g + b > 30) lit++;
    const packed = (r << 16) | (g << 8) | b;
    colors.add(packed);
    hash = (Math.imul(hash, 31) + packed) >>> 0;
  }
  const state = player.getState();
  return {
    lit: lit / (data.length / 4),
    colors: colors.size,
    hash,
    position: state.position,
    playing: state.playing,
    duration: state.duration,
    width: canvas.width,
    height: canvas.height,
  };
}

/** RangeReader en mémoire : chaque plage demandée est une tranche de l'octet-tableau, end exclu. */
async function memoryReader(url: string): Promise<RangeReader> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return {
    async size() {
      return bytes.byteLength;
    },
    async read(start, end) {
      if (start < 0 || end > bytes.byteLength || end <= start) {
        throw new RangeError(`plage invalide ${start}-${end} (taille ${bytes.byteLength})`);
      }
      served.reads++;
      served.bytes += end - start;
      return bytes.slice(start, end);
    },
  };
}

const relay = {
  ready: false,
  error: null as string | null,
  plan: null as unknown,
  player,
  events,
  errors,
  served,
  sample,
  stats: () => player.getStats(),
  ended: () => endedCount,
  room: (state: RoomState) => player.applyRoomState(state),
};
(window as unknown as { __relay: typeof relay }).__relay = relay;

const media = new URLSearchParams(location.search).get('media') ?? 'test-h264.mp4';
memoryReader(`/${media}`)
  .then((reader) => player.load(reader, canvas))
  .then((plan) => {
    relay.plan = plan;
    relay.ready = true;
  })
  .catch((error: unknown) => {
    relay.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  });
