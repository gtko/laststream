// Révèle la barre de défilement d'un conteneur pendant qu'il défile (voir styles/scrollbars.css).
const root = document.documentElement;
const timers = new WeakMap();

document.addEventListener('scroll', (e) => {
  const el = e.target === document ? root : e.target;
  if (!(el instanceof Element)) return;
  el.classList.add('is-scrolling');
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 900));
}, { capture: true, passive: true });

// Barre de la page : visible quand la souris approche du bord droit.
document.addEventListener('mousemove', (e) => {
  const near = root.clientWidth - e.clientX < 24;
  if (near !== root.classList.contains('sb-near')) root.classList.toggle('sb-near', near);
}, { passive: true });
document.addEventListener('mouseleave', () => root.classList.remove('sb-near'));
