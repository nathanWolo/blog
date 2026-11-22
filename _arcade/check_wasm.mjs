// Plays the Arcade's built engines (assets/wasm/*.wasm) under Node and checks every position on
// the way. The modules are loaded by the page's own loader (assets/js/arcade/engine-loader.js), so
// an engine that starts to import something the page does not supply fails here, not in a browser.
// The arcade-engines workflow runs this after a rebuild (see README.md).
//
//   node _arcade/check_wasm.mjs tronzero | slinky | crossfish | poker   (one or more)
//   node _arcade/check_wasm.mjs slinky-moves <mode> <snakes> <seed> <sims>
//       prints one game's moves and its final state exactly as, in _arcade/slinky,
//       `cargo run --release --example play -- <weights> <mode> <snakes> <seed> <sims>` does
//       natively, so that diff can compare the two builds.
//
// Exits 1 with a message at the first failed check. Needs Node 20 or newer; the poker module also
// needs WebAssembly exception handling as Emscripten emits it, which the Node that Emscripten
// brings has.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const file = (path) => readFileSync(new URL(path, ROOT));

function check(ok, message) {
  if (!ok) throw new Error(message);
}

// The loader is a worker script. Run it as one, with fetch() reading from the repository.
vm.runInThisContext(file('assets/js/arcade/engine-loader.js').toString(), { filename: 'engine-loader.js' });
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new Uint8Array(readFileSync(url)).buffer,
});

async function load(name) {
  const path = `assets/wasm/${name}.wasm`;
  // The loader gives an import it does not know a stub that fails when called. Here it fails now.
  const supplied = Object.keys(wasiFunctions(() => null));
  for (const item of WebAssembly.Module.imports(await WebAssembly.compile(file(path)))) {
    const known = item.kind === 'function' && (
      (item.module === 'wasi_snapshot_preview1' && supplied.includes(item.name)) ||
      (item.module === 'env' && ['now_ms', 'emscripten_notify_memory_growth'].includes(item.name)));
    check(known, `${path} imports ${item.module}.${item.name} (${item.kind}), which engine-loader.js does not supply`);
  }
  return loadEngine(new URL(path, ROOT));
}

const decoder = new TextDecoder();
// The module's memory can grow, so always look at its current buffer.
const text = (engine, ptr, len) => decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));

// A small repeatable generator: random(n) is 0..n-1.
function generator(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
}

// ---------------------------------------------------------------- Tron: tronzero.wasm
// The engine plays every seat of a 2-player and a 4-player game, as the crate's native tests do.
async function tronzero() {
  const e = await load('tronzero');
  const DX = [0, 0, -1, 1], DY = [-1, 1, 0, 0];   // up, down, left, right; y grows downward
  const STARTS = [[5, 5], [24, 14], [24, 5], [5, 14]];
  for (const [players, sims] of [[2, 200], [4, 100]]) {
    check(e.tron_new_game(30, 20, players) === 1, 'tron_new_game refused a 30 x 20 board');
    const trails = STARTS.slice(0, players).map((start) => [start]);
    trails.forEach((trail, p) => check(e.tron_spawn(p, trail[0][0], trail[0][1]) === 1, `tron_spawn refused player ${p}`));
    let moves = 0, searched = 0;
    while (!e.tron_over()) {
      const p = e.tron_to_move();
      check(p >= 0 && p < players && e.tron_alive(p) === 1, `the player to move is ${p}`);
      const taken = new Set();   // a bike that is out takes its trail off the board
      trails.forEach((trail, q) => { if (e.tron_alive(q)) trail.forEach(([x, y]) => taken.add(y * 30 + x)); });
      check(e.tron_think_sims((p + 1) % players, 10) === -1, 'the engine answered for a player out of turn');
      check(e.tron_play((p + 1) % players, 0) === 0, 'a move out of turn was accepted');
      // Mostly a fixed number of simulations; every fifth move is on the clock, as on the page.
      const dir = moves % 5 === 4 ? e.tron_think(p, 20) : e.tron_think_sims(p, sims);
      check(dir >= 0 && dir < 4, `no move for player ${p} (${dir})`);
      searched += e.tron_last_sims();
      const [hx, hy] = trails[p][trails[p].length - 1];
      const x = hx + DX[dir], y = hy + DY[dir];
      check(x >= 0 && x < 30 && y >= 0 && y < 20 && !taken.has(y * 30 + x), `player ${p} was sent into a wall at ${x},${y}`);
      check(e.tron_play(p, dir) === 1, `tron_play refused the engine's own move for player ${p}`);
      trails[p].push([x, y]);
      check(++moves < 700, 'the game did not end');
    }
    const alive = trails.map((_, q) => q).filter((q) => e.tron_alive(q));
    check(alive.length === 1 && e.tron_winner() === alive[0], `the game ended with ${alive.length} players left`);
    check(e.tron_to_move() === -1 && e.tron_think_sims(alive[0], 10) === -1, 'the engine still moves after the end');
    check(searched > 0, 'no search ran');
    console.log(`tronzero: ${players} players, ${moves} moves, player ${alive[0]} wins`);
  }
}

