// Global MFL season state shared by every fantasy league: the current week,
// which weeks are locked (games underway) or final, and player stats.
const { getSetting } = require('./db');
const { playerPoints } = require('./scoring');

const currentWeek = (db) => Number(getSetting(db, 'current_week'));
const seasonWeeks = (db) => Number(getSetting(db, 'season_weeks'));

function weekState(db, week) {
  const row = db.prepare('SELECT locked, final FROM weeks WHERE week = ?').get(week);
  const final = !!(row && row.final);
  return { locked: final || !!(row && row.locked), final };
}

const isFinal = (db, week) => weekState(db, week).final;
const isLocked = (db, week) => weekState(db, week).locked;

function finalWeeks(db) {
  return db.prepare('SELECT week FROM weeks WHERE final = 1 ORDER BY week').all().map((r) => r.week);
}

function lockedWeeks(db) {
  return db.prepare('SELECT week FROM weeks WHERE locked = 1 OR final = 1 ORDER BY week').all().map((r) => r.week);
}

function statsForWeek(db, week) {
  const map = new Map();
  for (const s of db.prepare('SELECT * FROM stats WHERE week = ?').all(week)) map.set(s.player_id, s);
  return map;
}

// player_id -> { total, games } under the given scoring rules
function seasonPoints(db, rules) {
  const out = new Map();
  for (const s of db.prepare('SELECT * FROM stats').all()) {
    const cur = out.get(s.player_id) || { total: 0, games: 0 };
    cur.total += playerPoints(s, rules);
    cur.games += 1;
    out.set(s.player_id, cur);
  }
  for (const v of out.values()) v.total = Math.round(v.total * 100) / 100;
  return out;
}

// Transactions (add/drop, trades, claims) pause while the current week's games are underway.
function transactionsOpen(db) {
  const w = currentWeek(db);
  const s = weekState(db, w);
  return !s.locked || s.final;
}

module.exports = {
  currentWeek, seasonWeeks, weekState, isFinal, isLocked, finalWeeks, lockedWeeks,
  statsForWeek, seasonPoints, transactionsOpen,
};
