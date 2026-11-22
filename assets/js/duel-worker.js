/*
 * Runs the Tron engine (assets/wasm/tron.wasm) off the main thread, so that
 * its thinking never makes the page stutter. The engine's source is in
 * _engine/; duel.js starts this worker and draws the game.
 *
 * Messages in:
 *   { type: 'new', game, cols, rows, walls, starts }
 *       walls is a list of cell indexes (row * cols + col); starts is
 *       [[col, row], [col, row]] for red and blue.
 *   { type: 'move', game, player, budget }
 *       budget is the thinking time in milliseconds.
 *
 * Messages out:
 *   { type: 'ready', game }
 *   { type: 'move', game, player, dir, depth }
 *       dir is 0 up, 1 down, 2 left, 3 right, or -1 when the bike is boxed in.
 *       The move has already been made on the engine's board.
 *   { type: 'error', game, message }
 */
'use strict';

var engine = null;

var loading = fetch(new URL('../wasm/tron.wasm', self.location.href))
  .then(function (response) {
    if (!response.ok) throw new Error('tron.wasm: HTTP ' + response.status);
    return response.arrayBuffer();
  })
  .then(function (bytes) {
    // The engine has no clock of its own; this is the one it asks for.
    var imports = { env: { now_ms: function () { return performance.now(); } } };
    return WebAssembly.instantiate(bytes, imports);
  })
  .then(function (result) {
    engine = result.instance.exports;
  });

function handle(msg) {
  if (msg.type === 'new') {
    if (!engine.tron_new_game(msg.cols, msg.rows, 2)) throw new Error('grid not accepted');
    for (var i = 0; i < msg.walls.length; i++) {
      var index = msg.walls[i];
      engine.tron_set_wall(index % msg.cols, Math.floor(index / msg.cols));
    }
    for (var player = 0; player < 2; player++) {
      if (!engine.tron_spawn(player, msg.starts[player][0], msg.starts[player][1])) {
        throw new Error('start cell not accepted');
      }
    }
    self.postMessage({ type: 'ready', game: msg.game });
  } else if (msg.type === 'move') {
    var dir = engine.tron_think(msg.player, msg.budget);
    if (dir >= 0 && !engine.tron_play(msg.player, dir)) throw new Error('engine chose a blocked cell');
    self.postMessage({
      type: 'move',
      game: msg.game,
      player: msg.player,
      dir: dir,
      depth: engine.tron_last_depth()
    });
  }
}

self.onmessage = function (event) {
  var msg = event.data;
  loading
    .then(function () {
      handle(msg);
    })
    .catch(function (error) {
      self.postMessage({
        type: 'error',
        game: msg.game,
        message: String((error && error.message) || error)
      });
    });
};
