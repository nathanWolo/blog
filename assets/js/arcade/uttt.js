/*
 * Ultimate Tic-Tac-Toe against crossfish, for /arcade/ultimate-tic-tac-toe/.
 *
 * The engine, and the rules with it, run in a worker (uttt-worker.js), which
 * sends the whole position after every move. This file draws it: eighty-one
 * buttons in nine small boards. The visitor is red and the engine blue,
 * whoever moves first; the first player's mark is X, the second's O.
 */
(function () {
  'use strict';

  // Known only while this script is running, so read it before anything else.
  var scriptUrl = document.currentScript ? document.currentScript.src : '';

  var root = document.getElementById('uttt');
  if (!root) return;
  var grid = root.querySelector('.uttt-grid');
  var note = root.querySelector('.board-note');
  var noteText = note.querySelector('.board-note-text');
  var noteButton = note.querySelector('.board-note-button');
  var scoreEl = root.querySelector('.game-score');
  var readoutEl = root.querySelector('.game-readout');
  var turnEl = root.querySelector('.game-turn');
  var newButton = root.querySelector('.game-new');

  var ENGINE_NAME = 'crossfish';
  var LOAD_PATIENCE_MS = 30000;
  var MOVE_PATIENCE_MS = 15000;
  var PLACES = ['top left', 'top', 'top right', 'left', 'centre', 'right', 'bottom left', 'bottom', 'bottom right'];

  var options = { first: 'you', ms: '300' };

  var position = null;    // as the worker reports it
  var human = 0;          // which player the visitor is: 0 moves first
  var lastMove = -1;      // board * 9 + cell
  // loading: waiting for the engine. yours: the visitor to move.
  // thinking: the engine to move. over. failed.
  var state = 'loading';
  var gameId = 0;
  var patienceTimer = 0, loadingTimer = 0;
  var score = [0, 0, 0];  // games won by the visitor, by the engine, drawn
  var worker = null;

  // The board: nine small boards of nine buttons each.
  var boardEls = [], cellEls = [];
  for (var b = 0; b < 9; b++) {
    var small = document.createElement('div');
    small.className = 'uttt-small';
    small.setAttribute('role', 'group');
    var cells = document.createElement('div');
    cells.className = 'uttt-cells';
    small.appendChild(cells);
    for (var c = 0; c < 9; c++) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'uttt-cell';
      button.setAttribute('data-board', b);
      button.setAttribute('data-cell', c);
      cells.appendChild(button);
      cellEls.push(button);
    }
    grid.appendChild(small);
    boardEls.push(small);
  }

  // The engine -------------------------------------------------------------------

  function startWorker() {
    if (!scriptUrl || !window.Worker || !window.WebAssembly) return false;
    try {
      worker = new Worker(new URL('uttt-worker.js', scriptUrl));
    } catch (e) {
      return false;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      fail('worker error');
    };
    return true;
  }

  // Send the worker a request, and give up if no answer comes.
  function ask(message, patience) {
    clearTimeout(patienceTimer);
    patienceTimer = setTimeout(function () {
      fail('no answer from the engine');
    }, patience);
    worker.postMessage(message);
  }

  function fail(reason) {
    if (state === 'failed') return;
    if (window.console && console.warn) console.warn('Ultimate Tic-Tac-Toe engine unavailable: ' + reason);
    clearTimeout(patienceTimer);
    if (worker) {
      worker.terminate();
      worker = null;
    }
    setState('failed');
  }

  function onWorkerMessage(event) {
    var msg = event.data;
    if (msg.game !== gameId) return;
    if (msg.type === 'error') {
      fail(msg.message);
      return;
    }
    if (msg.type !== 'position') return;
    position = msg.position;
    lastMove = msg.last;
    if (msg.search) {
      readoutEl.textContent = 'Depth ' + msg.search.depth + ' · ' + compact(msg.search.nodes) + ' positions';
    }
    if (position.winner >= 0) {
      clearTimeout(patienceTimer);
      if (position.winner === 2) score[2]++;
      else score[position.winner === human ? 0 : 1]++;
      showScore();
      setState('over');
    } else if (position.toMove === human) {
      clearTimeout(patienceTimer);
      setState('yours');
    } else {
      // The engine is working on its answer; the worker sends it when ready.
      setState('thinking');
    }
  }

  function compact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  // The game -----------------------------------------------------------------------

  function newGame() {
    gameId++;
    clearTimeout(patienceTimer);
    position = null;
    lastMove = -1;
    human = options.first === 'you' ? 0 : 1;
    readoutEl.textContent = '';
    showScore();
    setState('loading');
    if (!worker && !startWorker()) {
      fail('this browser cannot run the engine');
      return;
    }
    ask({ type: 'new', game: gameId, engineFirst: human === 1, ms: Number(options.ms) }, LOAD_PATIENCE_MS);
  }

  function play(board, cell) {
    if (state !== 'yours' || !position) return;
    if (!(position.legal[board] & (1 << cell))) return;
    // Shown at once; the worker's copy of the position follows.
    position.cells[board * 9 + cell] = human + 1;
    lastMove = board * 9 + cell;
    setState('thinking');
    ask({ type: 'move', game: gameId, board: board, cell: cell, ms: Number(options.ms) }, MOVE_PATIENCE_MS + Number(options.ms));
  }

  // What the visitor sees -----------------------------------------------------------

  function setState(next) {
    state = next;
    clearTimeout(loadingTimer);
    render();
    var text = '', button = '', turn = '';
    if (next === 'loading') {
      // Only worth saying if it takes a moment.
      note.hidden = true;
      turnEl.textContent = '';
      loadingTimer = setTimeout(function () {
        showNote('Loading the engine…', '');
      }, 400);
      return;
    }
    if (next === 'yours') {
      turn = 'Your move';
    } else if (next === 'thinking') {
      turn = ENGINE_NAME + ' is thinking…';
    } else if (next === 'over') {
      // The result goes under the board rather than over it, so that the
      // final position stays in view.
      if (position.winner === 2) turn = 'A draw.';
      else turn = position.winner === human ? 'You win.' : ENGINE_NAME + ' wins.';
      newButton.focus({ preventScroll: true });
    } else if (next === 'failed') {
      text = 'The engine could not be started in this browser.';
      button = 'Try again';
    }
    turnEl.textContent = turn;
    turnEl.classList.toggle('is-result', next === 'over');
    showNote(text, button);
  }

  function showNote(text, button) {
    note.hidden = !text;
    noteText.textContent = text;
    noteButton.hidden = !button;
    noteButton.textContent = button;
    if (button) noteButton.focus({ preventScroll: true });
  }

  function showScore() {
    scoreEl.textContent = '';
    var parts = [['You ' + score[0], 'is-red'], [' · ', ''], [ENGINE_NAME + ' ' + score[1], 'is-blue']];
    if (score[2]) parts.push([' · Drawn ' + score[2], '']);
    parts.forEach(function (part) {
      var span = document.createElement('span');
      span.textContent = part[0];
      if (part[1]) span.className = part[1];
      scoreEl.appendChild(span);
    });
  }

  // Player 0's mark is X and player 1's is O; the visitor's are red.
  function markClass(player) {
    return (player === 0 ? 'is-x' : 'is-o') + (player === human ? ' is-red' : ' is-blue');
  }

  function render() {
    var yours = state === 'yours';
    for (var b = 0; b < 9; b++) {
      var decided = position ? position.boards[b] : 0;
      var open = yours && position.legal[b] !== 0;
      var cls = 'uttt-small';
      if (open) cls += ' is-open';
      if (decided === 1 || decided === 2) cls += ' is-won ' + markClass(decided - 1);
      else if (decided === 3) cls += ' is-drawn';
      boardEls[b].className = cls;
      boardEls[b].setAttribute('aria-label', 'Board ' + PLACES[b] + (decided === 1 || decided === 2 ? ', won by ' + (decided - 1 === human ? 'you' : ENGINE_NAME) : decided === 3 ? ', drawn' : ''));
      for (var c = 0; c < 9; c++) {
        var i = b * 9 + c, el = cellEls[i];
        var mark = position ? position.cells[i] : 0;
        var legal = yours && (position.legal[b] & (1 << c)) !== 0;
        var cellCls = 'uttt-cell';
        if (mark) cellCls += ' ' + markClass(mark - 1);
        if (i === lastMove) cellCls += ' is-last';
        el.className = cellCls;
        el.disabled = !legal;
        el.setAttribute('aria-label', PLACES[c] + ' cell of the ' + PLACES[b] + ' board' + (mark ? ', ' + (mark - 1 === human ? 'yours' : ENGINE_NAME + "'s") : ''));
      }
    }
  }

  // Wiring ---------------------------------------------------------------------

  grid.addEventListener('click', function (event) {
    var el = event.target.closest && event.target.closest('.uttt-cell');
    if (!el) return;
    play(Number(el.getAttribute('data-board')), Number(el.getAttribute('data-cell')));
  });

  noteButton.addEventListener('click', function () {
    noteButton.blur();
    newGame();
  });

  newButton.addEventListener('click', function () {
    newButton.blur();
    newGame();
  });

  // The option rows: one button of each row is pressed.
  Array.prototype.forEach.call(root.querySelectorAll('.choice'), function (row) {
    var name = row.getAttribute('data-option');
    var buttons = row.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.getAttribute('aria-pressed') === 'true') options[name] = button.getAttribute('data-value');
      button.addEventListener('click', function () {
        var value = button.getAttribute('data-value');
        if (options[name] === value) return;
        options[name] = value;
        Array.prototype.forEach.call(buttons, function (other) {
          other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
        });
        button.blur();
        // Who starts is settled at the start of a game; the thinking time
        // applies from the engine's next move.
        if (name === 'first') newGame();
      });
    });
  });

  // Start ----------------------------------------------------------------------

  showScore();
  newGame();
})();
