// Two switches that keep the server from touching anything outside its own folders. They exist so
// server/smoke.test.mjs can boot the real server on a developer's PC (or a CI machine) without it
// starting PowerShell helpers, reading the registry, or reaching the internet, OBS or Discord.
// Neither is set in normal use.
//
//   UNCBOX_NO_HELPERS=1  start no child programs to read this PC (PowerShell, reg, tasklist,
//                        nvidia-smi): those features answer as if the program were not there.
//   UNCBOX_OFFLINE=1     make no connection to anything outside the server: no internet, no OBS,
//                        no Discord, no pings. Calls fail the way a lost connection does.

/** True when UNCBOX_NO_HELPERS=1: don't start helper programs. */
export const noHelpers = () => process.env.UNCBOX_NO_HELPERS === '1';

/** True when UNCBOX_OFFLINE=1: don't connect to anything. */
export const offline = () => process.env.UNCBOX_OFFLINE === '1';

/** A stand-in for fetch that fails like a lost connection; index.mjs hands it to the modules when offline. */
export const offlineFetch = () => Promise.reject(new TypeError('fetch failed (UNCBOX_OFFLINE)'));
