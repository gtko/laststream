import type { ConfigInput, Preset } from './schema.js';

// Import de types uniquement : presets.ts ne charge pas schema.ts à l'exécution (pas de cycle).

/** Valeurs partielles d'une configuration, au format d'entrée brut (avant validation). */
export type PresetValues = Partial<Omit<ConfigInput, 'preset'>>;

export interface PresetDefinition {
  readonly label: string;
  readonly description: string;
  readonly values: PresetValues;
  /** Valeurs ajoutées seulement si un debrid est configuré. */
  readonly withDebrid?: PresetValues;
}

/** Préréglages proposés par le configurateur. Ordre d'affichage : ordre des clés. */
export const PRESETS: Record<Preset, PresetDefinition> = {
  essentiel: {
    label: 'Essentiel',
    description: 'Réglages équilibrés : 1080p, 1440p et 2160p, VF ou multi en priorité, 30 résultats, tri par défaut.',
    values: {
      resolutions: { allowed: ['2160p', '1440p', '1080p'] },
      languages: { preferred: ['fr', 'multi'] },
      maxResults: 60,
      sort: 'default',
    },
  },
  zen: {
    label: 'Zen',
    description:
      'Un bon lien, sans effort : 1080p maximum, VF ou multi uniquement, 5 résultats, affichage compact. Avec un debrid, seuls les liens en cache (ou directs) sont gardés.',
    values: {
      resolutions: { max: '1080p' },
      languages: { preferred: ['fr', 'multi'], fallbackToOthers: false, acceptVostfr: false },
      maxResults: 5,
      sort: 'default',
      display: { template: 'compact' },
    },
    withDebrid: { onlyCached: true },
  },
  cinephile: {
    label: 'Cinéphile',
    description:
      'Qualité maximale : REMUX, BluRay et WEB-DL en 2160p, 1440p ou 1080p, Dolby Atmos et 7.1 préférés, tri du plus lourd, 20 résultats.',
    values: {
      filters: { qualities: ['REMUX', 'BluRay', 'WEB-DL'], preferredWords: ['Dolby Vision', 'DV', 'HDR'] },
      resolutions: { allowed: ['2160p', '1440p', '1080p'] },
      audio: { atmos: 'prefer', multichannel: 'prefer7_1', unsupportedFormats: [] },
      sort: 'heaviest',
      display: { template: 'detaille' },
      maxResults: 20,
    },
  },
  nomade: {
    label: 'Nomade',
    description:
      'Léger pour le mobile ou un réseau modeste : 1080p maximum, 8 Mbit/s et 4 Go au plus, sans DTS-HD, TrueHD ni Atmos, tri du plus léger, 10 résultats.',
    values: {
      filters: { bitrate: { maxMbps: 8 } },
      resolutions: { max: '1080p' },
      size: { maxGb: 4, perResolution: { '1080p': { maxGb: 3 }, '720p': { maxGb: 1.5 } } },
      audio: { unsupportedFormats: ['DTS-HD', 'TrueHD', 'Atmos'], unsupportedMode: 'exclude' },
      sort: 'lightest',
      display: { template: 'compact' },
      maxResults: 10,
    },
  },
};

/** Clés refusées lors de la fusion : évite toute pollution du prototype. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copie profonde des données JSON (objets et tableaux). Les valeurs de PRESETS ne sont jamais partagées. */
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (isPlainObject(value)) return mergeInto({}, value);
  return value;
}

/**
 * Fusionne `source` dans `target` (qui doit être une copie fraîche). Les objets sont fusionnés en profondeur,
 * les tableaux et valeurs scalaires de `source` remplacent ceux de `target`, les `undefined` sont ignorés.
 */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    target[key] = isPlainObject(value) && isPlainObject(current) ? mergeInto(current, value) : copy(value);
  }
  return target;
}

/**
 * Applique le préréglage nommé par `input.preset` : valeurs du préréglage, puis (si un debrid est configuré)
 * ses valeurs debrid, puis les valeurs explicites de l'utilisateur, qui l'emportent. Renvoie `input` tel quel
 * sans préréglage reconnu : un préréglage inconnu reste une erreur de validation.
 */
export function applyPreset(input: unknown): unknown {
  if (!isPlainObject(input) || typeof input.preset !== 'string' || !Object.hasOwn(PRESETS, input.preset)) {
    return input;
  }
  const definition = PRESETS[input.preset as Preset];
  let merged = mergeInto({}, definition.values);
  if (definition.withDebrid !== undefined && input.debrid !== undefined && input.debrid !== null) {
    merged = mergeInto(merged, definition.withDebrid);
  }
  return mergeInto(merged, input);
}

/** Liste des préréglages pour GET /config/schema. */
export function presetCatalog(): { id: Preset; label: string; description: string; values: PresetValues }[] {
  return (Object.keys(PRESETS) as Preset[]).map((id) => {
    const { label, description, values } = PRESETS[id];
    return { id, label, description, values };
  });
}
