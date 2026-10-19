# -*- coding: utf-8 -*-
"""Verifie un lot d'avatars genere dans .avatars-build/<lot>/ (contrat CONTRAT.md, sections 1, 2, 5).

Controles :
  - collections.json : liste valide, ids de collection et de personnage conformes a la regex,
    champs obligatoires, doublons interdits, previews inclus dans characters (max 8),
    plafond de 400 personnages sauf Pokemon, characters <= total ;
  - chaque characters[i] a son fichier i/<colId>/<charId>.webp, WebP de 128x128 ;
  - aucun fichier orphelin dans i/.

Usage : python -I scripts/avatars/check_lot.py <lot> [--min-collections N]
Code de sortie : 0 si conforme, 1 sinon.
"""
import argparse
import json
import os
import re
import site
import sys

sys.path.insert(0, site.getusersitepackages())
from PIL import Image  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
FAMILIES = {"heroes", "disney", "anime", "series", "games", "free"}
MAX_CHARS = 400
MAX_PREVIEWS = 8
THUMB = (128, 128)
MAX_SHOWN = 20


def main():
    ap = argparse.ArgumentParser(description="Verifie un lot d'avatars")
    ap.add_argument("lot")
    ap.add_argument("--min-collections", type=int, default=1)
    args = ap.parse_args()

    lot_dir = os.path.normpath(os.path.join(ROOT, ".avatars-build", args.lot))
    img_dir = os.path.join(lot_dir, "i")
    errors = []

    def err(msg):
        errors.append(msg)

    try:
        with open(os.path.join(lot_dir, "collections.json"), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        print("ECHEC : collections.json illisible : %s" % exc)
        return 1
    if not isinstance(data, list):
        print("ECHEC : collections.json doit etre une liste")
        return 1
    if len(data) < args.min_collections:
        err("%d collections, minimum attendu %d" % (len(data), args.min_collections))

    expected_files = set()
    seen_cols = set()
    n_chars = 0
    for col in data:
        cid = col.get("id")
        where = "collection %r" % cid
        if not isinstance(cid, str) or not ID_RE.match(cid):
            err("%s : id non conforme" % where)
            continue
        if cid in seen_cols:
            err("%s : doublon" % where)
        seen_cols.add(cid)
        if col.get("family") not in FAMILIES:
            err("%s : family invalide (%r)" % (where, col.get("family")))
        for key in ("name", "source", "license"):
            if not isinstance(col.get(key), str) or not col.get(key).strip():
                err("%s : %s manquant" % (where, key))
        if not isinstance(col.get("free"), bool) or not isinstance(col.get("kid"), bool):
            err("%s : free/kid doivent etre des booleens" % where)
        if not isinstance(col.get("aliases"), list) or not all(isinstance(a, str) for a in col.get("aliases", [])):
            err("%s : aliases doit etre une liste de chaines" % where)
        if ("group" in col) != ("style" in col):
            err("%s : group et style vont ensemble" % where)
        total = col.get("total")
        if not isinstance(total, int) or total < 1:
            err("%s : total invalide" % where)

        chars = col.get("characters")
        if not isinstance(chars, list) or not chars:
            err("%s : characters vide ou absent" % where)
            continue
        if len(chars) > MAX_CHARS and not cid.startswith("pokemon-"):
            err("%s : %d personnages, plafond %d depasse" % (where, len(chars), MAX_CHARS))
        if isinstance(total, int) and len(chars) > total:
            err("%s : characters (%d) > total (%d)" % (where, len(chars), total))

        char_ids = set()
        for ch in chars:
            chid = ch.get("id") if isinstance(ch, dict) else None
            if not isinstance(chid, str) or not ID_RE.match(chid):
                err("%s : charId non conforme (%r)" % (where, chid))
                continue
            if chid in char_ids:
                err("%s : charId en double (%s)" % (where, chid))
            char_ids.add(chid)
            if not isinstance(ch.get("name"), str) or not ch.get("name").strip():
                err("%s : nom manquant pour %s" % (where, chid))
            expected_files.add(os.path.normcase(os.path.normpath(os.path.join(img_dir, cid, chid + ".webp"))))
        n_chars += len(chars)

        previews = col.get("previews")
        if not isinstance(previews, list) or len(previews) > MAX_PREVIEWS or len(set(previews)) != len(previews):
            err("%s : previews invalides (liste de %d max, sans doublon)" % (where, MAX_PREVIEWS))
        elif not set(previews) <= char_ids:
            err("%s : previews hors de characters (%s)" % (where, sorted(set(previews) - char_ids)))

    # fichiers images : presence, format, taille
    missing, bad = [], []
    for path in sorted(expected_files):
        if not os.path.isfile(path):
            missing.append(path)
            continue
        try:
            with Image.open(path) as im:
                if im.format != "WEBP" or im.size != THUMB:
                    bad.append("%s (%s %dx%d)" % (path, im.format, im.size[0], im.size[1]))
        except Exception as exc:  # noqa: BLE001
            bad.append("%s (%s)" % (path, exc))
    if missing:
        err("%d fichiers images manquants" % len(missing))
    if bad:
        err("%d images non conformes (WebP 128x128 attendu)" % len(bad))

    orphans = []
    if os.path.isdir(img_dir):
        for root, _dirs, files in os.walk(img_dir):
            for f in files:
                p = os.path.normcase(os.path.normpath(os.path.join(root, f)))
                if p not in expected_files:
                    orphans.append(p)
    if orphans:
        err("%d fichiers orphelins dans i/" % len(orphans))

    print("collections=%d personnages=%d images_attendues=%d" % (len(data), n_chars, len(expected_files)))
    for title, items in (("manquant", missing), ("non conforme", bad), ("orphelin", orphans)):
        for item in items[:MAX_SHOWN]:
            print("  %s : %s" % (title, item))
        if len(items) > MAX_SHOWN:
            print("  ... %d autres (%s)" % (len(items) - MAX_SHOWN, title))
    for msg in errors:
        print("ERREUR : " + msg)
    if errors:
        print("ECHEC : %d erreur(s) sur le lot %s" % (len(errors), args.lot))
        return 1
    print("OK : lot %s conforme" % args.lot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
