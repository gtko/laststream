// Traduction anglaise de l'interface de l'app pour les captures des guides en anglais (capture-guides.mjs).
// L'app n'existe qu'en français : ces textes remplacent, à l'affichage seulement, ceux visibles sur les captures.
// Les titres du catalogue factice (films, chaînes, programmes) restent en français : leurs jaquettes portent ces titres.
// Clés : texte français exact (espaces normalisées). Ajoute ici toute chaîne signalée « NON TRADUIT » par le script.
export const EN_TEXT = {
  // Barre de navigation et menu du compte
  'Accueil': 'Home', 'Séries': 'Series', 'Films': 'Movies', 'Direct': 'Live', 'Émissions TV': 'TV shows',
  'Documentaires': 'Documentaries', 'Ensemble': 'Together', 'Explorer': 'Explore', 'Mes favoris': 'My favourites',
  'Dessins animés': 'Cartoons', 'Statistiques': 'Statistics', 'Réglages': 'Settings', 'Changer de profil': 'Switch profile',
  'Se déconnecter': 'Sign out', 'Rechercher': 'Search', 'Profil': 'Profile',
  // Accueil
  'Lecture': 'Play', 'Bande-annonce': 'Trailer', 'Plus d’infos': 'More info', 'Pour bien commencer': 'Getting started',
  'Tendance n°1 · Film': 'Trending #1 · Movie', 'Tendance n°1 · Série': 'Trending #1 · Series', 'Tous publics': 'All ages',
  'Aventure · Fantastique': 'Adventure · Fantasy', 'Drame · Sci-Fi & Fantastique': 'Drama · Sci-Fi & Fantasy',
  'Animation · Familial': 'Animation · Family', 'Pour toi, Lina': 'For you, Lina', 'Salut Lina !': 'Hi Lina!', 'TMDB :': 'TMDB:',
  'Sur une île battue par les tempêtes, deux gardiens découvrent que le phare veille sur bien plus qu’une côte.':
    'On a storm-battered island, two keepers discover the lighthouse watches over far more than a coastline.',
  'Dans un port breton, une enquête sur un naufrage réveille les secrets de quatre familles.':
    'In a Breton harbour, an investigation into a shipwreck stirs up the secrets of four families.',
  'Petit Renard quitte son terrier pour ramener une graine magique avant le premier hiver.':
    'Little Fox leaves his den to bring back a magic seed before the first winter.',
  // Qui regarde ? / profils
  'Qui regarde ?': 'Who’s watching?', 'Gérer les profils': 'Manage profiles', 'Ajouter un profil': 'Add a profile',
  'Fermer': 'Close', 'Terminé': 'Done', 'Nouveau profil': 'New profile', 'Modifier le profil': 'Edit profile',
  'Modifications non enregistrées': 'Unsaved changes', 'Annuler': 'Cancel', 'Créer le profil': 'Create profile',
  'Enregistrer': 'Save', 'Retour': 'Back', 'Identité': 'Identity', 'Nom du profil': 'Profile name',
  'Affiché sur l\'écran « Qui regarde ? ».': 'Shown on the “Who’s watching?” screen.', 'Apparence': 'Appearance',
  'Avatar': 'Avatar', 'Initiale': 'Initial', 'Sur la couleur du profil': 'On the profile colour', 'Changer d\'avatar': 'Change avatar',
  'Couleur': 'Colour', 'Contrôle parental': 'Parental controls', 'Profil enfant': 'Kids profile',
  'Seuls les avatars et les contenus pour enfants sont proposés. Le code parental est demandé pour quitter ce profil.':
    'Only kids’ avatars and content are offered. The parental code is needed to leave this profile.',
  'Profil enfant, protégé': 'Kids profile, protected', 'Âge maximal': 'Maximum age', 'Rubriques autorisées': 'Allowed sections',
  'Films en famille': 'Family movies', 'Séries jeunesse': 'Kids series', 'Classiques Disney et Pixar': 'Disney and Pixar classics',
  'Animés pour les jeunes': 'Anime for kids', 'Nouveautés jeunesse': 'New for kids', 'Plateformes (Disney+, Netflix)': 'Platforms (Disney+, Netflix)',
  'TV jeunesse': 'Kids TV', 'Code parental': 'Parental code', 'Code PIN du profil': 'Profile PIN code',
  'Il protège la sortie du profil enfant : c\'est le code du profil principal. Choisis-le maintenant (4 chiffres).':
    'It protects leaving the kids profile: it is the main profile’s code. Choose it now (4 digits).',
  'Facultatif. Ces 4 chiffres seront demandés pour ouvrir ce profil.': 'Optional. These 4 digits will be asked to open this profile.',
  'Effacer': 'Delete',
  // Réglages
  'Compte et apparence': 'Account and appearance', 'Langue': 'Language', 'Audio': 'Audio', 'Contenu': 'Content',
  'TV en direct': 'Live TV', 'Serveur': 'Server', 'Sources': 'Sources', 'Crédits': 'Credits',
  'Tes extensions Stremio, dans l’ordre où elles sont interrogées.': 'Your Stremio extensions, in the order they are queried.',
  'Addons Stremio': 'Stremio addons',
  'Les addons interrogés pour trouver des sources. Ils débrident eux-mêmes : la clé de ton débrideur se règle dans l’addon.':
    'The addons queried to find sources. They handle debrid themselves: your debrid key is set in the addon.',
  'Ajoute tes extensions Stremio pour voir des sources.': 'Add your Stremio extensions to see sources.',
  'L’ordre est la priorité : la source 1 passe en premier.': 'Order is priority: source 1 goes first.',
  'Ajouter un addon Stremio': 'Add a Stremio addon', 'Tester les sources': 'Test sources', 'Tester l’adresse': 'Test address',
  'Préférences de lecture': 'Playback preferences', 'Qualité maximale': 'Maximum quality',
  'Les sources au-dessus de cette qualité sont masquées.': 'Sources above this quality are hidden.', 'Aucune limite': 'No limit',
  'Configuration chargée.': 'Configuration loaded.', 'Configuration enregistrée': 'Configuration saved', 'Configuration enregistrée.': 'Configuration saved.',
  'Les clés sont chiffrées par le serveur ; ce navigateur ne garde que la configuration chiffrée.':
    'Keys are encrypted by the server; this browser only keeps the encrypted configuration.',
  'Addon amont': 'Upstream addon', 'Activée': 'Enabled', 'Nom': 'Name', 'URL de l’addon amont': 'Upstream addon URL',
  'Le manifest est lu à la saisie : nom, logo et état s’affichent.': 'The manifest is read as you type: name, logo and status appear.',
  'v1.0.0 · Films, Séries · Exemple de source pour Laststream': 'v1.0.0 · Movies, Series · Example source for Laststream',
  'Chaînes de ta box et playlists M3U, lues par cet appareil.': 'Your box’s channels and M3U playlists, read by this device.',
  'Ma box TV': 'My TV box',
  'Les chaînes de ta box s’ajoutent à la TV en direct avec le badge « Box » et sont lues par l’app sur le réseau de ta box.':
    'Your box’s channels are added to Live TV with the “Box” badge and are played by the app on your box’s network.',
  'Détecte les chaînes de ta Freebox quand tu es chez toi.': 'Detects your Freebox channels when you are at home.',
  'Détecter ma Freebox': 'Detect my Freebox', 'Qualité préférée': 'Preferred quality',
  'Les chaînes de la box existent en plusieurs qualités ; HD par défaut, sinon la meilleure disponible.':
    'Box channels come in several qualities; HD by default, otherwise the best available.',
  'Playlists M3U': 'M3U playlists', 'Playlists que tu as choisies toi-même. Lues par cet appareil, jamais par le serveur.':
    'Playlists you chose yourself. Read by this device, never by the server.', 'Aucune playlist ajoutée.': 'No playlist added.',
  'Ajouter une playlist M3U': 'Add an M3U playlist', 'Facultatif.': 'Optional.', 'Adresse de la playlist': 'Playlist address',
  'URL http(s) d’un fichier M3U. Elle peut contenir des identifiants : enregistrée chiffrée sur ton compte, jamais affichée.':
    'http(s) URL of an M3U file. It may contain credentials: stored encrypted on your account, never shown.',
  'Guide des programmes (XMLTV)': 'Programme guide (XMLTV)',
  'Facultatif : URL d’un fichier .xml ou .xml.gz. Lu sur cet appareil, de maintenant à +24 h.':
    'Optional: URL of an .xml or .xml.gz file. Read on this device, from now to +24 h.',
  'Ajouter la playlist': 'Add playlist', 'Importer un fichier': 'Import a file',
  'Un navigateur ne peut pas joindre ta box ni la plupart des playlists : disponible dans les apps Windows et Android.':
    'A browser cannot reach your box or most playlists: available in the Windows and Android apps.',
  'Disponible dans l’app sur le réseau de ta box': 'Available in the app on your box’s network',
  'Cinéma chinois': 'Chinese cinema', 'Classiques (avant 1980)': 'Classics (before 1980)',
  // Fiche et sources
  'Résolution': 'Resolution', 'Cache uniquement ⚡': 'Cached only ⚡', 'Connexion': 'Connection', 'Mesurer ma connexion': 'Measure my connection',
  'Trier par': 'Sort by', 'Recommandé': 'Recommended', 'Qualité': 'Quality', 'Taille': 'Size', 'Débit': 'Bitrate',
  'Pas de VF disponible : meilleure VO': 'No French dub available: best original version', 'Lien direct': 'Direct link',
  'Débit inconnu': 'Unknown bitrate', 'Affichage': 'Display', 'VF': 'FR dub', 'VO': 'Original',
  // TV en direct
  'Chaînes gratuites, FAST et ta playlist': 'Free channels, FAST and your playlist', 'Ma playlist': 'My playlist',
  'Pays': 'Country', 'Catégorie': 'Category', 'Source': 'Source', 'Recherche': 'Search', 'Fiable': 'Reliable',
  'Toutes les catégories': 'All categories', 'Toutes les sources': 'All sources', 'Nom de la chaîne': 'Channel name',
  'français': 'French', 'Toutes': 'All', 'Favoris': 'Favourites', 'Généraliste': 'General', 'Actualités': 'News',
  'Cinéma': 'Cinema', 'Sport': 'Sport', 'Musique': 'Music', 'Jeunesse': 'Kids', 'Business': 'Business', 'Météo': 'Weather',
  'Classique': 'Classic', 'Comédie': 'Comedy', 'Culture': 'Culture', 'Éducation': 'Education', 'Shopping': 'Shopping',
  'Chaîne': 'Channel', 'Sélectionne un programme pour voir le détail. Entrée lance la chaîne.': 'Select a programme to see its details. Enter starts the channel.',
  'En cours': 'On now', 'Regarder': 'Watch', 'Fin de la liste': 'End of list',
  'Le point sur la semaine : émission fictive de la playlist d’exemple (Laststream Info).': 'Le point sur la semaine: fictional show from the example playlist (Laststream Info).',
};

// [expression régulière (texte entier), remplacement] : textes avec une partie variable.
export const EN_PATTERNS = [
  ['^(\\d+) ans$', '$1 years'],
  ['^(\\d+) titre\\(s\\)$', '$1 title(s)'],
  ['^· (\\d+) sources?$', '· $1 source(s)'],
  ['^(\\d+) h (\\d+)$', '$1 h $2'],
  ['^(.*) · (\\d+) min · $', '$1 · $2 min · '],
  ['^France · FR \\((\\d+)\\)$', 'France · FR ($1)'],
  ['^Couleur (.+)$', 'Colour $1'],
  ['^(\\d+) chaînes? ajoutées?, guide à jour\\.$', '$1 channel(s) added, guide updated.'],
  ['^Tendance n°(\\d+) · Film$', 'Trending #$1 · Movie'],
  ['^Tendance n°(\\d+) · Série$', 'Trending #$1 · Series'],
];
