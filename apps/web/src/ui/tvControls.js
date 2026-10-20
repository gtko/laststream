/* Commandes du lecteur TV (logique pure, sans DOM) : masquage automatique de l'interface, raccourcis, pistes et niveaux
 * proposés, badge DIRECT, contenu du panneau « Infos ». player.js et tvExternal.js fournissent les objets (hls.js, mpv,
 * plugin natif, balise vidéo) ; ce module ne fait que transformer ces objets en options et en libellés. */
import { audioTrackLabel, langName, trackLang } from '../player/tracks';
import { channelNumber } from '../data/tvRank';

/** Délai sans activité au-delà duquel la barre, l'en-tête et le cartouche se masquent. */
export const UI_IDLE_MS = 3000;

/** Identifiant réservé à « Désactivés » (sous-titres) et « Auto » (qualité). */
export const NONE = '-1';

/**
 * Masquage automatique : l'interface reste visible `ms` après la dernière activité, et tant qu'elle est verrouillée
 * (panneau ouvert, pause, échec affiché). Les instants sont passés explicitement (pas d'horloge cachée).
 */
export class IdleUi {
  constructor(ms = UI_IDLE_MS) {
    this.ms = ms;
    this.until = 0;
    this.locked = false;
  }

  /** Activité (souris, toucher, touche) à l'instant `now` (ms). */
  wake(now) {
    this.until = now + this.ms;
    return this;
  }

  lock(on) {
    this.locked = !!on;
    return this;
  }

  visible(now) {
    return this.locked || now < this.until;
  }

  /** Instant (ms) où il faut revérifier, ou null si verrouillée (rien à programmer). */
  deadline() {
    return this.locked ? null : this.until;
  }
}

/**
 * Action d'une touche sur le lecteur, ou null pour les touches laissées à la navigation (flèches gauche et droite, Tab).
 * Échap et Retour arrière donnent « escape » : le lecteur décide de ce qu'il ferme (panneau, infos, plein écran, lecteur).
 */
export function tvKeyAction(key) {
  switch (key) {
    case 'Escape':
    case 'Backspace': return 'escape';
    case 'ArrowUp':
    case 'PageUp':
    case 'ChannelUp': return 'prev';
    case 'ArrowDown':
    case 'PageDown':
    case 'ChannelDown': return 'next';
    case 'i':
    case 'I': return 'info';
    case ' ': return 'toggle';
    case 'm':
    case 'M': return 'mute';
    case 'f':
    case 'F': return 'fullscreen';
    default: return null;
  }
}

/**
 * Badge « DIRECT » : seulement quand l'image avance (lecture réussie) et que la lecture ne fait pas une pause (une pause
 * n'est plus du direct) ; jamais pendant la connexion, le son seul ou un échec.
 */
export function liveBadge(state, paused) {
  return !!state && state.phase === 'live' && !paused;
}

const opt = (id, label, selected) => ({ id: String(id), label: String(label), selected: !!selected });

/** Options de menu à partir de pistes déjà libellées (mpv, plugin natif) ; `offLabel` ajoute l'entrée « Désactivés ». */
export function trackOptions(list, offLabel) {
  const rows = (list || []).map((t) => opt(t.id, t.label, t.selected));
  return offLabel ? [opt(NONE, offLabel, !rows.some((r) => r.selected))].concat(rows) : rows;
}

const langOr = (lang, title, fallback) => {
  const code = trackLang(lang, title);
  return (title || '').trim() || (code ? langName(code) : '') || fallback;
};

/** Pistes audio d'un flux hls.js (`audioTracks`, index courant `audioTrack`). */
export function hlsAudioOptions(h) {
  const list = (h && h.audioTracks) || [];
  return list.map((t, i) => opt(i, audioTrackLabel({ lang: trackLang(t.lang, t.name), title: t.name }), i === h.audioTrack));
}

/** Sous-titres d'un flux hls.js : affichés seulement si `subtitleDisplay` est vrai. */
export function hlsSubtitleOptions(h) {
  const list = (h && h.subtitleTracks) || [];
  if (!list.length) return [];
  const cur = h.subtitleDisplay ? h.subtitleTrack : -1;
  return [opt(NONE, 'Désactivés', cur < 0)].concat(list.map((t, i) => opt(i, langOr(t.lang, t.name, 'Sous-titres'), i === cur)));
}

function levelLabel(l) {
  if (l && l.height) return l.height + 'p';
  if (l && l.bitrate) return Math.round(l.bitrate / 1000) + ' kb/s';
  return 'Niveau';
}

