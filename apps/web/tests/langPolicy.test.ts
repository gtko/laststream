import { describe, expect, it } from 'vitest';
import { DEFAULT_LANG_PREFS, type LangPrefs } from '../src/data/langPrefs';
import { autoSubsToast, langCode, learnNotice, pickTracks, secondaryFor, SECONDARY_EMPTY_MSG, SECONDARY_LOAD_FAIL_MSG, SECONDARY_OFF_MSG, SECONDARY_UNSUPPORTED_MSG } from '../src/player/langPolicy';
import { trackLang, type AudioTrack, type SubtitleTrack } from '../src/player/tracks';

const a = (id: string, lang: string, over: Partial<AudioTrack> = {}): AudioTrack => ({
  id, lang: trackLang(lang, over.title), title: '', codec: 'eac3', channels: 6, selected: false, label: id, ...over,
});
const s = (id: string, lang: string, over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  id, lang: trackLang(lang, over.title), title: '', codec: 'subrip', forced: false, origin: 'embedded', renderable: true, selected: false, label: id, ...over,
});
const prefs = (over: Partial<LangPrefs> = {}): LangPrefs => ({ ...DEFAULT_LANG_PREFS, ...over });

describe('codes de langue', () => {
  it('normalise fr / fre / fra / french / VF / VFF / VFQ / VOSTFR', () => {
    for (const raw of ['fr', 'fre', 'fra', 'french', 'French', 'fr-FR', 'VF', 'VFF', 'VFQ', 'VFI', 'TrueFrench', 'FR_CA']) expect(langCode(raw)).toBe('fr');
  });
  it('anglais, japonais et inconnus', () => {
    expect(['en', 'eng', 'English', 'en-US'].map((x) => langCode(x))).toEqual(['en', 'en', 'en', 'en']);
    expect(['ja', 'jpn', 'jp', 'Japanese'].map((x) => langCode(x))).toEqual(['ja', 'ja', 'ja', 'ja']);
    for (const raw of ['und', 'UND', 'unknown', 'mul', 'zxx', '', null, undefined]) expect(langCode(raw)).toBe('');
    expect(langCode('', 'Français VFF 5.1')).toBe('fr');
    expect(langCode('und', 'English SDH')).toBe('en');
  });
});

describe('pickTracks : audio dans la langue principale', () => {
  const audio = [a('a1', 'jpn', { selected: true }), a('a2', 'fre', { title: 'VFF' })];
  const subs = [s('s1', 'fre'), s('s2', 'fre', { forced: true }), s('s3', 'eng')];

  it('VF présente : audio français, pas de sous-titres complets, seulement les forcés', () => {
    const r = pickTracks(audio, subs, prefs());
    expect(r).toMatchObject({ audioId: 'a2', subId: 's2', secondarySubId: null, audioLang: 'fr' });
  });

  it('VF présente sans piste forcée : aucun sous-titre', () => {
    const r = pickTracks(audio, [s('s1', 'fre'), s('s3', 'eng')], prefs());
    expect(r).toMatchObject({ audioId: 'a2', subId: null, secondarySubId: null });
  });

  it('forcés repérés par le titre quand le drapeau manque', () => {
    const r = pickTracks(audio, [s('s1', 'fre'), s('s2', 'fre', { title: 'Forcés' })], prefs());
    expect(r.subId).toBe('s2');
  });

  it('plusieurs VF : la plus riche en canaux, sans commentaire', () => {
    const r = pickTracks([a('c', 'fre', { title: 'Commentaire du réalisateur', channels: 8 }), a('x', 'fre', { channels: 2 }), a('y', 'fre', { channels: 6 })], [], prefs());
    expect(r.audioId).toBe('y');
  });

  it('mode « Toujours » : sous-titres complets même en VF', () => {
    const r = pickTracks(audio, subs, prefs(), { alwaysSubs: true });
    expect(r.subId).toBe('s1');
  });
});

