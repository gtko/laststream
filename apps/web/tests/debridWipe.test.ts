import { describe, expect, it } from 'vitest';
import { wipeDeviceDebrid } from '../src/sources/debridWipe';

describe('effacement des clés de débrideur de l’appareil', () => {
  it('retire les réglages et états enregistrés, sans toucher aux autres clés', () => {
    localStorage.setItem('laststream.debrid.v1', '{"keys":{"alldebrid":"SECRET"}}');
    localStorage.setItem('laststream.debrid.state.v1', '{}');
    localStorage.setItem('laststream.debrid.autre', 'x');
    localStorage.setItem('laststream.theme', 'dark');
    wipeDeviceDebrid();
    expect(localStorage.getItem('laststream.debrid.v1')).toBeNull();
    expect(localStorage.getItem('laststream.debrid.state.v1')).toBeNull();
    expect(localStorage.getItem('laststream.debrid.autre')).toBeNull();
    expect(localStorage.getItem('laststream.theme')).toBe('dark');
  });
});