// ---------------------------------------------------------------- Battlesnake: slinky.wasm
async function slinkyEngine() {
  const e = await load('slinky');
  const copyIn = (bytes) => {
    const ptr = e.bs_alloc(bytes.length);
    new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  };
  const config = copyIn(file('assets/wasm/slinky-weights/config.json'));
  const params = copyIn(file('assets/wasm/slinky-weights/params.npz'));
  const failed = e.bs_init(...config, ...params);
  check(!failed, 'bs_init: ' + text(e, e.bs_error_ptr(), e.bs_error_len()));
  e.bs_free(...config);
  e.bs_free(...params);
  return e;
}

// One game with every snake steered by the agent at a fixed number of simulations.
// Returns a row of moves per turn (-1 for a snake that is out) and the final state's text.
function slinkyGame(e, mode, snakes, seed, sims) {
  const error = () => text(e, e.bs_error_ptr(), e.bs_error_len());
  const state = () => text(e, e.bs_state_ptr(), e.bs_state_len());
  const s = BigInt(seed);
  check(e.bs_new_game(mode, snakes, Number(s & 0xffffffffn), Number((s >> 32n) & 0xffffffffn)) === 0, 'bs_new_game: ' + error());
  const rows = [];
  for (;;) {
    const position = state(), before = JSON.parse(position);
    check(before.turn === rows.length && !before.over && before.snakes.length === snakes, `unexpected state at turn ${rows.length}`);
    const moves = [0, 0, 0, 0];
    for (let i = 0; i < snakes; i++) {
      moves[i] = e.bs_think(i, sims, 0);
      if (before.snakes[i].alive) {
        check(moves[i] >= 0 && moves[i] < 4, `snake ${i} got no move at turn ${before.turn}: ${error()}`);
        check(e.bs_last_sims() === sims, `snake ${i} searched ${e.bs_last_sims()} simulations, not ${sims}`);
      } else {
        check(moves[i] === -1, `snake ${i} is out but got move ${moves[i]}`);
      }
    }
    check(state() === position, 'thinking changed the game');
    rows.push(moves);
    const over = e.bs_step(...moves);
    check(over === 0 || over === 1, 'bs_step: ' + error());
    if (over) break;
    check(rows.length < 2000, 'the game did not end');
  }
  return { rows, final: state() };
}

