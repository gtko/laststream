/* Palettes du générateur « Héros » : teints, cheveux, yeux, costumes (harmonisés avec le corail #ff5a36 de l'app). */

export type HeroFamily = 'heros' | 'vilains' | 'scifi' | 'fantasy';

/** Costume : [principale, secondaire, accent]. */
export type Costume = readonly [string, string, string];

/** Teints variés et inclusifs, du plus clair au plus foncé. */
export const SKINS: readonly string[] = [
  '#ffe3cf', '#f8d2b3', '#efc097', '#e0a57a', '#cd8d62', '#b3744b', '#94583a', '#74402a', '#573020', '#3e2218',
];
/** Teints fantastiques (extraterrestres, orcs). */
export const ALIEN_SKINS: readonly string[] = ['#86d6a6', '#7fb8ec', '#b9a0f2', '#ee93c6', '#7fae5a'];
/** Peaux d'androïdes. */
export const ANDROID_SKINS: readonly string[] = ['#e8eef7', '#cfd8e6', '#b5c0d3', '#e7cf9c', '#a9dff0'];

export const HAIRS: readonly string[] = [
  '#17171c', '#2b1b12', '#4a2c1a', '#7a4524', '#a8672c', '#d8a64a', '#ecdba6', '#c9ced8', '#b3302a', '#f2f2f2',
];
export const FANCY_HAIRS: readonly string[] = ['#7b5bf5', '#19c3a6', '#ec4899', '#3b82f6', '#ff5a36'];

export const IRISES: readonly string[] = ['#3a2a1c', '#2f6fb0', '#2e8b57', '#6b4a9e', '#7a5a2b', '#1f2430', '#55708f'];
export const NEONS: readonly string[] = ['#33e1ff', '#c6ff3d', '#ff4fd8', '#ffd23f', '#ff7a4d', '#8cff6a'];
export const VILLAIN_NEONS: readonly string[] = ['#ff3b3b', '#c6ff3d', '#ff4fd8', '#b06bff', '#ffb02e'];

export const COSTUMES: Record<HeroFamily, readonly Costume[]> = {
  heros: [
    ['#ff5a36', '#1d2b5a', '#ffd23f'],
    ['#2f6bff', '#f4f6fb', '#ff5a36'],
    ['#19c3a6', '#1b2433', '#c6ff3d'],
    ['#7b5bf5', '#161826', '#ff7ad9'],
    ['#d7263d', '#f5b700', '#171923'],
    ['#22a06b', '#f6efd9', '#ff8a3d'],
    ['#ec4899', '#1c2144', '#33e1ff'],
    ['#f5b700', '#2b3fb8', '#ffffff'],
    ['#3bb0ff', '#ff6a2b', '#12203f'],
    ['#2a3040', '#ff5a36', '#bfe9ff'],
    ['#8bd22f', '#5a2fb8', '#10121c'],
    ['#eef1f7', '#ff5a36', '#ffc83d'],
    ['#3a3fb5', '#19c3a6', '#ffe14d'],
    ['#e8662b', '#0f6b73', '#f6e3b4'],
  ],
  vilains: [
    ['#2a1f3d', '#7b2cbf', '#c8ff3d'],
    ['#16181f', '#d7263d', '#ffb02e'],
    ['#1f2a2a', '#19c3a6', '#e9fff9'],
    ['#3b0d1a', '#ff5a36', '#ffd23f'],
    ['#222a3f', '#4f6bff', '#e24bff'],
    ['#1b1b22', '#8c8c9a', '#ff3b3b'],
    ['#2d3b1f', '#9be21f', '#161616'],
    ['#26122e', '#ec4899', '#f5e04a'],
  ],
  scifi: [
    ['#e9eef6', '#ff7a1a', '#2b3fb8'],
    ['#cfd8e6', '#3b82f6', '#33e1ff'],
    ['#2b3142', '#19c3a6', '#ff5a36'],
    ['#f4f6fb', '#ff5a36', '#2a3040'],
    ['#1b2433', '#33e1ff', '#c6ff3d'],
    ['#3a3fb5', '#cfd8e6', '#ffd23f'],
    ['#b9c4d6', '#7b5bf5', '#ff7ad9'],
    ['#242b3a', '#ffb02e', '#e9eef6'],
  ],
  fantasy: [
    ['#8a97ab', '#b3202f', '#f5c451'],
    ['#6f7d93', '#2f5bd6', '#f4f6fb'],
    ['#5b3fc8', '#22183f', '#ffd23f'],
    ['#1f6b5a', '#0e2e2a', '#e8d9a0'],
    ['#3f7d3a', '#5a3a1e', '#e9d7a0'],
    ['#a8442a', '#3a2418', '#f0c26b'],
    ['#2b4a7a', '#e9eef6', '#f5b700'],
    ['#6a2d7a', '#e9d7a0', '#19c3a6'],
  ],
};
