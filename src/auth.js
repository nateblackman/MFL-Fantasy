const crypto = require('node:crypto');
const express = require('express');
const { tx, hashSecret, checkSecret, sha256 } = require('./db');
const { HttpError, bad } = require('./errors');

const COOKIE = 'mfl_session';
const SESSION_MS = 1000 * 60 * 60 * 24 * 30;
const RESET_MS = 1000 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin } : null;
}

function createSession(db, res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_MS);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS });
}

// Populates req.user from the session cookie.
function loadUser(db) {
  const find = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  return (req, _res, next) => {
    const token = req.cookies && req.cookies[COOKIE];
    req.user = token ? find.get(sha256(token), Date.now()) || null : null;
    next();
  };
}

function requireUser(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Please log in' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.is_admin) return next();
  res.status(req.user ? 403 : 401).json({ error: 'Site admin only' });
}

// Mutating API calls must be JSON. Browsers can't send a cross-site JSON POST
// without a CORS preflight, so this plus SameSite cookies blocks CSRF.
function requireJson(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.is('application/json')) return next();
  res.status(415).json({ error: 'Expected application/json' });
}

// Per-IP limiter. With failuresOnly, only requests that end in an error count,
// so a group logging in from the same Wi-Fi at a draft party isn't locked out.
function rateLimiter(max, windowMs, { failuresOnly = false } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || now - h.since > windowMs) { h = { count: 0, since: now }; hits.set(req.ip, h); }
    if (h.count >= max) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    if (!failuresOnly) h.count++;
    else res.on('finish', () => { if (res.statusCode >= 400) h.count++; });
    next();
  };
}

function cleanEmail(e) {
  const email = String(e || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Enter a valid email address');
  return email;
}

function cleanPassword(p) {
  const pw = String(p || '');
  if (pw.length < 8) throw bad('Password must be at least 8 characters');
  if (pw.length > 200) throw bad('Password is too long');
  return pw;
}

function cleanName(n) {
  const name = String(n || '').trim();
  if (!name) throw bad('Name is required');
  return name.slice(0, 40);
}

function authRouter(db, { mailer, appUrl }) {
  const router = express.Router();
  const TEN_MIN = 10 * 60 * 1000;
  const loginLimit = rateLimiter(15, TEN_MIN, { failuresOnly: true });
  const signupLimit = rateLimiter(40, TEN_MIN);
  const emailLimit = rateLimiter(10, TEN_MIN);

  router.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  router.post('/signup', signupLimit, (req, res) => {
    const b = req.body || {};
    const email = cleanEmail(b.email);
    const name = cleanName(b.name);
    const password = cleanPassword(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('An account with that email already exists');

    const user = tx(db, () => {
      const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
      const admin = first || (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.toLowerCase() === email);
      const r = db.prepare('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(email, name, hashSecret(password), admin ? 1 : 0, Date.now());
      return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    });
    createSession(db, res, req, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/login', loginLimit, (req, res) => {
    const b = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(b.email || '').trim().toLowerCase());
    if (!user || !checkSecret(String(b.password || ''), user.password_hash)) {
      throw new HttpError(401, 'Wrong email or password');
    }
    createSession(db, res, req, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    const token = req.cookies && req.cookies[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  // Always answers the same way so it can't be used to discover which emails have accounts.
  router.post('/forgot', emailLimit, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sha256(token), user.id, Date.now() + RESET_MS);
      const base = appUrl || `${req.protocol}://${req.get('host')}`;
      await mailer.send({
        to: user.email,
        subject: 'Reset your MFL Fantasy password',
        text: `Hi ${user.name},\n\nReset your password here (link expires in 1 hour):\n${base}/#/reset?token=${token}\n\nIf you didn't ask for this, ignore this email.`,
      });
    }
    res.json({ ok: true });
  });

  router.post('/reset', loginLimit, (req, res) => {
    const b = req.body || {};
    const password = cleanPassword(b.password);
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(b.token || '')));
    if (!row || row.used || row.expires_at < Date.now()) throw bad('This reset link is invalid or has expired');
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(password), row.user_id);
      db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    });
    createSession(db, res, req, row.user_id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) });
  });

  router.patch('/account', requireUser, (req, res) => {
    const b = req.body || {};
    if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(cleanName(b.name), req.user.id);
    if (b.new_password !== undefined) {
      if (!checkSecret(String(b.current_password || ''), req.user.password_hash)) throw bad('Current password is wrong');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(cleanPassword(b.new_password)), req.user.id);
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  return router;
}

module.exports = { authRouter, loadUser, requireUser, requireAdmin, requireJson, publicUser };
