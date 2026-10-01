const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { openDb, seedIfEmpty, getSetting, defaultDbFile } = require('./src/db');
const { loadAuth, authRouter } = require('./src/auth');
const { apiRouter } = require('./src/routes/api');
const { adminRouter } = require('./src/routes/admin');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1); // Render/Railway sit behind a proxy
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(process.env.SESSION_SECRET || getSetting(db, 'session_secret')));
  app.use(loadAuth);

  app.use('/api/auth', authRouter(db));
  app.use('/api/admin', adminRouter(db));
  app.use('/api', apiRouter(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });
  return app;
}

if (require.main === module) {
  const db = openDb(defaultDbFile());
  const pins = seedIfEmpty(db);
  if (pins) {
    console.log('New league created. Initial PINs (change them on the Commissioner page):');
    console.log(`  Commissioner: ${pins.commish}`);
    for (const [name, pin] of Object.entries(pins.teams)) console.log(`  ${name}: ${pin}`);
  }
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => console.log(`MFL Fantasy running at http://localhost:${port}`));
}

module.exports = { createApp };
