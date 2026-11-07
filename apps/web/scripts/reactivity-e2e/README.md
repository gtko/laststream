# Mesure de réactivité (web, mode démo)
Mesure le délai entre un clic et la première réaction visible (mutation du DOM, puis image peinte) sur les actions principales, en `?demo=1&clean=1`.
Lancer : `node scripts/reactivity-e2e/measure.mjs` (Vite démarre sur un port libre et s'arrête à la fin) ou `--url http://localhost:PORT` ; `--json` ajoute le résultat complet.
Chromium headless (Playwright, repli sur Chrome installé), 10 répétitions par action, code de sortie 0 même au-delà de 100 ms (mesure, pas un test).
Le mode démo lit le catalogue public (GET) sur le Worker Laststream : la mesure inclut ces lectures réseau.
