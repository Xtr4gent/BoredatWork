import { INTERNAL_SCHEDULER_HEADER } from "./constants";

const TICK_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

/**
 * Closes and opens rounds on time. Without this a round only changed when
 * someone loaded the site, so an 8 PM close happened at the first visit the
 * next morning, and the round-start ping went out late with it.
 *
 * It calls the app's own scheduler route rather than importing the bracket
 * code, so the advance runs inside Next with the same modules (store pool,
 * realtime rooms) as every other request. One request at a time, each with a
 * timeout; a failure is logged once until it recovers.
 */
export function startRoundClock(port: number, secret: string) {
  let running = false;
  let failing = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/internal/round-advance`, {
        method: "POST",
        headers: { [INTERNAL_SCHEDULER_HEADER]: secret },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (failing) {
        console.log("[round-clock] recovered");
        failing = false;
      }
    } catch (error) {
      if (!failing) {
        console.warn("[round-clock] advance check failed:", error instanceof Error ? error.message : error);
        failing = true;
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
