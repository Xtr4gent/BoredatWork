import crypto from "node:crypto";

import { readSecret } from "@/lib/workquiz/secrets";
import type { EntrantInput } from "@/lib/workquiz/types";

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function hashValue(value: string) {
  const secret = readSecret("WORKQUIZ_SECRET");
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function isoDate(value: Date | string) {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

export function addHours(value: string | Date, hours: number) {
  const next = new Date(value);
  next.setHours(next.getHours() + hours);
  return next.toISOString();
}

export function nextPowerOfTwo(value: number) {
  let size = 1;
  while (size < value) {
    size *= 2;
  }
  return size;
}

export function buildSeedOrder(size: number) {
  let slots = [1, 2];
  while (slots.length < size) {
    const nextSize = slots.length * 2 + 1;
    slots = slots.flatMap((slot) => [slot, nextSize - slot]);
  }
  return slots;
}

export function shuffle<T>(items: T[]) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [next[index], next[swap]] = [next[swap], next[index]];
  }
  return next;
}

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

export function absoluteUrl(pathname: string) {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  return new URL(pathname, base).toString();
}
