const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// The six real MFL teams (the league's equivalent of NFL franchises).
const MFL_TEAMS = [
  { name: 'Loot Lake LLamas', short: 'LLL', color: '#8e44ad' },
  { name: 'Tilted Tower Tyrants', short: 'TTT', color: '#c0392b' },
  { name: 'Tomato Town Titans', short: 'TTN', color: '#e4572e' },
  { name: 'Haunted Hills Huntmen', short: 'HHH', color: '#2e7d4f' },
  { name: 'Pleasant Park Panthers', short: 'PPP', color: '#2471a3' },
  { name: 'Greesy Grove Golden Burgers', short: 'GGB', color: '#d4a017' },
];

const DEFAULT_SEASON_WEEKS = 10;

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkSecret(secret, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(secret), salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const oldPlayers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'players'").get();
  if (oldPlayers && !db.prepare('PRAGMA table_info(players)').all().some((c) => c.name === 'mfl_team_id')) {
    throw new Error(`${file} was created by the old single-league version. Run "npm run seed" to start a fresh database.`);
  }
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.txDepth = 0;
  return db;
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// Runs fn in a transaction. Nested calls join the outer transaction.
function tx(db, fn) {
  if (db.txDepth > 0) return fn();
  db.exec('BEGIN');
  db.txDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.txDepth--;
  }
}

function seedIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM mfl_teams').get().n > 0) return false;
  tx(db, () => {
    const ins = db.prepare('INSERT INTO mfl_teams (name, short, color) VALUES (?, ?, ?)');
    for (const t of MFL_TEAMS) ins.run(t.name, t.short, t.color);
    setSetting(db, 'current_week', 1);
    setSetting(db, 'season_weeks', DEFAULT_SEASON_WEEKS);
  });
  return true;
}

function defaultDbFile() {
  return path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'mfl.db');
}

module.exports = {
  MFL_TEAMS, openDb, seedIfEmpty, getSetting, setSetting, tx,
  hashSecret, checkSecret, sha256, defaultDbFile,
};
