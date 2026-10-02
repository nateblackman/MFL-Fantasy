// Live snake draft. The commissioner sets the order and starts the draft; each
// pick has a deadline, and a background tick autopicks when it passes.
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const { bad, forbidden, conflict } = require('./errors');
const { SLOTS, slotPosition } = require('./scoring');
const L = require('./leagues');
const season = require('./season');

// Emits ('change', leagueId) whenever a league's draft or rosters change.
const events = new EventEmitter();
events.setMaxListeners(0);

function draftOrder(db, leagueId) {
  return db.prepare(`SELECT t.id, t.name, u.name AS owner, t.user_id, t.draft_slot
    FROM fantasy_teams t JOIN users u ON u.id = t.user_id
    WHERE t.league_id = ? ORDER BY t.draft_slot, t.id`).all(leagueId);
}

// Snake: odd rounds go 1..n, even rounds go n..1.
function pickInfo(overall, n) {
  const round = Math.ceil(overall / n);
  const i = (overall - 1) % n;
  return { round, index: round % 2 === 1 ? i : n - 1 - i };
}

function totalPicks(league, n) {
  return league.roster_size * n;
}

function onTheClock(db, league) {
  if (league.status !== 'drafting') return null;
  const order = draftOrder(db, league.id);
  const { round, index } = pickInfo(league.draft_pick, order.length);
  return { overall: league.draft_pick, round, team: order[index] };
}

