/* Défilement infini des grilles paginées (Tout voir, bibliothèque, filmographie, chaînes TV, recherche).
 * Une sentinelle placée sous la liste déclenche le chargement de la page suivante ~800 px avant la fin ; des tuiles
 * squelettes s'affichent pendant le chargement ; « Fin de la liste » clôt la liste. Au clavier, la sentinelle est un
 * lien « Charger plus » visible seulement au focus. Le contenu déjà chargé est mémorisé pour le retour en arrière. */

const memory = new Map(); // clé de page -> { html, page, done }
const MEMORY_MAX = 12;
let current = null;

/** Arrête la liste affichée (changement de page). */
export function stopInfinite() {
  if (current) current.destroy();
  current = null;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host        conteneur des éléments
 * @param {(page:number)=>Promise<{html:string, done:boolean}>} o.load  charge la page \`page\` (à partir de 1)
 * @param {(host:HTMLElement)=>void} [o.after]  appelé après chaque ajout (observation des tuiles…)
 * @param {string|null} [o.key]       clé de mémorisation (retour en arrière) ; null : pas de mémoire
 * @param {boolean} [o.restore]       restaure le contenu mémorisé s'il existe
 * @param {HTMLElement} [o.anchor]    élément sous lequel placer la sentinelle (défaut : le conteneur)
 * @param {string} [o.skeleton]       HTML d'un squelette
 * @param {number} [o.skeletons]      nombre de squelettes
 * @returns {{ ready: Promise<void>, destroy: ()=>void }}
 */
export function infiniteList(o) {
  stopInfinite();
  const host = o.host;
  const skeletonHTML = o.skeleton || '<span class="sk sk-card sk-grid" aria-hidden="true"></span>';
  const count = o.skeletons || 6;
  let page = 0;
  let done = false;
  let busy = false;
  let alive = true;
  let io = null;

  const bar = document.createElement('div');
  bar.className = 'inf';
  bar.innerHTML = '<a href="#" class="inf-more" role="button">Charger plus</a><p class="inf-end" hidden>Fin de la liste</p>';
  (o.anchor || host).insertAdjacentElement('afterend', bar);
  const link = bar.querySelector('.inf-more');
  const end = bar.querySelector('.inf-end');

  const strip = () => host.querySelectorAll('[data-inf-sk]').forEach((n) => n.remove());
  const remember = () => {
    if (!o.key) return;
    strip();
    memory.delete(o.key);
    memory.set(o.key, { html: host.innerHTML, page, done });
    if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
  };
  const finish = () => {
    done = true;
    link.hidden = true;
    end.hidden = false;
    if (io) io.disconnect();
  };
  const rearm = () => {
    // Une nouvelle observation redéclenche le rappel si la sentinelle est encore proche du bas de l'écran.
    if (io && alive && !done) { io.unobserve(bar); io.observe(bar); }
  };

  async function run() {
    if (busy || done || !alive) return;
    busy = true;
    const sk = document.createElement('template');
    sk.innerHTML = Array.from({ length: count }, () => skeletonHTML).join('');
    Array.from(sk.content.children).forEach((n) => { n.setAttribute('data-inf-sk', ''); host.appendChild(n); });
    try {
      const r = await o.load(page + 1);
      if (!alive) return;
      strip();
      page += r.advance || 1;
      if (r.html) host.insertAdjacentHTML('beforeend', r.html);
      if (r.done) finish();
      if (o.after) o.after(host);
      remember();
    } catch (_) {
      if (alive) {
        strip();
        link.hidden = false;
        link.textContent = 'Réessayer';
      }
    } finally {
      busy = false;
    }
    rearm();
  }

  link.addEventListener('click', (e) => { e.preventDefault(); run(); });
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) run(); }, { rootMargin: '0px 0px 800px 0px' });
    io.observe(bar);
  }

  const saved = o.key && o.restore ? memory.get(o.key) : null;
  let ready;
  if (saved) {
    host.innerHTML = saved.html;
    page = saved.page;
    if (saved.done) finish();
    if (o.after) o.after(host);
    ready = Promise.resolve();
  } else {
    ready = run();
  }

  const ctl = {
    ready,
    destroy() {
      alive = false;
      if (io) io.disconnect();
      bar.remove();
    },
  };
  current = ctl;
  return ctl;
}
