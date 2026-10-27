/* Téléchargement web « Sur cet appareil » (LAST-498) : dossier choisi (Chrome/Edge bureau) ou téléchargement du navigateur.
 * Ce qui demande un geste de l'utilisateur (permission du dossier, ouverture de l'onglet) est fait AVANT d'attendre le lien :
 * un navigateur bloque un onglet ouvert après une attente réseau. Aucun lien n'est affiché ni journalisé. */
import { resolveDeviceLink } from '../downloads/service';
import { errorMessage } from '../downloads/viewModel';
import { browserDownload, CorsBlockedError, folderPickerSupported, folderWritable, getSaveFolder, openBrowserTab, safeFileName, writeToFolder } from '../downloads/webSave';
import { toast } from './dom.js';

/** Dernier segment du chemin du lien, s'il ressemble à un nom de fichier (extension courte). */
function nameFromUrl(url) {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return /\.[a-z0-9]{2,5}$/i.test(seg) ? seg : '';
  } catch (_) {
    return '';
  }
}

/** Nom du fichier enregistré : celui de la source, sinon celui du lien, sinon le titre. */
const fileNameOf = (file, label) => safeFileName(file.filename || nameFromUrl(file.url), label + '.mkv');

/** Dossier choisi et accessible, ou null (pas de dossier, navigateur sans File System Access, permission refusée). */
async function writableFolder() {
  if (!folderPickerSupported()) return null;
  const folder = await getSaveFolder();
  if (!folder) return null;
  if (await folderWritable(folder, true)) return folder;
  toast('Accès au dossier « ' + folder.name + ' » refusé : le navigateur enregistre le fichier dans son dossier de téléchargements.');
  return null;
}

/** Confie le lien au navigateur : onglet d'attente s'il est ouvert, sinon onglet ouvert maintenant, sinon un bouton à cliquer. */
function handToBrowser(tab, file, name, label) {
  const open = tab || openBrowserTab();
  if (open) {
    open.go(file.url);
    toast('Téléchargement confié au navigateur · ' + label, { ms: 4000 });
    return;
  }
  toast('Le navigateur a bloqué l’ouverture du téléchargement.', { action: { label: 'Télécharger', run: () => browserDownload(file.url, name) }, ms: 15000 });
}

/**
 * Enregistre la source choisie sur l'appareil. À appeler directement depuis le clic de choix (pas d'attente avant).
 * `onProgress(texte)` : avancement à afficher sur le contrôle (null à la fin). Ne lève jamais : les erreurs deviennent des toasts.
 */
export async function saveToDevice(t, choice, label, onProgress = () => undefined) {
  // Sans File System Access, l'onglet s'ouvre tout de suite (pendant le clic).
  let tab = folderPickerSupported() ? null : openBrowserTab();
  const folder = tab ? null : await writableFolder();
  if (!folder && !tab) tab = openBrowserTab();
  const ctl = new AbortController();
  let file;
  try {
    file = await resolveDeviceLink(t, choice, ctl.signal);
  } catch (err) {
    if (tab) tab.close();
    toast(errorMessage((err && err.code) || 'resolve_failed'));
    return false;
  }
  const name = fileNameOf(file, label);
  if (!folder) { handToBrowser(tab, file, name, label); return true; }
  toast('Enregistrement dans « ' + folder.name + ' » · ' + label, { ms: 3500 });
  try {
    await writeToFolder(folder, name, file.url, {
      signal: ctl.signal,
      onProgress: (done, total) => onProgress(total ? Math.min(99, Math.floor((done / total) * 100)) + ' %' : Math.round(done / 1048576) + ' Mo'),
    });
    toast('Enregistré dans « ' + folder.name + ' » : ' + name, { ms: 5000 });
    return true;
  } catch (err) {
    if (err instanceof CorsBlockedError) {
      // L'hébergeur interdit la lecture par la page (AllDebrid) : seul le navigateur peut l'enregistrer, dans son propre dossier.
      toast('L’hébergeur de ce fichier interdit l’écriture directe dans ton dossier : il passe par les téléchargements du navigateur.', { ms: 6000 });
      handToBrowser(null, file, name, label);
      return true;
    }
    toast(errorMessage((err && err.code) || 'network'));
    return false;
  } finally {
    onProgress(null);
  }
}

/**
 * Saison « Sur cet appareil » : dans le dossier choisi, un épisode après l'autre. Sans dossier, le navigateur bloquerait les onglets
 * ouverts en série : on propose de choisir un dossier ou de télécharger épisode par épisode.
 */
export async function saveSeasonToDevice(plan, onProgress = () => undefined) {
  const folder = await writableFolder();
  if (!folder) {
    toast(folderPickerSupported()
      ? 'Pour une saison entière, choisis d’abord un dossier dans Téléchargements, ou télécharge les épisodes un par un.'
      : 'Ton navigateur ne peut pas enregistrer une saison d’un coup : télécharge les épisodes un par un.', { ms: 6000 });
    return;
  }
  const n = plan.entries.length;
  let saved = 0;
  let blocked = 0;
  toast('Enregistrement de ' + n + (n > 1 ? ' épisodes' : ' épisode') + ' dans « ' + folder.name + ' »', { ms: 3500 });
  try {
    for (let i = 0; i < n; i++) {
      const { target, choice } = plan.entries[i];
      const label = (target.name || 'titre') + ' S' + target.season + ' É' + target.episode;
      onProgress((i + 1) + ' / ' + n);
      try {
        const ctl = new AbortController();
        const file = await resolveDeviceLink(target, choice, ctl.signal);
        await writeToFolder(folder, fileNameOf(file, label), file.url, { signal: ctl.signal });
        saved++;
      } catch (err) {
        if (err instanceof CorsBlockedError) { blocked++; continue; }
        if (err && err.code === 'network') break; // plus de connexion : inutile d'enchaîner les échecs
      }
    }
  } finally {
    onProgress(null);
  }
  const failed = n - saved - blocked;
  toast(saved + ' / ' + n + ' épisodes enregistrés dans « ' + folder.name + ' »' +
    (blocked ? ' · ' + blocked + ' refusés par leur hébergeur (à télécharger un par un)' : '') +
    (failed ? ' · ' + failed + ' en échec' : ''), { ms: 8000 });
}
