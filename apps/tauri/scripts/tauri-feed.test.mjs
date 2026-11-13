import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeed } from './tauri-feed.mjs';
import { tauriFeedVersion } from '../../../services/edge/src/index.js';

const base = { version: '1.2.3', bytes: Buffer.from('abc'), size: 3, publishedAt: '2026-01-01T00:00:00Z' };

test('flux macOS et Windows : acceptés par le Worker edge, os lu par updater.rs', () => {
  for (const [platform, ext, os] of [['macos-aarch64', 'app.tar.gz', 'macos'], ['windows-x86_64', 'setup.exe', 'windows']]) {
    const feed = buildFeed({ ...base, platform, file: `/tmp/Laststream-1.2.3-${platform}.${ext}` });
    assert.equal(tauriFeedVersion(JSON.stringify(feed), platform), '1.2.3');
    assert.equal(feed.versionDesc, `https://app.laststream.app/app/tauri/${platform}/latest.json`);
    assert.equal(feed.files[0].os, os);
    assert.equal(feed.files[0].checksum, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  }
});

test('nom de fichier ou plateforme inattendus : refusés', () => {
  assert.throws(() => buildFeed({ ...base, platform: 'macos-aarch64', file: 'Laststream-1.2.3-macos-aarch64.dmg' }));
  assert.throws(() => buildFeed({ ...base, platform: 'linux-x86_64', file: 'x' }));
  assert.throws(() => buildFeed({ ...base, version: '1.2', platform: 'windows-x86_64', file: 'Laststream-1.2-windows-x86_64.setup.exe' }));
});
