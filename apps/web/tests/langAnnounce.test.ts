import { describe, expect, it } from 'vitest';
import { DEFAULT_LANG_PREFS, type LangPrefs } from '../src/data/langPrefs';
import { learnAnnouncement, manualSubPlan, secondaryFailureMsg } from '../src/player/langAnnounce';
import { pickTracks, SECONDARY_EMPTY_MSG, SECONDARY_LOAD_FAIL_MSG, SECONDARY_OFF_MSG, SECONDARY_UNSUPPORTED_MSG } from '../src/player/langPolicy';
import { trackLang, type AudioTrack, type SubtitleTrack } from '../src/player/tracks';

const a = (id: string, lang: string): AudioTrack => ({ id, lang: trackLang(lang), title: '', codec: 'eac3', channels: 6, selected: false, label: id });
const s = (id: string, lang: string, over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  id, lang: trackLang(lang), title: '', codec: 'subrip', forced: false, origin: 'embedded', renderable: true, selected: false, label: id, ...over,
});
const learn = (over: Partial<LangPrefs> = {}): LangPrefs => ({ ...DEFAULT_LANG_PREFS, audio: 'fr', learn: true, learnLang: 'ja', ...over });
const ok = { audioUnknown: false, subsOff: false, extSettled: true };

describe('annonce du mode apprentissage', () => {
  const audio = [a('a1', 'eng'), a('a2', 'fre')]; // pas de japonais
  const subs = [s('s1', 'fre')]; // pas de sous-titres japonais

  it('attend les sous-titres externes avant de dire « pas de sous-titres »', () => {
    const pick = pickTracks(audio, subs, learn());
    expect(learnAnnouncement(pick, learn(), { ...ok, extSettled: false })).toEqual({ wait: true, msg: '', offerTranscode: false });
    const r = learnAnnouncement(pick, learn(), ok);
    expect(r.wait).toBe(false);
    expect(r.msg).toContain("Pas d'audio japonais");
    expect(r.msg).toContain('Pas de sous-titres japonais');
  });

  it('sous-titres désactivés (Jamais) : seule la langue audio est annoncée', () => {
    const p = learn({ subsOn: false });
    const r = learnAnnouncement(pickTracks(audio, subs, p), p, { ...ok, subsOff: true });
    expect(r.msg).toContain("Pas d'audio japonais");
    expect(r.msg).not.toContain('sous-titres');
  });

  it('langue apprise présente : rien à dire', () => {
    const r = learnAnnouncement(pickTracks([a('a1', 'jpn')], [s('s1', 'jpn'), s('s2', 'fre')], learn()), learn(), ok);
    expect(r).toEqual({ wait: false, msg: '', offerTranscode: false });
  });

  it('hors mode apprentissage : rien, même sans attendre', () => {
    const p = learn({ learn: false });
    expect(learnAnnouncement(pickTracks(audio, subs, p), p, { ...ok, extSettled: false })).toEqual({ wait: false, msg: '', offerTranscode: false });
  });

  it('audio non modifiable (aucune piste annoncée) : ne prétend pas que la langue manque', () => {
    const r = learnAnnouncement(pickTracks([], [], learn()), learn(), { ...ok, audioUnknown: true });
    expect(r.msg).toContain('Langue audio non modifiable avec cette source');
    expect(r.msg).not.toContain("Pas d'audio");
  });

  describe('langue audio non modifiable : la sonde du serveur tranche', () => {
    const none = pickTracks([], [s('s1', 'jpn')], learn());
    const run = (extra: Partial<Parameters<typeof learnAnnouncement>[2]>) => learnAnnouncement(none, learn(), { ...ok, audioUnknown: true, ...extra });

    it('sans sonde : message et bouton Transcodage', () => {
      expect(run({})).toMatchObject({ offerTranscode: true, msg: expect.stringContaining('Langue audio non modifiable') });
    });
    it('sans sonde mais lecture directe déjà annoncée : pas de doublon', () => {
      expect(run({ directNotified: true })).toEqual({ wait: false, msg: '', offerTranscode: false });
    });
    it('la piste par défaut est déjà dans la langue apprise : rien', () => {
      expect(run({ probeAudio: [a('a0', 'jpn'), a('a1', 'fre')] })).toEqual({ wait: false, msg: '', offerTranscode: false });
    });
    it('une seule piste audio, dans la langue apprise : rien', () => {
      expect(run({ probeAudio: [a('a0', 'jpn')] }).msg).toBe('');
    });
    it("langue apprise absente de toutes les pistes : « Pas d'audio », sans bouton", () => {
      const r = run({ probeAudio: [a('a0', 'fre'), a('a1', 'eng')] });
      expect(r.msg).toContain("Pas d'audio japonais : audio français");
      expect(r.msg).not.toContain('non modifiable');
      expect(r.offerTranscode).toBe(false);
    });
    it('piste sans étiquette de langue : « non modifiable » et bouton, pas « Pas d’audio »', () => {
      const r = run({ probeAudio: [a('a0', '')] });
      expect(r.msg).toContain('non modifiable');
      expect(r.msg).not.toContain('Pas d');
      expect(r.offerTranscode).toBe(true);
    });
    it('langue apprise sur une piste non par défaut : message et bouton', () => {
      const r = run({ probeAudio: [a('a0', 'fre'), a('a1', 'jpn')], directNotified: true });
      expect(r.msg).toContain('Langue audio non modifiable');
      expect(r.offerTranscode).toBe(true);
    });
  });

  it('second sous-titre refusé par le moteur : message natif ou intégré', () => {
    const subs2 = [s('s1', 'jpn'), s('s2', 'fre')];
    const pick = pickTracks([a('a1', 'jpn')], subs2, learn(), { canSecondary: () => false });
    expect(pick.secondaryBlocked).toBe(true);
    expect(learnAnnouncement(pick, learn(), { ...ok, engineKind: 'native' }).msg).toContain('Un seul sous-titre sur ce lecteur');
    expect(learnAnnouncement(pick, learn(), { ...ok, engineKind: 'html' }).msg).toContain('Second sous-titre indisponible');
  });
});

