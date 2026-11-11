import type { EntrantInput } from "@/lib/workquiz/types";

/**
 * Turning pasted text into contender and player lists. Kept apart from
 * utils.ts on purpose: the create form runs this in the browser, and utils.ts
 * pulls in server-only crypto, which the bundler would otherwise ship to the
 * browser as a large polyfill.
 */
export function parseEntrantsFromText(value: string) {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateImageUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid image URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URLs must start with http:// or https://.");
  }

  return url.toString();
}

export function normalizeContenderInput(input: EntrantInput) {
  const rawName = typeof input === "string" ? input : input.name;
  const name = rawName.trim();
  if (!name) {
    throw new Error("Every contender needs a name.");
  }

  const rawImageUrl = typeof input === "string" ? undefined : input.imageUrl?.trim();
  return {
    name,
    imageUrl: rawImageUrl ? validateImageUrl(rawImageUrl) : undefined,
  };
}

export function normalizeContenderInputs(inputs: EntrantInput[]) {
  return inputs.map(normalizeContenderInput);
}

export function parseContendersFromText(value: string) {
  return parseEntrantsFromText(value).map((line) => {
    const separatorIndex = line.indexOf("|");
    if (separatorIndex === -1) {
      return normalizeContenderInput(line);
    }

    const name = line.slice(0, separatorIndex);
    const imageUrl = line.slice(separatorIndex + 1);
    return normalizeContenderInput({ name, imageUrl });
  });
}
