# -*- coding: utf-8 -*-
"""Lot "jeux" du catalogue d'avatars Laststream (contrat CONTRAT.md, sections 1, 2, 4, 5).

Pour chaque collection : recupere les personnages dans la source, telecharge leurs images
(ThreadPool 12, 3 essais, UA navigateur), produit une vignette 128x128 WebP q78 (alpha
conserve, portraits recadres sur la tete) et ecrit :
  .avatars-build/jeux/collections.json
  .avatars-build/jeux/i/<colId>/<charId>.webp

Les reponses JSON sont mises en cache dans .avatars-build/jeux/_cache : relancer le script
reutilise ce cache et saute les vignettes deja presentes (reprise). Un personnage dont
l'image echoue est retire de sa collection.

Usage : python -I scripts/avatars/lot_jeux.py
"""
import functools
import hashlib
import io
import json
import os
import re
import site
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, site.getusersitepackages())
from PIL import Image  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
LOT_DIR = os.path.normpath(os.path.join(ROOT, ".avatars-build", "jeux"))
CACHE_DIR = os.path.join(LOT_DIR, "_cache")
IMG_DIR = os.path.join(LOT_DIR, "i")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
WORKERS = 12
TRIES = 3
MAX_CHARS = 400      # plafond par collection (Pokemon : toutes les especes, pas de plafond)
THUMB = 128
WEBP_QUALITY = 78
N_PREVIEWS = 8
FAMILY = "games"

SHOWDOWN_ANI = "https://play.pokemonshowdown.com/sprites/ani/"
SHOWDOWN_TRAINERS = "https://play.pokemonshowdown.com/sprites/trainers/"
POKE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/"
SRC_POKE_GH = "PokeAPI sprites (GitHub)"
LIC_POKE = "propriétaire The Pokémon Company / Nintendo"
POKE_ALIASES = ["pokemon", "pokémon", "pocket monsters"]


# ---------------------------------------------------------------- reseau et cache
def safe_url(url):
    parts = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=-._~")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, threading.get_ident())
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def get(url, referer=None, timeout=60):
    """Telecharge une URL : 3 essais, sans nouvel essai sur 400/404/410."""
    last = None
    for attempt in range(1, TRIES + 1):
        headers = {"User-Agent": UA, "Accept": "*/*"}
        if referer:
            headers["Referer"] = referer
        try:
            req = urllib.request.Request(safe_url(url), headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (400, 404, 410):
                break
        except Exception as exc:  # noqa: BLE001 - on reessaie
            last = exc
        time.sleep(1.5 * attempt)
    raise last


def get_json(url):
    """JSON distant, mis en cache dans _cache (un fichier par URL)."""
    path = os.path.join(CACHE_DIR, hashlib.sha1(url.encode("utf-8")).hexdigest() + ".json")
    if os.path.exists(path):
        try:
            with open(path, "rb") as fh:
                return json.loads(fh.read().decode("utf-8"))
        except ValueError:
            os.remove(path)  # cache corrompu : on retelecharge
    data = get(url)
    value = json.loads(data.decode("utf-8"))  # refuse une reponse non JSON avant de la cacher
    write_atomic(path, data)
    return value


# ---------------------------------------------------------------- identifiants
def slugify(label):
    s = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40].rstrip("-")
    return s or "item"


def unique_slugs(labels):
    used, out = set(), []
    for label in labels:
        base = slugify(label)
        cand, n = base, 2
        while cand in used:
            cand = "%s-%d" % (base, n)
            n += 1
        used.add(cand)
        out.append(cand)
    return out


def order(items, name_of, preferred):
    """Noms preferes d'abord (ordre de preference), puis le reste dans l'ordre source."""
    by_name = {}
    for it in items:
        by_name.setdefault((name_of(it) or "").lower(), it)
    used, out = set(), []
    for p in preferred:
        it = by_name.get(p.lower())
        if it is not None and id(it) not in used:
            used.add(id(it))
            out.append(it)
    for it in items:
        if id(it) not in used:
            used.add(id(it))
            out.append(it)
    return out


def order_kw(names, keywords):
    used, out = set(), []
    for kw in keywords:
        for n in names:
            if n not in used and kw in n.lower():
                used.add(n)
                out.append(n)
                break
    for n in names:
        if n not in used:
            used.add(n)
            out.append(n)
    return out


