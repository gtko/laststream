// Génère les pages des guides, en français (public/guides/<id>/) et en anglais (public/en/guides/<slug>/), ainsi que le
// sommaire anglais (public/en/guides/). Le texte de chaque guide est dans guides-content.mjs ; les images viennent de
// capture-guides.mjs (`node capture-guides.mjs --install`). Usage : node build-guides.mjs
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDES, UI } from './guides-content.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, '..', 'public');
const SITE = 'https://laststream.app';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Texte riche des guides : déjà en HTML (code, liens, guillemets avec espaces insécables).
const urlOf = (g, lang) => (lang === 'fr' ? `/guides/${g.id}/` : `/en/guides/${g.en.slug}/`);
const indexUrl = (lang) => (lang === 'fr' ? '/guides/' : '/en/guides/');
const homeUrl = (lang) => (lang === 'fr' ? '/' : '/en/');

function head(lang, { title, description, url, image, imageAlt, alternates, jsonLd }) {
  const u = UI[lang];
  return `<!doctype html>
<!-- Page générée par guides-capture/build-guides.mjs (texte : guides-content.mjs) : modifier la source, pas ce fichier. -->
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0c0b11">
<link rel="canonical" href="${SITE}${url}">
${alternates.map(([l, href]) => `<link rel="alternate" hreflang="${l}" href="${SITE}${href}">`).join('\n')}
<link rel="icon" type="image/svg+xml" href="/assets/logo.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Laststream">
<meta property="og:locale" content="${u.locale}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${url}">
<meta property="og:image" content="${SITE}${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}${image}">
<meta name="twitter:image:alt" content="${esc(imageAlt)}">
<link rel="preload" href="/assets/fonts/sora-latin-800.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/jakarta-latin-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/guides/guides.css">${jsonLd ? `\n<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>` : ''}
</head>
<body>
<a class="skip" href="#contenu">${u.skip}</a>
`;
}

function topbar(lang, frHref, enHref) {
  const u = UI[lang];
  const h = homeUrl(lang);
  return `
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="${h}" aria-label="${u.brandLabel}">
      <img src="/assets/logo.svg" width="36" height="36" alt="">
      <span>Laststream</span>
    </a>
    <nav class="nav" aria-label="${u.mainNav}">
${u.nav.map(([href, label]) => `      <a href="${h}${href}">${label}</a>`).join('\n')}
      <a href="${indexUrl(lang)}" aria-current="page">Guides</a>
    </nav>
    <a class="btn btn-sm" href="${h}#telecharger">${u.download}</a>
    <nav class="lang" aria-label="${u.langNav}">
      <a href="${frHref}" hreflang="fr" lang="fr"${lang === 'fr' ? ' aria-current="page"' : ''}>FR</a>
      <a href="${enHref}" hreflang="en" lang="en"${lang === 'en' ? ' aria-current="page"' : ''}>EN</a>
    </nav>
  </div>
</header>
`;
}

function footer(lang) {
  const u = UI[lang];
  return `
<footer class="foot">
  <div class="wrap foot-in">
    <a class="brand" href="${homeUrl(lang)}"><img src="/assets/logo.svg" width="28" height="28" alt=""><span>Laststream</span></a>
    <div class="foot-txt">
${u.footer.map((p) => `      ${p}`).join('\n')}
    </div>
  </div>
</footer>
<script>
  // Vidéos du guide : pas de lecture automatique si l'utilisateur réduit les animations
  (function () {
    try {
      if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      document.querySelectorAll('video.clip').forEach(function (v) { v.removeAttribute('autoplay'); v.pause(); v.setAttribute('preload', 'none'); });
    } catch (e) { /* sans effet */ }
  })();
</script>
</body>
</html>
`;
}

function figure(dir, shot, alt) {
  return `          <figure class="shot">
            <img src="./img/${shot}-1280.webp" srcset="./img/${shot}-1280.webp 1280w, ./img/${shot}.webp 2560w" sizes="(min-width: 900px) 700px, calc(100vw - 84px)" width="1280" height="800" loading="lazy" alt="${esc(alt)}">
          </figure>`;
}

