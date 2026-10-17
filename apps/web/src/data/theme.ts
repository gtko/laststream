/** Thèmes : même format de stockage que l'application précédente (`laststream.theme` = JSON {id, accent}). */
export const THEME_STORAGE_KEY = 'laststream.theme';
export const DEFAULT_THEME_ID = 'laststream';
export const CUSTOM_THEME_ID = 'custom';
const HEX = /^#[0-9a-f]{6}$/i;

export interface ThemePreset {
  id: string;
  label: string;
  accent: string;
}

export const PRESETS: readonly ThemePreset[] = [
  { id: 'laststream', label: 'Laststream', accent: '#FF5A36' },
  { id: 'stremio', label: 'Stremio', accent: '#7B5BF5' },
  { id: 'teal', label: 'Teal', accent: '#19C3A6' },
  { id: 'amber', label: 'Amber', accent: '#F5B700' },
];

export interface Theme {
  id: string;
  accent: string;
}

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Texte sur l'accent : le fond sombre du thème tant qu'il tient 4,5:1, sinon blanc. */
export function onAccent(accent: string, dark = '#0c0b11'): string {
  return contrast(accent, dark) >= 4.5 ? dark : '#ffffff';
}

/** Éclaircit l'accent de 11 % vers le blanc pour l'état survol. */
export function hoverOf(accent: string): string {
  return '#' + rgb(accent).map((c) => Math.round(c + (255 - c) * 0.11).toString(16).padStart(2, '0')).join('');
}

export function resolveTheme(id: unknown, accent: unknown): Theme {
  if (id === CUSTOM_THEME_ID && isHexColor(accent)) return { id: CUSTOM_THEME_ID, accent: accent.toLowerCase() };
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  return { id: preset.id, accent: preset.accent };
}

export function readTheme(): Theme {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (!raw) return resolveTheme(DEFAULT_THEME_ID, null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw; // ancienne forme : identifiant seul
    }
    if (typeof parsed === 'string') return resolveTheme(parsed, null);
    const rec = (parsed ?? {}) as { id?: unknown; accent?: unknown };
    return resolveTheme(rec.id, rec.accent);
  } catch {
    return resolveTheme(DEFAULT_THEME_ID, null);
  }
}

export function saveTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, JSON.stringify({ id: theme.id, accent: theme.accent }));
  } catch {
    // Stockage indisponible.
  }
}

/** Applique le thème en variables CSS. Le thème par défaut retire les surcharges : la feuille de style fait foi. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const props = ['--accent', '--accent-hover', '--on-accent'];
  if (theme.id === DEFAULT_THEME_ID) {
    props.forEach((p) => root.style.removeProperty(p));
  } else {
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-hover', hoverOf(theme.accent));
    root.style.setProperty('--on-accent', onAccent(theme.accent));
  }
}
