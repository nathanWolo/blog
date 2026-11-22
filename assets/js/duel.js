/*
 * The game in the home page masthead.
 *
 * Two bikes play a light-trail duel on a grid around the name plate, by the
 * CodinGame Tron Battle rules: red moves, then blue, each one cell at a time,
 * each leaving a wall behind. A bike with nowhere to go loses.
 *
 * Both bikes are driven by the alpha-beta Tron engine from _engine/, compiled
 * to WebAssembly and run in a worker (duel-worker.js). The name plate, and
 * everything outside the grid, is a wall as far as the engine is concerned.
 * If the engine cannot be loaded, a small bot written here plays instead: it
 * takes the move that leaves it the most territory, one move deep.
 *
 * The dots show territory: a cell belongs to the bike that can reach it first.
 * One game is played per page load, then the picture stays still. Visitors
 * who ask for reduced motion get the finished game without the animation.
 */
(function () {
  'use strict';

  // Known only while this script is running, so read it before anything else.
  var scriptUrl = document.currentScript ? document.currentScript.src : '';

  var arena = document.getElementById('arena');
  if (!arena) return;
  var canvas = arena.querySelector('canvas');
  var plate = arena.querySelector('.plate');
  var caption = document.querySelector('.arena-caption');
  var statusEl = caption && caption.querySelector('.arena-status');
  var replayBtn = caption && caption.querySelector('.arena-replay');
  var ctx = canvas && canvas.getContext && canvas.getContext('2d');
  if (!ctx || !plate || !statusEl || !replayBtn) return;

  var PLY_MS = 22;            // time between single moves while animating
  var FILL_PLY_MS = 12;       // the same once the bikes are walled off from each other
  var THINK_MS = 14;          // the engine's thinking time per move while animating
  var QUICK_THINK_MS = 2;     // and when the game is played out of sight
  var ENGINE_PATIENCE_MS = 4000;
  var MAX_COLS = 64, MAX_ROWS = 20;   // the engine's limits

  // Directions in the engine's order: up, down, left, right.
  var DX = [0, 0, -1, 1];
  var DY = [-1, 1, 0, 0];
  var NAMES = ['Red', 'Blue'];
  var CLASSES = ['is-red', 'is-blue'];
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Geometry, in CSS pixels.
  var width = 0, height = 0, cols = 0, rows = 0, cell = 0, offsetY = 0;

  // Board state. Every array has one entry per cell, row by row.
  var walls = null;   // 1 where the name plate is
  var grid = null;    // walls plus both trails
  var owner = null;   // 0 or 1: the bike that reaches the cell first; 2: tie; 3: neither; 9: not empty
  var distA = null, distB = null, queue = null;

  var bots = [];
  var ply = 0, over = true, winner = -1, hasPlayed = false;
  var contested = true;   // false once no empty cell can be reached by both bikes
  var gameId = 0, animated = false, nextMoveAt = 0, moveTimer = 0;
  var colors = null;

  // The engine. `engineOk` goes false for good the first time anything about it fails.
  var worker = null, engineOk = true, engineTimer = 0;
  var awaiting = null;   // what the worker has been asked for: { game, type, player }

  function readColors() {
    var style = getComputedStyle(document.documentElement);
    function get(name) { return style.getPropertyValue(name).trim(); }
    colors = {
      bots: [get('--red'), get('--blue')],
      muted: get('--muted'),
      rule: get('--rule'),
      paper: get('--paper')
    };
  }

  // Size the canvas, lay out the grid and mark the cells under the name plate.
  function measure() {
    var box = arena.getBoundingClientRect();
    var w = Math.round(box.width), h = Math.round(box.height);
    if (w < 160 || h < 100) return false;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = w;
    height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Cells of about 13px (11px on phones), made larger if the grid would
    // otherwise be bigger than the engine can hold.
    var target = Math.max(w < 480 ? 11 : 13, w / MAX_COLS, h / MAX_ROWS);
    cols = Math.min(MAX_COLS, Math.floor(w / target));
    cell = w / cols;
    rows = Math.min(MAX_ROWS, Math.floor(h / cell));
    offsetY = (h - rows * cell) / 2;

    var p = plate.getBoundingClientRect();
    var pad = cell * 0.3;
    var x0 = p.left - box.left - pad, x1 = p.right - box.left + pad;
    var y0 = p.top - box.top - offsetY - pad, y1 = p.bottom - box.top - offsetY + pad;

    var n = cols * rows;
    walls = new Uint8Array(n);
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (x * cell < x1 && (x + 1) * cell > x0 && y * cell < y1 && (y + 1) * cell > y0) {
          walls[y * cols + x] = 1;
        }
      }
    }
    owner = new Uint8Array(n);
    distA = new Int16Array(n);
    distB = new Int16Array(n);
    queue = new Int32Array(n);
    return true;
  }

  function isFree(x, y) {
    return x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x] === 0;
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
    var head = 0, tail = 0, start = sy * cols + sx;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      var i = queue[head++];
      var x = i % cols, y = (i - x) / cols, d = dist[i] + 1;
      for (var k = 0; k < 4; k++) {
        var nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        var n = ny * cols + nx;
        if (grid[n] !== 0 || dist[n] !== -1) continue;
        dist[n] = d;
        queue[tail++] = n;
      }
    }
  }

  function mapTerritory() {
    flood(bots[0].x, bots[0].y, distA);
    flood(bots[1].x, bots[1].y, distB);
    contested = false;
    for (var i = 0; i < grid.length; i++) {
      var a = distA[i], b = distB[i];
      if (grid[i] === 0 && a >= 0 && b >= 0) contested = true;
      if (grid[i] !== 0) owner[i] = 9;
      else if (a >= 0 && (b < 0 || a < b)) owner[i] = 0;
      else if (b >= 0 && (a < 0 || b < a)) owner[i] = 1;
      else if (a >= 0) owner[i] = 2;
      else owner[i] = 3;
    }
  }

  function pickStart(xMin, xMax) {
    var spots = [];
    for (var y = 1; y < rows - 1; y++) {
      for (var x = Math.max(1, Math.floor(xMin)); x < Math.min(cols - 1, Math.ceil(xMax)); x++) {
        if (isFree(x, y) && freeNeighbours(x, y) === 4) spots.push([x, y]);
      }
    }
    return spots.length ? spots[Math.floor(Math.random() * spots.length)] : null;
  }

  // Red starts somewhere on the left, blue somewhere on the right.
  function spawn() {
    grid = walls.slice();
    var starts = [pickStart(0, cols * 0.3), pickStart(cols * 0.7, cols)];
    if (!starts[0] || !starts[1]) return false;
    bots = starts.map(function (s) {
      grid[s[1] * cols + s[0]] = 1;
      return { x: s[0], y: s[1], alive: true, path: [s[0], s[1]] };
    });
    ply = 0;
    over = false;
    winner = -1;
    mapTerritory();
    return true;
  }

  // Make one bike's move. A direction of -1, or one into a wall, is a crash.
  function advance(i, dir) {
    var bot = bots[i];
    var nx = bot.x + (dir >= 0 ? DX[dir] : 0), ny = bot.y + (dir >= 0 ? DY[dir] : 0);
    if (dir < 0 || !isFree(nx, ny)) {
      bot.alive = false;
      over = true;
      winner = 1 - i;
      return;
    }
    bot.x = nx;
    bot.y = ny;
    bot.path.push(nx, ny);
    grid[ny * cols + nx] = 1;
    ply++;
    mapTerritory();
  }

  // The stand-in bot -----------------------------------------------------------

  // Cells the bike at A reaches first, minus cells the bike at B reaches first.
  function territory(ax, ay, bx, by) {
    flood(ax, ay, distA);
    flood(bx, by, distB);
    var score = 0;
    for (var i = 0; i < grid.length; i++) {
      var a = distA[i], b = distB[i];
      if (a > 0 && (b < 0 || a < b)) score++;
      else if (b > 0 && (a < 0 || b < a)) score--;
    }
    return score;
  }

  // Returns a direction index, or -1 when every neighbour is blocked.
  function standInMove(i) {
    var me = bots[i], foe = bots[1 - i];
    var best = -1, bestScore = -Infinity;
    for (var k = 0; k < 4; k++) {
      var nx = me.x + DX[k], ny = me.y + DY[k];
      if (!isFree(nx, ny)) continue;
      var n = ny * cols + nx;
      grid[n] = 1;
      var score = territory(nx, ny, foe.x, foe.y);
      // Prefer cells with fewer exits, which fills space more tightly.
      score -= 0.2 * freeNeighbours(nx, ny);
      grid[n] = 0;
      // A little noise, so that equal moves are not always broken the same way.
      score += Math.random() * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return best;
  }

  // The engine -----------------------------------------------------------------

  function engineUsable() {
    return engineOk && !!scriptUrl && !!window.Worker && !!window.WebAssembly;
  }

  // Ask the worker for something, and give up on the engine if it stays silent.
  function ask(message) {
    awaiting = { game: message.game, type: message.type, player: message.player };
    clearTimeout(engineTimer);
    engineTimer = setTimeout(function () {
      engineFailed('no answer');
    }, ENGINE_PATIENCE_MS);
    worker.postMessage(message);
  }

  // Carry on with the stand-in bot, picking the game up wherever it was.
  function engineFailed(reason) {
    if (!engineOk) return;
    engineOk = false;
    clearTimeout(engineTimer);
    if (window.console && console.warn) console.warn('Tron engine unavailable (' + reason + '); using the stand-in bot.');
    if (worker) {
      worker.terminate();
      worker = null;
    }
    var waitingFor = awaiting;
    awaiting = null;
    if (over || !waitingFor || waitingFor.game !== gameId) return;
    if (waitingFor.type === 'new') begin();
    else deliver(waitingFor.player, standInMove(waitingFor.player));
  }

  function onWorkerMessage(event) {
    var msg = event.data;
    if (!awaiting || msg.game !== awaiting.game || msg.game !== gameId) return;
    if (msg.type === 'error') {
      engineFailed(msg.message);
      return;
    }
    if (msg.type !== (awaiting.type === 'new' ? 'ready' : 'move')) return;
    clearTimeout(engineTimer);
    var player = awaiting.player;
    awaiting = null;
    if (msg.type === 'ready') {
      begin();
      return;
    }
    // The engine has already made this move on its own board. If ours
    // disagrees about whether the cell is free, the two are out of step.
    var bot = bots[player];
    if (msg.dir >= 0 && !isFree(bot.x + DX[msg.dir], bot.y + DY[msg.dir])) {
      awaiting = { game: gameId, type: 'move', player: player };
      engineFailed('boards out of step');
      return;
    }
    deliver(player, msg.dir);
  }

  function startWorker() {
    try {
      worker = new Worker(new URL('duel-worker.js', scriptUrl));
    } catch (e) {
      engineOk = false;
      return false;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      engineFailed('worker error');
    };
    return true;
  }

  // The game loop --------------------------------------------------------------

  // Get the next move. The engine answers later, through deliver(). Moves
  // known at once (a boxed-in bike, or the stand-in bot) are made in this loop
  // when nothing is being animated, so that a whole game played out of sight
  // is not a chain of calls as deep as the game is long.
  function requestMove() {
    while (!over) {
      var player = ply % 2;
      var boxedIn = freeNeighbours(bots[player].x, bots[player].y) === 0;
      if (!boxedIn && engineOk && worker) {
        ask({ type: 'move', game: gameId, player: player, budget: animated ? THINK_MS : QUICK_THINK_MS });
        return;
      }
      var dir = boxedIn ? -1 : standInMove(player);
      if (animated) {
        deliver(player, dir);
        return;
      }
      advance(player, dir);
    }
    finish();
  }

  // A move has been chosen. While animating, make it on the beat.
  function deliver(player, dir) {
    var id = gameId;
    function make() {
      if (id !== gameId || over) return;
      advance(player, dir);
      if (over) {
        finish();
        return;
      }
      if (animated) draw();
      requestMove();
    }
    if (!animated) {
      make();
      return;
    }
    var now = performance.now();
    var wait = Math.max(0, nextMoveAt - now);
    // The fight is shown at one speed; filling in what is left goes faster.
    nextMoveAt = Math.max(nextMoveAt, now) + (contested ? PLY_MS : FILL_PLY_MS);
    clearTimeout(moveTimer);
    moveTimer = setTimeout(make, wait);
  }

  function begin() {
    // Nothing is shown under the arena while a game is in progress; the
    // result appears there when it ends.
    if (animated) nextMoveAt = performance.now();
    requestMove();
  }

  function start(wantAnimation) {
    gameId++;
    clearTimeout(moveTimer);
    clearTimeout(engineTimer);
    awaiting = null;
    if (!measure() || !spawn()) {
      over = true;
      caption.hidden = true;
      return;
    }
    readColors();
    animated = wantAnimation && !reduceMotion.matches;
    caption.hidden = false;
    replayBtn.hidden = true;
    statusEl.textContent = '';
    draw();

    if (engineUsable() && (worker || startWorker())) {
      var wallCells = [];
      for (var i = 0; i < walls.length; i++) {
        if (walls[i]) wallCells.push(i);
      }
      ask({
        type: 'new',
        game: gameId,
        cols: cols,
        rows: rows,
        walls: wallCells,
        starts: [[bots[0].x, bots[0].y], [bots[1].x, bots[1].y]]
      });
    } else {
      begin();
    }
  }

  function finish() {
    draw();
    hasPlayed = true;
    var count = Math.ceil(ply / 2);
    var moves = count + (count === 1 ? ' move' : ' moves');
    setStatus([[NAMES[winner], CLASSES[winner]], ' wins in ' + moves]);
    replayBtn.hidden = false;
  }

  // Drawing --------------------------------------------------------------------

  function centreX(x) { return (x + 0.5) * cell; }
  function centreY(y) { return offsetY + (y + 0.5) * cell; }

  function draw() {
    if (!grid || !colors) return;
    ctx.clearRect(0, 0, width, height);

    // Territory dots, one pass per colour.
    var half = Math.max(0.9, cell * 0.085);
    var fills = [colors.bots[0], colors.bots[1], colors.muted, colors.rule];
    var alphas = [0.62, 0.62, 0.5, 1];
    for (var o = 0; o < 4; o++) {
      ctx.fillStyle = fills[o];
      ctx.globalAlpha = alphas[o];
      for (var i = 0; i < owner.length; i++) {
        if (owner[i] !== o) continue;
        var x = i % cols, y = (i - x) / cols;
        ctx.fillRect(centreX(x) - half, centreY(y) - half, half * 2, half * 2);
      }
    }
    ctx.globalAlpha = 1;

    // Trails and heads.
    ctx.lineWidth = Math.max(1.75, cell * 0.2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (var b = 0; b < 2; b++) {
      var bot = bots[b], path = bot.path;
      ctx.strokeStyle = colors.bots[b];
      ctx.beginPath();
      ctx.moveTo(centreX(path[0]), centreY(path[1]));
      for (var j = 2; j < path.length; j += 2) {
        ctx.lineTo(centreX(path[j]), centreY(path[j + 1]));
      }
      ctx.stroke();

      // A filled head while the bike is alive, a hollow one where it crashed.
      ctx.beginPath();
      ctx.arc(centreX(bot.x), centreY(bot.y), cell * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = bot.alive ? colors.bots[b] : colors.paper;
      ctx.fill();
      if (!bot.alive) ctx.stroke();
    }
  }

  // Parts are plain strings or [text, className] pairs.
  function setStatus(parts) {
    statusEl.textContent = '';
    parts.forEach(function (part) {
      if (typeof part === 'string') {
        statusEl.appendChild(document.createTextNode(part));
      } else {
        var span = document.createElement('span');
        span.className = part[1];
        span.textContent = part[0];
        statusEl.appendChild(span);
      }
    });
  }

  // Wiring ---------------------------------------------------------------------

  replayBtn.addEventListener('click', function () {
    start(true);
  });

  // The grid depends on the arena's size, so a new size means a new game.
  // Only the first game on a page is animated without being asked for.
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var box = arena.getBoundingClientRect();
      if (Math.round(box.width) === width && Math.round(box.height) === height) return;
      start(!hasPlayed);
    }, 200);
  });

  document.addEventListener('themechange', function () {
    readColors();
    draw();
  });

  // The plate's size depends on the web font, so wait for it before laying out.
  function boot() {
    start(true);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(boot, boot);
  else boot();
})();
