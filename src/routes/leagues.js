const express = require('express');
const { bad, forbidden, conflict } = require('../errors');
const L = require('../leagues');
const D = require('../draft');
const M = require('../moves');
const season = require('../season');

function leaguesRouter(db) {
  const router = express.Router();
  const ctxOf = (req) => L.access(db, req.params.id, req.user);
  const myTeamOrThrow = (ctx) => {
    if (!ctx.team) throw forbidden("You don't have a team in this league");
    return ctx.team;
  };
  const weekOf = (req) => {
    const w = req.query.week != null ? Number(req.query.week) : season.currentWeek(db);
    if (!Number.isInteger(w) || w < 1) throw bad('Invalid week');
    return w;
  };

  // ---- my leagues, create, join ----

  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT l.id, l.name, l.status, l.max_teams, l.commissioner_id, t.id AS team_id, t.name AS team_name,
      (SELECT COUNT(*) FROM fantasy_teams x WHERE x.league_id = l.id) AS team_count
      FROM leagues l JOIN fantasy_teams t ON t.league_id = l.id AND t.user_id = ? ORDER BY l.created_at DESC`).all(req.user.id);
    res.json(rows.map((r) => ({ ...r, isCommish: r.commissioner_id === req.user.id })));
  });

  router.post('/', (req, res) => {
    res.status(201).json({ id: L.createLeague(db, req.user, req.body || {}) });
  });

  router.get('/invite/:code', (req, res) => {
    const l = L.leagueByCode(db, req.params.code);
    const count = db.prepare('SELECT COUNT(*) AS n FROM fantasy_teams WHERE league_id = ?').get(l.id).n;
    const commish = db.prepare('SELECT name FROM users WHERE id = ?').get(l.commissioner_id);
    res.json({
      id: l.id, name: l.name, status: l.status, teamCount: count, maxTeams: l.max_teams,
      commissioner: commish.name, alreadyMember: !!L.myTeam(db, l.id, req.user.id),
    });
  });

  router.post('/join', (req, res) => {
    const b = req.body || {};
    res.status(201).json({ id: L.joinLeague(db, req.user, b.code, b.team_name) });
  });

  // ---- league overview ----

  router.get('/:id', (req, res) => {
    const ctx = ctxOf(req);
    const l = ctx.league;
    res.json({
      league: {
        id: l.id, name: l.name, status: l.status, maxTeams: l.max_teams, rosterSize: l.roster_size,
        pickSeconds: l.pick_seconds, startWeek: l.start_week,
        inviteCode: ctx.team || ctx.isCommish ? l.invite_code : null,
      },
      teams: L.teamsOf(db, l.id),
      myTeamId: ctx.team ? ctx.team.id : null,
      isCommish: ctx.isCommish,
      scoring: L.leagueRules(db, l.id),
      season: {
        currentWeek: season.currentWeek(db),
        seasonWeeks: season.seasonWeeks(db),
        finalWeeks: season.finalWeeks(db),
        lockedWeeks: season.lockedWeeks(db),
        movesOpen: season.transactionsOpen(db),
      },
    });
  });

  router.patch('/:id', (req, res) => {
    const ctx = ctxOf(req);
    L.requireCommish(ctx);
    L.updateSettings(db, ctx.league, req.body || {});
    res.json({ ok: true });
  });

  router.delete('/:id/teams/:teamId', (req, res) => {
    const ctx = ctxOf(req);
    L.requireCommish(ctx);
    L.removeTeam(db, ctx.league, req.params.teamId);
    res.json({ ok: true });
  });

  router.patch('/:id/teams/:teamId', (req, res) => {
    const ctx = ctxOf(req);
    const team = L.getTeam(db, ctx.league.id, req.params.teamId);
    if (team.user_id !== req.user.id && !ctx.isCommish) throw forbidden('Not your team');
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) throw bad('Team name is required');
    db.prepare('UPDATE fantasy_teams SET name = ? WHERE id = ?').run(name.slice(0, 40), team.id);
    res.json({ ok: true });
  });

  router.get('/:id/scoreboard', (req, res) => {
    const ctx = ctxOf(req);
    const week = weekOf(req);
    res.json({ week, ...season.weekState(db, week), matchups: L.matchupsForWeek(db, ctx.league, week) });
  });

  router.get('/:id/standings', (req, res) => {
    res.json(L.standings(db, ctxOf(req).league));
  });

  router.get('/:id/activity', (req, res) => {
    const ctx = ctxOf(req);
    res.json(db.prepare('SELECT kind, text, created_at FROM transactions WHERE league_id = ? ORDER BY id DESC LIMIT 50')
      .all(ctx.league.id));
  });

  // ---- teams & lineups ----

  router.get('/:id/teams/:teamId', (req, res) => {
    const ctx = ctxOf(req);
    const team = L.getTeam(db, ctx.league.id, req.params.teamId);
    const week = weekOf(req);
    const rules = L.leagueRules(db, ctx.league.id);
    const pts = season.seasonPoints(db, rules);
    const mine = ctx.team && ctx.team.id === team.id;
    const matchup = db.prepare('SELECT id FROM matchups WHERE league_id = ? AND week = ? AND (home_team_id = ? OR away_team_id = ?)')
      .get(ctx.league.id, week, team.id, team.id);
    res.json({
      team: { id: team.id, name: team.name, owner: db.prepare('SELECT name FROM users WHERE id = ?').get(team.user_id).name,
        waiverPriority: team.waiver_priority },
      week,
      weekState: season.weekState(db, week),
      roster: L.rosterOf(db, team.id).map((p) => ({ ...p, seasonPts: pts.get(p.id)?.total ?? 0 })),
      lineup: L.teamWeek(db, team.id, week, L.weekCtx(db, ctx.league.id, week)),
      matchupId: matchup ? matchup.id : null,
      isMine: !!mine,
      canEdit: !!mine && ctx.league.status === 'inseason',
      claims: mine ? M.listClaims(db, team) : [],
    });
  });

  router.put('/:id/teams/:teamId/lineup', (req, res) => {
    const ctx = ctxOf(req);
    const team = L.getTeam(db, ctx.league.id, req.params.teamId);
    if (!ctx.team || ctx.team.id !== team.id) throw forbidden('You can only set your own lineup');
    const { week, slots } = req.body || {};
    L.saveLineup(db, ctx.league, team.id, Number(week), slots || {});
    res.json({ ok: true });
  });

  router.get('/:id/matchups/:mid', (req, res) => {
    const ctx = ctxOf(req);
    const m = db.prepare('SELECT * FROM matchups WHERE id = ? AND league_id = ?').get(Number(req.params.mid), ctx.league.id);
    if (!m) throw bad('Matchup not found');
    const wctx = L.weekCtx(db, ctx.league.id, m.week);
    const side = (teamId) => {
      const t = L.getTeam(db, ctx.league.id, teamId);
      return { team: { id: t.id, name: t.name }, ...L.teamWeek(db, teamId, m.week, wctx) };
    };
    res.json({ id: m.id, week: m.week, final: wctx.final, locked: wctx.locked, home: side(m.home_team_id), away: side(m.away_team_id) });
  });

  // ---- player pool ----

  router.get('/:id/players', (req, res) => {
    const ctx = ctxOf(req);
    const rules = L.leagueRules(db, ctx.league.id);
    const pts = season.seasonPoints(db, rules);
    const rows = db.prepare(`SELECT p.id, p.name, p.position, p.active, m.short AS mfl_short, m.color AS mfl_color,
        r.team_id AS owner_id, t.name AS owner_name,
        EXISTS (SELECT 1 FROM waiver_players w WHERE w.league_id = ? AND w.player_id = p.id) AS on_waivers
      FROM players p
      LEFT JOIN mfl_teams m ON m.id = p.mfl_team_id
      LEFT JOIN rosters r ON r.player_id = p.id AND r.league_id = ?
      LEFT JOIN fantasy_teams t ON t.id = r.team_id
      WHERE p.active = 1 OR r.team_id IS NOT NULL`).all(ctx.league.id, ctx.league.id);
    res.json(rows.map((p) => ({ ...p, on_waivers: !!p.on_waivers, seasonPts: pts.get(p.id)?.total ?? 0, games: pts.get(p.id)?.games ?? 0 }))
      .sort((a, b) => b.seasonPts - a.seasonPts || a.name.localeCompare(b.name)));
  });

  router.post('/:id/add', (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body || {};
    M.addFreeAgent(db, ctx.league, myTeamOrThrow(ctx), b.add_player_id, b.drop_player_id || null);
    res.json({ ok: true });
  });

  router.post('/:id/drop', (req, res) => {
    const ctx = ctxOf(req);
    M.dropPlayer(db, ctx.league, myTeamOrThrow(ctx), req.body && req.body.player_id);
    res.json({ ok: true });
  });

  router.post('/:id/claims', (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body || {};
    M.createClaim(db, ctx.league, myTeamOrThrow(ctx), b.add_player_id, b.drop_player_id || null);
    res.status(201).json({ ok: true });
  });

  router.delete('/:id/claims/:cid', (req, res) => {
    const ctx = ctxOf(req);
    M.cancelClaim(db, ctx.league, myTeamOrThrow(ctx), req.params.cid);
    res.json({ ok: true });
  });

  router.post('/:id/waivers/process', (req, res) => {
    const ctx = ctxOf(req);
    L.requireCommish(ctx);
    res.json(M.processWaivers(db, ctx.league));
  });

  // ---- trades ----

  router.get('/:id/trades', (req, res) => {
    const ctx = ctxOf(req);
    res.json(M.listTrades(db, ctx.league, ctx.team, ctx.isCommish));
  });

  router.post('/:id/trades', (req, res) => {
    const ctx = ctxOf(req);
    res.status(201).json({ id: M.proposeTrade(db, ctx.league, myTeamOrThrow(ctx), req.body || {}) });
  });

  router.post('/:id/trades/:tid/:action', (req, res) => {
    const ctx = ctxOf(req);
    const result = M.respondTrade(db, ctx.league, ctx, req.params.tid, req.params.action);
    if (result && result.failed) throw conflict(result.failed);
    res.json({ ok: true });
  });

  // ---- draft ----

  router.get('/:id/draft', (req, res) => {
    res.json(D.state(db, ctxOf(req).league));
  });

  router.post('/:id/draft/order', (req, res) => {
    const ctx = ctxOf(req);
    L.requireCommish(ctx);
    D.setOrder(db, ctx.league, req.body && req.body.team_ids);
    res.json({ ok: true });
  });

  router.post('/:id/draft/start', (req, res) => {
    const ctx = ctxOf(req);
    L.requireCommish(ctx);
    D.start(db, ctx.league);
    res.json({ ok: true });
  });

  router.post('/:id/draft/pause', (req, res) => {
    const ctx = ctxOf(req);
    L.requireCommish(ctx);
    D.setPaused(db, ctx.league, !!(req.body && req.body.paused));
    res.json({ ok: true });
  });

  // The team on the clock picks. The commissioner can pick for whoever is on the clock.
  router.post('/:id/draft/pick', (req, res) => {
    const ctx = ctxOf(req);
    const clock = D.onTheClock(db, ctx.league);
    if (!clock) throw conflict('The draft is not running');
    const isMine = ctx.team && ctx.team.id === clock.team.id;
    if (!isMine && !ctx.isCommish) throw forbidden(`It's ${clock.team.name}'s pick`);
    const b = req.body || {};
    if (b.auto) D.autoPick(db, ctx.league);
    else D.makePick(db, ctx.league, clock.team.id, b.player_id);
    D.events.emit('change', ctx.league.id);
    res.json({ ok: true });
  });

  // Server-sent events so the draft room updates the moment anyone picks.
  router.get('/:id/events', (req, res) => {
    const ctx = ctxOf(req);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const onChange = (leagueId) => { if (leagueId === ctx.league.id) res.write('data: change\n\n'); };
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    D.events.on('change', onChange);
    req.on('close', () => { clearInterval(ping); D.events.off('change', onChange); });
  });

  return router;
}

module.exports = { leaguesRouter };
