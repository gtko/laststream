# -*- coding: utf-8 -*-
"""Lot « libres » du catalogue d'avatars Laststream (contrat CONTRACT.md, sections 1, 2, 4, 5).

Sortie (gitignorée) dans <racine>/.avatars-build/libres/ :
  collections.json          liste de collections, chacune avec "characters" [{id, name}]
  i/<colId>/<charId>.webp   vignettes 128x128 WebP q78, alpha conservé (portraits recadrés pour les photos)
  _cache/                   téléchargements bruts et rapport.json (hors i/, donc hors contrôle d'orphelins)

Sources :
  - DiceBear 9.x / 10.x : 48 graines s01..s48 par style (PNG 256, repli SVG) ;
  - Iconify emoji : paquets npm @iconify-json (jsDelivr, puis unpkg), Animaux + Personnages, rendu resvg ;
  - game-icons (npm) : créatures ;
  - Fluent 3D : dépôt microsoft/fluentui-emoji (arbre GitHub, fichiers via jsDelivr), Animaux + Personnages ;
  - Dog CEO : une photo par race (toutes les races et sous-races) ;
  - The Cat API : 48 photos (cat01..cat48) ;
  - RoboHash : sets 1 à 5, 48 graines.

Variables d'environnement :
  LIBRES_LIMIT=n  (test) ne garde que n personnages par collection.

Lancement : python scripts/avatars/lot_libres.py   (depuis n'importe où)
"""
import io
import json
import os
import re
import shutil
import site
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.append(site.getusersitepackages())
sys.stdout.reconfigure(errors="replace")

from PIL import Image, ImageOps  # noqa: E402
import resvg_py  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
LOT = os.path.join(ROOT, ".avatars-build", "libres")
OUT_I = os.path.join(LOT, "i")
CACHE = os.path.join(LOT, "_cache")
OUT_JSON = os.path.join(LOT, "collections.json")
REPORT = os.path.join(CACHE, "rapport.json")

SIZE = 128
WEBP_Q = 78
CAP = 400
MIN_CHARS = 5
PREVIEWS = 8
WORKERS = 8
LIMIT = int(os.environ.get("LIBRES_LIMIT", "0") or 0)
UA = "Mozilla/5.0 (compatible; laststream-avatar-collector/2.0)"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")

# ---------------------------------------------------------------- Vocabulaire (animaux / personnages)
ANIMAL = set("""cat dog fox panda lion tiger bear rabbit unicorn owl penguin koala frog monkey mouse hamster
pig cow chicken rooster chick bird duck eagle dove peacock parrot flamingo swan goose bat wolf boar horse zebra
giraffe elephant gorilla deer bison ox buffalo camel llama donkey hedgehog skunk otter sloth seal beaver raccoon
kangaroo squirrel turtle snake lizard crocodile dinosaur rex sauropod dragon whale dolphin fish shark octopus
squid crab lobster shrimp snail butterfly bug bee ant spider scorpion worm jellyfish blowfish puffer beetle
hippopotamus rhinoceros mammoth poodle goat sheep ram rat elk moose badger leopard cheetah dodo kiwi chipmunk
orangutan mosquito cockroach""".split())
# Mots exclus pour les animaux : nourriture, objets, sports, formes (hot-dog, fish-cake, baseball-bat...).
EXCL_ANIMAL = set("""nose ear ears tail leg legs cake fried cooked meat bacon steak racing web hot pie sandwich
sushi bento food paw prints print turkey cricket bowl sauce computer trap fruit mahjong carousel flag baseball
bowling golf""".split())
PERSON = set("""person people man woman boy girl baby child adult older alien robot ghost ninja superhero
supervillain mage fairy vampire zombie elf genie merperson merpeople merman mermaid angel princess prince pirate
detective astronaut santa mx wizard artist singer scientist pilot judge teacher student cook farmer firefighter
mechanic technologist guard deaf pregnant bearded""".split())
# Mots exclus pour les personnages : objets, familles, groupes (baby-bottle, family, flag...).
EXCL_PERSON = set("""bottle symbol shoe shoes sandal boot boots clothes hat family couple kiss holding flag
mahjong fruit trap computer""".split())
FANTASY = set("""superhero supervillain mage fairy vampire zombie elf genie merperson merpeople mermaid merman
angel princess prince detective astronaut santa mx wizard ninja robot alien ghost pirate artist singer scientist
pilot judge teacher student cook farmer firefighter mechanic technologist guard turban veil headscarf crown
bunny skullcap""".split())
TOP_ANIMAL = {"cat", "dog", "fox", "panda", "lion", "tiger", "bear", "rabbit", "unicorn", "owl", "penguin", "koala",
              "frog", "monkey", "pig", "cow", "horse", "chicken", "bird", "duck", "elephant", "whale", "dolphin",
              "fish", "shark", "octopus", "turtle", "snake", "dragon", "wolf", "giraffe", "zebra", "hedgehog",
              "mouse", "hamster", "bee", "butterfly", "deer", "camel", "crocodile", "dinosaur", "kangaroo",
              "gorilla", "cat-face", "dog-face", "fox-face", "lion-face", "tiger-face", "panda-face"}
