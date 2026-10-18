import type { Capabilities } from '../types.js';

/** Sous Node : ffmpeg local, détection de segments et proxy HLS disponibles. */
export const nodeCapabilities: Capabilities = { thumbs: true, skipDetect: true, tvHls: true };
