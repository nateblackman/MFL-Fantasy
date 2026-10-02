// Site admin: manages the real MFL (teams, players, weekly stats, and the
// season calendar) that every fantasy league draws from.
const express = require('express');
const { tx, getSetting, setSetting } = require('../db');
const { requireAdmin } = require('../auth');
const { bad, notFound, conflict } = require('../errors');
const { STAT_FIELDS } = require('../scoring');
const L = require('../leagues');
const M = require('../moves');
const season = require('../season');

const POSITIONS = ['QB', 'WR', 'TE', 'C'];

function cleanPlayer(body, partial) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) throw bad('Name is required');
    out.name = name.slice(0, 60);
  }
  if (body.position !== undefined || !partial) {
    if (!POSITIONS.includes(body.position)) throw bad('Position must be QB, WR, TE or C');
    out.position = body.position;
  }
  if (body.mfl_team_id !== undefined) out.mfl_team_id = body.mfl_team_id === '' || body.mfl_team_id == null ? null : Number(body.mfl_team_id);
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return out;
}

function adminRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);

  // ---- MFL teams ----

  router.patch('/mfl-teams/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM mfl_teams WHERE id = ?').get(id)) throw notFound('Team not found');
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) throw bad('Name is required');
      db.prepare('UPDATE mfl_teams SET name = ? WHERE id = ?').run(name.slice(0, 60), id);
    }
    if (b.short !== undefined) {
      const short = String(b.short).trim().toUpperCase();
      if (!/^[A-Z0-9]{2,4}$/.test(short)) throw bad('Abbreviation must be 2-4 letters');
      db.prepare('UPDATE mfl_teams SET short = ? WHERE id = ?').run(short, id);
    }
    if (b.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(b.color)) throw bad('Color must look like #1a2b3c');
      db.prepare('UPDATE mfl_teams SET color = ? WHERE id = ?').run(b.color, id);
    }
    res.json({ ok: true });
  });

  // ---- players ----

  router.get('/players', (_req, res) => {
    res.json(db.prepare(`SELECT p.id, p.name, p.position, p.mfl_team_id, p.active, m.short AS mfl_short
      FROM players p LEFT JOIN mfl_teams m ON m.id = p.mfl_team_id ORDER BY p.active DESC, m.short, p.name`).all());
  });

  router.post('/players', (req, res) => {
    const p = cleanPlayer(req.body || {}, false);
    const r = db.prepare('INSERT INTO players (name, position, mfl_team_id) VALUES (?, ?, ?)').run(p.name, p.position, p.mfl_team_id ?? null);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.patch('/players/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) throw notFound('Player not found');
    const p = cleanPlayer(req.body || {}, true);
    const keys = Object.keys(p);
    if (keys.length) db.prepare(`UPDATE players SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => p[k]), id);
    res.json({ ok: true });
  });

  // ---- stats ----

  router.get('/stats', (req, res) => {
    const week = Number(req.query.week) || season.currentWeek(db);
    res.json({ week, ...season.weekState(db, week), rows: db.prepare('SELECT * FROM stats WHERE week = ?').all(week) });
  });

  // rows: [{ player_id, pass_yds, ... }]. A row with every field blank deletes that player's stats.
  router.put('/stats', (req, res) => {
    const week = Number(req.body && req.body.week);
    const rows = (req.body && req.body.rows) || [];
    if (!Number.isInteger(week) || week < 1) throw bad('Invalid week');
    if (season.isFinal(db, week)) throw conflict(`Week ${week} is final. Reopen it to edit stats.`);
    const exists = db.prepare('SELECT 1 FROM players WHERE id = ?');
    const del = db.prepare('DELETE FROM stats WHERE player_id = ? AND week = ?');
    const upsert = db.prepare(`INSERT INTO stats (player_id, week, ${STAT_FIELDS.join(', ')})
      VALUES (?, ?, ${STAT_FIELDS.map(() => '?').join(', ')})
      ON CONFLICT(player_id, week) DO UPDATE SET ${STAT_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')}`);
    tx(db, () => {
      for (const row of rows) {
        const pid = Number(row.player_id);
        if (!exists.get(pid)) throw bad(`Unknown player ${row.player_id}`);
        if (STAT_FIELDS.every((f) => row[f] === '' || row[f] == null)) { del.run(pid, week); continue; }
        const vals = STAT_FIELDS.map((f) => {
          const n = row[f] === '' || row[f] == null ? 0 : Number(row[f]);
          if (!Number.isFinite(n)) throw bad(`Bad value for ${f}`);
          return n;
        });
        upsert.run(pid, week, ...vals);
      }
    });
    res.json({ ok: true });
  });

  // ---- season calendar ----

  router.get('/season', (_req, res) => {
    const weeks = [];
    for (let w = 1; w <= season.seasonWeeks(db); w++) weeks.push({ week: w, ...season.weekState(db, w) });
    res.json({ currentWeek: season.currentWeek(db), seasonWeeks: season.seasonWeeks(db), weeks });
  });

  router.put('/season-weeks', (req, res) => {
    const n = Number(req.body && req.body.season_weeks);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw bad('Season length must be 1-30 weeks');
    if (db.prepare("SELECT 1 FROM leagues WHERE status != 'predraft'").get()) {
      throw conflict("Can't change the season length once a league has drafted");
    }
    setSetting(db, 'season_weeks', n);
    res.json({ ok: true });
  });

  // Moving the current week forward runs waivers in every league.
  router.put('/current-week', (req, res) => {
    const w = Number(req.body && req.body.week);
    if (!Number.isInteger(w) || w < 1 || w > season.seasonWeeks(db)) throw bad('Invalid week');
    const prev = Number(getSetting(db, 'current_week'));
    tx(db, () => {
      setSetting(db, 'current_week', w);
      if (w > prev) M.processAllWaivers(db);
    });
    res.json({ ok: true });
  });

  router.put('/weeks/:week', (req, res) => {
    const w = Number(req.params.week);
    if (!Number.isInteger(w) || w < 1 || w > season.seasonWeeks(db)) throw bad('Invalid week');
    const cur = season.weekState(db, w);
    const b = req.body || {};
    const locked = b.locked !== undefined ? !!b.locked : cur.locked;
    const final = b.final !== undefined ? !!b.final : cur.final;
    tx(db, () => {
      if (final && !cur.final) L.freezeLineups(db, w);
      db.prepare('INSERT INTO weeks (week, locked, final) VALUES (?, ?, ?) ON CONFLICT(week) DO UPDATE SET locked = excluded.locked, final = excluded.final')
        .run(w, locked || final ? 1 : 0, final ? 1 : 0);
    });
    res.json({ ok: true });
  });

  // ---- users ----

  router.get('/users', (_req, res) => {
    res.json(db.prepare('SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at').all());
  });

  router.patch('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw bad("You can't change your own admin access");
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body && req.body.is_admin ? 1 : 0, id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { adminRouter };