/** Qualités d'un flux hls.js : Auto puis un niveau par hauteur (le plus fort débit gagne). Rien si un seul niveau. */
export function hlsLevelOptions(h) {
  const levels = (h && h.levels) || [];
  if (levels.length < 2) return [];
  const auto = !!h.autoLevelEnabled;
  const order = levels.map((_, i) => i)
    .sort((a, b) => ((levels[b].height || 0) - (levels[a].height || 0)) || ((levels[b].bitrate || 0) - (levels[a].bitrate || 0)));
  const seen = new Set();
  const rows = [];
  order.forEach((i) => {
    const label = levelLabel(levels[i]);
    if (seen.has(label)) return;
    seen.add(label);
    rows.push(opt(i, label, !auto && h.currentLevel === i));
  });
  return [opt(NONE, 'Auto', auto)].concat(rows);
}

/** Pistes d'une balise vidéo (`audioTracks`, Safari) : liste indexée, `enabled` pour la piste active. */
export function htmlAudioList(list) {
  return Array.from(list || []);
}
export function htmlAudioOptions(list) {
  return htmlAudioList(list).map((t, i) => opt(i, audioTrackLabel({ lang: trackLang(t.language, t.label), title: t.label }), t.enabled));
}

/** Sous-titres d'une balise vidéo (`textTracks`) : seulement les pistes de sous-titres ou de légendes. */
export function htmlTextList(list) {
  return Array.from(list || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
}
export function htmlTextOptions(list) {
  const tracks = htmlTextList(list);
  if (!tracks.length) return [];
  const cur = tracks.findIndex((t) => t.mode === 'showing');
  return [opt(NONE, 'Désactivés', cur < 0)].concat(tracks.map((t, i) => opt(i, langOr(t.language, t.label, 'Sous-titres'), i === cur)));
}

/** Libellé d'un codec vidéo (chaîne hls.js « avc1.64001f » ou nom mpv « h264 »). */
export function videoCodecLabel(s) {
  const c = String(s || '').toLowerCase();
  if (!c) return '';
  if (/^(avc|h264)/.test(c)) return 'H.264';
  if (/^(hvc|hev|h265|hevc)/.test(c)) return 'HEVC';
  if (/^av0?1/.test(c)) return 'AV1';
  if (/^vp0?9/.test(c)) return 'VP9';
  if (/^vp0?8/.test(c)) return 'VP8';
  if (/mpeg2|mp2v/.test(c)) return 'MPEG-2';
  return c.toUpperCase();
}

/** Libellé d'un codec audio (« mp4a.40.2 », « ac-3 », « opus »…). */
export function audioCodecLabel(s) {
  const c = String(s || '').toLowerCase();
  if (!c) return '';
  if (/^mp4a\.6[9b]/.test(c) || c === 'mp3' || c === 'mp3float') return 'MP3';
  if (/^(mp4a|aac)/.test(c)) return 'AAC';
  if (/^ac-?3$/.test(c)) return 'AC-3';
  if (/^(ec-?3|eac3)/.test(c)) return 'E-AC-3';
  if (/opus/.test(c)) return 'Opus';
  if (/flac/.test(c)) return 'FLAC';
  if (/dts/.test(c)) return 'DTS';
  return c.toUpperCase();
}

/** Infos techniques d'un flux hls.js : niveau en cours (ou le seul connu), codecs annoncés par le manifeste. */
export function hlsTech(h) {
  const lv = (h && h.levels) || [];
  const cur = h && h.currentLevel >= 0 ? lv[h.currentLevel] : null;
  if (!cur) return {};
  const parts = String(cur.codecs || '').split(',').map((s) => s.trim());
  return {
    width: cur.width,
    height: cur.height,
    bitrate: cur.bitrate,
    videoCodec: cur.videoCodec || parts.find((p) => /^(avc|hvc|hev|av01|vp0?9)/i.test(p)) || '',
    audioCodec: cur.audioCodec || parts.find((p) => /^(mp4a|ac-?3|ec-?3|opus|flac|mp3)/i.test(p)) || '',
  };
}

/** Infos techniques d'après la liste de pistes mpv (`demux-w`, `demux-h`, `codec` de la piste vidéo et de l'audio choisi). */
export function techFromTracks(list) {
  const all = Array.isArray(list) ? list : [];
  const v = all.find((t) => t && t.type === 'video' && t.selected) || all.find((t) => t && t.type === 'video');
  const a = all.find((t) => t && t.type === 'audio' && t.selected);
  return {
    width: v ? v['demux-w'] : undefined,
    height: v ? v['demux-h'] : undefined,
    videoCodec: v ? v.codec || '' : '',
    audioCodec: a ? a.codec || '' : '',
  };
}

/** Fournisseur de la chaîne, tel qu'affiché dans le panneau « Infos ». */
function sourceLabel(c) {
  if (!c || !c.source) return '';
  return c.source === 'user' ? 'Ma playlist' : String(c.source);
}

/**
 * Contenu du panneau « Infos » : chaîne, programme en cours (progression, résumé si le guide en a un), 4 programmes
 * suivants au plus, infos techniques connues seulement (la source est toujours indiquée).
 */
export function infoModel(c, programs, now, tech) {
  const list = (programs || []).slice().sort((a, b) => a.start - b.start);
  const cur = list.find((p) => p.start <= now && now < p.stop) || null;
  const from = cur ? cur.stop : now;
  const next = list.filter((p) => p !== cur && p.start >= from).slice(0, 4)
    .map((p) => ({ title: p.title || '', start: p.start, stop: p.stop }));
  const dur = cur ? cur.stop - cur.start : 0;
  const pct = dur > 0 ? Math.max(0, Math.min(100, Math.round(((now - cur.start) / dur) * 100))) : 0;
  const t = tech || {};
  const rows = [];
  if (t.width && t.height) rows.push(['Résolution', t.width + ' × ' + t.height]);
  if (t.videoCodec) rows.push(['Vidéo', videoCodecLabel(t.videoCodec)]);
  if (t.audioCodec) rows.push(['Audio', audioCodecLabel(t.audioCodec)]);
  if (t.bitrate) rows.push(['Débit', Math.round(t.bitrate / 1000) + ' kb/s']);
  if (sourceLabel(c)) rows.push(['Source', sourceLabel(c)]);
  return {
    name: c.name || '',
    logo: c.logo || '',
    number: String(channelNumber(c) || ''),
    now: cur ? {
      title: cur.title || '', start: cur.start, stop: cur.stop, desc: cur.desc || '', pct,
      left: Math.max(0, Math.ceil((cur.stop - now) / 60)),
    } : null,
    next,
    tech: rows,
  };
}

// ---------- Panneau « Audio et sous-titres » : libellés lisibles ----------

const FLAG_RULES = [
  [/\b(ad|audio ?desc\w*|audiodesc\w*|malvoy\w*|descriptive)\b/, 'AD'],
  [/\b(sme|sdh|hearing|sourds?|malentendants?|cc)\b/, 'SME'],
  [/\b(forces?|forced)\b/, 'Forcés'],
  [/\b(vo|vost|vostfr|original)\b/, 'VO'],
];
const VARIANT = /\b(vff|vfq|vfi|vf)\b/i;

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Ligne d'un panneau de pistes : libellé de langue lisible (« Français », « Anglais (AD) »), détail secondaire (variante
 * VFF/VFQ, codec) et état. Les options « Désactivés » et « Auto » gardent leur texte.
 */
