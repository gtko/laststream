// Mode d'entrée courant, lu par les jetons d'anneau de focus (styles/styles.css) :
//   (absent)  rien n'a encore été touché : le focus donné par le code n'affiche aucun anneau
//   "kbd"     le clavier (ou une télécommande) navigue : anneau partout
//   "pointer" souris ou toucher : anneau seulement sur les champs de texte (toujours visibles)
const root = document.documentElement;
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'GoBack', 'BrowserBack']);

function set(mode) {
  if (root.dataset.input !== mode) root.dataset.input = mode;
}

// Appareil sans pointeur (TV) : navigation au clavier d'emblée, anneau dès le premier écran.
if (typeof matchMedia === 'function' && matchMedia('(any-pointer: none)').matches) set('kbd');

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey && !e.altKey && NAV_KEYS.has(e.key)) set('kbd');
}, true);
document.addEventListener('pointerdown', () => set('pointer'), true);
