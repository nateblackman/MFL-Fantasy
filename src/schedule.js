// Round-robin schedule via the circle method. With 6 teams that is 5 weeks of
// 3 games; longer seasons repeat the cycle with home/away flipped.

function roundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 === 1) ids.push(null); // bye
  const n = ids.length;
  const rounds = [];
  let rot = ids.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const circle = [ids[0], ...rot];
    const games = [];
    for (let i = 0; i < n / 2; i++) {
      const a = circle[i];
      const b = circle[n - 1 - i];
      if (a == null || b == null) continue;
      // alternate home/away so the fixed team isn't always home
      games.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(games);
    rot = [rot[rot.length - 1], ...rot.slice(0, -1)];
  }
  return rounds;
}

// Returns [{ week, home, away }] for weeks 1..seasonWeeks.
function buildSchedule(teamIds, seasonWeeks) {
  const rounds = roundRobin(teamIds);
  const out = [];
  for (let w = 0; w < seasonWeeks; w++) {
    const cycle = Math.floor(w / rounds.length);
    for (const [h, a] of rounds[w % rounds.length]) {
      out.push(cycle % 2 === 0 ? { week: w + 1, home: h, away: a } : { week: w + 1, home: a, away: h });
    }
  }
  return out;
}

module.exports = { roundRobin, buildSchedule };
