#!/usr/bin/env bash
# Règles de cycle de vie du bucket R2 des fiches (ODY-297). À lancer une fois, à la main :
#   bash scripts/r2-meta-lifecycle.sh
# Un objet consulté est réécrit à chaque échéance (voir src/lt/meta.ts), donc il survit ; un titre que
# personne ne consulte plus disparaît 365 jours après son dernier upload. Les objets v1 (une fiche par
# fichier, sans langue) ne sont plus lus que pour reprendre les notes : 60 jours suffisent.
set -euo pipefail

BUCKET="${META_BUCKET:-lastaddon-meta}"

npx wrangler r2 bucket lifecycle add "$BUCKET" expire-meta-v2 meta/v2/ --expire-days 365
npx wrangler r2 bucket lifecycle add "$BUCKET" expire-meta-v1-movie meta/movie/ --expire-days 60
npx wrangler r2 bucket lifecycle add "$BUCKET" expire-meta-v1-series meta/series/ --expire-days 60

npx wrangler r2 bucket lifecycle list "$BUCKET"
