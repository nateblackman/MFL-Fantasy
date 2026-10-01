// Scoring is a straight linear sum: each stat column times its points-per-unit rule.

const STAT_FIELDS = [
  'pass_yds', 'pass_td', 'pass_int',
  'rush_yds', 'rush_td',
  'rec', 'rec_yds', 'rec_td',
  'fumbles_lost', 'two_pt',
  'bad_snaps', 'sacks_allowed',
];

const DEFAULT_RULES = {
  pass_yds: 0.04,      // 1 pt per 25 yds
  pass_td: 4,
  pass_int: -2,
  rush_yds: 0.1,       // 1 pt per 10 yds
  rush_td: 6,
  rec: 0.5,
  rec_yds: 0.1,
  rec_td: 6,
  fumbles_lost: -2,
  two_pt: 2,
  bad_snaps: -2,       // centers
  sacks_allowed: -1,   // centers
};

const STAT_LABELS = {
  pass_yds: 'Pass Yds', pass_td: 'Pass TD', pass_int: 'INT',
  rush_yds: 'Rush Yds', rush_td: 'Rush TD',
  rec: 'Rec', rec_yds: 'Rec Yds', rec_td: 'Rec TD',
  fumbles_lost: 'Fum Lost', two_pt: '2-Pt',
  bad_snaps: 'Bad Snaps', sacks_allowed: 'Sacks Alw',
};

const SLOTS = ['QB', 'WR1', 'WR2', 'WR3', 'TE', 'C'];

function slotPosition(slot) {
  return slot.replace(/\d+$/, '');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function playerPoints(stats, rules) {
  if (!stats) return 0;
  let total = 0;
  for (const f of STAT_FIELDS) {
    total += (Number(stats[f]) || 0) * (Number(rules[f]) || 0);
  }
  return round2(total);
}

// lineup: [{ slot, player_id }], statsByPlayer: Map(player_id -> stats row)
function lineupPoints(lineup, statsByPlayer, rules) {
  let total = 0;
  for (const { player_id } of lineup) {
    if (player_id != null) total += playerPoints(statsByPlayer.get(player_id), rules);
  }
  return round2(total);
}

module.exports = {
  STAT_FIELDS, DEFAULT_RULES, STAT_LABELS, SLOTS,
  slotPosition, playerPoints, lineupPoints, round2,
};