CORE_PERSON = {"alien", "robot", "ghost", "ninja", "superhero", "supervillain", "mage", "fairy", "vampire", "zombie",
               "elf", "genie", "mermaid", "merman", "merperson", "angel", "princess", "prince", "detective",
               "astronaut", "santa-claus", "mx-claus", "person", "man", "woman", "boy", "girl", "baby", "child",
               "adult", "older-person", "old-man", "old-woman"}
# Tons de peau : on ne garde que la version par défaut quand elle existe.
TONE_RE = re.compile(r"-(?:(?:dark|light|medium(?:-dark|-light)?)-skin-tone|dark|light|medium(?:-dark|-light)?)$")
# Noms français pour les mots simples les plus courants ; le reste reste en anglais humanisé.
FR = {
    "cat": "Chat", "dog": "Chien", "fox": "Renard", "panda": "Panda", "lion": "Lion", "tiger": "Tigre",
    "bear": "Ours", "rabbit": "Lapin", "unicorn": "Licorne", "owl": "Hibou", "penguin": "Manchot",
    "koala": "Koala", "frog": "Grenouille", "monkey": "Singe", "mouse": "Souris", "hamster": "Hamster",
    "pig": "Cochon", "cow": "Vache", "chicken": "Poule", "rooster": "Coq", "chick": "Poussin", "bird": "Oiseau",
    "duck": "Canard", "eagle": "Aigle", "dove": "Colombe", "peacock": "Paon", "parrot": "Perroquet",
    "flamingo": "Flamant rose", "swan": "Cygne", "goose": "Oie", "bat": "Chauve-souris", "wolf": "Loup",
    "boar": "Sanglier", "horse": "Cheval", "zebra": "Zèbre", "giraffe": "Girafe", "elephant": "Éléphant",
    "gorilla": "Gorille", "deer": "Cerf", "bison": "Bison", "ox": "Bœuf", "camel": "Chameau", "llama": "Lama",
    "donkey": "Âne", "hedgehog": "Hérisson", "otter": "Loutre", "sloth": "Paresseux", "seal": "Phoque",
    "beaver": "Castor", "raccoon": "Raton laveur", "kangaroo": "Kangourou", "squirrel": "Écureuil",
    "turtle": "Tortue", "snake": "Serpent", "lizard": "Lézard", "crocodile": "Crocodile",
    "dinosaur": "Dinosaure", "dragon": "Dragon", "whale": "Baleine", "dolphin": "Dauphin", "fish": "Poisson",
    "shark": "Requin", "octopus": "Pieuvre", "squid": "Calamar", "crab": "Crabe", "lobster": "Homard",
    "shrimp": "Crevette", "snail": "Escargot", "butterfly": "Papillon", "bug": "Insecte", "bee": "Abeille",
    "ant": "Fourmi", "spider": "Araignée", "scorpion": "Scorpion", "worm": "Ver", "jellyfish": "Méduse",
    "hippopotamus": "Hippopotame", "rhinoceros": "Rhinocéros", "mammoth": "Mammouth", "poodle": "Caniche",
    "goat": "Chèvre", "sheep": "Mouton", "rat": "Rat", "moose": "Élan", "elk": "Wapiti", "badger": "Blaireau",
    "leopard": "Léopard", "cheetah": "Guépard", "dodo": "Dodo", "kiwi": "Kiwi", "skunk": "Mouffette",
    "mosquito": "Moustique", "cockroach": "Cafard", "beetle": "Scarabée", "t-rex": "T-Rex",
    "alien": "Alien", "robot": "Robot", "ghost": "Fantôme", "ninja": "Ninja", "superhero": "Super-héros",
    "supervillain": "Super-vilain", "mage": "Mage", "fairy": "Fée", "vampire": "Vampire", "zombie": "Zombie",
    "elf": "Elfe", "genie": "Génie", "angel": "Ange", "princess": "Princesse", "prince": "Prince",
    "detective": "Détective", "astronaut": "Astronaute", "person": "Personne", "man": "Homme",
    "woman": "Femme", "boy": "Garçon", "girl": "Fille", "baby": "Bébé", "child": "Enfant", "adult": "Adulte",
    "santa-claus": "Père Noël", "mermaid": "Sirène", "merman": "Triton",
}

