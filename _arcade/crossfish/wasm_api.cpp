// WebAssembly facade for the crossfish Ultimate Tic-Tac-Toe engine (cpp_impl/codingame_nnue.cpp).
//
// The upstream source is included, not copied: build.sh passes -I<checkout>/cpp_impl. Upstream's
// main() is renamed away. One static game, one heap engine, a plain C ABI (see README.md).
//
// Numbering: upstream already uses board = row-major 3x3 of small boards, cell = row-major 3x3
// inside a small board (its grid_coord_to_move: board = (row/3)*3 + col/3, square = (row%3)*3 +
// col%3), player 0 = markers[0] moves first. So the API indices ARE upstream's; no conversion.
#include "cf_stdlib_shim.hpp"  // makes libc++ draw the same Zobrist keys as libstdc++ (see the header)
#define main crossfish_upstream_main_unused
#include "codingame_nnue.cpp"
#undef main

#include <climits>

namespace {

GlobalBoard *g_board = nullptr;
CrossfishDev *g_engine = nullptr;
bool g_warm = false;
int g_last_depth = 0, g_last_nodes = 0, g_last_score = 0;

// The first search of the process decodes the network, bakes the macro table and builds the
// static lookup tables. Pay for that once, in cf_new, with a throwaway depth-1 search (the same
// warm-up cg_selfcheck uses; it cannot change any later result: the tables are pure functions of
// the packed data).
void warm_up() {
    if (g_warm) return;
    g_warm = true;
    pb_init<GlobalBoard, Move>([](const PbView &v, int c) { return b64::evaluate_board(v, c); });
    CrossfishDev *tmp = new CrossfishDev();
    GlobalBoard start;
    int ignored = 0;
    tmp->search_fixed_depth(start, 1, ignored);
    delete tmp;
}

int legal_moves(Move *buf) {  // 0 when the game is over
    if (g_board->checkWinner() != -1) return 0;
    return g_board->fillLegalMoves(buf);
}

}  // namespace

extern "C" {

void cf_new() {
    warm_up();
    delete g_board;
    delete g_engine;
    g_board = new GlobalBoard();
    g_engine = new CrossfishDev();  // 1.2 MB: heap, never the stack
    g_last_depth = g_last_nodes = g_last_score = 0;
}

int cf_play(int board, int cell) {
    if (!g_board) cf_new();
    if (board < 0 || board > 8 || cell < 0 || cell > 8) return 0;
    Move buf[81];
    int n = legal_moves(buf);
    for (int i = 0; i < n; i++) {
        if (buf[i].mini_board == board && buf[i].square == cell) {
            g_board->makeMove(buf[i]);
            return 1;
        }
    }
    return 0;
}

int cf_think(int ms) {
    if (!g_board) cf_new();
    if (g_board->checkWinner() != -1) return -1;
    if (ms < 1) ms = 20;  // as run_match does
    GlobalBoard copy = *g_board;
    Move best = g_engine->getMove(copy, std::chrono::milliseconds(ms));
    g_last_depth = g_engine->depth;
    g_last_nodes = g_engine->nodes;
    g_last_score = g_engine->root_score;
    if (g_board->n_moves == 0) {
        // CodinGame's first move is fixed (the search above only warms the persistent tables).
        best = Move{4, 4};
    } else {
        Move book_move;
        if (pb_lookup(*g_board, book_move)) best = book_move;  // no book ships: never true
    }
    return best.mini_board * 9 + best.square;
}

int cf_legal(int board) {
    if (!g_board) cf_new();
    if (board < 0 || board > 8) return 0;
    Move buf[81];
    int n = legal_moves(buf), mask = 0;
    for (int i = 0; i < n; i++)
        if (buf[i].mini_board == board) mask |= 1 << buf[i].square;
    return mask;
}

int cf_cell(int board, int cell) {
    if (!g_board) cf_new();
    if (board < 0 || board > 8 || cell < 0 || cell > 8) return 0;
    if (g_board->mini_boards[board].markers[0] & (1 << cell)) return 1;
    if (g_board->mini_boards[board].markers[1] & (1 << cell)) return 2;
    return 0;
}

int cf_board_state(int board) {
    if (!g_board) cf_new();
    if (board < 0 || board > 8) return 0;
    if (g_board->mini_board_states[0] & (1 << board)) return 1;
    if (g_board->mini_board_states[1] & (1 << board)) return 2;
    if (g_board->mini_board_states[2] & (1 << board)) return 3;
    return 0;
}

int cf_winner() {
    if (!g_board) cf_new();
    return g_board->checkWinner();
}

int cf_to_move() {
    if (!g_board) cf_new();
    return g_board->n_moves & 1;
}

int cf_last_depth() { return g_last_depth; }
int cf_last_nodes() { return g_last_nodes < 0 ? INT_MAX : g_last_nodes; }
int cf_last_score() { return g_last_score; }

#ifdef CF_TEST  // test builds only (build.sh --test); never in the shipped module
void cf_test_fixed_depth(int d) { g_fixed_search_depth = d; }  // 0 = timed search again
void cf_test_fresh_engine() { delete g_engine; g_engine = new CrossfishDev(); }
#endif

}  // extern "C"
