/* Forum (LAST-1651) : rendu Markdown réduit, construit en nœuds DOM (jamais d'innerHTML sur un texte de membre).
 * Blocs : paragraphes, titres (#, ##, ###), citations (>), listes (- * 1.), blocs de code (```). En ligne : `code`, **gras**,
 * *italique* ou _italique_, ~~barré~~, ||spoiler|| (flouté, révélé au clic), [texte](https://…), liens nus https://…, et
 * mentions @Nom#TAG. Les liens ne sont que http(s), ouverts dans un nouvel onglet sans référent. */

import { t } from '../i18n';
const INLINE = new RegExp(
  [
    '(`[^`\\n]+`)', // 1 code
    '(\\*\\*[^*\\n]+?\\*\\*)', // 2 gras
    '(~~[^~\\n]+?~~)', // 3 barré
    '(\\|\\|[^|\\n]+?\\|\\|)', // 4 spoiler
    '(\\[[^\\]\\n]{1,200}\\]\\(https?:\\/\\/[^\\s)]{1,2000}\\))', // 5 lien
    '(https?:\\/\\/[^\\s<>"]{2,2000}[^\\s<>".,;:!?)\\]\'])', // 6 lien nu
    '(\\*[^*\\n]+?\\*|\\b_[^_\\n]+?_\\b)', // 7 italique
    '(@[\\p{L}\\p{N}_-][\\p{L}\\p{N} _-]{1,19}#[0-9A-Za-z]{4})', // 8 mention
  ].join('|'),
  'gu',
);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function link(href, text) {
  const a = el('a', 'fm-link', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow ugc';
  return a;
}

/** Ajoute à `parent` le texte `text` mis en forme (récursif pour gras, italique, barré, spoiler). */
function renderInline(text, parent, depth = 0) {
  if (depth > 4) { parent.append(text); return; }
  let last = 0;
  // Copie locale : l'appel récursif (gras, italique…) ne doit pas déplacer la position de cette boucle.
  const re = new RegExp(INLINE.source, INLINE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) parent.append(el('code', 'fm-code', s.slice(1, -1)));
    else if (m[2]) { const b = el('strong'); renderInline(s.slice(2, -2), b, depth + 1); parent.append(b); }
    else if (m[3]) { const d = el('s'); renderInline(s.slice(2, -2), d, depth + 1); parent.append(d); }
    else if (m[4]) {
      const sp = el('span', 'fm-spoiler');
      sp.tabIndex = 0;
      sp.setAttribute('role', 'button');
      sp.setAttribute('aria-label', t('Spoiler : afficher'));
      renderInline(s.slice(2, -2), sp, depth + 1);
      const reveal = () => { sp.classList.add('is-shown'); sp.removeAttribute('role'); sp.removeAttribute('aria-label'); sp.removeAttribute('tabindex'); };
      sp.addEventListener('click', reveal, { once: true });
      sp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
      parent.append(sp);
    } else if (m[5]) {
      const close = s.indexOf('](');
      parent.append(link(s.slice(close + 2, -1), s.slice(1, close)));
    } else if (m[6]) parent.append(link(s, s.length > 60 ? s.slice(0, 57) + '…' : s));
    else if (m[7]) { const i = el('em'); renderInline(s.slice(1, -1), i, depth + 1); parent.append(i); }
    else if (m[8]) parent.append(el('span', 'fm-mention', s));
    last = m.index + s.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Rend `src` (Markdown du forum) dans un nouvel élément `div.fm`. */
export function renderMarkdown(src) {
  const root = el('div', 'fm');
  const lines = String(src || '').split('\n');
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = el('p');
    para.forEach((line, k) => { if (k) p.append(el('br')); renderInline(line, p); });
    root.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // fermeture (ou fin du texte)
      const pre = el('pre', 'fm-pre');
      pre.append(el('code', null, code.join('\n')));
      root.append(pre);
      continue;
    }
    const head = /^(#{1,3})\s+(.+)$/.exec(line);
    if (head) {
      flushPara();
      const hx = el(['h3', 'h4', 'h5'][head[1].length - 1], 'fm-h');
      renderInline(head[2], hx);
      root.append(hx);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ''));
      const bq = el('blockquote', 'fm-quote');
      bq.append(...renderMarkdown(quoted.join('\n')).childNodes);
      root.append(bq);
      continue;
    }
    const ul = /^\s*[-*]\s+/.test(line);
    const ol = /^\s*\d{1,3}[.)]\s+/.test(line);
    if (ul || ol) {
      flushPara();
      const list = el(ul ? 'ul' : 'ol', 'fm-list');
      const re = ul ? /^\s*[-*]\s+/ : /^\s*\d{1,3}[.)]\s+/;
      while (i < lines.length && re.test(lines[i])) {
        const li = el('li');
        renderInline(lines[i++].replace(re, ''), li);
        list.append(li);
      }
      root.append(list);
      continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return root;
}

/** Citation d'un message pour le champ de réponse : « > @Nom#TAG a écrit : » puis le texte cité. */
export function quoteOf(authorFull, body) {
  const quoted = String(body || '').split('\n').slice(0, 20).map((l) => '> ' + l).join('\n');
  return t('> **{v}** a écrit :\n{quoted}', { v: (authorFull ? '@' + authorFull : t('Quelqu’un')), quoted }) + '\n\n';
}
