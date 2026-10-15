import { cookies } from "next/headers";
import { nanoid } from "nanoid";

import { COOKIE_NAME, LAST_ROSTER_MEMBER_COOKIE } from "@/lib/workquiz/constants";

export async function getBrowserToken() {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? null;
}

export async function getOrCreateBrowserToken() {
  const jar = await cookies();
  const existing = jar.get(COOKIE_NAME)?.value;
  if (existing) {
    return existing;
  }

  const token = nanoid(24);
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90,
    path: "/",
  });

  return token;
}

/** Raw remembered-claim cookie: "rosterMemberId~claimId" (see voter.ts). */
export async function getRememberedClaim() {
  const jar = await cookies();
  return jar.get(LAST_ROSTER_MEMBER_COOKIE)?.value ?? null;
}

export async function setRememberedClaim(value: string | null) {
  const jar = await cookies();

  if (!value) {
    jar.delete(LAST_ROSTER_MEMBER_COOKIE);
    return;
  }

  // httpOnly: page scripts never read it, and it now carries a recovery secret.
  jar.set(LAST_ROSTER_MEMBER_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90,
    path: "/",
  });
}
