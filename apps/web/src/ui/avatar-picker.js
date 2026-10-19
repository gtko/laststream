/*
 * Sélecteur d'avatars DiceBear et Héros (ancien sélecteur de l'éditeur de profil). Il vit maintenant dans le studio
 * d'avatars, onglet « Illustrés » > « Générés ». Déplacé ici pour que le studio et l'éditeur ne dépendent pas
 * l'un de l'autre (pas d'import circulaire avec auth-ui.js).
 */
import { AVATAR_TABS, avatarCredits, HERO_FAMILIES, LICENSE_LABEL, LICENSE_URL, parseAvatar, parseColAvatar, parseHero, randomSeed, tabTiles } from '../data/avatars';
import { avatarAttrs } from './avatar-art.js';
import { esc } from './util.js';

/** Crédits des illustrations (CC BY 4.0 et licences à attribution) : liste des illustrateurs et licences. */
export function creditsHTML() {
  return '<ul class="av-credits">' + avatarCredits().map((c) =>
    '<li><strong>' + esc(c.creator) + '</strong> : ' + c.styles.map((st) => '<a href="' + esc(st.source) + '" target="_blank" rel="noopener noreferrer">' + esc(st.label) + '</a>').join(', ') +
    ' · <a href="' + esc(LICENSE_URL[c.license]) + '" target="_blank" rel="noopener noreferrer">' + esc(LICENSE_LABEL[c.license]) + '</a></li>').join('') +
    '</ul><p class="av-credits">Avatars « Héros » : dessins originaux laststream, générés en local.</p><p class="av-credits">Avatars générés avec <a href="https://www.dicebear.com" target="_blank" rel="noopener noreferrer">DiceBear</a> (MIT), en local sur ton appareil.</p>';
}

export function avatarPickerHTML() {
  return '<section class="pf-picker-avatars" aria-labelledby="pfe-av-title"><h3 class="pf-section-title" id="pfe-av-title">Avatar</h3>' +
    '<div class="av-tabs pills" role="tablist" aria-label="Familles d’avatars">' + AVATAR_TABS.map((t) =>
      '<button type="button" class="pill" role="tab" data-av-tab="' + t.id + '" aria-pressed="false">' + esc(t.label) + '</button>').join('') + '</div>' +
    '<div class="av-subs pills" role="group" aria-label="Types de héros" data-av-subs>' + HERO_FAMILIES.map((f) =>
      '<button type="button" class="pill" data-av-sub="' + f.id + '" aria-pressed="false">' + esc(f.label) + '</button>').join('') + '</div>' +
    '<div class="av-tools"><input class="set-input" type="search" name="avsearch" maxlength="40" placeholder="Un prénom pour essayer…" aria-label="Chercher un avatar à partir d’un mot" autocomplete="off">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-av-random>Au hasard</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-av-none>Initiale</button></div>' +
    '<div class="av-grid" data-av-grid role="group" aria-label="Avatars"></div>' +
    '<button type="button" class="btn btn-ghost btn-sm av-more" data-av-more>Voir plus</button>' +
    '<details class="av-credits-more"><summary>Crédits des illustrations</summary>' + creditsHTML() + '</details></section>';
}

/**
 * Sélecteur d'avatars du formulaire : onglets par famille, recherche / au hasard, grille paginée (rendu à la demande).
 * `onPick(avatar)` est appelé à chaque choix (vignette ou « Initiale »).
 */
export function avatarPicker(node, cur, onPick = () => {}) {
  const PAGE = 48;
  const parsed = parseAvatar(cur.avatar);
  const hero = parseHero(cur.avatar);
  // Avatar « collection » : pas d'onglet qui le liste (le sélecteur des collections est à venir) ; il est gardé tel quel
  // tant que l'utilisateur ne choisit pas autre chose, pour qu'un enregistrement ne l'efface pas.
  const col = parseColAvatar(cur.avatar);
  const valid = !!(parsed || hero || col);
  const state = { avatar: valid ? cur.avatar : null, tab: hero ? 'heroes' : parsed ? parsed.style.family : cur.isKid ? 'enfants' : 'heroes', sub: hero ? hero.family : 'heros', word: '', shown: PAGE, touched: valid };
  const grid = node.querySelector('[data-av-grid]');
  const more = node.querySelector('[data-av-more]');
  const render = () => {
    const tiles = tabTiles(state.tab, state.word, state.sub);
    grid.innerHTML = tiles.slice(0, state.shown).map((t) =>
      '<button type="button" class="av-tile"' + avatarAttrs(t.value, '#94a3b8') + ' data-av-pick="' + esc(t.value) + '" aria-pressed="' + (state.avatar === t.value) + '" aria-label="' + esc(t.style.label + ', ' + t.seed) + '"></button>').join('');
    more.hidden = state.shown >= tiles.length;
    node.querySelectorAll('[data-av-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avTab === state.tab)));
    node.querySelectorAll('[data-av-sub]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avSub === state.sub)));
    node.querySelector('[data-av-subs]').hidden = state.tab !== 'heroes';
  };
  node.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest('[data-av-tab]');
    if (tab) { state.tab = tab.dataset.avTab; state.shown = PAGE; state.touched = true; render(); return; }
    const sub = t.closest('[data-av-sub]');
    if (sub) { state.sub = sub.dataset.avSub; state.shown = PAGE; render(); return; }
    const pick = t.closest('[data-av-pick]');
    if (pick) { state.avatar = pick.dataset.avPick; render(); onPick(state.avatar); return; }
    if (t.closest('[data-av-none]')) { state.avatar = null; render(); onPick(null); return; }
    if (t.closest('[data-av-more]')) { state.shown += PAGE; render(); return; }
    if (t.closest('[data-av-random]')) {
      state.word = randomSeed();
      node.querySelector('input[name="avsearch"]').value = state.word;
      state.shown = PAGE;
      render();
    }
  });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.name === 'avsearch') e.preventDefault(); });
  node.addEventListener('input', (e) => {
    if (e.target.name !== 'avsearch') return;
    state.word = e.target.value;
    state.shown = PAGE;
    render();
  });
  render();
  return {
    value: () => state.avatar,
    kidChanged: (isKid) => { if (!state.touched) { state.tab = isKid ? 'enfants' : 'heroes'; state.shown = PAGE; render(); } },
  };
}
