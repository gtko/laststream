import { CHAT_MAX_CHARS } from './protocol.js';
import { stripInvisible } from './text.js';

/**
 * Filtrage basique du chat : retire les caractères de contrôle et de renversement de texte, remplace les liens,
 * masque une courte liste d'insultes (français et anglais, y compris avec accents ou chiffres). Ce n'est pas une
 * modération exhaustive : l'hôte peut rendre muet ou exclure, et les messages se signalent.
 */

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|xyz|tk|ly|gg|me|tv|cc)\b\S*/gi;

/** Racines masquées (comparées sans accents, en minuscules, chiffres courants remplacés par des lettres). */
const BAD_WORDS = [
  'connard',
  'connasse',
  'salope',
  'salaud',
  'encule',
  'enculer',
  'putain',
  'pute',
  'fdp',
  'ntm',
  'nique',
  'batard',
  'merde',
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'nazi',
];

const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Minuscules, accents retirés (marques combinantes U+0300 à U+036F), chiffres d'argot remplacés par des lettres. */
function fold(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFD').toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x300 && code <= 0x36f) continue;
    out += LEET[ch] ?? ch;
  }
  return out;
}

const BAD_RE = new RegExp(`(?<![a-z])(?:${BAD_WORDS.join('|')})[a-z]*`, 'g');

export type FilterResult = { ok: true; text: string } | { ok: false; reason: 'empty' };

/** Texte nettoyé (500 caractères au plus), ou `empty` s'il ne reste rien. */
export function filterChat(raw: string): FilterResult {
  let text = stripInvisible(raw).replace(/\s+/g, ' ').trim();
  text = text.replace(LINK, '[lien]');
  if (text.length > CHAT_MAX_CHARS) text = text.slice(0, CHAT_MAX_CHARS).trimEnd();
  if (text === '') return { ok: false, reason: 'empty' };
  const masked = text.split(' ').map((word) => {
    const folded = fold(word);
    return folded.replace(BAD_RE, '') === folded ? word : '*'.repeat(Math.min(word.length, 8));
  });
  return { ok: true, text: masked.join(' ') };
}

/** Texte d'un signalement, nettoyé (pas de masquage : l'hôte doit voir ce qui a été dit). */
export function cleanReportText(raw: string): string {
  return stripInvisible(raw).replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_CHARS);
}
