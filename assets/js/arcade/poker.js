/*
 * Poker against the cgpoker bot, for /arcade/poker/.
 *
 * The game and the bots run in a worker (poker-worker.js), which describes
 * the table after every step in the same JSON that the bot's own play server
 * (play/server.py in github.com/nathanWolo/cgpoker) sends to its page. This
 * file draws that state and turns buttons and keys into actions; its
 * rendering follows play/index.html in that repository.
 *
 * The game moves one visible thing at a time. After each one the page waits
 * a moment, so the visitor can follow, then asks the worker for the next.
 */
(function () {
  'use strict';

  // Known only while this script is running, so read it before anything else.
  var scriptUrl = document.currentScript ? document.currentScript.src : '';

  var root = document.getElementById('poker');
  if (!root) return;
  var seatsEl = root.querySelector('.poker-seats');
  var youEl = root.querySelector('.poker-you');
  var boardEl = root.querySelector('.poker-board');
  var potEl = root.querySelector('.poker-pot');
  var bannerEl = root.querySelector('.poker-banner');
  var actionsEl = root.querySelector('.poker-actions');
  var note = root.querySelector('.board-note');
  var noteText = note.querySelector('.board-note-text');
  var noteButton = note.querySelector('.board-note-button');
  var statusEl = root.querySelector('.game-score');
  var readoutEl = root.querySelector('.game-readout');
  var logEl = root.querySelector('.poker-log');
  var thoughtsEl = root.querySelector('.poker-thoughts');
  var thoughtsTitle = root.querySelector('.poker-thoughts-title');
  var newButton = root.querySelector('.game-new');

  var HUMAN = 0;
  var MORE = 0, YOUR_TURN = 1, HAND_OVER = 2;                  // the worker's status; 3 is game over
  var FOLD = 0, CHECK = 1, CALL = 2, ALL_IN = 3, RAISE = 4;    // the visitor's actions
  var SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var OUT_STEP_MS = 60;           // the pace once the visitor is out of the game
  var OUT_HAND_MS = 900;
  var LOAD_PATIENCE_MS = 45000;
  var STEP_PATIENCE_MS = 10000;

  var options = { players: '2', speed: '650' };

  var S = null;           // the table, as the worker last described it
  var status = MORE;
  var failed = false;
  var raiseTo = 0;        // what the raise control is set to
  var raiseFor = '';      // the decision that setting was made for
  var gameId = 0;
  var stepTimer = 0, patienceTimer = 0, loadingTimer = 0;
  var worker = null;

  // The engine -------------------------------------------------------------------

  function startWorker() {
    if (!scriptUrl || !window.Worker || !window.WebAssembly) return false;
    try {
      worker = new Worker(new URL('poker-worker.js', scriptUrl));
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
    }, patience || STEP_PATIENCE_MS);
    worker.postMessage(message);
  }

  function fail(reason) {
    if (failed) return;
    failed = true;
    if (window.console && console.warn) console.warn('Poker engine unavailable: ' + reason);
    clearTimeout(stepTimer);
    clearTimeout(patienceTimer);
    clearTimeout(loadingTimer);
    if (worker) {
      worker.terminate();
      worker = null;
    }
    actionsEl.textContent = '';
    showNote('The engine could not be started in this browser.', 'Try again');
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
    clearTimeout(loadingTimer);
    note.hidden = true;
    S = msg.state;
    status = msg.status;
    render();

    // What happens next, and how soon.
    var out = youAreOut();
    clearTimeout(stepTimer);
    if (status === MORE) {
      stepTimer = setTimeout(function () {
        ask({ type: 'step', game: gameId });
      }, out ? OUT_STEP_MS : Number(options.speed));
    } else if (status === HAND_OVER && out) {
      // Out of chips: the bots play the rest of the game by themselves.
      stepTimer = setTimeout(nextHand, OUT_HAND_MS);
    }
  }

  function youAreOut() {
    return !!S && S.players[HUMAN].out;
  }

  // The game -----------------------------------------------------------------------

  function newGame() {
    gameId++;
    failed = false;
    clearTimeout(stepTimer);
    clearTimeout(patienceTimer);
    S = null;
    status = MORE;
    raiseTo = 0;
    raiseFor = '';
    seatsEl.textContent = '';
    youEl.textContent = '';
    boardEl.textContent = '';
    potEl.textContent = '';
    bannerEl.textContent = '';
    actionsEl.textContent = '';
    statusEl.textContent = '';
    readoutEl.textContent = '';
    logEl.textContent = '';
    // Only worth saying if it takes a moment.
    note.hidden = true;
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(function () {
      showNote('Loading the engine…', '');
    }, 400);
    if (!worker && !startWorker()) {
      fail('this browser cannot run the engine');
      return;
    }
    ask({ type: 'new', game: gameId, players: Number(options.players) }, LOAD_PATIENCE_MS);
  }

  function act(kind, amount) {
    if (status !== YOUR_TURN || !S || !S.options) return;
    status = MORE;
    actionsEl.textContent = '';
    ask({ type: 'act', game: gameId, kind: kind, amount: amount || 0 });
  }

  function nextHand() {
    if (status !== HAND_OVER) return;
    status = MORE;
    actionsEl.textContent = '';
    ask({ type: 'next', game: gameId });
  }

  function showNote(text, button) {
    note.hidden = !text;
    noteText.textContent = text;
    noteButton.hidden = !button;
    noteButton.textContent = button;
  }

  // Drawing ------------------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function chips(n) {
    return Number(n).toLocaleString('en');
  }

  function inBlinds(n) {
    if (!S || !S.bb) return '';
    var x = n / S.bb;
    return x.toFixed(x < 10 ? 1 : 0) + ' BB';
  }

  // A card: "AS" is the ace of spades, "??" a card face down, nothing an empty place.
  function card(code) {
    var node = el('span', 'pcard');
    if (!code) {
      node.className += ' is-empty';
    } else if (code === '??') {
      node.className += ' is-back';
      node.setAttribute('aria-label', 'face-down card');
    } else {
      var suit = code.charAt(1);
      if (suit === 'H' || suit === 'D') node.className += ' is-red';
      node.appendChild(el('span', 'pcard-rank', code.charAt(0) === 'T' ? '10' : code.charAt(0)));
      node.appendChild(el('span', 'pcard-suit', SUITS[suit] || suit));
    }
    return node;
  }

  function seat(p) {
    var node = el('div', 'poker-seat' + (p.human ? ' is-you' : '') + (p.acting ? ' is-acting' : '') + (p.folded ? ' is-folded' : '') + (p.out ? ' is-out' : ''));
    var cards = el('div', 'poker-cards');
    (p.cards || []).forEach(function (code) {
      cards.appendChild(card(code));
    });
    node.appendChild(cards);

    var name = el('div', 'poker-name');
    name.appendChild(el('span', p.human ? 'is-red' : 'is-blue', p.name));
    if (p.dealer) name.appendChild(el('span', 'poker-badge', 'D'));
    if (p.sb && !p.dealer) name.appendChild(el('span', 'poker-badge', 'SB'));
    if (p.bbpos) name.appendChild(el('span', 'poker-badge', 'BB'));
    node.appendChild(name);

    var stack = el('div', 'poker-stack', chips(p.stack));
    if (!p.out) stack.appendChild(el('small', '', ' ' + inBlinds(p.stack)));
    node.appendChild(stack);

    var said = p.out ? 'out' : p.acting ? (p.human ? 'your turn' : 'thinking…') : p.allin ? 'all-in' : p.folded ? 'folded' : p.last;
    node.appendChild(el('div', 'poker-said caps', said || ' '));
    node.appendChild(el('div', 'poker-bet caps', p.bet > 0 && !p.out ? 'In ' + chips(p.bet) : ' '));
    return node;
  }

  function render() {
    statusEl.textContent = 'Hand ' + S.hand + ' · Blinds ' + S.sb + '/' + S.bb;
    readoutEl.textContent = 'Decision ' + S.rounds + ' of 600';

    seatsEl.textContent = '';
    youEl.textContent = '';
    S.players.forEach(function (p) {
      (p.human ? youEl : seatsEl).appendChild(seat(p));
    });

    boardEl.textContent = '';
    for (var k = 0; k < 5; k++) boardEl.appendChild(card(S.board[k]));
    potEl.textContent = 'Pot ' + chips(S.pot);

    var banner = '';
    if (S.status === 'game_over') {
      banner = standings();
    } else if (S.result && S.status === 'hand_over') {
      banner = S.result.players.filter(function (r) {
        return r.net > 0;
      }).map(function (r) {
        return S.players[r.pid].name + (r.pid === HUMAN ? ' win ' : ' wins ') + chips(r.net) + (r.best ? ' with ' + r.best : '');
      }).join(' · ');
    }
    bannerEl.textContent = banner;

    renderActions();
    renderLog();
    renderThoughts();
  }

  function standings() {
    var order = S.players.slice().sort(function (a, b) {
      return b.score - a.score;
    });
    return 'Game over: ' + order.map(function (p, k) {
      return (k + 1) + '. ' + p.name;
    }).join(', ');
  }

  function button(label, key, className, onClick) {
    var node = el('button', 'poker-button' + (className ? ' ' + className : ''), label);
    node.type = 'button';
    if (key) node.appendChild(el('kbd', '', key));
    node.addEventListener('click', onClick);
    return node;
  }

  function renderActions() {
    actionsEl.textContent = '';
    var row = el('div', 'poker-row');
    actionsEl.appendChild(row);

    if (S.status === 'game_over') {
      row.appendChild(button('New game', '', 'is-main', newGame));
      return;
    }
    if (S.status === 'hand_over') {
      if (youAreOut()) row.appendChild(el('span', 'poker-quiet', 'You are out of chips. The bots are playing the game out.'));
      else row.appendChild(button('Next hand', 'Space', 'is-main', nextHand));
      return;
    }
    var o = S.options;
    if (status !== YOUR_TURN || !o) {
      var who = S.players.filter(function (p) { return p.acting; })[0];
      row.appendChild(el('span', 'poker-quiet', who && !who.human ? who.name + ' is thinking…' : ' '));
      return;
    }

    var canRaise = o.raise_min_to > 0;
    var min = canRaise ? o.raise_min_to : o.allin_to, max = o.allin_to;
    // Each decision starts from the smallest raise, not from the last one made.
    var decision = S.hand + '/' + S.rounds;
    if (decision !== raiseFor || !(raiseTo >= min && raiseTo <= max)) raiseTo = min;
    raiseFor = decision;

    row.appendChild(button('Fold', 'F', '', function () { act(FOLD); }));
    if (o.check) row.appendChild(button('Check', 'C', '', function () { act(CHECK); }));
    else if (o.call) row.appendChild(button('Call ' + chips(o.call), 'C', '', function () { act(CALL); }));
    if (o.allin) row.appendChild(button((o.call >= o.allin ? 'Call all-in ' : 'All-in ') + chips(o.allin), 'A', '', function () { act(ALL_IN); }));
    if (!canRaise) return;

    // The raise: a slider and a number that move together, and a few usual sizes.
    var raise = el('div', 'poker-raise');
    var slider = el('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = 1;
    slider.value = raiseTo;
    slider.setAttribute('aria-label', 'Raise to');
    var number = el('input');
    number.type = 'number';
    number.min = min;
    number.max = max;
    number.value = raiseTo;
    number.setAttribute('aria-label', 'Raise to');
    var amount = el('span', '', chips(raiseTo));
    var go = button((o.call || !S.board.length ? 'Raise to ' : 'Bet '), 'R', 'is-main', function () { act(RAISE, raiseTo); });
    go.insertBefore(amount, go.lastChild);

    function set(value) {
      raiseTo = Math.max(min, Math.min(max, Math.round(Number(value) || min)));
      slider.value = raiseTo;
      number.value = raiseTo;
      amount.textContent = chips(raiseTo);
    }
    slider.addEventListener('input', function () { set(slider.value); });
    number.addEventListener('change', function () { set(number.value); });
    raise.appendChild(slider);
    raise.appendChild(number);
    raise.appendChild(go);
    actionsEl.appendChild(raise);

    var toCall = o.rnd + o.call, potAfter = o.pot + o.call;
    function sized(fraction) {
      return Math.round(Math.min(max, Math.max(min, toCall + fraction * potAfter)));
    }
    var presets = el('div', 'poker-row poker-presets caps');
    presets.appendChild(el('span', 'poker-quiet', 'Raise to'));
    var sizes = [['Min', min], ['½ pot', sized(0.5)], ['¾ pot', sized(0.75)], ['Pot', sized(1)]];
    if (!S.board.length) sizes.push(['3×', Math.min(max, Math.max(min, 3 * Math.max(toCall, S.bb)))]);
    sizes.forEach(function (size) {
      var node = el('button', '', size[0] + ' ' + chips(size[1]));
      node.type = 'button';
      node.addEventListener('click', function () { set(size[1]); });
      presets.appendChild(node);
    });
    actionsEl.appendChild(presets);
  }

  function renderLog() {
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    logEl.textContent = '';
    (S.events || []).forEach(function (event) {
      logEl.appendChild(el('div', 'is-' + event.kind, event.text));
    });
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  // What the bot's decision tags mean, from play/index.html.
  var TAGS = {
    open: 'open-raise (rules)', iso: 'raise over limpers', complete: 'limp / complete', call: 'call (pot odds)', raise: 're-raise for value',
    check: 'check', bet: 'value bet', bluff: 'bluff (fold equity)', icm: 'big call decided by ICM', callff: 'call off the stack (pot odds)',
    'pf-sb': 'jam/fold chart (small blind)', 'pf-bb': 'call-the-shove chart (big blind)', 'pf-sb-om': 'shove by EV vs how you call shoves',
    'hu-evjam': 'shove by EV over a limp / small raise', 'pfn-jam': 'ICM push/fold chart: jam', 'pfn-call': 'ICM chart: call the jam',
    'pfn-rejam': 'ICM chart: re-jam', 'pfn-jam-lim': 'ICM chart: jam over limpers'
  };
  var HU_MOVES = { F: 'fold', K: 'check', C: 'call', R: 'raise', A: 'all-in', B: 'bet' };

  function tagText(tag) {
    if (TAGS[tag]) return TAGS[tag];
    if (tag.indexOf('hu-') === 0) return 'solved heads-up strategy: ' + (HU_MOVES[tag.charAt(3)] || tag);
    return '';
  }

  // The bot's note on its opponent model ("om0 h12 open0.35(4) ..."): its read of the visitor, in words.
  var NOTE = /om(\d+) h(\d+) open([\d.]+)\((\d+)\) limp([\d.]+)\((\d+)\) jam([\d.]+)\((\d+)\) f2r([\d.]+)\((\d+)\) bet([\d.]+)\((\d+)\) f2b([\d.]+)\((\d+)\)/;

  function readOfYou(text) {
    var m = NOTE.exec(text || '');
    if (!m || Number(m[1]) !== HUMAN) return '';
    function pct(x) { return Math.round(Number(x) * 100) + '%'; }
    function seen(n) { return Number(n) ? ' (' + n + ' seen)' : ' (assumed)'; }
    return 'Its read of you after ' + m[2] + ' hands: raises first in with the top ' + pct(m[3]) + seen(m[4]) +
      ' · limps the top ' + pct(m[5]) + seen(m[6]) + ' · shoves the top ' + pct(m[7]) + seen(m[8]) +
      ' · folds to a raise ' + pct(m[9]) + seen(m[10]) + ' · bets when checked to ' + pct(m[11]) + seen(m[12]) +
      ' · folds to a bet ' + pct(m[13]) + seen(m[14]);
  }

  function streetOf(board) {
    if (!board || board.charAt(0) === 'X') return 'preflop';
    var shown = board.split('_').filter(function (c) { return c !== 'X'; }).length;
    return shown === 3 ? 'flop' : shown === 4 ? 'turn' : 'river';
  }

  function renderThoughts() {
    if (!S.thoughts || !S.thoughts.length) return;
    thoughtsTitle.textContent = 'What the bots were thinking in hand ' + S.thoughts_hand;
    // Each bot's read of the visitor is shown once, after its last decision of the hand.
    var lastRead = {};
    S.thoughts.forEach(function (t, i) {
      if (readOfYou(t.note)) lastRead[t.pid] = i;
    });
    thoughtsEl.textContent = '';
    S.thoughts.forEach(function (t, i) {
      var line = el('div', 'poker-thought');
      line.appendChild(el('b', '', t.name));
      var what = ' ' + streetOf(t.board) + ': ' + String(t.action || '').toLowerCase().replace('_', ' ') + ' — ';
      line.appendChild(document.createTextNode(what));
      line.appendChild(el('code', '', t.tag));
      var meaning = tagText(t.tag || '');
      if (meaning === t.tag) meaning = '';
      var equity = t.eq >= 0 ? 'equity ' + Math.round(t.eq * 100) + '%' : '';
      line.appendChild(document.createTextNode(' ' + [meaning, equity].filter(Boolean).join(' · ')));
      if (lastRead[t.pid] === i) line.appendChild(el('div', 'poker-read', readOfYou(t.note)));
      thoughtsEl.appendChild(line);
    });
  }

  // Wiring ---------------------------------------------------------------------

  document.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey || !S || failed) return;
    var target = event.target;
    if (target && target.tagName === 'INPUT' && target.type !== 'range') return;
    var key = event.key.toLowerCase();
    var onControl = target && target.closest && target.closest('a, button');
    if (status === HAND_OVER && !youAreOut() && (key === 'n' || (key === ' ' && !onControl))) {
      event.preventDefault();
      nextHand();
      return;
    }
    var o = S.options;
    if (status !== YOUR_TURN || !o) return;
    if (key === 'f') act(FOLD);
    else if (key === 'c') act(o.check ? CHECK : CALL);
    else if (key === 'a' && o.allin) act(ALL_IN);
    else if (key === 'r' && o.raise_min_to > 0) act(RAISE, raiseTo);
  });

  noteButton.addEventListener('click', newGame);

  newButton.addEventListener('click', function () {
    newButton.blur();
    newGame();
  });

  // The option rows: one button of each row is pressed.
  Array.prototype.forEach.call(root.querySelectorAll('.choice'), function (row) {
    var name = row.getAttribute('data-option');
    var buttons = row.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (other) {
      if (other.getAttribute('aria-pressed') === 'true') options[name] = other.getAttribute('data-value');
      other.addEventListener('click', function () {
        var value = other.getAttribute('data-value');
        if (options[name] === value) return;
        options[name] = value;
        Array.prototype.forEach.call(buttons, function (each) {
          each.setAttribute('aria-pressed', each === other ? 'true' : 'false');
        });
        other.blur();
        // A different number of players means a new game; the pace applies from the next step.
        if (name === 'players') newGame();
      });
    });
  });

  // Start ----------------------------------------------------------------------

  newGame();
})();
