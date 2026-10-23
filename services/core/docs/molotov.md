# Contrat « Molotov » — sources TV live connectées (app ↔ serveur)

> Source : REA de Molotov 8.0.3 (Electron) et de l'app web https://app.molotov.tv, captures réseau réelles (2026-10-21).
> Détail complet des observations : `REA/Molotov/REA-Molotov-integration.md`.

## 1. Ce qu'est Molotov cote reseau

Le client bureau Molotov 8.0.3 est une coquille Electron qui charge `https://app.molotov.tv`.
Toute la logique (catalogue, API, DRM) est dans l'app web ⇒ LastStream doit rejouer **les appels de l'app web**, pas reverse-engineurer l'Electron.

| Brique | Valeur |
|---|---|
| API | `https://api-eu.fubo.tv` (brand `molotov`, env `production` ; US = `api.fubo.tv`) |
| Manifeste | `https://prod-ssai-ftv-up.akamaized.net/.../master.mpd` (DASH, `Access-Control-Allow-Origin: *`) |
| Licence DRM | `https://api-eu.fubo.tv/vapi/v1/drm/irdeto-proxy/license` (proxy) ; Irdeto direct : `https://irdeto.fubo.tv/licenseServer/widevine/v1/FuboTV/license` |
| Images | `https://molotov-imgx.fubo.tv`, `https://images-eu.fubo.tv` |
| Analytics | `https://amolio-eu.fubo.tv/v1/…` |

## 2. Identité « client Molotov » (en-têtes `x-*`)

Requis par l'API ; à envoyer par le client (ou par le relais serveur).

```
x-application-id: molotov
x-client-version: 6.17.1-hotfix.3
x-player-version: 7.4.2
x-device-app: web
x-device-type: desktop
x-device-group: desktop
x-device-platform: desktop
x-drm-scheme: widevine
x-supported-streaming-protocols: hls,dash
x-supported-codecs-list: avc
x-device-id / x-ad-id / x-session-id   (persistants ou générés)
x-user-id / x-profile-id                (remplis par l'API après connexion)
User-Agent: Mozilla/5.0 (…) Molotov/8.0.3 Chrome/148.0.7778.96 Electron/42.0.0 Safari/537.36
Origin: https://app.molotov.tv
Referer: https://app.molotov.tv/
```

## 3. Authentification

La voie retenue pour connecter un compte est **l'email + mot de passe** (formulaire de la carte « Molotov » de l'app,
sans client id Google) :

```
PUT https://api-eu.fubo.tv/v2/signin
Content-Type: application/json
{ "email": "<email Molotov>", "password": "<mot de passe Molotov>" }
→ 200 { "type": "…", "payload": { "idToken": "<JWT Molotov>", "refreshToken": "<JWT Molotov>", … } }
   (jetons dans `payload`, ou à plat par sécurité)
```

Si le compte exige une **vérification en deux étapes**, la réponse est un défi plutôt que des jetons
(`type` insensible à la casse) :

```
→ 200 { "type": "MFA", "payload": { "token": "<mfaToken>" } }
```

Le code reçu par email se vérifie avec le jeton de défi porté par l'en-tête `X-Mfa-Token` :

```
PUT https://api-eu.fubo.tv/mfa/verify
X-Mfa-Token: <mfaToken>
Content-Type: application/json
{ "code": "123456" }
→ 200 { …jetons (à plat ou dans `payload`)… }
   4xx → code incorrect ou expiré ; code métier `CHILL_PLZ` → 429 (trop d'essais)
```

Le code peut être renvoyé ; le jeton de défi **peut changer** :

```
PUT https://api-eu.fubo.tv/mfa/email/resend
X-Mfa-Token: <mfaToken>
(corps vide)
→ 200 { "payload": { "token": "<nouveauMfaToken>" } }
```

Le `idToken` Molotov est le `Authorization: Bearer …` de **toutes** les requêtes API.
Refresh : `POST https://api-eu.fubo.tv/refresh` (avec le `refreshToken`).

> Note : la voie OAuth Google (`PUT /oauth/google` avec un `googleToken`) reste implémentée côté serveur mais n'est pas exposée dans l'UI.

## 4. API utile

