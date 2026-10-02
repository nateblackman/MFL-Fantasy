// Roster moves after the draft: free-agent adds, drops, waiver claims and trades.
//
// Undrafted players are free agents and can be added instantly. A dropped player
// goes on waivers until the next waiver run; until then other teams can only
// put in claims. Claims are awarded in waiver-priority order, and a team that
// wins a claim moves to the back of the line.
const { tx } = require('./db');
const { bad, forbidden, notFound, conflict } = require('./errors');
const L = require('./leagues');
const season = require('./season');

function assertOpen(db, league) {
  if (league.status !== 'inseason') throw conflict('Roster moves open after the draft');
  if (!season.transactionsOpen(db)) throw conflict('Roster moves are paused while games are underway');
}

const getPlayer = (db, id) => {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(id));
  if (!p) throw notFound('Player not found');
  return p;
};
const ownerOf = (db, leagueId, playerId) =>
  db.prepare('SELECT team_id FROM rosters WHERE league_id = ? AND player_id = ?').get(leagueId, playerId)?.team_id ?? null;
const onWaivers = (db, leagueId, playerId) =>
  !!db.prepare('SELECT 1 FROM waiver_players WHERE league_id = ? AND player_id = ?').get(leagueId, playerId);

function dropFromRoster(db, league, team, player) {
  db.prepare('DELETE FROM rosters WHERE league_id = ? AND player_id = ?').run(league.id, player.id);
  db.prepare('INSERT OR IGNORE INTO waiver_players (league_id, player_id) VALUES (?, ?)').run(league.id, player.id);
}

function addToRoster(db, league, team, player) {
  db.prepare('INSERT INTO rosters (league_id, team_id, player_id, acquired_at) VALUES (?, ?, ?, ?)')
    .run(league.id, team.id, player.id, Date.now());
}

// Instant free-agent add, with an optional drop to make room.
function addFreeAgent(db, league, team, addId, dropId) {
  assertOpen(db, league);
  tx(db, () => {
    const add = getPlayer(db, addId);
    if (!add.active) throw bad(`${add.name} is inactive`);
    if (ownerOf(db, league.id, add.id) != null) throw conflict(`${add.name} is already on a roster`);
    if (onWaivers(db, league.id, add.id)) throw conflict(`${add.name} is on waivers. Put in a claim instead.`);
    let drop = null;
    if (dropId) {
      drop = getPlayer(db, dropId);
      if (ownerOf(db, league.id, drop.id) !== team.id) throw bad(`${drop.name} is not on your roster`);
    }
    if (L.rosterCount(db, team.id) - (drop ? 1 : 0) + 1 > league.roster_size) {
      throw conflict(`Your roster is full (${league.roster_size}). Choose a player to drop.`);
    }
    if (drop) dropFromRoster(db, league, team, drop);
    addToRoster(db, league, team, add);
    L.logTx(db, league.id, team.id, 'add', `${team.name} added ${add.name}${drop ? ` and dropped ${drop.name}` : ''}`);
  });
}

function dropPlayer(db, league, team, playerId) {
  assertOpen(db, league);
  tx(db, () => {
    const p = getPlayer(db, playerId);
    if (ownerOf(db, league.id, p.id) !== team.id) throw bad(`${p.name} is not on your roster`);
    dropFromRoster(db, league, team, p);
    L.logTx(db, league.id, team.id, 'drop', `${team.name} dropped ${p.name}`);
  });
}

// ---------- waivers ----------