def dedupe(cands):
    """Retire les doublons d'URL et de nom (skins Hearthstone, variantes de cartes...)."""
    seen_url, seen_name, out = set(), set(), []
    for label, url, ref in cands:
        label = str(label or "").strip()
        key = label.lower()
        if not key or not url or url in seen_url or key in seen_name:
            continue
        seen_url.add(url)
        seen_name.add(key)
        out.append((label, url, ref))
    return out


# ---------------------------------------------------------------- metadonnees des collections
# kid : contrat section 4. group/style : collections d'un meme univers (selecteur de style).
META = {
    "lol": {"name": "League of Legends", "kid": False, "aliases": ["league of legends", "lol"]},
    "dota2": {"name": "Dota 2", "kid": False, "aliases": ["dota 2", "dota2", "dota"]},
    "valorant-agents": {"name": "Valorant", "kid": False, "aliases": ["valorant"],
                        "group": "valorant", "style": "Agents"},
    "valorant-cartes": {"name": "Valorant", "kid": False, "aliases": ["valorant"],
                        "group": "valorant", "style": "Cartes de joueur"},
    "overwatch": {"name": "Overwatch", "kid": False, "aliases": ["overwatch", "overwatch 2"]},
    "genshin": {"name": "Genshin Impact", "kid": False, "aliases": ["genshin impact", "genshin"]},
    "hsr": {"name": "Honkai: Star Rail", "kid": False,
            "aliases": ["honkai: star rail", "honkai star rail", "star rail"]},
    "arknights": {"name": "Arknights", "kid": False, "aliases": ["arknights"]},
    "fortnite": {"name": "Fortnite — tenues", "kid": False, "aliases": ["fortnite"]},
    "hearthstone": {"name": "Hearthstone — héros", "kid": False, "aliases": ["hearthstone"]},
    "clash-royale": {"name": "Clash Royale — cartes", "kid": False, "aliases": ["clash royale"]},
    "pokemon-officiel": {"name": "Pokémon", "kid": True, "aliases": POKE_ALIASES,
                         "group": "pokemon", "style": "Artwork officiel"},
    "pokemon-home": {"name": "Pokémon", "kid": True, "aliases": POKE_ALIASES,
                     "group": "pokemon", "style": "HOME 3D"},
    "pokemon-home-chromatique": {"name": "Pokémon", "kid": True, "aliases": POKE_ALIASES,
                                 "group": "pokemon", "style": "Chromatique"},
    "pokemon-animes": {"name": "Pokémon", "kid": True, "aliases": POKE_ALIASES,
                       "group": "pokemon", "style": "Pixel animé"},
    "pokemon-dresseurs": {"name": "Pokémon", "kid": False, "aliases": POKE_ALIASES,
                          "group": "pokemon", "style": "Dresseurs"},
    "pokemon-tcg": {"name": "Pokémon TCG — set de base", "kid": False,
                    "aliases": ["pokemon tcg", "pokémon tcg", "pokemon trading card game"]},
    "digimon": {"name": "Digimon", "kid": False,
                "aliases": ["digimon", "digimon adventure", "digital monsters"]},
    "yugioh": {"name": "Yu-Gi-Oh! — cartes", "kid": False,
               "aliases": ["yu-gi-oh!", "yu-gi-oh", "yugioh"]},
    "elden-ring": {"name": "Elden Ring — boss", "kid": False, "aliases": ["elden ring"]},
    "warframe": {"name": "Warframe", "kid": False, "aliases": ["warframe"]},
    "cs2": {"name": "Counter-Strike 2 — agents", "kid": False,
            "aliases": ["counter-strike 2", "counter-strike", "cs2", "csgo"]},
    "smash": {"name": "Super Smash Bros. Ultimate", "kid": False,
              "aliases": ["super smash bros. ultimate", "super smash bros", "smash bros"]},
    "amiibo-mario": {"name": "Amiibo", "kid": True, "group": "amiibo", "style": "Super Mario Bros.",
                     "aliases": ["amiibo", "super mario bros.", "super mario"]},
    "amiibo-zelda": {"name": "Amiibo", "kid": True, "group": "amiibo", "style": "The Legend of Zelda",
                     "aliases": ["amiibo", "the legend of zelda", "zelda"]},
    "amiibo-animal-crossing": {"name": "Amiibo", "kid": True, "group": "amiibo",
                               "style": "Animal Crossing",
                               "aliases": ["amiibo", "animal crossing", "animal crossing new horizons"]},
    "amiibo-splatoon": {"name": "Amiibo", "kid": True, "group": "amiibo", "style": "Splatoon",
                        "aliases": ["amiibo", "splatoon", "splatoon 3"]},
    "amiibo-kirby": {"name": "Amiibo", "kid": True, "group": "amiibo", "style": "Kirby",
                     "aliases": ["amiibo", "kirby"]},
    "amiibo-smash": {"name": "Amiibo", "kid": False, "group": "amiibo", "style": "Super Smash Bros.",
                     "aliases": ["amiibo", "super smash bros.", "smash bros"]},
    "minecraft": {"name": "Minecraft — têtes", "kid": True, "aliases": ["minecraft"]},
}