describe('pickTracks : version originale et sous-titres', () => {
  it('VO japonaise + sous-titres français internes', () => {
    const r = pickTracks([a('a1', 'jpn', { selected: true })], [s('s1', 'fre'), s('s2', 'eng')], prefs());
    expect(r).toMatchObject({ audioId: 'a1', subId: 's1', secondarySubId: null, audioLang: 'ja', subLang: 'fr' });
  });

  it('VO : la langue d’origine connue prime sur l’ordre des pistes', () => {
    const r = pickTracks([a('a1', 'eng'), a('a2', 'jpn')], [s('s1', 'fre')], prefs(), { originalLang: 'ja' });
    expect(r.audioId).toBe('a2');
  });

  it('VO sans langue d’origine connue : première piste hors langue principale', () => {
    const r = pickTracks([a('a1', 'ita'), a('a2', 'eng')], [s('s1', 'fre')], prefs());
    expect(r.audioId).toBe('a1');
  });

  it('VO repérée par son titre', () => {
    const r = pickTracks([a('a1', 'und', { title: 'Piste 1' }), a('a2', 'eng', { title: 'VO' })], [], prefs({ audio: 'fr' }));
    expect(r.audioId).toBe('a2');
  });

  it('audio secondaire explicite (anglais)', () => {
    const r = pickTracks([a('a1', 'jpn'), a('a2', 'eng')], [s('s1', 'fre')], prefs({ audio2: 'en' }));
    expect(r.audioId).toBe('a2');
  });

  it('audio secondaire « aucune » : meilleure disponible (piste par défaut du fichier)', () => {
    const r = pickTracks([a('a1', 'jpn'), a('a2', 'eng', { selected: true })], [s('s1', 'fre')], prefs({ audio2: 'none' }));
    expect(r).toMatchObject({ audioId: 'a2', subId: 's1' });
  });

  it('aucune piste dans les langues voulues : la meilleure disponible, avec sous-titres', () => {
    const r = pickTracks([a('a1', 'kor')], [s('s1', 'fre')], prefs({ audio2: 'en' }));
    expect(r).toMatchObject({ audioId: 'a1', subId: 's1', audioLang: 'ko' });
  });

  it('audio sans langue annoncée : pas considéré comme la langue principale, sous-titres activés', () => {
    const r = pickTracks([a('a1', 'und')], [s('s1', 'fre')], prefs());
    expect(r).toMatchObject({ audioId: 'a1', audioLang: '', subId: 's1' });
  });

  it('audio sans langue mais source annoncée française : forcés seulement', () => {
    const r = pickTracks([a('a1', 'und')], [s('s1', 'fre'), s('s2', 'fre', { forced: true })], prefs(), { unknownAudioLang: 'fr' });
    expect(r).toMatchObject({ audioLang: 'fr', subId: 's2' });
  });

  it('sous-titres désactivés : aucun, même en VO', () => {
    const r = pickTracks([a('a1', 'jpn')], [s('s1', 'fre')], prefs({ subsOn: false }));
    expect(r.subId).toBeNull();
  });

  it('langue des sous-titres distincte de la langue principale', () => {
    const r = pickTracks([a('a1', 'jpn')], [s('s1', 'fre'), s('s2', 'eng')], prefs({ subs: 'en' }));
    expect(r.subId).toBe('s2');
  });

  it('aucun sous-titre français : aucun sous-titre, sans erreur', () => {
    const r = pickTracks([a('a1', 'jpn')], [s('s2', 'eng'), s('s3', 'spa')], prefs());
    expect(r).toMatchObject({ audioId: 'a1', subId: null, secondarySubId: null });
  });

  it('aucune piste du tout', () => {
    expect(pickTracks([], [], prefs())).toMatchObject({ audioId: null, subId: null, secondarySubId: null });
  });
});

