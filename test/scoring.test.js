const test = require('node:test');
const assert = require('node:assert');
const { playerPoints, lineupPoints, DEFAULT_RULES, slotPosition } = require('../src/scoring');

test('QB line scores with default rules', () => {
  // 250 yds (10) + 3 TD (12) + 1 INT (-2) + 20 rush yds (2)
  const pts = playerPoints({ pass_yds: 250, pass_td: 3, pass_int: 1, rush_yds: 20 }, DEFAULT_RULES);
  assert.strictEqual(pts, 22);
});

test('WR line scores with half-PPR', () => {
  // 7 rec (3.5) + 95 yds (9.5) + 1 TD (6)
  assert.strictEqual(playerPoints({ rec: 7, rec_yds: 95, rec_td: 1 }, DEFAULT_RULES), 19);
});

test('center penalties apply', () => {
  assert.strictEqual(playerPoints({ bad_snaps: 1, sacks_allowed: 2 }, DEFAULT_RULES), -4);
});

test('missing stats are zero points', () => {
  assert.strictEqual(playerPoints(null, DEFAULT_RULES), 0);
});

test('lineupPoints sums starters and ignores empty slots', () => {
  const stats = new Map([[1, { pass_td: 1 }], [2, { rec_td: 1 }]]);
  const lineup = [{ slot: 'QB', player_id: 1 }, { slot: 'WR1', player_id: 2 }, { slot: 'WR2', player_id: null }];
  assert.strictEqual(lineupPoints(lineup, stats, DEFAULT_RULES), 10);
});

test('slotPosition strips the slot number', () => {
  assert.strictEqual(slotPosition('WR3'), 'WR');
  assert.strictEqual(slotPosition('C'), 'C');
});
