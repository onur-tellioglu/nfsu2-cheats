// ==UserScript==
// @name         NFSU2 Web: own-car hover / warp / boost
// @namespace    local.nfsu2.owncar
// @version      1.5.8
// @description  Hotkey toggles for the player's own car on nfsu2.xyz (free roam; races behind Alt+9, with a tighter preset in races): hover, short forward warp, speed boost, nitrous refill, grip.
// @match        https://nfsu2.xyz/*
// @match        https://*.nfsu2.xyz/*
// @match        http://localhost/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1/*
// @match        http://127.0.0.1:*/*
// @run-at       document-start
// @grant        unsafeWindow
// @sandbox      JavaScript
// @noframes
// @updateURL    https://raw.githubusercontent.com/onur-tellioglu/nfsu2-cheats/main/nfsu2-owncar.user.js
// @downloadURL  https://raw.githubusercontent.com/onur-tellioglu/nfsu2-cheats/main/nfsu2-owncar.user.js
// ==/UserScript==
/* global exportFunction, cloneInto, XPCNativeWrapper, globalThis */

/*
 * Layout source: github.com/th0mk/nfsu2-web @ f5f3bf68.
 *  - Guest address == wasm linear-memory offset (runtime/cpu.h: g_guest is a weak symbol at 0, GUEST_END 0x28000000).
 *  - Page owns the shared WebAssembly.Memory in Chrome/Firefox (web/src/host/process.ts allocMemory); WebKit gets the
 *    buffer from the io worker by message (memory.ts memoryOffPage). Both paths are hooked below, on the page realm:
 *    Tampermonkey @sandbox JavaScript runs it in the page on Chrome (raw) and in a Firefox USERSCRIPT_WORLD that
 *    reaches the page through unsafeWindow + exportFunction / cloneInto; Violentmonkey uses @inject-into page.
 *  - Player*: [SPLIT_PLAYERS_INDEX = 0x00D00000] in the wasm build (splitscreen_mem.h), 0x008900AC originally; car = [Player+4].
 *  - Car: +0x0C CarTypeInfo*, +0x28 physics mode (1 = physics drives), +0x30 controls (+0x20C throttle, +0x214 brake,
 *    +0x1E0 steer i16), +0x3C body (+0x5C nonzero, +0x68 rigid body), +0x60 place, +0x70 velocity, +0x90/+0xA0/+0xB0
 *    forward/left/up, +0x110 spin, +0x390 u8[4] ground, +0x40C heading u16, +0x42C speed.
 *  - Rigid body: +0x20 place, +0x70 momentum (velocity x mass in t), +0x80 angular momentum, +0xA0 velocity, +0xC0 spin.
 *    Velocity must be written together with momentum or the next step undoes it (roam_game.c comment above contact_get,
 *    and the "mp traffic go" test command, which writes car+0x70, rb+0xA0, rb+0x70).
 *  - Hot-position jump: 0x890140 vec3, 0x8900D0 heading u16, 0x8900CE valid, 0x8900CD jump (car_rescue, jump_behind).
 *  - Physics info: [car+0x10] + 0x10 (mprace.c perf_info): +0x140 mass (t), +0x290 drag (speed^2 x it / mass = m/s^2),
 *    +0x2C0 the stock car's governor in mph (125-159; 0 with any ECU part), copied to the chassis every frame
 *    (0x5A49A0, 0x59C1E0). A stock car stops there however it is pushed ("a stock 240SX made stronger would still stop
 *    at 209 km/h"): that is what held the boost at the car's own top speed. Boost now zeroes it while on, as an ECU
 *    part does (mprace.c balance), and puts the car's value back after.
 *  - Nitrous: car+0x40 +0x414 a full shot, +0x41C left when it went on (left now while off), +0x420 on since
 *    (0 / 0x7FFFFFFF off), all in G_TICKS [0x86518C] at 4000 a second (roam_game.c nos_left, nos_pose).
 *  - Wheels: [car+0x34] +0x38..+0x44, each +0x188 a factor of its tyre's force, 1 from its constructor (drift.c WH_GRIP).
 *    The source shows it only at 1 and under (the drift assist's rear grip). The top level, 3.0, is the most grip the
 *    source records cars driving with: edited GlobalB cars at grip x2.5..x3 that ran live races (mprace.c "edited").
 *  - Car +0x468: the catch-up factor, max(M, 1), scaling the car's torque, governor and grip (catchup.c VEH_BOOST). The
 *    game writes it on player cars too (two-player Catch Up races, 0x5F6740); its retail range tops at 1.37 (skill 9,
 *    320 m behind). Nothing writes it in free roam. The source has no offsets for tyre curves, steering rate or
 *    downforce, so this is the only other road-holding value the script sets (grip's last level only).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- configuration
  const CFG = {
    keys: { // e.code with Alt held
      hover: 'Digit1', warp: 'Digit2', boost: 'Digit3', nos: 'Digit4', grip: 'Digit5', brake: 'Digit6', corner: 'Digit7', overlay: 'Digit0', race: 'Digit9', up: 'KeyX', down: 'KeyZ',
      toPlayer: 'KeyW', nextPlayer: 'KeyE', findPlayer: 'KeyQ',
    },
    // Lobby races: features locked while these are false. Source: results.rs JUMP_M 150 m seen by other racers'
    // games, RACE_MPS / QUICK_SHARE / THIRD_SHARE time rules -> operator [cheat] lines. Alt+9 sets all seven to the
    // same value (start: as written here, false; not saved across reloads). In a race while any is true, racePreset applies.
    allowInRace: { hover: false, warp: false, boost: false, nos: false, grip: false, brake: false, corner: false },
    racePreset: { // in a race with Alt+9 on, instead of boostCapMps / warpM; free roam keeps those
      boostCapMps: 120, // 432 km/h, under watch.rs DRIVE_MPS 125; hard-limited to RACE_BOOST_HARD_MPS
      warpM: 140, // under results.rs JUMP_M 150; clamped to 50..149
      toPlayerM: 149, // Alt+W refuses a longer jump; clamped to 50..149
      governorMph: 275, // car governor ceiling (122.9 m/s, under DRIVE_MPS 125) over a car's own nonzero one; clamped 100..279
    },
    warpM: 200, // clamped to 150..250
    warpCooldownS: 8,
    warpLiftM: 2.0, // the car is put this far above its current height at the target
    warpKeepSpeed: true,
    behindM: 8, // warp-to-player: this far behind the target, along its heading
    headingSign: 1, // warp-to-player: flip to -1 if you land facing away (heading u16 direction not confirmed)
    confirmMs: 3000, // a logged (> warpOverBudgetM) jump needs a second Alt+W within this
    warpOverBudgetM: 230, // local estimate of watch.rs teleport excess + warp must stay under this (server: 300)
    boostCapMps: 156, // 562 km/h (349 mph). Hard-limited to BOOST_HARD_MPS below the receivers' 200 (roam_core.c
    // (boostCapMps, cont.) rc_state check). Over watch.rs DRIVE_MPS 125 for 2 s the server writes a fast-run line.
    boostAccel: 9, // extra m/s^2 while throttle is held on the ground, on top of the car's own drag
    // Brake: the source documents no brake torque field (only "brakes" among the edited GlobalB values, CarTypeInfo
    // +0x1E0..+0x6C4, no offset), so the extra braking goes through velocity + momentum like boost: a level's factor x
    // the game's own deceleration while braking (measured as it brakes; brakeStockMps2 until then), minus the stock.
    // Free roam, and lobby races while Alt+9 is on (allowInRace.brake), like the other features.
    // Corner assist (Alt+7): the wheels' grip factor (+0x188, as Alt+5) ramped towards cornerMax while the wheel is
    // turned and the car slips sideways, back to 1 on a straight. Free roam, and lobby races while Alt+9 is on (allowInRace.corner).
    cornerMax: 2.4, // ceiling of the factor (clamped 1..3, the grip work's top)
    cornerSteerMin: 0.15, // |steer| from which a turn counts
    cornerSlipMps: 1.5, // side slip (m/s: velocity across the car, or a wheel's own slip across) from which it engages
    cornerRampS: 0.15, // time constant up
    cornerFadeS: 0.3, // time constant back to 1
    brakeLevels: [1.5, 2.0, 3.0], // Alt+6 cycles off -> these, Shift+Alt+6 off
    brakeStockMps2: 9, // assumed stock braking before one is measured (m/s^2)
    brakeMaxExtra: 20, // the most braking added (m/s^2)
    gripLevels: [1.6, 2.4, 3.0], // Alt+5 cycles off -> these (each wheel's tyre force factor, game: 1); clamped 1..3
    gripCatchup: 1.37, // the last level also sets the car's catch-up factor (torque, governor, grip); clamped 1..1.37
    hoverLiftM: 2.0,
    hoverMaxRiseM: 60, // target height never more than this above where hover started
    hoverClimbMps: 6,
    hoverAccel: 9, // throttle along heading while hovering (m/s^2)
    hoverLevelRate: 2, // rad/s per unit of tilt that turns a hovering car back level (pitch and roll)
    hoverCapMps: 100,
    hoverYawRate: 1.6, // rad/s at full steer
    steerSign: 1, // flip to -1 if hover turns the wrong way (sign of controls +0x1E0 not confirmed)
    airLimitS: 100, // game's fly_frame kicks at 120 s of world time with no wheel down
    airDescendS: 85, // auto descent starts here
    groundResetS: 3.5, // game needs FLY_GROUND_S = 3 s on the ground to reset its count
    dropFlyingReport: true // drop a {"t":"flying"} websocket message if the game ever raises one
  };

  // ---------------------------------------------------------------- guest addresses
  const A = {
    PLAYER_IDX: [0x00d00000, 0x008900ac],
    G_FLOW: 0x008654a4, G_TRACK: 0x0089e7a0, G_RACE: 0x00890118, G_CAREER_RACE: 0x00863470, G_GAMEMODE: 0x00850078,
    G_CARTYPES: 0x008a1ccc, G_WORLD: 0x00890080,
    HOTPOS: 0x00890140, HOTPOS_ANGLE: 0x008900d0, HOTPOS_VALID: 0x008900ce, HOTPOS_JUMP: 0x008900cd,
    GUEST_END: 0x28000000, IMAGE_LO: 0x00400000,
  };
  const C = { NEXT: 0x00, REC: 0x14, DRIVER: 0x24, REC_NAME: 0x90c, TYPE: 0x0c, PHYS: 0x28, CTL: 0x30, BODY: 0x3c, POS: 0x60, VEL: 0x70, FWD: 0x90, LEFT: 0xa0, UP: 0xb0,
    SPIN: 0x110, GROUND: 0x390, HEAD: 0x40c, SPEED: 0x42c, SIZE: 0x9e0 };
  // rows +0x30/+0x40/+0x50 (roam_game.c: "its rows +0x30"), from which each step makes the car's +0x90/+0xA0/+0xB0
  const R = { POS: 0x20, ROWS: 0x30, MOM: 0x70, ANGMOM: 0x80, VEL: 0xa0, SPIN: 0xc0, SIZE: 0x168 };
  const PI = { RIDE: 0x10, INFO: 0x10, MASS: 0x140, DRAG: 0x290, GOV_MPH: 0x2c0 };
  const N = { BASE: 0x40, FULL: 0x414, LEFT: 0x41c, SINCE: 0x420, G_TICKS: 0x0086518c, NONE: 0x7fffffff };
  const WHL = { PHYSOBJ: 0x34, FIRST: 0x38, GRIP: 0x188 };
  const BOOST_HARD_MPS = 190; // the receivers drop a state over 200 m/s
  const RACE_BOOST_HARD_MPS = 124; // Alt+9 on: under watch.rs DRIVE_MPS 125

  // ---------------------------------------------------------------- memory capture
  // Live build (nfsu2.xyz main.js, same as web/src/host/process.ts + memory.ts at f5f3bf68):
  //  - Chrome/Firefox: the page makes the Memory (allocMemory: new WebAssembly.Memory({shared:true}), >= 1 GB) and
  //    posts it to /host/io-worker.js and every /host/game-worker.js ({memory, ...}). The startup checklist also makes
  //    a 1-page shared probe Memory long before play.
  //  - WebKit (memoryOffPage): /host/io-worker.js makes the Memory; the page only gets {t:'memory', buf} and
  //    {t:'mem', buf} (grown) SharedArrayBuffers from it, and forwards the buffer to /net/worker.js ({t:'init', memory}).
  //  - The page never instantiates the wasm (it only compileStreaming's /game.wasm); game workers instantiate it with
  //    an imported env.memory. A userscript never runs inside those workers.
  // Every hook below is installed on the PAGE's realm (unsafeWindow when the manager gives one). A hook installed on
  // a content-script realm sees nothing: that is what "NO MEMORY" with a working overlay meant.
  const mems = []; // WebAssembly.Memory or {buffer: SharedArrayBuffer}
  const MIN_BYTES = 256 * 1024 * 1024; // a bare SharedArrayBuffer must be at least this to be the game's memory
  const MIN_MEM = 0x01000000; // a Memory smaller than this is not the game's (the 1-page startup probe)
  const seen = { ctor: 0, getter: 0, post: 0, recv: 0, inst: 0, sab: 0, small: 0 };
  const known = typeof WeakSet === 'function' ? new WeakSet() : null; // accepted Memories
  const small = typeof WeakSet === 'function' ? new WeakSet() : null; // too small (counted once)
  const tagOf = x => { try { return Object.prototype.toString.call(x); } catch (_) { return ''; } };
  // realm-independent checks (a page object is not instanceof a content-script realm's constructor)
  const isMemory = x => !!x && typeof x === 'object' && tagOf(x) === '[object WebAssembly.Memory]';
  const isSab = x => !!x && typeof x === 'object' && tagOf(x) === '[object SharedArrayBuffer]';
  // Set once a Memory (not a bare WebKit buffer) has given a sane player car: the discovery hooks then pass straight
  // through. A Memory's .buffer follows its growth, so nothing more is needed from them; the page reads .buffer and
  // posts / receives worker messages every frame. Cleared again by tick's error path.
  let locked = false;
  let considering = false; // its own .buffer read goes through the hooked getter
  function considerMemory(m, via) {
    if (considering) return;
    considering = true;
    try {
      if (!m || mems.includes(m)) return;
      if (known && known.has(m)) return;
      const n = m.buffer.byteLength;
      if (n < MIN_MEM) { if (!small || !small.has(m)) { seen.small++; if (small) small.add(m); } return; }
      if (known) known.add(m);
      if (via) seen[via] = (seen[via] || 0) + 1;
      mems.push(m);
      log('game memory via ' + (via || 'direct') + ': ' + Math.round(n / 1048576) + ' MB');
    } catch (_) { /* ignore */ } finally { considering = false; }
  }
  function considerSab(b) {
    if (!isSab(b) || b.byteLength < MIN_BYTES) return;
    // the same bytes already held as a Memory: nothing new
    for (const m of mems) { try { if (!m.__sab && m.buffer === b) return; } catch (_) { /* ignore */ } }
    // a grown buffer replaces a shorter one (WebKit path: the newest buffer as memory grows)
    for (const m of mems) if (m.__sab && m.buffer.byteLength <= b.byteLength) { m.buffer = b; return; }
    for (const m of mems) if (m.__sab && m.buffer.byteLength > b.byteLength) return; // an older, shorter one
    seen.sab++;
    mems.push({ __sab: true, buffer: b });
    log('game memory buffer from a worker message: ' + Math.round(b.byteLength / 1048576) + ' MB');
  }
  function scan(d, depth, via) {
    if (!d || typeof d !== 'object' || depth > 2) return;
    try {
      if (isMemory(d)) return considerMemory(d, via);
      if (isSab(d)) return considerSab(d);
      if (ArrayBuffer.isView(d) || tagOf(d) === '[object ArrayBuffer]') return;
      if (Array.isArray(d)) { for (let i = 0; i < Math.min(d.length, 16); i++) scan(d[i], depth + 1, via); return; }
      const ks = Object.keys(d);
      for (let i = 0; i < Math.min(ks.length, 16); i++) scan(d[ks[i]], depth + 1, via);
    } catch (_) { /* ignore */ }
  }
  const W = typeof window !== 'undefined' ? window : globalThis;
  // Which world this script runs in, by realm identity: the page's Object constructor (unsafeWindow.Object) against
  // this script's own Object.
  //  - page world: the same constructor (Tampermonkey raw on Chrome, Violentmonkey @inject-into page). The window
  //    objects may still differ: Tampermonkey hands a granted script a proxy window in the page realm.
  //  - isolated world: a different one (Firefox content script, or Tampermonkey's Firefox USERSCRIPT_WORLD, which is
  //    what nfsu2.xyz gets: its CSP script-src 'self' 'wasm-unsafe-eval' has no 'unsafe-inline', so raw injection
  //    into the page fails there). Hooks then go on unsafeWindow, through exportFunction / cloneInto.
  //  - unknown: no unsafeWindow (and no window.wrappedJSObject), or the test threw.
  const WORLD = (() => {
    const r = { id: 'unknown', how: '', ff: typeof exportFunction === 'function' && typeof cloneInto === 'function', win: null };
    let uw = null;
    try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) { uw = unsafeWindow; r.how = 'unsafeWindow'; } } catch (_) { /* ignore */ }
    if (!uw) { try { const w = W.wrappedJSObject; if (w && w !== W) { uw = w; r.how = 'window.wrappedJSObject'; } } catch (_) { /* ignore */ } }
    if (!uw) { r.how = 'no unsafeWindow'; return r; }
    try {
      const sameObj = uw.Object === Object, sameWin = uw === W;
      r.how += (sameObj ? ': Object ===' : ': Object !==') + (sameWin ? ', window ===' : ', window !==');
      r.id = sameObj ? 'page' : 'isolated';
      if (uw.WebAssembly) r.win = uw;
    } catch (e) { r.how += ': identity test threw ' + (e && e.message); }
    return r;
  })();
  const crossRealm = WORLD.id === 'isolated';
  const FF = crossRealm && WORLD.ff; // Firefox: functions the page calls must be exported, page objects unwrapped
  // page objects reach an exported function as Xrays, which hide a WebAssembly.Memory's .buffer: waive them
  const unX = !FF ? x => x : x => {
    if (!x || (typeof x !== 'object' && typeof x !== 'function')) return x;
    try { if (typeof XPCNativeWrapper !== 'undefined') return XPCNativeWrapper.unwrap(x); } catch (_) { /* ignore */ }
    try { const w = x.wrappedJSObject; if (w) return w; } catch (_) { /* ignore */ }
    return x;
  };
  const PW = WORLD.win ? unX(WORLD.win) : W;
  const XF = !FF ? f => f : f => exportFunction(function (...a) { return f.apply(unX(this), a.map(unX)); }, PW);
  // a constructor wrapper made in the page realm (a Proxy from this realm cannot be handed to the page in Firefox)
  function pageProxy(target, construct) {
    const P = (crossRealm && PW.Proxy) || Proxy;
    if (!FF) return new P(target, { construct });
    let h = null;
    try { h = cloneInto({ construct: function (t, a, nt) { return construct(unX(t), unX(a), unX(nt)); } }, PW, { cloneFunctions: true }); } catch (_) { h = null; }
    if (!h) { h = new PW.Object(); h.construct = XF(construct); }
    return new P(target, h);
  }
  const construct = (t, a, nt) => ((crossRealm && PW.Reflect) || Reflect).construct(t, a, nt);
  const hooked = [];
  function wrapGetter(proto, prop, after, name) {
    try {
      const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || typeof d.get !== 'function') return;
      const g = d.get;
      let busy = false; // considerMemory reads .buffer itself
      Object.defineProperty(proto, prop, { configurable: true, enumerable: d.enumerable, set: d.set,
        get: XF(function () {
          const v = g.call(this);
          if (!busy && !locked) { busy = true; try { after(this, unX(v)); } catch (_) { /* ignore */ } finally { busy = false; } }
          return v;
        }) });
      hooked.push(name);
    } catch (_) { /* ignore */ }
  }
  function wrapMethod(obj, prop, before, name) {
    try {
      const f = obj && obj[prop];
      if (typeof f !== 'function') return;
      // f is the page's native: its arguments go across one by one (f.call(this, ...a)), never as this realm's array.
      // f.apply(this, a) handed the page's apply a script-realm array, an opaque wrapper in Firefox: its own
      // io.postMessage({memory}) then threw 'Permission denied to access property "length"' and the game did not start
      obj[prop] = XF(function (...a) { if (!locked) { try { before(this, a); } catch (_) { /* ignore */ } } return f.call(this, ...a); });
      hooked.push(name);
    } catch (_) { /* ignore */ }
  }
  function fromImports(imports) {
    if (!imports || typeof imports !== 'object') return;
    for (const mod of Object.keys(imports).slice(0, 16)) {
      const o = imports[mod];
      if (!o || typeof o !== 'object') continue;
      for (const k of Object.keys(o)) if (isMemory(o[k])) considerMemory(o[k], 'inst');
    }
  }
  function fromInstance(inst) {
    try { const ex = inst && inst.exports; if (ex) for (const k of Object.keys(ex)) if (isMemory(ex[k])) considerMemory(ex[k], 'inst'); } catch (_) { /* ignore */ }
  }
  function installHooks() {
    const WA = PW.WebAssembly;
    const NativeMemory = WA && WA.Memory;
    // 1. constructor: a Proxy in the page realm (Firefox: its handler cloned into the page with an exported construct)
    if (NativeMemory) {
      try {
        WA.Memory = pageProxy(NativeMemory, (t, args, nt) => {
          const m = construct(t, args, nt);
          considerMemory(m, 'ctor');
          return m;
        });
        hooked.push('Memory()');
      } catch (_) { /* ignore */ }
    }
    // 2. Memory.prototype.buffer / grow: catches a Memory made before the hooks or through a saved constructor; the
    //    page reads .memory.buffer every frame (gpu views(), radio, net)
    if (NativeMemory) {
      wrapGetter(NativeMemory.prototype, 'buffer', m => { if (!known || !known.has(m)) considerMemory(m, 'getter'); }, 'Memory.buffer');
      wrapMethod(NativeMemory.prototype, 'grow', m => considerMemory(m, 'getter'), 'Memory.grow');
    }
    // 3. instantiate paths (not used on the live page, which only compiles; kept for test pages and other builds)
    if (WA) {
      for (const name of ['instantiate', 'instantiateStreaming']) {
        const f = WA[name];
        if (typeof f !== 'function') continue;
        try {
          WA[name] = XF(function (src, imports, ...rest) {
            try { fromImports(imports); } catch (_) { /* ignore */ }
            const p = f.call(this, src, imports, ...rest);
            try { p.then(XF(r => { fromInstance(r && r.instance ? r.instance : r); })); } catch (_) { /* ignore */ }
            return p;
          });
          hooked.push(name);
        } catch (_) { /* ignore */ }
      }
      if (typeof WA.Instance === 'function') {
        try {
          WA.Instance = pageProxy(WA.Instance, (t, args, nt) => {
            try { fromImports(unX(args[1])); } catch (_) { /* ignore */ }
            const i = construct(t, args, nt); fromInstance(i); return i;
          });
          hooked.push('Instance()');
        } catch (_) { /* ignore */ }
      }
    }
    // 4. messages out: the page posts the Memory to the io and game workers, and the WebKit buffer to the net worker
    if (PW.Worker) wrapMethod(PW.Worker.prototype, 'postMessage', (_w, a) => scan(a[0], 0, 'post'), 'Worker.postMessage');
    if (PW.MessagePort) wrapMethod(PW.MessagePort.prototype, 'postMessage', (_p, a) => scan(a[0], 0, 'post'), 'MessagePort.postMessage');
    // 5. messages in: MessageEvent.data is read by the page's own onmessage for every worker message, so this sees the
    //    WebKit io worker's {t:'memory'|'mem', buf} even when that Worker was made before this script ran
    if (PW.MessageEvent) wrapGetter(PW.MessageEvent.prototype, 'data', (_e, d) => { if (d && typeof d === 'object') scan(d, 0, 'recv'); }, 'MessageEvent.data');
    // reading e.data through the hooked MessageEvent.data getter already scans it: scan here only without that hook
    const dataHooked = hooked.includes('MessageEvent.data');
    if (PW.Worker) {
      try {
        PW.Worker = pageProxy(PW.Worker, (t, args, nt) => {
          const w = construct(t, args, nt);
          try { w.addEventListener('message', XF(e => { const d = e.data; if (!dataHooked && !locked) scan(d, 0, 'recv'); })); } catch (_) { /* ignore */ }
          return w;
        });
        hooked.push('Worker()');
      } catch (_) { /* ignore */ }
    }
    log('world: ' + worldText() + ' [' + WORLD.how + ']; hooks on the ' + (crossRealm ? 'page via unsafeWindow' : 'script realm') + ': ' + hooked.join(', '));
    const WSk = PW.WebSocket;
    if (CFG.dropFlyingReport && WSk) {
      const send = WSk.prototype.send;
      WSk.prototype.send = XF(function (data) {
        if (typeof data === 'string' && data.length < 200 && /"t"\s*:\s*"flying"/.test(data)) { log('dropped a flying report'); return; }
        return send.call(this, data);
      });
    }
  }
  // what the overlay says while there is no memory: the world, which hooks are in, and what they saw
  const bootAt = typeof performance !== 'undefined' ? performance.now() : 0;
  function worldText() {
    if (WORLD.id === 'page') return 'page world';
    if (WORLD.id === 'isolated') return 'isolated world' + (FF ? ', hooks on the page via unsafeWindow + exportFunction' : ', no exportFunction');
    return 'unknown world';
  }
  function memDiag() {
    const s = 'world: ' + worldText() + ' [' + WORLD.how + ']\nhooks ' + hooked.length + ', seen ctor ' + seen.ctor + ' get ' + seen.getter +
      ' post ' + seen.post + ' recv ' + seen.recv + ' sab ' + seen.sab + ' small ' + seen.small;
    // the startup checklist makes a 1-page shared Memory as soon as main.js runs: none seen by now = hooks not on the page
    const late = typeof document !== 'undefined' && document.readyState === 'complete' && now() - bootAt > 5000;
    if (!late || seen.small || mems.length) return s;
    if (WORLD.id === 'page') return s + '\n! page world but no page Memory seen: the hooks came after main.js (needs @run-at document-start)';
    if (FF) return s + '\n! isolated world, hooks on unsafeWindow, still no page Memory seen: report this overlay text';
    if (crossRealm) return s + '\n! isolated world without exportFunction: hooks cannot reach the page (Tampermonkey: @sandbox JavaScript + @grant unsafeWindow)';
    return s + '\n! no page Memory seen and no unsafeWindow: the manager ignored @grant unsafeWindow (Violentmonkey: @inject-into page)';
  }

  // ---------------------------------------------------------------- guest memory access
  let dv = null, curBuf = null, memIdx = -1, playerIdx = -1, lastCar = 0;
  // the player car in memory i (0 if none), its view made current
  function carIn(i) {
    let b; try { b = mems[i].buffer; } catch (_) { return 0; }
    if (!b || b.byteLength < MIN_MEM) return 0;
    if (b !== curBuf) { curBuf = b; try { dv = new DataView(b); } catch (_) { dv = new PW.DataView(b); } }
    memIdx = i;
    const car = findCar();
    if (car && !mems[i].__sab) locked = true;
    return car;
  }
  // choose the memory that holds a valid player car, the last one first; returns that car (0: none)
  function refreshView() {
    const first = memIdx;
    if (first >= 0 && first < mems.length) { const car = carIn(first); if (car) return car; }
    for (let i = 0; i < mems.length; i++) { if (i === first) continue; const car = carIn(i); if (car) return car; }
    return 0;
  }
  const inGuest = (a, n) => a >= A.IMAGE_LO && a + n <= A.GUEST_END && dv && a + n <= dv.byteLength;
  const u8 = a => dv.getUint8(a), u16 = a => dv.getUint16(a, true), u32 = a => dv.getUint32(a, true);
  const f32 = a => dv.getFloat32(a, true);
  const wu32 = (a, v) => dv.setUint32(a, v >>> 0, true);
  const wf32 = (a, v) => dv.setFloat32(a, v, true), wu8 = (a, v) => dv.setUint8(a, v), wu16 = (a, v) => dv.setUint16(a, v, true);
  const rd32 = a => (inGuest(a, 4) ? u32(a) : 0);
  const v3 = a => [f32(a), f32(a + 4), f32(a + 8)];
  const w3 = (a, v) => { wf32(a, v[0]); wf32(a + 4, v[1]); wf32(a + 8, v[2]); };
  const len = v => Math.hypot(v[0], v[1], v[2]);
  const fin = v => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
  const anyGround = car => u8(car + C.GROUND) !== 0 || u8(car + C.GROUND + 1) !== 0 || u8(car + C.GROUND + 2) !== 0 || u8(car + C.GROUND + 3) !== 0;

  function carSane(car) {
    if (!inGuest(car, C.SIZE) || car & 3) return false;
    const p = v3(car + C.POS), f = v3(car + C.FWD), u = v3(car + C.UP), v = v3(car + C.VEL);
    if (!fin(p) || !fin(f) || !fin(u) || !fin(v)) return false;
    if (Math.abs(p[0]) >= 20000 || Math.abs(p[1]) >= 20000 || Math.abs(p[2]) >= 2000) return false;
    if (Math.abs(len(f) - 1) > 0.1 || Math.abs(len(u) - 1) > 0.1 || len(v) > 200) return false;
    return u32(car + C.PHYS) < 16;
  }
  function playerCar(i) {
    const pl = rd32(A.PLAYER_IDX[i]);
    const car = pl && inGuest(pl, 8) ? rd32(pl + 4) : 0;
    return car && carSane(car) ? car : 0;
  }
  function findCar() { // the last index that held the car first
    if (playerIdx >= 0) { const car = playerCar(playerIdx); if (car) return car; }
    for (let i = 0; i < A.PLAYER_IDX.length; i++) {
      if (i === playerIdx) continue;
      const car = playerCar(i);
      if (car) { playerIdx = i; return car; }
    }
    return 0;
  }
  function rigidBody(car) {
    const body = rd32(car + C.BODY);
    if (!inGuest(body, 0x6c) || !u32(body + 0x5c)) return 0;
    const rb = rd32(body + 0x68);
    if (!inGuest(rb, R.SIZE)) return 0;
    const p = v3(rb + R.POS), cp = v3(car + C.POS);
    // the body's place must be the car's (within a few metres: the centre of mass offset)
    return fin(p) && Math.hypot(p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]) < 10 ? rb : 0;
  }
  function typeMass(car) {
    const types = rd32(A.G_CARTYPES), ti = rd32(car + C.TYPE);
    if (types && ti >= types && (ti - types) % 0x890 === 0 && (ti - types) / 0x890 < 64 && inGuest(ti, 0x224)) {
      const m = f32(ti + 0x220);
      if (m > 0.3 && m < 20) return m;
    }
    return 1.4;
  }
  function massOf(car, rb) {
    const v = v3(rb + R.VEL), p = v3(rb + R.MOM), vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (vv > 1) {
      const m = (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / vv;
      if (m > 0.3 && m < 20) return m;
    }
    return typeMass(car);
  }
  function setVel(car, rb, v, m) {
    w3(car + C.VEL, v); w3(rb + R.VEL, v); w3(rb + R.MOM, [v[0] * m, v[1] * m, v[2] * m]);
  }
  function worldMode(car) {
    if (u32(A.G_FLOW) !== 6) return 'MENU';
    const race = rd32(A.G_RACE);
    const roam = car && u32(A.G_TRACK) % 1000 === 0 && inGuest(race, 0xc44) && u32(race) === 4 && u32(race + 0x24) === 1 &&
      u32(A.G_CAREER_RACE) === 0 && (u32(A.G_GAMEMODE) & 0x200) === 0;
    return roam ? 'ROAM' : 'RACE';
  }

  // ---------------------------------------------------------------- state
  const S = {
    hover: false, boost: false, nos: false, grip: 0, brake: 0, corner: false, overlay: true, // grip: level, 0 off
    mode: 'NO MEMORY', note: '',
    hoverZ: 0, hoverBaseZ: 0, descending: false, climb: 0,
    air: 0, ground: 0, // local mirror of fly_frame's count (conservative: wall time, hover counts as air)
    over: 0, lastPos: null, // local mirror of watch.rs teleport excess
    warpReadyAt: 0, warp: null, // pending hot-position jump
    noteUntil: 0,
    players: [], playersAt: 0, target: '', confirm: null, // warp-to-player
  };
  function log(s) { try { console.info('[nfsu2-owncar] ' + s); } catch (_) { /* ignore */ } }
  function note(s, ms = 2500) { S.note = s; S.noteUntil = now() + ms; log(s); }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const allowed = f => S.mode === 'ROAM' || (S.mode === 'RACE' && CFG.allowInRace[f]);
  const raceOn = () => Object.keys(CFG.allowInRace).some(f => CFG.allowInRace[f]); // the Alt+9 switch
  const presetOn = () => S.mode === 'RACE' && raceOn(); // racePreset in effect

  // ---------------------------------------------------------------- features
  function hoverStep(car, rb, dt, ctl) {
    const p = v3(car + C.POS), v = v3(rb + R.VEL), m = massOf(car, rb);
    if (S.air >= CFG.airDescendS && !S.descending) { S.descending = true; note('hover: air time budget, descending'); }
    if (S.descending) {
      S.hoverZ = p[2] - 50;
    } else {
      S.hoverZ = Math.min(S.hoverZ + S.climb * CFG.hoverClimbMps * dt, S.hoverBaseZ + CFG.hoverMaxRiseM);
    }
    const vz = Math.max(-8, Math.min(8, 2.5 * (S.hoverZ - p[2])));
    const f = v3(car + C.FWD), fl = Math.hypot(f[0], f[1]) || 1;
    let vx = v[0], vy = v[1];
    vx += (f[0] / fl) * ctl.throttle * CFG.hoverAccel * dt; vy += (f[1] / fl) * ctl.throttle * CFG.hoverAccel * dt;
    const drag = 1 - Math.min(0.9, (0.05 + 1.5 * (ctl.brake > 0.1 ? ctl.brake : 0)) * dt);
    vx *= drag; vy *= drag;
    const hs = Math.hypot(vx, vy);
    if (hs > CFG.hoverCapMps) { vx *= CFG.hoverCapMps / hs; vy *= CFG.hoverCapMps / hs; }
    setVel(car, rb, [vx, vy, vz], m);
    // keep the body level-ish and turn it with the steering
    const L = v3(rb + R.ANGMOM), w = v3(rb + R.SPIN);
    const ratio = Math.abs(w[2]) > 0.05 && L[2] / w[2] > 0.5 * m && L[2] / w[2] < 5 * m ? L[2] / w[2] : 2 * m;
    const wz = ctl.steer * CFG.hoverYawRate * CFG.steerSign;
    // pitch and roll turned back towards level (up x z), not only damped: no wheel on the road holds it level
    const up = v3(car + C.UP), cl = x => Math.max(-1.5, Math.min(1.5, x));
    const rx = cl(CFG.hoverLevelRate * up[1]), ry = cl(-CFG.hoverLevelRate * up[0]);
    const nw = [rx, ry, wz], nL = [rx * ratio, ry * ratio, wz * ratio];
    w3(rb + R.SPIN, nw); w3(car + C.SPIN, nw); w3(rb + R.ANGMOM, nL);
    if (!S.descending) for (let i = 0; i < 4; i++) wu8(car + C.GROUND + i, 1);
  }
  const boostCap = () => (presetOn() ? Math.max(10, Math.min(RACE_BOOST_HARD_MPS, CFG.racePreset.boostCapMps))
    : Math.max(10, Math.min(BOOST_HARD_MPS, CFG.boostCapMps)));
  const raceWarpM = () => Math.max(50, Math.min(149, CFG.racePreset.warpM));
  const raceToPlayerM = () => Math.max(50, Math.min(149, CFG.racePreset.toPlayerM));
  const raceGovMph = () => Math.max(100, Math.min(279, CFG.racePreset.governorMph)); // 279 mph = 124.7 m/s
  const warpDist = () => (presetOn() ? raceWarpM() : Math.max(150, Math.min(250, CFG.warpM)));
  // the ride's physics info, when it looks like one (governor a plausible mph, mass in tonnes)
  function perfInfo(car) {
    const ride = rd32(car + PI.RIDE), pi = ride ? ride + PI.INFO : 0;
    if (!pi || !inGuest(pi, PI.GOV_MPH + 4)) return 0;
    const g = f32(pi + PI.GOV_MPH), m = f32(pi + PI.MASS);
    return Number.isFinite(g) && g >= 0 && g < 1000 && m > 0.3 && m < 20 ? pi : 0;
  }
  // the car's own drag at speed s (m/s^2): the boost adds its extra on top, or it stalls at the car's top speed
  function dragDecel(car, s) {
    const pi = perfInfo(car); if (!pi) return 0;
    const k = f32(pi + PI.DRAG), m = f32(pi + PI.MASS);
    return k > 0 && k < 0.05 ? Math.min(40, k * s * s / m) : 0;
  }
  // the governor: zero while boost is on (the race preset ceiling in a race with Alt+9), the race preset ceiling over
  // a higher own value otherwise in that state, the car's own value back after (only the same live car). In a race an
  // absent (0) governor is never raised: the port's lobby-race balance (mprace.c balance_apply) zeroes every racer's
  // +0x2C0, and its balance_hold treats a nonzero one as an info built again and scales the torque curve by the
  // balance factor once more each second (x0.75 compounding to 0: the car could not accelerate, log 2026-11-08)
  const gov = { car: 0, pi: 0, mph: 0, set: 0 };
  function governorSet(car, want) { // want(own mph) -> mph to write
    const pi = perfInfo(car); if (!pi) return;
    if (gov.car && gov.car !== car) gov.car = 0; // another car: the old one may be gone, leave it
    const g = f32(pi + PI.GOV_MPH);
    if (!gov.car) { gov.car = car; gov.pi = pi; gov.mph = g; }
    else if (g !== gov.set) { gov.pi = pi; gov.mph = g; } // the info was built again (parts, race messages)
    const mph = Math.fround(want(gov.mph)); gov.set = mph;
    if (g !== mph) wf32(pi + PI.GOV_MPH, mph);
  }
  const raceCeiling = own => (own > 0 ? Math.min(own, raceGovMph()) : 0);
  function governorBack(car) {
    if (!gov.car) return;
    if (car === gov.car && perfInfo(car) === gov.pi && f32(gov.pi + PI.GOV_MPH) === gov.set && gov.mph !== gov.set) wf32(gov.pi + PI.GOV_MPH, gov.mph);
    gov.car = 0;
  }
  // The pose level with its heading kept and no turning: the rigid body's rows and the car's, when the two agree (the
  // layout checked: same rows, right-handed), else only the turning stopped. Hover start and a warp's landing.
  function levelPose(car, rb) {
    const zero = [0, 0, 0];
    w3(rb + R.SPIN, zero); w3(rb + R.ANGMOM, zero); w3(car + C.SPIN, zero);
    const f = v3(car + C.FWD), l = v3(car + C.LEFT), u = v3(car + C.UP);
    const same = [[C.FWD, 0], [C.LEFT, 0x10], [C.UP, 0x20]].every(([co, ro]) => {
      const a = v3(car + co), b = v3(rb + R.ROWS + ro);
      return fin(b) && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.05;
    });
    const hand = (u[1] * f[2] - u[2] * f[1]) * l[0] + (u[2] * f[0] - u[0] * f[2]) * l[1] + (u[0] * f[1] - u[1] * f[0]) * l[2];
    const fl = Math.hypot(f[0], f[1]);
    if (!same || hand < 0.9 || fl < 0.3) return false;
    const F = [f[0] / fl, f[1] / fl, 0], Lf = [-F[1], F[0], 0], U = [0, 0, 1];
    w3(rb + R.ROWS, F); w3(rb + R.ROWS + 0x10, Lf); w3(rb + R.ROWS + 0x20, U);
    w3(car + C.FWD, F); w3(car + C.LEFT, Lf); w3(car + C.UP, U);
    return true;
  }
  const brakeOk = () => allowed('brake');
  const cornerOk = () => allowed('corner');
  const CORNER = { car: 0, f: 1, last: 0 }; // the factor now; the last one written (for the restore)
  // side slip: the velocity across the car (its left row), or the largest slip across a grounded wheel (car +0x3B4,
  // float[4][2] along / across, roam_game.c CAR_SLIP)
  function cornerSlip(car, rb) {
    const v = rb ? v3(rb + R.VEL) : v3(car + C.VEL), l = v3(car + C.LEFT);
    let s = Math.abs(v[0] * l[0] + v[1] * l[1] + v[2] * l[2]);
    for (let i = 0; i < 4; i++) if (u8(car + C.GROUND + i)) { const a = Math.abs(f32(car + 0x3b4 + 8 * i + 4)); if (a < 100 && a > s) s = a; }
    return s;
  }
  function cornerStep(car, rb, dt, ctl, g) {
    const ws = wheels(car); if (ws.length !== 4) return false;
    const top = Math.max(1, Math.min(3, CFG.cornerMax));
    const on = g && Math.abs(ctl.steer) >= CFG.cornerSteerMin && f32(car + C.SPEED) > 5 && cornerSlip(car, rb) >= CFG.cornerSlipMps;
    CORNER.f += ((on ? top : 1) - CORNER.f) * Math.min(1, dt / (on ? CFG.cornerRampS : CFG.cornerFadeS));
    if (!on && CORNER.f < 1.02) CORNER.f = 1;
    CORNER.car = car;
    if (S.grip) return true; // Alt+5's level owns the wheels while it is on
    const f = Math.fround(CORNER.f);
    for (const w of ws) if (f32(w + WHL.GRIP) !== f) wf32(w + WHL.GRIP, f);
    CORNER.last = f;
    return true;
  }
  function cornerBack(car) {
    if (CORNER.car && car === CORNER.car && !S.grip) for (const w of wheels(car)) if (f32(w + WHL.GRIP) === CORNER.last) wf32(w + WHL.GRIP, 1);
    CORNER.car = 0; CORNER.f = 1; CORNER.last = 0;
  }
  const BR = { last: 0, decel: 0 }; // speed after our last write while braking; the game's own braking (EMA, m/s^2)
  const brakeLabel = () => !S.brake ? 'off' : 'L' + S.brake + ' x' + CFG.brakeLevels[S.brake - 1].toFixed(1) +
    (BR.decel ? '  stock ' + BR.decel.toFixed(1) + ' m/s2' : '');
  function brakeStep(car, rb, dt, ctl, grounded) {
    const v = v3(rb + R.VEL), h = Math.hypot(v[0], v[1]);
    if (!grounded || ctl.brake < 0.1 || !(f32(car + C.SPEED) > 2) || !(h > 2) || !(dt > 0)) { BR.last = 0; return false; }
    if (BR.last > 0) { const d = (BR.last - h) / dt; if (d > 0.5 && d < 60) BR.decel = BR.decel ? BR.decel + 0.2 * (d - BR.decel) : d; }
    const mult = CFG.brakeLevels[S.brake - 1] || 1, stock = BR.decel || CFG.brakeStockMps2;
    const extra = Math.min(CFG.brakeMaxExtra, Math.max(0, (mult - 1) * stock)) * ctl.brake;
    const nh = Math.max(2, h - extra * dt);
    if (nh < h) setVel(car, rb, [v[0] * nh / h, v[1] * nh / h, v[2]], massOf(car, rb));
    BR.last = nh;
    return true;
  }
  function boostStep(car, rb, dt, ctl, grounded) {
    governorSet(car, own => (presetOn() && own > 0 ? raceGovMph() : 0));
    if (!grounded || ctl.throttle < 0.3 || !(f32(car + C.SPEED) > 3)) return;
    // along the ground only: scaling the vertical speed too launched the car off every crest, nose up
    if (!(f32(car + C.UP + 8) > 0.85)) return;
    const v = v3(rb + R.VEL), s = len(v), h = Math.hypot(v[0], v[1]), cap = boostCap();
    if (!(h > 3) || s >= cap) return;
    const a = CFG.boostAccel + dragDecel(car, s), hMax = Math.sqrt(Math.max(0, cap * cap - v[2] * v[2]));
    const k = Math.min(hMax, h + a * ctl.throttle * dt) / h;
    if (k > 1) setVel(car, rb, [v[0] * k, v[1] * k, v[2]], massOf(car, rb));
  }
  // nitrous: what is left kept at a full shot, off or burning ('none' for a car without nitrous)
  function nosStep(car) {
    const n = car + N.BASE;
    if (!inGuest(n + N.FULL, 0x10)) return 'none';
    const full = u32(n + N.FULL), left = u32(n + N.LEFT), since = u32(n + N.SINCE);
    if (!full || full >= N.NONE || full > 4000 * 120 || left === N.NONE) return 'none';
    const on = since !== 0 && since !== N.NONE;
    const burnt = on ? (u32(N.G_TICKS) - since) >>> 0 : 0;
    if (burnt > 4000 * 600) return 'clock';
    const want = full + burnt;
    if ((left | 0) - burnt < full) wu32(n + N.LEFT, want);
    return 'ok';
  }
  function wheels(car) {
    const po = rd32(car + WHL.PHYSOBJ), out = [];
    if (!inGuest(po, WHL.FIRST + 16)) return out;
    for (let i = 0; i < 4; i++) {
      const w = rd32(po + WHL.FIRST + 4 * i);
      if (!inGuest(w, WHL.GRIP + 4) || out.includes(w)) return [];
      const g = f32(w + WHL.GRIP);
      if (!(g > 0.05 && g < 5)) return [];
      out.push(w);
    }
    return out;
  }
  const grip = { car: 0 };
  const CU = 0x468; // car: the catch-up factor
  const gripLevels = () => CFG.gripLevels.map(f => Math.fround(Math.max(1, Math.min(3, f))));
  const gripFactor = lvl => gripLevels()[lvl - 1] || 1;
  const cuFactor = () => Math.fround(Math.max(1, Math.min(1.37, CFG.gripCatchup)));
  const cuSane = car => { const v = f32(car + CU); return v >= 0.5 && v <= 2; };
  function gripStep(car, lvl) {
    const ws = wheels(car); if (ws.length !== 4) return false;
    const levels = gripLevels(), f = levels[lvl - 1] || 1, top = lvl === levels.length, cu = cuFactor();
    grip.car = car;
    for (const w of ws) if (f32(w + WHL.GRIP) !== f) wf32(w + WHL.GRIP, f);
    if (top) { if (cuSane(car) && f32(car + CU) !== cu) wf32(car + CU, cu); }
    else if (f32(car + CU) === cu) wf32(car + CU, 1);
    return true;
  }
  function gripBack(car) {
    if (!grip.car) return;
    if (car === grip.car) {
      const ours = gripLevels();
      for (const w of wheels(car)) if (ours.includes(f32(w + WHL.GRIP))) wf32(w + WHL.GRIP, 1);
      if (f32(car + CU) === cuFactor()) wf32(car + CU, 1);
    }
    grip.car = 0;
  }
  function warpStart(car, rb) {
    const t = now();
    if (!allowed('warp')) return note(S.mode === 'RACE' ? 'warp: locked in races' : 'warp: not in free roam');
    if (S.warp) return note('warp: one already pending');
    if (t < S.warpReadyAt) return note('warp: cooldown ' + Math.ceil((S.warpReadyAt - t) / 1000) + ' s');
    if (u32(car + C.PHYS) !== 1) return note('warp: car not under physics');
    const d = warpDist();
    if (S.over + d > CFG.warpOverBudgetM) return note('warp: wait, server excess estimate ' + Math.round(S.over) + ' m');
    const p = v3(car + C.POS), f = v3(car + C.FWD), fl = Math.hypot(f[0], f[1]);
    if (fl < 0.3) return note('warp: car not level');
    const to = [p[0] + (f[0] / fl) * d, p[1] + (f[1] / fl) * d, p[2] + CFG.warpLiftM];
    if (Math.abs(to[0]) > 19000 || Math.abs(to[1]) > 19000 || Math.abs(to[2]) > 1900) return note('warp: target out of bounds');
    const v = rb ? v3(rb + R.VEL) : v3(car + C.VEL), m = rb ? massOf(car, rb) : typeMass(car);
    w3(A.HOTPOS, to); wu16(A.HOTPOS_ANGLE, u16(car + C.HEAD)); wu8(A.HOTPOS_VALID, 1); wu8(A.HOTPOS_JUMP, 1);
    S.warp = { from: p, d, v, m, t, car, moved: false };
    S.warpReadyAt = t + CFG.warpCooldownS * 1000;
  }
  function warpStep(car, rb) {
    const w = S.warp; if (!w) return;
    const p = v3(car + C.POS), moved = Math.hypot(p[0] - w.from[0], p[1] - w.from[1]);
    if (car !== w.car) { S.warp = null; return; }
    if (w.to ? Math.hypot(p[0] - w.to[0], p[1] - w.to[1]) < 20 : moved > w.d * 0.6) {
      if (CFG.warpKeepSpeed && rb && !w.moved) { w.moved = true; return; } // restore one frame after the jump took
      if (CFG.warpKeepSpeed && rb) setVel(car, rb, w.v, w.m);
      if (rb) levelPose(car, rb);
      S.warp = null; note((w.name ? 'warp to ' + w.name + ': ' : 'warp: ') + Math.round(moved) + ' m');
      return;
    }
    if (now() - w.t > 1000) { wu8(A.HOTPOS_JUMP, 0); S.warp = null; S.warpReadyAt = 0; note('warp: the game did not take the jump'); }
  }

  // ---------------------------------------------------------------- warp to player
  // Friends' cars are game Cars on the World's list ([G_WORLD], car +0 next, ends at the World: roam_game.c create
  // ~1753), driver 0 (car +0x24), each with its slot's racer record (car +0x14) whose +0x90C holds the player's name,
  // 15 bytes + NUL (set_name ~1001). Only players the game has given a car (the nearest, up to the Players' cars
  // setting, 32 by default) are there; a parked car sits at z = -123456 (Car::Deactivate).
  const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function readName(rec) {
    const b = [];
    for (let i = 0; i < 16; i++) { const c = u8(rec + C.REC_NAME + i); if (!c) break; b.push(c); }
    if (!b.length || b.some(c => c < 0x20 || c === 0x7f)) return '';
    return dec ? dec.decode(new Uint8Array(b)) : String.fromCharCode(...b);
  }
  function listPlayers(me) {
    const w = rd32(A.G_WORLD), out = [];
    if (!inGuest(w, 0x80)) return out;
    const mp = v3(me + C.POS);
    for (let it = rd32(w), n = 0; it && it !== w && n < 128; it = rd32(it + C.NEXT), n++) {
      if (!inGuest(it, C.SIZE)) break;
      if (it === me) continue;
      if (u32(it + C.DRIVER) !== 0) continue;
      const rec = rd32(it + C.REC);
      if (!inGuest(rec, 0x920)) continue;
      const name = readName(rec), p = v3(it + C.POS), f = v3(it + C.FWD), v = v3(it + C.VEL);
      if (!name || !fin(p) || !fin(f) || !fin(v) || Math.abs(p[0]) >= 20000 || Math.abs(p[1]) >= 20000 || Math.abs(p[2]) >= 2000) continue;
      out.push({ name, lc: name.toLowerCase(), car: it, p, f, v, d: Math.hypot(p[0] - mp[0], p[1] - mp[1]) });
    }
    out.sort((a, b) => a.lc.localeCompare(b.lc));
    return out;
  }
  const findTarget = () => { const t = S.target.toLowerCase(); return S.players.find(q => q.lc === t) || null; };
  function pickPlayer(step, query) {
    if (!S.players.length) return note('no other player cars loaded near you');
    if (query != null) {
      const q = String(query).trim().toLowerCase();
      if (!q) return;
      const hit = S.players.find(x => x.lc === q) || S.players.find(x => x.lc.startsWith(q)) || S.players.find(x => x.lc.includes(q));
      if (!hit) return note('no loaded player matches "' + query + '"');
      S.target = hit.name;
    } else {
      const i = S.players.findIndex(x => x.name === S.target);
      S.target = S.players[(i + step + S.players.length) % S.players.length].name;
    }
    S.confirm = null;
    const t = findTarget(); note('target: ' + S.target + (t ? ' (' + Math.round(t.d) + ' m)' : ''));
  }
  function warpToPlayer(car, rb) {
    const t0 = now();
    if (!allowed('warp')) return note(S.mode === 'RACE' ? 'warp to player: locked in races' : 'warp to player: not in free roam');
    S.players = listPlayers(car); S.playersAt = t0;
    if (!S.target) pickPlayer(1);
    const tg = findTarget();
    if (!tg) return note(S.target ? S.target + ': no car loaded (too far or not in free roam)' : 'no target');
    if (S.warp) return note('warp: one already pending');
    if (t0 < S.warpReadyAt) return note('warp: cooldown ' + Math.ceil((S.warpReadyAt - t0) / 1000) + ' s');
    if (u32(car + C.PHYS) !== 1) return note('warp: car not under physics');
    const fl = Math.hypot(tg.f[0], tg.f[1]) || 1, fx = tg.f[0] / fl, fy = tg.f[1] / fl;
    const to = [tg.p[0] - fx * CFG.behindM, tg.p[1] - fy * CFG.behindM, tg.p[2] + 1.0];
    const p = v3(car + C.POS), d = Math.hypot(to[0] - p[0], to[1] - p[1]);
    if (presetOn() && d > raceToPlayerM()) return note('warp to player: ' + Math.round(d) + ' m, race limit ' + raceToPlayerM() + ' m');
    if (Math.abs(to[0]) > 19000 || Math.abs(to[1]) > 19000 || Math.abs(to[2]) > 1900) return note('warp: target out of bounds');
    if (S.over + d > CFG.warpOverBudgetM) {
      // over the server's teleport line (watch.rs JUMP_M 300 m after the 175 m/s allowance): logged whatever we do
      if (!S.confirm || S.confirm.name !== tg.name || t0 - S.confirm.t > CFG.confirmMs) {
        S.confirm = { name: tg.name, t: t0 };
        return note('WARNING ' + Math.round(d) + ' m: watch.rs will log this as a teleport. Alt+W again to jump anyway', CFG.confirmMs);
      }
    }
    S.confirm = null;
    // heading: the own car's u16 heading against its forward vector gives the offset; the target's is its forward's
    const mf = v3(car + C.FWD), toU16 = r => r * 32768 / Math.PI;
    const h = (u16(car + C.HEAD) + CFG.headingSign * toU16(Math.atan2(fy, fx) - Math.atan2(mf[1], mf[0]))) & 0xffff;
    const m = rb ? massOf(car, rb) : typeMass(car);
    w3(A.HOTPOS, to); wu16(A.HOTPOS_ANGLE, Math.round(h) & 0xffff); wu8(A.HOTPOS_VALID, 1); wu8(A.HOTPOS_JUMP, 1);
    S.warp = { from: p, to, d, v: tg.v, m, t: t0, car, moved: false, name: tg.name };
    S.warpReadyAt = t0 + CFG.warpCooldownS * 1000;
    if (d > CFG.warpOverBudgetM) note('jumping ' + Math.round(d) + ' m to ' + tg.name + ' (logged as a teleport)');
  }

  // local mirrors of the two counters the brief is about
  function trackAir(car, dt, hovering, g) {
    const up = f32(car + C.UP + 8), v = v3(car + C.VEL), sp = len(v);
    const ground = (!hovering || S.descending) && g;
    if (u32(car + C.PHYS) !== 1) return;
    if (ground) {
      if (S.air > 0 && (S.ground += dt) >= CFG.groundResetS) { S.air = 0; S.ground = 0; }
      return;
    }
    S.ground = 0;
    // fly_car's own exceptions (not a plane): on its side, under 5 m/s, falling faster than 15 m/s. Hover counts always.
    if (hovering || (up >= 0.5 && sp >= 5 && v[2] > -15)) S.air += dt;
  }
  function trackOver(car, dt) {
    const p = v3(car + C.POS);
    if (S.lastPos) {
      const d = Math.hypot(p[0] - S.lastPos[0], p[1] - S.lastPos[1], p[2] - S.lastPos[2]);
      S.over = Math.max(0, S.over + d - (125 + 50) * dt);
    }
    S.lastPos = p;
  }

  // ---------------------------------------------------------------- frame
  function tick(dtRaw) {
    const dt = Math.min(0.05, Math.max(0, dtRaw));
    if (!mems.length) { S.mode = 'NO MEMORY'; S.diag = memDiag(); return; }
    S.diag = '';
    const car = refreshView();
    lastCar = car;
    if (!car) { S.mode = 'NO CAR'; S.hover = false; S.lastPos = null; gov.car = 0; grip.car = 0; CORNER.car = 0; CORNER.f = 1; return; }
    try {
      S.mode = worldMode(car);
      const rb = rigidBody(car), phys = u32(car + C.PHYS) === 1;
      const ctlp = rd32(car + C.CTL), ctl = { throttle: 0, brake: 0, steer: 0 };
      if (inGuest(ctlp, 0x220)) {
        ctl.throttle = Math.max(0, Math.min(1, f32(ctlp + 0x20c) || 0));
        ctl.brake = Math.max(0, Math.min(1, f32(ctlp + 0x214) || 0));
        ctl.steer = Math.max(-1, Math.min(1, (dv.getInt16(ctlp + 0x1e0, true) / 32767) || 0));
      }
      if (S.hover && (!allowed('hover') || !rb || !phys)) { S.hover = false; S.descending = false; note('hover off (' + S.mode + ')'); }
      // read once: nothing below writes the ground bytes before their last use (hoverStep's write only matters while
      // hovering, when brake and boost do not run)
      const g = anyGround(car);
      if (S.hover && S.descending) {
        if (g || S.air >= CFG.airLimitS) { S.hover = false; S.descending = false; note('hover off: landed / budget'); }
      }
      trackAir(car, dt, S.hover, g);
      trackOver(car, dt);
      // the list is only shown by the overlay; the Alt+W / E / Q keys read it fresh themselves
      if (S.overlay) { const t = now(); if (t - S.playersAt > 500) { S.players = listPlayers(car); S.playersAt = t; } }
      if (S.grip && !allowed('grip')) { S.grip = 0; gripBack(car); note('grip off (' + S.mode + ')'); }
      if (S.corner && !cornerOk()) { S.corner = false; cornerBack(car); note('corner assist off (' + S.mode + ')'); }
      if (S.brake && !brakeOk()) { S.brake = 0; BR.last = 0; note('brake off (' + S.mode + ')'); }
      if (S.nos && !allowed('nos')) { S.nos = false; note('nos off (' + S.mode + ')'); }
      if (!S.boost || !allowed('boost') || S.hover) { if (presetOn()) governorSet(car, raceCeiling); else governorBack(car); }
      if (S.nos) { const r = nosStep(car); if (r !== 'ok') { S.nos = false; note(r === 'none' ? 'nos: this car has no nitrous' : 'nos: clock looks wrong, off'); } }
      if (S.grip && phys && !gripStep(car, S.grip)) { S.grip = 0; gripBack(car); note('grip: wheels not found, off'); }
      if (S.corner && phys && !cornerStep(car, rb, dt, ctl, g)) { S.corner = false; cornerBack(car); note('corner assist: wheels not found, off'); }
      if (!rb || !phys) return;
      if (S.hover) hoverStep(car, rb, dt, ctl);
      const braking = ctl.brake >= 0.1; // braking wins: no boost while the brake is held
      if (S.brake && !S.hover) brakeStep(car, rb, dt, ctl, g); else BR.last = 0;
      if (S.boost && allowed('boost') && !S.hover && !braking) boostStep(car, rb, dt, ctl, g);
      warpStep(car, rb);
    } catch (e) {
      // wrong offsets or a buffer that went away: stop editing
      S.hover = false; S.boost = false; S.nos = false; S.grip = 0; S.brake = 0; S.corner = false; S.warp = null; S.mode = 'ERROR'; note('stopped: ' + (e && e.message));
      gov.car = 0; grip.car = 0;
      memIdx = -1; playerIdx = -1; lastCar = 0; locked = false;
    }
  }

  const KEYS = new Set(Object.values(CFG.keys));
  function onKey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = CFG.keys, code = e.code;
    if (!KEYS.has(code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'keyup') { if (code === k.up || code === k.down) S.climb = 0; return; }
    if (code === k.up) { S.climb = 1; return; }
    if (code === k.down) { S.climb = -1; return; }
    if (e.repeat) return;
    if (code === k.overlay) { S.overlay = !S.overlay; return; }
    if (code === k.race) {
      const on = !raceOn(); Object.keys(CFG.allowInRace).forEach(f => { CFG.allowInRace[f] = on; });
      return note(on ? 'races: allowed, race preset in races' : 'races: locked');
    }
    const car = mems.length ? refreshView() : 0;
    if (!car) return note('no car in memory');
    S.mode = worldMode(car);
    if (code === k.boost) {
      if (!S.boost && !allowed('boost')) return note(S.mode === 'RACE' ? 'boost: locked in races' : 'boost: not in free roam');
      S.boost = !S.boost; if (!S.boost) governorBack(car);
      return note('boost ' + (S.boost ? 'on' : 'off'));
    }
    if (code === k.nos) {
      if (!S.nos && !allowed('nos')) return note(S.mode === 'RACE' ? 'nos: locked in races' : 'nos: not in free roam');
      S.nos = !S.nos; return note('nos refill ' + (S.nos ? 'on' : 'off'));
    }
    if (code === k.corner) {
      if (S.corner) { S.corner = false; cornerBack(car); return note('corner assist off'); }
      if (!cornerOk()) return note(S.mode === 'RACE' ? 'corner assist: locked in races' : 'corner assist: not in free roam');
      if (wheels(car).length !== 4) return note('corner assist: wheels not found');
      S.corner = true; return note('corner assist on (up to x' + CFG.cornerMax + ')');
    }
    if (code === k.brake) { // Alt+6 next level (after the last: off), Shift+Alt+6 off
      const next = e.shiftKey ? 0 : (S.brake + 1) % (CFG.brakeLevels.length + 1);
      if (next && !brakeOk()) return note(S.mode === 'RACE' ? 'brake: locked in races' : 'brake: not in free roam');
      S.brake = next; BR.last = 0; return note('brake ' + brakeLabel());
    }
    if (code === k.grip) { // Alt+5 next level (after the last: off), Shift+Alt+5 off
      const n = gripLevels().length, next = e.shiftKey ? 0 : (S.grip + 1) % (n + 1);
      if (!next) { S.grip = 0; gripBack(car); return note('grip off'); }
      if (!allowed('grip')) return note(S.mode === 'RACE' ? 'grip: locked in races' : 'grip: not in free roam');
      if (wheels(car).length !== 4) return note('grip: wheels not found');
      S.grip = next; return note('grip ' + gripLabel());
    }
    if (code === k.hover) {
      if (S.hover) { S.hover = false; S.descending = false; return note('hover off'); }
      if (!allowed('hover')) return note(S.mode === 'RACE' ? 'hover: locked in races' : 'hover: not in free roam');
      if (S.air >= CFG.airDescendS - 5) return note('hover: land ' + CFG.groundResetS + ' s first (air ' + Math.round(S.air) + ' s)');
      const rb = rigidBody(car);
      if (!rb) return note('hover: no rigid body');
      const z = f32(car + C.POS + 8);
      S.hoverBaseZ = z; S.hoverZ = z + CFG.hoverLiftM; S.descending = false; S.hover = true;
      levelPose(car, rb);
      return note('hover on');
    }
    if (code === k.warp) return warpStart(car, rigidBody(car));
    S.players = listPlayers(car); S.playersAt = now();
    if (code === k.nextPlayer) return pickPlayer(e.shiftKey ? -1 : 1);
    if (code === k.findPlayer) {
      let q = null; try { q = W.prompt('Warp target: player name (or part of it)', S.target); } catch (_) { /* ignore */ }
      return q == null ? undefined : pickPlayer(0, q);
    }
    if (code === k.toPlayer) warpToPlayer(car, rigidBody(car));
  }

  const gripLabel = () => !S.grip ? 'off' : 'L' + S.grip + ' x' + gripFactor(S.grip).toFixed(1) +
    (S.grip === gripLevels().length ? ' + catch-up x' + cuFactor().toFixed(2) : '');
  // ---------------------------------------------------------------- overlay
  let box = null, boxText = '', boxShown = null;
  function draw() {
    if (typeof document === 'undefined') return;
    if (!box) {
      if (!document.body) return;
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;font:12px/1.35 ui-monospace,Menlo,monospace;' +
        'color:#e8e8e8;background:rgba(0,0,0,.62);padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre';
      document.body.appendChild(box);
    }
    if (boxShown !== S.overlay) { boxShown = S.overlay; box.style.display = S.overlay ? 'block' : 'none'; }
    if (!S.overlay) return;
    const t = now(), lock = f => (allowed(f) ? '' : ' [locked]');
    const cd = Math.max(0, Math.ceil((S.warpReadyAt - t) / 1000));
    let kmh = '';
    try { if (dv && lastCar) kmh = Math.round(len(v3(lastCar + C.VEL)) * 3.6) + ' km/h'; } catch (_) { /* ignore */ }
    const text =
      'NFSU2 own car  ' + S.mode + '  ' + kmh + '  [' + WORLD.id + ' world]\n' + (S.diag ? S.diag + '\n' : '') +
      'Alt+1 hover  ' + (S.hover ? (S.descending ? 'DESCENDING' : 'ON') : 'off') + lock('hover') + '  air ' + Math.round(S.air) + '/' + CFG.airLimitS + ' s\n' +
      'Alt+2 warp   ' + (cd ? cd + ' s' : 'ready') + lock('warp') + '  excess ' + Math.round(S.over) + ' m\n' +
      'Alt+3 boost  ' + (S.boost ? 'ON' : 'off') + lock('boost') + '  cap ' + Math.round(boostCap() * 3.6) + ' km/h, ' + (presetOn() ? 'governor ' + raceGovMph() + ' mph' : 'no governor') + '\n' +
      'Alt+4 nos    ' + (S.nos ? 'ON (kept full)' : 'off') + lock('nos') + '\n' +
      'Alt+5 grip   ' + gripLabel() + lock('grip') + '  (cycle ' + gripLevels().map(f => f.toFixed(1)).join('/') + '+, Shift+Alt+5 off)\n' +
      'Alt+6 brake  ' + brakeLabel() + lock('brake') + '  (cycle ' + CFG.brakeLevels.map(f => f.toFixed(1)).join('/') + 'x, Shift+Alt+6 off)\n' +
      'Alt+7 corner ' + (S.corner ? 'ON x' + CORNER.f.toFixed(2) + (S.grip ? ' (paused: Alt+5 on)' : '') : 'off') + lock('corner') +
        '  up to x' + CFG.cornerMax + ' while steering with slip\n' +
      'Alt+W to player  ' + (S.target || '-') + playerInfo(t) + lock('warp') + '\n' +
      'Alt+E next player (Shift back)  Alt+Q find by name  (' + S.players.length + ' loaded)\n' +
      'Alt+9 races  ' + (raceOn() ? 'ALLOWED  race preset ' + (presetOn() ? 'ACTIVE' : '(in races)') + ': boost ' +
        Math.round(Math.min(RACE_BOOST_HARD_MPS, CFG.racePreset.boostCapMps) * 3.6) + ' km/h, governor ' + raceGovMph() + ' mph, warp ' +
        raceWarpM() + ' m, to player ' + raceToPlayerM() + ' m' : 'locked') + '\n' +
      'Alt+X / Alt+Z hover up/down   Alt+0 overlay' +
      (t < S.noteUntil ? '\n> ' + S.note : '');
    if (text !== boxText) { boxText = text; box.textContent = text; }
  }

  function playerInfo(t) {
    if (!S.target) return '';
    const q = findTarget();
    if (!q) return ' (no car loaded)';
    const far = S.over + q.d > CFG.warpOverBudgetM;
    return ' ' + Math.round(q.d) + ' m' + (far ? '  ! > ' + CFG.warpOverBudgetM + ' m: logged as teleport' : '') +
      (S.confirm && t - S.confirm.t < CFG.confirmMs ? '  [Alt+W to confirm]' : '');
  }

  // ---------------------------------------------------------------- start
  const TEST = typeof globalThis.__NFSU2_OWNCAR_TEST__ === 'object' ? globalThis.__NFSU2_OWNCAR_TEST__ : null;
  if (TEST) { // offline harness hook
    Object.assign(TEST, { CFG, A, C, R, S, mems, tick, onKey, raceOn, presetOn, boostCap, warpDist, considerSab, considerMemory, findCar, worldMode, refreshView, listPlayers, draw,
      seen, scan, memDiag, hooked, world: { id: WORLD.id, how: WORLD.how, ff: WORLD.ff } });
    if (TEST.installHooks) installHooks(); // hook test: on this realm's globals
    return;
  }
  installHooks();
  W.addEventListener('keydown', onKey, true);
  W.addEventListener('keyup', onKey, true);
  let last = now(), lastDraw = 0;
  function frame() {
    const t = now();
    tick((t - last) / 1000); last = t;
    if (t - lastDraw > 100) { lastDraw = t; try { draw(); } catch (_) { /* ignore */ } }
    W.requestAnimationFrame(frame);
  }
  W.requestAnimationFrame(frame);
  log('loaded; waiting for the game memory');
})();