def spec(cid, source, licence, total, cands, cap=MAX_CHARS):
    """Specification d'une collection. cands : (nom, url, referer) par ordre de priorite."""
    m = META[cid]
    return {"id": cid, "name": m["name"], "source": source, "license": licence, "kid": m["kid"],
            "total": int(total), "aliases": m["aliases"], "group": m.get("group"),
            "style": m.get("style"), "cap": cap, "cands": dedupe(cands)}


# ---------------------------------------------------------------- preferences (ordre d'affichage)
LOL_PREF = ["Ahri", "Yasuo", "Jinx", "Lux", "Garen", "Teemo", "Ezreal", "Thresh", "Zed",
            "Ashe", "Katarina", "Lee Sin"]
DOTA_PREF = ["Anti-Mage", "Pudge", "Invoker", "Juggernaut", "Axe", "Lina", "Crystal Maiden",
             "Phantom Assassin", "Queen of Pain", "Sven", "Earthshaker", "Templar Assassin"]
VALO_PREF = ["Jett", "Phoenix", "Sova", "Sage", "Reyna", "Omen", "Brimstone", "Viper",
             "Cypher", "Killjoy", "Raze", "Breach", "Skye", "Yoru"]
OW_PREF = ["Ana", "Genji", "Mercy", "Tracer", "Reinhardt", "D.Va", "Winston", "Soldier: 76",
           "Widowmaker", "Lúcio", "Kiriko", "Cassidy"]
GENSHIN_PREF = ["Kamisato Ayaka", "Hu Tao", "Klee", "Raiden Shogun", "Zhongli", "Keqing",
                "Venti", "Nahida", "Furina", "Ganyu", "Diluc", "Xiao", "Mona", "Jean"]
HSR_PREF = ["March 7th", "Dan Heng", "Kafka", "Silver Wolf", "Blade", "Seele", "Jingliu",
            "Himeko", "Welt", "Herta", "Firefly", "Acheron", "Bronya", "Clara"]
ARK_KW = ["amiya", "kalts", "texas", "siege", "ceylon", "skadi", "hoshiguma", "lappland",
          "eyjafjalla", "mostima", "saria", "nearl", "chen", "angel", "schwarz"]
FN_PREF = ["Peely", "Raven", "Midas", "Renegade Raider", "Black Knight", "Skull Trooper",
           "Drift", "Galaxy", "Meowscles", "Ghoul Trooper", "Aura", "Ikonik", "Jonesy", "Lynx"]
HS_PREF = ["Jaina Proudmoore", "Rexxar", "Thrall", "Garrosh Hellscream", "Valeera Sanguinar",
           "Uther Lightbringer", "Malfurion Stormrage", "Anduin Wrynn", "Gul'dan",
           "Lady Liadrin", "Lord Jaraxxus", "Illidan Stormrage"]
CR_PREF = ["Knight", "Archers", "Giant", "Wizard", "Valkyrie", "Musketeer", "Hog Rider",
           "P.E.K.K.A", "Prince", "Skeleton Army", "Baby Dragon", "Witch", "Balloon", "Golem",
           "Mega Knight", "Lava Hound"]
POKE_PREF = [25, 1, 4, 7, 133, 6, 150, 143, 149, 130, 94, 448, 658, 445]
ANI = ["pikachu", "charizard", "bulbasaur", "eevee", "gengar", "mewtwo", "snorlax", "lucario",
       "greninja", "gyarados", "dragonite", "garchomp", "sylveon", "umbreon"]
