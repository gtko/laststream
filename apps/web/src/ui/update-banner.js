/* Bannière « Mise à jour disponible (vX) — Installer » de l'application Android. Contrôle au lancement puis au plus toutes
 * les 24 h ; le téléchargement, la vérification SHA-256 et l'installeur système sont dans le plugin natif LaststreamUpdate. */
import {
  bannerModel, checkForUpdate, dismiss, INSTALL_MESSAGES, installUpdate, sizeLabel, updateSupported,
} from '../data/appUpdate';

const RECHECK_MS = 60 * 60 * 1000; // l'application peut rester ouverte des jours : on revérifie si 24 h sont passées

let banner = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function close() {
  if (banner) banner.remove();
  banner = null;
}

/** Affiche la bannière pour un manifeste ; `deps` permet de substituer l'installation en test. */
export function showUpdateBanner(manifest, deps = {}) {
  close();
  const install = deps.install || installUpdate;
  const model = bannerModel(manifest);
  const root = el('div', 'upd-banner');
  root.setAttribute('role', 'status');
  const msg = el('p', 'upd-text', model.text);
  const sub = el('p', 'upd-sub', [sizeLabel(manifest.size), manifest.notes].filter(Boolean).join(' · '));
  sub.hidden = !sub.textContent;
  const info = el('div', 'upd-info');
  info.append(msg, sub);
  const go = el('button', 'upd-go', model.action);
  go.type = 'button';
  const x = el('button', 'upd-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Plus tard');
  x.addEventListener('click', () => { dismiss(manifest); close(); });
  go.addEventListener('click', async () => {
    go.disabled = true;
    x.hidden = true;
    sub.hidden = false;
    sub.textContent = 'Téléchargement…';
    const result = await install(manifest, (p) => { if (p >= 0) sub.textContent = `Téléchargement… ${p} %`; });
    if (result === 'started') {
      sub.textContent = 'Installation : valide l’écran Android qui s’ouvre.';
      go.disabled = false;
      x.hidden = false;
      return;
    }
    sub.textContent = INSTALL_MESSAGES[result] || INSTALL_MESSAGES.network;
    go.disabled = false;
    x.hidden = false;
  });
  root.append(info, go, x);
  document.body.append(root);
  banner = root;
  return root;
}

/** À appeler une fois l'application affichée : sans effet hors application Android. */
export function initUpdateBanner() {
  if (!updateSupported()) return;
  const run = async () => {
    if (banner) return;
    const m = await checkForUpdate();
    if (m) showUpdateBanner(m);
  };
  run();
  setInterval(run, RECHECK_MS);
}
