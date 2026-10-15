import { nanoid } from "nanoid";

import type { BracketRecord } from "@/lib/workquiz/types";

/** memberClaims value meaning "an admin freed this name; no cookie may recover it". */
const RELEASED_CLAIM_PREFIX = "released:";

export function releasedClaimMarker() {
  return `${RELEASED_CLAIM_PREFIX}${nanoid(8)}`;
}

export function isReleasedClaim(value: string | undefined) {
  return value?.startsWith(RELEASED_CLAIM_PREFIX) ?? false;
}

/**
 * Drops "freed" markers so a full reset or restart really is a clean slate:
 * a browser the admin once froze out can pick its name again. Live claims
 * are kept so ordinary cookie-drift recovery keeps working.
 */
export function clearReleasedClaims(bracket: BracketRecord) {
  for (const [rosterMemberId, claim] of Object.entries(bracket.memberClaims ?? {})) {
    if (isReleasedClaim(claim)) {
      delete bracket.memberClaims![rosterMemberId];
    }
  }
}

/**
 * Upgrade for brackets released under the first Vote Watch build, which
 * tracked releases per browser token in `releasedBrowserTokens`. For each
 * name listed there without a claim record:
 * - nobody holds it now: mark it released, so the old browser's member-only
 *   cookie cannot recover it;
 * - a different browser re-registered it since: give it a fresh live claim.
 *   The old browser's member-only cookie no longer matches, and the current
 *   holder receives the claim cookie on its next poll (see
 *   ensureClaimForBoundBrowser), so its own recovery keeps working.
 * Returns true when the bracket changed.
 */
export function upgradeLegacyReleases(bracket: BracketRecord & { releasedBrowserTokens?: Record<string, string> }) {
  const legacy = bracket.releasedBrowserTokens;
  if (!legacy) {
    return false;
  }

  for (const rosterMemberId of new Set(Object.values(legacy))) {
    bracket.memberClaims ??= {};
    if (bracket.memberClaims[rosterMemberId] !== undefined) {
      continue;
    }

    const holder = browserTokenForRosterMember(bracket, rosterMemberId);
    const heldByNewBrowser = holder !== null && legacy[holder] !== rosterMemberId;
    bracket.memberClaims[rosterMemberId] = heldByNewBrowser ? nanoid(16) : releasedClaimMarker();
  }
  delete bracket.releasedBrowserTokens;
  return true;
}

/**
 * True when a browser bound to a name is not carrying that name's current
 * claim in its remembered cookie (an old member-only cookie, or a claim that
 * predates an upgrade). Read-only, so the hot polling path can skip the write.
 */
export function boundBrowserNeedsClaimCookie(
  bracket: BracketRecord,
  browserToken: string,
  remembered: string | null,
) {
  const bound = rosterMemberIdForBrowser(bracket, browserToken);
  if (!bound) {
    return false;
  }

  const parsed = parseRememberedClaim(remembered);
  const current = bracket.memberClaims?.[bound];
  return !(parsed?.rosterMemberId === bound && parsed.claimId !== null && parsed.claimId === current);
}

function normalizeRosterName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function ensureVoterBindings(bracket: BracketRecord) {
  bracket.voterBindings ??= {};
}

/**
 * The remembered-name cookie holds "rosterMemberId~claimId". The claim id is
 * a secret minted on every successful pick and stored in
 * bracket.memberClaims, so only the browser that made the CURRENT
 * registration can recover the name after its main cookie drifts. An admin
 * release replaces the stored id, which kills every older cookie no matter
 * which browser token it now travels with. Cookies written before claim ids
 * existed carry only the member id and keep working until the name is next
 * picked or released.
 */
const REMEMBERED_SEPARATOR = "~";

export interface RememberedClaim {
  rosterMemberId: string;
  claimId: string | null;
}

export function parseRememberedClaim(raw: string | null | undefined): RememberedClaim | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  const separator = value.indexOf(REMEMBERED_SEPARATOR);
  if (separator === -1) {
    return { rosterMemberId: value, claimId: null };
  }

  const rosterMemberId = value.slice(0, separator);
  const claimId = value.slice(separator + 1);
  return rosterMemberId ? { rosterMemberId, claimId: claimId || null } : null;
}

export function formatRememberedClaim(rosterMemberId: string, claimId: string) {
  return `${rosterMemberId}${REMEMBERED_SEPARATOR}${claimId}`;
}