# ---------------------------------------------------------------- Catalogue des sources
ICONIFY_SETS = [
    ("fluent-emoji", "Fluent Emoji", "MIT", True),
    ("fluent-emoji-flat", "Fluent Emoji Flat", "MIT", True),
    ("twemoji", "Twemoji", "CC BY 4.0", True),
    ("noto", "Noto Emoji", "Apache 2.0", True),
    ("openmoji", "OpenMoji", "CC BY-SA 4.0", True),
    ("emojione", "EmojiOne", "CC BY 4.0", True),
    ("fxemoji", "Firefox OS Emoji", "Apache 2.0", True),
    ("streamline-emojis", "Streamline Emojis", "CC BY 4.0", True),
]
GAME_EXACT = ["dragon-head", "wolf-head", "ogre", "goblin-head", "kraken-tentacle", "griffin-symbol", "unicorn",
              "minotaur", "troll", "cyclops", "hydra", "yeti", "gargoyle", "medusa-head", "harpy",
              "werewolf-head"]
DB_V9 = ["adventurer", "adventurer-neutral", "avataaars", "avataaars-neutral", "big-ears", "big-ears-neutral",
         "big-smile", "bottts", "bottts-neutral", "croodles", "croodles-neutral", "dylan", "fun-emoji", "lorelei",
         "lorelei-neutral", "micah", "miniavs", "notionists", "notionists-neutral", "open-peeps", "personas",
         "pixel-art", "pixel-art-neutral", "thumbs", "toon-head"]
DB_V10 = ["clay", "critters", "cameo", "cutouts", "gaze", "line-face", "moods", "pixelbot", "sprouts",
          "voxel-art", "voxel-bot"]
DB_CC0 = {"lorelei", "lorelei-neutral", "notionists", "notionists-neutral", "open-peeps", "pixel-art",
          "pixel-art-neutral", "thumbs"}
DB_PABLO = {"avataaars", "avataaars-neutral", "bottts", "bottts-neutral"}
DB_KID = {"adventurer", "big-smile", "fun-emoji", "thumbs", "croodles", "lorelei", "notionists", "pixel-art",
          "miniavs", "bottts", "big-ears"}
FLUENT_TREE_URL = "https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/main?recursive=1"
FLUENT_BASE = "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/"
DOG_LIST_URL = "https://dog.ceo/api/breeds/list/all"
DOG_PREF = ["husky", "corgi", "shiba", "labrador", "poodle", "beagle", "pug", "dachshund"]
ROBO_SETS = [(1, "Robots", "Robot"), (2, "Monstres", "Monstre"), (3, "Têtes de robot", "Tête robot"),
             (4, "Chats", "Chat"), (5, "Humains", "Humain")]


# ---------------------------------------------------------------- Utilitaires
def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:48].rstrip("-") or "x"


def title(s):
    return " ".join(w.capitalize() for w in s.split("-"))


def display_name(n):
    if n in FR:
        return FR[n]
    if n.endswith("-face") and n[: -len("-face")] in FR:
        return f"{FR[n[: -len('-face')]]} (visage)"
    s = n.replace("-", " ").strip()
    return s[:1].upper() + s[1:]


def http_get(url, timeout=60, tries=4):
    last = "inconnu"
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in (400, 401, 403, 404, 410):
                break
        except Exception as exc:  # noqa: BLE001  (réseau, timeout)
            last = f"{type(exc).__name__}: {str(exc)[:120]}"
        if k < tries - 1:
            time.sleep(2 * (k + 1))
    raise RuntimeError(last)