function state(db, league) {
  const order = draftOrder(db, league.id);
  const picks = db.prepare(`SELECT d.overall, d.round, d.team_id, d.auto, p.id AS player_id, p.name, p.position, m.short AS mfl_short
    FROM draft_picks d JOIN players p ON p.id = d.player_id LEFT JOIN mfl_teams m ON m.id = p.mfl_team_id
    WHERE d.league_id = ? ORDER BY d.overall`).all(league.id);
  return {
    status: league.status,
    rounds: league.roster_size,
    pickSeconds: league.pick_seconds,
    paused: !!league.draft_paused,
    deadline: league.pick_deadline,
    now: Date.now(),
    order,
    picks,
    totalPicks: totalPicks(league, order.length),
    current: onTheClock(db, league),
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// teamIds: explicit order, or omitted to randomize.
function setOrder(db, league, teamIds) {
  if (league.status !== 'predraft') throw conflict('The draft has already started');
  const teams = draftOrder(db, league.id).map((t) => t.id);
  let order;
  if (teamIds) {
    order = teamIds.map(Number);
    if (order.length !== teams.length || new Set(order).size !== teams.length || !order.every((id) => teams.includes(id))) {
      throw bad('Draft order must list every team exactly once');
    }
  } else {
    order = shuffle([...teams]);
  }
  tx(db, () => {
    const upd = db.prepare('UPDATE fantasy_teams SET draft_slot = ? WHERE id = ?');
    order.forEach((id, i) => upd.run(i + 1, id));
  });
  events.emit('change', league.id);
}

const deadlineFor = (league) => (league.pick_seconds > 0 ? Date.now() + league.pick_seconds * 1000 : null);

function start(db, league) {
  if (league.status !== 'predraft') throw conflict('The draft has already started');
  const order = draftOrder(db, league.id);
  if (order.length < 2) throw conflict('You need at least 2 teams to draft');
  const available = db.prepare('SELECT COUNT(*) AS n FROM players WHERE active = 1').get().n;
  if (available < totalPicks(league, order.length)) {
    throw conflict(`Not enough players: the draft needs ${totalPicks(league, order.length)} and the MFL has ${available}. Lower the roster size or ask the site admin to add players.`);
  }
  tx(db, () => {
    if (order.some((t) => t.draft_slot == null)) setOrder(db, league);
    db.prepare("UPDATE leagues SET status = 'drafting', draft_pick = 1, draft_paused = 0, pick_deadline = ? WHERE id = ?")
      .run(deadlineFor(league), league.id);
    L.logTx(db, league.id, null, 'draft', 'The draft started');
  });
  events.emit('change', league.id);
}

function setPaused(db, league, paused) {
  if (league.status !== 'drafting') throw conflict('The draft is not running');
  db.prepare('UPDATE leagues SET draft_paused = ?, pick_deadline = ? WHERE id = ?')
    .run(paused ? 1 : 0, paused ? null : deadlineFor(league), league.id);
  events.emit('change', league.id);
}

function makePick(db, league, teamId, playerId, auto = false) {
  return tx(db, () => {
    league = L.getLeague(db, league.id); // re-read inside the transaction
    const clock = onTheClock(db, league);
    if (!clock) throw conflict('The draft is not running');
    if (league.draft_paused && !auto) throw conflict('The draft is paused');
    if (clock.team.id !== teamId) throw forbidden(`It's ${clock.team.name}'s pick`);

    const player = db.prepare('SELECT * FROM players WHERE id = ? AND active = 1').get(Number(playerId));
    if (!player) throw bad('Player not found');
    if (db.prepare('SELECT 1 FROM rosters WHERE league_id = ? AND player_id = ?').get(league.id, player.id)) {
      throw conflict(`${player.name} has already been drafted`);
    }

    const now = Date.now();
    db.prepare('INSERT INTO draft_picks (league_id, overall, round, team_id, player_id, auto, picked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(league.id, clock.overall, clock.round, teamId, player.id, auto ? 1 : 0, now);
    db.prepare('INSERT INTO rosters (league_id, team_id, player_id, acquired_at) VALUES (?, ?, ?, ?)')
      .run(league.id, teamId, player.id, now + clock.overall); // keeps draft order stable for default lineups

    const order = draftOrder(db, league.id);
    if (clock.overall >= totalPicks(league, order.length)) finish(db, league, order);
    else db.prepare('UPDATE leagues SET draft_pick = draft_pick + 1, pick_deadline = ? WHERE id = ?').run(deadlineFor(league), league.id);
    return { overall: clock.overall, player };
  });
}

function finish(db, league, order) {
  const cur = season.currentWeek(db);
  const startWeek = season.isLocked(db, cur) ? cur + 1 : cur;
  db.prepare("UPDATE leagues SET status = 'inseason', pick_deadline = NULL, start_week = ? WHERE id = ?").run(startWeek, league.id);
  // Waiver priority starts as the reverse of the draft order.
  const upd = db.prepare('UPDATE fantasy_teams SET waiver_priority = ? WHERE id = ?');
  order.forEach((t, i) => upd.run(order.length - i, t.id));
  L.createSchedule(db, { ...league, status: 'inseason' }, startWeek);
  L.logTx(db, league.id, null, 'draft', `The draft is complete. The season starts in week ${startWeek}.`);
}

// Best available player for a team: fill empty starting positions first, then
// take the best remaining player. "Best" = most fantasy points so far this season.
function autoChoice(db, league, teamId) {
  const rules = L.leagueRules(db, league.id);
  const pts = season.seasonPoints(db, rules);
  const pool = db.prepare(`SELECT id, name, position FROM players WHERE active = 1
    AND id NOT IN (SELECT player_id FROM rosters WHERE league_id = ?)`).all(league.id);
  if (!pool.length) return null;
  const have = {};
  for (const p of L.rosterOf(db, teamId)) have[p.position] = (have[p.position] || 0) + 1;
  const need = {};
  for (const s of SLOTS) need[slotPosition(s)] = (need[slotPosition(s)] || 0) + 1;
  const score = (p) => (pts.get(p.id) || { total: 0 }).total;
  pool.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  return pool.find((p) => (have[p.position] || 0) < need[p.position]) || pool[0];
}

function autoPick(db, league) {
  const clock = onTheClock(db, league);
  if (!clock) return null;
  const choice = autoChoice(db, league, clock.team.id);
  if (!choice) return null;
  return makePick(db, league, clock.team.id, choice.id, true);
}

// Autopicks for every league whose pick timer ran out. Run on an interval.
function tick(db) {
  const due = db.prepare(`SELECT * FROM leagues WHERE status = 'drafting' AND draft_paused = 0
    AND pick_deadline IS NOT NULL AND pick_deadline <= ?`).all(Date.now());
  for (const league of due) {
    try {
      autoPick(db, league);
    } catch (err) {
      console.error(`Autopick failed in league ${league.id}:`, err.message);
      db.prepare('UPDATE leagues SET draft_paused = 1, pick_deadline = NULL WHERE id = ?').run(league.id);
    }
    events.emit('change', league.id);
  }
}

module.exports = { events, draftOrder, pickInfo, state, setOrder, start, setPaused, makePick, autoPick, tick, onTheClock };
