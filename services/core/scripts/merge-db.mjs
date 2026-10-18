#!/usr/bin/env node
/**
 * Fusionne les données utilisateur d'une base lastAddon « source » (sauvegarde) dans la base « active », sans perte.
 *
 * Usage : node scripts/merge-db.mjs --active <laststream.db> --source <laststream.db> [--dry-run]
 *   --dry-run : exécute toute la fusion dans une transaction annulée et affiche les compteurs (rien n'est écrit).
 * Le service doit être arrêté avant une vraie fusion, et la base active sauvegardée.
 *
 * Règles : comptes (par nom d'utilisateur) et profils (par id, sinon par compte + nom) ajoutés s'ils manquent, mots de
 * passe et PIN de la base active inchangés ; progression par (profil, type, titre, saison, épisode) à updated_at le
 * plus récent ; bibliothèque, suivis, notes, masqués : union, doublon = ligne la plus récente (égalité : source) ;
 * réglages : filtres d'accueil (homeHidden / homeGenres / homeCompleted) = union logique redécoupée en morceaux de
 * 3500 octets (logique de laststream-app src/data/homeFilters.ts), autres clés : absentes d'un côté = ajoutées,
 * différentes = valeur de la source (modifiée plus récemment, aucun horodatage disponible) ; sessions non expirées = union.
 * Aucun secret n'est affiché.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes('--dry-run');
const activePath = arg('--active');
const sourcePath = arg('--source');
if (!activePath || !sourcePath || !existsSync(activePath) || !existsSync(sourcePath)) {
  console.error('Usage : node scripts/merge-db.mjs --active <db> --source <db> [--dry-run]');
  process.exit(2);
}

const CHUNK_MAX_BYTES = 3500;
const MAX_CHUNKS = 12;
const encoder = new TextEncoder();
const byteSize = (v) => encoder.encode(JSON.stringify(v) ?? 'null').length;
function chunkItems(items) {
  const out = [];
  let cur = [];
  for (const it of items) {
    if (cur.length && byteSize([...cur, it]) > CHUNK_MAX_BYTES) {
      out.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

const active = new DatabaseSync(activePath);
const source = new DatabaseSync(sourcePath, { readOnly: true });
active.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
for (const [label, db] of [['active', active], ['source', source]]) {
  const ver = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
  if (ver !== 6) throw new Error(`Schéma ${label} inattendu (version ${ver}, attendu 6)`);
}

const TABLES = ['accounts', 'profiles', 'sessions', 'library_items', 'progress', 'follows', 'ratings', 'continue_hidden', 'settings', 'skip_segments', 'skip_fingerprints'];
const count = (db, t) => Number(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
const stats = Object.fromEntries(TABLES.map((t) => [t, { active: count(active, t), source: count(source, t), added: 0, replaced: 0, kept: 0 }]));
const notes = [];
const ts = (s) => {
  const n = Date.parse(s);
  return Number.isNaN(n) ? 0 : n;
};

/** Fusionne des lignes par clé ; `newer(srcRow, actRow)` vrai = la source remplace la ligne active. */
function mergeRows(table, keyCols, cols, mapRow, newer) {
  const sel = active.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
  const index = new Map(sel.map((r) => [keyCols.map((c) => r[c]).join('\u0000'), r]));
  const ins = active.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const raw of source.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all()) {
    const row = mapRow(raw);
    if (!row) continue;
    const key = keyCols.map((c) => row[c]).join('\u0000');
    const existing = index.get(key);
    if (!existing) {
      ins.run(...cols.map((c) => row[c]));
      stats[table].added++;
    } else if (newer(row, existing)) {
      ins.run(...cols.map((c) => row[c]));
      stats[table].replaced++;
    } else stats[table].kept++;
  }
}

