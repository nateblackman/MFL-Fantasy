const crypto = require('node:crypto');
const { tx } = require('./db');
const { bad, forbidden, notFound, conflict } = require('./errors');
const { SLOTS, DEFAULT_RULES, STAT_FIELDS, slotPosition, playerPoints, round2 } = require('./scoring');
const { buildSchedule } = require('./schedule');
const season = require('./season');

const LIMITS = {
  max_teams: [2, 12],
  roster_size: [SLOTS.length, 20],
  pick_seconds: [0, 600], // 0 = untimed
};

function clampInt(v, key, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  const [lo, hi] = LIMITS[key];
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${key.replace('_', ' ')} must be ${lo}-${hi}`);
  return n;
}

function cleanText(v, label, max = 40) {
  const s = String(v || '').trim();
  if (!s) throw bad(`${label} is required`);
  return s.slice(0, max);
}

function logTx(db, leagueId, teamId, kind, text) {
  db.prepare('INSERT INTO transactions (league_id, team_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(leagueId, teamId, kind, text, Date.now());
}

// ---------- leagues & membership ----------

function getLeague(db, id) {
  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(Number(id));
  if (!league) throw notFound('League not found');
  return league;
}

function leagueRules(db, leagueId) {
  const rules = { ...DEFAULT_RULES };
  for (const r of db.prepare('SELECT key, points FROM league_scoring WHERE league_id = ?').all(leagueId)) rules[r.key] = r.points;
  return rules;
}

function teamsOf(db, leagueId) {
  return db.prepare(`SELECT t.id, t.name, t.user_id, u.name AS owner, t.draft_slot, t.waiver_priority
    FROM fantasy_teams t JOIN users u ON u.id = t.user_id WHERE t.league_id = ? ORDER BY t.id`).all(leagueId);
}

function getTeam(db, leagueId, teamId) {
  const t = db.prepare('SELECT * FROM fantasy_teams WHERE id = ? AND league_id = ?').get(Number(teamId), leagueId);
  if (!t) throw notFound('Team not found');
  return t;
}

function myTeam(db, leagueId, userId) {
  return db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? AND user_id = ?').get(leagueId, userId) || null;
}

// Loads the league and the caller's place in it. Non-members get 403 (site admins may look).
function access(db, leagueId, user) {
  const league = getLeague(db, leagueId);
  const team = myTeam(db, league.id, user.id);
  const isCommish = league.commissioner_id === user.id;
  if (!team && !isCommish && !user.is_admin) throw forbidden("You're not in this league");
  return { league, team, isCommish };
}

function requireCommish(ctx) {
  if (!ctx.isCommish) throw forbidden('Only the commissioner can do that');
}

function newInviteCode(db) {
  for (;;) {
    const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toUpperCase();
    if (code.length === 6 && !db.prepare('SELECT 1 FROM leagues WHERE invite_code = ?').get(code)) return code;
  }
}

function createLeague(db, user, b) {
  const name = cleanText(b.name, 'League name');
  const teamName = cleanText(b.team_name, 'Team name');
  const maxTeams = clampInt(b.max_teams, 'max_teams', 6);
  const rosterSize = clampInt(b.roster_size, 'roster_size', 10);
  const pickSeconds = clampInt(b.pick_seconds, 'pick_seconds', 90);
  return tx(db, () => {
    const now = Date.now();
    const r = db.prepare(`INSERT INTO leagues (name, commissioner_id, invite_code, max_teams, roster_size, pick_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, user.id, newInviteCode(db), maxTeams, rosterSize, pickSeconds, now);
    const leagueId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO league_scoring (league_id, key, points) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_RULES)) ins.run(leagueId, k, v);
    db.prepare('INSERT INTO fantasy_teams (league_id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(leagueId, user.id, teamName, now);
    logTx(db, leagueId, null, 'league', `${user.name} created the league`);
    return leagueId;
  });
}

function leagueByCode(db, code) {
  const league = db.prepare('SELECT * FROM leagues WHERE invite_code = ?').get(String(code || '').trim().toUpperCase());
  if (!league) throw notFound('That invite code is not valid');
  return league;
}

