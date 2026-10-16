import { readStore, updateStore } from "@/lib/workquiz/store";

// The proxy checks this on every admin request, so it is cached briefly
// instead of reading the store each time. "Sign out everywhere" updates the
// cache directly, so the browser that pressed it sees the change at once;
// anything else catches up within this window.
const CACHE_MS = 15 * 1000;

declare global {
  var __workquizAdminSessionsValidAfter: { value: number | null; fetchedAt: number } | undefined;
}

function parseTime(value?: string) {
  if (!value) {
    return null;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Sessions issued before this time (ms) are no longer valid; null if never set. */
export async function getAdminSessionsValidAfter() {
  const cached = globalThis.__workquizAdminSessionsValidAfter;
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.value;
  }

  try {
    const value = parseTime((await readStore()).adminSessionsValidAfter);
    globalThis.__workquizAdminSessionsValidAfter = { value, fetchedAt: Date.now() };
    return value;
  } catch (error) {
    // The signature and 30-day limit are still checked. Refusing every admin
    // request because the store blinked would only lock the admin out.
    console.warn("[admin-sessions] could not read the sign-out time", error);
    return cached?.value ?? null;
  }
}

/** Ends every admin session issued before `now`, in every browser. */
export async function revokeAdminSessions(now = new Date()) {
  await updateStore((store) => {
    store.adminSessionsValidAfter = now.toISOString();
    return store;
  });
  globalThis.__workquizAdminSessionsValidAfter = { value: now.getTime(), fetchedAt: Date.now() };
}

/** Test hook: drop the cached value so the next check reads the store. */
export function clearAdminSessionsCache() {
  globalThis.__workquizAdminSessionsValidAfter = undefined;
}