describe('pickTracks : choix entre pistes de sous-titres', () => {
  const jp = [a('a1', 'jpn')];

  it('« Full » avant « Forced »', () => {
    const r = pickTracks(jp, [s('f', 'fre', { forced: true }), s('full', 'fre', { title: 'Full' })], prefs());
    expect(r.subId).toBe('full');
  });

  it('une piste complète sans titre passe devant une piste forcée', () => {
    expect(pickTracks(jp, [s('f', 'fre', { title: 'Forced' }), s('x', 'fre')], prefs()).subId).toBe('x');
  });

  it('forcés seuls : repli en dernier recours', () => {
    expect(pickTracks(jp, [s('f', 'fre', { forced: true })], prefs()).subId).toBe('f');
  });

  it('SDH évité quand une piste normale existe', () => {
    const r = pickTracks(jp, [s('sdh', 'fre', { title: 'French SDH' }), s('n', 'fre')], prefs());
    expect(r.subId).toBe('n');
  });

  it('SDH seul : choisi faute de mieux', () => {
    expect(pickTracks(jp, [s('sdh', 'fre', { title: 'Français (SDH)' }), s('en', 'eng')], prefs()).subId).toBe('sdh');
  });

  it('pistes internes avant les sous-titres externes', () => {
    const ext = s('e1', 'fre', { origin: 'external', url: 'http://x/a.srt' });
    expect(pickTracks(jp, [ext, s('i1', 'fre')], prefs()).subId).toBe('i1');
  });

  it('sous-titres externes déjà chargés quand le fichier n’en a pas', () => {
    const ext = s('e1', 'fre', { origin: 'external', url: 'http://x/a.srt' });
    expect(pickTracks(jp, [s('en', 'eng'), ext], prefs()).subId).toBe('e1');
  });

  it('externe complet avant interne SDH', () => {
    const ext = s('e1', 'fre', { origin: 'external', url: 'http://x/a.srt' });
    expect(pickTracks(jp, [s('i', 'fre', { title: 'SDH' }), ext], prefs()).subId).toBe('e1');
  });

  it('les pistes image non rendues sont écartées', () => {
    expect(pickTracks(jp, [s('pgs', 'fre', { renderable: false, codec: 'hdmv_pgs_subtitle' })], prefs()).subId).toBeNull();
  });

  it('sous-titres identifiés par le titre quand la balise manque', () => {
    expect(pickTracks(jp, [s('t', 'und', { title: 'Français' })], prefs()).subId).toBe('t');
  });
});

describe('pickTracks : mode apprentissage', () => {
  const learn = prefs({ learn: true, learnLang: 'en' });
  const audio = [a('fr', 'fre'), a('en', 'eng'), a('ja', 'jpn')];
  const subs = [s('sfr', 'fre'), s('sen', 'eng'), s('sfrf', 'fre', { forced: true })];

  it('anglais : audio anglais, sous-titre anglais + sous-titre français en second', () => {
    expect(pickTracks(audio, subs, learn)).toMatchObject({ audioId: 'en', subId: 'sen', secondarySubId: 'sfr', audioLang: 'en', subLang: 'en', secondaryLang: 'fr' });
  });

  it('langue apprise absente : audio secondaire (VO), sous-titres appris + français', () => {
    const r = pickTracks([a('fr', 'fre'), a('ja', 'jpn')], subs, learn, { originalLang: 'ja' });
    expect(r).toMatchObject({ audioId: 'ja', subId: 'sen', secondarySubId: 'sfr' });
  });

  it('ni apprise ni secondaire : audio principale', () => {
    const r = pickTracks([a('fr', 'fre')], subs, learn, { originalLang: 'en' });
    expect(r.audioId).toBe('fr');
  });

  it('sous-titres appris absents : le français seul', () => {
    const r = pickTracks(audio, [s('sfr', 'fre')], learn);
    expect(r).toMatchObject({ subId: 'sfr', secondarySubId: null });
  });

  it('le moteur ne gère pas le second sous-titre embarqué : le français externe est retenu', () => {
    const ext = s('efr', 'fre', { origin: 'external', url: 'http://x/fr.srt' });
    const r = pickTracks(audio, [s('sen', 'eng'), s('sfr', 'fre'), ext], learn, { canSecondary: (t) => t.origin === 'external' });
    expect(r).toMatchObject({ subId: 'sen', secondarySubId: 'efr' });
  });

  it('second sous-titre impossible : le sous-titre appris reste seul', () => {
    const r = pickTracks(audio, subs, learn, { canSecondary: () => false });
    expect(r).toMatchObject({ subId: 'sen', secondarySubId: null });
  });

  it('langue apprise = langue principale : comportement normal', () => {
    const r = pickTracks(audio, subs, prefs({ learn: true, learnLang: 'fr' }));
    expect(r).toMatchObject({ audioId: 'fr', secondarySubId: null });
  });

  it('apprentissage du japonais avec sous-titres japonais et français', () => {
    const r = pickTracks(audio, [s('sja', 'jpn'), s('sfr', 'fre')], prefs({ learn: true, learnLang: 'ja' }));
    expect(r).toMatchObject({ audioId: 'ja', subId: 'sja', secondarySubId: 'sfr' });
  });

  it('absence d’audio dans la langue apprise : learnAudioMissing, faux si elle existe', () => {
    expect(pickTracks([a('fr', 'fre'), a('ja', 'jpn')], subs, learn)).toMatchObject({ learnAudioMissing: true, audioId: 'ja' });
    expect(pickTracks(audio, subs, learn).learnAudioMissing).toBe(false);
  });

  it('absence de sous-titres dans la langue apprise : learnSubMissing, faux si elle existe', () => {
    expect(pickTracks(audio, [s('sfr', 'fre')], learn)).toMatchObject({ learnSubMissing: true, subId: 'sfr' });
    expect(pickTracks(audio, subs, learn).learnSubMissing).toBe(false);
  });

  it('second sous-titre refusé par le moteur : secondaryBlocked, faux sans refus', () => {
    expect(pickTracks(audio, subs, learn, { canSecondary: () => false })).toMatchObject({ subId: 'sen', secondarySubId: null, secondaryBlocked: true });
    expect(pickTracks(audio, subs, learn).secondaryBlocked).toBe(false);
  });

  it('« Jamais » en apprentissage : aucun sous-titre, l’audio reste dans la langue apprise', () => {
    expect(pickTracks(audio, subs, prefs({ learn: true, learnLang: 'en', subsOn: false }))).toMatchObject({ audioId: 'en', audioLang: 'en', subId: null, secondarySubId: null });
  });

  it('sous-titre mémorisé en langue principale : pas de second sous-titre', () => {
    expect(pickTracks(audio, subs, learn, { rememberedSub: 'fr' })).toMatchObject({ subId: 'sfr', secondarySubId: null, secondaryBlocked: false });
  });
});

