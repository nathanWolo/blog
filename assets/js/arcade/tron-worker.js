/*
 * Runs a Tron engine off the main thread for the arcade's Tron page
 * (tron.js). The engines are WebAssembly builds of the ones in
 * github.com/nathanWolo/tron-codingame; their sources are in _engine/
 * (alpha-beta) and _arcade/tronzero/.
 *
 * Messages in:
 *   { type: 'new', game, engine, cols, rows, starts }
 *       engine is a key of ENGINES; starts is [[col, row], ...], one per bike,
 *       in playing order.
 *   { type: 'move', game, player, budget, before }
 *       Ask the engine for `player`'s move, with `budget` milliseconds to
 *       think. `before` lists moves other bikes have made since the last
 *       message, as [player, dir] pairs, to be played on the engine's board
 *       first.
 *
 * Messages out:
 *   { type: 'ready', game }
 *   { type: 'move', game, player, dir, depth, sims }
 *       dir is 0 up, 1 down, 2 left, 3 right, or -1 when the bike is boxed in.
 *       The move has already been made on the engine's board. depth (plies
 *       searched) or sims (simulations run) says how hard the engine looked,
 *       whichever applies to it.
 *   { type: 'error', game, message }
 */
'use strict';

importScripts('engine-loader.js');

var ENGINES = {
  ab: '../../wasm/tron.wasm',
  zero: '../../wasm/tronzero.wasm'
};

var loaded = {};      // engine key -> promise of the module's exports
var engine = null;    // the one playing the current game

function load(key) {
  if (!ENGINES[key]) return Promise.reject(new Error('unknown engine "' + key + '"'));
  if (!loaded[key]) loaded[key] = loadEngine(new URL(ENGINES[key], self.location.href));
  return loaded[key];
}

function handle(msg) {
  if (msg.type === 'new') {
    return load(msg.engine).then(function (exports) {
      engine = exports;
      if (!engine.tron_new_game(msg.cols, msg.rows, msg.starts.length)) throw new Error('board not accepted');
      msg.starts.forEach(function (start, player) {
        if (!engine.tron_spawn(player, start[0], start[1])) throw new Error('start cell not accepted');
      });
      self.postMessage({ type: 'ready', game: msg.game });
    });
  }
  if (msg.type === 'move') {
    if (!engine) throw new Error('no game in progress');
    (msg.before || []).forEach(function (move) {
      if (!engine.tron_play(move[0], move[1])) throw new Error('boards out of step');
    });
    var dir = engine.tron_think(msg.player, msg.budget);
    if (dir >= 0 && !engine.tron_play(msg.player, dir)) throw new Error('engine chose a blocked cell');
    self.postMessage({
      type: 'move',
      game: msg.game,
      player: msg.player,
      dir: dir,
      depth: engine.tron_last_depth ? engine.tron_last_depth() : 0,
      sims: engine.tron_last_sims ? engine.tron_last_sims() : 0
    });
  }
}

// Messages are handled strictly in the order they arrive, even while an
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
