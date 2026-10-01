const express = require('express');
const { getSetting } = require('../db');
const { canEditTeam } = require('../auth');
const { SLOTS, STAT_FIELDS, STAT_LABELS } = require('../scoring');
const L = require('../league');

function weekParam(db, req) {
  const w = req.query.week != null ? Number(req.query.week) : Number(getSetting(db, 'current_week'));
  if (!Number.isInteger(w) || w < 1) throw new L.HttpError(400, 'Invalid week');
  return w;
}

function teamOr404(db, id) {
  const team = db.prepare('SELECT id, name, short, color FROM teams WHERE id = ?').get(Number(id));
  if (!team) throw new L.HttpError(404, 'Team not found');
  return team;
}

function apiRouter(db) {
  const router = express.Router();

  router.get('/league', (req, res) => {
    res.json({
      teams: db.prepare('SELECT id, name, short, color FROM teams ORDER BY id').all(),
      currentWeek: Number(getSetting(db, 'current_week')),
      seasonWeeks: Number(getSetting(db, 'season_weeks')),
      finalWeeks: L.finalWeeks(db),
      me: req.auth,
      slots: SLOTS,
      statFields: STAT_FIELDS,
      statLabels: STAT_LABELS,
    });
  });

  router.get('/scoreboard', (req, res) => {
    const week = weekParam(db, req);
    res.json({ week, final: L.isFinal(db, week), matchups: L.matchupsForWeek(db, week) });
  });

  router.get('/standings', (_req, res) => {
    res.json(L.standings(db));
  });

  router.get('/teams/:id', (req, res) => {
    const team = teamOr404(db, req.params.id);
    const week = weekParam(db, req);
    const roster = db.prepare(`SELECT id, name, position FROM players WHERE team_id = ? AND active = 1
      ORDER BY CASE position WHEN 'QB' THEN 1 WHEN 'WR' THEN 2 WHEN 'TE' THEN 3 ELSE 4 END, name`).all(team.id);
    const matchup = db.prepare('SELECT id FROM matchups WHERE week = ? AND (home_team_id = ? OR away_team_id = ?)')
      .get(week, team.id, team.id);
    res.json({
      team, week, roster,
      final: L.isFinal(db, week),
      lineup: L.teamWeek(db, team.id, week),
      matchupId: matchup ? matchup.id : null,
      canEdit: canEditTeam(req.auth, team.id),
    });
  });

  router.put('/teams/:id/lineup', (req, res) => {
    const team = teamOr404(db, req.params.id);
    if (!canEditTeam(req.auth, team.id)) throw new L.HttpError(401, "Enter this team's PIN to edit the lineup");
    const { week, slots } = req.body || {};
    L.saveLineup(db, team.id, Number(week), slots || {});
    res.json({ ok: true, lineup: L.teamWeek(db, team.id, Number(week)) });
  });

  router.get('/matchups/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM matchups WHERE id = ?').get(Number(req.params.id));
    if (!m) throw new L.HttpError(404, 'Matchup not found');
    res.json({
      id: m.id,
      week: m.week,
      final: L.isFinal(db, m.week),
      home: { team: teamOr404(db, m.home_team_id), ...L.teamWeek(db, m.home_team_id, m.week) },
      away: { team: teamOr404(db, m.away_team_id), ...L.teamWeek(db, m.away_team_id, m.week) },
    });
  });

  router.get('/players', (_req, res) => {
    res.json(db.prepare(`SELECT p.id, p.name, p.position, p.team_id, p.active, t.short AS team_short
      FROM players p LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.active DESC, p.name`).all());
  });

  router.get('/stats', (req, res) => {
    const week = weekParam(db, req);
    res.json({ week, final: L.isFinal(db, week), rows: db.prepare('SELECT * FROM stats WHERE week = ?').all(week) });
  });

  router.get('/scoring', (_req, res) => {
    res.json(L.getRules(db));
  });

  return router;
}

module.exports = { apiRouter };
