const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { openDb, seedIfEmpty, defaultDbFile } = require('./src/db');
const { authRouter, loadUser, requireUser, requireJson } = require('./src/auth');
const { leaguesRouter } = require('./src/routes/leagues');
const { adminRouter } = require('./src/routes/admin');
const { createMailer } = require('./src/mailer');
const { SLOTS, STAT_FIELDS, STAT_LABELS } = require('./src/scoring');
const season = require('./src/season');
const draft = require('./src/draft');

function createApp(db, { mailer = createMailer(), appUrl = process.env.APP_URL } = {}) {
  const app = express();
  app.set('trust proxy', 1); // Render/Railway sit behind a proxy
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser(db));
  app.use('/api', requireJson);

  app.use('/api/auth', authRouter(db, { mailer, appUrl }));

  // Shared reference data: the real MFL teams and the season calendar.
  app.get('/api/mfl', requireUser, (_req, res) => {
    res.json({
      teams: db.prepare('SELECT id, name, short, color FROM mfl_teams ORDER BY id').all(),
      currentWeek: season.currentWeek(db),
      seasonWeeks: season.seasonWeeks(db),
      finalWeeks: season.finalWeeks(db),
      lockedWeeks: season.lockedWeeks(db),
      slots: SLOTS,
      statFields: STAT_FIELDS,
      statLabels: STAT_LABELS,
    });
  });

  app.use('/api/leagues', requireUser, leaguesRouter(db));
  app.use('/api/admin', adminRouter(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });
  return app;
}

if (require.main === module) {
  const db = openDb(defaultDbFile());
  if (seedIfEmpty(db)) console.log('Created a fresh MFL database. The first account to sign up becomes the site admin.');
  setInterval(() => draft.tick(db), 1000).unref();
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => console.log(`MFL Fantasy running at http://localhost:${port}`));
}

module.exports = { createApp };
