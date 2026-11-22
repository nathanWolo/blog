/*
 * Tron against an engine, for /arcade/tron/.
 *
 * The visitor steers the red bike; an engine in a worker (tron-worker.js)
 * steers the blue one. The rules are CodinGame Tron Battle's: a 30 by 20
 * grid, red moves, then blue, each one cell at a time, each leaving a wall
 * behind. A bike that runs into a wall, or has nowhere to go, loses.
 *
 * Time is divided into turns of a fixed length. At the start of a turn the
 * red bike moves one cell the way it is heading. The engine then thinks for
 * most of the turn, and its move is shown just before the next turn starts,
 * so the two bikes appear to move together.
 */
(function () {
  'use strict';

  // Known only while this script is running, so read it before anything else.
  var scriptUrl = document.currentScript ? document.currentScript.src : '';

  var root = document.getElementById('tron');
  if (!root) return;
  var board = root.querySelector('.board');
  var canvas = board.querySelector('canvas');
  var note = board.querySelector('.board-note');
  var noteText = note.querySelector('.board-note-text');
  var noteButton = note.querySelector('.board-note-button');
  var scoreEl = root.querySelector('.game-score');
  var readoutEl = root.querySelector('.game-readout');
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  var COLS = 30, ROWS = 20, CELLS = COLS * ROWS;
  var HUMAN = 0, ENGINE = 1;

  // Directions in the engines' order: up, down, left, right.
  var DX = [0, 0, -1, 1];
  var DY = [-1, 1, 0, 0];
  var OPPOSITE = [1, 0, 3, 2];
  var KEY_DIRS = {
    ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3,
    KeyW: 0, KeyS: 1, KeyA: 2, KeyD: 3
  };

  var TURN_MS = { slow: 170, normal: 120, fast: 85 };
  var ENGINE_NAMES = { ab: 'alpha-beta', zero: 'tronzero' };
  var LOAD_PATIENCE_MS = 30000;   // fetching and compiling an engine
  var MOVE_PATIENCE_MS = 6000;
  var SWIPE_PX = 18;
  var SHOW_LEAD_MS = 12;          // the engine's move appears this long before the next turn
  var THINK_MARGIN_MS = 30;       // what is left of a turn after the engine's thinking time

  var touchScreen = window.matchMedia('(pointer: coarse)').matches;
  var options = { engine: 'zero', speed: 'normal' };

  // Board state. Every array has one entry per cell, row by row.
  var grid = new Uint8Array(CELLS);    // 1 where a trail is
  var owner = new Uint8Array(CELLS);   // 0 or 1: the bike that gets there first; 2: tie; 3: neither; 9: not empty
  var dists = [new Int16Array(CELLS), new Int16Array(CELLS)];
  var queue = new Int32Array(CELLS);
  var bikes = [];

  // loading: waiting for the engine. armed: waiting for the first key.
  // running, paused, over. failed: the engine could not be used.
  var state = 'loading';
  var heading = -1;       // the way the red bike is going
  var pending = [];       // turns asked for and not yet made, oldest first
  var gameId = 0;
  var turnAt = 0;         // when the current turn began
  var turnTimer = 0, engineTimer = 0, patienceTimer = 0, loadingTimer = 0;
  var awaiting = false;   // the engine has been asked for a move
  var turnOwed = false;   // the game was paused when the next turn was due
  var score = {};         // engine key -> [games won by red, games won by the engine]
  var worker = null;

  var width = 0, height = 0, cellW = 0, cellH = 0;
  var colors = null;

  function turnMs() {
    return TURN_MS[options.speed];
  }

  // The engine thinks for most of a turn.
  function thinkMs() {
    return Math.max(8, turnMs() - THINK_MARGIN_MS);
  }

  // The board ------------------------------------------------------------------

  function isFree(x, y) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS && grid[y * COLS + x] === 0;
  }

  function freeNeighbours(x, y) {
    var count = 0;
    for (var k = 0; k < 4; k++) {
      if (isFree(x + DX[k], y + DY[k])) count++;
    }
    return count;
  }

  // Breadth-first distances from (sx, sy) over empty cells; -1 means unreachable.
  function flood(sx, sy, dist) {
    dist.fill(-1);
    var head = 0, tail = 0, start = sy * COLS + sx;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      var i = queue[head++];
      var x = i % COLS, y = (i - x) / COLS, d = dist[i] + 1;
      for (var k = 0; k < 4; k++) {
        var nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        var n = ny * COLS + nx;
        if (grid[n] !== 0 || dist[n] !== -1) continue;
        dist[n] = d;
        queue[tail++] = n;
      }
    }
  }

  function mapTerritory() {
    flood(bikes[0].x, bikes[0].y, dists[0]);
    flood(bikes[1].x, bikes[1].y, dists[1]);
    for (var i = 0; i < CELLS; i++) {
      var a = dists[0][i], b = dists[1][i];
      if (grid[i] !== 0) owner[i] = 9;
      else if (a >= 0 && (b < 0 || a < b)) owner[i] = 0;
      else if (b >= 0 && (a < 0 || b < a)) owner[i] = 1;
      else if (a >= 0) owner[i] = 2;
      else owner[i] = 3;
    }
  }

  // Move a bike one cell. False, and nothing changes, if that cell is blocked.
  function advance(i, dir) {
    var bike = bikes[i];
    var nx = bike.x + DX[dir], ny = bike.y + DY[dir];
    if (!isFree(nx, ny)) return false;
    bike.x = nx;
    bike.y = ny;
    bike.path.push(nx, ny);
    grid[ny * COLS + nx] = 1;
    mapTerritory();
    return true;
  }

  // The engine -------------------------------------------------------------------

  function startWorker() {
    if (!scriptUrl || !window.Worker || !window.WebAssembly) return false;
    try {
      worker = new Worker(new URL('tron-worker.js', scriptUrl));
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
    if (window.console && console.warn) console.warn('Tron engine unavailable: ' + reason);
    stopTimers();
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
    if (msg.type === 'ready' && state === 'loading') {
      clearTimeout(patienceTimer);
      setState('armed');
      return;
    }
    if (msg.type !== 'move' || !awaiting) return;
    clearTimeout(patienceTimer);

    // Show the engine's move at the end of the turn, however quickly it came.
    var id = gameId;
    var wait = turnAt + turnMs() - SHOW_LEAD_MS - performance.now();
    clearTimeout(engineTimer);
    engineTimer = setTimeout(function () {
      if (id === gameId) engineMoved(msg);
    }, Math.max(0, wait));
  }

  function engineMoved(msg) {
    awaiting = false;
    // The engine has already made this move on its own board. If ours says
    // the cell is taken, the two are out of step.
    if (msg.dir < 0 || !advance(ENGINE, msg.dir)) {
      fail('boards out of step');
      return;
    }
    if (msg.sims) readoutEl.textContent = msg.sims.toLocaleString('en') + ' simulations';
    else readoutEl.textContent = msg.depth ? 'Depth ' + msg.depth : '';
    draw();
    if (state === 'running') scheduleTurn();
    else turnOwed = true;
  }

  // The game loop ----------------------------------------------------------------

  function stopTimers() {
    clearTimeout(turnTimer);
    clearTimeout(engineTimer);
    clearTimeout(patienceTimer);
    clearTimeout(loadingTimer);
    awaiting = false;
    turnOwed = false;
  }

  function newGame() {
    gameId++;
    stopTimers();
    pending = [];
    heading = -1;

    // Red starts somewhere on the left; blue starts at the same spot seen
    // from the opposite corner, so neither side of the board is better.
    grid.fill(0);
    var x = 2 + Math.floor(Math.random() * 8), y = 2 + Math.floor(Math.random() * (ROWS - 4));
    var starts = [[x, y], [COLS - 1 - x, ROWS - 1 - y]];
    bikes = starts.map(function (s) {
      grid[s[1] * COLS + s[0]] = 1;
      return { x: s[0], y: s[1], alive: true, path: [s[0], s[1]] };
    });
    mapTerritory();
    readoutEl.textContent = '';
    showScore();
    setState('loading');
    draw();

    if (!worker && !startWorker()) {
      fail('this browser cannot run the engine');
      return;
    }
    ask({ type: 'new', game: gameId, engine: options.engine, cols: COLS, rows: ROWS, starts: starts }, LOAD_PATIENCE_MS);
  }

  // One turn: red moves now, and the engine is asked for blue's reply.
  function turn() {
    if (state !== 'running') return;
    turnAt = performance.now();
    if (pending.length) heading = pending.shift();
    if (!advance(HUMAN, heading)) {
      finish(ENGINE);
      return;
    }
    var bot = bikes[ENGINE];
    if (freeNeighbours(bot.x, bot.y) === 0) {
      finish(HUMAN);
      return;
    }
    draw();
    awaiting = true;
    ask({ type: 'move', game: gameId, player: ENGINE, budget: thinkMs(), before: [[HUMAN, heading]] }, MOVE_PATIENCE_MS);
  }

  function scheduleTurn() {
    clearTimeout(turnTimer);
    turnTimer = setTimeout(turn, Math.max(0, turnAt + turnMs() - performance.now()));
  }

  function finish(winner) {
    stopTimers();
    bikes[1 - winner].alive = false;
    var tally = score[options.engine] || (score[options.engine] = [0, 0]);
    tally[winner]++;
    showScore();
    setState('over', winner);
    draw();
  }

  function pause() {
    if (state !== 'running') return;
    clearTimeout(turnTimer);
    if (!awaiting) turnOwed = true;
    setState('paused');
  }

  function resume() {
    setState('running');
    if (turnOwed) {
      turnOwed = false;
      turnAt = performance.now();
      scheduleTurn();
    }
  }

  // A direction from the keyboard, a swipe or a steering button.
  function steer(dir) {
    if (state === 'armed') {
      heading = dir;
      setState('running');
      turn();
      return;
    }
    if (state === 'paused') resume();
    if (state !== 'running') return;
    // Turns are queued, so two quick presses make two turns on successive
    // cells. Turning straight back onto your own trail is never meant.
    var last = pending.length ? pending[pending.length - 1] : heading;
    if (dir === last || dir === OPPOSITE[last]) return;
    if (pending.length < 3) pending.push(dir);
  }

  // What the visitor is told ---------------------------------------------------

  function setState(next, winner) {
    state = next;
    clearTimeout(loadingTimer);
    var text = '', button = '';
    if (next === 'loading') {
      // Only worth saying if it takes a moment.
      note.hidden = true;
      loadingTimer = setTimeout(function () {
        showNote('Loading the engine…', '');
      }, 400);
      return;
    }
    if (next === 'armed') {
      text = touchScreen ? 'Swipe, or tap an arrow, to start' : 'Press an arrow key to start';
    } else if (next === 'paused') {
      text = touchScreen ? 'Paused. Swipe to carry on.' : 'Paused. Press an arrow key to carry on.';
    } else if (next === 'over') {
      text = winner === HUMAN ? 'You win.' : ENGINE_NAMES[options.engine] + ' wins.';
      button = 'Play again';
    } else if (next === 'failed') {
      text = 'The engine could not be started in this browser.';
      button = 'Try again';
    }
    // The note sits in the middle of the board, except when a game has just
    // ended: then it moves to the half the bikes are not in, so that the
    // finish stays in view.
    var top = '50%';
    if (next === 'over') top = (bikes[0].y + bikes[1].y) / 2 < ROWS / 2 ? '74%' : '26%';
    note.style.top = top;
    showNote(text, button);
  }

  function showNote(text, button) {
    note.hidden = !text;
    noteText.textContent = text;
    noteButton.hidden = !button;
    noteButton.textContent = button;
    // With the button focused, Space or Enter starts the next game.
    if (button && !touchScreen) noteButton.focus({ preventScroll: true });
  }

  function showScore() {
    var tally = score[options.engine] || [0, 0];
    scoreEl.textContent = '';
    [['You ' + tally[0], 'is-red'], [' · ', ''], [ENGINE_NAMES[options.engine] + ' ' + tally[1], 'is-blue']].forEach(function (part) {
      var span = document.createElement('span');
      span.textContent = part[0];
      if (part[1]) span.className = part[1];
      scoreEl.appendChild(span);
    });
  }

  // Drawing --------------------------------------------------------------------

  function readColors() {
    var style = getComputedStyle(document.documentElement);
    function get(name) { return style.getPropertyValue(name).trim(); }
    colors = {
      bikes: [get('--red'), get('--blue')],
      muted: get('--muted'),
      rule: get('--rule'),
      paper: get('--paper')
    };
  }

  function measure() {
    var w = board.clientWidth, h = board.clientHeight;
    if (!w || !h) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = w;
    height = h;
    cellW = w / COLS;
    cellH = h / ROWS;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    return true;
  }

  function centreX(x) { return (x + 0.5) * cellW; }
  function centreY(y) { return (y + 0.5) * cellH; }

  function draw() {
    if (!colors || !width || !bikes.length) return;
    ctx.clearRect(0, 0, width, height);

    // Territory dots, one pass per colour.
    var half = Math.max(0.9, cellW * 0.075);
    var fills = [colors.bikes[0], colors.bikes[1], colors.muted, colors.rule];
    var alphas = [0.62, 0.62, 0.5, 1];
    for (var o = 0; o < 4; o++) {
      ctx.fillStyle = fills[o];
      ctx.globalAlpha = alphas[o];
      for (var i = 0; i < CELLS; i++) {
        if (owner[i] !== o) continue;
        var x = i % COLS, y = (i - x) / COLS;
        ctx.fillRect(centreX(x) - half, centreY(y) - half, half * 2, half * 2);
      }
    }
    ctx.globalAlpha = 1;

    // Trails and heads.
    ctx.lineWidth = Math.max(2, cellW * 0.26);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (var b = 0; b < bikes.length; b++) {
      var bike = bikes[b], path = bike.path;
      ctx.strokeStyle = colors.bikes[b];
      ctx.beginPath();
      ctx.moveTo(centreX(path[0]), centreY(path[1]));
      for (var j = 2; j < path.length; j += 2) {
        ctx.lineTo(centreX(path[j]), centreY(path[j + 1]));
      }
      ctx.stroke();

      // A filled head while the bike is going, a hollow one where it stopped.
      ctx.beginPath();
      ctx.arc(centreX(bike.x), centreY(bike.y), cellW * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = bike.alive ? colors.bikes[b] : colors.paper;
      ctx.fill();
      if (!bike.alive) ctx.stroke();
    }
  }

  // Wiring ---------------------------------------------------------------------

  function isOnScreen() {
    var box = board.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight;
  }

  document.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var dir = KEY_DIRS[event.code];
    if (dir !== undefined) {
      // The arrow keys steer while there is a game to steer; otherwise they
      // scroll the page as usual.
      var playing = state === 'running' || state === 'paused' || (state === 'armed' && isOnScreen());
      if (!playing) return;
      event.preventDefault();
      if (!event.repeat) steer(dir);
      return;
    }
    var onControl = event.target && event.target.closest && event.target.closest('a, button, input, select, textarea');
    if ((event.code === 'Space' || event.code === 'Enter') && state === 'over' && !onControl) {
      event.preventDefault();
      newGame();
    }
  });

  noteButton.addEventListener('click', function () {
    noteButton.blur();
    newGame();
  });

  // Swipes on the board. Each stretch of SWIPE_PX in one direction is a turn,
  // so a finger can stay down and draw the route.
  var swipeFrom = null;
  board.addEventListener('touchstart', function (event) {
    var touch = event.changedTouches[0];
    swipeFrom = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  board.addEventListener('touchmove', function (event) {
    if (!swipeFrom) return;
    var touch = event.changedTouches[0];
    var dx = touch.clientX - swipeFrom.x, dy = touch.clientY - swipeFrom.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : (dy > 0 ? 1 : 0));
    swipeFrom = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  board.addEventListener('touchend', function () {
    swipeFrom = null;
  });

  Array.prototype.forEach.call(root.querySelectorAll('.dpad button'), function (button) {
    button.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      steer(Number(button.getAttribute('data-dir')));
    });
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
        // A new opponent means a new game; a new speed applies from the next turn.
        if (name === 'engine') newGame();
      });
    });
    // A row with nothing to choose between is not shown.
    row.hidden = buttons.length < 2;
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause();
  });
  window.addEventListener('blur', pause);

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (measure()) draw();
    }, 100);
  });

  document.addEventListener('themechange', function () {
    readColors();
    draw();
  });

  // Start ----------------------------------------------------------------------

  readColors();
  measure();
  newGame();
})();
