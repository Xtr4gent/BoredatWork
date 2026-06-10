import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

/**
 * JSON response with an ETag. When the client sends a matching If-None-Match
 * header, returns an empty 304 instead of re-sending the full payload, which
 * keeps repeat polls from re-downloading identical snapshots.
 */
export function jsonWithETag(request: Request, payload: unknown, init?: ResponseInit) {
  const body = JSON.stringify(payload);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = new Headers(init?.headers);
  headers.set("ETag", etag);
  headers.set("Cache-Control", "no-cache");

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  headers.set("Content-Type", "application/json");
  return new NextResponse(body, { status: init?.status ?? 200, headers });
}
