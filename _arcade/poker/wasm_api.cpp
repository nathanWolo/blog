// wasm_api.cpp - one game of CodinGame-Poker hold'em, a human (seat 0) against cgpoker bots, as a C ABI
// for WebAssembly.  Upstream (https://github.com/nathanWolo/cgpoker) is included, never copied: build.sh
// passes its checkout as -I.  Upstream's Engine::game_turn calls the agent synchronously; a human cannot
// answer inside a worker, so SplitEngine::pre / ::post below are game_turn cut in two at the agent call.
// The state JSON is a port of play/server.py (Game.state, finish_hand, narrate).  See README.md.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <exception>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "engine/poker_engine.hpp"
#include "bot/bot.hpp"

namespace pkw {

using pk::Obs;

static const char* CATEGORY[] = {"high card", "a pair", "two pair", "three of a kind", "a straight",
                                 "a flush", "a full house", "four of a kind", "a straight flush"};
static const char* BOT_NAMES[] = {"Bot A", "Bot B", "Bot C"};
static const int MAX_KEEP_HANDS = 2;   // the current and the previous hand

// ----------------------------------------------------------------------------- game_turn in two halves
struct SplitEngine : pk::Engine {
  using pk::Engine::Engine;

  // Referee.gameTurn up to the agent call.  Returns true when seat `pid` has to answer `obs` (turn and the
  // obs bookkeeping are already done); false when the frame finished without needing an action.
  bool pre(int t, int& pid, Obs& obs) {
    if (calculate_player_winnings()) { do_board_over(); return false; }
    if (over || t == 1) {
      if (t != 1) { reset_hand(); init_deck(); init_blind(); note_hand_start(); calculate_next_player(); }
      deal_first();
      calc_next = false;
      return false;
    }
    size_t n_cards = board.size();
    end_turn();
    if (n_cards != board.size()) {
      if (last_hand_round != hand_nb) {
        turn++;
        if (turn > pk::MAX_TURN) throw std::runtime_error("referee would crash: NONE round 601 (InputSender.java:21,30)");
        round_infos[turn] = {turn, hand_nb, -1, "NONE", board_str()};
        last_hand_round = hand_nb;
      }
      return false;
    }
    if (calculate_player_winnings()) { do_board_over(); return false; }
    if (turn == pk::MAX_TURN) {
      if (!over) for (auto& p : players) p.stack += p.total, p.total = 0;
      cancelled = true;
      final_scores();
      game_over = true;
      return false;
    }
    if (deal()) { calculate_next_player(); calc_next = false; return false; }
    if (calc_next) calculate_next_player();
    calc_next = true;
    pid = next_player;
    if (pid < 0 || pid >= n) throw std::runtime_error("no player to act");
    turn++;
    obs = build_obs(pid);
    return true;
  }

  // The rest of Referee.gameTurn: the agent's raw output line `out` (ok = false: a timeout) is applied.
  void post(int pid, bool ok, const std::string& out) {
    Parsed pr;
    if (!ok) pr = {pk::A_TIMEOUT, 0, true};
    else pr = parse(out.substr(0, out.find(';')));
    auto rp = replace(pr.t, pr.amount);
    if (ok && (pr.err || rp.first != pr.t || (rp.first == pk::A_BET && rp.second != pr.amount))) replaced[pid]++;
    std::string shown = pk::act_name(rp.first);
    if (rp.first == pk::A_BET) shown += "_" + std::to_string(rp.second);
    round_infos[turn] = {turn, hand_nb, pid, shown, board_str()};
    last_hand_round = hand_nb;
    do_action(rp.first, rp.second);
    log.push_back({turn, hand_nb, pid, shown});
  }
};

// ----------------------------------------------------------------------------- JSON helpers
static std::string js(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
static const char* jb(bool b) { return b ? "true" : "false"; }
static std::string pretty(const std::string& card) {   // "TD" -> "10" + diamond
  std::string r = card[0] == 'T' ? "10" : std::string(1, card[0]);
  switch (card[1]) {
    case 'S': return r + "\xE2\x99\xA0";
    case 'H': return r + "\xE2\x99\xA5";
    case 'D': return r + "\xE2\x99\xA6";
    default: return r + "\xE2\x99\xA3";
  }
}
static std::string strip(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && (unsigned char)s[a] <= ' ') a++;
  while (b > a && (unsigned char)s[b - 1] <= ' ') b--;
  return s.substr(a, b - a);
}

struct Event { int hand; std::string text, kind; };
struct Thought { int round, hand, pid; double eq; std::string tag, note; };
struct PlayerResult { int pid; bool out = false; std::vector<std::string> cards; int net = 0; bool folded = false; std::string best; };
struct Result { int hand = 0; std::vector<std::string> board; bool showdown = false; std::vector<PlayerResult> players; };

// ----------------------------------------------------------------------------- the game
struct Session {
  int n = 2;
  int64_t seed = 0;
  std::unique_ptr<SplitEngine> eng;
  std::vector<std::unique_ptr<bot::Bot>> bots;   // null for the human seat
  bool human_seat = true;                        // false: every seat is a bot (tests)
  bot::Budget budget;
  std::string status = "running";                // running | hand_over | game_over
  bool broken = false;
  int t = 0;                                     // referee frames, as server.py's loop counter
  int acting = -1;
  bool pending = false;                          // the human has to answer
  Obs pend_obs;
  std::vector<std::string> names;
  std::vector<std::string> last_action;
  std::map<int, std::vector<int>> hand_start;
  std::vector<Event> events;
  std::vector<Thought> thoughts;
  std::map<int, Result> results;
  void (*hook)(Session&, int pid) = nullptr;     // tests: called at every decision, before it is answered

