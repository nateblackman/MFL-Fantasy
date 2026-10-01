const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_RULES } = require('./scoring');
const { buildSchedule } = require('./schedule');

const TEAMS = [
  { name: 'Loot Lake LLamas', short: 'LLL', color: '#8e44ad' },
  { name: 'Tilted Tower Tyrants', short: 'TTT', color: '#c0392b' },
  { name: 'Tomato Town Titans', short: 'TTN', color: '#e4572e' },
  { name: 'Haunted Hills Huntmen', short: 'HHH', color: '#2e7d4f' },
  { name: 'Pleasant Park Panthers', short: 'PPP', color: '#2471a3' },
  { name: 'Greesy Grove Golden Burgers', short: 'GGB', color: '#d4a017' },
];

const DEFAULT_SEASON_WEEKS = 10;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
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

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function writeSchedule(db, seasonWeeks) {
  const teamIds = db.prepare('SELECT id FROM teams ORDER BY id').all().map((t) => t.id);
  tx(db, () => {
    db.exec('DELETE FROM matchups');
    const ins = db.prepare('INSERT INTO matchups (week, home_team_id, away_team_id) VALUES (?, ?, ?)');
    for (const g of buildSchedule(teamIds, seasonWeeks)) ins.run(g.week, g.home, g.away);
    setSetting(db, 'season_weeks', seasonWeeks);
  });
}

// Seeds teams, rules, settings and a schedule if the league is empty.
// Returns the PINs it created so they can be printed once.
function seedIfEmpty(db, { commishPin, teamPins } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
  if (count > 0) return null;

  const pins = { commish: String(commishPin || process.env.COMMISH_PIN || '0000'), teams: {} };
  tx(db, () => {
    const insTeam = db.prepare('INSERT INTO teams (name, short, color, pin_hash) VALUES (?, ?, ?, ?)');
    TEAMS.forEach((t, i) => {
      const pin = String((teamPins && teamPins[i]) || 1001 + i);
      insTeam.run(t.name, t.short, t.color, hashPin(pin));
      pins.teams[t.name] = pin;
    });
    const insRule = db.prepare('INSERT OR REPLACE INTO scoring_rules (key, points) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_RULES)) insRule.run(k, v);
    setSetting(db, 'commish_pin_hash', hashPin(pins.commish));
    setSetting(db, 'current_week', 1);
    if (!getSetting(db, 'session_secret')) setSetting(db, 'session_secret', crypto.randomBytes(32).toString('hex'));
  });
  writeSchedule(db, DEFAULT_SEASON_WEEKS);
  return pins;
}

function defaultDbFile() {
  return path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'mfl.db');
}

module.exports = {
  TEAMS, openDb, seedIfEmpty, getSetting, setSetting, tx, writeSchedule,
  hashPin, checkPin, defaultDbFile,
};
