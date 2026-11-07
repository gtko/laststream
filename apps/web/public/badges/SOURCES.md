# Logos des formats (sélecteur de sources)

Logos officiels des formats audio et vidéo, affichés dans les badges du sélecteur de sources (`src/sources/badges.ts`).
Fichiers récupérés sur Wikimedia Commons, nettoyés (métadonnées, scripts, liens et images embarquées retirés ; `viewBox`
ajouté à `av1.svg` s'il manquait). Aucun fichier n'a été redessiné.

Licence : les fichiers sont dans le domaine public (ou, pour les mentions indiquées, sous une licence libre) selon
Commons. Cette licence couvre le droit d'auteur du dessin, pas la marque : chaque logo reste une marque déposée de son
titulaire, mentionnée ci-dessous. Les titulaires sont ceux crédités par Commons ; l'enregistrement des marques n'a pas
été vérifié.

| Fichier publié | Format | Source (Commons) | Licence | Mention |
|---|---|---|---|---|
| `dolby-vision.svg` | Dolby Vision | https://commons.wikimedia.org/wiki/File:Dolby_Vision_2021_logo.svg | Domaine public | marque déposée de Dolby Laboratories, Inc. |
| `dolby-atmos.svg` | Dolby Atmos | https://commons.wikimedia.org/wiki/File:Dolby_Atmos_(logo).svg | Domaine public (auteur non renseigné) | marque déposée de Dolby Laboratories, Inc. |
| `dolby-digital.svg` | Dolby Digital | https://commons.wikimedia.org/wiki/File:Dolby-Digital.svg | Domaine public | marque déposée de Dolby Laboratories, Inc. |
| `dolby-digital-plus.svg` | Dolby Digital Plus | https://commons.wikimedia.org/wiki/File:Dolby-Digital-Plus.svg | Domaine public | marque déposée de Dolby Laboratories, Inc. |
| `dolby-truehd.svg` | Dolby TrueHD | https://commons.wikimedia.org/wiki/File:Dolby_TrueHD.svg | Domaine public | marque déposée de Dolby Laboratories, Inc. |
| `dts-hd-ma.svg` | DTS-HD Master Audio | https://commons.wikimedia.org/wiki/File:DTS-HD-MA.svg | Domaine public | marque déposée de DTS, Inc. |
| `dts.svg` | DTS (logo 2020) | https://commons.wikimedia.org/wiki/File:DTS_(2020).svg | Domaine public | marque déposée de DTS, Inc. (Xperi) |
| `hdr10.svg` | HDR10 | https://commons.wikimedia.org/wiki/File:HDR_10_logo_(black).svg | Domaine public (version noire, auteur Premeditated) | marque déposée de UHD Alliance |
| `hdr10plus.svg` | HDR10+ | https://commons.wikimedia.org/wiki/File:HDR_10_plus_logo_(black).svg | Domaine public (version noire, auteur Premeditated) | marque déposée de HDR10+ Technologies, LLC |
| `av1.svg` | AV1 | https://commons.wikimedia.org/wiki/File:AV1_logo_2018.svg | Domaine public | marque de l'Alliance for Open Media (AOMedia) |
| `avc.svg` | AVC / H.264 | https://commons.wikimedia.org/wiki/File:H.264,_MPEG-4_AVC_logo.svg | Domaine public | marque déposée de MPEG LA (aujourd'hui Via LA) |
| `opus.svg` | Opus | https://commons.wikimedia.org/wiki/File:Opus_logo2.svg | Domaine public | logo du projet Opus (Xiph.Org Foundation) |
| `aac.svg` | AAC | https://commons.wikimedia.org/wiki/File:AAC_original_logo.svg | Domaine public | logo AAC original (crédité Dolby Laboratories Inc.) |

`hdr10plus.svg` est la version noire publiée sur Commons. Le logo officiel HDR10+ (Samsung, CC BY-SA 4.0,
https://commons.wikimedia.org/wiki/File:HDR10%2B_Logo.svg) n'a pas été retenu : il contient des images bitmap embarquées.

## Formats sans logo publié (badge maison conservé)

- DTS:X : seul un PNG existe (https://commons.wikimedia.org/wiki/File:DTS_X_B%26W.png, CC BY-SA 4.0), pas de SVG.
- HEVC (H.265) : seul un JPG existe (https://commons.wikimedia.org/wiki/File:H.265_logo.jpg), pas de SVG.
- HLG : aucun logo trouvé sur Commons.
- HDR générique, REMUX, BluRay, WEB-DL, FLAC, VP9 et les canaux : pas de logo de marque, badges maison.

Pour ajouter un logo : déposer le SVG nettoyé ici, ajouter une ligne dans ce fichier et dans la table `LOGOS` de
`src/sources/badges.ts`.
