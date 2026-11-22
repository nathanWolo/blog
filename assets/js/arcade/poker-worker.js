/*
 * Runs the poker game and its bots off the main thread for the arcade's
 * poker page (poker.js).
 *
 * The WebAssembly module (assets/wasm/poker.wasm, built from _arcade/poker/)
 * holds both the game (a port of the CodinGame Poker referee: the deal, the
 * betting, the pots) and the bot, from github.com/nathanWolo/cgpoker. Seat 0
 * is the visitor; every other seat is a copy of the bot.
 *
 * The game advances one visible thing at a time (a bot's action, a street
 * being dealt, the end of a hand), so that the page can show each one before
 * asking for the next.
 *
 * Messages in:
 *   { type: 'new', game, players }      players is 2, 3 or 4
 *   { type: 'step', game }              advance by one thing
 *   { type: 'act', game, kind, amount } the visitor's action: kind 0 fold,
 *                                       1 check, 2 call, 3 all-in, 4 raise to
 *                                       `amount` in this betting round
 *   { type: 'next', game }              deal the next hand
 *
 * Messages out:
 *   { type: 'state', game, status, state, refused }
 *       status: 0 more to do (send 'step'), 1 waiting for the visitor,
 *       2 the hand is over (send 'next'), 3 the game is over.
 *       state is the table as JSON (see _arcade/poker/README.md).
 *       refused is true when an 'act' was not a legal action.
 *   { type: 'error', game, message }
 */
'use strict';

importScripts('engine-loader.js');

var WASM = '../../wasm/poker.wasm';
var MORE = 0, YOUR_TURN = 1;

var engine = null;
var starting = null;
var decoder = new TextDecoder();

function start() {
  if (!starting) {
    starting = loadEngine(new URL(WASM, self.location.href)).then(function (exports) {
      engine = exports;
    });
  }
  return starting;
}

// The module's memory can grow, so always look at its current buffer.
function readText(ptr, len) {
  return decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
}

function lastError() {
  return readText(engine.pk_error_ptr(), engine.pk_error_len()) || 'the engine reported an error';
}

function post(game, status, refused) {
  self.postMessage({
    type: 'state',
    game: game,
    status: status,
    state: JSON.parse(readText(engine.pk_state_ptr(), engine.pk_state_len())),
    refused: !!refused
  });
}

function step(game) {
  var status = engine.pk_step();
  if (status < 0) throw new Error(lastError());
  post(game, status);
}

function handle(msg) {
  if (msg.type === 'new') {
    return start().then(function () {
      var seed = new Uint32Array(2);
      crypto.getRandomValues(seed);
      if (engine.pk_new_game(msg.players, seed[0], seed[1])) throw new Error(lastError());
      step(msg.game);
    });
  }
  if (!engine) throw new Error('no game in progress');
  if (msg.type === 'step') {
    step(msg.game);
  } else if (msg.type === 'act') {
    if (engine.pk_act(msg.kind, msg.amount | 0)) post(msg.game, YOUR_TURN, true);
    else post(msg.game, MORE);
  } else if (msg.type === 'next') {
    if (engine.pk_next_hand()) throw new Error(lastError());
    step(msg.game);
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
