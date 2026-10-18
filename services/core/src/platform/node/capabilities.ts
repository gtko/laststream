import type { Capabilities } from '../types.js';

/** Sous Node : ffmpeg local, détection de segments et proxy HLS disponibles. */
export const nodeCapabilities: Capabilities = { thumbs: true, rangeThumbs: true, skipDetect: true, tvHls: true, sharedState: false };
