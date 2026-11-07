# Archive Molotov (LAST-184)

Code de l'intégration **Molotov TV** (sources TV live, fubo Europe) mis de côté. Il n'est plus monté, ni compilé, ni testé : `typecheck`, `lint`, `test` et `test:workers` ignorent ce dossier (`archive/**` exclu de tsconfig, eslint, vitest, vitest workers et knip).

## Nature du code

- `src/user/molotov.ts` (1829 lignes à l'origine) : `registerMolotovRoutes`, routes `/user/account/molotov*` montées sous `/user`.
  - Compte : connexion par email et mot de passe (`signin`), vérification MFA (`signin/verify`, `signin/resend`) ou jetons déjà obtenus (`PUT`). Jetons et profil chiffrés dans la table `molotov_accounts`.
  - Catalogue : chaînes, guide des programmes (EPG), replay, fiche d'émission.
  - Lecture : `play`, `play-asset`, licence DRM (`license`, binaire), `heartbeat`.
  - Relais serveur vers l'API Molotov (`relay`) et `credentials` pour le mode « appareil direct ».
- `docs/molotov.md` : contrat HTTP et notes d'architecture.
- `store-accessors.ts.txt` : accesseurs de `molotov_accounts` extraits de `src/user/store.ts`.
- `tests/` : tests du module et de sa portée globale (régression ODY-235).

## Raison

Issue Telic LAST-184 : mise de côté du code Molotov TV. Les fichiers sont déplacés sans modification de leur contenu.

## Déplacements (origine vers archive)

| Origine | Archive |
|---|---|
| `src/user/molotov.ts` | `archive/molotov/src/user/molotov.ts` |
| `docs/molotov.md` | `archive/molotov/docs/molotov.md` |
| `tests/molotov.test.ts` | `archive/molotov/tests/molotov.test.ts` |
| `tests/molotov-global-scope.test.ts` | `archive/molotov/tests/molotov-global-scope.test.ts` |
| `src/user/store.ts`, accesseurs (lignes 98-106 et 1338-1360) | `archive/molotov/store-accessors.ts.txt` |

Les fichiers archivés gardent leurs imports d'origine (`../config/runtime-env.js`, `./store.js`, `../src/user/molotov.js`...). Pour les réactiver, les remettre à leur emplacement d'origine (`git mv`), puis rétablir les points ci-dessous.

## Points de rebranchement

Numéros de ligne d'origine (avant LAST-184).

1. **Routes**, `src/user/routes.ts` :
   - ligne 37, import : `import { registerMolotovRoutes } from './molotov.js';`
   - ligne 860, après `registerDebridLinkRoutes(router, deps, backend);` : `  registerMolotovRoutes(router, deps, backend);`
2. **Accesseurs du store**, `src/user/store.ts` : voir `store-accessors.ts.txt`.
   - `interface MolotovAccount` au niveau module (lignes 98-106), avant `export class UserStore` (ligne 403).
   - Méthodes `getMolotovAccount`, `setMolotovAccount` et `deleteMolotovAccount` dans la classe (lignes 1338-1360), après `setTvSources`.
3. **Relais**, `src/config/runtime-env.ts`, lignes 72-78, après `isTrustProxy` :

   ```ts
   /**
    * LASTADDON_MOLOTOV_RELAY=0 : relais serveur Molotov désactivé (mode « appel direct depuis l'appareil » seul).
    * Actif par défaut ; toute autre valeur laisse le relais actif.
    */
   export function isMolotovRelayEnabled(): boolean {
     return runtimeEnv().get('LASTADDON_MOLOTOV_RELAY') !== '0';
   }
   ```

4. **Variable d'environnement**, `.env.example`, lignes 36-40 (ligne vide puis bloc) :

   ```
   # Relais serveur vers l'API Molotov (TV live) : 1 = actif (défaut), 0 = désactivé.
   # Désactivé, l'app doit appeler l'API Molotov elle-même (mode « appareil direct ») : les routes de relais
   # (/user/account/molotov/relay, /channels, /play, /license, /heartbeat) répondent alors 403 relay_disabled.
   # LASTADDON_MOLOTOV_RELAY=1
   ```

## Ce qui reste volontairement

- `src/user/migrations.ts` n'est **pas modifié**. Les migrations 30 (table `molotov_accounts`) et 31 sont déjà passées sur les bases existantes et ne doivent pas bouger. La table reste en base, sans lecteur ni écrivain. Une base neuve la crée toujours.
- `tests/migrations-v13-main.test.ts` garde sa suite de versions (1 à 31) ; seul un commentaire est reformulé.
- `tests-workers/announcements-upgrade.test.ts` : le retour à la version 23 retire les tables de la migration 30, lues depuis `MIGRATIONS` (au lieu d'un nom en dur).

## Effets

- `/user/account/molotov` et ses sous-routes ne sont plus montées : le routeur `/user` répond `404 not_found` (`router.all('*')`).
- `LASTADDON_MOLOTOV_RELAY` n'est plus lue par le serveur.

## Réactiver

1. Remettre les fichiers archivés à leur emplacement d'origine (`git mv`).
2. Rétablir les points 1 à 4 ci-dessus.
3. Retirer éventuellement les exclusions `archive/**` (elles sont sans effet une fois le dossier vidé).
4. Lancer `npm run typecheck`, `npm test` et `npm run test:workers`.
