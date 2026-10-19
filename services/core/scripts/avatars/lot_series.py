# -*- coding: utf-8 -*-
"""Lot « series » du catalogue d'avatars Laststream (contrat CONTRACT.md, sections 1, 2, 4 et 5).

Sorties dans <racine du depot>/.avatars-build/series/ :
  collections.json          liste des collections (champs du catalogue, previews, characters)
  i/<colId>/<charId>.webp   vignettes 128x128 WebP q78, recadrage haut (zone de la tete),
                            alpha conserve quand l'image source en a une
  _cache/*.json             reponses d'API memorisees (reprise sans refaire les appels)
  _cache/img/               telechargements bruts (reprise sans retelecharger)

Usage (depuis la racine du depot) :
  python -I scripts/avatars/lot_series.py   generation complete
Verification : python -I scripts/avatars/check_lot.py series --min-collections 70
"""
import concurrent.futures as cf
import hashlib
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
import uuid
from collections import Counter

sys.path.insert(0, site.getusersitepackages())
from PIL import Image  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOT = os.path.join(ROOT, ".avatars-build", "series")
CACHE = os.path.join(LOT, "_cache")
RAW = os.path.join(CACHE, "img")
OUT_IMG = os.path.join(LOT, "i")
OUT_JSON = os.path.join(LOT, "collections.json")

CAP = 400              # plafond de personnages par collection (contrat §5)
THUMB = 128
QUALITY = 78
PREVIEWS = 8
MIN_CHARS = 8          # collection ecartee sous ce seuil (8 apercus attendus)
DL_ATTEMPTS = 3        # essais par URL
DL_WORKERS = 12
TVM_TARGET = 60        # series TVMaze retenues avant le controle des personnages
TVM_PAUSE = 0.5        # pause entre deux appels TVMaze
MIN_COLLECTIONS = 70
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
FAM_HEROES, FAM_DISNEY, FAM_SERIES = "heroes", "disney", "series"

SUPERHERO_URL = "https://cdn.jsdelivr.net/gh/akabab/superhero-api@0.3.0/api/all.json"
SW_URL = "https://cdn.jsdelivr.net/gh/akabab/starwars-api@0.2.1/api/all.json"
HP_URL = "https://hp-api.onrender.com/api/characters"
GOT_URL = "https://thronesapi.com/api/v2/Characters"
DISNEY_REF = "https://disney.fandom.com/"
SW_REF = "https://starwars.fandom.com/"

notes = []      # journal (non bloquant)
FAILS = []      # images non obtenues ou non converties
COLLS = []      # collections en cours de construction


# ---------- HTTP et cache ----------
def log(msg):
    print(msg, flush=True)


def quote_url(url):
    return urllib.parse.quote(url, safe=":/?&=%#+,;@!$'()*~[]")