TRAINERS = ["red", "blue", "cynthia", "ash", "misty", "brock", "n", "lillie", "leon",
            "youngster", "lass", "hilbert", "hilda", "gold", "silver", "lyra", "ethan", "may",
            "brendan", "lucas", "dawn", "bianca", "gladion", "sonia", "hop", "marnie", "bede",
            "gloria", "nate", "rosa", "steven", "wallace", "giovanni", "erika", "sabrina",
            "koga", "blaine", "lance", "jessie", "james"]
TCG_PREF = ["Charizard", "Pikachu", "Blastoise", "Venusaur", "Alakazam", "Mewtwo", "Gyarados",
            "Snorlax", "Machamp", "Raichu", "Zapdos", "Chansey"]
DIGI_PREF = ["Agumon", "Gabumon", "Patamon", "Gomamon", "Palmon", "Tentomon", "Biyomon",
             "Gatomon", "Veemon", "Guilmon", "Terriermon", "Renamon", "Angemon", "Greymon",
             "Garurumon", "MetalGreymon", "WarGreymon", "Omegamon"]
YGO_PREF = ["Dark Magician", "Blue-Eyes White Dragon", "Exodia the Forbidden One",
            "Red-Eyes Black Dragon", "Summoned Skull", "Kuriboh", "Dark Magician Girl",
            "Time Wizard", "Mystical Elf", "Obelisk the Tormentor", "Slifer the Sky Dragon",
            "The Winged Dragon of Ra", "Gaia The Fierce Knight", "Celtic Guardian"]
ELDEN_PREF = ["Margit, the Fell Omen", "Godrick the Grafted", "Radahn, Festival of the Stars",
              "Malenia, Blade of Miquella", "Rennala, Queen of the Full Moon",
              "Rykard, Lord of Blasphemy", "Maliketh, the Black Blade", "Mohg, Lord of Blood",
              "Godfrey, First Elden Lord", "Fire Giant", "Astel, Naturalborn of the Void",
              "Dragonlord Placidusax"]
WF_PREF = ["Excalibur", "Mag", "Volt", "Loki", "Ash", "Rhino", "Frost", "Nova", "Trinity",
           "Mirage", "Valkyr", "Ember", "Nyx", "Inaros", "Saryn"]
SMASH = [("mario", "Mario"), ("link", "Link"), ("pikachu", "Pikachu"), ("kirby", "Kirby"),
         ("samus", "Samus"), ("donkey_kong", "Donkey Kong"), ("fox", "Fox"), ("yoshi", "Yoshi"),
         ("sonic", "Sonic"), ("pac_man", "Pac-Man")]
MC = ["Steve", "Alex", "Notch", "jeb_", "Dream", "Technoblade", "CaptainSparklez", "DanTDM"]
AMIIBO = [  # (colId, serie interrogee dans AmiiboAPI)
    ("amiibo-mario", "Super Mario Bros."),
    ("amiibo-zelda", "Legend Of Zelda"),
    ("amiibo-animal-crossing", "Animal Crossing"),
    ("amiibo-splatoon", "Splatoon"),
    ("amiibo-kirby", "Kirby"),
    ("amiibo-smash", "Super Smash Bros."),
]


# ---------------------------------------------------------------- constructeurs de collections
def b_lol():
    champs = list(get_json("https://ddragon.leagueoflegends.com/cdn/16.20.1/data/en_US/champion.json")["data"].values())
    base = "https://ddragon.leagueoflegends.com/cdn/16.20.1/img/champion/"
    items = order(champs, lambda c: c.get("name"), LOL_PREF)
    return spec("lol", "Riot Data Dragon", "propriétaire Riot", len(champs),
                [(c["name"], base + c["image"]["full"], None) for c in items])


def b_dota():
    heroes = get_json("https://api.opendota.com/api/heroes")
    items = order(heroes, lambda h: h.get("localized_name"), DOTA_PREF)
    base = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/"
    return spec("dota2", "OpenDota / Steam CDN", "propriétaire Valve", len(heroes),
                [(h["localized_name"], base + h["name"].replace("npc_dota_hero_", "") + ".png", None)
                 for h in items])


