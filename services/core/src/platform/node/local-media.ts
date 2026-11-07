import { createAutoDetector } from '../../lt/detect/index.js';
import { ThumbService } from '../../lt/thumbs/index.js';
import type { LocalMedia } from '../types.js';

/** ffmpeg local (miniatures, détection des segments de saut) : processus enfants et disque, propres à Node. */
export const nodeLocalMedia: LocalMedia = {
  createThumbs: (options) => new ThumbService(options),
  createDetector: (openSkips, options) => createAutoDetector(openSkips, options),
};
