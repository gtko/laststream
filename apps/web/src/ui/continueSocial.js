/* « Reprendre la lecture » côté amis (LAST-195) : repère de l'ami le plus avancé sur la barre de lecture et mention
 * (« Léa a 1 épisode d'avance », « Personne d'autre ne l'a commencé »). Données : UNE requête groupée /home/progress pour les
 * titres affichés (le client découpe par 20), lancée après le premier rendu de la rangée ; la carte est complétée en place (le
 * repère flotte sur le visuel, la mention vit dans le bloc de texte déjà posé : aucun saut de mise en page). Compte connecté,
 * jamais sur un profil enfant (socialAvailable). Échec réseau : silencieux, nouvel essai au plus une fois par minute. */
import { getState } from '../data/socialStore';
import { homeProgress } from '../data/socialV3Api';
import { userStore } from '../data/userStore';
import { NOBODY_ELSE, friendAhead, friendName } from '../data/homeSocial';
import { socialAvailable } from './socialButton.js';

const TTL_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const TMDB_MAX = 999_999_999;

/** clé de carte (`tv:123`) -> réponse reçue pour ce titre : { at, items }. Une entrée = la réponse est arrivée. */
const answers = new Map();
let inflight = false;
let failedAt = 0;
/** Génération : incrémentée à chaque montage (profil ou session changé) ; la réponse d'une génération passée est ignorée. */
let gen = 0;

const kindOf = (key) => (key.startsWith('tv:') ? 'series' : 'movie');
const idOf = (key) => Number(key.slice(key.indexOf(':') + 1));
const validId = (key) => { const n = idOf(key); return Number.isInteger(n) && n >= 1 && n <= TMDB_MAX; };
const initialOf = (f) => Array.from(friendName(f))[0]?.toUpperCase() || '?';
const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3b3750');

function setLine(card, text) {
  let line = card.querySelector('.cont-friend');
  if (!text) { if (line) line.remove(); return; }
  if (!line) {
    line = document.createElement('span');
    line.className = 'cont-friend';
    (card.querySelector('.cont-info') || card).appendChild(line);
  }
  if (line.textContent !== text) line.textContent = text;
}

function setMarker(card, ahead) {
  let mark = card.querySelector('.cont-mark');
  card.classList.toggle('has-mark', !!ahead && ahead.marker != null);
  if (!ahead || ahead.marker == null) { if (mark) mark.remove(); return; }
  if (!mark) {
    mark = document.createElement('span');
    mark.className = 'cont-mark';
    mark.setAttribute('aria-hidden', 'true');
    (card.querySelector('.card-media') || card).appendChild(mark);
  }
  mark.textContent = initialOf(ahead.friend);
  mark.style.background = colorOf(ahead.friend.avatarColor);
  mark.style.setProperty('--p', ahead.marker + '%');
}

/** Complète les cartes affichées avec les réponses déjà reçues ; sans réponse pour un titre, la carte reste telle quelle. */
export function paintContinueSocial(root = document.getElementById('cont-slot'), s = getState()) {
  if (!root) return;
  const entries = new Map(userStore.continueWatching().map((p) => [p.key, p]));
  const muted = new Set((s.friends || []).filter((f) => f.muted).map((f) => f.pid));
  root.querySelectorAll('.cont-card').forEach((card) => {
    const key = card.dataset.resume;
    const ans = answers.get(key);
    const p = entries.get(key);
    if (!ans || !p) { setLine(card, ''); setMarker(card, null); return; }
    const ahead = friendAhead(
      { kind: kindOf(key), season: p.season, episode: p.episode, position: p.position, duration: p.duration, finished: p.finished, suggested: p.suggested },
      ans.items, muted);
    setMarker(card, ahead);
    setLine(card, ahead ? ahead.text : NOBODY_ELSE);
  });
}

/** Demande l'avancée des amis pour les titres affichés qui n'ont pas de réponse récente (un seul appel groupé), puis peint. */
export async function loadContinueSocial() {
  const root = document.getElementById('cont-slot');
  if (!root || !socialAvailable()) return;
  paintContinueSocial(root);
  const now = Date.now();
  if (inflight || now - failedAt < RETRY_MS) return;
  const keys = [...new Set(Array.from(root.querySelectorAll('.cont-card'), (c) => c.dataset.resume))]
    .filter((k) => k && validId(k) && !(answers.has(k) && now - answers.get(k).at < TTL_MS));
  if (!keys.length) return;
  inflight = true;
  const mine = gen;
  let ok = false;
  try {
    const res = await homeProgress(keys.map((k) => ({ type: kindOf(k), tmdbId: idOf(k) })));
    if (mine !== gen) return; // profil précédent : sa réponse ne doit rien écrire (inflight est déjà libéré par le montage suivant)
    const at = Date.now();
    keys.forEach((k) => answers.set(k, { at, items: [] }));
    for (const it of res.items || []) {
      const got = answers.get((it.type === 'series' ? 'tv:' : 'movie:') + it.tmdbId);
      if (got) got.items.push(it);
    }
    ok = true;
  } catch (_) { if (mine === gen) failedAt = Date.now(); } finally { if (mine === gen) inflight = false; }
  if (ok) await loadContinueSocial(); // cartes apparues pendant l'appel ; chaque succès répond à toutes les clés demandées, donc sans boucle
}

/** Ouverture de l'accueil : oublie les réponses, l'appel en cours et l'échec d'un profil ou d'une session précédents, puis charge. */
export function mountContinueSocial() {
  gen += 1;
  inflight = false;
  answers.clear();
  failedAt = 0;
  return loadContinueSocial();
}