def b_valo_agents():
    ag = [a for a in get_json("https://valorant-api.com/v1/agents?isPlayableCharacter=true")["data"]
          if a.get("displayIcon")]
    items = order(ag, lambda a: a.get("displayName"), VALO_PREF)
    return spec("valorant-agents", "valorant-api.com", "propriétaire Riot", len(ag),
                [(a["displayName"], a["displayIcon"], None) for a in items])


def b_valo_cards():
    cards = [c for c in get_json("https://valorant-api.com/v1/playercards")["data"] if c.get("displayIcon")]
    return spec("valorant-cartes", "valorant-api.com", "propriétaire Riot", len(cards),
                [(c["displayName"], c["displayIcon"], None) for c in cards])


def b_overwatch():
    heroes = [h for h in get_json("https://overfast-api.tekrop.fr/heroes") if h.get("portrait")]
    items = order(heroes, lambda h: h.get("name"), OW_PREF)
    return spec("overwatch", "OverFast API", "propriétaire Blizzard", len(heroes),
                [(h["name"], h["portrait"], None) for h in items])


def b_genshin():
    chars = [c for c in get_json("https://gi.yatta.moe/api/v2/en/avatar")["data"]["items"].values()
             if c.get("icon") and c.get("name")]
    items = order(chars, lambda c: c.get("name"), GENSHIN_PREF)
    return spec("genshin", "gi.yatta.moe", "propriétaire HoYoverse", len(chars),
                [(c["name"], "https://gi.yatta.moe/assets/UI/%s.png" % c["icon"], None) for c in items])


def b_hsr():
    chars = list(get_json("https://raw.githubusercontent.com/Mar-7th/StarRailRes/master/index_new/en/characters.json").values())
    items = order(chars, lambda c: c.get("name"), HSR_PREF)
    base = "https://raw.githubusercontent.com/Mar-7th/StarRailRes/master/icon/character/%s.png"
    return spec("hsr", "StarRailRes (Mar-7th)", "propriétaire HoYoverse", len(chars),
                [(c["name"], base % c["id"], None) for c in items])


def b_arknights():
    repo = "https://api.github.com/repos/yuanyan3060/Arknights-Bot-Resource"
    branch = get_json(repo)["default_branch"]
    top = get_json(repo + "/git/trees/" + branch)["tree"]
    sha = next(t["sha"] for t in top if t["path"] == "avatar")
    files = sorted(t["path"] for t in get_json(repo + "/git/trees/" + sha)["tree"]
                   if t["path"].startswith("char_") and t["path"].endswith(".png"))
    ordered = order_kw(files, ARK_KW)
    base = "https://raw.githubusercontent.com/yuanyan3060/Arknights-Bot-Resource/%s/avatar/" % branch

    def label(fname):
        parts = fname[:-4].split("_")
        return (parts[2] if len(parts) > 2 else fname[:-4]).capitalize()

    return spec("arknights", "Arknights-Bot-Resource (GitHub)", "propriétaire Hypergryph / Yostar",
                len(files), [(label(f), base + f, None) for f in ordered])


def b_fortnite():
    data = get_json("https://fortnite-api.com/v2/cosmetics/br?language=en")["data"]
    outfits = [c for c in data if (c.get("type") or {}).get("value") == "outfit"
               and (c.get("images") or {}).get("icon")]
    items = order(outfits, lambda c: c.get("name"), FN_PREF)
    return spec("fortnite", "fortnite-api.com", "propriétaire Epic Games", len(outfits),
                [(c["name"], c["images"]["icon"], None) for c in items])


def b_hearthstone():
    cards = get_json("https://api.hearthstonejson.com/v1/latest/enUS/cards.json")
    heroes = [c for c in cards if c.get("type") == "HERO" and c.get("collectible")]
    items = order(heroes, lambda c: c.get("name"), HS_PREF)
    return spec("hearthstone", "HearthstoneJSON", "propriétaire Blizzard", len(heroes),
                [(c["name"], "https://art.hearthstonejson.com/v1/256x/%s.jpg" % c["id"], None) for c in items])


def b_clash():
    cards = get_json("https://royaleapi.github.io/cr-api-data/json/cards.json")
    items = order(cards, lambda c: c.get("name"), CR_PREF)
    return spec("clash-royale", "RoyaleAPI", "propriétaire Supercell", len(cards),
                [(c["name"], "https://royaleapi.github.io/cr-api-assets/cards-150/%s.png" % c["key"], None)
                 for c in items])


