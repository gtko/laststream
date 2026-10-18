/**
 * Lecture en flux de gros JSON, pour les Workers (128 Mo de mémoire) : jamais le fichier entier en mémoire, seulement le
 * fragment courant (un élément à la fois) et le bloc de réception.
 */

interface Frame {
  isObject: boolean;
  /** Clé de la valeur en cours dans cet objet. */
  key: string;
  expectKey: boolean;
}

/** Éléments d'un conteneur (tableau ou objet) trouvé au chemin de clés `path`, un par un, sous forme de texte JSON. */
export interface ScanOptions {
  /** Plafond d'un élément (octets de texte) : au-delà il est ignoré, la mémoire reste bornée. */
  maxItemChars?: number;
  /** Plafond du texte lu au total : au-delà la lecture s'arrête (flux annulé). */
  maxTotalChars?: number;
}

const DEFAULT_MAX_ITEM_CHARS = 256 * 1024;

/**
 * Parcourt un flux JSON et appelle `onItem` avec le texte de chaque élément du conteneur situé à `path`
 * (`[]` : la racine). Pour un objet, l'élément est `"clé":valeur`. Le flux est annulé dès que le conteneur est refermé.
 * Retourne le nombre d'éléments produits.
 */
export async function scanJson(
  stream: ReadableStream<Uint8Array>,
  path: readonly string[],
  onItem: (text: string, isObjectEntry: boolean) => void,
  options: ScanOptions = {},
): Promise<number> {
  const maxItem = options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS;
  const maxTotal = options.maxTotalChars ?? Number.POSITIVE_INFINITY;
  const targetDepth = path.length + 1;
  const stack: Frame[] = [];
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let inString = false;
  let escaped = false;
  let keyBuf = '';
  let capturingKey = false;
  let inTarget = false;
  let targetIsObject = false;
  let segment: string[] = [];
  let segmentLength = 0;
  let overflow = false;
  let produced = 0;
  let total = 0;
  let done = false;

  const flush = (): void => {
    if (segmentLength > 0 && !overflow) {
      const text = segment.join('').trim();
      if (text !== '') {
        onItem(text, targetIsObject);
        produced += 1;
      }
    }
    segment = [];
    segmentLength = 0;
    overflow = false;
  };

  const process = (text: string): void => {
    let start = 0; // début du fragment à ajouter au segment courant
    const append = (end: number): void => {
      if (!inTarget || end <= start) return;
      const piece = text.slice(start, end);
      segmentLength += piece.length;
      if (segmentLength > maxItem) {
        overflow = true;
        segment = [];
      } else if (!overflow) segment.push(piece);
    };
    for (let i = 0; i < text.length && !done; i++) {
      const c = text.charCodeAt(i);
      if (inString) {
        if (capturingKey) keyBuf += text[i];
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === 34) {
          inString = false;
          if (capturingKey) {
            const frame = stack[stack.length - 1];
            if (frame !== undefined) {
              frame.key = keyBuf.slice(0, -1);
              frame.expectKey = false;
            }
            capturingKey = false;
          }
        }
        continue;
      }
      if (c === 34) {
        inString = true;
        const frame = stack[stack.length - 1];
        capturingKey = frame !== undefined && frame.isObject && frame.expectKey;
        keyBuf = '';
        continue;
      }
      if (c === 123 || c === 91) {
        // { ou [
        stack.push({ isObject: c === 123, key: '', expectKey: c === 123 });
        if (stack.length === targetDepth && !inTarget && matchesPath(stack, path)) {
          inTarget = true;
          targetIsObject = c === 123;
          start = i + 1; // le crochet de la cible n'est pas un élément
        }
        continue;
      }
      if (c === 125 || c === 93) {
        // } ou ]
        if (inTarget && stack.length === targetDepth) {
          append(i);
          flush();
          inTarget = false;
          done = true;
          stack.pop();
          return;
        }
        stack.pop();
        continue;
      }
      if (c === 44) {
        // virgule
        const frame = stack[stack.length - 1];
        if (inTarget && stack.length === targetDepth) {
          append(i);
          flush();
          start = i + 1;
        }
        if (frame !== undefined && frame.isObject) frame.expectKey = true;
      }
    }
    append(text.length);
  };

  try {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      total += value.byteLength;
      if (total > maxTotal) throw new Error('json_too_large');
      process(decoder.decode(value, { stream: true }));
      if (done) break;
    }
    if (!done) process(decoder.decode());
  } finally {
    // Flux non terminé (cible refermée ou erreur) : on l'annule pour libérer la connexion.
    await reader.cancel().catch(() => undefined);
  }
  return produced;
}

function matchesPath(stack: readonly Frame[], path: readonly string[]): boolean {
  for (let i = 0; i < path.length; i++) {
    const frame = stack[i];
    if (frame === undefined || !frame.isObject || frame.key !== path[i]) return false;
  }
  return true;
}

/** Éléments objets JSON d'un tableau racine, déjà analysés (un élément illisible est ignoré). */
export function scanJsonArray(
  stream: ReadableStream<Uint8Array>,
  onRecord: (record: Record<string, unknown>) => void,
  options?: ScanOptions,
): Promise<number> {
  return scanJson(
    stream,
    [],
    (text) => {
      try {
        const value = JSON.parse(text) as unknown;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) onRecord(value as Record<string, unknown>);
      } catch {
        // élément illisible : ignoré
      }
    },
    options,
  );
}

/** Lignes d'un flux texte, une à la fois (ligne plus longue que `maxLineChars` : ignorée). */
export async function scanLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  maxLineChars = 64 * 1024,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      let at = rest.indexOf('\n');
      let from = 0;
      while (at !== -1) {
        const line = rest.slice(from, at);
        if (line.length <= maxLineChars) onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        from = at + 1;
        at = rest.indexOf('\n', from);
      }
      rest = rest.slice(from);
      if (rest.length > maxLineChars) rest = '';
    }
    rest += decoder.decode();
    if (rest !== '' && rest.length <= maxLineChars) onLine(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