  Session(int n_, int64_t seed_, bool human) : n(n_), seed(seed_), human_seat(human) {
    eng.reset(new SplitEngine(n, seed));
    budget.ms = 15; budget.min_trials = 2000; budget.max_trials = 100000;   // bot/main.cpp: 15 ms, Budget's trial limits
    names.push_back("You");
    for (int i = 1; i < n; i++) names.push_back(BOT_NAMES[i - 1]);
    last_action.assign(n, "");
    bots.resize(n);
    for (int i = human ? 1 : 0; i < n; i++) {
      bots[i].reset(new bot::Bot());
      bots[i]->use_fast = true;                  // pe::init() has run (main.cpp sets this once its tables are ready)
    }
  }

  // ---- events (server.py: event, said, narrate, finish_hand)
  void event(const std::string& text, const char* kind = "action") { events.push_back({eng->hand_nb, text, kind}); }
  std::string said(int pid, const std::string& third, const std::string& second) const {
    return names[pid] + " " + (pid == 0 && human_seat ? second : third);
  }
  bool is_human(int pid) const { return human_seat && pid == 0; }

  void narrate(int pid, const std::string& shown, int before_total, int max_rnd_before) {
    const pk::Player& p = eng->players[pid];
    int added = p.total - before_total;
    std::string a = std::to_string(added), r = std::to_string(p.rnd);
    std::string third, second, status_s;
    if (shown == "FOLD") third = "folds", second = "fold", status_s = "folded";
    else if (shown == "CHECK") third = "checks", second = "check", status_s = "checked";
    else if (shown == "CALL") third = "calls " + a, second = "call " + a, status_s = "called " + a;
    else if (shown == "ALL-IN" && p.rnd > max_rnd_before) third = "is all-in (" + r + ")", second = "are all-in (" + r + ")", status_s = "all-in";
    else if (shown == "ALL-IN") third = "calls all-in (" + a + ")", second = "call all-in (" + a + ")", status_s = "all-in";
    else if (shown.rfind("BET", 0) == 0 && max_rnd_before > 0) third = "raises to " + r, second = "raise to " + r, status_s = "raised to " + r;
    else if (shown.rfind("BET", 0) == 0) third = "bets " + a, second = "bet " + a, status_s = "bet " + a;
    else third = "times out", second = "time out", status_s = "timed out";
    last_action[pid] = status_s;
    event(said(pid, third, second));
  }

  void new_hand_event() {
    pk::Board& b = *eng;
    hand_start[b.hand_nb].clear();
    for (auto& p : b.players) hand_start[b.hand_nb].push_back(p.stack + p.total);
    last_action.assign(n, "");
    int dealer = b.dealer_id >= 0 ? b.dealer_id : b.sb_id;
    event("Hand " + std::to_string(b.hand_nb) + " \xC2\xB7 blinds " + std::to_string(b.sb) + "/" + std::to_string(b.bb) +
          " \xC2\xB7 " + names[dealer] + " on the button", "hand");
    // keep the current and the previous hand only
    int lo = b.hand_nb - (MAX_KEEP_HANDS - 1);
    events.erase(std::remove_if(events.begin(), events.end(), [&](const Event& e) { return e.hand < lo; }), events.end());
    thoughts.erase(std::remove_if(thoughts.begin(), thoughts.end(), [&](const Thought& x) { return x.hand < lo; }), thoughts.end());
    for (auto it = results.begin(); it != results.end();) it = it->first < lo ? results.erase(it) : std::next(it);
    for (auto it = hand_start.begin(); it != hand_start.end();) it = it->first < lo ? hand_start.erase(it) : std::next(it);
  }

