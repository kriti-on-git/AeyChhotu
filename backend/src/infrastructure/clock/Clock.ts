/* Clock — an injectable time source.

   Only what the foundation needs today: timestamps for log lines and future
   health/diagnostic ages. Injected rather than read from Date.now() inline so
   a test can assert an exact timestamp without patching globals. */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
