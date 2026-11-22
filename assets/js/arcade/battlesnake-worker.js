/*
 * Runs the Battlesnake game and its agents off the main thread for the
 * arcade's Battlesnake page (battlesnake.js).
 *
 * The WebAssembly module (assets/wasm/slinky.wasm, built from _arcade/slinky/)
 * holds both the game itself (the rules, the food, the hazards) and the agent,
 * AlphaSlinky, from github.com/nathanWolo/slinky. Snake 0 is the visitor;
 * every other snake is steered by the agent. The network's weights are
 * fetched once and handed to the module.
 *
 * Battlesnake turns are simultaneous, so the agents do not wait to see what
 * the visitor does: as soon as a position is known they choose their moves for
 * it, and those moves are held until the visitor's arrives.
 *
 * Messages in:
 *   { type: 'new', game, mode, snakes, budget }
 *       mode is 0 standard, 1 duel, 2 royale, 3 constrictor.
 *   { type: 'turn', game, move, budget }
 *       move is the visitor's: 0 up, 1 down, 2 left, 3 right (ignored once
 *       their snake is out).
 *   budget is the thinking time, in milliseconds, each agent gets for the
 *   position that follows.
 *
 * Messages out:
 *   { type: 'state', game, state, moves, sims }
 *       state is the position (see _arcade/slinky/README.md for its shape).
 *       After a turn, moves lists the move each snake made to reach it (-1
 *       for a snake that was already out), and sims is how many simulations
 *       the agents ran, in total, to choose theirs.
 *   { type: 'error', game, message }
 */
'use strict';

importScripts('engine-loader.js');

var WASM = '../../wasm/slinky.wasm';
var WEIGHTS = '../../wasm/slinky-weights/';

var engine = null;
var starting = null;    // promise: the module is loaded and has its weights
var decoder = new TextDecoder();

var current = null;     // { state, moves, sims } for the game in progress

function fetchBytes(path) {
  return fetch(new URL(path, self.location.href)).then(function (response) {
    if (!response.ok) throw new Error(path.split('/').pop() + ': HTTP ' + response.status);
    return response.arrayBuffer();
  });
}

// The module's memory can grow, so always look at its current buffer.
function readText(ptr, len) {
  return decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
}

function lastError() {
  return readText(engine.bs_error_ptr(), engine.bs_error_len()) || 'the engine reported an error';
}

function copyIn(buffer) {
  var bytes = new Uint8Array(buffer);
  var ptr = engine.bs_alloc(bytes.length);
  new Uint8Array(engine.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr: ptr, len: bytes.length };
}

function start() {
  if (!starting) {
    starting = Promise.all([
      loadEngine(new URL(WASM, self.location.href)),
      fetchBytes(WEIGHTS + 'config.json'),
      fetchBytes(WEIGHTS + 'params.npz')
    ]).then(function (parts) {
      engine = parts[0];
      var config = copyIn(parts[1]), params = copyIn(parts[2]);
      var failed = engine.bs_init(config.ptr, config.len, params.ptr, params.len);
      engine.bs_free(config.ptr, config.len);
      engine.bs_free(params.ptr, params.len);
      if (failed) throw new Error(lastError());
    });
  }
  return starting;
}

function readState() {
  return JSON.parse(readText(engine.bs_state_ptr(), engine.bs_state_len()));
}

// Choose every agent's move for the current position.
function think(budget) {
  current.moves = [-1, -1, -1, -1];
  current.sims = 0;
  if (current.state.over) return;
  for (var i = 1; i < current.state.snakes.length; i++) {
    if (!current.state.snakes[i].alive) continue;
    var move = engine.bs_think(i, 0, budget);
    if (move < 0) throw new Error(lastError());
    current.moves[i] = move;
    current.sims += engine.bs_last_sims();
  }
}

function handle(msg) {
  if (msg.type === 'new') {
    return start().then(function () {
      var seed = new Uint32Array(2);
      crypto.getRandomValues(seed);
      if (engine.bs_new_game(msg.mode, msg.snakes, seed[0], seed[1])) throw new Error(lastError());
      current = { state: readState(), moves: [-1, -1, -1, -1], sims: 0 };
      self.postMessage({ type: 'state', game: msg.game, state: current.state, sims: 0 });
      think(msg.budget);
    });
  }
  if (msg.type === 'turn') {
    if (!current) throw new Error('no game in progress');
    var moves = [msg.move, current.moves[1], current.moves[2], current.moves[3]];
    if (engine.bs_step(moves[0], moves[1], moves[2], moves[3]) < 0) throw new Error(lastError());
    var sims = current.sims;
    current.state = readState();
    self.postMessage({ type: 'state', game: msg.game, state: current.state, moves: moves, sims: sims });
    think(msg.budget);
  }
}

// Messages are handled strictly in the order they arrive, even while the
// engine is still loading.
var queue = Promise.resolve();

self.onmessage = function (event) {
  var msg = event.data;
  queue = queue
    .then(function () {
      return handle(msg);
    })
    .catch(function (error) {
      self.postMessage({
        type: 'error',
        game: msg.game,
        message: String((error && error.message) || error)
      });
    });
};
