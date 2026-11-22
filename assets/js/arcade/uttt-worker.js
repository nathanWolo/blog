/*
 * Runs crossfish, the Ultimate Tic-Tac-Toe engine, off the main thread for
 * the arcade's page (uttt.js). The WebAssembly module
 * (assets/wasm/crossfish.wasm, built from _arcade/crossfish/) holds the rules
 * as well as the search, so the page never has to decide what is legal or who
 * has won: after every move it is sent the whole position.
 *
 * Small boards are numbered 0 to 8, left to right and top to bottom, and so
 * are the cells inside each. The first player is 0 (X), the second 1 (O).
 *
 * Messages in:
 *   { type: 'new', game, engineFirst, ms }
 *   { type: 'move', game, board, cell, ms }
 *       the visitor's move; the engine then answers it.
 *   ms is the engine's thinking time for its next move.
 *
 * Messages out:
 *   { type: 'position', game, position, last, by, search }
 *       position: { cells: [81 of 0 empty, 1 X, 2 O], boards: [9 of 0 open,
 *       1 X, 2 O, 3 drawn], legal: [9 masks of the cells that may be played],
 *       toMove, winner: -1 none yet, 0 X, 1 O, 2 draw }.
 *       last is the move that led to it, as board * 9 + cell (-1 at the
 *       start); by says who made it, 'you' or 'engine'; search, after an
 *       engine move, is { depth, nodes }.
 *   { type: 'error', game, message }
 */
'use strict';

importScripts('engine-loader.js');

var WASM = '../../wasm/crossfish.wasm';
var OPENING_MS = 100;

var engine = null;
var starting = null;

function start() {
  if (!starting) {
    starting = loadEngine(new URL(WASM, self.location.href)).then(function (exports) {
      engine = exports;
    });
  }
  return starting;
}

function readPosition() {
  var cells = [], boards = [], legal = [];
  for (var b = 0; b < 9; b++) {
    boards.push(engine.cf_board_state(b));
    legal.push(engine.cf_legal(b));
    for (var c = 0; c < 9; c++) cells.push(engine.cf_cell(b, c));
  }
  return { cells: cells, boards: boards, legal: legal, toMove: engine.cf_to_move(), winner: engine.cf_winner() };
}

function post(game, last, by, search) {
  self.postMessage({ type: 'position', game: game, position: readPosition(), last: last, by: by, search: search || null });
}

// Let the engine choose a move, play it and report it.
function engineMove(game, ms) {
  var move = engine.cf_think(ms);
  if (move < 0) throw new Error('the engine found no move');
  if (!engine.cf_play(Math.floor(move / 9), move % 9)) throw new Error('the engine chose an illegal move');
  post(game, move, 'engine', { depth: engine.cf_last_depth(), nodes: engine.cf_last_nodes() });
}

function handle(msg) {
  if (msg.type === 'new') {
    return start().then(function () {
      engine.cf_new();
      post(msg.game, -1, '');
      // The engine's opening move is fixed (the centre of the centre board);
      // its search before it only fills its tables, so keep that short.
      if (msg.engineFirst) engineMove(msg.game, Math.min(msg.ms, OPENING_MS));
    });
  }
  if (msg.type === 'move') {
    if (!engine) throw new Error('no game in progress');
    if (!engine.cf_play(msg.board, msg.cell)) throw new Error('that move is not legal');
    post(msg.game, msg.board * 9 + msg.cell, 'you');
    if (engine.cf_winner() < 0) engineMove(msg.game, msg.ms);
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