describe('secondaryFor : choix manuel du sous-titre principal', () => {
  const learn = prefs({ learn: true, learnLang: 'en' });
  const subs = [s('sfr', 'fre'), s('sen', 'eng')];

  it('« off » : aucun second sous-titre', () => {
    expect(secondaryFor(subs, learn, null)).toBeNull();
  });
  it('langue principale choisie : pas de doublon', () => {
    expect(secondaryFor(subs, learn, 'sfr')).toBeNull();
  });
  it('choix normal en apprentissage : second en langue principale', () => {
    expect(secondaryFor(subs, learn, 'sen')).toBe('sfr');
  });
  it('hors apprentissage, ou second refusé par le moteur : aucun', () => {
    expect(secondaryFor(subs, prefs(), 'sen')).toBeNull();
    expect(secondaryFor(subs, learn, 'sen', () => false)).toBeNull();
  });
});

describe('learnNotice : message du mode apprentissage', () => {
  const ja = prefs({ learn: true, learnLang: 'ja' });
  const jaSub = s('sja', 'jpn');
  const frSub = s('sfr', 'fre');

  it('audio appris absent : repli nommé', () => {
    expect(learnNotice(pickTracks([a('fr', 'fre'), a('en', 'eng')], [jaSub, frSub], ja), ja)).toBe('Pas d\'audio japonais : audio anglais');
  });
  it('sous-titres appris absents : langue principale seule', () => {
    expect(learnNotice(pickTracks([a('ja', 'jpn')], [frSub], ja), ja)).toBe('Pas de sous-titres japonais : français seuls');
  });
  it('sous-titres appris absents et aucun sous-titre en langue principale : pas de « seuls » inventé', () => {
    expect(learnNotice(pickTracks([a('ja', 'jpn')], [], ja), ja)).toBe('Pas de sous-titres japonais');
  });
  it('sous-titres appris absents, sous-titre mémorisé dans une autre langue : cette langue-là est nommée', () => {
    const r = pickTracks([a('ja', 'jpn')], [frSub, s('sen', 'eng')], ja, { rememberedSub: 'en' });
    expect(r.subLang).toBe('en');
    expect(learnNotice(r, ja)).toBe('Pas de sous-titres japonais : anglais seuls');
  });
  it('moteur natif : un seul sous-titre', () => {
    const r = pickTracks([a('ja', 'jpn')], [jaSub, frSub], ja, { canSecondary: () => false });
    expect(learnNotice(r, ja, { engineKind: 'native' })).toBe('Un seul sous-titre sur ce lecteur : japonais seuls');
  });
  it('HTML5 / HLS avec sous-titres intégrés : second indisponible', () => {
    const r = pickTracks([a('ja', 'jpn')], [jaSub, frSub], ja, { canSecondary: () => false });
    expect(learnNotice(r, ja, { engineKind: 'html5' })).toBe('Second sous-titre indisponible (sous-titres intégrés)');
  });
  it('langue audio non modifiable avec cette source', () => {
    expect(learnNotice(pickTracks([a('ja', 'jpn')], [jaSub], ja), ja, { audioUnknown: true })).toBe('Langue audio non modifiable avec cette source');
  });
  it('plusieurs fragments joints dans un seul message', () => {
    expect(learnNotice(pickTracks([a('fr', 'fre'), a('en', 'eng')], [frSub], ja), ja)).toBe('Pas d\'audio japonais : audio anglais · Pas de sous-titres japonais : français seuls');
  });
  it('« Jamais » : aucun message sur les sous-titres', () => {
    expect(learnNotice(pickTracks([a('fr', 'fre'), a('en', 'eng')], [frSub], ja), ja, { subsOff: true })).toBe('Pas d\'audio japonais : audio anglais');
  });
  it('rien à dire : chaîne vide', () => {
    expect(learnNotice(pickTracks([a('ja', 'jpn')], [jaSub, frSub], ja), ja)).toBe('');
  });
});

