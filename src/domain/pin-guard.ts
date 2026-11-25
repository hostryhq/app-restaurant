/**
 * PIN attempt policy (RS01, RM-A7): the screen never says whether the name or the PIN failed. After 5 wrong tries on one
 * member the device makes them wait a minute; after 10 it locks that member on this device until the owner resets the
 * PIN online. The counter resets on a correct PIN. Pure: time comes in as a parameter.
 */

export const DELAY_AFTER = 5;
export const LOCK_AFTER = 10;
export const DELAY_SECONDS = 60;

export type GuardState = { wrong: number; blockedUntilMs: number };

export type Attempt = { allowed: true } | { allowed: false; reason: "delay" | "locked"; waitSeconds: number };

export function emptyGuard(): GuardState {
  return { wrong: 0, blockedUntilMs: 0 };
}

/** May a PIN be tried now? */
export function checkAttempt(g: GuardState, nowMs: number): Attempt {
  if (g.wrong >= LOCK_AFTER) return { allowed: false, reason: "locked", waitSeconds: 0 };
  if (g.wrong >= DELAY_AFTER && nowMs < g.blockedUntilMs) {
    return { allowed: false, reason: "delay", waitSeconds: Math.ceil((g.blockedUntilMs - nowMs) / 1000) };
  }
  return { allowed: true };
}

/** State after an attempt. A wrong PIN at a multiple of 5 starts the delay. */
export function afterAttempt(g: GuardState, correct: boolean, nowMs: number): GuardState {
  if (correct) return emptyGuard();
  const wrong = g.wrong + 1;
  return { wrong, blockedUntilMs: wrong >= DELAY_AFTER && wrong < LOCK_AFTER ? nowMs + DELAY_SECONDS * 1000 : g.blockedUntilMs };
}
