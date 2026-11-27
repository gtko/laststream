import test from 'node:test';
import assert from 'node:assert/strict';
import { segments, attrSegments } from '../scripts/i18n-site.mjs';

const keys = (html) => segments(html).map((s) => s.key);

test('un paragraphe avec balises en ligne est un seul texte, sans la balise qui l’entoure', () => {
  assert.deepEqual(keys('<p>Hello <strong>world</strong>, again.</p><h2><a href="/x">Title here</a></h2>'), ['Hello <strong>world</strong>, again.', 'Title here']);
});

test('liens côte à côte : un texte chacun ; scripts, styles et sélecteur de langue ignorés', () => {
  const html = '<div><a class="btn" href="/a">Download now</a> <a class="btn" href="/b">Open app</a></div>' +
    '<script>var x = "Not this";</script><nav class="lang"><a href="/">FR</a><a href="/en/">EN</a></nav><p>Français</p>';
  assert.deepEqual(keys(html), ['Download now', 'Open app']);
});

test('attributs et meta de partage', () => {
  const html = '<meta name="description" content="Your cinema everywhere"><meta name="theme-color" content="#000"><img alt="A screenshot" src="x.webp"><button aria-label="Close menu"></button>';
  assert.deepEqual(attrSegments(html).map((s) => s.key), ['Your cinema everywhere', 'A screenshot', 'Close menu']);
});
