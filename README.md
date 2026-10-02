# MFL Fantasy

Fantasy football for the Morgantown Football League (MFL). It works like NFL fantasy, but the player pool is real MFL players.

- **Accounts:** players sign up with email and password, create leagues, and invite friends with a link or a 6-letter code.
- **Live snake draft:** a real-time draft room with a pick timer. When the timer runs out, the app picks automatically.
- **Season play:** weekly head-to-head matchups and standings, plus free agency, waivers and trades.

The six Fortnite-named teams (Loot Lake LLamas, Tilted Tower Tyrants, Tomato Town Titans, Haunted Hills Huntmen, Pleasant Park Panthers and Greesy Grove Golden Burgers) are the **real MFL franchises**, the way the Bills or the Steelers are in the NFL. Players belong to those teams. Fantasy managers name their own fantasy teams.

Each fantasy team starts **QB, WR, WR, WR, TE, C**, plus a bench. The commissioner picks the roster size.

## Run it

You need Node 22.13 or newer.

```sh
npm install
npm start          # http://localhost:3000
```

**The first account to sign up becomes the site admin.** To make another email an admin, set `ADMIN_EMAIL`.

Other commands:

- `npm run dev` restarts the server whenever a file changes.
- `npm test` runs the tests.
- `npm run seed` wipes the database and starts over.

## Who does what

**Site admin** (the *MFL admin* menu) runs the real league that every fantasy league uses:

1. **Players:** add MFL players and assign each one to an MFL team.
2. **Season:** each week:
   - **Lock** the week at kickoff. Lineups freeze and roster moves pause.
   - Enter **Stats** after the games.
   - Mark the week **Final** so it counts in standings.
   - **Advance** to the next week. Waiver claims run in every league at this point.

**League commissioner** (whoever created the league):
- Invite friends.
- Set the team count, roster size, pick timer and scoring.
- Set the draft order and start the draft. During the draft, the commissioner can pause it or autopick for an absent manager.
- Veto trades and run waivers early.

**Managers:**
- Draft a team.
- Set the lineup each week.
- Add free agents, put in waiver claims, and propose or accept trades.

### Rules

- **Draft:** snake order. With a pick timer, the app autopicks when time runs out. Autopick fills empty starting positions first, then takes the highest-scoring available player.
- **Free agency and waivers:**
  - Undrafted players are free agents, and anyone can add one instantly.
  - A dropped player goes on waivers until the next week begins. During that time, teams can only put in claims.
  - Claims are awarded by waiver priority. Priority starts in reverse draft order, and a team that wins a claim moves to the back.
- **Trades:** the receiving team accepts or rejects, and the commissioner can veto a trade that is still pending. Both rosters must stay within the size limit.
- **Lineups:**
  - A lineup carries forward each week until it is changed.
  - Players lock once they have stats for the week, and everything locks when the admin locks the week.
- **Scoring:** each league sets its own points per stat on Settings. The defaults are:
  - 1 pt per 25 pass yds, 4 per pass TD, −2 per INT
  - 1 pt per 10 rush/rec yds, 6 per TD, 0.5 per catch
  - −2 per fumble lost, +2 per 2-pt conversion
  - Centers also lose 2 per bad snap and 1 per sack allowed.

## Email (password resets)

Password reset emails go out through [Resend](https://resend.com) when you set these:

```
RESEND_API_KEY=re_...
EMAIL_FROM="MFL Fantasy <noreply@yourdomain.com>"
APP_URL=https://your-app.onrender.com
```

Without them, the reset link is printed in the server log. That works for local testing, but users can't reset their own passwords.

## Deploy

Any host that runs Node and keeps a persistent disk will work. Here is how on Render:

1. In Render, create a **Web Service** from this GitHub repo. Set the build command to `npm install` and the start command to `npm start`.
2. Add a **Disk** mounted at `/var/data`, and set `DATA_DIR=/var/data`.
3. Set `APP_URL`, plus the Resend variables above.
4. Sign up first so that you become the site admin. Or set `ADMIN_EMAIL` before anyone else signs up.

Without a persistent disk, the database is erased on every redeploy. Run only one server instance: the draft timer and live updates run inside the server process.

## Layout

```
server.js              Express app + draft timer
src/schema.sql         database tables
src/db.js              SQLite (node:sqlite), password hashing, seeding
src/auth.js            accounts, sessions, password reset
src/season.js          MFL calendar: current week, locked/final weeks, stats
src/leagues.js         leagues, membership, lineups, scoring, standings
src/draft.js           snake draft, autopick, live update events
src/moves.js           free agency, waivers, trades
src/routes/            league API (leagues.js) and site-admin API (admin.js)
public/js/views/       single-page frontend, one file per area (no build step)
test/                  node --test suites
```