```
GET /papi/v1/config                       (public)
GET /papi/v1/page/live-tv                 (2 Mo : catalogue « En direct »)
GET /epg                                  (public, ~6 Mo : guide TV complet)
GET /papi/v1/main-navigation
GET /v3/location                          (géo/postal)
GET /rights/v2/location                   ({purchasable,watchable})
GET /user , /social , /profile , /users/tier
GET /vapi/v1/playback?channelId=<id>&type=live      (template d'écran du lecteur)
GET /vapi/asset/v1?channelId=<id>&type=live         (manifeste + DRM + heartbeat)
POST /vapi/heartbeat/v2?channelId=..&id=..&type=live
```

Réponse de `/vapi/asset/v1` (champs **à plat**, pas sous `configuration`) :

```jsonc
{
  "stream": { "url": "https://prod-ssai-ftv-up.akamaized.net/…/master.mpd?aws.sessionId=…&filter=…&hdnts=st=…~exp=…~acl=…~hmac=…&remap=1",
              "packagingProtocol": "dash", "drmProtected": true, "drmProvider": "drmtoday",
              "live": true, "withCredentials": false, "scrubOffset": 15 },
  "drm":   { "provider": "irdeto", "scheme": "widevine",
              "licenseUrl": "https://api-eu.fubo.tv/vapi/v1/drm/irdeto-proxy/license?drmId=<callSign>&ls_session=<JWT>&scheme=widevine&userId=<uid>",
              "token": "<JWT identique à ls_session>" },
  "heartbeat": { "method": "POST",
                 "url": "https://api-eu.fubo.tv/vapi/heartbeat/v2?channelId=..&id=LIVE_…&type=live",
                 "payload": { "passback": {…}, "pdt": "@", "progress": "@" } },
  "accessRightsV2": { "live": {…}, "startover": {…}, "lookback": null, "dvr": null, "vod": null }
}
```

## 5. Lecture (DASH + Widevine)

1. `player.load(stream.url)` (manifeste Akamai, chargeable en direct par le navigateur).
2. EME : `POST drm.licenseUrl` — en-têtes `Content-Type: application/octet-stream` et
   `Authorization: Bearer <drm.token>` ; corps = challenge Widevine ; réponse = octets de licence.
   - Sur **web**, CORS bloque ⇒ relais serveur binaire (§7).
   - Sur **Android/desktop**, appel natif direct possible.
3. Heartbeat de progression toutes les ~15 s (`payload.pdt` / `payload.progress` remplacés par le temps en ms).
4. `hdnts` (signature Akamai) et `ls_session` expirent (~1 h) ⇒ refaire `/vapi/asset/v1` avant expiration.

## 6. Contraintes plateforme (à garder en tête)

| Cible | DASH + Widevine | Comment |
|---|---|---|
| Web (Chrome/Edge) | ✅ | EME + lecteur DASH (Shaka.js) |
| Android (WebView Capacitor) | ✅ | idem (WebView = Chromium + Widevine) |
| Windows (shell Rust : WebView2 + libmpv) | ✅ | WebView2 embarque le CDM Widevine (présent dans le runtime EdgeWebView, vérifié sur machine réelle) ; lecture via Shaka dans la WebView. libmpv n'est pas utilisé pour ces flux. Le garde réel est la **détection EME à l'exécution** (`navigator.requestMediaKeySystemAccess('com.widevine.alpha')`) : sans module Widevine, le lecteur renvoie `no_widevine` et propose le navigateur. |

> Molotov y arrive de son côté avec un fork Electron « +wvcus » (CDM Widevine intégré) ; notre coque s'appuie sur le CDM d'EdgeWebView, présent par défaut.

## 7. CORS (contrainte structurante)

`api-eu.fubo.tv` renvoie un `Access-Control-Allow-Origin` **fixe** (`https://www.fubo.tv` / `https://app.molotov.tv`) :
**un navigateur tiers ne peut pas l'appeler directement.** Trois contournements, tous utilisés ici :

| Contexte | Voie |
|---|---|
| Android / desktop | appel **direct** à l'API depuis l'appareil (transport natif : CapacitorHttp / IPC shell) — pas de relais |
| Web | **relais serveur** (`/user/account/molotov/relay`) : le serveur injecte les en-têtes `x-*` + `Origin: https://app.molotov.tv` et renvoie le JSON |
| Licence (web) | **relais binaire** (`/user/account/molotov/license`) : le corps binaire est relayé verbatim |