  void finish_hand(int h) {
    pk::Board& b = *eng;
    const SplitEngine::Showdown& sd = eng->showdowns[h];
    Result res;
    res.hand = h;
    { std::string cur; for (char c : sd.board + "_") { if (c == '_') { if (!cur.empty() && cur != "X") res.board.push_back(cur); cur.clear(); } else cur += c; } }
    const std::vector<int>& start = hand_start.count(h) ? hand_start[h] : std::vector<int>();
    int live = 0;
    for (auto& p : b.players) live += !p.folded && !p.eliminated;
    res.showdown = live > 1 && res.board.size() == 5;
    for (auto& p : b.players) {
      PlayerResult r;
      r.pid = p.id;
      if (sd.elim[p.id]) { r.out = true; res.players.push_back(r); continue; }
      for (int k = 0; k < p.n_hand; k++) r.cards.push_back(pk::card_str(p.hand[k]));
      r.net = p.stack - (start.empty() ? p.stack : start[p.id]);
      r.folded = p.folded;
      if (res.showdown && !p.folded && !p.eliminated) r.best = CATEGORY[pk::best7(p.hand, b.board) >> 20];
      res.players.push_back(r);
    }
    results[h] = res;
    for (auto& r : res.players) {
      if (r.out || r.net <= 0) continue;
      std::string how = r.best.empty() ? "" : " with " + r.best;
      event(said(r.pid, "wins " + std::to_string(r.net) + how, "win " + std::to_string(r.net) + how), "result");
    }
    for (auto& p : b.players)
      if (p.stack == 0 && !start.empty() && start[p.id] > 0)
        event(is_human(p.id) ? "You are out: the bots play the game out" : names[p.id] + " is out", "result");
  }

  void game_over_event() {
    std::vector<int> order(n);
    for (int i = 0; i < n; i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) {
      const pk::Player &x = eng->players[a], &y = eng->players[b];
      if (x.score != y.score) return x.score > y.score;
      return x.elim_rank < y.elim_rank;
    });
    std::string s = "Game over: ";
    for (int k = 0; k < n; k++) s += (k ? ", " : "") + std::to_string(k + 1) + ". " + names[order[k]];
    event(s, "result");
  }

  // ---- the bot
  std::string bot_act(int pid, const Obs& obs) {
    auto t0 = bot::Clock::now();
    bot::Bot& b = *bots[pid];
    std::string out = b.act(obs, budget, t0);
    Thought th;
    th.round = obs.round; th.hand = obs.hand_nb; th.pid = pid; th.eq = b.last_equity; th.tag = b.last_tag;
    std::string note = strip(b.last_note);   // server.py: the part of the bot's stderr line from "om" on
    size_t k = note.find("om");
    th.note = k == std::string::npos ? "" : note.substr(k);
    char eb[32]; snprintf(eb, sizeof eb, "%.3f", th.eq);
    th.eq = atof(eb);
    thoughts.push_back(th);
    return out;
  }

  // Apply seat `pid`'s answer (post-half of the frame) and narrate it.
  void apply(int pid, const std::string& out) {
    pk::Board& b = *eng;
    int before_total = b.players[pid].total, max_rnd = 0;
    for (auto& p : b.players) max_rnd = std::max(max_rnd, p.rnd);
    size_t log_n = eng->log.size();
    eng->post(pid, true, out);
    for (size_t i = log_n; i < eng->log.size(); i++) narrate(eng->log[i].pid, eng->log[i].shown, before_total, max_rnd);
    acting = -1;
  }