describe('choix manuel du sous-titre en mode apprentissage', () => {
  const subs = [s('ja', 'jpn'), s('fr', 'fre'), s('en', 'eng')];

  it('langue apprise choisie : le second (langue principale) est conservé', () => {
    expect(manualSubPlan(subs, learn(), 'ja', undefined, true)).toEqual({ secondaryId: 'fr', toast: '' });
  });

  it('autre langue choisie (anglais) : le second reste la langue principale', () => {
    expect(manualSubPlan(subs, learn(), 'en', undefined, true).secondaryId).toBe('fr');
  });

  it('langue principale choisie : pas de second, message', () => {
    expect(manualSubPlan(subs, learn(), 'fr', undefined, true)).toEqual({ secondaryId: null, toast: SECONDARY_OFF_MSG });
  });

  it('« off » : pas de second, message', () => {
    expect(manualSubPlan(subs, learn(), null, undefined, true)).toEqual({ secondaryId: null, toast: SECONDARY_OFF_MSG });
  });

  it('pas de message s\'il n\'y avait pas de second', () => {
    expect(manualSubPlan(subs, learn(), null, undefined, false).toast).toBe('');
  });

  it('hors mode apprentissage : retrait silencieux d’un second manuel', () => {
    expect(manualSubPlan(subs, learn({ learn: false }), 'ja', undefined, true).toast).toBe('');
  });

  it('hors mode apprentissage : jamais de second', () => {
    expect(manualSubPlan(subs, learn({ learn: false }), 'ja', undefined, false).secondaryId).toBeNull();
  });

  it('moteur sans second sous-titre : aucun second', () => {
    expect(manualSubPlan(subs, learn(), 'ja', () => false, false).secondaryId).toBeNull();
  });
});

describe('échecs du second sous-titre', () => {
  it('un message par cause', () => {
    expect(secondaryFailureMsg('unsupported')).toBe(SECONDARY_UNSUPPORTED_MSG);
    expect(secondaryFailureMsg('empty')).toBe(SECONDARY_EMPTY_MSG);
    expect(secondaryFailureMsg('load')).toBe(SECONDARY_LOAD_FAIL_MSG);
  });
});
