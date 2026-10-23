# @laststream/protocol

Contrat partagé entre **lastaddon** (serveur, source de vérité) et **laststream-app** (application). TypeScript strict, ESM, aucune dépendance à l'exécution.

| Import | Contenu |
|---|---|
| `@laststream/protocol/party` | constantes du salon (`REACTIONS`, `CHAT_MAX_CHARS`, `CLOSE`…), objets échangés (`PlaybackState`, `Participant`, `RoomInfo`…), unions `ClientMessage` / `ServerMessage` |
| `@laststream/protocol/sync` | `expectedPosition`, `estimateOffset`, `DRIFT_IGNORE_SEC`, `DRIFT_SEEK_SEC` |
| `@laststream/protocol/scrub` | `reduceHost`, `isIpLiteral`, `isLocalName`, `scrubPath`, `HOST_ALLOWLIST` |
| `@laststream/protocol/language` | `parseLanguages` (langue, variante française, MULTI, sous-titres FR d'une release), types `Lang`, `FrVariant` |
| `@laststream/protocol/social` | types seulement : formes des réponses de l'API sociale (`/user/social/*`, `/user/invites`, `/user/profiles/:id/hidden`) : amis, messages, conversations, profil, partage, listes, activité, parrainage |
| `@laststream/protocol` | tout ce qui précède |

Ne vit ici que ce qui est identique des deux côtés. La validation des trames (`parseClientMessage`), l'hystérésis de dérive du lecteur, les placeholders de Sentry, etc. restent dans leur dépôt.

## Utilisation

```json
"@laststream/protocol": "github:gtko/laststream-protocol#v0.1.1"
```

Le dossier `dist/` (JS ESM + `.d.ts`) est **commité** : pas d'étape `prepare` à l'installation. Après toute modification de `src/` :

```sh
npm run build   # régénère dist/
npm test
git add dist && git commit && git tag vX.Y.Z && git push --follow-tags
```

Puis changer le tag dans les deux dépôts. Les tests de contrat (`tests/party.test.ts`) figent les constantes du fil : les modifier est un changement de protocole.
