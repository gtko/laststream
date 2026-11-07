/* Premier lancement de l'application Android : « Connecter mon serveur Laststream ».
 * Par défaut, l'app utilise le serveur Laststream (PUBLIC_BASE) sans rien demander ; l'écran de saisie n'apparaît
 * que si ce serveur ne répond pas. Un serveur perso (lastAddon sur ton PC, ou un autre) peut être saisi ici ou
 * dans les réglages. */
import { getBase, getConfig, PUBLIC_BASE, saveSettings } from '../data/config';
import { PUBLIC_PROBE_MS, prepareServer, probeHealth } from '../data/serverMode';
import { testServer } from '../data/serverTest';
import { brand } from './fragments.js';
import { esc } from './util.js';

function html(value, msg, ok) {
  return '<div class="auth-card"><div class="auth-brand">' + brand() + '</div>' +
    '<h1 class="auth-title">Connecter mon serveur Laststream</h1>' +
    '<p class="tv-form-note">Laststream utilise le serveur Laststream par défaut. Pour ton propre lastAddon, saisis son adresse : sur le réseau local (par exemple <b>http://192.168.1.20:7000</b>), le téléphone et le PC doivent être sur le même Wi-Fi.</p>' +
    '<form id="srv-form" class="tv-form auth-form" autocomplete="off">' +
    '<label class="tv-field">Adresse du serveur<input type="url" name="base" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="http://192.168.1.20:7000" value="' + esc(value) + '"></label>' +
    '<p class="tv-form-msg" id="srv-msg" role="status" data-ok="' + (ok ? '1' : '0') + '">' + esc(msg || '') + '</p>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-srv-test>Tester</button>' +
    '<button type="button" class="btn btn-ghost" data-srv-retry>Réessayer</button>' +
    '<button type="submit" class="btn btn-primary">Connecter</button></div></form></div>';
}

/** Affiche l'écran jusqu'à ce qu'une adresse joignable soit enregistrée (PUBLIC_BASE pré-rempli). */
function runServerSetup() {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'srv-setup';
    root.className = 'auth';
    document.body.appendChild(root);
    document.body.classList.add('modal-open');
    let value = PUBLIC_BASE;
    const draw = (msg, ok) => {
      root.innerHTML = html(value, msg, ok);
      const input = root.querySelector('input[name="base"]');
      if (input) input.addEventListener('input', () => { value = input.value; });
    };
    const busy = (on, label) => {
      root.querySelectorAll('button').forEach((b) => { b.disabled = on; });
      const m = root.querySelector('#srv-msg');
      if (m && on) m.textContent = label;
    };
    // Config chiffrée conservée seulement si l'adresse ne change pas (elle est propre à chaque serveur).
    const finish = (base, mode) => {
      const keep = getBase() === base;
      saveSettings({ mode, base, config: keep ? getConfig() : '', ...(mode === 'custom' ? { custom: base } : {}) });
      root.remove();
      document.body.classList.remove('modal-open');
      resolve(base);
    };
    const check = async () => {
      value = root.querySelector('input[name="base"]').value;
      busy(true, 'Connexion en cours…');
      const r = await testServer(value);
      if (r.base) value = r.base;
      draw(r.message, r.ok);
      return r;
    };
    // « Réessayer » interroge le serveur Laststream (la saisie reste telle quelle).
    const retry = async () => {
      busy(true, 'Connexion au serveur Laststream…');
      if (await probeHealth(PUBLIC_BASE, PUBLIC_PROBE_MS)) finish(PUBLIC_BASE, 'public');
      else draw('Le serveur Laststream ne répond toujours pas. Réessaie plus tard, ou saisis l’adresse de ton lastAddon.', false);
    };
    root.addEventListener('click', async (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('[data-srv-test]')) await check();
      else if (e.target.closest('[data-srv-retry]')) await retry();
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await check();
      if (r.ok) finish(r.base, 'custom');
    });
    draw('Le serveur Laststream ne répond pas pour l’instant. Réessaie, ou saisis l’adresse de ton serveur.', false);
  });
}

/** Android, au démarrage : rien d'affiché si une adresse utilisable est prête, sinon l'écran de saisie. Hors Android : rien. */
export async function ensureServerSetup() {
  if (!(await prepareServer())) await runServerSetup();
}
