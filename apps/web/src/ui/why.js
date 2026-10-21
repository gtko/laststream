/* Cartes « En deux mots » : texte limité à 2 lignes, déployé vers le haut au survol,
 * au focus clavier (Entrée / Espace) ou au toucher, sans décaler les boutons situés dessous. */

export function setupWhy(card) {
  if (!card || card.dataset.why) return;
  card.dataset.why = '1';
  const inner = document.createElement('div');
  inner.className = 'f-why-inner';
  while (card.firstChild) inner.appendChild(card.firstChild);
  card.appendChild(inner);
  const text = inner.querySelector('.f-why-text');
  const hint = document.createElement('span');
  hint.className = 'f-why-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = 'Lire la suite';
  inner.appendChild(hint);
  card.classList.add('is-live');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-expanded', 'false');

  let collapsed = 0;
  let touch = false;
  const measure = () => {
    card.classList.remove('is-open');
    inner.style.maxHeight = '';
    card.style.height = '';
    card.dataset.clamped = String(text.scrollHeight > text.clientHeight + 1);
    collapsed = inner.offsetHeight;
    card.style.height = collapsed + 'px';
    inner.style.maxHeight = collapsed + 'px';
  };
  const open = () => {
    if (card.dataset.clamped !== 'true' || card.classList.contains('is-open')) return;
    card.classList.add('is-open');
    card.setAttribute('aria-expanded', 'true');
    inner.style.maxHeight = 'none';
    const full = inner.offsetHeight;
    inner.style.maxHeight = collapsed + 'px';
    void inner.offsetHeight; // fixe le point de départ de la transition
    inner.style.maxHeight = full + 'px';
  };
  const close = () => {
    if (!card.classList.contains('is-open')) return;
    card.classList.remove('is-open');
    card.setAttribute('aria-expanded', 'false');
    inner.style.maxHeight = collapsed + 'px';
  };
  const toggle = () => (card.classList.contains('is-open') ? close() : open());

  card.addEventListener('pointerdown', (e) => { touch = e.pointerType !== 'mouse'; });
  card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') open(); });
  card.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && document.activeElement !== card) close(); });
  card.addEventListener('focus', () => { if (!touch) open(); });
  card.addEventListener('blur', () => { touch = false; close(); });
  card.addEventListener('click', () => { if (touch) toggle(); });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); }
    else if (e.key === 'Escape' && card.classList.contains('is-open')) { e.preventDefault(); e.stopPropagation(); close(); }
  });
  window.addEventListener('resize', () => { if (card.isConnected && !card.classList.contains('is-open')) measure(); });
  measure();
}
