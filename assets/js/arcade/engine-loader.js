/*
 * Loads a game engine's WebAssembly module inside a worker. The workers for
 * the arcade games pull this in with importScripts().
 *
 * The engines are built in two ways, and loadEngine() handles both by looking
 * at what the module asks to import:
 *
 *   - wasm32-unknown-unknown modules (the alpha-beta Tron engine) import one
 *     function, env.now_ms, their clock.
 *   - wasm32-wasip1 modules (the Rust engines that use the standard library's
 *     clock) and the C++ engines built with Emscripten as standalone modules
 *     import a handful of WASI functions. An engine only needs the time,
 *     somewhere for an error message to go, and random bytes; anything to do
 *     with files is answered with "no such thing".
 */
'use strict';

var WASI_ESUCCESS = 0, WASI_EBADF = 8, WASI_ENOSYS = 52;

// The WASI functions, reading and writing the module's memory.
function wasiFunctions(getMemory) {
  var decoder = new TextDecoder();
  var pendingLine = '';

  function view() {
    return new DataView(getMemory().buffer);
  }

  function zeroCounts(countPtr, sizePtr) {
    var v = view();
    v.setUint32(countPtr, 0, true);
    v.setUint32(sizePtr, 0, true);
    return WASI_ESUCCESS;
  }

  return {
    // Clock 0 is the wall clock; the others count from an arbitrary start.
    clock_time_get: function (clock, precision, resultPtr) {
      var ms = clock === 0 ? Date.now() : performance.now();
      view().setBigUint64(resultPtr, BigInt(Math.round(ms * 1e6)), true);
      return WASI_ESUCCESS;
    },
    clock_res_get: function (clock, resultPtr) {
      view().setBigUint64(resultPtr, BigInt(1000), true);
      return WASI_ESUCCESS;
    },
    // Output goes to the console, a line at a time. Engines write only when
    // something has gone wrong (a panic message).
    fd_write: function (fd, iovs, iovsLen, writtenPtr) {
      var v = view(), bytes = new Uint8Array(getMemory().buffer), written = 0;
      for (var i = 0; i < iovsLen; i++) {
        var ptr = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
        pendingLine += decoder.decode(bytes.slice(ptr, ptr + len));
        written += len;
      }
      var lines = pendingLine.split('\n');
      pendingLine = lines.pop();
      lines.forEach(function (line) {
        console.warn('[engine] ' + line);
      });
      v.setUint32(writtenPtr, written, true);
      return WASI_ESUCCESS;
    },
    random_get: function (ptr, len) {
      var bytes = new Uint8Array(getMemory().buffer, ptr, len);
      for (var at = 0; at < len; at += 65536) {
        crypto.getRandomValues(bytes.subarray(at, Math.min(len, at + 65536)));
      }
      return WASI_ESUCCESS;
    },
    environ_sizes_get: zeroCounts,
    environ_get: function () { return WASI_ESUCCESS; },
    args_sizes_get: zeroCounts,
    args_get: function () { return WASI_ESUCCESS; },
    sched_yield: function () { return WASI_ESUCCESS; },
    proc_exit: function (code) {
      throw new Error('the engine stopped (exit code ' + code + ')');
    },
    // No files: every descriptor other than the output streams is invalid.
    fd_close: function () { return WASI_EBADF; },
    fd_read: function () { return WASI_EBADF; },
    fd_seek: function () { return WASI_EBADF; },
    fd_fdstat_get: function () { return WASI_EBADF; },
    fd_prestat_get: function () { return WASI_EBADF; },
    fd_prestat_dir_name: function () { return WASI_EBADF; }
  };
}

// Fetch, compile and start the module at `url`. Resolves to its exports.
function loadEngine(url) {
  return fetch(url)
    .then(function (response) {
      if (!response.ok) throw new Error(String(url).split('/').pop() + ': HTTP ' + response.status);
      return response.arrayBuffer();
    })
    .then(function (bytes) {
      return WebAssembly.compile(bytes);
    })
    .then(function (module) {
      var memory = null;
      var wasi = wasiFunctions(function () { return memory; });
      var imports = {};
      WebAssembly.Module.imports(module).forEach(function (item) {
        if (item.kind !== 'function') return;
        var group = imports[item.module] || (imports[item.module] = {});
        if (item.module === 'wasi_snapshot_preview1') {
          group[item.name] = wasi[item.name] || function () { return WASI_ENOSYS; };
        } else if (item.module === 'env' && item.name === 'now_ms') {
          group[item.name] = function () { return performance.now(); };
        } else if (item.module === 'env' && item.name === 'emscripten_notify_memory_growth') {
          // The C++ engines say when their memory has grown. Nothing here
          // holds on to the old buffer, so there is nothing to do.
          group[item.name] = function () {};
        } else {
          group[item.name] = function () {
            throw new Error('the engine called ' + item.module + '.' + item.name + ', which the page does not provide');
          };
        }
      });
      return WebAssembly.instantiate(module, imports).then(function (instance) {
        memory = instance.exports.memory;
        // WASI modules built as libraries set themselves up in _initialize.
        if (instance.exports._initialize) instance.exports._initialize();
        return instance.exports;
      });
    });
}