  // ---- the loop (server.py Game.run, a frame at a time, stopping at the next visible thing)
  // returns: 0 more to do, 1 the human has to act, 2 hand over, 3 game over
  int advance() {
    for (;;) {
      if (eng->game_over) return finish_game();
      if (t >= pk::MAX_REFEREE_TURN) { eng->game_over = true; return finish_game(); }
      t++;
      int hand = eng->hand_nb;
      size_t board_n = eng->board.size();
      int pid = -1;
      Obs obs;
      bool need = eng->pre(t, pid, obs);
      if (need) {
        acting = pid;
        if (is_human(pid)) { pend_obs = obs; pending = true; }
        if (hook) hook(*this, pid);
        if (is_human(pid)) return 1;
        apply(pid, bot_act(pid, obs));
        return 0;
      }
      bool visible = false;
      if (eng->hand_nb != hand || t == 1) { new_hand_event(); visible = true; }
      if (eng->board.size() > board_n) {
        size_t m = eng->board.size();
        std::string street = m == 3 ? "Flop" : m == 4 ? "Turn" : "River", cards;
        for (size_t i = m == 3 ? 0 : m - 1; i < m; i++) cards += (cards.empty() ? "" : " ") + pretty(pk::card_str(eng->board[i]));
        event(street + ": " + cards, "street");
        visible = true;
      }
      int h = eng->hand_nb;
      if ((int)eng->showdowns.size() > h && !eng->showdowns[h].board.empty() && !results.count(h)) {
        finish_hand(h);
        if (!eng->game_over) { status = "hand_over"; return 2; }
        return finish_game();
      }
      if (eng->game_over) return finish_game();
      if (visible) return 0;
    }
  }
  int finish_game() {
    if (status != "game_over") { status = "game_over"; game_over_event(); }
    return 3;
  }

