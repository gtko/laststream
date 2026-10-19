# -*- coding: utf-8 -*-
"""Lot anime : collections d'avatars (AniList + API fan), tous les personnages.

Usage : python -I scripts/avatars/lot_anime.py --manifest <dossier>/lots/anime/manifest.json

Entree : manifest.json du premier passage (ids, noms, sources des 45 collections).
Sorties (dans .avatars-build/anime/) :
  collections.json                 collections au format contrat (section 5)
  i/<colId>/<charId>.webp          vignettes 128x128, WebP q78, carre pris en haut (tete)
  _cache/                          JSON bruts (AniList, API fan) et echecs.txt
Reprise : les JSON en cache et les vignettes deja presentes ne sont pas rechargees.
"""
import argparse
import concurrent.futures as cf
import io
import json
import os
import re
import shutil
import site
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, site.getusersitepackages())
from PIL import Image  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT = os.path.join(ROOT, ".avatars-build", "anime")
IMG = os.path.join(OUT, "i")
CACHE = os.path.join(OUT, "_cache")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
ANILIST = "https://graphql.anilist.co"
ANILIST_GAP = 1.2       # secondes entre deux requetes AniList
ANILIST_WAIT = 60       # attente apres un 429
CAP = 400               # personnages max par collection
PER_PAGE = 25           # maximum AniList par page de characters
PREVIEWS = 8
MIN_CHARS = 5           # en dessous, collection ecartee
ALIAS_MAX = 12
SIZE = 128
QUALITY = 78
WORKERS = 12
TRIES = 3
ID_MAX = 48
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
LICENCE = "propriétaire (studio)"
DEFAULT_IMG = "default.jpg"

PAGE_Q = ("query($page:Int){Page(page:$page,perPage:50){media(type:ANIME,sort:POPULARITY_DESC,isAdult:false)"
          "{id title{romaji english} synonyms}}}")
SEARCH_Q = "query($s:String){Media(search:$s,type:ANIME){id title{romaji english} synonyms}}"
CHARS_Q = ("query($id:Int,$page:Int){Media(id:$id,type:ANIME){characters(sort:FAVOURITES_DESC,page:$page,perPage:25)"
           "{pageInfo{hasNextPage} nodes{id name{full} image{large}}}}}")

_last = [0.0]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------- HTTP (repris de scripts/fetch.py : UA navigateur, reessais) ----------
def safe_url(url):
    return urllib.parse.quote(url, safe=":/?&=%#+,;@!$'()*~[]")


