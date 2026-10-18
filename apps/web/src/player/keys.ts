/* Raccourcis clavier du lecteur (et télécommande : flèches, Entrée, Retour). Fonction pure, testée. */

export type KeyAction =
  | { type: 'toggle-play' }
  | { type: 'seek'; by: number }
  | { type: 'volume'; by: number }
  | { type: 'fullscreen' }
  | { type: 'mute' }
  | { type: 'skip' }
  | { type: 'pip' }
  | { type: 'mini' }
  | { type: 'panel'; name: 'subtitles' | 'audio' | 'episodes' | 'info' | 'speed' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'nav'; dir: 'up' | 'down' | 'left' | 'right' }
  | { type: 'wake' };

export interface KeyContext {
  /** Un panneau latéral est ouvert : les flèches haut/bas le parcourent au lieu de régler le volume. */
  panelOpen: boolean;
  /** Le focus est sur un champ de saisie ou un curseur : on ne détourne pas ses touches. */
  typing: boolean;
  /** Le focus est sur un bouton : Espace et Entrée l'activent au lieu de mettre en pause. */
  onButton: boolean;
}

export const SEEK_STEP = 10;
export const VOLUME_STEP = 0.05;

export function keyToAction(key: string, ctx: KeyContext, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean } = {}): KeyAction | null {
  if (mods.ctrl || mods.alt || mods.meta) return null;
  if (ctx.typing) return key === 'Escape' ? { type: 'back' } : null;
  if (ctx.panelOpen) {
    switch (key) {
      case 'ArrowUp': return { type: 'nav', dir: 'up' };
      case 'ArrowDown': return { type: 'nav', dir: 'down' };
      case 'ArrowLeft': return { type: 'nav', dir: 'left' };
      case 'ArrowRight': return { type: 'nav', dir: 'right' };
      case 'Escape': case 'Backspace': case 'BrowserBack': return { type: 'back' };
      default: break;
    }
  }
  switch (key) {
    case ' ': case 'k': case 'K': case 'MediaPlayPause':
      return ctx.onButton && key === ' ' ? null : { type: 'toggle-play' };
    case 'ArrowLeft': return { type: 'seek', by: -(mods.shift ? 3 : 1) * SEEK_STEP };
    case 'ArrowRight': return { type: 'seek', by: (mods.shift ? 3 : 1) * SEEK_STEP };
    case 'ArrowUp': return { type: 'volume', by: VOLUME_STEP };
    case 'ArrowDown': return { type: 'volume', by: -VOLUME_STEP };
    case 'f': case 'F': return { type: 'fullscreen' };
    case 'm': case 'M': return { type: 'mute' };
    case 's': case 'S': return { type: 'skip' };
    case 'p': case 'P': return { type: 'pip' };
    case 'c': case 'C': return { type: 'panel', name: 'subtitles' };
    case 'a': case 'A': return { type: 'panel', name: 'audio' };
    case 'e': case 'E': return { type: 'panel', name: 'episodes' };
    case 'i': case 'I': return { type: 'mini' };
    case 'n': case 'N': case 'MediaTrackNext': return { type: 'next' };
    case 'Escape': case 'Backspace': case 'BrowserBack': return { type: 'back' };
    case 'Tab': case 'Enter': return { type: 'wake' };
    default: return null;
  }
}

/** Volume borné à [0, 1] et arrondi au pas de 5 %. */
export function stepVolume(current: number, by: number): number {
  return Math.min(1, Math.max(0, Math.round((current + by) * 20) / 20));
}

export const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