@functools.lru_cache(maxsize=None)
def pokemon_table():
    """[(id national, nom anglais PokeAPI, nom francais)] pour toutes les especes (1025)."""
    listing = get_json("https://pokeapi.co/api/v2/pokemon-species?limit=2000")["results"]
    rows = sorted((int(r["url"].rstrip("/").split("/")[-1]), r["name"]) for r in listing)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        fr_names = list(pool.map(poke_fr, [pid for pid, _ in rows]))
    table, fallback = [], 0
    for (pid, eng), fr in zip(rows, fr_names):
        if not fr:
            fallback += 1
            fr = eng.replace("-", " ").capitalize()
        table.append((pid, eng, fr))
    print("pokemon : %d especes, nom francais manquant (repli anglais) = %d" % (len(table), fallback))
    return table


def poke_fr(pid):
    try:
        sp = get_json("https://pokeapi.co/api/v2/pokemon-species/%d" % pid)
    except Exception:  # noqa: BLE001 - repli sur le nom anglais, signale dans le recap
        return None
    return next((n["name"] for n in sp.get("names", [])
                 if n.get("language", {}).get("name") == "fr"), None)


def b_poke(cid, sprite_path, source, showdown=False):
    table = pokemon_table()
    names = {pid: (eng, fr) for pid, eng, fr in table}
    order_ids = [p for p in POKE_PREF if p in names] + [pid for pid, _, _ in table if pid not in POKE_PREF]
    cands = []
    for pid in order_ids:
        eng, fr = names[pid]
        if showdown:  # nom Showdown = nom anglais sans caracteres speciaux (nidoran-f -> nidoranf)
            url = SHOWDOWN_ANI + re.sub(r"[^a-z0-9]", "", eng) + ".gif"
        else:
            url = POKE_BASE + sprite_path + "/%d.png" % pid
        cands.append((fr, url, None))
    return spec(cid, source, LIC_POKE, len(table), cands, cap=len(table))


def b_trainers():
    return spec("pokemon-dresseurs", "Pokémon Showdown (sprites dresseurs)", LIC_POKE, len(TRAINERS),
                [(n.capitalize(), SHOWDOWN_TRAINERS + n + ".png", None) for n in TRAINERS])


def b_tcg():
    data = get_json("https://api.tcgdex.net/v2/en/sets/base1")
    items = order([c for c in data["cards"] if c.get("image")], lambda c: c.get("name"), TCG_PREF)
    return spec("pokemon-tcg", "TCGdex", "propriétaire The Pokémon Company", data["cardCount"]["total"],
                [(c["name"], c["image"] + "/high.webp", None) for c in items])


def b_digimon():
    found = {}
    for page in range(40):
        try:
            content = get_json("https://digi-api.com/api/v1/digimon?page=%d&pageSize=100" % page).get("content", [])
        except Exception:  # noqa: BLE001
            if not found:
                raise
            break
        if not content:
            break
        for d in content:
            found.setdefault(d["name"], d)
    items = order(list(found.values()), lambda d: d.get("name"), DIGI_PREF)
    return spec("digimon", "Digi-API", "propriétaire Bandai / Toei Animation", len(found),
                [(d["name"], d["image"], None) for d in items if d.get("image")])


def b_yugioh():
    # Une seule requete : toute la base (~14 600 cartes). Preferees d'abord, puis les monstres
    # dans l'ordre source (les cartes Spell/Trap/Token ne sont pas des personnages).
    data = get_json("https://db.ygoprodeck.com/api/v7/cardinfo.php")["data"]
    by_name = {}
    for c in data:
        by_name.setdefault(c["name"].lower(), c)
    prefs = [by_name[p.lower()] for p in YGO_PREF
             if p.lower() in by_name and by_name[p.lower()].get("card_images")]
    pref_names = {c["name"].lower() for c in prefs}
    monsters = [c for c in data if "Monster" in (c.get("type") or "") and c.get("card_images")
                and c["name"].lower() not in pref_names]
    cands = [(c["name"], "https://images.ygoprodeck.com/images/cards_cropped/%d.jpg" % c["card_images"][0]["id"], None)
             for c in prefs + monsters]
    return spec("yugioh", "YGOPRODeck", "propriétaire Konami / Shueisha", len(data), cands)


