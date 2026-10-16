import { cookies } from "next/headers";

import { getAdminSessionsValidAfter } from "@/lib/workquiz/admin-sessions";
import { readSecret } from "@/lib/workquiz/secrets";

const ADMIN_SESSION_COOKIE = "workquiz_admin_session";
const ADMIN_LOGIN_PATH = "/admin-login";
const DEFAULT_ADMIN_REDIRECT = "/admin";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// A little slack for a session minted a moment "in the future" by clock skew.
const SESSION_CLOCK_SKEW_MS = 60 * 1000;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES_PER_IP = 5;
// Caps guessing from many addresses at once (forwarded IPs can be faked).
// Hitting it blocks new sign-ins for a while; existing sessions keep working.
const LOGIN_MAX_FAILURES_TOTAL = 30;
const LOGIN_FAILURE_DELAY_MS = 1000;

type AdminSignInResult =
  | { ok: true }
  | { ok: false; reason: "config" | "invalid" | "locked" };

declare global {
  var __workquizLoginFailures: { total: number[]; byIp: Map<string, number[]> } | undefined;
}

function getConfiguredCredentials() {
  const username = process.env.WORKQUIZ_ADMIN_USERNAME?.trim();
  const password = process.env.WORKQUIZ_ADMIN_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function signValue(value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(readSecret("WORKQUIZ_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function isAdminAuthConfigured() {
  return getConfiguredCredentials() !== null;
}

/**
 * A session cookie is "<issued-at ms>.<signature>". The signature covers the
 * credentials and the issue time, so changing the password ends every
 * session, and the server (not just the browser) enforces the 30-day limit
 * and "sign out everywhere".
 */
export async function buildAdminSessionValue(issuedAt = Date.now()) {
  const credentials = getConfiguredCredentials();
  if (!credentials) {
    return null;
  }

  const signature = await signValue(
    `workquiz-admin:v2:${credentials.username}:${credentials.password}:${issuedAt}`,
  );
  return `${issuedAt}.${signature}`;
}

export async function hasValidAdminSessionValue(
  sessionValue?: string | null,
  options: { validAfter?: number | null; now?: number } = {},
) {
  const match = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(sessionValue ?? "");
  if (!match) {
    return false;
  }

  const issuedAt = Number(match[1]);
  const now = options.now ?? Date.now();
  if (issuedAt > now + SESSION_CLOCK_SKEW_MS || now - issuedAt > SESSION_MAX_AGE_SECONDS * 1000) {
    return false;
  }

  if (options.validAfter != null && issuedAt < options.validAfter) {
    return false;
  }

  const expectedValue = await buildAdminSessionValue(issuedAt);
  return Boolean(expectedValue) && safeEqual(expectedValue!, sessionValue!);
}

/** Checks a cookie value, including whether "sign out everywhere" has ended it. */
export async function isAdminSessionValueCurrent(sessionValue?: string | null) {
  if (!sessionValue) {
    return false;
  }

  return hasValidAdminSessionValue(sessionValue, { validAfter: await getAdminSessionsValidAfter() });
}

export async function isAdminAuthenticated() {
  const jar = await cookies();
  return isAdminSessionValueCurrent(jar.get(ADMIN_SESSION_COOKIE)?.value);
}

/** Starts a fresh session in this browser. */
export async function setAdminSessionCookie(issuedAt = Date.now()) {
  const sessionValue = await buildAdminSessionValue(issuedAt);
  if (!sessionValue) {
    return false;
  }

  const jar = await cookies();
  jar.set(ADMIN_SESSION_COOKIE, sessionValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  return true;
}

function loginFailures() {
  globalThis.__workquizLoginFailures ??= { total: [], byIp: new Map() };
  return globalThis.__workquizLoginFailures;
}

function pruneFailures(now: number) {
  const failures = loginFailures();
  const cutoff = now - LOGIN_WINDOW_MS;
  failures.total = failures.total.filter((time) => time > cutoff);
  for (const [ip, times] of failures.byIp) {
    const recent = times.filter((time) => time > cutoff);
    if (recent.length) {
      failures.byIp.set(ip, recent);
    } else {
      failures.byIp.delete(ip);
    }
  }
}

function isLoginLocked(ip: string, now: number) {
  pruneFailures(now);
  const failures = loginFailures();
  return (
    failures.total.length >= LOGIN_MAX_FAILURES_TOTAL ||
    (failures.byIp.get(ip)?.length ?? 0) >= LOGIN_MAX_FAILURES_PER_IP
  );
}

function recordLoginFailure(ip: string, now: number) {
  const failures = loginFailures();
  failures.total.push(now);
  failures.byIp.set(ip, [...(failures.byIp.get(ip) ?? []), now]);
}

/** Test hook: forget every recorded failed sign-in. */
export function resetLoginFailures() {
  globalThis.__workquizLoginFailures = undefined;
}

export async function signInAdmin(
  username: string,
  password: string,
  options: { clientIp?: string | null; now?: number; failureDelayMs?: number } = {},
): Promise<AdminSignInResult> {
  const now = options.now ?? Date.now();
  const credentials = getConfiguredCredentials();
  if (!credentials) {
    return { ok: false, reason: "config" };
  }

  const ip = options.clientIp ?? "unknown";
  if (isLoginLocked(ip, now)) {
    console.warn(`[admin-login] refused while locked (ip ${ip})`);
    return { ok: false, reason: "locked" };
  }

  if (!safeEqual(username.trim(), credentials.username) || !safeEqual(password, credentials.password)) {
    recordLoginFailure(ip, now);
    console.warn(`[admin-login] failed sign-in (ip ${ip})`);
    // Slows guessing down. Not a lock: the counters above do that.
    const delay = options.failureDelayMs ?? LOGIN_FAILURE_DELAY_MS;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return { ok: false, reason: "invalid" };
  }

  if (!(await setAdminSessionCookie(now))) {
    return { ok: false, reason: "config" };
  }

  return { ok: true };
}

export function sanitizeAdminRedirectTarget(target?: string | null) {
  if (!target || !target.startsWith("/") || target.startsWith("//")) {
    return DEFAULT_ADMIN_REDIRECT;
  }

  try {
    const url = new URL(target, "http://workquiz.local");
    if (url.origin !== "http://workquiz.local") {
      return DEFAULT_ADMIN_REDIRECT;
    }

    if (url.pathname.startsWith("/api/")) {
      return DEFAULT_ADMIN_REDIRECT;
    }

    return `${url.pathname}${url.search}`;
  } catch {
    return DEFAULT_ADMIN_REDIRECT;
  }
}

export function buildAdminLoginRedirect(target?: string | null, error?: string) {
  const next = sanitizeAdminRedirectTarget(target);
  const params = new URLSearchParams();
  params.set("next", next);
  if (error) {
    params.set("error", error);
  }

  return `${ADMIN_LOGIN_PATH}?${params.toString()}`;
}

export const ADMIN_AUTH = {
  loginPath: ADMIN_LOGIN_PATH,
  sessionCookie: ADMIN_SESSION_COOKIE,
};
