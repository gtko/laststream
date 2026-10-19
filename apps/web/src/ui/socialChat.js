/* Discussion avec un ami (Social v2, lot 3a) : contenu de la vue « conversation » de la barre latérale, branché par
 * setConversationRenderer (socialSidebar.js). Bulles (miennes à droite, les leurs à gauche, heure, « Lu »), messages
 * précédents par pages (loadMessages avant le plus ancien), saisie (Entrée envoie, 1 à 1000 caractères, compteur), lu à
 * l’ouverture et à la réception tant que la discussion est visible, défilement en bas sur un nouveau message, contexte
 * cliquable « à 12:34 dans Dune » qui ouvre le média à cette position. Tout texte passe par textContent. */
import * as store from '../data/socialStore';
import { playAt } from '../data/watchWith';
import { state } from './state.js';

const PAGE = 50;
/** Distance (px) sous laquelle la liste est considérée comme « en bas ». */
const NEAR_BOTTOM_PX = 48;

const pad = (n) => String(n).padStart(2, '0');

/** Heure locale « 09:05 ». */
export const hhmm = (ms) => {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
};

/** Position d’un passage : « 12:34 », ou « 1:02:03 » à partir d’une heure. */
export function posLabel(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

/** Message lisible d’une erreur d’envoi (403 : ni amis ni foyer ; 429 : trop de messages). */
export function sendErrorMessage(err) {
  const status = err ? err.status : undefined;
  if (status === 403) return 'Tu ne peux écrire qu’à tes amis et à ton foyer.';
  if (status === 429) return 'Trop de messages d’un coup : réessaie dans une minute.';
  if (status === 0 || (err && err.code === 'network')) return 'Serveur injoignable pour le moment.';
  return 'Message non envoyé. Réessaie.';
}

/** Titre d’un passage : catalogue, puis relevé de l’ami s’il regarde ce titre ; sinon chaîne vide. */
export function titleOfContext(ctx, friend) {
  const it = state.byKey.get((ctx.type === 'series' ? 'tv' : 'movie') + ':' + ctx.tmdbId);
  if (it && it.name) return it.name;
  const w = friend && friend.watching;
  if (w && w.tmdbId === ctx.tmdbId && w.type === ctx.type && w.title) return w.title;
  return '';
}

/** Libellé du contexte : « à 12:34 dans Dune » ; « dans un titre » si le titre est inconnu. */
export function contextLabel(ctx, title) {
  const at = typeof ctx.pos === 'number' && ctx.pos >= 0 ? 'à ' + posLabel(ctx.pos) + ' ' : '';
  return at + 'dans ' + (title || 'un titre');
}

const button = (cls, text) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
};

/**
 * Fabrique du contenu de la discussion. `launch` lance la lecture normale (playBest) ; `toast` affiche un message.
 * Renvoie la fonction passée à setConversationRenderer : `({ el, pid, friend })`. Un nouvel appel remplace le précédent
 * (son abonnement au store est levé).
 */
