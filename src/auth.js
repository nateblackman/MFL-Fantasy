const express = require('express');
const { checkPin, getSetting } = require('./db');

const COOKIE = 'mfl_auth';
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

// Reads the signed cookie into req.auth: { role: 'commish' } | { role: 'team', teamId } | null
function loadAuth(req, _res, next) {
  const v = req.signedCookies && req.signedCookies[COOKIE];
  if (v === 'commish') req.auth = { role: 'commish' };
  else if (typeof v === 'string' && v.startsWith('team:')) req.auth = { role: 'team', teamId: Number(v.slice(5)) };
  else req.auth = null;
  next();
}

function requireCommish(req, res, next) {
  if (req.auth && req.auth.role === 'commish') return next();
  res.status(401).json({ error: 'Commissioner PIN required' });
}

function canEditTeam(auth, teamId) {
  return !!auth && (auth.role === 'commish' || (auth.role === 'team' && auth.teamId === teamId));
}

function authRouter(db) {
  const router = express.Router();
  const attempts = new Map(); // ip -> { count, since }

  router.post('/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const a = attempts.get(ip);
    if (a && now - a.since < WINDOW_MS && a.count >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }

    const pin = String((req.body && req.body.pin) || '').trim();
    let value = null;
    if (pin && checkPin(pin, getSetting(db, 'commish_pin_hash'))) value = 'commish';
    else if (pin) {
      for (const t of db.prepare('SELECT id, pin_hash FROM teams').all()) {
        if (checkPin(pin, t.pin_hash)) { value = `team:${t.id}`; break; }
      }
    }

    if (!value) {
      const fresh = !a || now - a.since >= WINDOW_MS;
      attempts.set(ip, fresh ? { count: 1, since: now } : { count: a.count + 1, since: a.since });
      return res.status(401).json({ error: 'Wrong PIN' });
    }
    attempts.delete(ip);
    res.cookie(COOKIE, value, {
      signed: true, httpOnly: true, sameSite: 'lax',
      secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 180,
    });
    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { loadAuth, requireCommish, canEditTeam, authRouter };
