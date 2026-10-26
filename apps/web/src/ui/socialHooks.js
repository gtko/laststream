// Points d'entrée partagés entre les lots Social v3 (F1–F6).
// Chaque lot remplace UNIQUEMENT les fonctions qu'il possède par une vraie implémentation,
// en gardant ces signatures ; les autres lots les appellent sans connaître leur module.
// Propriétaires : F2 openProfileEditor · F3 openConversation / renderConversationList · F4 openShareDialog
// · F6 inviteToParty / openPartyLobby.

const impl = {
  /** F2 — ouvre l'édition du profil social (page desktop, plein écran mobile). */
  openProfileEditor: () => {},
  /** F3 — ouvre la discussion `conv` ("dm:<pid>" ou "g:<id>") dans une fenêtre ancrée (desktop) ou plein écran (mobile). */
  openConversation: (_conv) => {},
  /** F3 — rend la liste des conversations (onglet Messages de la sidebar) dans `el`, renvoie une fonction de nettoyage. */
  renderConversationList: (_el) => () => {},
  /** F4 — ouvre la fenêtre « Partager ». opts = { media: {type, tmdbId, title, poster?, season?, episode?}, pos?: number } */
  openShareDialog: (_opts) => {},
  /** F6 — invite l'ami `pid` dans ma watch party active (ou en crée une sur le titre en cours). */
  inviteToParty: (_pid) => {},
  /** F6 — ouvre le salon d'attente d'une watch party. */
  openPartyLobby: (_partyId) => {},
  /** ODY-221 — lance la lecture normale (playBest) d'une cible `request` avec `opts` ({ resume, startAt }) ; branchée par main.js. */
  launchPlayback: (_request, _opener, _opts) => undefined,
};

/** Un lot enregistre son implémentation au démarrage de son module : registerSocialHook('openShareDialog', fn). */
export function registerSocialHook(name, fn) {
  if (!(name in impl)) throw new Error(`Hook social inconnu : ${name}`);
  impl[name] = fn;
}

// Chargement différé du Social (LAST-129) : tant que ses modules ne sont pas arrivés, un appel de hook est mis en file
// et rejoué dès l'enregistrement. Sans chargeur (tests, ou Social déjà chargé), l'appel est direct.
let loader = null;
let ready = true;

/** Déclare le chargeur du Social ; les hooks appelés avant `markSocialReady` attendent ce chargement. */
export function setSocialLoader(fn) { loader = fn; ready = false; }
/** Les modules Social sont chargés et leurs hooks enregistrés. */
export function markSocialReady() { ready = true; }
/** Charge le Social si besoin. */
export const ensureSocial = () => (loader && !ready ? loader() : Promise.resolve());

/** Message court affiché quand le Social n'a pas pu être chargé (branché sur le toast de l'application par main.js). */
let notify = () => undefined;
export function setSocialNotifier(fn) { notify = fn; }
const SOCIAL_FAIL = 'Impossible de charger cette fonction, vérifiez la connexion.';
const call = (name, a) => {
  if (ready) return impl[name](...a);
  void ensureSocial().then(() => impl[name](...a)).catch(() => notify(SOCIAL_FAIL));
  return undefined;
};

export const openProfileEditor = (...a) => call('openProfileEditor', a);
export const openConversation = (...a) => call('openConversation', a);
export const renderConversationList = (...a) => {
  if (ready) return impl.renderConversationList(...a);
  let cleanup;
  let closed = false;
  void ensureSocial().then(() => { if (!closed) cleanup = impl.renderConversationList(...a); }).catch(() => notify(SOCIAL_FAIL));
  return () => { closed = true; if (typeof cleanup === 'function') cleanup(); };
};
export const openShareDialog = (...a) => call('openShareDialog', a);
export const inviteToParty = (...a) => call('inviteToParty', a);
export const openPartyLobby = (...a) => call('openPartyLobby', a);
export const launchPlayback = (...a) => call('launchPlayback', a);