function joinLeague(db, user, code, teamName) {
  const league = leagueByCode(db, code);
  const name = cleanText(teamName, 'Team name');
  return tx(db, () => {
    if (myTeam(db, league.id, user.id)) throw conflict("You're already in this league");
    if (league.status !== 'predraft') throw conflict('This league has already drafted');
    const n = db.prepare('SELECT COUNT(*) AS n FROM fantasy_teams WHERE league_id = ?').get(league.id).n;
    if (n >= league.max_teams) throw conflict('This league is full');
    db.prepare('INSERT INTO fantasy_teams (league_id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(league.id, user.id, name, Date.now());
    logTx(db, league.id, null, 'league', `${user.name} joined as ${name}`);
    return league.id;
  });
}

function updateSettings(db, league, b) {
  tx(db, () => {
    if (b.name !== undefined) db.prepare('UPDATE leagues SET name = ? WHERE id = ?').run(cleanText(b.name, 'League name'), league.id);
    for (const key of ['max_teams', 'roster_size']) {
      if (b[key] === undefined) continue;
      if (league.status !== 'predraft') throw conflict(`Can't change ${key.replace('_', ' ')} after the draft starts`);
      const v = clampInt(b[key], key);
      if (key === 'max_teams' && v < db.prepare('SELECT COUNT(*) AS n FROM fantasy_teams WHERE league_id = ?').get(league.id).n) {
        throw bad('More teams have already joined than that');
      }
      db.prepare(`UPDATE leagues SET ${key} = ? WHERE id = ?`).run(v, league.id);
    }
    if (b.pick_seconds !== undefined) {
      db.prepare('UPDATE leagues SET pick_seconds = ? WHERE id = ?').run(clampInt(b.pick_seconds, 'pick_seconds'), league.id);
    }
    if (b.scoring) {
      const upsert = db.prepare(`INSERT INTO league_scoring (league_id, key, points) VALUES (?, ?, ?)
        ON CONFLICT(league_id, key) DO UPDATE SET points = excluded.points`);
      for (const f of STAT_FIELDS) {
        if (b.scoring[f] === undefined) continue;
        const n = Number(b.scoring[f]);
        if (!Number.isFinite(n)) throw bad(`Bad scoring value for ${f}`);
        upsert.run(league.id, f, n);
      }
    }
  });
}

function removeTeam(db, league, teamId) {
  if (league.status !== 'predraft') throw conflict("Teams can't be removed after the draft starts");
  const team = getTeam(db, league.id, teamId);
  if (team.user_id === league.commissioner_id) throw bad("The commissioner's team can't be removed");
  db.prepare('DELETE FROM fantasy_teams WHERE id = ?').run(team.id);
  logTx(db, league.id, null, 'league', `${team.name} was removed from the league`);
}

// ---------- rosters & lineups ----------

function rosterOf(db, teamId) {
  return db.prepare(`SELECT p.id, p.name, p.position, p.mfl_team_id, m.short AS mfl_short, r.acquired_at
    FROM rosters r JOIN players p ON p.id = r.player_id LEFT JOIN mfl_teams m ON m.id = p.mfl_team_id
    WHERE r.team_id = ?
    ORDER BY CASE p.position WHEN 'QB' THEN 1 WHEN 'WR' THEN 2 WHEN 'TE' THEN 3 ELSE 4 END, p.name`).all(teamId);
}

const rosterCount = (db, teamId) => db.prepare('SELECT COUNT(*) AS n FROM rosters WHERE team_id = ?').get(teamId).n;

function defaultLineup(db, teamId) {
  const roster = db.prepare(`SELECT p.id, p.position FROM rosters r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? ORDER BY r.acquired_at, p.id`).all(teamId);
  const used = new Set();
  return SLOTS.map((slot) => {
    const p = roster.find((r) => r.position === slotPosition(slot) && !used.has(r.id));
    if (p) used.add(p.id);
    return { slot, player_id: p ? p.id : null };
  });
}

// The lineup a team is using in a week: its saved lineup for that week, else the
// latest earlier one carried forward, else a default built from the roster.
// Until the week is final, players no longer on the roster drop out.
function effectiveLineup(db, teamId, week) {
  const q = db.prepare('SELECT slot, player_id FROM lineups WHERE team_id = ? AND week = ?');
  let rows = q.all(teamId, week);
  if (rows.length === 0) {
    const prev = db.prepare('SELECT MAX(week) AS w FROM lineups WHERE team_id = ? AND week < ?').get(teamId, week).w;
    rows = prev != null ? q.all(teamId, prev) : defaultLineup(db, teamId);
  }
  const bySlot = new Map(rows.map((r) => [r.slot, r.player_id]));
  const final = season.isFinal(db, week);
  const onRoster = db.prepare('SELECT 1 FROM rosters WHERE player_id = ? AND team_id = ?');
  return SLOTS.map((slot) => {
    let pid = bySlot.get(slot) ?? null;
    if (pid != null && !final && !onRoster.get(pid, teamId)) pid = null;
    return { slot, player_id: pid };
  });
}

function teamWeek(db, teamId, week, ctx) {
  const getPlayer = db.prepare(`SELECT p.id, p.name, p.position, m.short AS mfl_short
    FROM players p LEFT JOIN mfl_teams m ON m.id = p.mfl_team_id WHERE p.id = ?`);
  let total = 0;
  const slots = effectiveLineup(db, teamId, week).map(({ slot, player_id }) => {
    const player = player_id != null ? getPlayer.get(player_id) : null;
    const s = player ? ctx.stats.get(player.id) : null;
    const points = s ? playerPoints(s, ctx.rules) : 0;
    total += points;
    return { slot, player, stats: s || null, points, played: !!s, locked: ctx.locked || !!s };
  });
  return { slots, total: round2(total) };
}

function weekCtx(db, leagueId, week) {
  const st = season.weekState(db, week);
  return { rules: leagueRules(db, leagueId), stats: season.statsForWeek(db, week), locked: st.locked, final: st.final };
}

function saveLineup(db, league, teamId, week, slots) {
  if (league.status !== 'inseason') throw conflict('Lineups open after the draft');
  if (!Number.isInteger(week) || week < 1 || week > season.seasonWeeks(db)) throw bad('Invalid week');
  if (week < season.currentWeek(db)) throw conflict(`Week ${week} is over`);
  if (season.isLocked(db, week)) throw conflict(`Week ${week} is locked: games are underway`);

  const stats = season.statsForWeek(db, week);
  const current = new Map(effectiveLineup(db, teamId, week).map((r) => [r.slot, r.player_id]));
  const getPlayer = db.prepare(`SELECT p.id, p.name, p.position FROM rosters r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? AND p.id = ?`);
  const next = new Map();
  const used = new Set();

  for (const slot of SLOTS) {
    const raw = slots[slot];
    const pid = raw === '' || raw == null ? null : Number(raw);
    const cur = current.get(slot) ?? null;
    if (cur != null && stats.has(cur) && pid !== cur) throw conflict(`${slot} is locked: that player already has stats this week`);
    if (pid != null) {
      const p = getPlayer.get(teamId, pid);
      if (!p) throw bad(`${slot}: that player is not on your roster`);
      if (p.position !== slotPosition(slot)) throw bad(`${slot}: ${p.name} is a ${p.position}`);
      if (used.has(pid)) throw bad(`${p.name} is in more than one slot`);
      if (pid !== cur && stats.has(pid)) throw conflict(`${p.name} already played this week and can't be moved in`);
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

// Called when the site admin marks a week final: freezes every team's lineup
// for that week so later roster moves can't rewrite history.
function freezeLineups(db, week) {
  tx(db, () => {
    const teams = db.prepare(`SELECT t.id FROM fantasy_teams t JOIN leagues l ON l.id = t.league_id
      WHERE l.status = 'inseason' AND l.start_week <= ?`).all(week);
    for (const { id } of teams) {
      writeLineup(db, id, week, new Map(effectiveLineup(db, id, week).map((r) => [r.slot, r.player_id])));
    }
  });
}

// ---------- schedule, scores, standings ----------

function createSchedule(db, league, startWeek) {
  const teamIds = db.prepare('SELECT id FROM fantasy_teams WHERE league_id = ? ORDER BY draft_slot, id').all(league.id).map((t) => t.id);
  const weeks = season.seasonWeeks(db) - startWeek + 1;
  db.prepare('DELETE FROM matchups WHERE league_id = ?').run(league.id);
  if (weeks < 1) return;
  const ins = db.prepare('INSERT INTO matchups (league_id, week, home_team_id, away_team_id) VALUES (?, ?, ?, ?)');
  for (const g of buildSchedule(teamIds, weeks)) ins.run(league.id, g.week + startWeek - 1, g.home, g.away);
}

function matchupsForWeek(db, league, week) {
  const ctx = weekCtx(db, league.id, week);
  const teams = new Map(teamsOf(db, league.id).map((t) => [t.id, t]));
  return db.prepare('SELECT * FROM matchups WHERE league_id = ? AND week = ? ORDER BY id').all(league.id, week).map((m) => ({
    id: m.id,
    week,
    final: ctx.final,
    home: { team: teams.get(m.home_team_id), score: teamWeek(db, m.home_team_id, week, ctx).total },
    away: { team: teams.get(m.away_team_id), score: teamWeek(db, m.away_team_id, week, ctx).total },
  }));
}

function standings(db, league) {
  const table = new Map(teamsOf(db, league.id).map((t) => [t.id, { team: t, w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  for (const week of season.finalWeeks(db)) {
    for (const m of matchupsForWeek(db, league, week)) {
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

module.exports = {
  logTx, getLeague, leagueRules, teamsOf, getTeam, myTeam, access, requireCommish,
  createLeague, leagueByCode, joinLeague, updateSettings, removeTeam,
  rosterOf, rosterCount, effectiveLineup, teamWeek, weekCtx, saveLineup, freezeLineups,
  createSchedule, matchupsForWeek, standings,
};
