PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  short     TEXT NOT NULL,
  color     TEXT NOT NULL,
  pin_hash  TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  position  TEXT NOT NULL CHECK (position IN ('QB','WR','TE','C')),
  team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS lineups (
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  week      INTEGER NOT NULL,
  slot      TEXT NOT NULL CHECK (slot IN ('QB','WR1','WR2','WR3','TE','C')),
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, week, slot)
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

CREATE TABLE IF NOT EXISTS scoring_rules (
  key    TEXT PRIMARY KEY,
  points REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS matchups (
  id            INTEGER PRIMARY KEY,
  week          INTEGER NOT NULL,
  home_team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weeks (
  week   INTEGER PRIMARY KEY,
  final  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
