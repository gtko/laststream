/* Point d'entrée léger du lecteur pour l'interface : le lecteur (session.js et tout ce qu'il tire, dont mediabunny)
 * est chargé par `import()` au premier appel, pas au démarrage de l'application (LAST-129). */
import { toast } from '../ui/dom.js';
import { partyBridge } from '../party/bridge';

let mod = null;
let pending = null;
/** Incrémenté à chaque fermeture demandée avant l'arrivée du module : une lecture lancée avant ne démarre plus. */
let generation = 0;

/** Charge le lecteur (une seule fois) et rend son module ; un échec est signalé et un nouvel essai reste possible. */
function loadSession() {
  if (!pending) {
    pending = import('./session.js').then((m) => {
      if (!m) { pending = null; return m; } // import détourné (preventDefault de Vite) : rien à mémoriser
      mod = m;
      return m;
    }).catch((e) => {
      pending = null;
      toast('Lecteur indisponible, vérifiez la connexion.');
      throw e;
    });
  }
  return pending;
}

/** Vrai si un lecteur est ouvert ; faux tant que le module n'est pas chargé (aucune lecture n'a pu démarrer). */
export const isPlayerOpen = () => !!mod && mod.isPlayerOpen();

/** Lecteur affiché en grand (pas en miniature) ; faux tant que le module n'est pas chargé. */
export const isPlayerFull = () => !!mod && mod.isPlayerFull();

/** Retour du téléphone pendant la lecture : la lecture se réduit en miniature, ou le lecteur se ferme (voir sessionUi.js). */
export function leavePlayer() {
  if (mod) mod.leavePlayer();
}

/** Ferme le lecteur (appelé aussi par le retour du navigateur) ; une lecture en cours de chargement du module est annulée (rien ne démarre à l'arrivée du module). */
export function closePlayer() {
  if (mod) mod.closePlayer();
  else generation++;
}

/** Charge le lecteur puis lance `name`, sauf si le lecteur a été fermé pendant le chargement. Tant que le module n'est pas là,
 * le retour du navigateur (popstate) n'a pas d'écouteur de lecteur : il annule la lecture en attente. */
async function launch(name, args) {
  const g = generation;
  let m;
  if (mod) m = mod;
  else {
    const onBack = () => { generation++; };
    window.addEventListener('popstate', onBack);
    try { m = await loadSession(); } finally { window.removeEventListener('popstate', onBack); }
  }
  if (!m || g !== generation) return undefined;
  return m[name](...args);
}

export const playBest = (...args) => launch('playBest', args);
export const playSource = (...args) => launch('playSource', args);

// Salon (watch party) : le pont lance les épisodes demandés par l'hôte avec la source la plus proche de son empreinte.
// Posé au chargement de ce module, et non à celui du lecteur : « Rejoindre » fonctionne avant la première lecture.
// Un lancement annulé pendant le chargement du lecteur quitte le salon, sauf si un autre salon a été rejoint entre-temps.
partyBridge.launcher = async (request, o) => {
  const g = generation;
  const c = partyBridge.client;
  const r = await playBest(request, null, { resume: o.resume, force: true, prefer: o.prefer });
  if (g !== generation && partyBridge.client === c) partyBridge.leave();
  return r;
};