export function createConversationRenderer({ launch, toast }) {
  let teardown = null;

  return function renderConversation({ el, pid, friend }) {
    if (teardown) teardown();
    teardown = null;
    el.textContent = '';

    const wrap = document.createElement('div');
    wrap.className = 'ss-chat';
    const more = button('btn btn-ghost btn-sm ss-chat-more', 'Charger les messages précédents');
    more.hidden = true;
    const log = document.createElement('div');
    log.className = 'ss-chat-log';
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    const status = document.createElement('p');
    status.className = 'ss-chat-status';
    status.setAttribute('role', 'status');
    const form = document.createElement('form');
    form.className = 'wp-send';
    form.noValidate = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'text';
    input.autocomplete = 'off';
    input.placeholder = 'Écrire un message';
    input.setAttribute('aria-label', 'Message');
    const send = button('btn btn-primary btn-sm', 'Envoyer');
    send.type = 'submit';
    form.append(input, send);
    const count = document.createElement('p');
    count.className = 'ss-chat-count';
    wrap.append(more, log, status, form, count);
    el.append(wrap);

    let alive = true;
    let hasMore = false;
    // Chargement initial lancé tout de suite : pas de « Aucun message » provisoire.
    let loading = true;
    let loadFailed = false;
    let sending = false;
    let marking = false;
    let markOff = false;
    let painted = false;
    let lastSig = null;
    let lastNewest = null;
    let lastOldest = null;

    /** Visible = connectée et sans ancêtre masqué (barre fermée ou autre vue). */
    const visible = () => alive && el.isConnected && !el.closest('[hidden]');
    const myPid = () => {
      const s = store.getState();
      return s.me ? s.me.pid : '';
    };
    const listOf = (s = store.getState()) => s.messages[pid] || [];
    const setStatus = (text, tone) => {
      status.textContent = text || '';
      if (tone) status.dataset.tone = tone;
      else delete status.dataset.tone;
    };

    function contextButton(ctx) {
      const title = titleOfContext(ctx, friend);
      const btn = button('ss-chat-ctx', contextLabel(ctx, title));
      btn.title = 'Ouvrir ce passage dans le lecteur';
      btn.addEventListener('click', () => {
        playAt({ launch, toast }, { type: ctx.type, tmdbId: ctx.tmdbId, title, season: ctx.season, episode: ctx.episode },
          typeof ctx.pos === 'number' ? ctx.pos : 0, btn);
      });
      return btn;
    }

    function bubble(m, me) {
      const mine = m.from === me;
      const row = document.createElement('div');
      row.className = 'ss-bub-row ' + (mine ? 'is-mine' : 'is-theirs');
      const bub = document.createElement('div');
      bub.className = 'ss-bub';
      const text = document.createElement('p');
      text.className = 'ss-bub-text';
      text.textContent = m.body;
      bub.append(text);
      if (m.context) bub.append(contextButton(m.context));
      const meta = document.createElement('p');
      meta.className = 'ss-bub-meta';
      const time = document.createElement('time');
      if (Number.isFinite(m.createdAt)) {
        time.dateTime = new Date(m.createdAt).toISOString();
        time.textContent = hhmm(m.createdAt);
      }
      meta.append(time);
      if (mine && m.readAt) meta.append(' · Lu');
      bub.append(meta);
      row.append(bub);
      return row;
    }

    /** Reconstruit la liste si son contenu a changé. Nouveau message en bas : défilement si on y était ou si c’est le mien ; page précédente : la position reste au même endroit. */
    function paintLog(list) {
      const sig = list.map((m) => m.id + (m.readAt ? '+' : '')).join('|');
      if (painted && sig === lastSig) return;
      const me = myPid();
      const dist = log.scrollHeight - log.scrollTop;
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX;
      const newest = list.length ? list[list.length - 1].id : null;
      const oldest = list.length ? list[0].id : null;
      const first = !painted;
      const appended = !first && newest !== lastNewest;
      const prepended = !first && !appended && oldest !== lastOldest;
      const last = list[list.length - 1];

      log.textContent = '';
      if (!list.length) {
        if (!loading) {
          const empty = document.createElement('p');
          empty.className = 'wp-empty';
          empty.textContent = 'Aucun message pour l’instant. Écris le premier !';
          log.append(empty);
        }
      } else {
        for (const m of list) log.append(bubble(m, me));
      }
      lastSig = sig;
      lastNewest = newest;
      lastOldest = oldest;
      painted = true;
      if (first || (appended && (nearBottom || (last && last.from === me)))) log.scrollTop = log.scrollHeight;
      else if (prepended) log.scrollTop = log.scrollHeight - dist;
    }

    function paintMore() {
      more.hidden = !(hasMore || loadFailed);
      more.disabled = loading;
      more.textContent = loadFailed ? 'Réessayer le chargement' : 'Charger les messages précédents';
    }

    function updateForm() {
      const n = Array.from(input.value.trim()).length;
      const over = n > store.MESSAGE_MAX;
      count.textContent = n + ' / ' + store.MESSAGE_MAX;
      count.classList.toggle('is-over', over);
      send.disabled = sending || n === 0 || over;
    }

    /** Premier chargement : les plus récents. `hasMore` reste vrai si la page est pleine. */
    async function loadFirst() {
      loading = true;
      loadFailed = false;
      setStatus('');
      lastSig = null;
      paintLog(listOf());
      paintMore();
      try {
        const merged = await store.loadMessages(pid, { limit: PAGE });
        hasMore = merged.length >= PAGE;
      } catch {
        loadFailed = true;
      }
      loading = false;
      if (!alive) return;
      setStatus(loadFailed ? 'Messages indisponibles pour le moment.' : '', loadFailed ? 'error' : '');
      lastSig = null;
      paintLog(listOf());
      paintMore();
    }

    /**
     * Page précédente : avant le plus ancien message chargé. Le compteur réel de l’API n’est pas exposé par le store :
     * « d’autres messages » = la fusion a grandi. Une page sans rien de nouveau masque le bouton.
     */
    async function loadOlder() {
      const list = listOf();
      if (loading || !list.length) return;
      loading = true;
      paintMore();
      const prev = list.length;
      try {
        const merged = await store.loadMessages(pid, { before: list[0].createdAt, limit: PAGE });
        hasMore = merged.length > prev;
      } catch {
        hasMore = true;
        if (alive) toast('Messages précédents indisponibles pour le moment.');
      }
      loading = false;
      if (!alive) return;
      paintLog(listOf());
      paintMore();
    }

    /** Marque tout lu avec ce correspondant. Un échec coupe les essais pour cette discussion (pas de boucle sur les notifications du store). */
    function markNow() {
      if (marking || markOff) return;
      marking = true;
      Promise.resolve()
        .then(() => store.markRead(pid))
        .catch(() => { markOff = true; })
        .finally(() => { marking = false; });
    }

    async function sendText() {
      const text = input.value.trim();
      if (sending || !text) return;
      if (Array.from(text).length > store.MESSAGE_MAX) {
        setStatus('Message trop long : ' + store.MESSAGE_MAX + ' caractères au maximum.', 'error');
        return;
      }
      sending = true;
      setStatus('');
      updateForm();
      try {
        await store.sendMessage(pid, text);
        if (input.value.trim() === text) input.value = '';
      } catch (err) {
        if (alive) setStatus(sendErrorMessage(err), 'error');
      }
      sending = false;
      if (alive) {
        updateForm();
        input.focus();
      }
    }

    /** Réaction au store : nouveau message ou changement de lecture ; lu tout de suite si la discussion est visible et qu’un message non lu arrive. */
    function onState(s) {
      if (!visible()) return;
      paintLog(listOf(s));
      const conv = s.conversations.find((c) => c.pid === pid);
      if (conv && conv.unread > 0) markNow();
    }

    input.addEventListener('input', updateForm);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void sendText();
    });
    more.addEventListener('click', () => {
      if (loadFailed) void loadFirst();
      else void loadOlder();
    });

    const unsub = store.subscribe(onState);
    teardown = () => {
      alive = false;
      unsub();
    };

    updateForm();
    paintLog(listOf());
    markNow();
    void loadFirst();
  };
}
