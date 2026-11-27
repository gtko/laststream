import { LastAddonError } from './errors';
import { normalizeBase } from './config';
import { requestJson } from './transport';
import { t } from '../i18n';

export interface ServerTest {
  ok: boolean;
  /** Adresse normalisée (sans « / » final), vide si la saisie est invalide. */
  base: string;
  message: string;
}

/** Joint lastAddon (GET {base}/config/schema) : sert au premier lancement et au bouton « Tester » des réglages. */
export async function testServer(raw: string): Promise<ServerTest> {
  let base = '';
  try {
    base = normalizeBase(raw);
  } catch (e) {
    return { ok: false, base: '', message: e instanceof LastAddonError ? e.message : t('Adresse invalide.') };
  }
  if (!base) return { ok: false, base: '', message: t('Saisis l’adresse de ton serveur, par exemple http://192.168.1.20:7000.') };
  try {
    const schema = await requestJson<unknown>(`${base}/config/schema`);
    if (schema && typeof schema === 'object') return { ok: true, base, message: t('Connecté à ton serveur Laststream.') };
    return { ok: false, base, message: t('Ce serveur ne ressemble pas à lastAddon (réponse inattendue).') };
  } catch {
    return {
      ok: false, base,
      message: t('Serveur injoignable. Vérifie que lastAddon tourne sur ton PC, que le téléphone est sur le même Wi-Fi et que le pare-feu autorise le port de lastAddon.'),
    };
  }
}