active.exec('BEGIN IMMEDIATE');
try {
  // ---- Comptes : correspondance par nom d'utilisateur.
  const actAcc = new Map(active.prepare('SELECT id, username FROM accounts').all().map((r) => [r.username, r.id]));
  const accMap = new Map();
  for (const a of source.prepare('SELECT * FROM accounts').all()) {
    if (actAcc.has(a.username)) {
      accMap.set(a.id, actAcc.get(a.username));
      stats.accounts.kept++;
    } else {
      active.prepare('INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)').run(a.id, a.username, a.password_hash, a.is_owner, a.created_at);
      accMap.set(a.id, a.id);
      stats.accounts.added++;
    }
  }

  // ---- Profils : même id, sinon (compte, nom).
  const actProf = active.prepare('SELECT * FROM profiles').all();
  const profMap = new Map();
  for (const p of source.prepare('SELECT * FROM profiles').all()) {
    const acc = accMap.get(p.account_id);
    const match = actProf.find((x) => x.id === p.id) ?? actProf.find((x) => x.account_id === acc && x.name === p.name);
    if (match) {
      profMap.set(p.id, match.id);
      stats.profiles.kept++;
      const diff = ['name', 'avatar_color', 'is_kid', 'kid_max_age', 'allowed_catalogs'].filter((c) => match[c] !== p[c]);
      if (diff.length) notes.push(`profil « ${p.name} » : champs différents conservés côté active (${diff.join(', ')})`);
      if ((match.pin_hash ?? null) !== (p.pin_hash ?? null)) notes.push(`profil « ${p.name} » : PIN différent, celui de la base active est conservé`);
    } else {
      active.prepare(
        `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, pin_hash, allowed_catalogs, created_at, pin_failures, pin_locked_until, pin_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.id, acc, p.name, p.avatar_color, p.is_kid, p.kid_max_age, p.pin_hash, p.allowed_catalogs, p.created_at, p.pin_failures, p.pin_locked_until, p.pin_version);
      profMap.set(p.id, p.id);
      stats.profiles.added++;
    }
  }
  const mapProfile = (row) => {
    const pid = profMap.get(row.profile_id);
    return pid ? { ...row, profile_id: pid } : null;
  };

  // ---- Sessions : union des non expirées.
  const now = Date.now();
  const actTok = new Set(active.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash));
  for (const s of source.prepare('SELECT * FROM sessions').all()) {
    const acc = accMap.get(s.account_id);
    if (actTok.has(s.token_hash)) stats.sessions.kept++;
    else if (!acc || ts(s.expires_at) <= now) notes.push('session expirée de la source ignorée');
    else {
      active.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(s.token_hash, acc, s.created_at, s.expires_at);
      stats.sessions.added++;
    }
  }

  // ---- Bibliothèque, progression, suivis, notes, masqués.
  const later = (field) => (a, b) => ts(a[field]) >= ts(b[field]);
  mergeRows('library_items', ['profile_id', 'type', 'title_ref'], ['profile_id', 'type', 'title_ref', 'tmdb_id', 'imdb_id', 'title', 'poster', 'added_at', 'removed'], mapProfile, later('added_at'));
  mergeRows('progress', ['profile_id', 'type', 'title_ref', 'season', 'episode'], ['profile_id', 'type', 'title_ref', 'tmdb_id', 'imdb_id', 'season', 'episode', 'position_sec', 'duration_sec', 'updated_at', 'finished'], mapProfile, (a, b) => ts(a.updated_at) > ts(b.updated_at));
  mergeRows('follows', ['profile_id', 'type', 'title_ref'], ['profile_id', 'type', 'title_ref', 'tmdb_id', 'imdb_id', 'title', 'poster', 'followed_at', 'notify'], mapProfile, later('followed_at'));
  mergeRows('ratings', ['profile_id', 'type', 'title_ref'], ['profile_id', 'type', 'title_ref', 'tmdb_id', 'imdb_id', 'title', 'rating', 'rated_at'], mapProfile, later('rated_at'));
  mergeRows('continue_hidden', ['profile_id', 'type', 'title_ref'], ['profile_id', 'type', 'title_ref', 'hidden_at'], mapProfile, later('hidden_at'));

  // ---- Segments de saut (vides aujourd'hui) : union par (imdb, saison, épisode, type, début, fin).
  if (stats.skip_segments.source > 0) {
    const have = new Set(active.prepare('SELECT imdb_id, season, episode, kind, "start", "end" FROM skip_segments').all().map((r) => [r.imdb_id, r.season, r.episode, r.kind, r.start, r.end].join('|')));
    const ins = active.prepare('INSERT INTO skip_segments (imdb_id, season, episode, kind, "start", "end", duration, votes_up, votes_down, source, created_at, confidence, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of source.prepare('SELECT * FROM skip_segments').all()) {
      if (have.has([r.imdb_id, r.season, r.episode, r.kind, r.start, r.end].join('|'))) stats.skip_segments.kept++;
      else {
        ins.run(r.imdb_id, r.season, r.episode, r.kind, r.start, r.end, r.duration, r.votes_up, r.votes_down, r.source, r.created_at, r.confidence, r.method);
        stats.skip_segments.added++;
      }
    }
  }
  if (stats.skip_fingerprints.source > 0) {
    const ins = active.prepare('INSERT OR IGNORE INTO skip_fingerprints (imdb_id, season, kind, method, fp, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of source.prepare('SELECT * FROM skip_fingerprints').all()) stats.skip_fingerprints.added += Number(ins.run(r.imdb_id, r.season, r.kind, r.method, r.fp, r.created_at).changes);
  }

  // ---- Réglages par profil.
  const readSettings = (db, pid) => Object.fromEntries(db.prepare('SELECT key, value FROM settings WHERE profile_id = ?').all(pid).map((r) => [r.key, JSON.parse(r.value)]));
  const readChunks = (s, name) => {
    const n = s[name];
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return [];
    const out = [];
    for (let k = 0; k < Math.min(n, MAX_CHUNKS); k++) if (Array.isArray(s[name + k])) out.push(...s[name + k]);
    return out;
  };
  const isHomeKey = (k) => /^(homeHidden|homeCompleted)\d*$/.test(k) || k === 'homeGenres';
  const setKey = active.prepare('INSERT INTO settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value');
  const delKey = active.prepare('DELETE FROM settings WHERE profile_id = ? AND key = ?');

  for (const [srcPid, actPid] of profMap) {
    const src = readSettings(source, srcPid);
    const act = readSettings(active, actPid);
    const label = source.prepare('SELECT name FROM profiles WHERE id = ?').get(srcPid).name;

    // Filtres d'accueil : union logique puis redécoupage.
    const hasHome = (s) => ['homeGenres', 'homeHidden', 'homeCompleted'].some((k) => s[k] !== undefined && s[k] !== null);
    if (hasHome(src) || hasHome(act)) {
      const hidden = new Map();
      for (const e of [...readChunks(act, 'homeHidden'), ...readChunks(src, 'homeHidden')]) {
        if (!e || typeof e.key !== 'string') continue;
        const prev = hidden.get(e.key);
        if (!prev || (e.addedAt ?? 0) >= (prev.addedAt ?? 0)) hidden.set(e.key, e);
      }
      const genres = [...new Set([...(Array.isArray(act.homeGenres) ? act.homeGenres : []), ...(Array.isArray(src.homeGenres) ? src.homeGenres : [])])].sort((a, b) => a - b);
      const completed = [...new Set([...readChunks(act, 'homeCompleted'), ...readChunks(src, 'homeCompleted')])];
      const put = (name, items) => {
        const parts = chunkItems(items);
        if (parts.length > MAX_CHUNKS) throw new Error(`« ${name} » dépasse ${MAX_CHUNKS} morceaux pour le profil ${label}`);
        setKey.run(actPid, name, JSON.stringify(parts.length));
        for (let k = 0; k < MAX_CHUNKS; k++) {
          if (parts[k]) setKey.run(actPid, name + k, JSON.stringify(parts[k]));
          else delKey.run(actPid, name + k);
        }
      };
      setKey.run(actPid, 'homeGenres', JSON.stringify(genres));
      put('homeHidden', [...hidden.values()]);
      put('homeCompleted', completed);
      notes.push(`profil « ${label} » filtres d'accueil : ${hidden.size} masqués, ${genres.length} genres, ${completed.length} séries vues`);
      stats.settings.replaced++;
    }

    // Autres réglages : groupes atomiques (clé + clé<n> pour les listes découpées, ex. aiRecs / aiRecs0).
    const groupOf = (k, all) => {
      const m = /^(.*?)\d+$/.exec(k);
      return m && typeof all[m[1]] === 'number' ? m[1] : k;
    };
    const groups = new Map();
    for (const [side, s] of [['act', act], ['src', src]]) {
      for (const k of Object.keys(s)) {
        if (isHomeKey(k)) continue;
        const g = groupOf(k, s);
        if (!groups.has(g)) groups.set(g, { act: {}, src: {} });
        groups.get(g)[side][k] = s[k];
      }
    }
    for (const [g, { act: a, src: s }] of groups) {
      const hasA = Object.keys(a).length > 0;
      const hasS = Object.keys(s).length > 0;
      if (hasS && (!hasA || JSON.stringify(a) !== JSON.stringify(s))) {
        for (const k of Object.keys(a)) if (!(k in s)) delKey.run(actPid, k);
        for (const [k, v] of Object.entries(s)) setKey.run(actPid, k, JSON.stringify(v));
        if (hasA) {
          stats.settings.replaced++;
          notes.push(`profil « ${label} » réglage « ${g} » : valeur de la source retenue`);
        } else stats.settings.added++;
      } else stats.settings.kept++;
    }
  }

  // ---- Contrôles avant validation.
  const integrity = active.prepare('PRAGMA integrity_check').get();
  const fk = active.prepare('PRAGMA foreign_key_check').all();
  const after = Object.fromEntries(TABLES.map((t) => [t, count(active, t)]));
  const problems = [];
  if (Object.values(integrity)[0] !== 'ok') problems.push('integrity_check');
  if (fk.length) problems.push(`foreign_key_check (${fk.length})`);
  for (const t of ['progress', 'library_items', 'follows', 'ratings', 'continue_hidden', 'sessions']) {
    if (after[t] < Math.max(stats[t].active, t === 'sessions' ? 0 : stats[t].source)) problems.push(`${t} : ${after[t]} < max`);
  }

  console.log(`Mode : ${dryRun ? 'DRY-RUN (annulé)' : 'ÉCRITURE'}`);
  console.log('table'.padEnd(17), 'active'.padStart(7), 'source'.padStart(7), 'apres'.padStart(7), ' ajoutes remplaces gardes');
  for (const t of TABLES) {
    const s = stats[t];
    console.log(t.padEnd(17), String(s.active).padStart(7), String(s.source).padStart(7), String(after[t]).padStart(7), `${String(s.added).padStart(8)} ${String(s.replaced).padStart(9)} ${String(s.kept).padStart(6)}`);
  }
  for (const n of [...new Set(notes)]) console.log('note :', n);
  console.log('integrity_check :', Object.values(integrity)[0], '| foreign_key_check :', fk.length);
  if (problems.length) throw new Error('Contrôles échoués : ' + problems.join(', '));

  if (dryRun) active.exec('ROLLBACK');
  else active.exec('COMMIT');
} catch (err) {
  try {
    active.exec('ROLLBACK');
  } catch {
    // transaction déjà terminée
  }
  console.error("Échec, rien n'est écrit :", err.message);
  process.exitCode = 1;
} finally {
  active.close();
  source.close();
}
