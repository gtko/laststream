# Laststream : app TV et projecteurs LG (webOS)

App LG webOS (paquet `.ipk`) publiée à chaque release : `Laststream-X.Y.Z-webos.ipk` dans les assets de la release GitHub.
Comme l'app Android, c'est une coque légère : elle contient une page de démarrage locale (`app/index.html`) qui sonde le
serveur puis ouvre l'interface web servie par `https://app.laststream.app`. L'interface est donc toujours à jour sans
réinstaller l'app ; seul un changement de cette coque (icônes, page de démarrage, `appinfo.json`) demande un nouveau `.ipk`.

| Fichier | Rôle |
|---|---|
| `app/appinfo.json` | Fiche de l'app : identifiant `com.laststream.app`, icônes, écran de lancement, `disableBackHistoryAPI` (la touche Retour arrive à la page). La version est écrite au build. |
| `app/index.html` | Page de démarrage : TV trop ancienne (Chromium < 94), sonde de `/health`, écran hors ligne, Retour = quitter. |
| `app/icon.png`, `largeIcon.png`, `splash.png` | Icônes 80 et 130 px, écran de lancement 1920×1080. |
| `scripts/ipk.mjs` | Écriture du `.ipk` sans dépendance (même format qu'`ares-package` du SDK LG : ar + control.tar.gz + data.tar.gz). |
| `scripts/build-ipk.mjs` | `npm run build` : `dist/Laststream-<version>-webos.ipk`. Version : `--version`, sinon `VERSION`, sinon celle de `apps/tauri/src-tauri/Cargo.toml`. |

Côté interface (`apps/web`), webOS est reconnu à l'agent utilisateur (`Web0S`) :

- mode TV (`<html data-device="tv">`, `ui/device.js`), même avec la Magic Remote qui sert aussi de pointeur ;
- touche Retour (keyCode 461, `ui/webosKeys.js`) : envoyée comme Échap à la page (fenêtre, panneau, lecteur, page intérieure),
  sinon même règle que le bouton retour Android ; sur l'accueil, un second appui rend la main à la TV ;
- touches média de la télécommande (lecture, pause, stop, avance et retour rapides) reconnues par le lecteur (`player/keys.ts`).

La lecture passe par le lecteur web de l'interface (vidéo HTML, hls.js) et donc par les décodeurs de la TV.

## Compatibilité

webOS 23 ou plus récent (Chromium 94 et plus) : TV LG de 2023 et après, et modèles plus anciens passés à webOS 23 par une
mise à jour. En dessous, la page de démarrage affiche « TV trop ancienne » au lieu d'une page blanche. Sur webOS 23 et 24,
quelques couleurs de l'interface (`color-mix`, Chromium 111) peuvent manquer. Les projecteurs LG CineBeam sous webOS
suivent la même règle.

## Installer sur une TV ou un projecteur LG

L'app n'est pas sur le LG Content Store : elle s'installe en mode développeur, gratuit.

1. **Compte développeur LG** : en créer un sur <https://webostv.developer.lge.com> (gratuit).
2. **Sur la TV** : installer l'app « Developer Mode » depuis le LG Content Store, s'y connecter avec ce compte, passer
   « Dev Mode Status » sur ON (la TV redémarre), puis « Key Server » sur ON. Noter l'adresse IP et la passphrase affichées.
3. **Sur l'ordinateur** (même réseau que la TV), au choix :
   - **webOS Dev Manager** (application graphique, Windows / macOS / Linux) : <https://github.com/webosbrew/dev-manager-desktop/releases>.
     Ajouter la TV (IP + passphrase), puis « Apps » → installer le fichier `Laststream-X.Y.Z-webos.ipk` de la dernière release.
   - **CLI LG** (Node.js requis) :

     ```sh
     npm install -g @webos-tools/cli
     ares-setup-device --add tv --info "{'host':'<IP de la TV>','port':'9922','username':'prisoner'}"
     ares-novacom --device tv --getkey            # demande la passphrase affichée par l'app Developer Mode
     ares-install --device tv Laststream-X.Y.Z-webos.ipk
     ares-launch --device tv com.laststream.app
     ```

4. L'app apparaît dans la barre des apps de la TV (icône Laststream).

**Attention : la session du mode développeur dure 50 heures.** Une fois expirée, la TV désinstalle les apps du mode
développeur. Ouvrir l'app « Developer Mode » et appuyer sur « Extend » avant l'échéance. Sur une TV avec Homebrew Channel (TV rootée), l'app reste installée sans limite.

**Mettre à jour la coque** : réinstaller le nouveau `.ipk` par-dessus (même identifiant). L'interface elle-même se met à
jour toute seule, à chaque lancement.

## Développer

```sh
cd apps/webos
npm test                       # format du paquet, appinfo.json
npm run build -- --version 1.2.3
```

Pour tester l'interface en mode TV LG dans un navigateur de bureau : agent utilisateur `Mozilla/5.0 (Web0S; Linux/SmartTV)
… Chrome/120…` (outils de développement, appareil personnalisé). La touche Retour se simule avec un `keydown` de keyCode 461.
La CI (`webos-ci.yml`) teste et construit le paquet ; `release.yml` (job `webos`) le joint à chaque release.
