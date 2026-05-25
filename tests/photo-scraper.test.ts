import assert from "node:assert/strict";
import test from "node:test";

import { scoreWikimediaTitleMatch, suggestEntrantPhotos } from "@/lib/workquiz/photo-scraper";

test("scoreWikimediaTitleMatch prefers file titles containing full entrant name", () => {
  const high = scoreWikimediaTitleMatch("Taylor Swift", "File:Taylor Swift at concert.jpg");
  const low = scoreWikimediaTitleMatch("Taylor Swift", "File:Concert crowd.jpg");

  assert.ok(high > low);
  assert.ok(high >= 0.9);
});

test("suggestEntrantPhotos returns found suggestion when Wikimedia returns image pages", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Taylor Swift portrait.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/taylor.jpg",
                  thumburl: "https://upload.wikimedia.org/taylor-thumb.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Taylor_Swift_portrait.jpg",
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const [result] = await suggestEntrantPhotos(["Taylor Swift Wikimedia"], { fetchImpl: fakeFetch, serperApiKey: null });
  assert.equal(result.status, "found");
  assert.equal(result.imageUrl, "https://upload.wikimedia.org/taylor.jpg");
  assert.ok(result.confidence > 0.3);
});

test("suggestEntrantPhotos returns not_found when Wikimedia has no matching pages", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ query: { pages: {} } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const [result] = await suggestEntrantPhotos(["Definitely Not A Real Person"], { fetchImpl: fakeFetch, serperApiKey: null });
  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "No Wikimedia image match found.");
});

test("suggestEntrantPhotos prefers Serper results when API key is configured", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("google.serper.dev")) {
      return new Response(
        JSON.stringify({
          images: [
            {
              imageUrl: "https://images.example.com/taylor-serper.jpg",
              thumbnailUrl: "https://images.example.com/taylor-serper-thumb.jpg",
              title: "Taylor Swift live photo",
              source: "Billboard",
              link: "https://billboard.example.com/taylor",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ query: { pages: {} } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const [result] = await suggestEntrantPhotos(["Taylor Swift Serper"], {
    fetchImpl: fakeFetch,
    serperApiKey: "test-key",
  });
  assert.equal(result.status, "found");
  assert.equal(result.imageUrl, "https://images.example.com/taylor-serper.jpg");
  assert.match(result.reason, /Google match/);
});

test("suggestEntrantPhotos falls back to Wikimedia when Serper has no images", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("google.serper.dev")) {
      return new Response(JSON.stringify({ images: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Taylor Swift fallback.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/taylor-fallback.jpg",
                  thumburl: "https://upload.wikimedia.org/taylor-fallback-thumb.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Taylor_Swift_fallback.jpg",
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const [result] = await suggestEntrantPhotos(["Taylor Swift Fallback"], {
    fetchImpl: fakeFetch,
    serperApiKey: "test-key",
  });
  assert.equal(result.status, "found");
  assert.equal(result.imageUrl, "https://upload.wikimedia.org/taylor-fallback.jpg");
});

test("suggestEntrantPhotos falls back when Serper match confidence is too low", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("google.serper.dev")) {
      return new Response(
        JSON.stringify({
          images: [
            {
              imageUrl: "https://images.example.com/wrong-photo.jpg",
              title: "Cute Golden Retriever Puppy",
              source: "Pet Gallery",
              link: "https://pets.example.com/puppy",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Taylor Swift fallback.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/taylor-fallback.jpg",
                  thumburl: "https://upload.wikimedia.org/taylor-fallback-thumb.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Taylor_Swift_fallback.jpg",
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const [result] = await suggestEntrantPhotos(["Taylor Swift"], {
    fetchImpl: fakeFetch,
    serperApiKey: "test-key",
  });
  assert.equal(result.status, "found");
  assert.equal(result.imageUrl, "https://upload.wikimedia.org/taylor-fallback.jpg");
});

test("suggestEntrantPhotos rejects junk Serper title hints and falls back", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("google.serper.dev")) {
      return new Response(
        JSON.stringify({
          images: [
            {
              imageUrl: "https://images.example.com/taylor-wallpaper.jpg",
              title: "Taylor Swift wallpaper 4k",
              source: "Wallpaper Hub",
              link: "https://wallpapers.example.com/taylor",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Taylor Swift Filtered fallback.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/taylor-filtered-fallback.jpg",
                  thumburl: "https://upload.wikimedia.org/taylor-filtered-fallback-thumb.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Taylor_Swift_fallback.jpg",
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const [result] = await suggestEntrantPhotos(["Taylor Swift Filtered"], {
    fetchImpl: fakeFetch,
    serperApiKey: "test-key",
  });
  assert.equal(result.status, "found");
  assert.equal(result.imageUrl, "https://upload.wikimedia.org/taylor-filtered-fallback.jpg");
});