  // ---- the page's view (server.py Game.state)
  std::string state_json() const {
    const pk::Board& b = *eng;
    int h = b.hand_nb;
    const Result* res = nullptr;
    if (status == "hand_over" || status == "game_over") { auto it = results.find(h); if (it != results.end()) res = &it->second; }
    int pot = 0;
    for (auto& p : b.players) pot += p.total;
    std::string o = "{";
    o += "\"status\":" + js(status) + ",\"hand\":" + std::to_string(h) + ",\"sb\":" + std::to_string(b.sb) + ",\"bb\":" + std::to_string(b.bb) +
         ",\"level\":" + std::to_string(b.level) + ",\"pot\":" + std::to_string(pot) + ",\"board\":[";
    for (size_t i = 0; i < b.board.size(); i++) o += (i ? "," : "") + js(pk::card_str(b.board[i]));
    o += "],\"players\":[";
    for (auto& p : b.players) {
      std::vector<std::string> cards;
      const PlayerResult* rv = nullptr;
      if (res) for (auto& r : res->players) if (r.pid == p.id && !r.out) rv = &r;
      if (is_human(p.id) || rv) { for (int k = 0; k < p.n_hand; k++) cards.push_back(pk::card_str(p.hand[k])); }
      else if (p.n_hand > 0 && !p.eliminated) cards = {"??", "??"};
      int dealer = b.dealer_id >= 0 ? b.dealer_id : b.sb_id;
      if (p.id) o += ",";
      o += "{\"id\":" + std::to_string(p.id) + ",\"name\":" + js(names[p.id]) + ",\"human\":" + jb(is_human(p.id)) +
           ",\"stack\":" + std::to_string(p.stack) + ",\"bet\":" + std::to_string(p.rnd) + ",\"total\":" + std::to_string(p.total) +
           ",\"folded\":" + jb(p.folded && !p.eliminated) + ",\"allin\":" + jb(p.allin) +
           ",\"out\":" + jb(p.eliminated || (p.stack == 0 && p.total == 0)) + ",\"dealer\":" + jb(p.id == dealer) +
           ",\"sb\":" + jb(p.id == b.sb_id) + ",\"bbpos\":" + jb(p.id == b.bb_id) + ",\"cards\":[";
      for (size_t k = 0; k < cards.size(); k++) o += (k ? "," : "") + js(cards[k]);
      o += "],\"acting\":" + std::string(jb(p.id == acting)) + ",\"last\":" + js(last_action[p.id]) + ",\"score\":" + std::to_string(p.score) + "}";
    }
    o += "],\"acting\":" + std::to_string(acting) + ",\"options\":";
    if (pending && acting == 0 && human_seat) {
      const pk::Player& me = b.players[0];
      const std::vector<std::string>& pos = pend_obs.possible;
      auto has = [&](const char* s) { return std::find(pos.begin(), pos.end(), s) != pos.end(); };
      int bet = 0; bool has_bet = false;
      for (auto& a : pos) if (a.compare(0, 4, "BET_") == 0) { bet = atoi(a.c_str() + 4); has_bet = true; break; }
      o += "{\"fold\":" + std::string(jb(has("FOLD"))) + ",\"check\":" + jb(has("CHECK")) + ",\"call\":" + std::to_string(has("CALL") ? b.call_amount(me) : 0) +
           ",\"allin\":" + std::to_string(has("ALL-IN") ? me.stack : 0) + ",\"allin_to\":" + std::to_string(me.rnd + me.stack) +
           ",\"raise_min_to\":" + std::to_string(has_bet ? me.rnd + bet : 0) + ",\"raise_max_to\":" + std::to_string(has_bet ? me.rnd + me.stack - 1 : 0) +
           ",\"rnd\":" + std::to_string(me.rnd) + ",\"pot\":" + std::to_string(pot) + ",\"bb\":" + std::to_string(b.bb) + "}";
    } else o += "null";
    o += ",\"events\":[";
    size_t from = events.size() > 150 ? events.size() - 150 : 0;
    for (size_t i = from; i < events.size(); i++)
      o += std::string(i > from ? "," : "") + "{\"hand\":" + std::to_string(events[i].hand) + ",\"text\":" + js(events[i].text) + ",\"kind\":" + js(events[i].kind) + "}";
    o += "],\"result\":";
    if (res) {
      o += "{\"hand\":" + std::to_string(res->hand) + ",\"board\":[";
      for (size_t i = 0; i < res->board.size(); i++) o += (i ? "," : "") + js(res->board[i]);
      o += std::string("],\"showdown\":") + jb(res->showdown) + ",\"players\":[";
      for (size_t i = 0; i < res->players.size(); i++) {
        const PlayerResult& r = res->players[i];
        if (i) o += ",";
        if (r.out) { o += "{\"pid\":" + std::to_string(r.pid) + ",\"out\":true}"; continue; }
        o += "{\"pid\":" + std::to_string(r.pid) + ",\"cards\":[";
        for (size_t k = 0; k < r.cards.size(); k++) o += (k ? "," : "") + js(r.cards[k]);
        o += "],\"net\":" + std::to_string(r.net) + ",\"folded\":" + jb(r.folded) + ",\"best\":" + js(r.best) + "}";
      }
      o += "]}";
    } else o += "null";
    // thoughts of the last finished hand (the one before this one while a hand is running)
    int last_done = 0;
    for (auto& kv : results) if (status != "running" || kv.first < h) last_done = std::max(last_done, kv.first);
    o += ",\"thoughts\":[";
    bool first = true;
    for (auto& t_ : thoughts) {
      if (t_.hand != last_done) continue;
      std::string action, board;
      if (t_.round >= 1 && t_.round < (int)eng->round_infos.size()) { action = eng->round_infos[t_.round].shown; board = eng->round_infos[t_.round].board; }
      char eb[32]; snprintf(eb, sizeof eb, "%.3f", t_.eq);
      o += std::string(first ? "" : ",") + "{\"round\":" + std::to_string(t_.round) + ",\"hand\":" + std::to_string(t_.hand) + ",\"pid\":" + std::to_string(t_.pid) +
           ",\"eq\":" + eb + ",\"tag\":" + js(t_.tag) + ",\"note\":" + js(t_.note) + ",\"name\":" + js(names[t_.pid]) +
           ",\"action\":" + js(action) + ",\"board\":" + js(board) + "}";
      first = false;
    }
    o += "],\"thoughts_hand\":" + std::to_string(last_done) + ",\"seed\":" + std::to_string(seed) +
         ",\"seed_lo\":" + std::to_string((uint32_t)((uint64_t)seed)) + ",\"seed_hi\":" + std::to_string((uint32_t)((uint64_t)seed >> 32)) +
         ",\"delay\":0.0,\"auto_next\":false,\"rounds\":" + std::to_string(b.turn) + ",\"n\":" + std::to_string(n) + "}";
    return o;
  }

  // ---- the human's action
  int act(int kind, int amount) {
    if (!pending || status != "running") return -1;
    const pk::Player& me = eng->players[0];
    const std::vector<std::string>& pos = pend_obs.possible;
    auto has = [&](const char* s) { return std::find(pos.begin(), pos.end(), s) != pos.end(); };
    std::string out;
    if (kind == 0) { if (!has("FOLD")) return -1; out = "FOLD"; }
    else if (kind == 1) { if (!has("CHECK")) return -1; out = "CHECK"; }
    else if (kind == 2) { if (!has("CALL")) return -1; out = "CALL"; }
    else if (kind == 3) { if (!has("ALL-IN")) return -1; out = "ALL-IN"; }
    else if (kind == 4) {
      int min_add = -1;
      for (auto& a : pos) if (a.compare(0, 4, "BET_") == 0) min_add = atoi(a.c_str() + 4);
      if (min_add < 0) return -1;
      int add = amount - me.rnd;
      if (add >= me.stack) { if (add != me.stack || !has("ALL-IN")) return -1; out = "ALL-IN"; }   // raising to exactly all-in chips
      else if (add < min_add) return -1;
      else out = "BET " + std::to_string(add);
    } else return -1;
    pending = false;
    apply(0, out);
    return 0;
  }