async function slinky() {
  const e = await slinkyEngine();
  const MODES = ['standard', 'duel', 'royale', 'constrictor'];
  for (const [mode, snakes, seed, sims] of [[1, 2, 7, 32], [0, 4, 12345, 32], [2, 3, 99, 16], [3, 2, 99, 16]]) {
    const { rows, final } = slinkyGame(e, mode, snakes, seed, sims);
    const end = JSON.parse(final);
    const alive = end.snakes.map((snake, i) => (snake.alive ? i : -1)).filter((i) => i >= 0);
    check(end.over && end.mode === MODES[mode] && end.turn === rows.length, 'the final state does not match the game played');
    check(alive.length <= 1 && end.winner === (alive.length ? alive[0] : -1), `winner ${end.winner} with ${alive.length} snakes left`);
    check(e.bs_think(0, sims, 0) === -1 && e.bs_step(0, 0, 0, 0) === -1, 'the game goes on after its end');
    console.log(`slinky: ${MODES[mode]}, ${snakes} snakes, ${rows.length} turns, winner ${end.winner}`);
  }
  // On the clock, as the page asks.
  check(e.bs_new_game(1, 2, 4, 0) === 0, 'bs_new_game refused a duel');
  const move = e.bs_think(1, 0, 60);
  check(move >= 0 && move < 4 && e.bs_last_sims() > 1, `a 60 ms search gave move ${move} after ${e.bs_last_sims()} simulations`);
  console.log(`slinky: 60 ms search, ${e.bs_last_sims()} simulations`);
}

async function slinkyMoves(mode, snakes, seed, sims) {
  const e = await slinkyEngine();
  const { rows, final } = slinkyGame(e, Number(mode), Number(snakes), seed, Number(sims));
  rows.forEach((row, turn) => console.log(`${turn} ${row.join(' ')}`));
  console.log(final);
}

// ---------------------------------------------------------------- Ultimate Tic-Tac-Toe: crossfish.wasm
// The engine against random legal moves, once as each side.
async function crossfish() {
  const e = await load('crossfish');
  const random = generator(20261121);
  for (const engineSide of [0, 1]) {
    e.cf_new();
    let moves = 0;
    while (e.cf_winner() === -1) {
      const legal = [];
      for (let b = 0; b < 9; b++) {
        const mask = e.cf_legal(b);
        for (let c = 0; c < 9; c++) if ((mask >> c) & 1) legal.push(b * 9 + c);
      }
      check(legal.length > 0, 'no legal move in an unfinished game');
      check(e.cf_to_move() === moves % 2, 'cf_to_move is out of step');
      let move;
      if (moves % 2 === engineSide) {
        move = e.cf_think(30);
        check(legal.includes(move), `the engine chose ${move}, which is not legal`);
        check(moves > 0 || move === 40, `the engine opened with ${move}, not the centre`);
        check(e.cf_last_depth() >= 1 && e.cf_last_nodes() > 0, 'the search reported no work');
      } else {
        move = legal[random(legal.length)];
      }
      // A cell that is not offered is refused and nothing changes.
      for (let other = 0; other < 81; other++) {
        if (legal.includes(other)) continue;
        check(e.cf_play(Math.floor(other / 9), other % 9) === 0, `cf_play accepted ${other}, which is not legal`);
        break;
      }
      check(e.cf_play(Math.floor(move / 9), move % 9) === 1, `cf_play refused the legal move ${move}`);
      check(e.cf_cell(Math.floor(move / 9), move % 9) === 1 + (moves % 2), `move ${move} is not on the board`);
      moves++;
      let marks = 0;
      for (let cell = 0; cell < 81; cell++) marks += e.cf_cell(Math.floor(cell / 9), cell % 9) !== 0;
      check(marks === moves, `${marks} marks on the board after ${moves} moves`);
    }
    const winner = e.cf_winner();
    check(winner >= 0 && winner <= 2, `cf_winner is ${winner}`);
    check(e.cf_think(30) === -1, 'the engine still moves after the end');
    console.log(`crossfish: engine as ${'XO'[engineSide]}, ${moves} moves, result: ${['X wins', 'O wins', 'draw'][winner]}`);
  }
}

