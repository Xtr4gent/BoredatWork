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

  const [result] = await suggestEntrantPhotos(["Taylor Swift"], { fetchImpl: fakeFetch });
  assert.equal(result.status, "found");
  assert.equal(result.imageUrl, "https://upload.wikimedia.org/taylor.jpg");
  assert.ok(result.confidence > 0.7);
});

test("suggestEntrantPhotos returns not_found when Wikimedia has no matching pages", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ query: { pages: {} } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const [result] = await suggestEntrantPhotos(["Definitely Not A Real Person"], { fetchImpl: fakeFetch });
  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "No Wikimedia image match found.");
});