def cached_path(key, url, timeout=240, tries=3):
    """Télécharge url dans CACHE/key une seule fois ; renvoie le chemin local."""
    path = os.path.join(CACHE, key)
    if not os.path.exists(path):
        data = http_get(url, timeout=timeout, tries=tries)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    return path


def clean_svg(text):
    """Nettoie un SVG : pas de script, pas de handlers, pas de href externe, minifie."""
    i = text.lower().find("<svg")
    if i >= 0:
        text = text[i:]
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<script\b.*?</script\s*>", "", text, flags=re.S | re.I)
    text = re.sub(r"<foreignObject\b.*?</foreignObject\s*>", "", text, flags=re.S | re.I)
    text = re.sub(r"\son[a-zA-Z]+\s*=\s*(\"[^\"]*\"|'[^']*')", "", text)
    text = re.sub(r"\s(?:xlink:)?href\s*=\s*([\"'])(?:https?:|javascript:)[^\"']*\1", "", text, flags=re.I)
    text = re.sub(r">\s+<", "><", text)
    return re.sub(r"\s+", " ", text).strip()


def select(allnames, kind):
    """Filtre les noms (kebab-case) pour « animaux » ou « personnages », dédoublonne les tons de peau,
    trie par priorité et plafonne à CAP."""
    keep = []
    for n in allnames:
        toks = set(n.split("-"))
        if kind == "animaux":
            if not (toks & ANIMAL) or (toks & EXCL_ANIMAL):
                continue
        else:
            if not (toks & PERSON) or (toks & ANIMAL) or (toks & EXCL_PERSON):
                continue
        if TONE_RE.search(n) and TONE_RE.sub("", n) in allnames:
            continue
        keep.append(n)
    keep.sort(key=lambda n: (prio(n, kind), len(n), n))
    print(f"    {kind} : {len(keep)} candidats, plafond {CAP}", flush=True)
    return keep[:CAP]


def prio(n, kind):
    if kind == "animaux":
        return 0 if n in TOP_ANIMAL else 1
    if n in CORE_PERSON:
        return 0
    return 1 if set(n.split("-")) & FANTASY else 2


def coll(cid, name, source, lic, free, kid, cands, cover=False, group=None, style=None, pref=()):
    """Construit une collection ; garantit des charId uniques ; applique LIMIT si défini."""
    if LIMIT:
        cands = cands[:LIMIT]
    seen, uniq = set(), []
    for c in cands:
        i, k = c["id"], 2
        while i in seen:
            i = slug(f"{c['id']}-{k}")
            k += 1
        seen.add(i)
        uniq.append(dict(c, id=i))
    return {"id": cid, "name": name, "source": source, "license": lic, "free": free, "kid": kid,
            "cands": uniq, "cover": cover, "group": group, "style": style, "pref": list(pref)}


# ---------------------------------------------------------------- DiceBear
def dicebear_collections():
    out = []
    for ver, slugs in (("9.x", DB_V9), ("10.x", DB_V10)):
        for s in slugs:
            if ver == "10.x":
                lic, free = "À confirmer (DiceBear v10)", False
            elif s in DB_CC0:
                lic, free = "CC0 1.0", True
            elif s in DB_PABLO:
                lic, free = "Gratuit (Pablo Stanley)", False
            else:
                lic, free = "CC BY 4.0", True
            style = title(s)
            cands = []
            for k in range(1, 49):
                seed = f"s{k:02d}"
                cands.append({"id": seed, "name": f"{style} {k}",
                              "urls": [f"https://api.dicebear.com/{ver}/{s}/png?seed={seed}&size=256",
                                       f"https://api.dicebear.com/{ver}/{s}/svg?seed={seed}"]})
            out.append(coll(f"dicebear-{s}", "DiceBear", "DiceBear", lic, free, s in DB_KID, cands,
                            group="dicebear", style=style))
    return out


# ---------------------------------------------------------------- Iconify (emoji, game-icons) via npm
def load_iconify(prefix):
    last = None
    for base in ("https://cdn.jsdelivr.net/npm", "https://unpkg.com"):
        try:
            path = cached_path(os.path.join("iconify", f"{prefix}-icons.json"),
                               f"{base}/@iconify-json/{prefix}/icons.json")
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"Iconify {prefix} indisponible : {last}")


