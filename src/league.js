const { tx } = require('./db');
const { SLOTS, slotPosition, playerPoints, round2 } = require('./scoring');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getRules(db) {
  const rules = {};
  for (const r of db.prepare('SELECT key, points FROM scoring_rules').all()) rules[r.key] = r.points;
  return rules;
}

function isFinal(db, week) {
  const row = db.prepare('SELECT final FROM weeks WHERE week = ?').get(week);
  return !!(row && row.final);
}

function finalWeeks(db) {
  return db.prepare('SELECT week FROM weeks WHERE final = 1 ORDER BY week').all().map((r) => r.week);
}

function statsForWeek(db, week) {
  const map = new Map();
  for (const s of db.prepare('SELECT * FROM stats WHERE week = ?').all(week)) map.set(s.player_id, s);
  return map;
}

// The lineup a team is actually using in a week: its saved lineup for that week,
// or else the most recent earlier saved lineup carried forward. For weeks that
// aren't final, players no longer on the roster are dropped.
function effectiveLineup(db, teamId, week) {
  let rows = db.prepare('SELECT slot, player_id FROM lineups WHERE team_id = ? AND week = ?').all(teamId, week);
  if (rows.length === 0) {
    const prev = db.prepare('SELECT MAX(week) AS w FROM lineups WHERE team_id = ? AND week < ?').get(teamId, week).w;
    if (prev != null) rows = db.prepare('SELECT slot, player_id FROM lineups WHERE team_id = ? AND week = ?').all(teamId, prev);
    else rows = defaultLineup(db, teamId);
  }
  const bySlot = new Map(rows.map((r) => [r.slot, r.player_id]));
  const final = isFinal(db, week);
  const onRoster = db.prepare('SELECT 1 FROM players WHERE id = ? AND team_id = ? AND active = 1');
  return SLOTS.map((slot) => {
    let pid = bySlot.get(slot) ?? null;
    if (pid != null && !final && !onRoster.get(pid, teamId)) pid = null;
    return { slot, player_id: pid };
  });
}

// A team that has never saved a lineup starts its players in roster order.
function defaultLineup(db, teamId) {
  const roster = db.prepare('SELECT id, position FROM players WHERE team_id = ? AND active = 1 ORDER BY id').all(teamId);
  const used = new Set();
  return SLOTS.map((slot) => {
    const p = roster.find((r) => r.position === slotPosition(slot) && !used.has(r.id));
    if (p) used.add(p.id);
    return { slot, player_id: p ? p.id : null };
  });
}

function teamWeek(db, teamId, week, ctx = {}) {
  const rules = ctx.rules || getRules(db);
  const stats = ctx.stats || statsForWeek(db, week);
  const final = ctx.final ?? isFinal(db, week);
  const getPlayer = db.prepare('SELECT id, name, position, team_id FROM players WHERE id = ?');
  let total = 0;
  const slots = effectiveLineup(db, teamId, week).map(({ slot, player_id }) => {
    const player = player_id != null ? getPlayer.get(player_id) : null;
    const s = player ? stats.get(player.id) : null;
    const points = player ? playerPoints(s, rules) : 0;
    total += points;
    return { slot, player, stats: s || null, points, played: !!s, locked: final || !!s };
  });
  return { slots, total: round2(total) };
}

function matchupsForWeek(db, week) {
  const ctx = { rules: getRules(db), stats: statsForWeek(db, week), final: isFinal(db, week) };
  const teams = new Map(db.prepare('SELECT id, name, short, color FROM teams').all().map((t) => [t.id, t]));
  return db.prepare('SELECT * FROM matchups WHERE week = ? ORDER BY id').all(week).map((m) => ({
    id: m.id,
    week: m.week,
    final: ctx.final,
    home: { team: teams.get(m.home_team_id), score: teamWeek(db, m.home_team_id, week, ctx).total },
    away: { team: teams.get(m.away_team_id), score: teamWeek(db, m.away_team_id, week, ctx).total },
  }));
}

