/* « Proposer une watch party » (Social v3, ODY-173) : fenêtre de création quand aucun titre n'est en lecture. On cherche un film ou
 * une série (TMDB), on règle saison / épisode d'une série et la visibilité, puis le salon d'attente est créé et l'ami de la
 * conversation (ou les amis cochés dans un partage) est invité. La watch party synchronise des comptes : chacun lit avec sa propre source. */
import '../styles/convwin.css';
import { isKidProfile } from '../data/auth';
import { tmdb } from '../data/lt';
import { partyVisibilityChoices } from '../party/bridge';
import { safeTmdbImage } from './safeImg.js';
import { sortedFriends } from './partyfriends.js';
import { h } from './socialConvDom.js';
import { openDialog } from './socialConvDialog.js';
import { nameOf } from './socialFmt.js';

const SEARCH_MIN = 2;
const SEARCH_MAX = 8;
const SEARCH_DELAY_MS = 250;

/** Résultats TMDB (search/multi) -> films et séries affichables : { type: 'movie'|'tv', id, name, year, poster }. */
export function titleRows(results) {
  const rows = Array.isArray(results) ? results : [];
  return rows
    .filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv') && Number.isInteger(r.id) && (r.title || r.name))
    .slice(0, SEARCH_MAX)
    .map((r) => ({
      type: r.media_type, id: r.id, name: String(r.title || r.name),
      year: String(r.release_date || r.first_air_date || '').slice(0, 4), poster: r.poster_path || null,
    }));
}

/** Saisons réelles d'une série (hors épisodes spéciaux, saison 0) : [{ n, episodes }] ; vide si la fiche n'en donne pas. */
export function seasonChoices(details) {
  const list = details && Array.isArray(details.seasons) ? details.seasons : [];
  return list
    .filter((s) => s && Number.isInteger(s.season_number) && s.season_number >= 1)
    .map((s) => ({ n: s.season_number, episodes: Number.isInteger(s.episode_count) && s.episode_count > 0 ? s.episode_count : 1 }))
    .sort((a, b) => a.n - b.n);
}

/** Cible de lecture attendue par `createLobbyFor` ; une série démarre à la saison et à l'épisode choisis (1 et 1 par défaut). */
export function requestOfPick(pick, season = 1, episode = 1) {
  const tv = pick.type === 'tv';
  return { type: pick.type, id: String(pick.id), name: pick.name, season: tv ? season : null, episode: tv ? episode : null, key: pick.type + ':' + pick.id };
}

/** Phrase sous le choix : qui sera invité. */
export function inviteNote(names) {
  if (!names.length) return 'Aucun ami invité : tu pourras partager le lien depuis le salon.';
  if (names.length === 1) return names[0] + ' sera invité(e) dans le salon d’attente.';
  return names.length + ' amis seront invités dans le salon d’attente.';
}

let current = null;

function friendName(pid) {
  const f = sortedFriends().find((x) => x.pid === pid);
  return f ? nameOf(f) : 'Ton ami';
}

function numberOptions(select, count, label, value) {
  select.textContent = '';
  for (let i = 1; i <= count; i++) {
    const o = h('option', null, label + ' ' + i, { value: i });
    if (i === value) o.selected = true;
    select.append(o);
  }
}

/**
 * Ouvre la fenêtre pour inviter `pid`. Déjà ouverte (partage à plusieurs amis) : l'ami est ajouté à la liste des invités.
 * `create(req, poster, visibility, from, invite)` : `createLobbyFor` du salon d'attente.
 */
