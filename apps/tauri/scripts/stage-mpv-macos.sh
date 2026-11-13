#!/usr/bin/env bash
# Prépare libmpv (Homebrew) et toutes ses dépendances pour le paquet macOS :
#  - copie dans <dossier>/ (par défaut apps/tauri/src-tauri/target/mpv-stage) ;
#  - install names réécrits en @rpath/… (l'app a un rpath vers Contents/Frameworks, voir build.rs) ;
#  - signature ad hoc de chaque bibliothèque (Apple Silicon refuse de charger un code modifié non signé) ;
#  - écrit <dossier>/frameworks.json : liste à passer à `tauri build --config` (bundle.macOS.frameworks).
# Prérequis : brew install mpv dylibbundler
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$here/src-tauri/target/mpv-stage}"
rm -rf "$out"
mkdir -p "$out"
mpv_lib="$(brew --prefix mpv)/lib/libmpv.2.dylib"
test -f "$mpv_lib"
cp "$mpv_lib" "$out/libmpv.2.dylib"
chmod u+w "$out/libmpv.2.dylib"
install_name_tool -id @rpath/libmpv.2.dylib "$out/libmpv.2.dylib"
# Copie les dépendances (hors système) dans le même dossier et réécrit toutes les références en @rpath/.
dylibbundler -of -b -cd -x "$out/libmpv.2.dylib" -d "$out" -p @rpath/ >/dev/null
# Liaison par -lmpv au build.
ln -sf libmpv.2.dylib "$out/libmpv.dylib"
for lib in "$out"/*.dylib; do
  [ -L "$lib" ] && continue
  codesign --force --sign - "$lib"
done
# Liste des bibliothèques à copier dans Contents/Frameworks (sans le lien symbolique).
python3 - "$out" <<'PY'
import json, os, sys
out = sys.argv[1]
libs = sorted(os.path.join(out, f) for f in os.listdir(out) if f.endswith('.dylib') and not os.path.islink(os.path.join(out, f)))
json.dump({"bundle": {"macOS": {"frameworks": libs}}}, open(os.path.join(out, 'frameworks.json'), 'w'), indent=2)
print(f"{len(libs)} bibliothèques prêtes dans {out}")
PY
