// Fin de salon : chaque motif a son message, et aucun ne retombe sur le générique « Salon fermé ».
import { describe, expect, it } from 'vitest';
import { endReasonText } from '../src/party/join';

describe('endReasonText : message de fin de salon par motif', () => {
  it('chaque motif reçu a son texte exact', () => {
    expect(endReasonText('replaced')).toBe('Connexion reprise depuis un autre appareil.');
    expect(endReasonText('expired')).toBe('Invitation expirée.');
    expect(endReasonText('banned')).toBe('Tu as été exclu du salon.');
    expect(endReasonText('kicked')).toBe('Tu as été exclu du salon.');
    expect(endReasonText('name_taken')).toBe('Ce pseudo est déjà utilisé dans le salon.');
    expect(endReasonText('name_changed')).toBe('Le pseudo de cette invitation ne peut pas changer.');
    expect(endReasonText('full')).toBe('Le salon est complet.');
    expect(endReasonText('ended')).toBe('Le salon est terminé.');
  });

  it('un motif inconnu affiche « Connexion au salon perdue. », jamais « Salon fermé »', () => {
    expect(endReasonText('autre-motif')).toBe('Connexion au salon perdue.');
    expect(endReasonText('')).not.toMatch(/Salon fermé/);
  });

  it('aucun motif connu ne retombe sur le message générique', () => {
    const reasons = ['replaced', 'expired', 'banned', 'kicked', 'name_taken', 'name_changed', 'full', 'ended'];
    for (const reason of reasons) expect(endReasonText(reason)).not.toMatch(/Salon fermé/);
  });
});
