/*
 * Battlesnake against AlphaSlinky, for /arcade/battlesnake/.
 *
 * The visitor steers the red snake. Every other snake is steered by the
 * agent, which runs, together with the game itself, in a worker
 * (battlesnake-worker.js). This file draws the board and turns keys, swipes
 * and taps into moves.
 *
 * Battlesnake turns are simultaneous. With a timed pace a turn is played
 * every so many milliseconds, the red snake carrying straight on unless it
 * has been steered, as in Snake. With the "step" pace the game waits, and
 * each key press is one turn.
 */
(function () {
  'use strict';

  // Known only while this script is running, so read it before anything else.
  var scriptUrl = document.currentScript ? document.currentScript.src : '';

  var root = document.getElementById('battlesnake');
  if (!root) return;
  var board = root.querySelector('.board');
  var canvas = board.querySelector('canvas');
  var note = board.querySelector('.board-note');
  var noteText = note.querySelector('.board-note-text');
  var noteButton = note.querySelector('.board-note-button');
  var legendEl = root.querySelector('.snake-legend');
  var scoreEl = root.querySelector('.game-score');
  var readoutEl = root.querySelector('.game-readout');
  var newButton = root.querySelector('.game-new');
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  var HUMAN = 0;
  var AGENT_NAME = 'AlphaSlinky';

  // The engine's numbers for the game modes, and how many snakes play each.
  var MODES = {
    duel: { id: 1, snakes: 2 },
    standard: { id: 0, snakes: 4 },
    royale: { id: 2, snakes: 4 },
    constrictor: { id: 3, snakes: 2 }
  };

  // Directions in the engine's order: up, down, left, right. Up is towards
  // larger y: the board's origin is its bottom-left corner.
  var DX = [0, 0, -1, 1];
  var DY = [1, -1, 0, 0];
  var OPPOSITE = [1, 0, 3, 2];
  var KEY_DIRS = {
    ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3,
    KeyW: 0, KeyS: 1, KeyA: 2, KeyD: 3
  };

  var PACE_MS = { step: 0, slow: 450, normal: 300, fast: 190 };   // 0: wait for each move
  var THINK_MARGIN_MS = 60;       // what is left of a turn after the agents' thinking time
  var STEP_THINK_MS = 240;        // the agents' thinking time per turn at the step pace
  var WATCH_MS = 170;             // turn length once the red snake is out
  var WATCH_HOLD_MS = 1100;       // pause on the turn the red snake goes out
  var LOAD_PATIENCE_MS = 45000;   // fetching the engine and the network's weights
  var TURN_PATIENCE_MS = 8000;
  var SWIPE_PX = 18;

  var touchScreen = window.matchMedia('(pointer: coarse)').matches;
  var options = { mode: 'duel', pace: 'normal' };

  var view = null;        // the position on the board, as the engine reports it
  var ghosts = [];        // snakes that went out on the last turn: { snake, body, target }
  var legend = [];        // the legend's elements, one entry per snake

  // loading: waiting for the engine. armed: waiting for the first key.
  // running, paused, over. failed: the engine could not be used.
  var state = 'loading';
  var heading = -1;       // the red snake's last move
  var pending = [];       // moves asked for and not yet made, oldest first
  var humanOut = false;
  var gameId = 0;
  var turnAt = 0;         // when the last turn was sent
  var turnTimer = 0, patienceTimer = 0, loadingTimer = 0;
  var awaiting = false;   // a turn has been sent and the new position is not back yet
  var turnOwed = false;   // the game was paused when the next turn was due
  var score = {};         // mode -> [games won by red, games won by an agent]
  var worker = null;

  var size = 0;           // the board's width and height in CSS pixels
  var colors = null;

  function paceMs() {
    return PACE_MS[options.pace];
  }

  // Thinking time for each agent. They think one after another.
  function budget() {
    var agents = 0;
    if (view) {
      for (var i = 1; i < view.snakes.length; i++) {
        if (view.snakes[i].alive) agents++;
      }
    } else {
      agents = MODES[options.mode].snakes - 1;
    }
    var total = STEP_THINK_MS;
    if (humanOut) total = WATCH_MS - THINK_MARGIN_MS;
    else if (paceMs()) total = paceMs() - THINK_MARGIN_MS;
    return Math.max(15, Math.min(250, Math.floor(total / Math.max(1, agents))));
  }

  // The direction from the red snake's head back to its neck, or -1 while the
  // snake is still coiled on its starting cell. Moving that way is never meant.
  function neckDir() {
    var body = view.snakes[HUMAN].body;
    if (body.length < 2) return -1;
    var dx = body[1][0] - body[0][0], dy = body[1][1] - body[0][1];
    for (var k = 0; k < 4; k++) {
      if (DX[k] === dx && DY[k] === dy) return k;
    }
    return -1;
  }

  // The engine -------------------------------------------------------------------

  function startWorker() {
    if (!scriptUrl || !window.Worker || !window.WebAssembly) return false;
    try {
      worker = new Worker(new URL('battlesnake-worker.js', scriptUrl));
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
    if (window.console && console.warn) console.warn('Battlesnake engine unavailable: ' + reason);
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
    if (msg.type !== 'state') return;
    clearTimeout(patienceTimer);
    awaiting = false;

    var before = view;
    view = msg.state;
    findGhosts(before, msg.moves);
    readoutEl.textContent = 'Turn ' + view.turn + (msg.sims ? ' · ' + msg.sims.toLocaleString('en') + ' simulations' : '');
    showLegend();
    draw();

    if (!before) {
      setState('armed');
      return;
    }
    if (view.over) {
      finish();
      return;
    }
    var hold = 0;
    if (!view.snakes[HUMAN].alive && !humanOut) {
      // Out, with others still playing: stay on this picture for a moment,
      // then let the rest of the game run.
      humanOut = true;
      pending = [];
      hold = WATCH_HOLD_MS;
    }
    if (state === 'running') scheduleTurn(hold);
    else turnOwed = true;
  }

  // Snakes that were on the board a turn ago and are not now, with the cell
  // each was moving to.
  function findGhosts(before, moves) {
    ghosts = [];
    if (!before || !moves) return;
    for (var i = 0; i < view.snakes.length; i++) {
      var was = before.snakes[i];
      if (!was.alive || view.snakes[i].alive || !was.body.length) continue;
      var move = moves[i], target = null;
      if (move >= 0 && move < 4) target = [was.body[0][0] + DX[move], was.body[0][1] + DY[move]];
      ghosts.push({ snake: i, body: was.body, target: target });
    }
  }

  // The game loop ----------------------------------------------------------------

  function stopTimers() {
    clearTimeout(turnTimer);
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
    humanOut = false;
    view = null;
    ghosts = [];
    readoutEl.textContent = '';
    showScore();
    showLegend();
    setState('loading');
    draw();

    if (!worker && !startWorker()) {
      fail('this browser cannot run the engine');
      return;
    }
    var mode = MODES[options.mode];
    ask({ type: 'new', game: gameId, mode: mode.id, snakes: mode.snakes, budget: budget() }, LOAD_PATIENCE_MS);
  }

  // Play one turn: send the red snake's move. The agents have already chosen theirs.
  function commitTurn() {
    if (state !== 'running' || awaiting || !view || view.over) return;
    if (!humanOut) {
      var back = neckDir();
      while (pending.length) {
        var dir = pending.shift();
        if (dir !== back) {
          heading = dir;
          break;
        }
      }
    }
    turnAt = performance.now();
    awaiting = true;
    ask({ type: 'turn', game: gameId, move: heading, budget: budget() }, TURN_PATIENCE_MS);
  }

  // Arrange the next turn, `hold` milliseconds later than usual.
  function scheduleTurn(hold) {
    clearTimeout(turnTimer);
    var ms = humanOut ? WATCH_MS : paceMs();
    if (ms) {
      turnTimer = setTimeout(commitTurn, Math.max(0, turnAt + ms + (hold || 0) - performance.now()));
      return;
    }
    // The step pace: nothing happens until a move is asked for.
    var back = neckDir();
    while (pending.length && pending[0] === back) pending.shift();
    if (pending.length) commitTurn();
  }

  function finish() {
    stopTimers();
    var tally = score[options.mode] || (score[options.mode] = [0, 0]);
    if (view.winner === HUMAN) tally[0]++;
    else if (view.winner > 0) tally[1]++;
    showScore();
    setState('over');
  }

  function pause() {
    if (state !== 'running' || !(humanOut || paceMs())) return;
    clearTimeout(turnTimer);
    if (!awaiting) turnOwed = true;
    setState('paused');
  }

  function resume() {
    setState('running');
    if (turnOwed) {
      turnOwed = false;
      turnAt = performance.now();
      scheduleTurn(0);
    }
  }

  // A direction from the keyboard, a swipe or a steering button.
  function steer(dir) {
    if (state === 'armed') {
      heading = dir;
      setState('running');
      commitTurn();
      return;
    }
    if (state === 'paused') resume();
    if (state !== 'running' || humanOut) return;
    if (!paceMs()) {
      // The step pace: each press is one turn. Presses made while a turn is
      // being played wait for it.
      if (!awaiting && dir === neckDir()) return;
      if (pending.length < 2) pending.push(dir);
      if (!awaiting) scheduleTurn(0);
      return;
    }
    // A timed pace: turns are queued, so two quick presses make two turns on
    // successive cells.
    var last = pending.length ? pending[pending.length - 1] : heading;
    if (dir === last || dir === OPPOSITE[last]) return;
    if (pending.length < 3) pending.push(dir);
  }

  // What the visitor is told ---------------------------------------------------

  function setState(next) {
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
      if (view.winner === HUMAN) text = 'You win.';
      else if (view.winner > 0) text = AGENT_NAME + ' wins.';
      else text = 'Nobody wins.';
      button = 'Play again';
    } else if (next === 'failed') {
      text = 'The engine could not be started in this browser.';
      button = 'Try again';
    }
    // The note sits in the middle of the board, except when a game has just
    // ended: then it moves away from the snakes' heads, so that the finish
    // stays in view.
    var top = '50%';
    if (next === 'over') top = headsAreLow() ? '24%' : '76%';
    note.style.top = top;
    showNote(text, button);
  }

  // Whether the heads on the board, those of the snakes that have just gone
  // out included, are mostly in its lower half.
  function headsAreLow() {
    var sum = 0, count = 0;
    function add(body) {
      if (!body.length) return;
      sum += body[0][1];
      count++;
    }
    view.snakes.forEach(function (snake) { add(snake.body); });
    ghosts.forEach(function (ghost) { add(ghost.body); });
    return !count || sum / count < (view.height - 1) / 2;
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
    var tally = score[options.mode] || [0, 0];
    scoreEl.textContent = '';
    [['You ' + tally[0], 'is-red'], [' · ', ''], [AGENT_NAME + ' ' + tally[1], 'is-blue']].forEach(function (part) {
      var span = document.createElement('span');
      span.textContent = part[0];
      if (part[1]) span.className = part[1];
      scoreEl.appendChild(span);
    });
  }

  // One entry per snake under the board: its name, its length and its health.
  function showLegend() {
    var count = view ? view.snakes.length : MODES[options.mode].snakes;
    if (legend.length !== count) {
      legendEl.textContent = '';
      legend = [];
      for (var i = 0; i < count; i++) {
        var item = document.createElement('div');
        item.className = 'snake-tag snake-' + i;
        var name = document.createElement('span');
        name.className = 'snake-name';
        name.textContent = i === HUMAN ? 'You' : AGENT_NAME;
        var length = document.createElement('span');
        length.className = 'snake-length';
        var bar = document.createElement('span');
        bar.className = 'snake-health';
        var fill = document.createElement('span');
        bar.appendChild(fill);
        item.appendChild(name);
        item.appendChild(length);
        item.appendChild(bar);
        legendEl.appendChild(item);
        legend.push({ item: item, length: length, fill: fill });
      }
    }
    legend.forEach(function (entry, i) {
      var snake = view ? view.snakes[i] : null;
      entry.item.classList.toggle('is-out', !!snake && !snake.alive);
      entry.length.textContent = !snake ? '' : snake.alive ? String(snake.length) : 'out';
      entry.fill.style.width = (snake && snake.alive ? snake.health : 0) + '%';
    });
  }

  // Drawing --------------------------------------------------------------------

  function readColors() {
    var style = getComputedStyle(document.documentElement);
    function get(name) { return style.getPropertyValue(name).trim(); }
    colors = {
      snakes: [get('--red'), get('--blue'), get('--green'), get('--gold')],
      ink: get('--ink'),
      muted: get('--muted'),
      tint: get('--tint'),
      paper: get('--paper')
    };
  }

  function measure() {
    var w = board.clientWidth;
    if (!w) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = w;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / w, 0, 0);
    return true;
  }

  function draw() {
    if (!colors || !size) return;
    var cells = view ? view.width : 11;
    var cell = size / cells, gap = Math.max(1, cell * 0.045);
    function cx(x) { return (x + 0.5) * cell; }
    function cy(y) { return (cells - 1 - y + 0.5) * cell; }

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = colors.tint;
    for (var y = 0; y < cells; y++) {
      for (var x = 0; x < cells; x++) {
        ctx.fillRect(x * cell + gap, y * cell + gap, cell - 2 * gap, cell - 2 * gap);
      }
    }
    if (!view) return;

    // Hazard cells are darker.
    ctx.fillStyle = colors.ink;
    ctx.globalAlpha = 0.2;
    view.hazards.forEach(function (p) {
      ctx.fillRect(cx(p[0]) - cell / 2 + gap, cy(p[1]) - cell / 2 + gap, cell - 2 * gap, cell - 2 * gap);
    });
    ctx.globalAlpha = 1;

    ctx.fillStyle = colors.muted;
    view.food.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(cx(p[0]), cy(p[1]), cell * 0.19, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    function trace(body) {
      ctx.beginPath();
      ctx.moveTo(cx(body[0][0]), cy(body[0][1]));
      for (var j = 1; j < body.length; j++) ctx.lineTo(cx(body[j][0]), cy(body[j][1]));
      ctx.stroke();
    }

    // A snake that has just gone out is shown faintly where it was, with a
    // cross on the cell it was moving to.
    ghosts.forEach(function (ghost) {
      ctx.strokeStyle = colors.snakes[ghost.snake];
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = cell * 0.6;
      trace(ghost.body);
      ctx.globalAlpha = 1;
      if (!ghost.target) return;
      var tx = cx(ghost.target[0]), ty = cy(ghost.target[1]), arm = cell * 0.2;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.beginPath();
      ctx.moveTo(tx - arm, ty - arm);
      ctx.lineTo(tx + arm, ty + arm);
      ctx.moveTo(tx + arm, ty - arm);
      ctx.lineTo(tx - arm, ty + arm);
      ctx.stroke();
    });

    view.snakes.forEach(function (snake, i) {
      var body = snake.body;
      if (!snake.alive || !body.length) return;
      ctx.strokeStyle = colors.snakes[i];
      ctx.fillStyle = colors.snakes[i];
      ctx.lineWidth = cell * 0.6;
      trace(body);

      // The head: a larger disc with two eyes looking the way it last moved.
      var hx = cx(body[0][0]), hy = cy(body[0][1]);
      ctx.beginPath();
      ctx.arc(hx, hy, cell * 0.4, 0, Math.PI * 2);
      ctx.fill();
      var dx = 0, dy = -1;
      for (var j = 1; j < body.length; j++) {
        if (body[j][0] !== body[0][0] || body[j][1] !== body[0][1]) {
          dx = Math.sign(body[0][0] - body[j][0]);
          dy = -Math.sign(body[0][1] - body[j][1]);
          break;
        }
      }
      ctx.fillStyle = colors.paper;
      for (var side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.arc(hx + dx * cell * 0.13 - dy * side * cell * 0.17, hy + dy * cell * 0.13 + dx * side * cell * 0.17, cell * 0.085, 0, Math.PI * 2);
        ctx.fill();
      }
    });
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
      // The arrow keys steer while there is a snake to steer; otherwise they
      // scroll the page as usual.
      var playing = (state === 'running' && !humanOut) || state === 'paused' || (state === 'armed' && isOnScreen());
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

  newButton.addEventListener('click', function () {
    newButton.blur();
    newGame();
  });

  // Swipes on the board. Each stretch of SWIPE_PX in one direction is a move.
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
        if (name === 'mode') {
          newGame();
        } else if (state === 'running' && !awaiting) {
          // A new pace applies from now.
          pending = [];
          turnAt = performance.now();
          scheduleTurn(0);
        }
      });
    });
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
