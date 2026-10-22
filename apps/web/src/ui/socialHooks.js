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

export const openProfileEditor = (...a) => impl.openProfileEditor(...a);
export const openConversation = (...a) => impl.openConversation(...a);
export const renderConversationList = (...a) => impl.renderConversationList(...a);
export const openShareDialog = (...a) => impl.openShareDialog(...a);
export const inviteToParty = (...a) => impl.inviteToParty(...a);
export const openPartyLobby = (...a) => impl.openPartyLobby(...a);
export const launchPlayback = (...a) => impl.launchPlayback(...a);