def b_elden():
    d = get_json("https://eldenring.fanapis.com/api/bosses?limit=200")
    bosses = [b for b in d["data"] if b.get("image")]
    items = order(bosses, lambda b: b.get("name"), ELDEN_PREF)
    return spec("elden-ring", "eldenring.fanapis.com", "propriétaire FromSoftware / Bandai Namco",
                d.get("total", len(d["data"])), [(b["name"], b["image"], None) for b in items])


def b_warframe():
    wf = [w for w in get_json("https://api.warframestat.us/warframes") if w.get("imageName")]
    items = order(wf, lambda w: w.get("name"), WF_PREF)
    return spec("warframe", "warframestat.us", "propriétaire Digital Extremes", len(wf),
                [(w["name"], "https://cdn.warframestat.us/img/" + w["imageName"], None) for w in items])


def b_cs2():
    ag = [a for a in get_json("https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json")
          if a.get("image")]
    return spec("cs2", "ByMykel/CSGO-API", "propriétaire Valve", len(ag),
                [(a["name"].split(" | ")[0], a["image"], None) for a in ag])


def b_smash():
    base = "https://www.smashbros.com/assets_v2/img/fighter/"
    return spec("smash", "smashbros.com", "propriétaire Nintendo", len(SMASH),
                [(lab, base + slug + "/main.png", None) for slug, lab in SMASH])


def b_amiibo(cid, series):
    am = [a for a in get_json("https://www.amiiboapi.org/api/amiibo/?amiiboSeries=" + urllib.parse.quote(series))
          .get("amiibo", []) if a.get("image")]
    return spec(cid, "AmiiboAPI", "propriétaire Nintendo", len(am),
                [(a["name"], a["image"], None) for a in am])


def b_minecraft():
    return spec("minecraft", "mc-heads.net", "propriétaire Mojang / Microsoft", len(MC),
                [(p, "https://mc-heads.net/avatar/%s/96" % p, None) for p in MC])


BUILDERS = [
    ("lol", b_lol), ("dota2", b_dota), ("valorant-agents", b_valo_agents),
    ("valorant-cartes", b_valo_cards), ("overwatch", b_overwatch), ("genshin", b_genshin),
    ("hsr", b_hsr), ("arknights", b_arknights), ("fortnite", b_fortnite),
    ("hearthstone", b_hearthstone), ("clash-royale", b_clash),
    ("pokemon-officiel", functools.partial(b_poke, "pokemon-officiel", "other/official-artwork", SRC_POKE_GH)),
    ("pokemon-home", functools.partial(b_poke, "pokemon-home", "other/home", SRC_POKE_GH)),
    ("pokemon-home-chromatique", functools.partial(b_poke, "pokemon-home-chromatique", "other/home/shiny",
                                                   SRC_POKE_GH)),
    ("pokemon-animes", functools.partial(b_poke, "pokemon-animes", None,
                                         "Pokémon Showdown (sprites animés)", True)),
    ("pokemon-dresseurs", b_trainers), ("pokemon-tcg", b_tcg),
    ("digimon", b_digimon), ("yugioh", b_yugioh), ("elden-ring", b_elden),
    ("warframe", b_warframe), ("cs2", b_cs2), ("smash", b_smash),
] + [(cid, functools.partial(b_amiibo, cid, series)) for cid, series in AMIIBO] + [
    ("minecraft", b_minecraft),
]


