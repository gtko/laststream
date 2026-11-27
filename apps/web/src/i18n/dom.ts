/* Traduction des textes figés de index.html (lecteur TV, fenêtre modale…), une fois au démarrage (src/boot.ts) :
 * nœuds de texte et attributs dont la valeur est une clé du catalogue. Les textes produits par le code passent par t(). */
import { getLocale, SOURCE_LOCALE, t } from './index';

const ATTRS = ['aria-label', 'data-tip', 'title', 'placeholder', 'alt'];

export function translateStatic(root: ParentNode = document): void {
  if (getLocale() === SOURCE_LOCALE || typeof document === 'undefined') return;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue || '';
    const key = raw.trim().replace(/\s+/g, ' ');
    if (!key || n.parentElement?.closest('script,style,svg')) continue;
    const v = t(key);
    if (v !== key) n.nodeValue = raw.replace(raw.trim(), v);
  }
  (root as Element | Document).querySelectorAll('*').forEach((el) => {
    for (const a of ATTRS) {
      const key = el.getAttribute(a);
      if (key) { const v = t(key); if (v !== key) el.setAttribute(a, v); }
    }
  });
  const desc = document.querySelector('meta[name="description"]');
  const d = desc?.getAttribute('content');
  if (desc && d) desc.setAttribute('content', t(d));
}