export function openPartyCreate(pid, create) {
  if (current && current.box.isConnected) {
    current.pids.add(pid);
    current.paintNote();
    return;
  }
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const pids = new Set([pid]);
  const st = { pick: null, seasons: [], season: 1, episode: 1, visibility: 'private', seq: 0, timer: 0 };
  let paintNote = () => {};
  const dlg = openDialog({
    title: 'Proposer une watch party', confirmLabel: 'Ouvrir le salon d’attente', opener,
    build(body, ctl) {
      const intro = h('p', 'cvd-hint', 'Choisis un film ou une série. Chacun lit avec sa propre source : seuls les amis Laststream sont invités.');
      const search = h('div', 'wpc-search');
      const input = h('input', 'cvd-input', null, { type: 'search', placeholder: 'Chercher un film ou une série…', autocomplete: 'off', 'aria-label': 'Chercher un film ou une série' });
      const status = h('p', 'cvd-hint wpc-status', '', { role: 'status' });
      const results = h('ul', 'wpc-res', null, { 'aria-label': 'Résultats' });
      search.append(input, status, results);

      const chosen = h('div', 'wpc-chosen');
      const card = h('div', 'wpc-card');
      const poster = h('span', 'wpc-poster');
      const cardText = h('span', 'wpc-card-t');
      const change = h('button', 'cvm-btn wpc-change', 'Changer', { type: 'button' });
      card.append(poster, cardText, change);
      const epRow = h('div', 'wpc-eps');
      const seasonSel = h('select', 'cvd-input', null, { 'aria-label': 'Saison' });
      const episodeSel = h('select', 'cvd-input', null, { 'aria-label': 'Épisode' });
      epRow.append(seasonSel, episodeSel);
      const vis = h('div', 'wpc-vis', null, { role: 'radiogroup', 'aria-label': 'Qui peut rejoindre' });
      const choices = partyVisibilityChoices(isKidProfile());
      for (const [value, label, hint] of [['private', 'Privé', 'Amis invités'], ['public', 'Public', 'Listé dans « Watch parties »']]) {
        if (!choices.includes(value)) continue;
        const l = h('label', 'wpc-vis-o');
        const r = h('input', null, null, { type: 'radio', name: 'wpc-vis', value });
        if (value === 'private') r.checked = true;
        r.addEventListener('change', () => { st.visibility = value; });
        const t = h('span');
        t.append(h('b', null, label), h('i', null, hint));
        l.append(r, t);
        vis.append(l);
      }
      const note = h('p', 'cvd-hint');
      chosen.append(card, epRow, vis);
      // Un seul des deux blocs est dans le DOM à la fois : le piège de focus d'openDialog ne voit pas un bloc masqué.
      const slot = h('div', 'wpc-slot');
      slot.append(search);
      body.append(intro, slot, note);

      paintNote = () => { note.textContent = inviteNote([...pids].map(friendName)); };
      paintNote();

      const showSearch = () => {
        st.pick = null;
        st.seq++;
        slot.replaceChildren(search);
        ctl.setValid(false);
        input.focus();
      };
      const choose = (row) => {
        clearTimeout(st.timer);
        st.pick = row;
        st.seasons = [];
        st.season = 1;
        st.episode = 1;
        slot.replaceChildren(chosen);
        const src = safeTmdbImage(row.poster, 'w92');
        poster.textContent = '';
        if (src) { const im = h('img', null, null, { alt: '', loading: 'lazy' }); im.src = src; poster.append(im); }
        cardText.textContent = '';
        cardText.append(h('b', null, row.name), h('span', 'cvd-hint', (row.type === 'tv' ? 'Série' : 'Film') + (row.year ? ' · ' + row.year : '')));
        epRow.hidden = row.type !== 'tv';
        ctl.setValid(true);
        if (row.type !== 'tv') { change.focus(); return; }
        numberOptions(seasonSel, 1, 'Saison', 1);
        numberOptions(episodeSel, 1, 'Épisode', 1);
        const my = ++st.seq;
        tmdb('tv/' + row.id).then((d) => {
          if (my !== st.seq || st.pick !== row) return;
          st.seasons = seasonChoices(d);
          if (!st.seasons.length) return;
          seasonSel.textContent = '';
          for (const s of st.seasons) seasonSel.append(h('option', null, 'Saison ' + s.n, { value: s.n }));
          st.season = st.seasons[0].n;
          numberOptions(episodeSel, st.seasons[0].episodes, 'Épisode', 1);
        }, () => { /* sans détail : saison 1, épisode 1 */ });
        change.focus();
      };
      change.addEventListener('click', showSearch);
      seasonSel.addEventListener('change', () => {
        st.season = Number(seasonSel.value) || 1;
        st.episode = 1;
        const s = st.seasons.find((x) => x.n === st.season);
        numberOptions(episodeSel, s ? s.episodes : 1, 'Épisode', 1);
      });
      episodeSel.addEventListener('change', () => { st.episode = Number(episodeSel.value) || 1; });

      async function run() {
        const q = input.value.trim();
        const my = ++st.seq;
        results.textContent = '';
        if (q.length < SEARCH_MIN) { status.textContent = q ? 'Tape au moins deux lettres.' : ''; return; }
        status.textContent = 'Recherche…';
        let rows;
        try {
          const out = await tmdb('search/multi', { query: q, include_adult: 'false' });
          rows = titleRows(out && out.results);
        } catch {
          if (my === st.seq) status.textContent = 'Recherche indisponible pour le moment.';
          return;
        }
        if (my !== st.seq) return;
        status.textContent = rows.length ? '' : 'Aucun résultat.';
        for (const row of rows) {
          const li = h('li');
          const b = h('button', 'wpc-r', null, { type: 'button' });
          const p = h('span', 'wpc-poster');
          const src = safeTmdbImage(row.poster, 'w92');
          if (src) { const im = h('img', null, null, { alt: '', loading: 'lazy' }); im.src = src; p.append(im); }
          const t = h('span', 'wpc-card-t');
          t.append(h('b', null, row.name), h('span', 'cvd-hint', (row.type === 'tv' ? 'Série' : 'Film') + (row.year ? ' · ' + row.year : '')));
          b.append(p, t);
          b.addEventListener('click', () => choose(row));
          li.append(b);
          results.append(li);
        }
      }
      input.addEventListener('input', () => { clearTimeout(st.timer); st.timer = setTimeout(() => { void run(); }, SEARCH_DELAY_MS); });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        clearTimeout(st.timer);
        void run().then(() => { const f = results.querySelector('button'); if (f) f.focus(); });
      });
    },
    onConfirm: async () => {
      if (!st.pick) throw new Error('Choisis d’abord un film ou une série.');
      clearTimeout(st.timer);
      const req = requestOfPick(st.pick, st.season, st.episode);
      const visibility = st.visibility === 'public' && !isKidProfile() ? 'public' : 'private';
      current = null;
      void create(req, st.pick.poster, visibility, opener, [...pids]);
    },
  });
  current = { box: dlg.el, pids, paintNote: () => paintNote() };
}