describe('messages du second sous-titre', () => {
  it('textes exacts affichés par session.js', () => {
    expect([SECONDARY_OFF_MSG, SECONDARY_UNSUPPORTED_MSG, SECONDARY_EMPTY_MSG, SECONDARY_LOAD_FAIL_MSG]).toEqual([
      'Second sous-titre retiré',
      'Second sous-titre non pris en charge ici',
      'Second sous-titre vide ou illisible',
      'Impossible de charger le second sous-titre',
    ]);
  });
});

describe('message au démarrage', () => {
  it('« Sous-titres français activés (audio : japonais) »', () => {
    const r = pickTracks([a('a1', 'jpn')], [s('s1', 'fre')], prefs());
    expect(autoSubsToast(r)).toBe('Sous-titres français activés (audio : japonais)');
  });
  it('double sous-titres', () => {
    const r = pickTracks([a('en', 'eng')], [s('sen', 'eng'), s('sfr', 'fre')], prefs({ learn: true }));
    expect(autoSubsToast(r)).toBe('Sous-titres anglais et français activés (audio : anglais)');
  });
  it('rien quand aucun sous-titre', () => {
    expect(autoSubsToast(pickTracks([a('a1', 'fre')], [], prefs()))).toBe('');
  });
});

describe('pickTracks : mémoire du titre', () => {
  const audio = [a('fr', 'fre'), a('ja', 'jpn')];
  const subs = [s('sfr', 'fre'), s('sen', 'eng')];

  it('audio mémorisé (choix manuel antérieur) : prime sur la langue principale, sous-titres de la langue principale', () => {
    expect(pickTracks(audio, subs, prefs(), { rememberedAudio: 'ja' })).toMatchObject({ audioId: 'ja', subId: 'sfr' });
  });
  it('audio mémorisé absent du fichier : préférences du profil', () => {
    expect(pickTracks(audio, subs, prefs(), { rememberedAudio: 'ko' }).audioId).toBe('fr');
  });
  it('sous-titres mémorisés « off » : aucun ; hors apprentissage, une langue mémorisée reste seule', () => {
    expect(pickTracks(audio, subs, prefs({ learn: true }), { rememberedSub: 'off' })).toMatchObject({ subId: null, secondarySubId: null });
    expect(pickTracks(audio, subs, prefs(), { rememberedSub: 'en' })).toMatchObject({ subId: 'sen', secondarySubId: null });
  });
  it('sous-titre mémorisé en apprentissage : il remplace le premier, le second en langue principale reste calculé', () => {
    expect(pickTracks(audio, subs, prefs({ learn: true }), { rememberedSub: 'en' })).toMatchObject({ subId: 'sen', secondarySubId: 'sfr' });
  });
  it('langues annoncées sur trois lettres par le lecteur natif', () => {
    const r = pickTracks([a('x', 'eng')], [s('y', 'fra')], prefs({ audio: 'en' }));
    expect(r).toMatchObject({ audioId: 'x', subId: null });
  });
});
