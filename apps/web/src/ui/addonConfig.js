// Configuration d'un addon sans quitter l'app : fenêtre d'avertissement (clé du débrideur), puis la page /configure de
// l'addon dans une fenêtre, avec collage (ou détection) du lien d'installation. Aucune adresse n'est jamais écrite dans
// l'interface, les journaux ni les messages : elles contiennent souvent la clé du débrideur ; seuls l'hôte et le nom s'affichent.
import { modal, modalBody, toast } from './dom.js';
import { closeModal, openModal } from './modal.js';
import { esc } from './util.js';

const MAX_LINK = 2048;

/**
 * Adresse https d'un lien d'installation Stremio (`stremio://…` ou `http(s)://…` finissant par /manifest.json, query ignorée)
 * si `text` en est un (une seule ligne, 2048 caractères au plus) ; sinon ''.
 */
export function extractInstallLink(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > MAX_LINK || /[\r\n]/.test(raw) || !/^(stremio|https?):\/\//i.test(raw)) return '';
  const link = raw.replace(/^stremio:\/\//i, 'https://');
  try {
    const u = new URL(link);
    return /\/manifest\.json$/i.test(u.pathname) ? link : '';
  } catch (_) { return ''; }
}

/** Faux si la page n'est pas http(s), ou si elle est en http alors que l'app est servie en https (contenu mixte bloqué). */
export function canEmbed(pageUrl, pageProtocol = location.protocol) {
  try {
    const u = new URL(String(pageUrl || ''));
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && pageProtocol !== 'https:';
  } catch (_) { return false; }
}

function hostOf(link) {
  try { return new URL(link).hostname; } catch (_) { return ''; }
}

/**
 * Fenêtre d'avertissement. Rien de tiers n'est chargé avant « J’ai compris, continuer ».
 * `opts` : { name, page, openOutside(url), onApply(link) }.
 */
export function openAddonConfig(opts, opener) {
  const name = opts.name || 'l’addon';
  openModal(
    '<div class="addon-cfg-pane">' +
    '<h2 id="modal-title">Configurer ' + esc(name) + '</h2>' +
    '<p>La page de configuration est celle de l’addon, pas celle de Laststream. Ne saisis ta clé de débrideur que dans les addons dont tu acceptes qu’ils débrident depuis leurs serveurs.</p>' +
    '<details><summary>En savoir plus</summary><p class="set-hint">Un addon appelle le débrideur depuis ses propres serveurs, dont les adresses sont celles d’un datacenter. ' +
    'Un débrideur peut suspendre un compte appelé de cette façon. Laststream, lui, appelle le débrideur depuis ton appareil.</p></details>' +
    '<div class="addon-cfg-actions"><button type="button" class="btn btn-ghost" data-acw-cancel>Annuler</button>' +
    '<button type="button" class="btn" data-acw-go>J’ai compris, continuer</button></div></div>',
    opener, 'addon-cfg-warn');
  const cancel = modalBody.querySelector('[data-acw-cancel]');
  cancel.addEventListener('click', () => closeModal());
  modalBody.querySelector('[data-acw-go]').addEventListener('click', () => showConfigWindow(opts));
  cancel.focus();
}

function showConfigWindow({ name: rawName, page, openOutside, onApply }) {
  const name = rawName || 'l’addon';
  let sameOrigin = false;
  try { sameOrigin = new URL(page).origin === location.origin; } catch (_) { sameOrigin = false; }
  const embed = canEmbed(page) && !sameOrigin;
  const pageHost = hostOf(page);
  openModal(
    '<div class="addon-cfg-head"><h2 id="modal-title">Configurer ' + esc(name) + '</h2>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-acw-out>Ouvrir dans le navigateur</button></div>' +
    '<p class="set-hint addon-cfg-empty">Page de ' + esc(pageHost) + '. Page vide ? Ouvre-la dans le navigateur.</p>' +
    '<div class="addon-cfg-view">' + (embed
      ? '<iframe src="' + esc(page) + '" title="' + esc('Configuration de ' + name) +
        '" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" allow="clipboard-write" referrerpolicy="no-referrer" loading="eager"></iframe>'
      : '<p class="addon-cfg-noembed">Cette page ne peut pas s’afficher dans l’app : ouvre-la dans le navigateur.</p>') + '</div>' +
    '<div class="addon-cfg-foot"><p class="set-hint">Quand la page affiche le lien d’installation, copie-le puis colle-le ici. Utilise « Copier le lien », pas « Installer ».</p>' +
    '<label class="sr-only" for="acw-link">Lien d’installation</label>' +
    '<div class="addon-cfg-row"><input type="text" id="acw-link" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://… ou stremio://…/manifest.json">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-acw-paste>Coller</button>' +
    '<button type="button" class="btn btn-sm" data-acw-use>Utiliser ce lien</button></div>' +
    '<p class="set-hint addon-cfg-status" aria-live="polite"></p></div>',
    undefined, 'addon-cfg');
  const input = modalBody.querySelector('#acw-link');
  const status = modalBody.querySelector('.addon-cfg-status');
  const say = (msg) => { status.textContent = msg; };
  let lastDetected = ''; // lien mémorisé (collé ou détecté) : jamais écrit dans le champ
  const ac = new AbortController();

  modalBody.querySelector('[data-acw-out]').addEventListener('click', () => { void openOutside(page); });

  const readClipboard = async () => {
    try { return navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : ''; } catch (_) { return ''; }
  };
  const apply = async (link) => {
    let r;
    try { r = await onApply(link); } catch (_) { r = { status: 'ko' }; }
    const st = (r && r.status) || 'ok';
    if (st === 'ko') {
      // Sans adresse : un message d'erreur ne doit jamais contenir la clé du débrideur.
      const why = String((r && r.error) || 'vérifie le lien.').replace(/(?:https?|stremio):\/\/\S+/gi, '').trim();
      say('Lien lu, mais l’addon ne répond pas : ' + (why || 'vérifie le lien.'));
      return;
    }
    ac.abort();
    closeModal();
    toast('Lien appliqué : ' + name + (st === 'warn' ? ', mais sans ressource « stream »' : '') + '. Enregistre la page pour valider.');
  };
  const useField = () => {
    const typed = input.value.trim();
    const link = typed ? extractInstallLink(typed) : lastDetected;
    if (!link) { say(typed ? 'Ce n’est pas un lien d’installation : il doit finir par /manifest.json.' : 'Colle d’abord le lien d’installation.'); input.focus(); return Promise.resolve(); }
    return apply(link);
  };

  modalBody.querySelector('[data-acw-paste]').addEventListener('click', async () => {
    const link = extractInstallLink(await readClipboard());
    if (!link) {
      say('Pas de lien d’installation dans le presse-papiers : copie le lien, puis colle-le dans le champ.');
      input.focus();
      return;
    }
    lastDetected = link;
    say('Lien lu : ' + hostOf(link) + '.');
    await apply(link);
  });
  modalBody.querySelector('[data-acw-use]').addEventListener('click', () => { void useField(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void useField(); } });

  // Détection au retour au premier plan (après une copie), seulement si la lecture est déjà autorisée : aucune invite surprise.
  const onBack = async () => {
    if (modal.hidden || !input.isConnected) { ac.abort(); return; }
    if (document.visibilityState === 'hidden') return;
    try {
      const perm = navigator.permissions && navigator.permissions.query ? await navigator.permissions.query({ name: /** @type {any} */ ('clipboard-read') }) : null;
      if (!perm || perm.state !== 'granted') return;
    } catch (_) { return; }
    const link = extractInstallLink(await readClipboard());
    if (!link || link === lastDetected || !input.isConnected) return;
    lastDetected = link;
    say('Lien détecté dans le presse-papiers : ' + hostOf(link) + '. Clique « Utiliser ce lien ».');
  };
  window.addEventListener('focus', onBack, { signal: ac.signal });
  document.addEventListener('visibilitychange', onBack, { signal: ac.signal });
}
