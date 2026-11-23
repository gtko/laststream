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
  {
    id: 'inviter-un-proche', minutes: 2, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Inviter un proche',
      lead: 'L’inscription se fait sur invitation. Offre un de tes billets de parrainage&nbsp;: un lien personnel, avec ton mot et trois titres à lui faire découvrir.',
      ogAlt: 'Billet de parrainage ouvert : le mot, les trois coups de cœur et le bouton « Copier le lien » sont encadrés en jaune',
      prereq: ['Un compte connecté, sur un profil adulte.', 'Quelques titres dans ta bibliothèque si tu veux proposer des coups de cœur.'],
      steps: [
        { text: `Ouvre les ${q('Réglages')} (ton avatar en haut à droite), catégorie ${q('Profil')}. Touche ${q('Mes billets de parrainage')} pour déplier tes billets.`, shot: '01-billets', alt: 'Réglages, Profil et compte : la carte « Mes billets de parrainage » (4 billets disponibles) est encadrée.' },
        { text: `Choisis un billet disponible&nbsp;: ${q('Offrir ce billet')}.`, shot: '02-offrir', alt: 'Les quatre billets orange « Offrir ce billet » ; le premier est encadré.' },
        { text: [`Écris ton mot (1, 280 caractères maximum)&nbsp;: il s’affiche sur sa page d’arrivée. Choisis jusqu’à 3 coups de cœur dans ta bibliothèque (2).`, `Touche ${q('Copier le lien')} (3), ou ${q('Partager…')} pour l’envoyer directement depuis ton téléphone.`], shot: '03-billet', alt: 'Billet en cours de personnalisation : le mot, trois affiches cochées et le bouton « Copier le lien » sont numérotés de 1 à 3.' },
        { text: `Envoie le lien comme tu veux (message, e-mail…). Le billet passe en ${q('Envoyé, en attente')} jusqu’à ce que ton proche crée son compte.`, shot: '04-envoye', alt: 'Le premier billet affiche « En attente », avec le mot envoyé et les boutons « Copier à nouveau » et « Annuler le billet ».' },
      ],
      sections: [{ tip: [
        'Chaque billet ne sert qu’une fois. Le lien est valable 14 jours après l’envoi&nbsp;; s’il n’est pas utilisé, le billet te revient.',
        `${q('Annuler le billet')} le récupère tout de suite si tu t’es trompé de personne.`,
        `Ton filleul pourra devenir ton ami en un clic. Plus rapide, sans personnalisation&nbsp;: le panneau Amis, ${q('Inviter quelqu’un')}, ${q('Copier un lien')}.`,
        `Pour donner accès à un de tes profils (même foyer), c’est la carte ${q('Invitations du foyer')}, juste en dessous.`,
      ] }],
    },
    en: {
      slug: 'invite-someone', title: 'Invite someone',
      card: 'Give one of your invitation tickets, with a personal note and three titles to discover.',
      lead: 'Sign-up is by invitation. Give one of your invitation tickets: a personal link, with your note and three titles for them to discover.',
      ogAlt: 'Invitation ticket open: the note, the three favourites and the “Copy link” button are framed in yellow',
      prereq: ['A signed-in account, on an adult profile.', 'A few titles in your library if you want to suggest favourites.'],
      steps: [
        { text: `Open ${e('Settings')} (your avatar at the top right), ${e('Profile')} category. Tap ${e('My invitation tickets')} to unfold your tickets.`, shot: '01-billets', alt: 'Settings, Profile and account: the “My invitation tickets” card (4 tickets available) is framed.' },
        { text: `Pick an available ticket: ${e('Give this ticket')}.`, shot: '02-offrir', alt: 'The four orange “Give this ticket” tickets; the first one is framed.' },
        { text: [`Write your note (1, 280 characters max): it shows on their welcome page. Pick up to 3 favourites from your library (2).`, `Tap ${e('Copy link')} (3), or ${e('Share…')} to send it straight from your phone.`], shot: '03-billet', alt: 'Ticket being personalised: the note, three ticked posters and the “Copy link” button are numbered 1 to 3.' },
        { text: `Send the link however you like (message, email…). The ticket shows ${e('Sent, pending')} until they create their account.`, shot: '04-envoye', alt: 'The first ticket shows “Pending”, with the note sent and the “Copy again” and “Cancel ticket” buttons.' },
      ],
      sections: [{ tip: [
        'Each ticket works once. The link is valid for 14 days after sending; if nobody uses it, the ticket comes back to you.',
        `${e('Cancel ticket')} gets it back right away if you picked the wrong person.`,
        `The person you invite can become your friend in one click. Quicker, without a note: the Friends panel, ${e('Invite someone')}, ${e('Copy a link')}.`,
        `To give access to one of your profiles (same household), use the ${e('Household invitations')} card just below.`,
      ] }],
    },
  },
  {
    id: 'importer-stremio', minutes: 3, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Importer sa bibliothèque Stremio',
      lead: 'Retrouve ta bibliothèque, tes titres vus et ta progression Stremio dans ton profil Laststream. L’import lit ton compte sans jamais le modifier.',
      ogAlt: 'Aperçu de l’import Stremio : les catégories cochées et le bouton « Importer 12 éléments » sont encadrés en jaune',
      prereq: ['Ton e-mail et ton mot de passe Stremio, ou un fichier d’export Stremio.', 'Le profil Laststream qui doit recevoir les titres, ouvert.'],
      steps: [
        { text: `Ouvre les ${q('Réglages')}, catégorie ${q('Profil')}, et descends jusqu’à ${q('Importer depuis une autre app')}.`, shot: '01-importer', alt: 'Réglages : la carte « Importer depuis une autre app, Stremio, Nuvio, Simkl, Plex » est encadrée.' },
        { text: `Choisis ${q('Compte Stremio')} (1). Sans connexion à ton compte, ${q('Fichier d’export Stremio')} (2) lit un fichier sur cet appareil.`, shot: '02-compte-stremio', alt: 'Liste des sources d’import : « Compte Stremio » et « Fichier d’export Stremio » sont numérotés 1 et 2.' },
        { text: [`Lis l’avertissement puis touche ${q('J’ai compris, continuer')}.`, `Saisis ton e-mail (1) et ton mot de passe Stremio (2), puis ${q('Lire ma bibliothèque')} (3).`], shot: '03-identifiants', alt: 'Formulaire « Lecture seule, depuis cet appareil » : l’e-mail, le mot de passe et le bouton « Lire ma bibliothèque » sont numérotés de 1 à 3.' },
        { text: `Laststream montre ce qui peut être importé&nbsp;: ${q('Bibliothèque')}, ${q('Liste «&nbsp;À voir&nbsp;»')}, ${q('Vus')}, ${q('Progression de lecture')}. Décoche ce que tu ne veux pas (1), puis ${q('Importer')} (2).`, shot: '04-apercu', alt: 'Aperçu de l’import : quatre catégories cochées avec leur nombre et le bouton « Importer 12 éléments ».' },
        { text: `À la fin, le bilan donne les éléments réussis, ignorés et échoués. Touche ${q('Voir ma bibliothèque')}.`, shot: '05-termine', alt: 'Import Stremio terminé : 12 réussis, 0 ignoré, 0 échoué ; le bouton « Voir ma bibliothèque » est encadré.' },
        { text: 'Tes titres Stremio sont dans ta bibliothèque, avec leur état vu et leur progression.', shot: '06-bibliotheque', alt: 'La bibliothèque de Laststream avec six titres importés.' },
      ],
      sections: [{ tip: [
        'Ton e-mail et ton mot de passe partent directement de ton appareil vers Stremio. Ni Laststream ni ton serveur ne les reçoivent, et ils ne sont pas gardés.',
        'Rien n’est modifié sur ton compte Stremio&nbsp;: tu peux continuer à l’utiliser comme avant.',
        'Les titres sans équivalent (chaînes TV, titres propres à un addon) sont ignorés, et le rapport dit pourquoi. Tu peux le copier ou le télécharger.',
        `La même carte importe aussi une sauvegarde Nuvio, un export Simkl ou l’historique d’un serveur Plex. L’import va dans le profil ouvert&nbsp;: refais-le pour chaque profil.`,
      ] }],
    },
    en: {
      slug: 'import-from-stremio', title: 'Import your Stremio library',
      card: 'Bring your Stremio library, watched titles and progress into Laststream.',
      lead: 'Bring your Stremio library, watched titles and progress into your Laststream profile. The import reads your account and never changes it.',
      ogAlt: 'Stremio import preview: the ticked categories and the “Import 12 items” button are framed in yellow',
      prereq: ['Your Stremio email and password, or a Stremio export file.', 'The Laststream profile that should get the titles, open.'],
      steps: [
        { text: `Open ${e('Settings')}, ${e('Profile')} category, and scroll down to ${e('Import from another app')}.`, shot: '01-importer', alt: 'Settings: the “Import from another app, Stremio, Nuvio, Simkl, Plex” card is framed.' },
        { text: `Pick ${e('Stremio account')} (1). Without signing in to your account, ${e('Stremio export file')} (2) reads a file on this device.`, shot: '02-compte-stremio', alt: 'Import sources list: “Stremio account” and “Stremio export file” are numbered 1 and 2.' },
        { text: [`Read the notice, then tap ${e('Got it, continue')}.`, `Type your Stremio email (1) and password (2), then ${e('Read my library')} (3).`], shot: '03-identifiants', alt: '“Read-only, from this device” form: the email, the password and the “Read my library” button are numbered 1 to 3.' },
        { text: `Laststream shows what can be imported: ${e('Library')}, ${e('Watchlist')}, ${e('Watched')}, ${e('Playback progress')}. Untick what you don’t want (1), then ${e('Import')} (2).`, shot: '04-apercu', alt: 'Import preview: four ticked categories with their count and the “Import 12 items” button.' },
        { text: `At the end, the summary gives the items imported, skipped and failed. Tap ${e('See my library')}.`, shot: '05-termine', alt: 'Stremio import finished: 12 imported, 0 skipped, 0 failed; the “See my library” button is framed.' },
        { text: 'Your Stremio titles are in your library, with their watched state and progress.', shot: '06-bibliotheque', alt: 'The Laststream library with six imported titles.' },
      ],
      sections: [{ tip: [
        'Your email and password go straight from your device to Stremio. Neither Laststream nor your server receives them, and they are not kept.',
        'Nothing changes on your Stremio account: you can keep using it as before.',
        'Titles with no match (TV channels, addon-only titles) are skipped, and the report says why. You can copy or download it.',
        'The same card also imports a Nuvio backup, a Simkl export or a Plex server’s history. The import goes into the open profile: do it again for each profile.',
      ] }],
    },
  },
  {
    id: 'ajouter-des-amis', minutes: 2, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Ajouter des amis',
      lead: 'Chaque profil a un identifiant Nom#TAG. Échange-le avec tes amis pour voir qui est en ligne, discuter et lancer des watch parties.',
      ogAlt: 'Panneau Amis : le champ « Chercher ou ajouter Nom#TAG », rempli, et le bouton d’ajout sont encadrés en jaune',
      prereq: ['Un compte connecté, sur un profil adulte.', 'Le Nom#TAG de ton ami (il le trouve au même endroit).'],
      steps: [
        { text: `Touche le bouton ${q('Amis')} en haut à droite.`, shot: '01-bouton-amis', alt: 'Page Bibliothèque : le bouton Amis, en haut à droite, est encadré.' },
        { text: `En haut du panneau, ton propre Nom#TAG (1)&nbsp;: touche-le pour le copier et l’envoyer à ton ami. Le champ en dessous (2) sert à ajouter le sien.`, shot: '02-ton-tag', alt: 'Panneau Amis ouvert : l’identifiant Camille#TAG et le champ « Chercher ou ajouter Nom#TAG » sont numérotés 1 et 2.' },
        { text: `Saisis le Nom#TAG de ton ami, exactement, majuscules du tag comprises (1), puis touche le bouton d’ajout (2).`, shot: '03-ajouter', alt: 'Le champ contient Léo#TAG ; le champ et le bouton d’ajout sont numérotés 1 et 2.' },
        { text: `La demande apparaît dans ${q('Demandes')}, ${q('demande envoyée')}.`, shot: '04-demande-envoyee', alt: 'Rubrique « Demandes » : Léo, « demande envoyée », est encadré.' },
        { text: 'De son côté, ton ami voit ta demande dans son panneau Amis et l’accepte avec la coche.', shot: '05-accepter', alt: 'Panneau Amis de Léo : la demande de Camille, « veut devenir ton ami », et la coche d’acceptation encadrée.' },
        { text: `C’est fait&nbsp;: ton ami apparaît dans ta liste, avec son statut (${q('En ligne')}…).`, shot: '06-ami-en-ligne', alt: 'Panneau Amis de Camille : Léo apparaît dans la rubrique « En ligne ».' },
      ],
      sections: [{ tip: [
        `Les onglets ${q('Messages')} et ${q('Activité')} du panneau servent à discuter et à voir ce que regardent tes amis.`,
        `Touche ton statut sous ton nom pour passer en ${q('Absent')}, ${q('Ne pas déranger')} ou ${q('Invisible')}.`,
        'Un ami invité avec un de tes billets de parrainage peut devenir ton ami en un clic, sans échanger de Nom#TAG.',
        'Les profils enfants n’ont pas d’amis ni de messages.',
      ] }],
    },
    en: {
      slug: 'add-friends', title: 'Add friends',
      card: 'Swap your Name#TAG with your friends to see who’s online and watch together.',
      lead: 'Each profile has a Name#TAG. Swap it with your friends to see who’s online, chat and start watch parties.',
      ogAlt: 'Friends panel: the “Search or add Name#TAG” field, filled in, and the add button are framed in yellow',
      prereq: ['A signed-in account, on an adult profile.', 'Your friend’s Name#TAG (they find it in the same place).'],
      steps: [
        { text: `Tap the ${e('Friends')} button at the top right.`, shot: '01-bouton-amis', alt: 'Library page: the Friends button, top right, is framed.' },
        { text: `At the top of the panel, your own Name#TAG (1): tap it to copy it and send it to your friend. The field below (2) is for adding theirs.`, shot: '02-ton-tag', alt: 'Friends panel open: the Camille#TAG handle and the “Search or add Name#TAG” field are numbered 1 and 2.' },
        { text: `Type your friend’s Name#TAG exactly, tag letters included (1), then tap the add button (2).`, shot: '03-ajouter', alt: 'The field contains Léo#TAG; the field and the add button are numbered 1 and 2.' },
        { text: `The request shows under ${e('Requests')}, ${e('request sent')}.`, shot: '04-demande-envoyee', alt: '“Requests” section: Léo, “request sent”, is framed.' },
        { text: 'On their side, your friend sees your request in their Friends panel and accepts it with the tick.', shot: '05-accepter', alt: 'Léo’s Friends panel: Camille’s request, “wants to be your friend”, and the framed accept tick.' },
        { text: `Done: your friend is in your list, with their status (${e('Online')}…).`, shot: '06-ami-en-ligne', alt: 'Camille’s Friends panel: Léo shows in the “Online” section.' },
      ],
      sections: [{ tip: [
        `The panel’s ${e('Messages')} and ${e('Activity')} tabs are for chatting and seeing what your friends are watching.`,
        `Tap your status under your name to switch to ${e('Away')}, ${e('Do not disturb')} or ${e('Invisible')}.`,
        'Someone you invited with one of your tickets can become your friend in one click, without swapping Name#TAGs.',
        'Kids profiles have no friends or messages.',
      ] }],
    },
  },
  {
    id: 'watch-party', minutes: 3, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Lancer une watch party',
      lead: 'Regardez le même film au même moment, chacun chez soi. Chacun lit avec sa propre source&nbsp;: la watch party cale vos lectures l’une sur l’autre, aucun flux vidéo n’est partagé.',
      ogAlt: 'Salon d’attente d’une watch party : le lien à partager, l’onglet « Inviter des amis » et le bouton de lancement sont encadrés en jaune',
      prereq: ['Un compte connecté, sur un profil adulte.', 'Au moins un ami (voir <a href="/guides/ajouter-des-amis/">Ajouter des amis</a>), ou le lien du salon à partager.', 'Une source qui trouve le titre (voir <a href="/guides/ajouter-une-source/">Ajouter une source Stremio</a>).'],
      steps: [
        { text: 'Ouvre la fiche du film et touche le bouton «&nbsp;…&nbsp;» à côté de Lecture.', shot: '01-plus-actions', alt: 'Fiche du film « Les Gardiens du phare » : le bouton « … » est encadré.' },
        { text: `Choisis ${q('Regarder avec…')}.`, shot: '02-menu-fiche', alt: 'Menu de la fiche ouvert : l’entrée « Regarder avec… » est encadrée.' },
        { text: `Tes amis en ligne sont listés, avec ${q('Inviter')}. Pour réunir plusieurs personnes, touche ${q('Ouvrir un salon pour ce titre')}.`, shot: '03-regarder-avec', alt: 'Fenêtre « Regarder avec… » : Léo, en ligne, et le lien « Ouvrir un salon pour ce titre » encadré.' },
        { text: [`Garde ${q('Privé')} (1) pour tes seuls invités, ou choisis ${q('Public')} pour lister le salon dans ${q('Watch parties')}.`, `Coche les amis à inviter (2), puis ${q('Ouvrir le salon d’attente')} (3).`], shot: '04-salon', alt: 'Fenêtre Watch party : « Privé », la case de Léo cochée et le bouton « Ouvrir le salon d’attente » sont numérotés de 1 à 3.' },
        { text: [`Dans le salon d’attente, chacun voit sa source se préparer. Partage le lien (1) à quelqu’un qui n’a pas de compte, ou invite d’autres amis (2).`, `Quand tout le monde est prêt, lance la lecture (3)&nbsp;: les lectures restent calées ensemble.`], shot: '05-salon-attente', alt: 'Salon d’attente : le bouton « Copier » du lien, l’onglet « Inviter des amis » et le bouton « Lancer » sont numérotés de 1 à 3.' },
      ],
      sections: [{ tip: [
        `Réglages du salon&nbsp;: ${q('Qui contrôle la lecture')} (tout le monde ou l’hôte), ${q('Attendre les retardataires')} et ${q('Réactions à l’écran')}.`,
        'Le lien du salon accepte aussi des personnes sans compte&nbsp;: 4 places, valable 12&nbsp;h. Un salon reçoit jusqu’à 20 participants.',
        `La page ${q('Ensemble')} regroupe les salons ouverts, ${q('Rejoindre avec un code')} et ${q('Planifier une soirée')} pour plus tard.`,
        'Chacun regarde avec sa propre source et sa propre langue&nbsp;: si ta source n’est pas dans la langue du salon, le salon te le signale.',
      ] }],
    },
    en: {
      slug: 'watch-party', title: 'Start a watch party',
      card: 'Watch the same film at the same time, each at home.',
      lead: 'Watch the same film at the same time, each at home. Everyone plays their own source: the watch party keeps your playback in sync, no video stream is shared.',
      ogAlt: 'Watch party waiting room: the link to share, the “Invite friends” tab and the start button are framed in yellow',
      prereq: ['A signed-in account, on an adult profile.', 'At least one friend (see <a href="/en/guides/add-friends/">Add friends</a>), or the room link to share.', 'A source that finds the title (see <a href="/en/guides/add-a-source/">Add a Stremio source</a>).'],
      steps: [
        { text: 'Open the film’s page and tap the “…” button next to Play.', shot: '01-plus-actions', alt: '“Les Gardiens du phare” film page: the “…” button is framed.' },
        { text: `Pick ${e('Watch with…')}.`, shot: '02-menu-fiche', alt: 'Page menu open: the “Watch with…” entry is framed.' },
        { text: `Your online friends are listed, with ${e('Invite')}. To bring several people together, tap ${e('Open a room for this title')}.`, shot: '03-regarder-avec', alt: '“Watch with…” window: Léo, online, and the framed “Open a room for this title” link.' },
        { text: [`Keep ${e('Private')} (1) for your guests only, or pick ${e('Public')} to list the room under ${e('Watch parties')}.`, `Tick the friends to invite (2), then ${e('Open the waiting room')} (3).`], shot: '04-salon', alt: 'Watch party window: “Private”, Léo’s ticked box and the “Open the waiting room” button are numbered 1 to 3.' },
        { text: [`In the waiting room, everyone sees their source getting ready. Share the link (1) with someone who has no account, or invite more friends (2).`, `When everyone is ready, start playback (3): playback stays in sync.`], shot: '05-salon-attente', alt: 'Waiting room: the link’s “Copy” button, the “Invite friends” tab and the “Start” button are numbered 1 to 3.' },
      ],
      sections: [{ tip: [
        `Room settings: ${e('Who controls playback')} (everyone or the host), ${e('Wait for latecomers')} and ${e('On-screen reactions')}.`,
        'The room link also lets in people without an account: 4 seats, valid for 12 h. A room takes up to 20 people.',
        `The ${e('Together')} page gathers open rooms, ${e('Join with a code')} and ${e('Plan an evening')} for later.`,
        'Everyone watches with their own source and language: if your source is not in the room’s language, the room tells you.',
      ] }],
    },
  },
  {
    id: 'partager-sa-bibliotheque', minutes: 1, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Partager sa bibliothèque',
      lead: 'Ta bibliothèque est privée par défaut. Rends visibles par tes amis les titres de ton choix, ou toute ta bibliothèque d’un coup.',
      ogAlt: 'Page Ma liste : l’œil sur une affiche est encadré en jaune',
      prereq: ['Un compte connecté, sur un profil adulte (les profils enfants ne partagent rien).', 'Des titres dans ta bibliothèque, et des amis pour les voir.'],
      steps: [
        { text: `Ouvre le menu ${q('Explorer')} (1), puis ${q('Ma liste')} (2). Sur téléphone, c’est l’onglet ${q('Ma liste')} en bas de l’écran.`, shot: '01-ma-liste', alt: 'Accueil, menu Explorer ouvert : « Explorer » et « Ma liste » sont numérotés 1 et 2.' },
        { text: 'Chaque affiche porte un œil en haut à droite. Barré, le titre est privé.', shot: '02-oeil', alt: 'Bibliothèque : l’œil barré sur l’affiche « La Maison des brumes » est encadré.' },
        { text: 'Touche l’œil&nbsp;: il s’ouvre, et le titre est visible par tes amis. Touche-le à nouveau pour le rendre privé.', shot: '03-titre-partage', alt: 'L’œil, maintenant ouvert et orange, est encadré ; le message « Visible par tes amis » s’affiche en bas.' },
        { text: `Pour tout changer d’un coup&nbsp;: ${q('Partager avec mes amis')} (1) ou ${q('Tout garder privé')} (2). Avec le filtre ${q('Films')} ou ${q('Séries')}, seuls ces titres changent.`, shot: '04-tout-partager', alt: 'Les boutons « Partager avec mes amis » et « Tout garder privé » sont numérotés 1 et 2.' },
        { text: 'Laststream demande confirmation, puis indique combien de titres sont visibles par tes amis.', shot: '05-partagee', alt: 'Sous les boutons, le texte « 4 titres visibles par tes amis. » est encadré.' },
      ],
      sections: [{ tip: [
        `Tes amis voient tes titres partagés dans leur panneau Amis&nbsp;: ils touchent ton nom, puis ${q('Voir toute sa bibliothèque')}. Ils peuvent les ajouter à leur propre bibliothèque.`,
        'Un titre ajouté ensuite reste privé tant que tu n’ouvres pas son œil.',
      ] }],
    },
    en: {
      slug: 'share-your-library', title: 'Share your library',
      card: 'Let your friends see the titles you choose, or your whole library.',
      lead: 'Your library is private by default. Let your friends see the titles you choose, or your whole library at once.',
      ogAlt: 'My list page: the eye on a poster is framed in yellow',
      prereq: ['A signed-in account, on an adult profile (kids profiles share nothing).', 'Titles in your library, and friends to see them.'],
      steps: [
        { text: `Open the ${e('Explore')} menu (1), then ${e('My list')} (2). On a phone, it’s the ${e('My list')} tab at the bottom of the screen.`, shot: '01-ma-liste', alt: 'Home, Explore menu open: “Explore” and “My list” are numbered 1 and 2.' },
        { text: 'Each poster has an eye at the top right. Crossed out, the title is private.', shot: '02-oeil', alt: 'Library: the crossed-out eye on the “La Maison des brumes” poster is framed.' },
        { text: 'Tap the eye: it opens, and your friends can see the title. Tap it again to make it private.', shot: '03-titre-partage', alt: 'The eye, now open and orange, is framed; the message “Visible to your friends” shows at the bottom.' },
        { text: `To change everything at once: ${e('Share with my friends')} (1) or ${e('Keep everything private')} (2). With the ${e('Movies')} or ${e('Series')} filter, only those titles change.`, shot: '04-tout-partager', alt: 'The “Share with my friends” and “Keep everything private” buttons are numbered 1 and 2.' },
        { text: 'Laststream asks you to confirm, then tells you how many titles your friends can see.', shot: '05-partagee', alt: 'Under the buttons, the text “4 titles visible to your friends.” is framed.' },
      ],
      sections: [{ tip: [
        `Your friends see your shared titles in their Friends panel: they tap your name, then ${e('See their whole library')}. They can add them to their own library.`,
        'A title you add later stays private until you open its eye.',
      ] }],
    },
  },
  {
    id: 'sous-titres-et-langues', minutes: 1, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Sous-titres et langues',
      lead: 'Choisis une fois la langue de l’audio et des sous-titres&nbsp;: Laststream les applique au début de chaque lecture sur ce profil.',
      ogAlt: 'Réglages Audio et sous-titres : la langue audio principale et la langue secondaire sont encadrées en jaune',
      steps: [
        { text: `Ouvre les ${q('Réglages')} (ton avatar en haut à droite), catégorie ${q('Audio')} (1). Choisis ta ${q('Langue audio principale')} (2), puis la ${q('Langue audio secondaire')} (3), utilisée quand la principale manque dans la source.`, shot: '01-langue-audio', alt: 'Réglages, catégorie Audio : la langue audio principale (Français) et la secondaire (Version originale) sont numérotées 2 et 3.' },
        { text: `Active ${q('Sous-titres hors langue principale')} (1) pour avoir des sous-titres quand l’audio n’est pas dans ta langue, et choisis leur langue (2).`, shot: '02-sous-titres', alt: 'Carte Sous-titres : l’interrupteur activé et la langue « Identique à la langue principale » sont numérotés 1 et 2.' },
        { text: `Pour les animes, active ${q('Réglages spécifiques aux animes')}&nbsp;: par exemple l’audio japonais avec des sous-titres français, sans toucher aux autres titres.`, shot: '03-anime', alt: 'Carte Anime : l’interrupteur « Réglages spécifiques aux animes » est encadré.' },
      ],
      sections: [{ tip: [
        'Dans ta langue principale, seuls les sous-titres forcés (panneaux, dialogues étrangers) restent affichés.',
        `${q('Version originale')} en langue secondaire prend la langue d’origine du titre.`,
        'Pendant la lecture, les boutons Piste audio et Sous-titres du lecteur changent la piste pour ce film seulement.',
        'Les sous-titres viennent d’abord du fichier, puis des sous-titres externes. Un anime est un titre classé Animation et d’origine japonaise.',
      ] }],
    },
    en: {
      slug: 'subtitles-and-languages', title: 'Subtitles and languages',
      card: 'Pick your audio and subtitle languages once, for every playback.',
      lead: 'Pick your audio and subtitle languages once: Laststream applies them at the start of every playback on this profile.',
      ogAlt: 'Audio and subtitles settings: the main and secondary audio languages are framed in yellow',
      steps: [
        { text: `Open ${e('Settings')} (your avatar at the top right), ${e('Audio')} category (1). Pick your ${e('Main audio language')} (2), then the ${e('Secondary audio language')} (3), used when the main one is missing from the source.`, shot: '01-langue-audio', alt: 'Settings, Audio category: the main audio language (French) and the secondary one (Original version) are numbered 2 and 3.' },
        { text: `Turn on ${e('Subtitles outside the main language')} (1) to get subtitles when the audio isn’t in your language, and pick their language (2).`, shot: '02-sous-titres', alt: 'Subtitles card: the switch turned on and the language “Same as main language” are numbered 1 and 2.' },
        { text: `For anime, turn on ${e('Anime-specific settings')}: for example Japanese audio with subtitles in your language, without changing other titles.`, shot: '03-anime', alt: 'Anime card: the “Anime-specific settings” switch is framed.' },
      ],
      sections: [{ tip: [
        'In your main language, only forced subtitles (signs, foreign dialogue) stay on.',
        `${e('Original version')} as the secondary language picks the title’s original language.`,
        'During playback, the player’s Audio track and Subtitles buttons change the track for that film only.',
        'Subtitles come from the file first, then from external subtitles. An anime is a title classed as Animation and of Japanese origin.',
      ] }],
    },
  },
  {
    id: 'lecture-confort', minutes: 2, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Lecture confort',
      lead: 'Lancement direct, qualité adaptée à ta connexion, intros sautées, épisodes enchaînés&nbsp;: les réglages qui rendent la lecture plus simple.',
      ogAlt: 'Réglages Lecture : « Passer l’intro » et « Enchaîner l’épisode suivant » sont encadrés en jaune',
      steps: [
        { text: `Ouvre les ${q('Réglages')}, catégorie ${q('Lecture')} (1). ${q('Lancer la meilleure source')} (2) démarre la lecture sans passer par la liste des sources.`, shot: '01-lancement', alt: 'Réglages, catégorie Lecture : l’entrée du menu et la ligne « Lancer la meilleure source » sont numérotées 1 et 2.' },
        { text: `${q('Résolution maximale')} (1) plafonne la qualité choisie d’office, pour économiser des données. ${q('Débit de ma connexion')} (2) écarte les sources trop lourdes pour ta connexion&nbsp;: laisse ${q('Automatique (mesure)')} ou choisis un débit.`, shot: '02-qualite', alt: 'Cartes Résolution et Connexion : « Automatique (selon l’écran) » et « Automatique (mesure) » sont numérotés 1 et 2.' },
        { text: `Pour les séries&nbsp;: ${q('Passer l’intro')} (1) saute le générique d’ouverture quand il est repéré, ${q('Enchaîner l’épisode suivant')} (2) lance la suite à la fin du générique. ${q('Passer le récapitulatif')} saute le «&nbsp;précédemment&nbsp;».`, shot: '03-series', alt: 'Carte Séries et épisodes : « Passer l’intro » et « Enchaîner l’épisode suivant » sont numérotés 1 et 2.' },
        { text: `Si la lecture saccade sur une source lente, augmente la ${q('Taille de la mémoire tampon')}&nbsp;: ${q('Grand')} ou ${q('Maximum')}.`, shot: '04-tampon', alt: 'Carte Mémoire tampon : le choix « Grand » est encadré.' },
      ],
      sections: [{ tip: [
        'La résolution maximale ne t’empêche jamais de choisir une autre source à la main.',
        `${q('Tester ma connexion')} mesure ton débit tout de suite.`,
        'Sur Android, un grand tampon retarde un peu le démarrage et les sauts (jusqu’à 30&nbsp;s en Maximum). Le réglage s’applique à la lecture suivante.',
        `Animes&nbsp;: ${q('Passer les épisodes filler')} saute les épisodes de remplissage dans l’enchaînement.`,
      ] }],
    },
    en: {
      slug: 'playback-comfort', title: 'Playback comfort',
      card: 'Start right away, match quality to your connection, skip intros.',
      lead: 'Instant start, quality suited to your connection, skipped intros, back-to-back episodes: the settings that make playback easier.',
      ogAlt: 'Playback settings: “Skip intro” and “Play next episode” are framed in yellow',
      steps: [
        { text: `Open ${e('Settings')}, ${e('Playback')} category (1). ${e('Start the best source')} (2) starts playback without going through the source list.`, shot: '01-lancement', alt: 'Settings, Playback category: the menu entry and the “Start the best source” row are numbered 1 and 2.' },
        { text: `${e('Maximum resolution')} (1) caps the quality picked for you, to save data. ${e('My connection speed')} (2) leaves out sources too heavy for your connection: keep ${e('Automatic (measured)')} or pick a speed.`, shot: '02-qualite', alt: 'Resolution and Connection cards: “Automatic (screen-based)” and “Automatic (measured)” are numbered 1 and 2.' },
        { text: `For series: ${e('Skip intro')} (1) skips the opening credits when they’re detected, ${e('Play next episode')} (2) starts the next one after the end credits. ${e('Skip recap')} skips the “previously on”.`, shot: '03-series', alt: 'Series and episodes card: “Skip intro” and “Play next episode” are numbered 1 and 2.' },
        { text: `If playback stutters on a slow source, raise the ${e('Buffer size')}: ${e('Large')} or ${e('Maximum')}.`, shot: '04-tampon', alt: 'Buffer card: the “Large” choice is framed.' },
      ],
      sections: [{ tip: [
        'The maximum resolution never stops you from picking another source by hand.',
        `${e('Test my connection')} measures your speed right away.`,
        'On Android, a large buffer slightly delays the start and seeking (up to 30 s on Maximum). It applies from the next playback.',
        `Anime: ${e('Skip filler episodes')} skips filler episodes when playing back to back.`,
      ] }],
    },
  },
  {
    id: 'nettoyer-recommandations', minutes: 2, platforms: ['win', 'android', 'web'],
    fr: {
      title: 'Nettoyer ses recommandations',
      lead: 'Un titre ou un genre ne t’intéresse pas&nbsp;? Retire-le de l’accueil. Il reste trouvable dans la recherche et sur sa fiche.',
      ogAlt: 'Menu d’une affiche de l’accueil : l’entrée « Ne plus proposer » est encadrée en jaune',
      steps: [
        { text: `Sur l’accueil, touche le «&nbsp;…&nbsp;» d’une affiche (ou clic droit, ou appui long), puis ${q('Ne plus proposer')}.`, shot: '01-ne-plus-proposer', alt: 'Accueil, menu d’une affiche ouvert : l’entrée « Ne plus proposer » est encadrée.' },
        { text: 'Depuis la fiche d’un titre, c’est le bouton «&nbsp;…&nbsp;» à côté de Lecture…', shot: '02-plus-actions', alt: 'Fiche du film « Rivages de cendre » : le bouton « … » est encadré.' },
        { text: `…puis ${q('Ne plus proposer sur l’accueil')}.`, shot: '03-depuis-la-fiche', alt: 'Menu de la fiche ouvert : l’entrée « Ne plus proposer sur l’accueil » est encadrée.' },
        { text: [`Dans les ${q('Réglages')}, catégorie ${q('Accueil')}&nbsp;: ${q('Titres masqués')} (1) compte les titres retirés, et ${q('Gérer')} permet de les remettre.`, `Sous ${q('Genres à ne jamais proposer')}, touche un genre (2) pour sortir tous ses titres de l’accueil. ${q('Tout réinitialiser')} les remet tous.`], shot: '04-reglages-accueil', alt: 'Réglages, Accueil et recommandations : « Titres masqués — 2 titres » et le genre Horreur coché sont numérotés 1 et 2.' },
      ],
      sections: [{ tip: [
        'Les films vus ou regardés à 90&nbsp;% et les séries vues en entier ne sont plus proposés sur l’accueil. Ils restent dans la bibliothèque, la recherche et la fiche.',
        'Ces choix valent pour le profil ouvert seulement.',
      ] }],
    },
    en: {
      slug: 'clean-up-recommendations', title: 'Clean up your recommendations',
      card: 'Remove titles and genres you don’t want to see on Home.',
      lead: 'Not interested in a title or a genre? Remove it from Home. It can still be found through search and on its page.',
      ogAlt: 'Poster menu on Home: the “Don’t suggest again” entry is framed in yellow',
      steps: [
        { text: `On Home, tap a poster’s “…” (or right-click, or long-press), then ${e('Don’t suggest again')}.`, shot: '01-ne-plus-proposer', alt: 'Home, poster menu open: the “Don’t suggest again” entry is framed.' },
        { text: 'From a title’s page, it’s the “…” button next to Play…', shot: '02-plus-actions', alt: '“Rivages de cendre” film page: the “…” button is framed.' },
        { text: `…then ${e('Don’t suggest on Home')}.`, shot: '03-depuis-la-fiche', alt: 'Page menu open: the “Don’t suggest on Home” entry is framed.' },
        { text: [`In ${e('Settings')}, ${e('Home')} category: ${e('Hidden titles')} (1) counts the titles you removed, and ${e('Manage')} brings them back.`, `Under ${e('Genres never to suggest')}, tap a genre (2) to take all its titles off Home. ${e('Reset all')} brings them all back.`], shot: '04-reglages-accueil', alt: 'Settings, Home and recommendations: “Hidden titles — 2 titles” and the ticked Horror genre are numbered 1 and 2.' },
      ],
      sections: [{ tip: [
        'Films watched or played to 90% and series watched in full are no longer suggested on Home. They stay in your library, search and their page.',
        'These choices apply to the open profile only.',
      ] }],
    },
  },
];
