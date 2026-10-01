// Usage: npm run seed            (wipes the database and re-seeds)
//        COMMISH_PIN=4321 npm run seed
const fs = require('node:fs');
const { openDb, seedIfEmpty, defaultDbFile } = require('./db');

const file = defaultDbFile();
if (process.argv.includes('--reset') && fs.existsSync(file)) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  console.log(`Removed ${file}`);
}

const db = openDb(file);
const pins = seedIfEmpty(db);
if (!pins) {
  console.log('League already seeded; nothing to do.');
} else {
  console.log('Seeded MFL league. Initial PINs (change them in the Commissioner page):');
  console.log(`  Commissioner: ${pins.commish}`);
  for (const [name, pin] of Object.entries(pins.teams)) console.log(`  ${name}: ${pin}`);
}
db.close();