def iconify_index(j):
    """name -> (corps SVG, largeur, hauteur) ; les alias sans transformation sont repris."""
    dw, dh = j.get("width", 24), j.get("height", 24)
    icons = j.get("icons") or {}
    out = {}
    for name, ic in icons.items():
        out[name] = (ic["body"], ic.get("width", dw), ic.get("height", dh))
    for name, al in (j.get("aliases") or {}).items():
        if name in out or any(k in al for k in ("hFlip", "vFlip", "rotate")):
            continue
        parent = icons.get(al.get("parent"))
        if parent:
            out[name] = (parent["body"], parent.get("width", dw), parent.get("height", dh))
    return out


def svg_wrap(body, w, h):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="0 0 {w} {h}">{body}</svg>')


def iconify_collections():
    out = []
    for prefix, short, lic, free in ICONIFY_SETS:
        try:
            index = iconify_index(load_iconify(prefix))
        except Exception as exc:  # noqa: BLE001
            print(f"[iconify] {prefix} ignoré : {exc}", flush=True)
            continue
        for kind, label in (("animaux", "Animaux"), ("personnages", "Personnages")):
            cands = []
            for n in select(set(index), kind):
                body, w, h = index[n]
                cands.append({"id": slug(n), "name": display_name(n), "svg": svg_wrap(body, w, h)})
            out.append(coll(f"iconify-{prefix}-{kind}", short, f"Iconify (@iconify-json/{prefix})", lic, free,
                            kind == "animaux", cands, group=f"emoji-{prefix}", style=label))
        del index
    return out


def game_collection():
    index = iconify_index(load_iconify("game-icons"))
    cands = []
    for n in GAME_EXACT:
        if n in index:
            body, w, h = index[n]
            cands.append({"id": slug(n), "name": display_name(n), "svg": svg_wrap(body, w, h)})
    return [coll("iconify-game-icons-creatures", "Game-icons – Créatures", "Iconify (@iconify-json/game-icons)",
                 "CC BY 3.0", True, False, cands)]


# ---------------------------------------------------------------- Fluent 3D (GitHub)
def fluent_collections():
    tree = json.load(open(cached_path("github-fluent-tree.json", FLUENT_TREE_URL), encoding="utf-8"))
    if tree.get("truncated"):
        print("[fluent3d] arbre GitHub tronqué : résultat possiblement incomplet", flush=True)
    best = {}
    for t in tree.get("tree", []):
        p = t.get("path", "")
        if t.get("type") != "blob" or not p.startswith("assets/") or not p.endswith(".png"):
            continue
        parts = p.split("/")
        if len(parts) == 5 and parts[2] == "Default" and parts[3] == "3D":
            pref = 0
        elif len(parts) == 4 and parts[2] == "3D":
            pref = 1
        else:
            continue
        folder = parts[1]
        if folder not in best or pref < best[folder][0]:
            best[folder] = (pref, p)
    by_name = {}
    for folder, (_, p) in best.items():
        by_name[re.sub(r"\s+", "-", folder.strip().lower())] = p
    out = []
    for kind, label, kid in (("animaux", "Animaux", True), ("personnages", "Personnages", False)):
        cands = []
        for n in select(set(by_name), kind):
            url = FLUENT_BASE + "/".join(urllib.parse.quote(seg) for seg in by_name[n].split("/"))
            cands.append({"id": slug(n), "name": display_name(n), "urls": [url]})
        out.append(coll(f"fluent3d-{kind}", "Fluent 3D", "Microsoft Fluent Emoji (GitHub)", "MIT", True, kid,
                        cands, group="fluent3d", style=label))
    return out


# ---------------------------------------------------------------- Dog CEO et The Cat API (photos)
def dog_collections():
    data = json.loads(http_get(DOG_LIST_URL).decode("utf-8"))["message"]
    entries = []
    for breed, subs in sorted(data.items()):
        if subs:
            for sub in sorted(subs):
                entries.append((f"{breed}-{sub}", f"{breed}/{sub}", f"{sub} {breed}"))
        else:
            entries.append((breed, breed, breed))

    def one(entry):
        cid, api, label = entry
        try:
            url = json.loads(http_get(f"https://dog.ceo/api/breed/{api}/images/random").decode("utf-8"))["message"]
        except Exception as exc:  # noqa: BLE001
            print(f"[dogceo] {api} ignorée : {exc}", flush=True)
            return None
        return {"id": cid, "name": title(label.replace(" ", "-")), "urls": [url]}

    with ThreadPoolExecutor(max_workers=6) as ex:
        cands = [c for c in ex.map(one, entries) if c]
    return [coll("dogceo-chiens", "Chiens", "Dog CEO API (photos)", "Droits non vérifiés (photos)", False, True,
                 cands, cover=True, pref=DOG_PREF)]