function createClaim(db, league, team, addId, dropId) {
  assertOpen(db, league);
  const add = getPlayer(db, addId);
  if (ownerOf(db, league.id, add.id) != null) throw conflict(`${add.name} is already on a roster`);
  if (!onWaivers(db, league.id, add.id)) throw conflict(`${add.name} is a free agent, so add them directly instead.`);
  if (dropId != null && dropId !== '') {
    const drop = getPlayer(db, dropId);
    if (ownerOf(db, league.id, drop.id) !== team.id) throw bad(`${drop.name} is not on your roster`);
  } else if (L.rosterCount(db, team.id) >= league.roster_size) {
    throw conflict('Your roster is full. Choose a player to drop if the claim wins.');
  }
  if (db.prepare("SELECT 1 FROM waiver_claims WHERE team_id = ? AND add_player_id = ? AND status = 'pending'").get(team.id, add.id)) {
    throw conflict(`You already have a claim on ${add.name}`);
  }
  db.prepare('INSERT INTO waiver_claims (league_id, team_id, add_player_id, drop_player_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(league.id, team.id, add.id, dropId ? Number(dropId) : null, Date.now());
}

function cancelClaim(db, league, team, claimId) {
  const r = db.prepare("UPDATE waiver_claims SET status = 'cancelled' WHERE id = ? AND team_id = ? AND status = 'pending'")
    .run(Number(claimId), team.id);
  if (!r.changes) throw notFound('Claim not found');
}

function listClaims(db, team) {
  return db.prepare(`SELECT c.id, c.status, c.note, c.created_at, a.name AS add_name, a.id AS add_id, d.name AS drop_name
    FROM waiver_claims c JOIN players a ON a.id = c.add_player_id LEFT JOIN players d ON d.id = c.drop_player_id
    WHERE c.team_id = ? ORDER BY c.status = 'pending' DESC, c.created_at DESC LIMIT 30`).all(team.id);
}

function processWaivers(db, league) {
  if (league.status !== 'inseason') return { awarded: 0 };
  return tx(db, () => {
    const teams = () => db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? ORDER BY waiver_priority, id').all(league.id);
    const pendingFor = db.prepare("SELECT * FROM waiver_claims WHERE team_id = ? AND status = 'pending' ORDER BY created_at, id");
    const setStatus = db.prepare('UPDATE waiver_claims SET status = ?, note = ? WHERE id = ?');
    let awarded = 0;

    for (;;) {
      let winner = null;
      for (const team of teams()) {
        for (const c of pendingFor.all(team.id)) {
          const addFree = ownerOf(db, league.id, c.add_player_id) == null;
          const dropOk = c.drop_player_id == null || ownerOf(db, league.id, c.drop_player_id) === team.id;
          const room = L.rosterCount(db, team.id) - (c.drop_player_id ? 1 : 0) + 1 <= league.roster_size;
          if (addFree && dropOk && room) { winner = { team, claim: c }; break; }
        }
        if (winner) break;
      }
      if (!winner) break;

      const { team, claim } = winner;
      const add = getPlayer(db, claim.add_player_id);
      const drop = claim.drop_player_id ? getPlayer(db, claim.drop_player_id) : null;
      if (drop) db.prepare('DELETE FROM rosters WHERE league_id = ? AND player_id = ?').run(league.id, drop.id);
      addToRoster(db, league, team, add);
      setStatus.run('won', null, claim.id);
      db.prepare("UPDATE waiver_claims SET status = 'lost', note = ? WHERE league_id = ? AND add_player_id = ? AND status = 'pending'")
        .run(`Claimed by ${team.name}`, league.id, add.id);
      // winner goes to the back of the line
      const order = teams().filter((t) => t.id !== team.id).concat(team);
      order.forEach((t, i) => db.prepare('UPDATE fantasy_teams SET waiver_priority = ? WHERE id = ?').run(i + 1, t.id));
      L.logTx(db, league.id, team.id, 'waiver', `${team.name} claimed ${add.name} off waivers${drop ? ` and dropped ${drop.name}` : ''}`);
      awarded++;
    }

    db.prepare("UPDATE waiver_claims SET status = 'lost', note = 'Not valid when waivers ran' WHERE league_id = ? AND status = 'pending'")
      .run(league.id);
    db.prepare('DELETE FROM waiver_players WHERE league_id = ?').run(league.id);
    L.logTx(db, league.id, null, 'waiver', `Waivers processed (${awarded} claim${awarded === 1 ? '' : 's'} awarded)`);
    return { awarded };
  });
}

function processAllWaivers(db) {
  for (const league of db.prepare("SELECT * FROM leagues WHERE status = 'inseason'").all()) processWaivers(db, league);
}

// ---------- trades ----------

function proposeTrade(db, league, fromTeam, b) {
  assertOpen(db, league);
  const toTeam = L.getTeam(db, league.id, b.to_team_id);
  if (toTeam.id === fromTeam.id) throw bad("You can't trade with yourself");
  const give = [...new Set((b.give || []).map(Number))];
  const get = [...new Set((b.get || []).map(Number))];
  if (!give.length && !get.length) throw bad('Pick at least one player');
  for (const id of give) if (ownerOf(db, league.id, id) !== fromTeam.id) throw bad('You can only offer players on your roster');
  for (const id of get) if (ownerOf(db, league.id, id) !== toTeam.id) throw bad(`You can only ask for players on ${toTeam.name}`);

  return tx(db, () => {
    const r = db.prepare('INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(league.id, fromTeam.id, toTeam.id, String(b.message || '').slice(0, 280) || null, Date.now());
    const tradeId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO trade_items (trade_id, player_id, from_team_id) VALUES (?, ?, ?)');
    for (const id of give) ins.run(tradeId, id, fromTeam.id);
    for (const id of get) ins.run(tradeId, id, toTeam.id);
    return tradeId;
  });
}

function getTrade(db, league, tradeId) {
  const t = db.prepare('SELECT * FROM trades WHERE id = ? AND league_id = ?').get(Number(tradeId), league.id);
  if (!t) throw notFound('Trade not found');
  t.items = db.prepare(`SELECT i.player_id, i.from_team_id, p.name, p.position FROM trade_items i
    JOIN players p ON p.id = i.player_id WHERE i.trade_id = ?`).all(t.id);
  return t;
}

function listTrades(db, league, team, isCommish) {
  const rows = db.prepare(`SELECT id FROM trades WHERE league_id = ?
    AND (? OR proposer_team_id = ? OR receiver_team_id = ?) ORDER BY status = 'pending' DESC, created_at DESC LIMIT 50`)
    .all(league.id, isCommish ? 1 : 0, team?.id ?? -1, team?.id ?? -1);
  return rows.map((r) => getTrade(db, league, r.id));
}

function respondTrade(db, league, ctx, tradeId, action) {
  return tx(db, () => {
    const t = getTrade(db, league, tradeId);
    if (t.status !== 'pending') throw conflict('This trade is no longer pending');
    const myId = ctx.team?.id;
    const finish = (status) => db.prepare('UPDATE trades SET status = ?, resolved_at = ? WHERE id = ?').run(status, Date.now(), t.id);
    const names = (teamId) => t.items.filter((i) => i.from_team_id === teamId).map((i) => i.name).join(', ') || 'nothing';
    const proposer = L.getTeam(db, league.id, t.proposer_team_id);
    const receiver = L.getTeam(db, league.id, t.receiver_team_id);

    if (action === 'cancel') {
      if (myId !== t.proposer_team_id) throw forbidden('Only the team that proposed it can cancel');
      return finish('cancelled');
    }
    if (action === 'reject') {
      if (myId !== t.receiver_team_id) throw forbidden('Only the receiving team can reject');
      return finish('rejected');
    }
    if (action === 'veto') {
      L.requireCommish(ctx);
      finish('vetoed');
      L.logTx(db, league.id, null, 'trade', `The commissioner vetoed a trade between ${proposer.name} and ${receiver.name}`);
      return;
    }
    if (action !== 'accept') throw bad('Unknown action');
    if (myId !== t.receiver_team_id) throw forbidden('Only the receiving team can accept');
    assertOpen(db, league);

    for (const i of t.items) {
      if (ownerOf(db, league.id, i.player_id) !== i.from_team_id) {
        finish('failed');
        return { failed: `${i.name} is no longer on that roster, so the trade can't go through` };
      }
    }
    for (const team of [proposer, receiver]) {
      const out = t.items.filter((i) => i.from_team_id === team.id).length;
      const inn = t.items.length - out;
      if (L.rosterCount(db, team.id) - out + inn > league.roster_size) {
        throw conflict(`${team.name} would have too many players. They need to drop someone first.`);
      }
    }
    const move = db.prepare('UPDATE rosters SET team_id = ?, acquired_at = ? WHERE league_id = ? AND player_id = ?');
    for (const i of t.items) {
      move.run(i.from_team_id === proposer.id ? receiver.id : proposer.id, Date.now(), league.id, i.player_id);
    }
    finish('accepted');
    L.logTx(db, league.id, null, 'trade', `Trade: ${proposer.name} sent ${names(proposer.id)} to ${receiver.name} for ${names(receiver.id)}`);
  });
}

module.exports = {
  addFreeAgent, dropPlayer, createClaim, cancelClaim, listClaims, processWaivers, processAllWaivers,
  proposeTrade, listTrades, respondTrade, ownerOf, onWaivers,
};