// ---------------------------------------------------------------- Poker: poker.wasm
// Whole sit-and-go games. Seat 0 follows a script (a repeatable mix of every kind of action, legal
// and not); the bots play the other seats with a fixed number of trials, so a game is repeatable.
// Checked at every step: the 4,800 chips are all there, what the page is offered is accepted and
// everything else refused without a change, and each hand's winnings add up to its losses.
// (While a hand runs the chips are the stacks plus what is in the pot; once it is over the pot has
// been paid into the stacks, and the state goes on showing what each player had put in.)
async function poker() {
  const e = await load('poker');
  const CHIPS = 4800;
  const raw = () => text(e, e.pk_state_ptr(), e.pk_state_len());
  const error = () => text(e, e.pk_error_ptr(), e.pk_error_len());
  const sum = (list, value) => list.reduce((total, item) => total + value(item), 0);
  check(e.pk_init() === 0, 'pk_init: ' + error());
  e.pk_set_budget(0, 256);

  function chips(s, players) {
    const settled = s.status !== 'running';
    check(s.players.length === players && s.n === players, `${s.players.length} players in a ${players}-player game`);
    for (const p of s.players) {
      check(p.stack >= 0 && p.bet >= 0 && p.total >= p.bet, `${p.name}: stack ${p.stack}, bet ${p.bet}, in the pot ${p.total}`);
    }
    const all = sum(s.players, (p) => p.stack + (settled ? 0 : p.total));
    check(all === CHIPS, `hand ${s.hand}, ${s.status}: ${all} chips at the table, not ${CHIPS}`);
    check(s.pot === sum(s.players, (p) => p.total), `hand ${s.hand}: the pot is ${s.pot} but the players put in ${sum(s.players, (p) => p.total)}`);
  }

  function game(players, seed) {
    const random = generator(seed);
    check(e.pk_new_game(players, seed, 0) === 0, 'pk_new_game: ' + error());
    let hands = 0, acted = 0, refused = 0;
    for (let steps = 0; ; steps++) {
      check(steps < 200000, 'the game did not end');
      const status = e.pk_step();
      check(status >= 0 && status <= 3, 'pk_step: ' + error());
      const s = JSON.parse(raw());
      chips(s, players);

      if (status === 0) {
        check(s.status === 'running' && s.options === null, 'options are offered while the game moves on by itself');
      } else if (status === 2) {
        check(s.status === 'hand_over' && s.result && s.result.hand === s.hand, `hand ${s.hand} ended without a result`);
        const seated = s.result.players.filter((p) => !p.out);
        check(sum(seated, (p) => p.net) === 0, `hand ${s.hand}: winnings and losses differ by ${sum(seated, (p) => p.net)}`);
        check(seated.every((p) => p.cards.length === 2 && !p.cards.includes('??')), `hand ${s.hand}: hidden cards in the result`);
        check(e.pk_act(1, 0) === -1 && e.pk_step() === 2, 'the finished hand still takes actions');
        check(e.pk_next_hand() === 0, 'pk_next_hand: ' + error());
        hands++;
      } else if (status === 3) {
        check(s.status === 'game_over' && s.options === null, 'the game is over but its state says otherwise');
        const last = s.events[s.events.length - 1];
        check(last && last.text.startsWith('Game over: '), 'no final ranking in the hand log');
        check(e.pk_step() === 3 && e.pk_next_hand() === -1 && e.pk_act(0, 0) === -1, 'the game goes on after its end');
        return { hands: hands + 1, acted, refused, ranking: last.text, final: raw() };
      } else {
        // Seat 0 has to act.
        const o = s.options, me = s.players[0];
        check(s.status === 'running' && s.acting === 0 && o, 'waiting for seat 0 without options');
        check(!me.folded && !me.out && me.stack > 0 && me.cards.length === 2, 'seat 0 is asked to act but is not in the hand');
        check(o.rnd === me.bet && o.allin_to === me.bet + me.stack && o.pot === s.pot && o.bb === s.bb, 'the options do not match the table');
        check(!o.raise_min_to || (o.raise_min_to > o.rnd && o.raise_min_to <= o.raise_max_to && o.raise_max_to === o.allin_to - 1),
          `raise range ${o.raise_min_to} to ${o.raise_max_to} with all-in at ${o.allin_to}`);
        check(o.fold || o.check || o.call || o.allin, 'nothing is offered');

        // What is not offered is refused, and the state stays as it was.
        const before = raw();
        const illegal = [[5, 0], [-1, 0]];
        if (!o.fold) illegal.push([0, 0]);
        if (!o.check) illegal.push([1, 0]);
        if (!o.call) illegal.push([2, 0]);
        if (!o.allin) illegal.push([3, 0]);
        if (o.raise_min_to) illegal.push([4, o.raise_min_to - 1], [4, o.allin_to + 1], [4, o.rnd]);
        else illegal.push([4, o.allin_to - 1], [4, o.rnd + 2 * o.bb]);
        for (const [kind, amount] of illegal) {
          check(e.pk_act(kind, amount) === -1, `hand ${s.hand}: action ${kind} to ${amount} was accepted though it is not offered`);
          check(raw() === before, `hand ${s.hand}: a refused action changed the game`);
          refused++;
        }

        // One of the offered actions, checks and calls most often.
        const offered = [];
        const add = (times, kind, amount) => { for (let i = 0; i < times; i++) offered.push([kind, amount]); };
        if (o.fold && !o.check) add(2, 0, 0);
        if (o.check) add(8, 1, 0);
        if (o.call) add(7, 2, 0);
        if (o.allin) add(1, 3, 0);
        if (o.raise_min_to) {
          add(2, 4, o.raise_min_to);
          add(1, 4, o.raise_max_to);
          add(2, 4, o.raise_min_to + random(o.raise_max_to - o.raise_min_to + 1));
          if (o.allin) add(1, 4, o.allin_to);   // raising to exactly everything is an all-in
        }
        const [kind, amount] = offered[random(offered.length)];
        check(e.pk_act(kind, amount) === 0, `hand ${s.hand}: the offered action ${kind} to ${amount} was refused`);
        acted++;
        const after = JSON.parse(raw());
        chips(after, players);
        const now = after.players[0];
        const allIn = kind === 3 || (kind === 4 && amount === o.allin_to);
        if (kind === 0) check(now.folded && now.stack === me.stack, 'the fold did not register');
        else if (kind === 1) check(now.bet === me.bet && now.stack === me.stack, 'the check moved chips');
        else if (kind === 2) check(now.bet === me.bet + o.call && now.stack === me.stack - o.call, `the call is not ${o.call}`);
        else if (allIn) check(now.stack === 0 && now.bet === o.allin_to && now.allin, 'the all-in did not put everything in');
        else check(now.bet === amount && now.stack === me.stack - (amount - me.bet), `the raise is not to ${amount}`);
      }
    }
  }

  for (const [players, seed] of [[2, 111], [3, 333], [4, 555], [4, 777]]) {
    const g = game(players, seed);
    console.log(`poker: ${players} players, seed ${seed}: ${g.hands} hands, ${g.acted} actions by seat 0, ${g.refused} refusals. ${g.ranking}`);
  }
  // The same seed and the same script give the same game, to the byte.
  check(game(3, 2026).final === game(3, 2026).final, 'the same seed and actions gave two different games');
  console.log('poker: a replayed game is identical');
}

// ----------------------------------------------------------------
const CHECKS = { tronzero, slinky, crossfish, poker };
const [what, ...rest] = process.argv.slice(2);
try {
  if (what === 'slinky-moves' && rest.length === 4) {
    await slinkyMoves(...rest);
  } else {
    const names = [what, ...rest];
    check(what && names.every((name) => CHECKS[name]), 'usage: check_wasm.mjs tronzero|slinky|crossfish|poker ...  |  slinky-moves <mode> <snakes> <seed> <sims>');
    for (const name of names) await CHECKS[name]();
  }
} catch (error) {
  console.error('FAILED: ' + error.message);
  process.exit(1);
}
