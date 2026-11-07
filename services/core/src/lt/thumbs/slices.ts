/** Miniatures de la barre de progression : une image toutes les 30 s. Calculs purs. */

export const SLICE_SECONDS = 30;
/** Plafond de tranches par source (4 h) : borne le travail quand la durée est inconnue. */
export const MAX_SLICES = 480;

/** Nombre de tranches d'une source (index 0 .. count-1). Durée inconnue : le plafond. */
export function sliceCount(duration: number | undefined): number {
  if (duration === undefined || !(duration > 0)) return MAX_SLICES;
  return Math.min(MAX_SLICES, Math.floor(duration / SLICE_SECONDS) + 1);
}

/** Instant (s) de la capture d'une tranche : 2 s pour la première (évite le noir de départ), jamais au-delà de la fin. */
export function sliceTime(index: number, duration?: number): number {
  const t = index === 0 ? 2 : index * SLICE_SECONDS;
  return duration !== undefined && duration > 3 ? Math.min(t, duration - 1) : t;
}

/**
 * Ordre de génération : la tranche courante, puis alternativement vers l'avant et vers l'arrière
 * (c, c+1, c-1, c+2, c-2, ...), dans [0, count).
 */
export function generationOrder(center: number, count: number): number[] {
  const order: number[] = [];
  if (count <= 0) return order;
  const c = Math.min(Math.max(0, Math.trunc(center)), count - 1);
  order.push(c);
  for (let d = 1; order.length < count; d += 1) {
    if (c + d < count) order.push(c + d);
    if (c - d >= 0) order.push(c - d);
  }
  return order;
}

/** Arguments ffmpeg pour une image : recherche avant -i (rapide), WebP 160 px sur stdout, protocoles limités. Jamais de shell. */
export function ffmpegArgs(inputUrl: string, seconds: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'http,https,tcp,tls',
    '-ss', String(seconds),
    '-i', inputUrl,
    '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', 'scale=160:-2',
    '-c:v', 'libwebp', '-quality', '50',
    '-f', 'webp', '-',
  ];
}
