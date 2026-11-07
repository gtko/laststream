/* Bandes-annonces et lecteur : quand la vidéo passe en plein écran, tout aperçu (survol, carrousel, mise en avant de la fiche)
   s'arrête ; à la fermeture ou en miniature, ils reprennent. Les gardes d'entrée vivent dans preview.js, hover.js, hero.js et
   heroVideo.js ; ce module ne fait que couper et relancer sur les changements d'état. */
import { isFull, onChange } from '../player/playerState';
import { resumeHero } from './hero.js';
import { heroVideoSync } from './heroVideo.js';
import { closeHover } from './hover.js';
import { cancelDwell, stopPreview } from './preview.js';

export function initTrailersGate() {
  return onChange(() => {
    if (isFull()) { stopPreview(); cancelDwell(); closeHover(); } else resumeHero();
    heroVideoSync();
  });
}
