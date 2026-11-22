// Texte des guides du site, en français et en anglais (lu par build-guides.mjs).
// Chaque étape peut montrer une capture annotée de capture-guides.mjs (`shot` = nom de l'image, sans extension).
// Les libellés entre guillemets sont ceux de l'app ; en anglais, ceux de l'interface traduite des captures (i18n-en.mjs).
const q = (s) => `«&nbsp;${s}&nbsp;»`;
const e = (s) => `“${s}”`;

export const UI = {
  fr: {
    locale: 'fr_FR', skip: 'Aller au contenu', brandLabel: 'Laststream, accueil', mainNav: 'Navigation principale',
    nav: [['#fonctions', 'Fonctions'], ['#comment', 'Comment ça marche'], ['#apercu', 'Aperçu'], ['#ensemble', 'Ensemble'], ['#telecharger', 'Télécharger'], ['#faq', 'FAQ']],
    download: 'Télécharger', langNav: 'Langue', guidesTitle: 'Guides Laststream', crumbs: "Fil d'Ariane",
    badges: 'Durée et plateformes', platforms: { win: 'Windows', android: 'Android', web: 'Navigateur' },
    clipLabel: 'Vidéo du parcours complet, sans son', prereq: 'Prérequis', steps: 'Étapes',
    legend: 'Sur chaque capture, le cadre jaune montre où toucher ou cliquer&nbsp;; les numéros donnent l’ordre.',
    tip: 'Bon à savoir', pager: 'Guides voisins', prev: 'Guide précédent', next: 'Guide suivant', contents: 'Sommaire', allGuides: '← Tous les guides',
    footer: [
      "<p>Laststream n'héberge aucun contenu&nbsp;: il lit les extensions que tu configures. Inscription sur invitation.</p>",
      '<p><a href="/guides/">Guides</a></p>',
      "<p class=\"legal\">Laststream n'est pas affilié à Stremio.</p>",
      "<p class=\"legal\">Ce produit utilise l'API TMDB mais n'est ni approuvé ni certifié par TMDB.</p>",
      '<p class="legal">Captures réalisées avec un catalogue de démonstration&nbsp;: titres fictifs et affiches générées par IA.</p>',
    ],
  },
  en: {
    locale: 'en_US', skip: 'Skip to content', brandLabel: 'Laststream, home', mainNav: 'Main navigation',
    nav: [['#fonctions', 'Features'], ['#etapes', 'How it works'], ['#apercu', 'Preview'], ['#ensemble', 'Together'], ['#telecharger', 'Download'], ['#faq', 'FAQ']],
    download: 'Download', langNav: 'Language', guidesTitle: 'Laststream guides', crumbs: 'Breadcrumb',
    badges: 'Duration and platforms', platforms: { win: 'Windows', android: 'Android', web: 'Browser' },
    clipLabel: 'Video of the whole walkthrough, no sound', prereq: 'Before you start', steps: 'Steps',
    legend: 'On each screenshot, the yellow frame shows where to tap or click; the numbers give the order. The app is in French: the screenshots show its English translation.',
    tip: 'Good to know', pager: 'Other guides', prev: 'Previous guide', next: 'Next guide', contents: 'Contents', allGuides: '← All guides',
    footer: [
      '<p>Laststream hosts no content: it reads the extensions you configure. Invitation only.</p>',
      '<p><a href="/en/guides/">Guides</a></p>',
      '<p class="legal">Laststream is not affiliated with Stremio.</p>',
      '<p class="legal">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>',
      '<p class="legal">Screenshots made with a demo catalogue: made-up titles and AI-generated posters.</p>',
    ],
  },
};

