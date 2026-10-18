/* Premier lancement de l'application Android : « Connecter mon serveur Laststream ».
 * lastAddon tourne sur le PC de l'utilisateur ; l'adresse est enregistrée dans {base, config} (clé historique). */
import { getBase, getConfig, isAndroidApp, saveSettings } from '../data/config';
import { testServer } from '../data/serverTest';
import { brand } from './fragments.js';
import { esc } from './util.js';

export const needsServerSetup = () => isAndroidApp() && !getBase();

function html(value, msg, ok) {
  return '<div class="auth-card"><div class="auth-brand">' + brand() + '</div>' +
    '<h1 class="auth-title">Connecter mon serveur Laststream</h1>' +
    '<p class="tv-form-note">Laststream utilise le serveur lastAddon de ton PC. Saisis son adresse sur le réseau local (par exemple <b>http://192.168.1.20:7000</b>) : le téléphone et le PC doivent être sur le même Wi-Fi.</p>' +
    '<form id="srv-form" class="tv-form auth-form" autocomplete="off">' +
    '<label class="tv-field">Adresse du serveur<input type="url" name="base" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="http://192.168.1.20:7000" value="' + esc(value) + '"></label>' +
    '<p class="tv-form-msg" id="srv-msg" role="status" data-ok="' + (ok ? '1' : '0') + '">' + esc(msg || '') + '</p>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-srv-test>Tester</button>' +
    '<button type="submit" class="btn btn-primary">Connecter</button></div></form></div>';
}

/** Affiche l'écran jusqu'à ce qu'une adresse joignable soit enregistrée. */
export function runServerSetup() {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'srv-setup';
    root.className = 'auth';
    document.body.appendChild(root);
    document.body.classList.add('modal-open');
    let value = '';
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
    const check = async () => {
      value = root.querySelector('input[name="base"]').value;
      busy(true, 'Connexion en cours…');
      const r = await testServer(value);
      if (r.base) value = r.base;
      draw(r.message, r.ok);
      return r;
    };
    root.addEventListener('click', async (e) => {
      if (e.target instanceof Element && e.target.closest('[data-srv-test]')) await check();
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await check();
      if (!r.ok) return;
      saveSettings({ base: r.base, config: getConfig() });
      root.remove();
      document.body.classList.remove('modal-open');
      resolve(r.base);
    });
    draw('', false);
  });
}
