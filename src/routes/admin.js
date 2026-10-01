const express = require('express');
const { getSetting, setSetting, tx, writeSchedule, hashPin, checkPin } = require('../db');
const { requireCommish } = require('../auth');
const { STAT_FIELDS } = require('../scoring');
const L = require('../league');

const POSITIONS = ['QB', 'WR', 'TE', 'C'];

function cleanPlayer(body, partial) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) throw new L.HttpError(400, 'Name is required');
    out.name = name.slice(0, 60);
  }
  if (body.position !== undefined || !partial) {
    if (!POSITIONS.includes(body.position)) throw new L.HttpError(400, 'Position must be QB, WR, TE or C');
    out.position = body.position;
  }
  if (body.team_id !== undefined) out.team_id = body.team_id === '' || body.team_id == null ? null : Number(body.team_id);
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return out;
}

function cleanPin(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(p)) throw new L.HttpError(400, 'PIN must be 4-8 digits');
  return p;
}

function pinInUse(db, pin, exceptTeamId) {
  if (checkPin(pin, getSetting(db, 'commish_pin_hash'))) return true;
  return db.prepare('SELECT id, pin_hash FROM teams').all()
    .some((t) => t.id !== exceptTeamId && checkPin(pin, t.pin_hash));
}

function adminRouter(db) {
  const router = express.Router();
  router.use(requireCommish);

  router.post('/players', (req, res) => {
    const p = cleanPlayer(req.body || {}, false);
    const r = db.prepare('INSERT INTO players (name, position, team_id) VALUES (?, ?, ?)')
      .run(p.name, p.position, p.team_id ?? null);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.patch('/players/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) throw new L.HttpError(404, 'Player not found');
    const p = cleanPlayer(req.body || {}, true);
    const keys = Object.keys(p);
    if (keys.length) {
      db.prepare(`UPDATE players SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => p[k]), id);
    }
    res.json({ ok: true });
  });

  // rows: [{ player_id, pass_yds, ... }]. A row with every field blank deletes that player's stats.
  router.put('/stats', (req, res) => {
    const week = Number(req.body && req.body.week);
    const rows = (req.body && req.body.rows) || [];
    if (!Number.isInteger(week) || week < 1) throw new L.HttpError(400, 'Invalid week');
    if (L.isFinal(db, week)) throw new L.HttpError(409, `Week ${week} is final. Un-finalize it to edit stats.`);

    const exists = db.prepare('SELECT 1 FROM players WHERE id = ?');
    const del = db.prepare('DELETE FROM stats WHERE player_id = ? AND week = ?');
    const upsert = db.prepare(`INSERT INTO stats (player_id, week, ${STAT_FIELDS.join(', ')})
      VALUES (?, ?, ${STAT_FIELDS.map(() => '?').join(', ')})
      ON CONFLICT(player_id, week) DO UPDATE SET ${STAT_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')}`);
    tx(db, () => {
      for (const row of rows) {
        const pid = Number(row.player_id);
        if (!exists.get(pid)) throw new L.HttpError(400, `Unknown player ${row.player_id}`);
        const blank = STAT_FIELDS.every((f) => row[f] === '' || row[f] == null);
        if (blank) { del.run(pid, week); continue; }
        const vals = STAT_FIELDS.map((f) => {
          const n = row[f] === '' || row[f] == null ? 0 : Number(row[f]);
          if (!Number.isFinite(n)) throw new L.HttpError(400, `Bad value for ${f}`);
          return n;
        });
        upsert.run(pid, week, ...vals);
      }
    });
    res.json({ ok: true });
  });

  router.put('/scoring', (req, res) => {
    const rules = req.body || {};
    const upd = db.prepare('UPDATE scoring_rules SET points = ? WHERE key = ?');
    tx(db, () => {
      for (const f of STAT_FIELDS) {
        if (rules[f] === undefined) continue;
        const n = Number(rules[f]);
        if (!Number.isFinite(n)) throw new L.HttpError(400, `Bad value for ${f}`);
        upd.run(n, f);
      }
    });
    res.json(L.getRules(db));
  });

  router.post('/schedule', (req, res) => {
    const weeks = Number(req.body && req.body.season_weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 30) throw new L.HttpError(400, 'Season length must be 1-30 weeks');
    if (L.finalWeeks(db).length) throw new L.HttpError(409, "Can't regenerate the schedule after a week is final");
    writeSchedule(db, weeks);
    res.json({ ok: true });
  });

  router.patch('/matchups/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM matchups WHERE id = ?').get(Number(req.params.id));
    if (!m) throw new L.HttpError(404, 'Matchup not found');
    if (L.isFinal(db, m.week)) throw new L.HttpError(409, `Week ${m.week} is final`);
    const home = Number(req.body.home_team_id);
    const away = Number(req.body.away_team_id);
    if (home === away) throw new L.HttpError(400, 'A team cannot play itself');
    const clash = db.prepare(`SELECT 1 FROM matchups WHERE week = ? AND id != ?
      AND (home_team_id IN (?, ?) OR away_team_id IN (?, ?))`).get(m.week, m.id, home, away, home, away);
    if (clash) throw new L.HttpError(400, 'One of those teams already plays another game that week');
    db.prepare('UPDATE matchups SET home_team_id = ?, away_team_id = ? WHERE id = ?').run(home, away, m.id);
    res.json({ ok: true });
  });

  router.put('/current-week', (req, res) => {
    const w = Number(req.body && req.body.week);
    if (!Number.isInteger(w) || w < 1) throw new L.HttpError(400, 'Invalid week');
    setSetting(db, 'current_week', w);
    res.json({ ok: true });
  });

  router.put('/weeks/:week/final', (req, res) => {
    const w = Number(req.params.week);
    if (!Number.isInteger(w) || w < 1) throw new L.HttpError(400, 'Invalid week');
    L.setWeekFinal(db, w, !!(req.body && req.body.final));
    res.json({ ok: true });
  });

  router.patch('/teams/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id)) throw new L.HttpError(404, 'Team not found');
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) throw new L.HttpError(400, 'Name is required');
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name.slice(0, 60), id);
    }
    if (b.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(b.color)) throw new L.HttpError(400, 'Color must look like #1a2b3c');
      db.prepare('UPDATE teams SET color = ? WHERE id = ?').run(b.color, id);
    }
    if (b.pin !== undefined) {
      const pin = cleanPin(b.pin);
      if (pinInUse(db, pin, id)) throw new L.HttpError(400, 'That PIN is already used by someone else');
      db.prepare('UPDATE teams SET pin_hash = ? WHERE id = ?').run(hashPin(pin), id);
    }
    res.json({ ok: true });
  });

  router.put('/commish-pin', (req, res) => {
    const pin = cleanPin(req.body && req.body.pin);
    if (db.prepare('SELECT pin_hash FROM teams').all().some((t) => checkPin(pin, t.pin_hash))) {
      throw new L.HttpError(400, 'That PIN is already used by a team');
    }
    setSetting(db, 'commish_pin_hash', hashPin(pin));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { adminRouter };
