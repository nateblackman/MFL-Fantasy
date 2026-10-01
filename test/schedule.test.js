const test = require('node:test');
const assert = require('node:assert');
const { buildSchedule } = require('../src/schedule');

const TEAMS = [1, 2, 3, 4, 5, 6];
const key = (a, b) => [a, b].sort().join('-');

test('every pair meets exactly once in 5 weeks', () => {
  const games = buildSchedule(TEAMS, 5);
  assert.strictEqual(games.length, 15);
  const pairs = new Set(games.map((g) => key(g.home, g.away)));
  assert.strictEqual(pairs.size, 15);
});

test('no team plays twice in a week', () => {
  const games = buildSchedule(TEAMS, 10);
  for (let w = 1; w <= 10; w++) {
    const teams = games.filter((g) => g.week === w).flatMap((g) => [g.home, g.away]);
    assert.strictEqual(teams.length, 6);
    assert.strictEqual(new Set(teams).size, 6);
  }
});

test('second cycle flips home and away', () => {
  const games = buildSchedule(TEAMS, 10);
  const first = games.filter((g) => g.week === 1);
  const sixth = games.filter((g) => g.week === 6);
  assert.deepStrictEqual(sixth.map((g) => [g.away, g.home]), first.map((g) => [g.home, g.away]));
});

test('home games are balanced over a cycle', () => {
  const counts = new Map();
  for (const g of buildSchedule(TEAMS, 10)) counts.set(g.home, (counts.get(g.home) || 0) + 1);
  for (const t of TEAMS) assert.strictEqual(counts.get(t), 5);
});
