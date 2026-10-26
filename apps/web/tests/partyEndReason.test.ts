// Fin de salon : chaque motif a son message d'origine ; aucun motif connu ne retombe sur « Salon fermé. » ni sur le texte par défaut.
import { describe, expect, it } from 'vitest';
import { endReasonText } from '../src/party/join';

const DEFAUT = 'Connexion au salon perdue.';
const CONNUS = ['replaced', 'expired', 'banned', 'kicked', 'name_taken', 'name_changed', 'full', 'ended'];

describe('endReasonText : message de fin de salon par motif', () => {
  it('chaque motif reçu a son texte exact', () => {
    expect(endReasonText('replaced')).toBe('Connexion reprise depuis un autre appareil.');
    expect(endReasonText('expired')).toBe('Lien expiré ou invalide : demande une nouvelle invitation à l’hôte.');
    expect(endReasonText('banned')).toBe('Tu ne peux pas rejoindre ce salon.');
    expect(endReasonText('kicked')).toBe('Tu as été exclu du salon.');
    expect(endReasonText('name_taken')).toBe('Ce pseudo est déjà pris dans le salon : choisis-en un autre.');
    expect(endReasonText('name_changed')).toBe('Cette invitation est liée à un autre pseudo : rejoins avec le pseudo d’origine.');
    expect(endReasonText('full')).toBe('Le salon est complet.');
    expect(endReasonText('ended')).toBe('Le salon est terminé.');
  });

  it('un motif inconnu affiche le texte par défaut', () => {
    expect(endReasonText('autre-motif')).toBe(DEFAUT);
  });

  it('aucun motif connu ne donne « Salon fermé. » ni le texte par défaut', () => {
    for (const reason of CONNUS) {
      expect(endReasonText(reason)).not.toBe('Salon fermé.');
      expect(endReasonText(reason)).not.toBe(DEFAUT);
    }
  });
});