function guidePage(g, lang, i) {
  const u = UI[lang];
  const c = g[lang];
  const url = urlOf(g, lang);
  const prev = GUIDES[i - 1];
  const next = GUIDES[i + 1];
  const parts = [];
  parts.push(head(lang, {
    title: `${c.title} - ${u.guidesTitle}`,
    description: c.lead.replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ''),
    url,
    image: `${url}img/og.jpg`,
    imageAlt: c.ogAlt,
    alternates: [['fr', urlOf(g, 'fr')], ['en', urlOf(g, 'en')], ['x-default', urlOf(g, 'fr')]],
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Guides', item: SITE + indexUrl(lang) },
        { '@type': 'ListItem', position: 2, name: c.title, item: SITE + url },
      ],
    },
  }));
  parts.push(topbar(lang, urlOf(g, 'fr'), urlOf(g, 'en')));
  parts.push(`
<main id="contenu">
  <header class="guide-hero">
    <div class="wrap narrow">
      <nav class="guide-crumbs" aria-label="${u.crumbs}">
        <ol>
          <li><a href="${indexUrl(lang)}">Guides</a></li>
          <li aria-current="page">${c.title}</li>
        </ol>
      </nav>
      <h1>${c.title}</h1>
      <p class="lead">${c.lead}</p>
      <ul class="guide-badges" aria-label="${u.badges}">
        <li class="is-time">${g.minutes} min</li>
${g.platforms.map((p) => `        <li>${u.platforms[p]}</li>`).join('\n')}
      </ul>
      <figure class="shot">
        <video class="clip" src="./clip.mp4" poster="./img/poster.webp" width="1280" height="800" autoplay muted loop playsinline controls preload="metadata" aria-label="${esc(u.clipLabel)}"></video>
      </figure>
    </div>
  </header>

  <article class="wrap narrow guide-body">`);
  if (c.prereq) {
    parts.push(`
    <section class="guide-prereq" aria-labelledby="h-prereq">
      <h2 id="h-prereq">${u.prereq}</h2>
      <ul>
${c.prereq.map((p) => `        <li>${p}</li>`).join('\n')}
      </ul>
    </section>`);
  }
  parts.push(`
    <section aria-labelledby="h-steps">
      <h2 id="h-steps">${u.steps}</h2>
      <p class="guide-note">${u.legend}</p>
      <ol class="guide-steps">
${c.steps.map((st) => `        <li>
${[].concat(st.text).map((t) => `          <p>${t}</p>`).join('\n')}${st.shot ? '\n' + figure(url, st.shot, st.alt) : ''}
        </li>`).join('\n')}
      </ol>
    </section>`);
  for (const sec of c.sections ?? []) {
    if (sec.tip) {
      parts.push(`
    <aside class="guide-tip" aria-label="${u.tip}">
      <p class="guide-tip-title">${u.tip}</p>
      <ul>
${sec.tip.map((t) => `        <li>${t}</li>`).join('\n')}
      </ul>
    </aside>`);
    } else {
      parts.push(`
    <section aria-labelledby="h-${sec.id}">
      <h2 id="h-${sec.id}">${sec.title}</h2>
${sec.html.trim().split('\n').map((l) => (l ? '      ' + l : l)).join('\n')}
    </section>`);
    }
  }
  parts.push(`
    <nav class="guide-pager" aria-label="${u.pager}">
${prev ? `      <a class="prev" href="${urlOf(prev, lang)}">
        <small>${u.prev}</small>
        <strong>${prev[lang].title}</strong>
      </a>` : ''}${prev && next ? '\n' : ''}${next ? `      <a class="next" href="${urlOf(next, lang)}">
        <small>${u.next}</small>
        <strong>${next[lang].title}</strong>
      </a>` : `
      <a class="next" href="${indexUrl(lang)}">
        <small>${u.contents}</small>
        <strong>${u.allGuides}</strong>
      </a>`}
    </nav>
  </article>
</main>
`);
  parts.push(footer(lang));
  return parts.join('');
}

function enIndex() {
  const u = UI.en;
  const parts = [head('en', {
    title: 'Guides - Laststream',
    description: 'Short step-by-step guides to get started with Laststream: profiles, Stremio sources, live TV.',
    url: '/en/guides/',
    image: '/assets/og.png',
    imageAlt: 'Laststream logo and the tagline Your cinema, everywhere',
    alternates: [['fr', '/guides/'], ['en', '/en/guides/'], ['x-default', '/guides/']],
  })];
  parts.push(topbar('en', '/guides/', '/en/guides/'));
  parts.push(`
<main id="contenu">
  <header class="guide-hero">
    <div class="wrap">
      <h1>Guides</h1>
      <p class="lead">Short step-by-step guides to get started with Laststream, from your first profile to live TV. Every screenshot shows where to click.</p>
    </div>
  </header>

  <section class="guide-index" aria-label="Guides">
    <div class="wrap">
      <section class="guide-index-sec" aria-labelledby="h-essentials">
        <p class="kicker">Getting started</p>
        <h2 id="h-essentials">The essential guides</h2>
        <ul class="cards">
${GUIDES.map((g, i) => `          <li class="card guide-card">
            <a href="${urlOf(g, 'en')}">
              <span class="guide-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
              <h3>${g.en.title}</h3>
              <p>${g.en.card}</p>
            </a>
          </li>`).join('\n')}
        </ul>
      </section>
    </div>
  </section>
</main>
`);
  parts.push(footer('en'));
  return parts.join('');
}

for (const [i, g] of GUIDES.entries()) {
  for (const lang of ['fr', 'en']) {
    const dir = join(PUBLIC, urlOf(g, lang));
    for (const st of g[lang].steps) if (st.shot) statSync(join(dir, 'img', `${st.shot}-1280.webp`)); // image manquante : erreur
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), guidePage(g, lang, i));
    console.log(`${urlOf(g, lang)}index.html`);
  }
}
writeFileSync(join(PUBLIC, 'en', 'guides', 'index.html'), enIndex());
console.log('/en/guides/index.html');
