/* Réglages > Sources et debrid : débrideurs de l'appareil (AllDebrid, TorBox, Real-Debrid).
 * Clés gardées UNIQUEMENT sur cet appareil (jamais envoyées au serveur), ordre de priorité réordonnable, état de chaque compte.
 * Aucun appel réseau à l'ouverture : l'état affiché est le dernier connu ; « Tester » fait un appel depuis cet appareil. */
import { debrid, PROVIDER_IDS, PROVIDER_LABEL } from '../sources/debridClient';
import { card } from './settings-ui.js';
import { esc } from './util.js';
import { toast } from './dom.js';

const STATE_TEXT = {
  ok: 'OK',
  suspended: 'Suspendu',
  quota: 'Quota atteint',
  invalid_key: 'Clé invalide',
  not_premium: 'Non premium',
  unreachable: 'Injoignable',
  unsupported: 'Non pris en charge ici',
};

const pad = (n) => String(n).padStart(2, '0');
const when = (t) => { const d = new Date(t); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

/** Libellé et classe d'état d'un fournisseur : « OK », « Suspendu jusqu’au 19/10 03:10 », « Pas de clé »… (fonction pure sur le gestionnaire). */
export function providerState(mgr, id, now = Date.now()) {
  const blocked = mgr.blockedReason(id);
  if (blocked === 'no_key') return { cls: 'none', text: 'Pas de clé' };
  if (blocked === 'web_unsupported') return { cls: 'ko', text: 'Application Windows ou Android requise (le navigateur ne peut pas appeler ce service)' };
  const h = mgr.healthOf(id);
  if (!h) return { cls: 'unknown', text: 'Non testé' };
  if (h.state === 'ok') return { cls: 'ok', text: STATE_TEXT.ok };
  const active = h.until !== undefined && h.until > now;
  const base = STATE_TEXT[h.state] || h.state;
  return { cls: active ? 'ko' : 'unknown', text: base + (active && h.state !== 'invalid_key' ? ' jusqu’au ' + when(h.until) : '') };
}

function rowHTML(mgr, id, pos, count) {
  const st = providerState(mgr, id);
  const has = mgr.hasKey(id);
  return '<div class="set-row is-stack" data-nav data-deb-row="' + id + '">' +
    '<div class="set-row-t"><span class="set-row-l">' + (pos + 1) + '. ' + esc(PROVIDER_LABEL[id]) + '</span>' +
    '<span class="set-row-d" data-deb-state="' + id + '"><span class="set-dot is-' + st.cls + '"></span> ' + esc(st.text) + '</span></div>' +
    '<div class="set-row-c">' +
    '<input class="set-input" type="password" autocomplete="off" data-deb-key="' + id + '" aria-label="Clé ' + esc(PROVIDER_LABEL[id]) + '" placeholder="' + (has ? 'Clé enregistrée sur cet appareil' : 'Colle ta clé API') + '">' +
    '<div class="set-actions">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-deb="save" data-id="' + id + '">Enregistrer</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-deb="test" data-id="' + id + '"' + (has ? '' : ' disabled') + '>Tester</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-deb="clear" data-id="' + id + '"' + (has ? '' : ' disabled') + '>Retirer</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-deb="up" data-id="' + id + '" aria-label="Monter la priorité"' + (pos === 0 ? ' disabled' : '') + '>▲</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-deb="down" data-id="' + id + '" aria-label="Baisser la priorité"' + (pos === count - 1 ? ' disabled' : '') + '>▼</button>' +
    '</div></div></div>';
}

/** Carte « Débrideurs de cet appareil » : une ligne par fournisseur, dans l'ordre de priorité. */
export function debridCardHTML() {
  const mgr = debrid();
  const order = mgr.settings().order;
  return card('Débrideurs de cet appareil',
    '<div id="set-debrid">' + order.map((id, i) => rowHTML(mgr, id, i, order.length)).join('') + '</div>',
    { desc: 'Les clés restent sur cet appareil : elles ne sont jamais envoyées au serveur. Une source est « en cache » si au moins un service l’a ; la lecture passe par le premier service disponible qui l’a en cache, puis par le suivant si un compte est suspendu ou à court de quota.' });
}

function rerender() {
  const box = document.getElementById('set-debrid');
  if (!box) return;
  const mgr = debrid();
  const order = mgr.settings().order;
  box.innerHTML = order.map((id, i) => rowHTML(mgr, id, i, order.length)).join('');
}

const stateLine = (id) => {
  const el = document.querySelector('[data-deb-state="' + id + '"]');
  return el;
};

async function onClick(e) {
  const btn = e.target instanceof Element ? e.target.closest('[data-deb]') : null;
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!PROVIDER_IDS.includes(id)) return;
  const mgr = debrid();
  const action = btn.getAttribute('data-deb');
  if (action === 'save') {
    const input = document.querySelector('[data-deb-key="' + id + '"]');
    const value = input && input.value.trim();
    if (!value) { toast('Colle la clé ' + PROVIDER_LABEL[id] + ' dans le champ.'); return; }
    mgr.setKey(id, value);
    toast('Clé ' + PROVIDER_LABEL[id] + ' enregistrée sur cet appareil.');
    rerender();
  } else if (action === 'clear') {
    mgr.setKey(id, '');
    rerender();
  } else if (action === 'up' || action === 'down') {
    const order = mgr.settings().order.slice();
    const i = order.indexOf(id);
    const j = action === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    mgr.setOrder(order);
    rerender();
  } else if (action === 'test') {
    btn.disabled = true;
    const line = stateLine(id);
    if (line) line.textContent = 'Test en cours…';
    try { await mgr.refreshStatus(id); } catch { /* état conservé */ }
    rerender();
  }
}

let bound = false;
/** Écouteur délégué, posé une seule fois (le contenu de la carte est recréé à chaque action). */
export function bindDebrid() {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (e) => { void onClick(e); });
}