# ---------------------------------------------------------------- vignettes et telechargement
def thumbnail(data):
    """Vignette carree 128x128 WebP q78, alpha conserve. Portrait : haut de l'image (tete)."""
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        rgba = im.convert("RGBA")
    w, h = rgba.size
    s = min(w, h)
    if h > w:
        box = (0, 0, s, s)
    else:
        x0, y0 = (w - s) // 2, (h - s) // 2
        box = (x0, y0, x0 + s, y0 + s)
    out = rgba.crop(box).resize((THUMB, THUMB), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue()


def fetch_thumb(task):
    cid, chid, url, ref, dst = task
    if os.path.exists(dst):  # reprise : vignette deja produite lors d'un lancement precedent
        return cid, chid, True, "present"
    try:
        write_atomic(dst, thumbnail(get(url, referer=ref)))
        return cid, chid, True, None
    except Exception as exc:  # noqa: BLE001
        return cid, chid, False, "%s: %s" % (type(exc).__name__, str(exc)[:160])


# ---------------------------------------------------------------- principal
def main():
    t0 = time.time()
    os.makedirs(CACHE_DIR, exist_ok=True)

    specs, spec_errors = [], []
    for cid, fn in BUILDERS:
        try:
            s = fn()
            specs.append(s)
            print("spec %-26s total=%-6s candidats=%d" % (cid, s["total"], len(s["cands"])))
        except Exception as exc:  # noqa: BLE001
            spec_errors.append((cid, repr(exc)[:200]))
            print("ERREUR SPEC %-26s %s" % (cid, repr(exc)[:200]))
    print("specs construites : %d / %d (%.0fs)" % (len(specs), len(BUILDERS), time.time() - t0))

    tasks = []
    for s in specs:
        cands = s["cands"][: s["cap"]]
        slugs = unique_slugs([label for label, _, _ in cands])
        s["chars"] = [{"id": sl, "name": label, "url": url, "ref": ref}
                      for sl, (label, url, ref) in zip(slugs, cands)]
        for c in s["chars"]:
            tasks.append((s["id"], c["id"], c["url"], c["ref"],
                          os.path.join(IMG_DIR, s["id"], c["id"] + ".webp")))
    print("images a traiter : %d" % len(tasks))

    results = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for n, (cid, chid, ok, info) in enumerate(pool.map(fetch_thumb, tasks), 1):
            results[(cid, chid)] = (ok, info)
            if n % 500 == 0 or n == len(tasks):
                print("  ... %d / %d (%.0fs)" % (n, len(tasks), time.time() - t0), flush=True)

    out, keep, report = [], set(), []
    for s in specs:
        kept = [c for c in s["chars"] if results[(s["id"], c["id"])][0]]
        failed = [c for c in s["chars"] if not results[(s["id"], c["id"])][0]]
        report.append((s["id"], len(kept), len(s["chars"]), len(failed),
                       [(c["id"], results[(s["id"], c["id"])][1]) for c in failed[:3]]))
        for c in kept:
            keep.add(os.path.normpath(os.path.join(IMG_DIR, s["id"], c["id"] + ".webp")))
        if not kept:
            continue
        entry = {"id": s["id"], "family": FAMILY, "name": s["name"], "source": s["source"],
                 "license": s["license"], "free": False, "kid": s["kid"], "total": s["total"],
                 "aliases": s["aliases"]}
        if s["group"]:
            entry["group"] = s["group"]
            entry["style"] = s["style"]
        entry["previews"] = [c["id"] for c in kept[:N_PREVIEWS]]
        entry["characters"] = [{"id": c["id"], "name": c["name"]} for c in kept]
        out.append(entry)

    orphans = 0
    if os.path.isdir(IMG_DIR):
        for root, _dirs, files in os.walk(IMG_DIR):
            for f in files:
                p = os.path.normpath(os.path.join(root, f))
                if p not in keep:
                    os.remove(p)
                    orphans += 1
        for root, _dirs, _files in os.walk(IMG_DIR, topdown=False):
            if root != IMG_DIR and not os.listdir(root):
                os.rmdir(root)

    write_atomic(os.path.join(LOT_DIR, "collections.json"),
                 json.dumps(out, ensure_ascii=False, indent=1).encode("utf-8"))

    print()
    print("%-26s %-12s %s" % ("collection", "gardes", "echecs (exemples)"))
    for cid, nkept, ntot, nfail, sample in report:
        print("%-26s %4d / %-6d %d %s" % (cid, nkept, ntot, nfail,
                                          "; ".join("%s=%s" % x for x in sample)))
    n_chars = sum(len(e["characters"]) for e in out)
    n_fail = sum(1 for ok, _ in results.values() if not ok)
    n_present = sum(1 for ok, info in results.values() if ok and info == "present")
    print("COLLECTIONS=%d PERSONNAGES=%d ECHECS_IMAGE=%d (reprises=%d) ECHECS_SPEC=%d ORPHELINS_SUPPRIMES=%d DUREE=%.0fs"
          % (len(out), n_chars, n_fail, n_present, len(spec_errors), orphans, time.time() - t0))


if __name__ == "__main__":
    main()