  int next_hand() {
    if (status != "hand_over") return -1;
    status = "running";
    int r = advance();
    return r < 0 ? -1 : 0;
  }
  int step() {
    if (status == "hand_over") return 2;
    if (status == "game_over") return 3;
    if (pending) return 1;
    return advance();
  }
  void start() {                       // frame 1 deals hand 1 (server.py: the loop's first iteration)
    t = 1;
    int pid = -1; Obs obs;
    eng->pre(1, pid, obs);
    new_hand_event();
  }
};

}  // namespace pkw

// ----------------------------------------------------------------------------- C ABI
#ifndef PK_NO_EXPORTS
static std::unique_ptr<pkw::Session> g_game;
static std::string g_state = "{\"status\":\"none\"}", g_error;
static bool g_inited = false;
static bot::Budget g_budget = [] { bot::Budget b; b.ms = 15; b.min_trials = 2000; b.max_trials = 100000; return b; }();

static void refresh() { g_state = g_game ? g_game->state_json() : std::string("{\"status\":\"none\"}"); }
static void ensure_init() { if (!g_inited) { pe::init(); g_inited = true; } }
static void fail(const char* where, const std::string& what) {
  g_error = std::string(where) + ": " + what;
  if (g_game) g_game->broken = true;
}

#define PK_EXPORT extern "C" __attribute__((used, visibility("default")))

PK_EXPORT int pk_init() {                     // optional: builds the evaluator tables now rather than at the first game
  try { ensure_init(); return 0; }
  catch (const std::exception& e) { g_error = std::string("pk_init: ") + e.what(); return 1; }
  catch (...) { g_error = "pk_init: unknown exception"; return 1; }
}

PK_EXPORT int pk_new_game(int players, unsigned seed_lo, unsigned seed_hi) {
  try {
    if (players < 2 || players > 4) { g_error = "pk_new_game: players must be 2..4"; return 1; }
    ensure_init();
    int64_t seed = (int64_t)(((uint64_t)seed_hi << 32) | seed_lo);
    g_game.reset(new pkw::Session(players, seed, true));
    g_game->budget = g_budget;
    g_game->start();
    refresh();
    g_error.clear();
    return 0;
  } catch (const std::exception& e) { g_game.reset(); fail("pk_new_game", e.what()); }
  catch (...) { g_game.reset(); fail("pk_new_game", "unknown exception"); }
  refresh();
  return 1;
}

PK_EXPORT int pk_step() {
  if (!g_game) { g_error = "pk_step: no game"; return -1; }
  if (g_game->broken) return -1;
  try { int r = g_game->step(); refresh(); return r; }
  catch (const std::exception& e) { fail("pk_step", e.what()); }
  catch (...) { fail("pk_step", "unknown exception"); }
  refresh();
  return -1;
}

PK_EXPORT int pk_act(int kind, int amount) {
  if (!g_game || g_game->broken) return -1;
  try { int r = g_game->act(kind, amount); refresh(); return r; }
  catch (const std::exception& e) { fail("pk_act", e.what()); }
  catch (...) { fail("pk_act", "unknown exception"); }
  refresh();
  return -1;
}

PK_EXPORT int pk_next_hand() {
  if (!g_game || g_game->broken) return -1;
  try { int r = g_game->next_hand(); refresh(); return r; }
  catch (const std::exception& e) { fail("pk_next_hand", e.what()); }
  catch (...) { fail("pk_next_hand", "unknown exception"); }
  refresh();
  return -1;
}

PK_EXPORT const char* pk_state_ptr() { return g_state.c_str(); }
PK_EXPORT int pk_state_len() { return (int)g_state.size(); }

PK_EXPORT void pk_set_budget(int ms, int trials) {
  g_budget.ms = ms;
  if (trials > 0) { g_budget.min_trials = trials; g_budget.max_trials = std::max(100000, 2 * trials); }
  if (g_game) g_game->budget = g_budget;
}

PK_EXPORT const char* pk_error_ptr() { return g_error.c_str(); }
PK_EXPORT int pk_error_len() { return (int)g_error.size(); }
#endif
