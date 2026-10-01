# MFL Fantasy

Fantasy football for the Morgantown Football League. Six teams, each starting a QB, three WRs, a TE and a C. All players are real MFL players, and the commissioner enters their stats every week.

## Run it

You need Node 22.13 or newer.

```sh
npm install
npm start          # http://localhost:3000
```

The first start creates `data/mfl.db` and prints the initial PINs:

| Who | PIN |
| --- | --- |
| Commissioner | `0000`, or `COMMISH_PIN=xxxx npm start` on first run |
| Loot Lake LLamas … Greesy Grove Golden Burgers | `1001` – `1006` |

Change every PIN on **Commissioner → League** before you share the link.

Other commands:

- `npm run dev` restarts the server whenever a file changes.
- `npm test` runs the tests.
- `npm run seed` wipes the database and starts the league over. Don't run this once the season has started.

## How a week works

1. **Commissioner → Players**: add players and assign each one to a team. Moving a player to another team counts as a trade, and setting them to Free agent counts as a drop.
2. **Team managers** log in with their team PIN and set their lineup. Each lineup carries forward to the next week until it is changed. A team that has never set a lineup starts its players in roster order.
3. **Commissioner → Stats**: after the games, enter each player's stats and press **Save stats**. A player's slot locks as soon as they have stats for the week.
4. **Commissioner → League**: mark the week **final**. This locks the week's stats and lineups and counts it in the standings. Then set the next **current week**.

Scoring rules are set as points per unit on **Commissioner → League**. Scores are recalculated every time a page loads, so a rule change applies to past weeks too. The defaults are:
- 1 pt per 25 pass yds, 4 per pass TD, −2 per INT
- 1 pt per 10 rush/rec yds, 6 per TD, 0.5 per catch
- −2 per fumble lost, +2 per 2-pt conversion
- Centers also lose 2 per bad snap and 1 per sack allowed.

The schedule is a round robin, so each team plays every other team once every 5 weeks. The season is 10 weeks by default. To change matchups or the season length, go to **Commissioner → Schedule**. Regenerating the schedule only works before any week is final.

## Deploy (so the league can use it)

Any host that runs Node and keeps a persistent disk will work. Here is how on Render:

1. Push this folder to a GitHub repo.
2. In Render, create a **Web Service** from the repo. Set the build command to `npm install` and the start command to `npm start`.
3. Add a **Disk** mounted at `/var/data`, and set the env var `DATA_DIR=/var/data`.
4. Optionally, set `COMMISH_PIN` before the first deploy, and set `SESSION_SECRET` to a long random string.

Without a persistent disk, the database is erased on every redeploy.

## Layout

```
server.js            Express app
src/db.js            SQLite (node:sqlite), seeding, PIN hashing
src/league.js        lineups, scoring per week, standings
src/scoring.js       scoring rules + math
src/schedule.js      round-robin generator
src/routes/          public API (api.js) and commissioner API (admin.js)
src/auth.js          PIN login → signed cookie
public/              single-page frontend (no build step)
test/                node --test suites
```