/** Remembered member id when it is on this bracket's roster, whatever its claim state. */
export function rememberedRosterMemberId(bracket: BracketRecord, raw: string | null | undefined) {
  const remembered = parseRememberedClaim(raw);
  return remembered && bracket.rosterMembers.some((member) => member.id === remembered.rosterMemberId)
    ? remembered.rosterMemberId
    : null;
}

/** True when this cookie belongs to the name's current registration. */
export function isRememberedClaimCurrent(bracket: BracketRecord, raw: string | null | undefined) {
  const remembered = parseRememberedClaim(raw);
  if (!remembered || !rememberedRosterMemberId(bracket, raw)) {
    return false;
  }

  const current = bracket.memberClaims?.[remembered.rosterMemberId];
  if (current === undefined) {
    // Registered before claim ids existed: trust the member id, as before.
    return true;
  }

  return remembered.claimId !== null && remembered.claimId === current;
}

export function rosterMemberIdForBrowser(bracket: BracketRecord, browserToken: string) {
  ensureVoterBindings(bracket);
  return bracket.voterBindings![browserToken] ?? null;
}

export function browserTokenForRosterMember(bracket: BracketRecord, rosterMemberId: string) {
  ensureVoterBindings(bracket);
  for (const [token, memberId] of Object.entries(bracket.voterBindings!)) {
    if (memberId === rosterMemberId) {
      return token;
    }
  }

  return null;
}

export function isRosterMemberClaimed(bracket: BracketRecord, rosterMemberId: string) {
  return browserTokenForRosterMember(bracket, rosterMemberId) !== null;
}

export function findRosterMemberByName(bracket: BracketRecord, rosterMemberName: string) {
  const target = normalizeRosterName(rosterMemberName);
  return bracket.rosterMembers.find((member) => normalizeRosterName(member.name) === target) ?? null;
}

export function releaseRosterMemberBinding(bracket: BracketRecord, rosterMemberId: string) {
  ensureVoterBindings(bracket);
  for (const [token, memberId] of Object.entries(bracket.voterBindings!)) {
    if (memberId === rosterMemberId) {
      delete bracket.voterBindings![token];
    }
  }
}

export function bindBrowserToRosterMember(
  bracket: BracketRecord,
  browserToken: string,
  rosterMemberId: string,
  options?: { rebind?: boolean },
): { ok: true } | { ok: false; error: string } {
  ensureVoterBindings(bracket);

  const existingForBrowser = bracket.voterBindings![browserToken];
  if (existingForBrowser && existingForBrowser !== rosterMemberId) {
    const name =
      bracket.rosterMembers.find((member) => member.id === existingForBrowser)?.name ?? "someone else";
    return { ok: false, error: `This browser is already registered as ${name}.` };
  }

  const existingForMember = browserTokenForRosterMember(bracket, rosterMemberId);
  if (existingForMember && existingForMember !== browserToken) {
    if (!options?.rebind) {
      const name = bracket.rosterMembers.find((member) => member.id === rosterMemberId)?.name ?? "That name";
      return { ok: false, error: `${name} is already registered on another device.` };
    }

    delete bracket.voterBindings![existingForMember];
  }

  bracket.voterBindings![browserToken] = rosterMemberId;
  return { ok: true };
}

/**
 * Read-only check: would tryMigrateVoterBinding change anything for this
 * browser? Mirrors its early returns. Lets hot read paths skip the locked
 * read-modify-write transaction when (as on almost every poll) nothing changes.
 */
export function voterBindingNeedsMigration(
  bracket: BracketRecord,
  browserToken: string,
  remembered: string | null,
) {
  if (rosterMemberIdForBrowser(bracket, browserToken)) {
    return false;
  }

  return isRememberedClaimCurrent(bracket, remembered);
}

export function tryMigrateVoterBinding(
  bracket: BracketRecord,
  browserToken: string,
  remembered: string | null,
) {
  const existing = rosterMemberIdForBrowser(bracket, browserToken);
  if (existing) {
    return existing;
  }

  if (!isRememberedClaimCurrent(bracket, remembered)) {
    return null;
  }

  const rosterMemberId = parseRememberedClaim(remembered)!.rosterMemberId;
  const result = bindBrowserToRosterMember(bracket, browserToken, rosterMemberId, {
    rebind: true,
  });
  return result.ok ? rosterMemberId : null;
}