Règles de sécurité du relais :
* allow-list stricte des chemins/paramètres amont (pas d'open proxy) ;
* le `Authorization` Molotov vient du serveur (tokens stockés chiffrés) et n'est jamais renvoyé au client ;
* aucune donnée utilisateur en cache partagé.

## 8. Surface d'API Laststream (contrat app ↔ serveur)

Toutes sous `/user/account/molotov`, profil principal requis, comme `/user/account/tv-sources`.

| Méthode | Route | Corps / réponse |
|---|---|---|
| `GET` | `/user/account/molotov` | `{ connected, tier, userId, profileId, email, channelCount, updatedAt }` (`updatedAt` en ms epoch) |
| `PUT` | `/user/account/molotov` | `{ idToken, refreshToken }` **ou** `{ googleToken }` (le serveur fait alors l'échange) → `{ ok: true }` (tokens chiffrés au repos) |
| `POST` | `/user/account/molotov/signin` | `{ email, password }` → même état que `GET` (le serveur fait l'amont `PUT /v2/signin`, corps `{email, password}`, **sans** `Authorization`) ; si l'amont exige un code : `{ status: "mfa_required", mfaToken }` (aucune ligne de compte créée) |
| `POST` | `/user/account/molotov/signin/verify` | `{ mfaToken, code }` → même état que `GET` (le serveur fait l'amont `PUT /mfa/verify`, corps `{code}`, en-tête `X-Mfa-Token` ; jetons chiffrés au repos) |
| `POST` | `/user/account/molotov/signin/resend` | `{ mfaToken }` → `{ mfaToken }` (le serveur fait l'amont `PUT /mfa/email/resend` avec `X-Mfa-Token` ; le jeton de défi peut changer) |
| `DELETE` | `/user/account/molotov` | `{ ok: true }` (déconnexion) |
| `GET` | `/user/account/molotov/credentials` | `{ idToken, refreshToken, expiresAt }` (usage appareil direct ; chiffré en transit par le TLS du worker) |
| `GET` | `/user/account/molotov/channels` | `{ channels: [{ id, name, callSign, logo, group, live, program }], fetchedAt, rawChannelCount }` (compact, cache ~5 min) |
| `GET` | `/user/account/molotov/epg` | `{ channels: [{ id, name, logo, callSign, programs: [{ id, title, start, end, type, desc, image }] }], fetchedAt }` (guide TV complet, grille multi-heures : `start`/`end` en ISO 8601 depuis `assets[].accessRights`, `desc` tronqué à 200 car., fenêtre 30 min / +24 h, cache ~10 min ; amont `GET /epg` **public**, sans `Authorization`) |
| `POST` | `/user/account/molotov/play` | `{ channelId }` → `{ channelId, manifestUrl, drm: { scheme, licenseUrl, licenseToken }, heartbeatUrl, heartbeatPayload, assetId, expiresAt }` |
| `POST` | `/user/account/molotov/license` | `{ licenseUrl, token, challenge (base64) }` → octets de licence (`application/octet-stream`, **jamais** du texte) |
| `POST` | `/user/account/molotov/heartbeat` | `{ channelId, assetId?, progress, payload? }` → `{ ok: true }` (`payload` = charge utile amont ; `pdt`/`progress` sont remplacés) |
| `GET` | `/user/account/molotov/relay?path=…&query=…` | relais JSON vers `api-eu.fubo.tv` (usage web ; allow-list de chemins, `query` encodée à part) |

Erreurs notables : `400 google_token_rejected` (l'API Molotov refuse le client id Google), `400 unsupported_path`,
`400 invalid_body`, `401 invalid_credentials` (signin : identifiants refusés), `401 invalid_code` (verify/resend : code
ou défi incorrect, expiré), `429 rate_limited` (verify/resend : trop d'essais), `403 main_profile_required`,
`403 relay_disabled`, `401 invalid_session`, `502 molotov_unavailable`.

## 9. Configuration

| Nom | Où | Rôle |
|---|---|---|
| `LASTADDON_MOLOTOV_RELAY` | secret/variable `lastaddon-core` | active le relais serveur (`1` par défaut). `0` ⇒ relais désactivé (mode « appareil direct » seul). |

Secrets : aucun nouveau secret fort requis (les tokens Molotov sont chiffrés avec `LASTADDON_SECRET`).

## 10. Hors périmètre

* Multi-compte / multi-profile Molotov (une session par compte Laststream).
* Replay/VOD Molotov, sous-titres, chat, recommandations.
* Support de la lecture Molotov dans le shell Windows (pas de CDM Widevine).
* Redistribution du CDM Widevine (licence).
