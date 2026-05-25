import assert from "node:assert/strict";
import test from "node:test";

import { POST as suggestRoute } from "@/app/api/images/wikimedia-suggest/route";

test("wikimedia suggest route rejects invalid names payload", async () => {
  const response = await suggestRoute(
    new Request("http://localhost/api/images/wikimedia-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: "not-an-array" }),
    }),
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.equal(payload.error, "Names must be an array.");
});

test("wikimedia suggest route returns per-name suggestions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Alice Example.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/alice.jpg",
                  thumburl: "https://upload.wikimedia.org/alice-thumb.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Alice_Example.jpg",
                },
              ],
            },
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const response = await suggestRoute(
      new Request("http://localhost/api/images/wikimedia-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: ["Alice Example"] }),
      }),
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      suggestions: Array<{ status: string; imageUrl?: string }>;
    };
    assert.equal(payload.suggestions.length, 1);
    assert.equal(payload.suggestions[0].status, "found");
    assert.equal(payload.suggestions[0].imageUrl, "https://upload.wikimedia.org/alice.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wikimedia suggest route accepts retry options", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Bob Example.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/bob.jpg",
                  thumburl: "https://upload.wikimedia.org/bob-thumb.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Bob_Example.jpg",
                },
              ],
            },
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const response = await suggestRoute(
      new Request("http://localhost/api/images/wikimedia-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          names: ["Bob Example"],
          skipCache: true,
          searchVariant: "alt",
        }),
      }),
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      suggestions: Array<{ status: string; imageUrl?: string }>;
    };
    assert.equal(payload.suggestions.length, 1);
    assert.equal(payload.suggestions[0].status, "found");
    assert.equal(payload.suggestions[0].imageUrl, "https://upload.wikimedia.org/bob.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