def cat_collection():
    seen, urls = set(), []
    for _ in range(40):
        if len(urls) >= 48:
            break
        try:
            data = json.loads(http_get("https://api.thecatapi.com/v1/images/search?limit=10").decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"[thecatapi] appel ignoré : {exc}", flush=True)
            time.sleep(3)
            continue
        for it in data:
            url, key = it.get("url", ""), it.get("id")
            if key and key not in seen and url.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                seen.add(key)
                urls.append(url)
        time.sleep(0.3)
    cands = [{"id": f"cat{k:02d}", "name": f"Chat {k}", "urls": [u]} for k, u in enumerate(urls[:48], 1)]
    return [coll("thecatapi-chats", "Chats", "The Cat API (photos)", "Droits non vérifiés (photos)", False, True,
                 cands, cover=True)]


# ---------------------------------------------------------------- RoboHash
def robohash_collections():
    out = []
    for n, style, label in ROBO_SETS:
        cands = [{"id": f"s{k:02d}", "name": f"{label} {k}",
                  "urls": [f"https://robohash.org/s{k:02d}.png?set=set{n}&size=256x256"]}
                 for k in range(1, 49)]
        out.append(coll(f"robohash-set{n}", "RoboHash", "RoboHash (robohash.org)", "CC BY (robohash.org)", True,
                        False, cands, group="robohash", style=style))
    return out


# ---------------------------------------------------------------- Images
def to_image(data):
    if isinstance(data, str):
        is_svg, text = True, data
    else:
        is_svg = b"<svg" in data[:4096].lower()
        text = data.decode("utf-8", "replace") if is_svg else None
    if is_svg:
        png = resvg_py.svg_to_bytes(svg_string=clean_svg(text), width=SIZE)
        im = Image.open(io.BytesIO(bytes(png)))
    else:
        im = Image.open(io.BytesIO(data))
    im.load()
    return im


def fit(im, cover):
    im = im.convert("RGBA")
    if cover:
        return ImageOps.fit(im, (SIZE, SIZE), Image.Resampling.LANCZOS, centering=(0.5, 0.35))
    scale = min(SIZE / im.width, SIZE / im.height)
    if abs(scale - 1.0) > 1e-6:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                       Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2), im)
    return canvas


def save_webp(img, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    img.save(dest, "WEBP", quality=WEBP_Q, method=6)


def build_char(c, cand):
    cid, chid = c["id"], cand["id"]
    dest = os.path.join(OUT_I, cid, chid + ".webp")
    if "svg" in cand:
        save_webp(fit(to_image(cand["svg"]), c["cover"]), dest)
        return
    raw = os.path.join(CACHE, "raw", cid, chid + ".bin")
    if os.path.exists(raw):
        with open(raw, "rb") as fh:
            data = fh.read()
        save_webp(fit(to_image(data), c["cover"]), dest)
        return
    last = "aucune URL"
    for url in cand["urls"]:
        try:
            data = http_get(url, timeout=30 if "robohash" in url else 60)
            img = fit(to_image(data), c["cover"])
        except Exception as exc:  # noqa: BLE001
            last = f"{url[:70]} -> {str(exc)[:120]}"
            continue
        os.makedirs(os.path.dirname(raw), exist_ok=True)
        with open(raw, "wb") as fh:
            fh.write(data)
        save_webp(img, dest)
        return
    raise RuntimeError(last)


def run_jobs(colls, jobs, ok, err):
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(build_char, colls[ci], colls[ci]["cands"][k]): (ci, k) for ci, k in jobs}
        for fut in as_completed(futs):
            key = futs[fut]
            done += 1
            try:
                fut.result()
                ok[key] = True
                err.pop(key, None)
            except Exception as exc:  # noqa: BLE001
                err[key] = str(exc)[:200]
            if done % 500 == 0 or done == len(futs):
                print(f"  ... {done}/{len(futs)} (échecs à ce stade : {len(err)})", flush=True)


