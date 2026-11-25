import type { Delivery } from "./ports";

/** What the simulator needs from the writer. */
export interface LocalWriter {
  deliver(level: Exclude<Delivery, "local">, upTo?: number): Promise<number>;
}