def fetch(url, referer=None, attempts=DL_ATTEMPTS, timeout=60):
    """GET avec Referer optionnel. 429 : pause 5 s. 403/404 : pas de nouvel essai."""
    last = None
    for i in range(attempts):
        try:
            headers = {"User-Agent": UA, "Accept": "*/*"}
            if referer:
                headers["Referer"] = referer
            req = urllib.request.Request(quote_url(url), headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (403, 404):
                break
            time.sleep(5.0 if exc.code == 429 else 1.5 * (i + 1))
        except Exception as exc:  # noqa: BLE001 - on reessaie
            last = exc
            time.sleep(1.5 * (i + 1))
    raise last


def get_json(url, referer=None, attempts=DL_ATTEMPTS):
    return json.loads(fetch(url, referer=referer, attempts=attempts).decode("utf-8"))


def polite(url, pause=0.3):
    time.sleep(pause)
    return get_json(url)


def tvm_json(url):
    time.sleep(TVM_PAUSE)
    return get_json(url, attempts=4)


def cached(name, producer):
    """JSON memorise dans _cache/<name>.json ; producer() n'est appele que si le fichier manque."""
    path = os.path.join(CACHE, name + ".json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    value = producer()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False)
    os.replace(tmp, path)
    return value


# ---------- utilitaires ----------
def slug(text, maxlen=40):
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:maxlen].strip("-") or "x"


def cand(name, urls):
    """Candidat personnage : urls = liste de (url, referer), essayees dans l'ordre."""
    return {"name": name.strip(), "urls": [[u, r] for u, r in urls]}


def prio_sort(cands, order):
    """Tri stable : les noms de `order` d'abord (ordre de la liste), le reste ensuite."""
    def rank(cd):
        for i, key in enumerate(order):
            if re.search(r"\b%s\b" % re.escape(key), cd["name"]):
                return i
        return len(order)
    return sorted(cands, key=rank)


ALIASES = {
    "marvel-heros": ["Marvel Heroes", "Marvel"],
    "marvel-mechants": ["Marvel Villains", "Marvel"],
    "dc-heros": ["DC Heroes", "DC Comics"],
    "dc-mechants": ["DC Villains", "DC Comics"],
    "autres-editeurs": ["Other publishers"],
    "reine-des-neiges": ["Frozen"],
    "roi-lion": ["The Lion King"],
    "lilo-stitch": ["Lilo and Stitch"],
    "vaiana": ["Moana"],
    "mickey-amis": ["Mickey and Friends", "Mickey Mouse"],
    "princesses-disney": ["Disney Princesses"],
    "mechants-disney": ["Disney Villains"],
    "pixar-divers": ["Pixar"],
    "winnie-lourson": ["Winnie the Pooh"],
    "star-wars": ["La Guerre des étoiles"],
    "simpsons": ["The Simpsons"],
    "rick-morty": ["Rick and Morty"],
    "got": ["Game of Thrones", "Le Trône de fer"],
}


def add_coll(cid, family, name, source, licence, cands, kid=False, group=None, style=None,
             extra_aliases=()):
    """Enregistre une collection : dedoublonne par nom, plafonne, attribue les charId uniques."""
    seen, uniq = set(), []
    for cd in cands:
        key = slug(cd["name"], 200)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(cd)
    uniq = uniq[:CAP]
    used = set()
    for cd in uniq:
        base = slug(cd["name"], 40)
        char_id, k = base, 2
        while char_id in used:
            char_id, k = "%s-%d" % (base, k), k + 1
        used.add(char_id)
        cd["id"] = char_id
    aliases = []
    for a in [name] + ALIASES.get(cid, []) + list(extra_aliases):
        if a and a not in aliases:
            aliases.append(a)
    COLLS.append({"id": cid, "family": family, "name": name, "source": source, "license": licence,
                  "kid": kid, "group": group, "style": style, "aliases": aliases, "cands": uniq})
    log("  %-20s %-22s %4d candidats (kid=%s)" % (cid, name[:22], len(uniq), kid))


def safe(fn):
    """Un constructeur en echec n'arrete pas le lot : l'erreur est journalisee."""
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        notes.append("ECHEC %s : %r" % (fn.__name__, exc))
        log("ECHEC %s : %r" % (fn.__name__, exc))


def safe_list(label, fn, arg):
    try:
        return fn(arg)
    except Exception as exc:  # noqa: BLE001
        notes.append("%s %s : %r" % (label, arg, str(exc)[:120]))
        return []


# ---------- Super-heros : superhero-api (akabab) ----------
SRC_SUPER = "superhero-api (akabab)"


def build_super():
    heroes = cached("superhero-all", lambda: get_json(SUPERHERO_URL))

    def pub(h):
        return ((h.get("biography") or {}).get("publisher") or "").strip()

    def align(h):
        return (h.get("biography") or {}).get("alignment") or ""

    def img(h):
        return (h.get("images") or {}).get("lg") or ""

    def power(h):
        tot = 0
        for v in (h.get("powerstats") or {}).values():
            try:
                tot += int(v)
            except (TypeError, ValueError):
                pass
        return tot

    def pick(pred):
        sel = [h for h in heroes if img(h) and h.get("name") and pred(h)]
        sel.sort(key=lambda h: (-power(h), h["name"]))  # plus puissants d'abord
        return [cand(h["name"], [(img(h), None)]) for h in sel]

    add_coll("marvel-heros", FAM_HEROES, "Marvel – Héros", SRC_SUPER, "propriétaire (Marvel)",
             pick(lambda h: pub(h) == "Marvel Comics" and align(h) == "good"),
             group="marvel", style="Héros")
    add_coll("marvel-mechants", FAM_HEROES, "Marvel – Méchants", SRC_SUPER, "propriétaire (Marvel)",
             pick(lambda h: pub(h) == "Marvel Comics" and align(h) == "bad"),
             group="marvel", style="Méchants")
    add_coll("dc-heros", FAM_HEROES, "DC – Héros", SRC_SUPER, "propriétaire (DC)",
             pick(lambda h: pub(h) == "DC Comics" and align(h) == "good"),
             group="dc", style="Héros")
    add_coll("dc-mechants", FAM_HEROES, "DC – Méchants", SRC_SUPER, "propriétaire (DC)",
             pick(lambda h: pub(h) == "DC Comics" and align(h) == "bad"),
             group="dc", style="Méchants")
    add_coll("autres-editeurs", FAM_HEROES, "Autres éditeurs", SRC_SUPER,
             "propriétaire (éditeurs de comics)",
             pick(lambda h: pub(h) not in ("", "-", "Marvel Comics", "DC Comics")))


# ---------- Disney : disneyapi.dev (noms exacts + filtre films), images Fandom avec Referer ----------
FROZEN = ["Elsa", "Anna", "Olaf", "Kristoff", "Sven", "Hans", "Marshmallow", "Oaken", "Grand Pabbie",
          "Queen Iduna", "King Agnarr", "Honeymaren", "Kai", "Ryder Nattura"]
TOY = ["Woody", "Buzz Lightyear", "Jessie", "Bo Peep", "Mr. Potato Head", "Rex", "Hamm", "Slinky Dog",
       "Sarge", "Lotso", "Andy", "Forky", "Zurg", "Bullseye", "Wheezy", "Stinky Pete", "Mrs. Potato Head"]
LION = ["Simba", "Nala", "Mufasa", "Scar", "Timon", "Pumbaa", "Rafiki", "Zazu", "Sarabi", "Kiara", "Kovu",
        "Shenzi", "Banzai", "Ed", "Ahadi", "Nuka"]
LILO = ["Stitch", "Lilo Pelekai", "Nani Pelekai", "Pleakley", "Jumba Jookiba", "Cobra Bubbles",
        "Captain Gantu", "Angel", "Mrs. Hasagawa", "David Kawena", "Reuben", "Mertle Edmonds"]
MOANA = ["Moana", "Maui", "Heihei", "Tamatoa", "Chief Tui", "Sina", "Gramma Tala", "Te Fiti", "Pua",
         "Kakamora", "Kele", "Matangi", "Moni"]
MICKEY = ["Mickey Mouse", "Minnie Mouse", "Donald Duck", "Daisy Duck", "Goofy", "Pluto", "Chip", "Dale",
          "Clarabelle Cow", "Horace Horsecollar", "Donald Jr.", "Figaro", "Mortimer Mouse",
          "Millie and Melody Mouse", "Hilda Hippo", "Captain Goof-Beard", "Mrs. Claus", "Duffy the Disney Bear"]
PRINCESSES = ["Snow White", "Cinderella", "Aurora", "Ariel", "Belle", "Jasmine", "Pocahontas", "Mulan",
              "Tiana", "Rapunzel", "Merida", "Raya", "Elsa", "Anna", "Moana"]
VILLAINS = ["Maleficent", "Ursula", "Jafar", "Cruella de Vil", "Hades", "Gaston", "Captain Hook",
            "Evil Queen", "Shere Khan", "Prince John", "Lady Tremaine", "Yzma", "Dr. Facilier",
            "Mother Gothel", "Governor Ratcliffe", "Madame Medusa", "Scar"]
PIXAR = ["Nemo", "Dory", "Marlin", "Gill", "Bruce", "Squirt", "Crush", "Nigel", "Boo", "Sulley",
         "Mike Wazowski", "Randall Boggs", "Mr. Incredible", "Elastigirl", "Jack-Jack", "Edna Mode",
         "Syndrome", "Frozone", "Lightning McQueen", "Mater", "Sally Carrera", "Doc Hudson", "Luigi",
         "Guido", "Ramone", "Fillmore"]
PIXAR_FILMS = ["Finding Nemo", "Finding Dory", "Monsters, Inc.", "Monsters University", "The Incredibles",
               "Incredibles 2", "Cars", "Cars 2", "Cars 3", "Inside Out", "Inside Out 2", "Up", "Ratatouille",
               "WALL·E", "Coco", "Brave", "Onward", "Soul", "Luca", "Turning Red", "Elemental",
               "A Bug's Life", "The Good Dinosaur"]
WINNIE = ["Winnie the Pooh", "Piglet", "Tigger", "Eeyore", "Owl", "Rabbit", "Kanga", "Roo",
          "Christopher Robin", "Gopher"]

# (colId, nom, kid, noms curates, films dont on prend tous les personnages)
DISNEY_SETS = [
    ("reine-des-neiges", "La Reine des neiges", True, FROZEN, ["Frozen", "Frozen II"]),
    ("toy-story", "Toy Story", True, TOY,
     ["Toy Story", "Toy Story 2", "Toy Story 3", "Toy Story 4", "Toy Story of Terror!",
      "Toy Story That Time Forgot"]),
    ("roi-lion", "Le Roi Lion", True, LION,
     ["The Lion King", "The Lion King II: Simba's Pride", "The Lion King 1½"]),
    ("lilo-stitch", "Lilo & Stitch", True, LILO,
     ["Lilo & Stitch", "Lilo & Stitch 2: Stitch Has a Glitch", "Leroy & Stitch"]),
    ("vaiana", "Vaiana", True, MOANA, ["Moana", "Moana 2"]),
    ("mickey-amis", "Mickey et ses amis", True, MICKEY, ["Mickey Mouse"]),
    ("princesses-disney", "Princesses Disney", True, PRINCESSES, []),
    ("mechants-disney", "Méchants Disney", False, VILLAINS, []),
    ("pixar-divers", "Pixar divers", True, PIXAR, PIXAR_FILMS),
    ("winnie-lourson", "Winnie l'ourson", True, WINNIE,
     ["Winnie the Pooh", "The Many Adventures of Winnie the Pooh"]),
]


def disney_scaled(url):
    """Variante Fandom redimensionnee (300 px de large) ; plus legere que l'original."""
    return url.split("/revision/")[0] + "/revision/latest/scale-to-width-down/300"


def disney_query(key, params):
    """Toutes les pages de /character?<params> (pageSize=50) : liste de [nom, imageUrl] avec image."""
    def produce():
        out, page = [], 1
        while True:
            time.sleep(0.15)
            d = get_json("https://api.disneyapi.dev/character?%s&pageSize=50&page=%d" % (params, page))
            for it in d.get("data", []):
                if isinstance(it, dict) and it.get("name") and it.get("imageUrl"):
                    out.append([it["name"], it["imageUrl"]])
            if page >= int((d.get("info") or {}).get("totalPages") or 1):
                break
            page += 1
        return out
    return cached("disney-" + key, produce)


def disney_film(film):
    return disney_query("film-" + slug(film, 60), "films=" + urllib.parse.quote(film, safe=""))


def disney_name(name):
    def produce():
        time.sleep(0.15)
        d = get_json("https://api.disneyapi.dev/character?name=" + urllib.parse.quote(name, safe=""))
        data = d.get("data", [])
        if isinstance(data, dict):
            data = [data]
        exact = [x for x in data if isinstance(x, dict)
                 and (x.get("name") or "").lower() == name.lower() and x.get("imageUrl")]
        return [[exact[0]["name"], exact[0]["imageUrl"]]] if exact else []
    return cached("disney-name-" + slug(name, 60), produce)


def build_disney_all():
    for cid, nom, kid, names, films in DISNEY_SETS:
        found = []
        for n in names:                      # noms curates d'abord (ordre de popularite)
            found += safe_list("disney-nom", disney_name, n)
        for f in films:
            found += safe_list("disney-film", disney_film, f)
        cands = [cand(n, [(disney_scaled(u), DISNEY_REF), (u, DISNEY_REF)]) for n, u in found]
        add_coll(cid, FAM_DISNEY, nom, "Disney API (disneyapi.dev)", "propriétaire (Disney)", cands, kid=kid)


# ---------- Star Wars et Harry Potter ----------
def build_starwars():
    sw = cached("starwars-all", lambda: get_json(SW_URL))
    sw = sorted([c for c in sw if c.get("image") and c.get("name")], key=lambda c: c.get("id", 0))
    add_coll("star-wars", FAM_DISNEY, "Star Wars", "starwars-api (akabab)",
             "propriétaire (Lucasfilm / Disney)",
             [cand(c["name"], [(c["image"], SW_REF)]) for c in sw])


def build_hp():
    hp = cached("hp-characters", lambda: get_json(HP_URL, attempts=4))
    hp = [c for c in hp if c.get("image") and c.get("name")]
    add_coll("harry-potter", FAM_DISNEY, "Harry Potter", "HP API (hp-api.onrender.com)",
             "propriétaire (Warner Bros. / Wizarding World)",
             [cand(c["name"], [(c["image"], None)]) for c in hp])


# ---------- Series dediees ----------
SIMPSONS_PRIO = ["Homer", "Marge", "Bart", "Lisa", "Maggie", "Ned Flanders", "Moe", "Krusty", "Milhouse",
                 "Nelson", "Ralph", "Apu", "Burns", "Smithers", "Sideshow Bob", "Skinner", "Willie",
                 "Lenny", "Carl", "Edna", "Otto", "Patty", "Selma", "Wiggum", "Itchy", "Scratchy"]
FUT_PRIO = ["Fry", "Leela", "Bender", "Farnsworth", "Zoidberg", "Amy", "Hermes", "Zapp", "Nibbler",
            "Kif", "Mom", "Scruffy"]


def build_simpsons():
    def produce():
        names, last, page = {}, None, 1
        while last is None or page <= last:
            d = polite("https://thesimpsonsapi.com/api/characters?page=%d" % page)
            if last is None:
                last = int(d.get("pages") or 1)
            res = [r for r in d.get("results", [])
                   if isinstance(r, dict) and isinstance(r.get("id"), int) and r.get("name")]
            for r in res:
                if 1 <= r["id"] <= CAP:
                    names[str(r["id"])] = r["name"]
            if not res or min(r["id"] for r in res) > CAP:
                break
            page += 1
        return names

    names = cached("simpsons-names", produce)
    cands = [cand(names[k], [("https://cdn.thesimpsonsapi.com/500/character/%s.webp" % k, None)])
             for k in sorted(names, key=int)]
    add_coll("simpsons", FAM_SERIES, "Les Simpson", "TheSimpsonsAPI",
             "propriétaire (20th Television / Disney)", prio_sort(cands, SIMPSONS_PRIO))


def build_futurama():
    first = cached("futurama-p1", lambda: polite("https://futuramaapi.com/api/characters?page=1"))
    items = list(first.get("items", []))
    for pg in range(2, int(first.get("pages") or 1) + 1):
        page = cached("futurama-p%d" % pg,
                      lambda pg=pg: polite("https://futuramaapi.com/api/characters?page=%d" % pg))
        items += page.get("items", [])
    cands = [cand(it["name"], [(it["image"], None)]) for it in items if it.get("image") and it.get("name")]
    add_coll("futurama", FAM_SERIES, "Futurama", "FuturamaAPI (futuramaapi.com)",
             "propriétaire (Disney / Hulu)", prio_sort(cands, FUT_PRIO))


def rm_pack(ids):
    time.sleep(0.6)
    d = get_json("https://rickandmortyapi.com/api/character/" + ",".join(str(i) for i in ids), attempts=4)
    if isinstance(d, dict):
        d = [d]
    return [{"id": c["id"], "name": c["name"]} for c in d if isinstance(c, dict) and c.get("name")]


def build_rick_morty():
    names = {}
    for start in range(1, CAP + 1, 20):      # noms par paquets de 20 (429 : pause geree par fetch)
        ids = list(range(start, min(start + 19, CAP) + 1))
        try:
            arr = cached("rickmorty-%d-%d" % (ids[0], ids[-1]), lambda ids=ids: rm_pack(ids))
        except Exception as exc:  # noqa: BLE001
            notes.append("Rick et Morty paquet %d-%d : %r" % (ids[0], ids[-1], exc))
            continue
        for c in arr:
            names[int(c["id"])] = c["name"]
    cands = [cand(names[i], [("https://rickandmortyapi.com/api/character/avatar/%d.jpeg" % i, None)])
             for i in sorted(names) if i <= CAP]
    add_coll("rick-morty", FAM_SERIES, "Rick et Morty", "Rick and Morty API (rickandmortyapi.com)",
             "propriétaire (Adult Swim / Warner Bros.)", cands)


def build_got():
    got = cached("got-characters", lambda: get_json(GOT_URL))

    def nm(c):
        return c.get("fullName") or ("%s %s" % (c.get("firstName", ""), c.get("lastName", ""))).strip()

    cands = [cand(nm(c), [(c["imageUrl"], None)]) for c in got if c.get("imageUrl") and nm(c)]
    add_coll("got", FAM_SERIES, "Game of Thrones", "ThronesAPI", "propriétaire HBO", cands)


# ---------- TVMaze : series automatiques ----------
TVM_SKIP = {"The Simpsons", "Futurama", "Rick and Morty", "Game of Thrones"}
TVM_AKA_COUNTRIES = {None, "FR", "US", "GB", "CA", "BE", "CH"}


def tvm_shows():
    def produce():
        out = []
        for p in range(0, 41):
            try:
                data = tvm_json("https://api.tvmaze.com/shows?page=%d" % p)
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    break
                raise
            for s in data:
                avg = (s.get("rating") or {}).get("average")
                weight = s.get("weight")
                if avg is not None and weight is not None and avg >= 7.8 and weight >= 90:
                    out.append({"id": s["id"], "name": s["name"], "rating": avg, "weight": weight})
        out.sort(key=lambda s: (-s["weight"], -s["rating"], s["id"]))
        return out
    return cached("tvmaze-shows", produce)


def build_tvmaze():
    shows = tvm_shows()
    notes.append("TVMaze : %d series passent le filtre rating>=7.8 et weight>=90" % len(shows))
    kept = []
    for s in shows:
        if len(kept) >= TVM_TARGET:
            break
        if s["name"] in TVM_SKIP:
            continue
        try:
            cast = cached("tvmaze-cast-%d" % s["id"],
                          lambda sid=s["id"]: tvm_json("https://api.tvmaze.com/shows/%d/cast" % sid))
        except Exception as exc:  # noqa: BLE001
            notes.append("TVMaze cast %s : %r" % (s["name"], str(exc)[:120]))
            continue
        persons = {}
        for cm in cast:
            ch = cm.get("character") or {}
            img = (ch.get("image") or {}).get("medium")
            nm = (ch.get("name") or "").strip()
            if img and nm and nm not in persons:
                persons[nm] = img
        if len(persons) < MIN_CHARS:
            continue
        kept.append((s, persons))

    for s, persons in kept:
        try:
            akas = cached("tvmaze-akas-%d" % s["id"],
                          lambda sid=s["id"]: tvm_json("https://api.tvmaze.com/shows/%d/akas" % sid))
        except Exception:  # noqa: BLE001 - pas d'akas : seul le nom sert d'alias
            akas = []
        extra = []
        for a in akas:
            code = (a.get("country") or {}).get("code")
            title = (a.get("name") or "").strip()
            if code in TVM_AKA_COUNTRIES and title and title != s["name"] and title not in extra:
                extra.append(title)
        used = {c["id"] for c in COLLS}
        base = "tvmaze-" + slug(s["name"], 30)
        cid, k = base, 2
        while cid in used:
            cid, k = "%s-%d" % (base, k), k + 1
        add_coll(cid, FAM_SERIES, s["name"], "TVMaze", "propriétaire (TVMaze, photos promo)",
                 [cand(nm, [(img, None)]) for nm, img in persons.items()], extra_aliases=extra[:3])


# ---------- telechargement et conversion ----------
def raw_path(cid, cd):
    digest = hashlib.sha1(cd["urls"][0][0].encode("utf-8")).hexdigest()[:16]
    return os.path.join(RAW, cid, digest + ".bin")


def to_thumb(src, dst):
    """Carre en haut (zone de la tete), 128x128, WebP q78 ; alpha conserve si l'image source en a."""
    with Image.open(src) as im:
        im.load()
        if min(im.size) < 40:
            raise ValueError("image trop petite %s" % (im.size,))
        im = im.convert("RGBA")
        w, h = im.size
        s = min(w, h)
        left = (w - s) // 2
        im = im.crop((left, 0, left + s, s)).resize((THUMB, THUMB), Image.Resampling.LANCZOS)
        if im.getchannel("A").getextrema() == (255, 255):
            im = im.convert("RGB")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.save(dst, "WEBP", quality=QUALITY, method=6)


def process_candidate(c, cd):
    """Telecharge (3 essais par URL, URL de secours) puis convertit. Ne leve jamais d'exception."""
    raw = raw_path(c["id"], cd)
    dst = os.path.join(OUT_IMG, c["id"], cd["id"] + ".webp")
    try:
        if not (os.path.isfile(raw) and os.path.getsize(raw) > 0):
            err = "aucune URL"
            for url, ref in cd["urls"]:
                try:
                    data = fetch(url, referer=ref)
                    os.makedirs(os.path.dirname(raw), exist_ok=True)
                    tmp = "%s.%s.part" % (raw, uuid.uuid4().hex)
                    with open(tmp, "wb") as fh:
                        fh.write(data)
                    os.replace(tmp, raw)
                    break
                except Exception as exc:  # noqa: BLE001
                    err = "%s : %s" % (url[-70:], repr(exc)[:100])
            else:
                return False, "telechargement " + err
        try:
            to_thumb(raw, dst)
        except Exception as exc:  # noqa: BLE001
            try:
                os.remove(raw)  # le prochain run retelecharge
            except OSError:
                pass
            return False, "conversion %r" % (exc,)
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, "%r" % (exc,)


def download_all():
    jobs = [(c, cd) for c in COLLS for cd in c["cands"]]
    log("telechargements : %d images (%d workers)" % (len(jobs), DL_WORKERS))
    results, done = {}, 0
    with cf.ThreadPoolExecutor(max_workers=DL_WORKERS) as ex:
        futs = {ex.submit(process_candidate, c, cd): (c["id"], cd["id"], c["id"] + "/" + cd["name"])
                for c, cd in jobs}
        for fut in cf.as_completed(futs):
            cid, char_id, label = futs[fut]
            ok, err = fut.result()
            results[(cid, char_id)] = ok
            if not ok:
                FAILS.append("%s : %s" % (label, err))
            done += 1
            if done % 500 == 0:
                log("  ... %d / %d" % (done, len(jobs)))
    return results


def assemble(results):
    final, dropped = [], []
    for c in COLLS:
        chars = [{"id": cd["id"], "name": cd["name"]} for cd in c["cands"]
                 if results.get((c["id"], cd["id"]))]
        if len(chars) < MIN_CHARS:
            dropped.append("%s (%d personnage(s) utilisables)" % (c["id"], len(chars)))
            shutil.rmtree(os.path.join(OUT_IMG, c["id"]), ignore_errors=True)
            continue
        out = {"id": c["id"], "family": c["family"], "name": c["name"], "source": c["source"],
               "license": c["license"], "free": False, "kid": bool(c["kid"]),
               "total": len(chars), "aliases": c["aliases"]}
        if c["group"]:
            out["group"] = c["group"]
            out["style"] = c["style"]
        out["previews"] = [ch["id"] for ch in chars[:PREVIEWS]]
        out["characters"] = chars
        final.append(out)
    return final, dropped


def write_collections(final):
    tmp = OUT_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(final, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT_JSON)


# ---------- controle interne ----------
def validate():
    """Controle du critere : JSON valide, >= 70 collections, WebP 128x128 par personnage, ids, previews."""
    from_file = []
    if not os.path.isfile(OUT_JSON):
        log("ECHEC : %s absent" % OUT_JSON)
        return 1
    with open(OUT_JSON, encoding="utf-8") as fh:
        cols = json.load(fh)
    errs = []
    if not isinstance(cols, list):
        return 1
    ids = [c.get("id") for c in cols]
    if len(ids) != len(set(ids)):
        errs.append("colId en double")
    if len(cols) < MIN_COLLECTIONS:
        errs.append("%d collections (>= %d attendues)" % (len(cols), MIN_COLLECTIONS))
    n_files = 0
    for c in cols:
        cid = c.get("id")
        if not isinstance(cid, str) or not ID_RE.match(cid):
            errs.append("colId invalide %r" % (cid,))
            continue
        for k in ("family", "name", "source", "license", "kid", "free", "total", "aliases",
                  "previews", "characters"):
            if k not in c:
                errs.append("%s : champ %s absent" % (cid, k))
        if c.get("family") not in ("heroes", "disney", "series"):
            errs.append("%s : family %r" % (cid, c.get("family")))
        if not isinstance(c.get("kid"), bool) or c.get("free") is not False:
            errs.append("%s : kid/free" % cid)
        chars = c.get("characters") or []
        cids = [ch.get("id") for ch in chars]
        if c.get("total") != len(chars):
            errs.append("%s : total %r != %d" % (cid, c.get("total"), len(chars)))
        if not (MIN_CHARS <= len(chars) <= CAP):
            errs.append("%s : %d personnages" % (cid, len(chars)))
        if len(set(cids)) != len(cids):
            errs.append("%s : charId en double" % cid)
        for ch in chars:
            chid = ch.get("id")
            if not isinstance(chid, str) or not ID_RE.match(chid) or not ch.get("name"):
                errs.append("%s : personnage invalide %r" % (cid, chid))
                continue
            path = os.path.join(OUT_IMG, cid, chid + ".webp")
            if not os.path.isfile(path):
                errs.append("image absente %s/%s" % (cid, chid))
                continue
            with Image.open(path) as im:
                if im.format != "WEBP" or im.size != (THUMB, THUMB):
                    errs.append("%s/%s : %s %s" % (cid, chid, im.format, im.size))
            n_files += 1
        prev = c.get("previews") or []
        if (len(prev) != min(PREVIEWS, len(chars)) or len(set(prev)) != len(prev)
                or not set(prev) <= set(cids)):
            errs.append("%s : previews invalides" % cid)
        if not isinstance(c.get("aliases"), list) or not all(isinstance(a, str) for a in c["aliases"]):
            errs.append("%s : aliases" % cid)
        if ("group" in c) != ("style" in c):
            errs.append("%s : group/style" % cid)
    expected = {(c["id"], ch["id"]) for c in cols for ch in c.get("characters", [])}
    orphans = 0
    if os.path.isdir(OUT_IMG):
        for cdir in os.listdir(OUT_IMG):
            for f in os.listdir(os.path.join(OUT_IMG, cdir)):
                if (cdir, f[:-5]) not in expected:
                    orphans += 1
    if orphans:
        errs.append("%d fichiers orphelins dans i/" % orphans)
    fam = Counter(c.get("family") for c in cols)
    log("VALIDATION : collections=%d personnages=%d images_ok=%d orphelins=%d familles=%s previews_8=%d" % (
        len(cols), sum(len(c.get("characters", [])) for c in cols), n_files, orphans, dict(fam),
        sum(1 for c in cols if len(c.get("previews", [])) == PREVIEWS)))
    for e in errs[:40]:
        log("  ERREUR : " + e)
    log("VALIDATION : %s" % ("OK" if not errs else "%d erreur(s)" % len(errs)))
    return 1 if errs else 0


def report(final, dropped, t0):
    fam = Counter(c["family"] for c in final)
    nch = [len(c["characters"]) for c in final]
    log("")
    log("COLLECTIONS GARDEES : %d %s (kid=true : %d)" % (len(final), dict(fam),
                                                          sum(1 for c in final if c["kid"])))
    log("PERSONNAGES : %d (min %d, max %d par collection)" % (sum(nch), min(nch), max(nch)))
    log("ECARTEES (< %d personnages utilisables) : %d" % (MIN_CHARS, len(dropped)))
    for d in dropped:
        log("  - " + d)
    log("IMAGES EN ECHEC : %d" % len(FAILS))
    for e in FAILS[:40]:
        log("  " + e[:220])
    for n in notes[:80]:
        log("NOTE " + n[:220])
    log("DUREE : %.0f s" % (time.time() - t0))


def main():
    if "--check" in sys.argv:
        return validate()
    t0 = time.time()
    if os.path.isdir(OUT_IMG):
        shutil.rmtree(OUT_IMG)
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(RAW, exist_ok=True)
    log("== Super-heros")
    safe(build_super)
    log("== Disney")
    safe(build_disney_all)
    safe(build_starwars)
    safe(build_hp)
    log("== Series dediees")
    safe(build_simpsons)
    safe(build_futurama)
    safe(build_rick_morty)
    safe(build_got)
    log("== TVMaze")
    safe(build_tvmaze)
    results = download_all()
    final, dropped = assemble(results)
    write_collections(final)
    report(final, dropped, t0)
    return validate()


if __name__ == "__main__":
    sys.exit(main())