function standings(db) {
  const table = new Map(db.prepare('SELECT id, name, short, color FROM teams ORDER BY id').all()
    .map((t) => [t.id, { team: t, w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  for (const week of finalWeeks(db)) {
    for (const m of matchupsForWeek(db, week)) {
      const h = table.get(m.home.team.id);
      const a = table.get(m.away.team.id);
      h.pf += m.home.score; h.pa += m.away.score;
      a.pf += m.away.score; a.pa += m.home.score;
      if (m.home.score > m.away.score) { h.w++; a.l++; }
      else if (m.home.score < m.away.score) { a.w++; h.l++; }
      else { h.t++; a.t++; }
    }
  }
  const rows = [...table.values()].map((r) => ({ ...r, pf: round2(r.pf), pa: round2(r.pa) }));
  const pct = (r) => (r.w + r.l + r.t ? (r.w + r.t / 2) / (r.w + r.l + r.t) : 0);
  rows.sort((x, y) => pct(y) - pct(x) || y.pf - x.pf);
  return rows;
}

// slots: { QB: playerId|null, WR1: ..., ... }
function saveLineup(db, teamId, week, slots) {
  if (!Number.isInteger(week) || week < 1) throw new HttpError(400, 'Invalid week');
  if (isFinal(db, week)) throw new HttpError(409, `Week ${week} is final`);

  const stats = statsForWeek(db, week);
  const current = new Map(effectiveLineup(db, teamId, week).map((r) => [r.slot, r.player_id]));
  const getPlayer = db.prepare('SELECT id, name, position, team_id, active FROM players WHERE id = ?');
  const next = new Map();
  const used = new Set();

  for (const slot of SLOTS) {
    const raw = slots[slot];
    const pid = raw === '' || raw == null ? null : Number(raw);
    const cur = current.get(slot) ?? null;

    if (cur != null && stats.has(cur) && pid !== cur) {
      throw new HttpError(409, `${slot} is locked: that player already has stats this week`);
    }
    if (pid != null) {
      const p = getPlayer.get(pid);
      if (!p || p.team_id !== teamId || !p.active) throw new HttpError(400, `${slot}: player is not on this roster`);
      if (p.position !== slotPosition(slot)) throw new HttpError(400, `${slot}: ${p.name} is a ${p.position}`);
      if (used.has(pid)) throw new HttpError(400, `${p.name} is in more than one slot`);
      if (pid !== cur && stats.has(pid)) throw new HttpError(409, `${p.name} already has stats this week and can't be moved in`);
      used.add(pid);
    }
    next.set(slot, pid);
  }

  writeLineup(db, teamId, week, next);
}

function writeLineup(db, teamId, week, bySlot) {
  tx(db, () => {
    const ins = db.prepare(`INSERT INTO lineups (team_id, week, slot, player_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, week, slot) DO UPDATE SET player_id = excluded.player_id`);
    for (const slot of SLOTS) ins.run(teamId, week, slot, bySlot.get(slot) ?? null);
  });
}

// Marking a week final freezes every team's carried-forward lineup into real rows
// so later roster moves can't rewrite history.
function setWeekFinal(db, week, final) {
  if (final) {
    for (const { id } of db.prepare('SELECT id FROM teams').all()) {
      const lineup = effectiveLineup(db, id, week);
      writeLineup(db, id, week, new Map(lineup.map((r) => [r.slot, r.player_id])));
    }
  }
  db.prepare('INSERT INTO weeks (week, final) VALUES (?, ?) ON CONFLICT(week) DO UPDATE SET final = excluded.final')
    .run(week, final ? 1 : 0);
}

module.exports = {
  HttpError, getRules, isFinal, finalWeeks, statsForWeek, effectiveLineup,
  teamWeek, matchupsForWeek, standings, saveLineup, setWeekFinal,
};
