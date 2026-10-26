/* Sous-titre à l'écran à l'instant courant : cue active (décalage, vitesse, second sous-titre) et HTML mémorisé. Le HTML d'une cue
 * n'est recalculé que si son texte change, et l'interface n'est touchée que si l'affichage change. Logique pure, testée. */
import { activeCue, cueHtml, type Cue } from './subs';

/** Ce que la vue lit de l'état des sous-titres de la session (`P.subs`). */
export interface CueSubs {
  cues: readonly Cue[];
  /** Cues du second sous-titre (mode apprentissage). */
  cues2: readonly Cue[];
  /** Cues lues dans la vidéo du navigateur (pistes intégrées) : rafraîchies par l'appelant. */
  nativeCues: readonly Cue[] | null;
  /** Sous-titres rendus par le moteur lui-même (mpv, natif) ou par la vidéo du navigateur. */
  native: boolean;
  native2: boolean;
  secondaryId: string | null;
  offset: number;
  shift: number;
  shift2: number;
  rate: number;
  style: unknown;
}

/** Cue à montrer pour le premier et le second sous-titre ('' : rien). */
export function cueTexts(s: CueSubs, kind: string, time: number): [string, string] {
  const cues = s.native && kind === 'html' ? s.nativeCues ?? [] : s.cues;
  // Le lecteur natif affiche ses sous-titres lui-même ; mpv aussi quand la piste est intégrée.
  const main = kind === 'native' || (s.native && kind === 'mpv') ? null : activeCue(cues, time, s.offset + s.shift, s.rate);
  const second = s.secondaryId && !s.native2 && kind !== 'native' ? activeCue(s.cues2, time, s.shift2, 1) : null;
  return [main ? main.text : '', second ? second.text : ''];
}

export interface CueView {
  /** Calcule le sous-titre de `time` et appelle `push(html, style, html2)` seulement s'il diffère du précédent. */
  render(s: CueSubs, kind: string, time: number, push: (html: string, style: unknown, html2: string) => void): boolean;
  /** Oublie l'affichage précédent : le prochain `render` pousse toujours (nouvelle session). */
  forget(): void;
}

/** Une entrée de mémoire par sous-titre : une cue dure plusieurs secondes, son HTML ne change pas entre deux relevés. */
function memoHtml(toHtml: (text: string) => string): (text: string) => string {
  let key = '';
  let val = '';
  return (text) => {
    if (text === '') return '';
    if (text !== key) { key = text; val = toHtml(text); }
    return val;
  };
}

export function createCueView(toHtml: (text: string) => string = cueHtml): CueView {
  const html1 = memoHtml(toHtml);
  const html2 = memoHtml(toHtml);
  let shown: { a: string; b: string; style: unknown } | null = null;
  return {
    render(s, kind, time, push) {
      const [t1, t2] = cueTexts(s, kind, time);
      const a = html1(t1);
      const b = html2(t2);
      if (shown && shown.a === a && shown.b === b && shown.style === s.style) return false;
      shown = { a, b, style: s.style };
      push(a, s.style, b);
      return true;
    },
    forget() { shown = null; },
  };
}
