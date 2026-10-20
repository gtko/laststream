/* Échec de création d'un salon : message humain par code (src/party/createError.ts) et, pour `pin_required`, saisie du code du
 * profil sur le clavier PIN existant puis nouvel essai. La cause brute reste écrite dans la console. */
import { auth } from '../data/auth';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { partyCreateErrorText } from '../party/createError';
import { toast } from './dom.js';

/**
 * @param {unknown} err
 * @param {{ retry?: () => void, say?: (text: string) => void }} [opts] `retry` : relance la création une fois le code saisi ;
 *   `say` : où afficher le message (toast par défaut).
 */
export async function handlePartyCreateError(err, { retry, say = toast } = {}) {
  try { console.error('[watch party] création', err); } catch { /* ignoré */ }
  const text = partyCreateErrorText(err);
  if (err instanceof UserApiError && err.code === 'pin_required' && retry) {
    let profile;
    try { const id = userStore.currentProfile().id; profile = auth.profiles.find((p) => p.id === id); } catch { profile = undefined; }
    if (profile) {
      const { pinPad, hidePad } = await import('./auth-ui.js');
      pinPad({ title: 'Code de ' + profile.name, profile, onOk: async () => { hidePad(); retry(); }, onCancel: () => say(text) });
      return;
    }
  }
  say(text);
}
