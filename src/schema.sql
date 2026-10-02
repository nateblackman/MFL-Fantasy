PRAGMA foreign_keys = ON;

-- ---------- accounts ----------

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

-- ---------- the real MFL (shared by every fantasy league) ----------

CREATE TABLE IF NOT EXISTS mfl_teams (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  short  TEXT NOT NULL,
  color  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  position     TEXT NOT NULL CHECK (position IN ('QB','WR','TE','C')),
  mfl_team_id  INTEGER REFERENCES mfl_teams(id) ON DELETE SET NULL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stats (
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  week          INTEGER NOT NULL,
  pass_yds      REAL NOT NULL DEFAULT 0,
  pass_td       REAL NOT NULL DEFAULT 0,
  pass_int      REAL NOT NULL DEFAULT 0,
  rush_yds      REAL NOT NULL DEFAULT 0,
  rush_td       REAL NOT NULL DEFAULT 0,
  rec           REAL NOT NULL DEFAULT 0,
  rec_yds       REAL NOT NULL DEFAULT 0,
  rec_td        REAL NOT NULL DEFAULT 0,
  fumbles_lost  REAL NOT NULL DEFAULT 0,
  two_pt        REAL NOT NULL DEFAULT 0,
  bad_snaps     REAL NOT NULL DEFAULT 0,
  sacks_allowed REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, week)
);

-- locked: games are underway, lineups and transactions are frozen
-- final:  stats are complete and the week counts in standings
CREATE TABLE IF NOT EXISTS weeks (
  week    INTEGER PRIMARY KEY,
  locked  INTEGER NOT NULL DEFAULT 0,
  final   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- fantasy leagues ----------

CREATE TABLE IF NOT EXISTS leagues (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  commissioner_id INTEGER NOT NULL REFERENCES users(id),
  invite_code     TEXT NOT NULL UNIQUE,
  max_teams       INTEGER NOT NULL DEFAULT 6,
  roster_size     INTEGER NOT NULL DEFAULT 10,
  pick_seconds    INTEGER NOT NULL DEFAULT 90,
  status          TEXT NOT NULL DEFAULT 'predraft' CHECK (status IN ('predraft','drafting','inseason')),
  draft_pick      INTEGER NOT NULL DEFAULT 1,  -- overall pick on the clock
  pick_deadline   INTEGER,                     -- ms epoch; NULL = paused or untimed
  draft_paused    INTEGER NOT NULL DEFAULT 0,
  start_week      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS league_scoring (
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  points     REAL NOT NULL,
  PRIMARY KEY (league_id, key)
);

CREATE TABLE IF NOT EXISTS fantasy_teams (
  id               INTEGER PRIMARY KEY,
  league_id        INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  draft_slot       INTEGER,
  waiver_priority  INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (league_id, user_id)
);

CREATE TABLE IF NOT EXISTS rosters (
  league_id    INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id      INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  acquired_at  INTEGER NOT NULL,
  PRIMARY KEY (league_id, player_id)
);

CREATE TABLE IF NOT EXISTS lineups (
  team_id    INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  week       INTEGER NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('QB','WR1','WR2','WR3','TE','C')),
  player_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, week, slot)
);

CREATE TABLE IF NOT EXISTS matchups (
  id            INTEGER PRIMARY KEY,
  league_id     INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week          INTEGER NOT NULL,
  home_team_id  INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  away_team_id  INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_picks (
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  overall    INTEGER NOT NULL,
  round      INTEGER NOT NULL,
  team_id    INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  auto       INTEGER NOT NULL DEFAULT 0,
  picked_at  INTEGER NOT NULL,
  PRIMARY KEY (league_id, overall)
);

-- players dropped since the last waiver run; they can only be claimed, not added
CREATE TABLE IF NOT EXISTS waiver_players (
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (league_id, player_id)
);

CREATE TABLE IF NOT EXISTS waiver_claims (
  id              INTEGER PRIMARY KEY,
  league_id       INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id         INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  add_player_id   INTEGER NOT NULL REFERENCES players(id),
  drop_player_id  INTEGER REFERENCES players(id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','cancelled')),
  note            TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id                INTEGER PRIMARY KEY,
  league_id         INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  proposer_team_id  INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  receiver_team_id  INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','rejected','cancelled','vetoed','failed')),
  message           TEXT,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER
);

CREATE TABLE IF NOT EXISTS trade_items (
  trade_id      INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  from_team_id  INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY,
  league_id   INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id     INTEGER REFERENCES fantasy_teams(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rosters_team ON rosters(team_id);
CREATE INDEX IF NOT EXISTS idx_matchups_league_week ON matchups(league_id, week);
CREATE INDEX IF NOT EXISTS idx_stats_week ON stats(week);
CREATE INDEX IF NOT EXISTS idx_tx_league ON transactions(league_id, created_at);
