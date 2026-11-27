# Classiques libres

Films libres de droits **partout** (États-Unis, France, Suisse), proposés à tous les comptes sans source ni extension :
une rangée « Classiques libres » sur l'accueil et la page Films, et des liens directs en tête des sources du film.
Code : `src/lt/libres.ts`. Ticket : LAST-1656 (recherche : LAST-1652).

## Règle « libre partout »

Un film entre dans l'index seulement s'il passe les deux règles, calculées chaque année :

| Pays | Règle | En 2026 |
| --- | --- | --- |
| États-Unis | publié il y a plus de 95 ans | publié en 1930 au plus tard |
| France, Suisse | chaque auteur connu (réalisation, scénario, musique) mort il y a plus de 70 ans | auteurs morts en 1955 au plus tard |

Un film sans auteur connu dans Wikidata, ou dont un auteur n'a pas de date de décès lisible, est écarté. Exemples : les
Méliès, les Lumière ou *Nosferatu* (1922) passent ; Chaplin (†1977), Keaton (†1966) ou *La Nuit des morts-vivants*
(libre aux USA seulement) ne passent pas.

## Sources

- **Wikidata** (données CC0) : registre. Identifiant IMDb (P345) et TMDB (P4947), date de publication (P577), auteurs
  (P57, P58, P86) et leur date de décès (P570), notoriété (nombre de wikis) pour l'ordre de la rangée.
- **Wikimedia Commons** : vidéo du film (P10, hors bande-annonce), lien `Special:FilePath` (WebM de préférence).
- **Internet Archive** : élément lié au film (P724) ; le plus lourd des MP4 entre 5 Mo et 8 Go est retenu. Archive
  seul ne vérifie pas les droits : seuls les éléments reliés par Wikidata et passés par la règle sont utilisés.

Les vidéos restent chez Commons et Archive : l'appareil les lit en direct, le serveur ne relaie aucun octet.

## Construction de l'index

- **Workers** : Cron quotidien dédié `23 4 * * *` (`src/platform/workers/libres-refresh.ts`), séparé des passes TV.
  L'index n'est reconstruit que s'il date de plus d'une semaine ; il est écrit dans R2 (bucket META, clé
  `libres/index.json`) et relu en mémoire au plus une fois par heure. Une reconstruction vide ne remplace jamais
  l'index existant. Les fichiers Archive déjà connus sont repris sans relire leur fiche.
- **Node (auto-hébergé)** : pas de stockage ; la première demande de la rangée lance la construction en arrière-plan,
  puis une reconstruction par semaine.

## Routes

- `GET /:config/lt/libres?page=1` : `{ results: [{ tmdb, imdb, year }], total }`, 20 films par page (films ayant une
  fiche TMDB), du plus connu au moins connu. Liste vide tant que l'index n'existe pas.
- `GET /:config/stream/movie/:imdb.json` : pour un film de l'index, un lien Archive (MP4) puis un lien Commons sont
  ajoutés en tête, nommés « Classique libre », avec `laststream.origins = [{ name: 'Classiques libres' }]`.
