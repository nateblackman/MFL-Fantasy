// Usage: npm run seed   (wipes the database and starts over)
const fs = require('node:fs');
const { openDb, seedIfEmpty, defaultDbFile } = require('./db');

const file = defaultDbFile();
if (process.argv.includes('--reset')) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  console.log(`Removed ${file}`);
}

const db = openDb(file);
console.log(seedIfEmpty(db)
  ? 'Created a fresh MFL database. The first account to sign up becomes the site admin.'
  : 'Database already set up; nothing to do.');
db.close();
