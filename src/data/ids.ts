import { uuidv7 } from "@hostry/client-core";

/**
 * UUIDv7 ids that sort in creation order even within one millisecond (RFC 9562 method 1: a 12-bit counter in rand_a).
 * Screens sort lines, moves and tickets by id, so two taps in the same millisecond must not swap.
 */
export function monotonicIds(now: () => number = Date.now): () => string {
  let lastMs = -1;
  let seq = 0;
  return () => {
    let ms = now();
    if (ms <= lastMs) {
      ms = lastMs;
      seq++;
      if (seq > 0xfff) {
        ms++;
        seq = 0;
      }
    } else seq = 0;
    lastMs = ms;
    const s = seq;
    return uuidv7(
      () => ms,
      () => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (s >> 8) & 0x0f;
        b[7] = s & 0xff;
        return b;
      },
    );
  };
}
