import { describe, expect, it } from 'vitest';
import { quoteOf, renderMarkdown } from '../src/ui/forumMarkdown.js';

/** Forum (LAST-1651) : le rendu Markdown construit des nœuds DOM, sans jamais interpréter de HTML venu d'un membre. */
const html = (src: string): string => (renderMarkdown(src) as HTMLElement).innerHTML;

describe('forumMarkdown', () => {
  it('n’interprète aucun HTML', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(2)</script>') as HTMLElement;
    expect(out.querySelector('img, script')).toBeNull();
    expect(out.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('liens : http(s) seulement, nouvel onglet sans référent', () => {
    const out = renderMarkdown('[doc](https://laststream.app/guides) et [piège](javascript:alert(1)) https://example.org/a.') as HTMLElement;
    const links = [...out.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://laststream.app/guides', 'https://example.org/a']);
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(out.textContent).toContain('[piège](javascript:alert(1))');
  });

  it('mise en forme en ligne : gras, italique, barré, code, spoiler, mention', () => {
    const out = html('**gras** *ita* ~~non~~ `x<y` ||fin du film|| @Léa#AB12');
    expect(out).toContain('<strong>gras</strong>');
    expect(out).toContain('<em>ita</em>');
    expect(out).toContain('<s>non</s>');
    expect(out).toContain('<code class="fm-code">x&lt;y</code>');
    expect(out).toContain('class="fm-spoiler"');
    expect(out).toContain('<span class="fm-mention">@Léa#AB12</span>');
  });

  it('blocs : titres, citations, listes, code', () => {
    const out = renderMarkdown('## Titre\n> cité\n> suite\n\n- a\n- b\n\n1. un\n\n```\n<b>brut</b>\n```') as HTMLElement;
    expect(out.querySelector('h4')?.textContent).toBe('Titre');
    expect(out.querySelector('blockquote')?.textContent).toContain('cité');
    expect(out.querySelectorAll('ul li')).toHaveLength(2);
    expect(out.querySelectorAll('ol li')).toHaveLength(1);
    expect(out.querySelector('pre code')?.textContent).toBe('<b>brut</b>');
  });

  it('citation pour la réponse', () => {
    expect(quoteOf('Léa#AB12', 'ligne 1\nligne 2')).toBe('> **@Léa#AB12** a écrit :\n> ligne 1\n> ligne 2\n\n');
  });
});
