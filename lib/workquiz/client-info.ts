import type { VoterClientInfo } from "@/lib/workquiz/types";
import { hashValue } from "@/lib/workquiz/utils";

/** Header the voting page sends with a coarse, client-computed device hint. */
export const DEVICE_HINT_HEADER = "x-workquiz-device";

const MAX_DEVICE_HINT_LENGTH = 512;

function shortHash(kind: string, value: string) {
  return hashValue(`${kind}:${value}`).slice(0, 10);
}

/** Same browser cookie always yields the same id; the raw token is never stored. */
export function browserIdForToken(browserToken: string) {
  return shortHash("browser", browserToken);
}

function clientIp(headers: Headers) {
  // The public hostname sits behind Cloudflare, which sets cf-connecting-ip.
  // Railway's own proxy sets x-forwarded-for / x-real-ip.
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",")[0],
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

export function summariseUserAgent(userAgent: string | null) {
  if (!userAgent) {
    return null;
  }

  const browser = /Edg(e|A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Other browser";

  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /CrOS/.test(userAgent)
            ? "ChromeOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "Other OS";

  return `${browser} on ${os}`;
}

export function getClientInfo(request: Request, browserToken: string): VoterClientInfo {
  const ip = clientIp(request.headers);
  const deviceHint = request.headers.get(DEVICE_HINT_HEADER)?.slice(0, MAX_DEVICE_HINT_LENGTH).trim();

  return {
    browserId: browserIdForToken(browserToken),
    network: ip ? shortHash("network", ip) : null,
    device: deviceHint ? shortHash("device", deviceHint) : null,
    agent: summariseUserAgent(request.headers.get("user-agent")),
  };
}