export const GUIDES = [
  {
    id: 'creer-un-profil', minutes: 2, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Créer un profil',
      lead: 'Chaque personne du foyer a son profil&nbsp;: sa bibliothèque, sa progression et ses réglages la suivent sur tous ses appareils.',
      ogAlt: 'Fenêtre « Nouveau profil » : le nom, l’avatar et la couleur sont encadrés en jaune',
      prereq: ['Un compte connecté.', 'Seul le profil principal (ou quelqu’un qui connaît son code) peut ajouter des profils.'],
      steps: [
        { text: `Touche ton avatar en haut à droite (1), puis ${q('Changer de profil')} (2).`, shot: '01-avatar', alt: 'Accueil de Laststream, menu de l’avatar ouvert : l’avatar et l’entrée « Changer de profil » sont encadrés.' },
        { text: `Sur l’écran ${q('Qui regarde&nbsp;?')}, touche la case ${q('Ajouter un profil')}.`, shot: '02-ajouter', alt: 'Écran « Qui regarde ? » : la case « Ajouter un profil » est encadrée, à côté du profil Camille.' },
        { text: `Dans ${q('Nouveau profil')}, saisis son prénom (1, 20 caractères maximum). Choisis si tu veux un avatar avec ${q('Changer d’avatar')} (2), puis une couleur parmi les 8 pastilles (3).`, shot: '03-nom-couleur', alt: 'Fenêtre « Nouveau profil » : le champ du nom (Léo), le bouton « Changer d’avatar » et les pastilles de couleur sont numérotés de 1 à 3.' },
        { text: [`Facultatif&nbsp;: un ${q('Code PIN du profil')} de 4 chiffres (1), demandé ensuite pour ouvrir ce profil.`, `Touche ${q('Créer le profil')} en haut à droite (2).`], shot: '04-code-pin', alt: 'Bas de la fenêtre « Nouveau profil » : les 4 cases du code PIN et le bouton « Créer le profil » sont encadrés.' },
        { text: `Le nouveau profil apparaît à côté des autres. Touche ${q('Terminé')} pour revenir à ${q('Qui regarde&nbsp;?')}, puis touche le profil pour l’ouvrir.`, shot: '05-profil-cree', alt: 'Écran « Gérer les profils » : le nouveau profil Léo est encadré, à côté de Camille.' },
      ],
      sections: [{ tip: [
        `Pour modifier un profil&nbsp;: ${q('Gérer les profils')}, puis touche le profil. Tu peux changer son nom, son avatar, sa couleur ou son code PIN.`,
        `Pour supprimer un profil&nbsp;: même chemin, puis la ${q('Zone de danger')} en bas (il faut saisir son nom pour confirmer). Le profil principal ne se supprime pas.`,
        `Pour un enfant, suis plutôt le guide ${q('<a href="/guides/profil-enfant/">Créer un profil enfant</a>')}.`,
      ] }],
    },
    en: {
      slug: 'create-a-profile', title: 'Create a profile',
      card: 'Add a profile for everyone at home, with their name, colour and an optional PIN code.',
      lead: 'Everyone at home gets their own profile: their library, progress and settings follow them on all their devices.',
      ogAlt: '“New profile” window: the name, avatar and colour are framed in yellow',
      prereq: ['A signed-in account.', 'Only the main profile (or someone who knows its code) can add profiles.'],
      steps: [
        { text: `Tap your avatar at the top right (1), then ${e('Switch profile')} (2).`, shot: '01-avatar', alt: 'Laststream home, avatar menu open: the avatar and the “Switch profile” entry are framed.' },
        { text: `On the ${e('Who’s watching?')} screen, tap the ${e('Add a profile')} tile.`, shot: '02-ajouter', alt: '“Who’s watching?” screen: the “Add a profile” tile is framed, next to the Camille profile.' },
        { text: `In ${e('New profile')}, type their name (1, 20 characters max). If you like, pick an avatar with ${e('Change avatar')} (2), then a colour from the 8 swatches (3).`, shot: '03-nom-couleur', alt: '“New profile” window: the name field (Léo), the “Change avatar” button and the colour swatches are numbered 1 to 3.' },
        { text: [`Optional: a 4-digit ${e('Profile PIN code')} (1), asked from then on to open this profile.`, `Tap ${e('Create profile')} at the top right (2).`], shot: '04-code-pin', alt: 'Bottom of the “New profile” window: the 4 PIN boxes and the “Create profile” button are framed.' },
        { text: `The new profile shows up next to the others. Tap ${e('Done')} to go back to ${e('Who’s watching?')}, then tap the profile to open it.`, shot: '05-profil-cree', alt: '“Manage profiles” screen: the new Léo profile is framed, next to Camille.' },
      ],
      sections: [{ tip: [
        `To edit a profile: ${e('Manage profiles')}, then tap the profile. You can change its name, avatar, colour or PIN code.`,
        `To delete a profile: same path, then the danger zone at the bottom (type its name to confirm). The main profile cannot be deleted.`,
        `For a child, follow the <a href="/en/guides/kids-profile/">Create a kids profile</a> guide instead.`,
      ] }],
    },
  },
  {
    id: 'profil-enfant', minutes: 3, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Créer un profil enfant',
      lead: 'Un profil enfant n’affiche que les titres dont la classification d’âge est connue et inférieure ou égale à l’âge choisi. Le code parental est demandé pour en sortir.',
      ogAlt: 'Fenêtre « Nouveau profil » : l’interrupteur « Profil enfant » est encadré en jaune',
      steps: [
        { text: `Ouvre ${q('Nouveau profil')} comme dans le guide <a href="/guides/creer-un-profil/">Créer un profil</a> (avatar, ${q('Changer de profil')}, ${q('Ajouter un profil')}), puis saisis son prénom.` },
        { text: `Dans ${q('Contrôle parental')}, active ${q('Profil enfant')}.`, shot: '01-case-enfant', alt: 'Section « Contrôle parental » : l’interrupteur « Profil enfant » est activé et encadré.' },
        { text: `Choisis l’${q('Âge maximal')} (1)&nbsp;: 10, 12, 16 ou 18 ans (12 par défaut). Coche les ${q('Rubriques autorisées')} (2), voir le tableau plus bas.`, shot: '02-rubriques', alt: 'Le menu « Âge maximal » (12 ans) et la liste des rubriques autorisées sont numérotés 1 et 2.' },
        { text: [`Si le profil principal n’a pas encore de code parental, saisis-en un de 4 chiffres (1). C’est lui qui protège la sortie du profil enfant.`, `Touche ${q('Créer le profil')} (2).`], shot: '03-code-parental', alt: 'Les 4 cases du code parental, remplies, et le bouton « Créer le profil » sont encadrés.' },
        { text: `Touche ${q('Terminé')}, puis le profil enfant&nbsp;: son accueil ne montre que des titres de son âge.`, shot: '04-accueil-enfant', alt: 'Accueil du profil enfant Lina, avec le film d’animation « Petit Renard et la forêt » ; son avatar est encadré.' },
      ],
      sections: [
        { id: 'rubriques', title: 'Rubriques autorisées', html: `
<table class="guide-table">
  <thead>
    <tr><th scope="col">Rubrique</th><th scope="col">Cochée par défaut</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Dessins animés</th><td>Oui</td></tr>
    <tr><th scope="row">Films en famille</th><td>Oui</td></tr>
    <tr><th scope="row">Séries jeunesse</th><td>Oui</td></tr>
    <tr><th scope="row">Classiques Disney et Pixar</th><td>Oui</td></tr>
    <tr><th scope="row">Animés pour les jeunes</th><td>Oui</td></tr>
    <tr><th scope="row">Nouveautés jeunesse</th><td>Oui</td></tr>
    <tr><th scope="row">Plateformes (Disney+, Netflix)</th><td>Oui</td></tr>
    <tr><th scope="row">TV jeunesse</th><td>Non</td></tr>
  </tbody>
</table>
<p>Sans «&nbsp;TV jeunesse&nbsp;», l’onglet TV est masqué pour l’enfant.</p>` },
        { id: 'sortie', title: 'Sortir du profil enfant', html: `
<p>Touche son avatar, puis «&nbsp;Changer de profil&nbsp;»&nbsp;: le code parental est demandé.</p>
<figure class="shot">
  <img src="./img/05-sortie-code-1280.webp" srcset="./img/05-sortie-code-1280.webp 1280w, ./img/05-sortie-code.webp 2560w" sizes="(min-width: 900px) 700px, calc(100vw - 84px)" width="1280" height="800" loading="lazy" alt="Clavier « Code parental » affiché au-dessus de l’accueil du profil enfant.">
</figure>` },
        { tip: [
          'Un titre sans classification d’âge est masqué.',
          'L’enfant ne voit pas les Réglages, les Statistiques, les amis ni le partage de bibliothèque.',
        ] },
      ],
    },
    en: {
      slug: 'kids-profile', title: 'Create a kids profile',
      card: 'Set up a profile for the youngest, next to the other profiles at home.',
      lead: 'A kids profile only shows titles whose age rating is known and at or below the chosen age. The parental code is needed to leave it.',
      ogAlt: '“New profile” window: the “Kids profile” switch is framed in yellow',
      steps: [
        { text: `Open ${e('New profile')} as in the <a href="/en/guides/create-a-profile/">Create a profile</a> guide (avatar, ${e('Switch profile')}, ${e('Add a profile')}), then type their name.` },
        { text: `Under ${e('Parental controls')}, turn on ${e('Kids profile')}.`, shot: '01-case-enfant', alt: '“Parental controls” section: the “Kids profile” switch is on and framed.' },
        { text: `Choose the ${e('Maximum age')} (1): 10, 12, 16 or 18 (12 by default). Tick the ${e('Allowed sections')} (2), see the table below.`, shot: '02-rubriques', alt: 'The “Maximum age” menu (12 years) and the list of allowed sections are numbered 1 and 2.' },
        { text: [`If the main profile has no parental code yet, type a 4-digit one (1). It protects leaving the kids profile.`, `Tap ${e('Create profile')} (2).`], shot: '03-code-parental', alt: 'The 4 filled parental code boxes and the “Create profile” button are framed.' },
        { text: `Tap ${e('Done')}, then the kids profile: its home only shows titles for its age.`, shot: '04-accueil-enfant', alt: 'Home of the kids profile Lina, with the animated film “Petit Renard et la forêt”; its avatar is framed.' },
      ],
      sections: [
        { id: 'sections', title: 'Allowed sections', html: `
<table class="guide-table">
  <thead>
    <tr><th scope="col">Section</th><th scope="col">Ticked by default</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Cartoons</th><td>Yes</td></tr>
    <tr><th scope="row">Family movies</th><td>Yes</td></tr>
    <tr><th scope="row">Kids series</th><td>Yes</td></tr>
    <tr><th scope="row">Disney and Pixar classics</th><td>Yes</td></tr>
    <tr><th scope="row">Anime for kids</th><td>Yes</td></tr>
    <tr><th scope="row">New for kids</th><td>Yes</td></tr>
    <tr><th scope="row">Platforms (Disney+, Netflix)</th><td>Yes</td></tr>
    <tr><th scope="row">Kids TV</th><td>No</td></tr>
  </tbody>
</table>
<p>Without “Kids TV”, the TV tab is hidden for the child.</p>` },
        { id: 'leave', title: 'Leaving the kids profile', html: `
<p>Tap its avatar, then “Switch profile”: the parental code is asked.</p>
<figure class="shot">
  <img src="./img/05-sortie-code-1280.webp" srcset="./img/05-sortie-code-1280.webp 1280w, ./img/05-sortie-code.webp 2560w" sizes="(min-width: 900px) 700px, calc(100vw - 84px)" width="1280" height="800" loading="lazy" alt="“Parental code” keypad shown over the kids profile home.">
</figure>` },
        { tip: [
          'A title with no age rating is hidden.',
          'The child does not see Settings, Statistics, friends or library sharing.',
        ] },
      ],
    },
  },
  {
    id: 'ajouter-une-source', minutes: 3, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Ajouter une source (extension Stremio)',
      lead: 'Laststream accepte les extensions (addons) Stremio&nbsp;: tu colles l’adresse de leur manifest et leurs liens apparaissent quand tu lances un titre.',
      ogAlt: 'Réglages, Sources : le champ de l’URL du manifest est encadré en jaune',
      prereq: ['Un compte connecté, sur le profil principal.', 'L’adresse du manifest de l’extension (elle finit en général par <code>/manifest.json</code>).'],
      steps: [
        { text: `Touche ton avatar, puis ${q('Réglages')}.`, shot: '01-menu-reglages', alt: 'Menu de l’avatar ouvert : l’entrée « Réglages » est encadrée.' },
        { text: `Dans la colonne de gauche, choisis ${q('Sources')} (1), puis ${q('Ajouter un addon Stremio')} (2).`, shot: '02-reglages-sources', alt: 'Réglages : la catégorie « Sources » et le bouton « Ajouter un addon Stremio » sont numérotés 1 et 2.' },
        { text: [`Colle l’adresse dans ${q('URL de l’addon amont')}. Les liens <code>stremio://</code> sont acceptés, et <code>/manifest.json</code> est ajouté s’il manque.`, 'Sur les captures, l’adresse commence par <code>http://localhost</code>&nbsp;: c’est l’extension d’exemple plus bas, lancée en local pour le guide. Toi, tu colles l’adresse fournie par l’extension que tu veux installer.'], shot: '03-url-addon', alt: 'Nouvelle carte d’addon : le champ « URL de l’addon amont », rempli, est encadré.' },
        { text: `Le manifest est lu tout de suite&nbsp;: le nom, le logo et l’état de l’addon s’affichent (1). Touche ${q('Enregistrer')} en bas des Réglages (2).`, shot: '04-addon-lu', alt: 'La carte « Mon addon » avec son logo et son état, et le bouton « Enregistrer », sont numérotés 1 et 2.' },
        { text: `Ouvre la fiche d’un film et touche ${q('Lecture')}&nbsp;: les liens de l’addon apparaissent dans le panneau ${q('Sources')}.`, shot: '05-fiche-sources', alt: 'Panneau « Sources » d’un film : le lien fourni par « Mon addon » est encadré.' },
      ],
      sections: [
        { tip: [
          `Menu ${q('…')} d’une carte&nbsp;: modifier, ouvrir la configuration, copier l’URL, activer ou désactiver, retirer.`,
          'L’ordre compte&nbsp;: la source 1 est interrogée en premier. Change-le avec la poignée ⋮⋮ ou les flèches ↑ ↓.',
          `Pour désinstaller&nbsp;: ${q('Retirer')}, puis ${q('Enregistrer')}.`,
          'La clé de débridage ne se saisit pas dans Laststream&nbsp;: chaque addon gère le débridage dans sa propre configuration.',
        ] },
        { id: 'exemple', title: 'Exemple&nbsp;: une extension basique', html: `
<p>Une extension est un petit service web qui expose deux adresses&nbsp;: <code>/manifest.json</code> et <code>/stream/{type}/{id}.json</code>.</p>
<p>Le manifest&nbsp;:</p>
<pre><code>{
  "id": "exemple.mon-addon",
  "version": "1.0.0",
  "name": "Mon addon",
  "description": "Exemple de source pour Laststream",
  "resources": ["stream"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"],
  "catalogs": []
}</code></pre>
<p>Réponse de <code>/stream/movie/tt0000001.json</code>&nbsp;:</p>
<pre><code>{
  "streams": [
    {
      "name": "Mon addon",
      "title": "1080p",
      "url": "https://exemple.com/video.mp4"
    }
  ]
}</code></pre>
<p>C’est exactement l’extension utilisée pour les captures de ce guide.</p>` },
      ],
    },
    en: {
      slug: 'add-a-source', title: 'Add a source (Stremio extension)',
      card: 'Connect the Stremio extensions you want to use in Laststream.',
      lead: 'Laststream accepts Stremio extensions (addons): paste the address of their manifest and their links show up when you play a title.',
      ogAlt: 'Settings, Sources: the manifest URL field is framed in yellow',
      prereq: ['A signed-in account, on the main profile.', 'The address of the extension’s manifest (it usually ends with <code>/manifest.json</code>).'],
      steps: [
        { text: `Tap your avatar, then ${e('Settings')}.`, shot: '01-menu-reglages', alt: 'Avatar menu open: the “Settings” entry is framed.' },
        { text: `In the left column, choose ${e('Sources')} (1), then ${e('Add a Stremio addon')} (2).`, shot: '02-reglages-sources', alt: 'Settings: the “Sources” category and the “Add a Stremio addon” button are numbered 1 and 2.' },
        { text: [`Paste the address into ${e('Upstream addon URL')}. <code>stremio://</code> links are accepted, and <code>/manifest.json</code> is added if missing.`, 'On the screenshots the address starts with <code>http://localhost</code>: it is the example extension below, run locally for the guide. You paste the address given by the extension you want to install.'], shot: '03-url-addon', alt: 'New addon card: the filled “Upstream addon URL” field is framed.' },
        { text: `The manifest is read right away: the addon’s name, logo and status appear (1). Tap ${e('Save')} at the bottom of Settings (2).`, shot: '04-addon-lu', alt: 'The “Mon addon” card with its logo and status, and the “Save” button, are numbered 1 and 2.' },
        { text: `Open a movie and tap ${e('Play')}: the addon’s links appear in the ${e('Sources')} panel.`, shot: '05-fiche-sources', alt: 'A movie’s “Sources” panel: the link provided by “Mon addon” is framed.' },
      ],
      sections: [
        { tip: [
          'A card’s “…” menu: edit, open the configuration, copy the URL, enable or disable, remove.',
          'Order matters: source 1 is queried first. Change it with the ⋮⋮ handle or the ↑ ↓ arrows.',
          'To uninstall: remove, then “Save”.',
          'The debrid key is not entered in Laststream: each addon handles debrid in its own configuration.',
        ] },
        { id: 'example', title: 'Example: a basic extension', html: `
<p>An extension is a small web service that exposes two addresses: <code>/manifest.json</code> and <code>/stream/{type}/{id}.json</code>.</p>
<p>The manifest:</p>
<pre><code>{
  "id": "exemple.mon-addon",
  "version": "1.0.0",
  "name": "Mon addon",
  "description": "Exemple de source pour Laststream",
  "resources": ["stream"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"],
  "catalogs": []
}</code></pre>
<p>Response of <code>/stream/movie/tt0000001.json</code>:</p>
<pre><code>{
  "streams": [
    {
      "name": "Mon addon",
      "title": "1080p",
      "url": "https://exemple.com/video.mp4"
    }
  ]
}</code></pre>
<p>This is exactly the extension used for this guide’s screenshots.</p>` },
      ],
    },
  },
  {
    id: 'tv-en-direct', minutes: 5, platforms: ['win', 'android'],
    fr: {
      title: 'Configurer la TV en direct (playlist M3U)',
      lead: 'La TV en direct lit des playlists M3U fournies par ton opérateur ou ton service IPTV, et en option un guide des programmes XMLTV.',
      ogAlt: 'Réglages, TV en direct : les champs de la playlist M3U sont numérotés de 1 à 4',
      prereq: ['L’app Windows ou Android&nbsp;: un navigateur ne peut pas joindre la plupart des playlists.', 'L’adresse de ta playlist M3U (et, si tu l’as, celle du guide XMLTV).'],
      steps: [
        { text: `Touche ton avatar, puis ${q('Réglages')}, puis ${q('TV en direct')} dans la colonne de gauche.`, shot: '01-reglages-tv', alt: 'Réglages : la catégorie « TV en direct » est encadrée.' },
        { text: [`Dans ${q('Ajouter une playlist M3U')}, renseigne un nom (1, facultatif), l’${q('Adresse de la playlist')} (2) et, si tu l’as, le ${q('Guide des programmes (XMLTV)')} (3, <code>.xml</code> ou <code>.xml.gz</code>).`, `Touche ${q('Ajouter la playlist')} (4). Tu peux aussi ${q('Importer un fichier')} <code>.m3u</code> depuis l’appareil.`], shot: '02-formulaire', alt: 'Formulaire « Ajouter une playlist M3U » rempli : nom, adresse de la playlist, guide XMLTV et bouton « Ajouter la playlist » numérotés de 1 à 4.' },
        { text: `Quand le message ${q('… chaînes ajoutées, guide à jour')} s’affiche, reviens à l’accueil et ouvre l’onglet ${q('Direct')}.`, shot: '03-onglet-direct', alt: 'Barre du haut de l’accueil : l’onglet « Direct » est encadré.' },
        { text: `Tes chaînes apparaissent avec le badge ${q('Box')}, avec leurs programmes. La colonne de gauche filtre par catégorie.`, shot: '04-chaines', alt: 'Page « TV en direct » : la première chaîne de la playlist et ses programmes sont encadrés.' },
        { text: `Touche un programme pour voir sa fiche, puis ${q('Regarder')}.`, shot: '05-guide', alt: 'Fiche du programme en cours, avec le bouton « Regarder », encadrée au-dessus de la grille des programmes.' },
      ],
      sections: [
        { tip: [
          `Abonné Freebox&nbsp;: ${q('Détecter ma Freebox')} ajoute les chaînes de la box sans rien saisir.`,
          'Chaque playlist se désactive, s’actualise ou se retire depuis sa ligne, dans «&nbsp;Playlists M3U&nbsp;».',
          'Les playlists du compte sont gérées par le profil principal.',
        ] },
        { id: 'format', title: 'Format attendu', html: `
<pre><code>#EXTM3U
#EXTINF:-1 tvg-id="chaine1.fr" tvg-name="Chaîne 1" tvg-logo="https://exemple.com/logo1.png" group-title="Généralistes" tvg-chno="1",Chaîne 1
https://exemple.com/live/chaine1.m3u8</code></pre>
<p>La première ligne doit être <code>#EXTM3U</code>. Chaque <code>#EXTINF</code> est suivi de l’adresse du flux (http, https, rtsp, rtp ou udp). <code>group-title</code> donne la catégorie, <code>tvg-chno</code> le numéro (1 à 9999), <code>tvg-id</code> fait le lien avec le guide XMLTV.</p>
<table class="guide-table">
  <thead>
    <tr><th scope="col">Limite</th><th scope="col">Valeur</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Taille d’une playlist</th><td>20 Mo</td></tr>
    <tr><th scope="row">Délai de chargement</th><td>20 s</td></tr>
    <tr><th scope="row">Actualisation automatique</th><td>toutes les 24 h</td></tr>
    <tr><th scope="row">Playlists par compte</th><td>20</td></tr>
    <tr><th scope="row">Guide des programmes</th><td>de maintenant à +24 h</td></tr>
  </tbody>
</table>` },
        { id: 'probleme', title: 'Si ça ne marche pas', html: `
<ul>
  <li><strong>«&nbsp;Cette adresse ne renvoie pas une playlist M3U.&nbsp;»</strong> → l’adresse pointe vers une page web ou un fichier d’un autre format.</li>
  <li><strong>«&nbsp;Aucune chaîne trouvée dans cette playlist.&nbsp;»</strong> → fichier vide ou mal formé.</li>
  <li><strong>«&nbsp;Adresse injoignable&nbsp;»</strong> → vérifie l’adresse et ta connexion (et le réseau de ta box pour une Freebox).</li>
  <li><strong>Dans un navigateur</strong> → un navigateur web ne peut pas joindre la plupart des playlists&nbsp;: utilise l’app Windows ou Android.</li>
</ul>` },
      ],
    },
    en: {
      slug: 'live-tv', title: 'Set up live TV (M3U playlist)',
      card: 'Get live TV ready to watch your channels in Laststream.',
      lead: 'Live TV reads M3U playlists from your provider or IPTV service, and optionally an XMLTV programme guide.',
      ogAlt: 'Settings, Live TV: the M3U playlist fields are numbered 1 to 4',
      prereq: ['The Windows or Android app: a browser cannot reach most playlists.', 'Your M3U playlist address (and, if you have one, the XMLTV guide address).'],
      steps: [
        { text: `Tap your avatar, then ${e('Settings')}, then ${e('Live TV')} in the left column.`, shot: '01-reglages-tv', alt: 'Settings: the “Live TV” category is framed.' },
        { text: [`In ${e('Add an M3U playlist')}, fill in a name (1, optional), the ${e('Playlist address')} (2) and, if you have it, the ${e('Programme guide (XMLTV)')} (3, <code>.xml</code> or <code>.xml.gz</code>).`, `Tap ${e('Add playlist')} (4). You can also ${e('Import a file')} (<code>.m3u</code>) from the device.`], shot: '02-formulaire', alt: 'Filled “Add an M3U playlist” form: name, playlist address, XMLTV guide and “Add playlist” button numbered 1 to 4.' },
        { text: `Once the “… channels added, guide updated” message shows, go back home and open the ${e('Live')} tab.`, shot: '03-onglet-direct', alt: 'Top bar of the home screen: the “Live” tab is framed.' },
        { text: `Your channels appear with the ${e('Box')} badge, with their programmes. The left column filters by category.`, shot: '04-chaines', alt: '“Live TV” page: the playlist’s first channel and its programmes are framed.' },
        { text: `Tap a programme to see its details, then ${e('Watch')}.`, shot: '05-guide', alt: 'Details of the programme on now, with the “Watch” button, framed above the programme grid.' },
      ],
      sections: [
        { tip: [
          'Freebox subscriber: “Detect my Freebox” adds the box’s channels without typing anything.',
          'Each playlist can be disabled, refreshed or removed from its row, under “M3U playlists”.',
          'The account’s playlists are managed by the main profile.',
        ] },
        { id: 'format', title: 'Expected format', html: `
<pre><code>#EXTM3U
#EXTINF:-1 tvg-id="channel1.fr" tvg-name="Channel 1" tvg-logo="https://example.com/logo1.png" group-title="General" tvg-chno="1",Channel 1
https://example.com/live/channel1.m3u8</code></pre>
<p>The first line must be <code>#EXTM3U</code>. Each <code>#EXTINF</code> is followed by the stream address (http, https, rtsp, rtp or udp). <code>group-title</code> gives the category, <code>tvg-chno</code> the number (1 to 9999), <code>tvg-id</code> links to the XMLTV guide.</p>
<table class="guide-table">
  <thead>
    <tr><th scope="col">Limit</th><th scope="col">Value</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Playlist size</th><td>20 MB</td></tr>
    <tr><th scope="row">Loading timeout</th><td>20 s</td></tr>
    <tr><th scope="row">Automatic refresh</th><td>every 24 h</td></tr>
    <tr><th scope="row">Playlists per account</th><td>20</td></tr>
    <tr><th scope="row">Programme guide</th><td>from now to +24 h</td></tr>
  </tbody>
</table>` },
        { id: 'trouble', title: 'If it does not work', html: `
<ul>
  <li><strong>“This address does not return an M3U playlist.”</strong> → the address points to a web page or a file in another format.</li>
  <li><strong>“No channel found in this playlist.”</strong> → empty or malformed file.</li>
  <li><strong>“Address unreachable”</strong> → check the address and your connection (and your box’s network for a Freebox).</li>
  <li><strong>In a browser</strong> → a web browser cannot reach most playlists: use the Windows or Android app.</li>
</ul>
<p>The app shows these messages in French.</p>` },
      ],
    },
  },
];