export function trackRow(o, kind) {
  if (o.id === NONE) return { id: o.id, selected: o.selected, text: o.label, detail: '', special: true };
  const [head, ...rest] = String(o.label || '').split(' · ');
  const low = plain(head);
  const code = trackLang('', head);
  const flags = FLAG_RULES.filter(([re]) => re.test(low)).map(([, f]) => f);
  const variant = (VARIANT.exec(head) || [''])[0].toUpperCase();
  const tech = rest.join(' · ');
  if (!code) {
    const raw = head.trim();
    return { id: o.id, selected: o.selected, text: raw || (kind === 'sub' ? 'Sous-titres' : 'Piste audio'), detail: tech, special: false };
  }
  const flagTxt = flags.length ? ' (' + flags.join(', ') + ')' : '';
  return { id: o.id, selected: o.selected, text: langName(code) + flagTxt, detail: [variant, tech].filter(Boolean).join(' · '), special: false };
}

/** Lignes d'une colonne : les doublons (deux « Français » sans autre indice) sont numérotés. */
function trackRows(list, kind) {
  const rows = (list || []).map((o) => trackRow(o, kind));
  const seen = new Map();
  rows.forEach((r) => {
    if (r.special) return;
    const n = (seen.get(r.text) || 0) + 1;
    seen.set(r.text, n);
    if (n > 1) r.text += ' ' + n;
  });
  return rows;
}

/** Détail d'un niveau de qualité (« Full HD », « HD »…) d'après sa hauteur. */
function qualityDetail(label) {
  const m = /^(\d{3,4})p$/.exec(String(label));
  const h = m ? Number(m[1]) : 0;
  if (!h) return label === 'Auto' ? 'Selon la connexion' : '';
  if (h >= 2000) return 'Ultra HD 4K';
  if (h >= 1000) return 'Full HD';
  if (h >= 700) return 'HD';
  return 'Qualité standard';
}

/**
 * Contenu du panneau « Audio et sous-titres » : deux colonnes (audio, sous-titres) et, si plusieurs niveaux existent,
 * une ligne « Qualité » séparée. Les sous-titres commencent par « Désactivés ».
 */
export function tracksModel(audio, subs, levels) {
  return {
    audio: trackRows(audio, 'audio'),
    subs: trackRows(subs, 'sub'),
    quality: (levels || []).length > 1 ? trackRows(levels, 'quality').map((r) => ({ ...r, detail: qualityDetail(r.text) })) : [],
  };
}