# ---------------------------------------------------------------- Principal
def verify(out):
    problems = []
    for c in out:
        if not ID_RE.match(c["id"]):
            problems.append(f"id collection : {c['id']}")
        ids = {ch["id"] for ch in c["characters"]}
        for ch in c["characters"]:
            if not ID_RE.match(ch["id"]):
                problems.append(f"charId {c['id']}/{ch['id']}")
            p = os.path.join(OUT_I, c["id"], ch["id"] + ".webp")
            if not os.path.isfile(p):
                problems.append(f"fichier manquant {p}")
                continue
            with Image.open(p) as im:
                if im.format != "WEBP" or im.size != (SIZE, SIZE):
                    problems.append(f"image non conforme {p} ({im.format} {im.size})")
        if not set(c["previews"]) <= ids:
            problems.append(f"previews hors characters : {c['id']}")
    return problems


def main():
    t0 = time.time()
    if os.path.isdir(OUT_I):
        shutil.rmtree(OUT_I)
    if os.path.exists(OUT_JSON):
        os.remove(OUT_JSON)
    os.makedirs(OUT_I, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    print(f"Sortie : {LOT}  (LIBRES_LIMIT={LIMIT or 'aucun'})", flush=True)

    colls = []
    sources = [("dicebear", dicebear_collections), ("iconify", iconify_collections),
               ("game-icons", game_collection), ("fluent3d", fluent_collections),
               ("dogceo", dog_collections), ("thecatapi", cat_collection),
               ("robohash", robohash_collections)]
    for label, fn in sources:
        try:
            got = fn()
        except Exception as exc:  # noqa: BLE001
            print(f"[{label}] ignoré : {exc}", flush=True)
            got = []
        print(f"[{label}] {len(got)} collection(s), {sum(len(c['cands']) for c in got)} candidats", flush=True)
        colls += got

    jobs = [(ci, k) for ci, c in enumerate(colls) for k in range(len(c["cands"]))]
    print(f"Téléchargement et conversion : {len(jobs)} personnages", flush=True)
    ok, err = {}, {}
    run_jobs(colls, jobs, ok, err)
    retry = [j for j in jobs if j not in ok]
    if retry:
        print(f"Nouvelle tentative (une fois) pour {len(retry)} personnage(s) après 30 s", flush=True)
        time.sleep(30)
        run_jobs(colls, retry, ok, err)

    out, report, dropped = [], {}, []
    for ci, c in enumerate(colls):
        chars = [cand for k, cand in enumerate(c["cands"]) if (ci, k) in ok]
        fails = [(cand["id"], err.get((ci, k), "?")) for k, cand in enumerate(c["cands"]) if (ci, k) not in ok]
        if fails:
            report[c["id"]] = {"echecs": len(fails), "exemples": fails[:3]}
        if len(chars) < MIN_CHARS:
            dropped.append(c["id"])
            continue
        chars_out = [{"id": x["id"], "name": x["name"]} for x in chars]
        ids = [x["id"] for x in chars_out]
        pref = [p for p in c["pref"] if p in ids]
        previews = (pref + [i for i in ids if i not in pref])[:PREVIEWS]
        d = {"id": c["id"], "family": "free", "name": c["name"], "source": c["source"], "license": c["license"],
             "free": c["free"], "kid": c["kid"], "total": len(chars_out), "aliases": []}
        if c["group"]:
            d["group"] = c["group"]
            d["style"] = c["style"]
        d["previews"] = previews
        d["characters"] = chars_out
        out.append(d)

    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    problems = verify(out)
    libres = sum(1 for c in out if c["free"])
    persos = sum(c["total"] for c in out)
    echecs = sum(v["echecs"] for v in report.values())
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump({"collections": len(out), "libres": libres, "personnages": persos, "echecs": report,
                   "abandonnees": dropped, "problemes": problems[:100]}, fh, ensure_ascii=False, indent=1)
    print(f"RESUME collections={len(out)} libres={libres} personnages={persos} "
          f"echecs_personnages={echecs} abandonnees={len(dropped)} problemes={len(problems)} "
          f"duree={int(time.time() - t0)}s", flush=True)
    for cid in dropped:
        print(f"  abandonnée : {cid}", flush=True)
    for p in problems[:20]:
        print(f"  PROBLEME : {p}", flush=True)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