def http(url, data=None, ctype=None, accept="*/*", referer=None, tries=TRIES, timeout=60):
    """GET, ou POST si data. Les 4xx (hors 429) ne sont pas reessayes."""
    last = None
    for k in range(tries):
        try:
            headers = {"User-Agent": UA, "Accept": accept}
            if referer:
                headers["Referer"] = referer
            if ctype:
                headers["Content-Type"] = ctype
            req = urllib.request.Request(safe_url(url), data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code < 500 and exc.code != 429:
                raise
            last = exc
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(1.5 * (k + 1))
    raise last


def fetch_json(url):
    return json.loads(http(url, accept="application/json").decode("utf-8"))


def anilist(query, variables):
    """Requete GraphQL AniList : 1 requete / 1,2 s ; sur 429, attente 60 s puis reprise."""
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    for _ in range(6):
        wait = ANILIST_GAP - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            raw = http(ANILIST, data=body, ctype="application/json", accept="application/json", tries=1)
        except urllib.error.HTTPError as exc:
            if exc.code != 429:
                raise
            log("AniList 429 : attente %d s" % ANILIST_WAIT)
            time.sleep(ANILIST_WAIT)
            continue
        d = json.loads(raw.decode("utf-8"))
        if d.get("errors") and not d.get("data"):
            raise RuntimeError("AniList : %s" % str(d["errors"])[:200])
        return d.get("data") or {}
    raise RuntimeError("AniList : 429 persistant")


# ---------- Cache JSON ----------
def cached(name, produce):
    path = os.path.join(CACHE, name + ".json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    value = produce()
    os.makedirs(CACHE, exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False)
    os.replace(path + ".tmp", path)
    return value


# ---------- Textes et identifiants ----------
def slug(text, maxlen=ID_MAX):
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:maxlen].rstrip("-")
    return t or "x"


def unique_id(name, used):
    base = slug(name)
    cand, i = base, 2
    while cand in used:
        suffix = "-%d" % i
        cand = base[:ID_MAX - len(suffix)].rstrip("-") + suffix
        i += 1
    used.add(cand)
    return cand


def words(text):
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def head(text):
    """Partie avant ':' ou '(' : « Demon Slayer: Kimetsu no Yaiba » -> « demon slayer »."""
    return words(re.split(r"[:(]", text, maxsplit=1)[0])


def latin_only(text):
    for ch in text:
        if ch.isalpha() and not unicodedata.name(ch, "").startswith("LATIN"):
            return False
    return True


def unique_names(items, limit=ALIAS_MAX):
    out, seen = [], set()
    for s in items:
        s = " ".join((s or "").split())
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out[:limit]


# ---------- AniList : medias ----------
def titles(m):
    t = m.get("title") or {}
    return [x for x in (t.get("english"), t.get("romaji")) if x]


def display(m):
    t = m.get("title") or {}
    return t.get("english") or t.get("romaji") or ("anime-%d" % m["id"])


def media_aliases(m):
    if not m:
        return []
    t = m.get("title") or {}
    syn = [s for s in (m.get("synonyms") or []) if latin_only(s)]
    return unique_names([t.get("english"), t.get("romaji")] + syn)


def fetch_pages():
    medias = []
    for page in (1, 2, 3):
        medias += anilist(PAGE_Q, {"page": page}).get("Page", {}).get("media") or []
    log("AniList : %d medias (pages 1 a 3)" % len(medias))
    return medias


def find_media(medias, nom):
    target = words(nom)
    for m in medias:
        if words(display(m)) == target:
            return m
    for m in medias:
        if any(words(t) == target for t in titles(m)):
            return m
    return None


def search_media(text):
    def produce():
        try:
            return (anilist(SEARCH_Q, {"s": text}).get("Media")) or None
        except RuntimeError:
            return None
    return cached("anilist_search_" + slug(text, 40), produce)


def anilist_chars(media_id):
    """Tous les personnages (favoris decroissants), pagination 25 par page, plafond CAP."""
    out, seen = [], set()
    for page in range(1, CAP // PER_PAGE + 1):
        ch = anilist(CHARS_Q, {"id": media_id, "page": page})["Media"]["characters"]
        for n in ch["nodes"]:
            if n["id"] in seen:
                continue
            seen.add(n["id"])
            img = (n.get("image") or {}).get("large") or ""
            if not img or DEFAULT_IMG in img:
                continue
            nom = " ".join(((n.get("name") or {}).get("full") or "Personnage").split())
            out.append({"nom": nom, "url": img, "referer": None})
        if not ch["pageInfo"]["hasNextPage"] or len(out) >= CAP:
            break
    return out[:CAP]


# ---------- API fan (pagination complete, plafond CAP) ----------
def src_naruto():
    out, seen = [], set()
    for page in range(1, 40):
        items = fetch_json("https://dattebayo-api.onrender.com/characters?page=%d&limit=50" % page)
        items = items.get("characters") or []
        new = 0
        for c in items:
            if c["id"] in seen:
                continue
            seen.add(c["id"])
            new += 1
            if c.get("images"):
                out.append({"nom": c["name"], "url": c["images"][0], "referer": "https://naruto.fandom.com/"})
        if not new or len(out) >= CAP:
            break
    return out[:CAP]


def src_aot():
    out, seen, url = [], set(), "https://api.attackontitanapi.com/characters"
    for _ in range(40):
        d = fetch_json(url)
        for c in d.get("results") or []:
            if c.get("id") in seen:
                continue
            seen.add(c.get("id"))
            if c.get("img"):
                out.append({"nom": c["name"], "url": c["img"], "referer": "https://attackontitan.fandom.com/"})
        nxt = (d.get("info") or {}).get("next_page")
        if not nxt or len(out) >= CAP:
            break
        url = nxt
    return out[:CAP]


def src_dbz():
    out, seen = [], set()
    for page in range(1, 40):
        d = fetch_json("https://dragonball-api.com/api/characters?page=%d&limit=60" % page)
        new = 0
        for c in d.get("items") or []:
            if c.get("deletedAt") or c["id"] in seen:
                continue
            seen.add(c["id"])
            new += 1
            if c.get("image"):
                out.append({"nom": c["name"], "url": c["image"], "referer": None})
        total_pages = (d.get("meta") or {}).get("totalPages")
        if not new or len(out) >= CAP or (total_pages and page >= total_pages):
            break
    return out[:CAP]


def src_ds():
    out, seen = [], set()
    for page in range(1, 60):
        d = fetch_json("https://www.demonslayer-api.com/api/v1/characters?page=%d" % page)
        for c in d.get("content") or []:
            if c.get("id") in seen:
                continue
            seen.add(c.get("id"))
            if c.get("img"):
                out.append({"nom": c["name"], "url": c["img"], "referer": None})
        total_pages = (d.get("pagination") or {}).get("totalPages") or 0
        if page >= total_pages or len(out) >= CAP:
            break
        time.sleep(0.3)
    return out[:CAP]


# Collections API fan du manifest : id -> (source, nom de base, groupe, style)
FAN = {
    "naruto-api-fan": (src_naruto, "Naruto", "naruto", "Wiki fan"),
    "attack-on-titan": (src_aot, "Attack on Titan", None, None),
    "dragon-ball": (src_dbz, "Dragon Ball", None, None),
    "demon-slayer-api-fan": (src_ds, "Demon Slayer", "demon-slayer", "Wiki fan"),
}
# Collections AniList appartenant a un groupe (meme univers que la version API fan)
ANILIST_GROUPS = {
    "naruto": ("naruto", "AniList"),
    "demon-slayer-kimetsu-no-yaiba": ("demon-slayer", "AniList"),
}


# ---------- Images ----------
def make_thumb(data):
    """Carre pris en haut (zone tete), 128x128, WebP q78 ; alpha conserve si utile."""
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert("RGBA")
    w, h = im.size
    s = min(w, h)
    left = (w - s) // 2
    im = im.crop((left, 0, left + s, s)).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    if im.getchannel("A").getextrema() == (255, 255):
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=QUALITY, method=6)
    return buf.getvalue()


def fetch_thumb(cid, c):
    """Renvoie None si la vignette est en place, sinon le motif d'echec."""
    path = os.path.join(IMG, cid, c["id"] + ".webp")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return None
    try:
        webp = make_thumb(http(c["url"], referer=c["referer"], accept="image/*,*/*;q=0.8", tries=TRIES))
    except Exception as exc:  # noqa: BLE001
        return repr(exc)[:160]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as fh:
        fh.write(webp)
    os.replace(tmp, path)
    return None


# ---------- Assemblage d'une collection ----------
def process(entry, medias, pool):
    cid, nom, source = entry["id"], entry["nom"], entry["source"]
    if not ID_RE.match(cid):
        raise ValueError("id de collection invalide : %s" % cid)
    if source == "AniList":
        m = find_media(medias, nom)
        if m is None:
            s = search_media(nom)
            if not s or not any(head(t) == head(nom) for t in titles(s)):
                raise RuntimeError("media AniList introuvable : %s" % nom)
            m = s
        name = display(m)
        cands = cached("anilist_chars_%d" % m["id"], lambda: anilist_chars(m["id"]))
        aliases = media_aliases(m)
        grp, style = ANILIST_GROUPS.get(cid, (None, None))
    else:
        if cid not in FAN:
            raise KeyError("source API fan non prevue pour %s" % cid)
        fn, base, grp, style = FAN[cid]
        cands = cached("fan_" + cid, fn)
        name = base
        aliases = [base]
        if grp is None:
            s = search_media(base)
            if s and any(head(t) == head(base) for t in titles(s)):
                aliases = unique_names([base] + media_aliases(s))

    used = set()
    for c in cands:
        c["id"] = unique_id(c["nom"], used)
    errs_raw = list(pool.map(lambda c: fetch_thumb(cid, c), cands))
    kept, errs = [], []
    for c, err in zip(cands, errs_raw):
        if err is None:
            kept.append({"id": c["id"], "name": c["nom"]})
        else:
            errs.append("%s | %s | %s | %s" % (cid, c["nom"], err, c["url"]))

    rec = {"id": cid, "family": "anime", "name": name}
    if grp:
        rec["group"], rec["style"] = grp, style
    rec.update({"source": source, "license": LICENCE, "free": False, "kid": False,
                "total": len(kept), "aliases": aliases[:ALIAS_MAX],
                "previews": [c["id"] for c in kept[:PREVIEWS]], "characters": kept})
    return rec, errs


def apply_groups(recs):
    """Membres d'un meme groupe : nom commun (version AniList) et alias reunis."""
    groups = {}
    for r in recs:
        if r.get("group"):
            groups.setdefault(r["group"], []).append(r)
    for members in groups.values():
        ref = next((r for r in members if r["style"] == "AniList"), members[0])
        union = unique_names([a for r in members for a in r["aliases"]])
        for r in members:
            r["name"] = ref["name"]
            r["aliases"] = union


def prune(recs):
    keep = {r["id"]: {c["id"] for c in r["characters"]} for r in recs}
    for col in os.listdir(IMG):
        d = os.path.join(IMG, col)
        if col not in keep:
            shutil.rmtree(d)
            continue
        for f in os.listdir(d):
            if not (f.endswith(".webp") and f[:-5] in keep[col]):
                os.remove(os.path.join(d, f))


def check(recs):
    probs = []
    ids = set()
    for r in recs:
        cid = r["id"]
        if not ID_RE.match(cid) or cid in ids:
            probs.append("id collection invalide ou doublon : %s" % cid)
        ids.add(cid)
        chars = [c["id"] for c in r["characters"]]
        if not chars or len(set(chars)) != len(chars) or not all(ID_RE.match(x) for x in chars):
            probs.append("ids personnages invalides : %s" % cid)
        if not set(r["previews"]) <= set(chars) or len(r["previews"]) != min(PREVIEWS, len(chars)):
            probs.append("previews hors personnages : %s" % cid)
        if r["total"] != len(chars) or len(chars) > CAP:
            probs.append("total incoherent : %s" % cid)
    return probs


def verify_images(recs):
    bad = []
    for r in recs:
        for c in r["characters"]:
            p = os.path.join(IMG, r["id"], c["id"] + ".webp")
            try:
                with Image.open(p) as im:
                    if im.format != "WEBP" or im.size != (SIZE, SIZE):
                        bad.append("%s %s %s" % (p, im.format, im.size))
            except Exception as exc:  # noqa: BLE001
                bad.append("%s %s" % (p, repr(exc)[:80]))
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="manifest.json du premier passage (45 collections)")
    args = ap.parse_args()
    t0 = time.time()
    os.makedirs(IMG, exist_ok=True)
    with open(args.manifest, encoding="utf-8") as fh:
        entries = json.load(fh)
    log("Collections de reference : %d" % len(entries))

    medias = cached("anilist_pages", fetch_pages)
    pool = cf.ThreadPoolExecutor(max_workers=WORKERS)
    recs, errs_all, rejected, failed = [], [], [], []
    for i, entry in enumerate(entries, 1):
        t_c = time.time()
        try:
            rec, errs = process(entry, medias, pool)
        except Exception as exc:  # noqa: BLE001
            failed.append("%s : %r" % (entry["id"], exc))
            log("[%2d/%d] ECHEC %s : %r" % (i, len(entries), entry["id"], exc))
            continue
        errs_all += errs
        if len(rec["characters"]) < MIN_CHARS:
            rejected.append("%s : %d perso" % (rec["id"], len(rec["characters"])))
            continue
        recs.append(rec)
        log("[%2d/%d] %-40s %4d perso, %3d echec(s), %.0f s"
            % (i, len(entries), rec["name"][:40], len(rec["characters"]), len(errs), time.time() - t_c))
    pool.shutdown(wait=True)

    apply_groups(recs)
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "echecs.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(failed + errs_all) + "\n")
    out_path = os.path.join(OUT, "collections.json")
    with open(out_path + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(recs, fh, ensure_ascii=False, indent=1)
    os.replace(out_path + ".tmp", out_path)
    prune(recs)

    probs = check(recs)
    bad_img = verify_images(recs)
    log("COLLECTIONS : %d (manifest : %d)" % (len(recs), len(entries)))
    log("PERSONNAGES : %d" % sum(len(r["characters"]) for r in recs))
    log("ECHECS      : %d collection(s), %d vignette(s) (detail : _cache/echecs.txt)" % (len(failed), len(errs_all)))
    log("REJETS      : %d %s" % (len(rejected), rejected))
    log("CONTROLE ids/previews/total : %d probleme(s) %s" % (len(probs), probs[:5]))
    log("CONTROLE webp 128x128 : %d probleme(s) %s" % (len(bad_img), bad_img[:5]))
    log("DUREE : %.0f s" % (time.time() - t0))


if __name__ == "__main__":
    main()
