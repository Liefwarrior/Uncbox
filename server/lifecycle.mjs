// Two small tools for the server's long-running parts: a lease that starts something when it is
// asked for and stops it when nobody has asked for a while, and a shutdown that stops everything
// in order before the process exits.

/**
 * How long a helper outlives the last ask. Widgets ask every 30 seconds, but a page in the tray or
 * a background tab has its timers slowed to once a minute, so the lease must be longer than that.
 */
export const HELPER_IDLE_MS = 90_000;

/**
 * Runs `start` on the first `touch()` and `stop` once `idleMs` pass without another one, so a
 * helper process or poller only runs while some page is still using it. Touch it on every request
 * (the page asks again every ~30 s while its widget shows); touching a stopped lease starts it
 * again. `setTimer` and `clearTimer` are what the tests swap out.
 */
export function createLease({ idleMs = 60_000, start, stop, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let on = false;
  let timer = null;

  function release() {
    timer = null;
    if (!on) return;
    on = false;
    stop();
  }

  return {
    touch() {
      if (!on) {
        start();
        on = true;
      }
      clearTimer(timer);
      timer = setTimer(release, idleMs);
      // An idle lease alone must never keep the process alive.
      timer?.unref?.();
    },
    /** Stops it now (the helper died, or the server is shutting down). Safe to call when stopped. */
    close() {
      clearTimer(timer);
      timer = null;
      release();
    },
    get active() {
      return on;
    },
  };
}

/**
 * Stops the server's parts one at a time, last added first, then exits. A part that
 * hangs is given `graceMs` and then left behind. A second signal while stopping exits at once, so
 * a second Ctrl+C never waits on anything.
 */
export function createShutdown({ exit = (code) => process.exit(code), log = (line) => console.log(line), graceMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const parts = [];
  let running = null;

  function run(reason, code = 0) {
    running ??= (async () => {
      log(`Uncbox: stopping (${reason}).`);
      for (const { name, fn } of parts.slice().reverse()) {
        let giveUp;
        const late = new Promise((resolve) => {
          giveUp = setTimer(() => {
            log(`Uncbox: ${name} took too long to stop; leaving it.`);
            resolve();
          }, graceMs);
          giveUp?.unref?.();
        });
        try {
          await Promise.race([Promise.resolve().then(fn), late]);
        } catch (err) {
          log(`Uncbox: couldn't stop ${name}: ${err?.message ?? err}`);
        }
        clearTimer(giveUp);
      }
      exit(code);
    })();
    return running;
  }

  return {
    /** Registers something to stop. `fn` may be async. */
    add(name, fn) {
      parts.push({ name, fn });
    },
    run,
    /** Makes SIGINT/SIGTERM (and the console's close/break) stop the server cleanly. */
    install(proc = process) {
      let signals = 0;
      const onSignal = (signal) => {
        if (signals++ > 0) return exit(1);
        void run(signal);
      };
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
        try {
          proc.on(signal, () => onSignal(signal));
        } catch {
          // Not a signal on this platform.
        }
      }
    },
  };
}
