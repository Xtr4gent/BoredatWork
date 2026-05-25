"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { BracketKind, BracketSnapshot, EntrantInput, SeedingMode } from "@/lib/workquiz/types";
import { parseContendersFromText, parseEntrantsFromText } from "@/lib/workquiz/utils";

const LAST_ROSTER_STORAGE_KEY = "workquiz:last-admin-roster";
const LAST_TITLE_STORAGE_KEY = "workquiz:last-admin-title";
const LAST_ENTRANTS_STORAGE_KEY = "workquiz:last-admin-entrants";
const DEFAULT_TITLE = "Best Chocolate Snack";
const DEFAULT_ENTRANTS = [
  "Snickers",
  "Kit Kat",
  "Twix",
  "Reese's Peanut Butter Cups",
  "Hershey's Milk Chocolate",
  "Cadbury Dairy Milk",
  "Kinder Bueno",
  "Crunch",
  "Oh Henry!",
  "Coffee Crisp",
  "Mars",
  "Crunchie",
  "Aero",
  "Caramilk",
  "Skor",
  "Wunderbar",
  "Mr. Big",
  "Hershey's cookies and creme",
].join("\n");
const DEFAULT_ROSTER = "Gabe\nAlex\nJordan\nSam\nPriya\nMaya\nLuca\nTaylor";

function toLocalDateTimeValue(date: Date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return offsetDate.toISOString().slice(0, 16);
}

function toLocalDateValue(date: Date) {
  return toLocalDateTimeValue(date).slice(0, 10);
}

function getNextSixAmRoundStart() {
  const now = new Date();
  const nextStart = new Date(now);
  nextStart.setHours(6, 0, 0, 0);

  if (nextStart.getTime() <= now.getTime()) {
    nextStart.setDate(nextStart.getDate() + 1);
  }

  return nextStart;
}

function getSameDayEightPm(date: Date) {
  const end = new Date(date);
  end.setHours(20, 0, 0, 0);
  return end;
}

function getRoundWindowForLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }

  const start = new Date(year, month - 1, day, 6, 0, 0, 0);
  const end = new Date(year, month - 1, day, 20, 0, 0, 0);

  return {
    startsAt: toLocalDateTimeValue(start),
    endsAt: toLocalDateTimeValue(end),
  };
}

function moveContenders<T>(items: T[], from: number, to: number) {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function shufflePreview<T>(items: T[]) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [next[index], next[swap]] = [next[swap], next[index]];
  }
  return next;
}

function contenderName(contender: EntrantInput) {
  return typeof contender === "string" ? contender : contender.name;
}

function contenderImageUrl(contender: EntrantInput) {
  return typeof contender === "string" ? undefined : contender.imageUrl;
}

function contenderLine(contender: EntrantInput) {
  const name = contenderName(contender);
  const imageUrl = contenderImageUrl(contender);
  return imageUrl ? `${name} | ${imageUrl}` : name;
}

type PhotoSuggestion = {
  name: string;
  status: "found" | "not_found" | "error";
  imageUrl?: string;
  thumbnailUrl?: string;
  sourcePageUrl?: string;
  confidence: number;
  reason: string;
};

export function CreateBracketForm({
  initialTemplate,
  variant = "setup",
}: {
  initialTemplate?: {
    title: string;
    entrants: EntrantInput[];
    rosterMembers: string[];
    seedingMode: SeedingMode;
    sourceTitle?: string;
  } | null;
  variant?: "setup" | "admin";
}) {
  const router = useRouter();
  const defaultRoundStart = useMemo(() => getNextSixAmRoundStart(), []);
  const [title, setTitle] = useState(initialTemplate?.title ?? DEFAULT_TITLE);
  const [entrantsText, setEntrantsText] = useState(
    initialTemplate?.entrants.map(contenderLine).join("\n") ?? DEFAULT_ENTRANTS,
  );
  const [rosterText, setRosterText] = useState(
    initialTemplate?.rosterMembers.join("\n") ?? DEFAULT_ROSTER,
  );
  const [seedingMode, setSeedingMode] = useState<SeedingMode>(initialTemplate?.seedingMode ?? "manual");
  const [roundDate, setRoundDate] = useState(() => toLocalDateValue(defaultRoundStart));
  const [startsAt, setStartsAt] = useState(() => toLocalDateTimeValue(defaultRoundStart));
  const [endsAt, setEndsAt] = useState(() => toLocalDateTimeValue(getSameDayEightPm(defaultRoundStart)));
  const [previewSeededEntrants, setPreviewSeededEntrants] = useState<EntrantInput[]>(() =>
    initialTemplate?.seedingMode === "random"
      ? shufflePreview(initialTemplate.entrants)
      : initialTemplate?.entrants ?? parseContendersFromText(entrantsText),
  );
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<BracketSnapshot | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isStorageReady, setIsStorageReady] = useState(Boolean(initialTemplate));
  const [isPhotoLookupLoading, setIsPhotoLookupLoading] = useState(false);
  const [photoLookupError, setPhotoLookupError] = useState<string | null>(null);
  const [photoSuggestions, setPhotoSuggestions] = useState<PhotoSuggestion[]>([]);
  const [showPhotoReview, setShowPhotoReview] = useState(false);

  const contenderParse = useMemo(() => {
    try {
      return { entrants: parseContendersFromText(entrantsText), error: null };
    } catch (error) {
      return {
        entrants: [] as EntrantInput[],
        error: error instanceof Error ? error.message : "Invalid contender list.",
      };
    }
  }, [entrantsText]);
  const entrants = contenderParse.entrants;
  const rosterMembers = useMemo(() => parseEntrantsFromText(rosterText), [rosterText]);
  const previewIsValid = useMemo(() => {
    const startsAtIso = new Date(startsAt).toISOString();
    const endsAtIso = new Date(endsAt).toISOString();

    return (
      !!title.trim() &&
      !contenderParse.error &&
      entrants.length >= 2 &&
      rosterMembers.length >= 2 &&
      !Number.isNaN(new Date(startsAtIso).getTime()) &&
      !Number.isNaN(new Date(endsAtIso).getTime()) &&
      new Date(endsAtIso).getTime() > new Date(startsAtIso).getTime() &&
      new Set(rosterMembers.map((member) => member.toLowerCase())).size === rosterMembers.length
    );
  }, [contenderParse.error, endsAt, entrants.length, rosterMembers, startsAt, title]);

  useEffect(() => {
    if (variant === "admin") {
      return;
    }

    if (!previewIsValid) {
      return;
    }

    const startsAtIso = new Date(startsAt).toISOString();
    const endsAtIso = new Date(endsAt).toISOString();

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setIsPreviewLoading(true);
      const response = await fetch("/api/brackets/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          entrants,
          rosterMembers,
          seededEntrants: previewSeededEntrants,
          seedingMode,
          startsAt: startsAtIso,
          endsAt: endsAtIso,
        }),
        signal: controller.signal,
      }).catch(() => null);

      if (!response) {
        setIsPreviewLoading(false);
        return;
      }

      const result = (await response.json()) as BracketSnapshot & { error?: string };
      if (!response.ok) {
        setPreviewSnapshot(null);
        setPreviewError(result.error ?? "Could not render the preview yet.");
        setIsPreviewLoading(false);
        return;
      }

      setPreviewSnapshot(result);
      setPreviewError(null);
      setIsPreviewLoading(false);
    }, 150);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [endsAt, entrants, previewIsValid, previewSeededEntrants, rosterMembers, seedingMode, startsAt, title, variant]);

  useEffect(() => {
    if (initialTemplate) {
      return;
    }

    const rememberedTitle = window.localStorage.getItem(LAST_TITLE_STORAGE_KEY);
    const rememberedEntrants = window.localStorage.getItem(LAST_ENTRANTS_STORAGE_KEY);
    const rememberedRoster = window.localStorage.getItem(LAST_ROSTER_STORAGE_KEY);
    const timeout = window.setTimeout(() => {
      if (rememberedTitle?.trim()) {
        setTitle(rememberedTitle);
      }

      if (rememberedEntrants?.trim()) {
        try {
          const nextEntrants = parseContendersFromText(rememberedEntrants);
          setEntrantsText(rememberedEntrants);
          setPreviewSeededEntrants(nextEntrants);
        } catch {
          window.localStorage.removeItem(LAST_ENTRANTS_STORAGE_KEY);
        }
      }

      if (rememberedRoster?.trim()) {
        setRosterText(rememberedRoster);
      }
      setIsStorageReady(true);
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [initialTemplate]);

  useEffect(() => {
    if (!isStorageReady) {
      return;
    }

    window.localStorage.setItem(LAST_TITLE_STORAGE_KEY, title);
    window.localStorage.setItem(LAST_ENTRANTS_STORAGE_KEY, entrantsText);
    window.localStorage.setItem(LAST_ROSTER_STORAGE_KEY, rosterText);
  }, [entrantsText, isStorageReady, rosterText, title]);

  function updateEntrants(next: EntrantInput[]) {
    setEntrantsText(next.map(contenderLine).join("\n"));
    setPreviewSeededEntrants(seedingMode === "random" ? shufflePreview(next) : next);
    setPhotoLookupError(null);
    setShowPhotoReview(false);
    setPhotoSuggestions([]);
  }

  function reshufflePreview() {
    setPreviewSeededEntrants(shufflePreview(entrants));
  }

  function handleEntrantsTextChange(value: string) {
    setEntrantsText(value);
    setPhotoLookupError(null);
    setShowPhotoReview(false);
    setPhotoSuggestions([]);
    try {
      const nextEntrants = parseContendersFromText(value);
      setPreviewSeededEntrants(seedingMode === "random" ? shufflePreview(nextEntrants) : nextEntrants);
    } catch {
      setPreviewSeededEntrants([]);
    }
  }

  function handleRosterTextChange(value: string) {
    setRosterText(value);
  }

  function handleSeedingModeChange(nextMode: SeedingMode) {
    setSeedingMode(nextMode);
    setPreviewSeededEntrants(nextMode === "random" ? shufflePreview(entrants) : entrants);
  }

  function handleRoundDateChange(value: string) {
    const nextWindow = getRoundWindowForLocalDate(value);
    setRoundDate(value);
    if (!nextWindow) {
      return;
    }

    setStartsAt(nextWindow.startsAt);
    setEndsAt(nextWindow.endsAt);
  }

  async function handleSubmit(formData: FormData) {
    setError(null);
    const kind: BracketKind = formData.get("kind") === "test" ? "test" : "public";
    const payload = {
      title: String(formData.get("title") ?? ""),
      kind,
      entrants,
      rosterMembers,
      seededEntrants: previewSeededEntrants,
      seedingMode,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
    };

    if (new Date(payload.endsAt).getTime() <= new Date(payload.startsAt).getTime()) {
      setError("Round one end time must be later than the start time.");
      return;
    }

    if (payload.rosterMembers.length < 2) {
      setError("Add at least two roster members.");
      return;
    }

    if (new Set(payload.rosterMembers.map((member) => member.toLowerCase())).size !== payload.rosterMembers.length) {
      setError("Roster names must be unique.");
      return;
    }

    startTransition(async () => {
      const response = await fetch("/api/brackets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string; adminUrl?: string };

      if (!response.ok || !result.adminUrl) {
        setError(result.error ?? "Could not create the bracket.");
        return;
      }

      window.localStorage.setItem(LAST_TITLE_STORAGE_KEY, title);
      window.localStorage.setItem(LAST_ENTRANTS_STORAGE_KEY, entrantsText);
      window.localStorage.setItem(LAST_ROSTER_STORAGE_KEY, rosterText);
      router.push(result.adminUrl);
    });
  }

  async function handlePhotoLookup() {
    const missingImageEntrants = entrants
      .map((entrant, index) => ({ entrant, index }))
      .filter(({ entrant }) => !contenderImageUrl(entrant));

    if (!missingImageEntrants.length) {
      setPhotoLookupError("Every contender already has an image URL.");
      setShowPhotoReview(false);
      setPhotoSuggestions([]);
      return;
    }

    setIsPhotoLookupLoading(true);
    setPhotoLookupError(null);
    const response = await fetch("/api/images/wikimedia-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        names: missingImageEntrants.map(({ entrant }) => contenderName(entrant)),
      }),
    }).catch(() => null);

    if (!response) {
      setIsPhotoLookupLoading(false);
      setPhotoLookupError("Could not reach Wikimedia suggestions. Try again.");
      return;
    }

    const result = (await response.json()) as { error?: string; suggestions?: PhotoSuggestion[] };
    if (!response.ok || !Array.isArray(result.suggestions)) {
      setIsPhotoLookupLoading(false);
      setPhotoLookupError(result.error ?? "Could not fetch photo suggestions.");
      return;
    }

    setPhotoSuggestions(result.suggestions);
    setShowPhotoReview(true);
    setIsPhotoLookupLoading(false);
  }

  function applyPhotoSuggestions() {
    if (!photoSuggestions.length) {
      return;
    }

    const missingImageIndexes = entrants
      .map((entrant, index) => ({ entrant, index }))
      .filter(({ entrant }) => !contenderImageUrl(entrant))
      .map(({ index }) => index);

    const imageByEntrantIndex = new Map<number, string>();
    photoSuggestions.forEach((suggestion, suggestionIndex) => {
      const entrantIndex = missingImageIndexes[suggestionIndex];
      if (
        typeof entrantIndex === "number" &&
        suggestion.status === "found" &&
        typeof suggestion.imageUrl === "string" &&
        suggestion.imageUrl
      ) {
        imageByEntrantIndex.set(entrantIndex, suggestion.imageUrl);
      }
    });

    const nextEntrants = entrants.map((entrant, entrantIndex) => {
      const existingImage = contenderImageUrl(entrant);
      if (existingImage) {
        return entrant;
      }

      const suggestedImageUrl = imageByEntrantIndex.get(entrantIndex);
      if (!suggestedImageUrl) {
        return entrant;
      }

      return {
        name: contenderName(entrant),
        imageUrl: suggestedImageUrl,
      } satisfies EntrantInput;
    });

    updateEntrants(nextEntrants);
    setShowPhotoReview(false);
    setPhotoSuggestions([]);
  }

  const foundPhotoSuggestions = photoSuggestions.filter((suggestion) => suggestion.status === "found");

  if (variant === "admin") {
    return (
      <form action={handleSubmit} className="bw-create-form">
        <div className="bw-card">
          <div className="bw-card-title">Tournament Details</div>
          <label className="bw-field">
            <span>Topic</span>
            <input
              name="title"
              placeholder="e.g. Best 90s Movie, Greatest Snack, Worst Meeting Habit..."
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <small>Keep it spicy. Boring topics get boring votes.</small>
          </label>
          <div className="bw-field-row">
            <label className="bw-field">
              <span>First round date</span>
              <input
                type="date"
                value={roundDate}
                onChange={(event) => handleRoundDateChange(event.target.value)}
              />
              <small>Round one opens at 6:00 AM and closes at 8:00 PM.</small>
            </label>
            <div className="bw-field">
              <span>Seeding</span>
              <div className="bw-seed-mode">
                <button
                  className={seedingMode === "manual" ? "bw-time-btn sel" : "bw-time-btn"}
                  onClick={() => handleSeedingModeChange("manual")}
                  type="button"
                >
                  Manual
                </button>
                <button
                  className={seedingMode === "random" ? "bw-time-btn sel" : "bw-time-btn"}
                  onClick={() => handleSeedingModeChange("random")}
                  type="button"
                >
                  Random
                </button>
                {seedingMode === "random" ? (
                  <button className="bw-time-btn" onClick={reshufflePreview} type="button">
                    Reshuffle
                  </button>
                ) : null}
              </div>
              <small>Manual preserves list order. Random uses the preview order.</small>
            </div>
          </div>
          <input name="startsAt" type="hidden" value={startsAt} />
          <input name="endsAt" type="hidden" value={endsAt} />
        </div>

        <div className="bw-card">
          <div className="bw-card-title">Contenders</div>
          <label className="bw-field">
            <span>Paste your list</span>
            <textarea
              placeholder={"One per line, or Name | https://image-url"}
              rows={10}
              value={entrantsText}
              onChange={(event) => handleEntrantsTextChange(event.target.value)}
            />
            <small>
              {entrants.length} contender{entrants.length === 1 ? "" : "s"} ready. Add optional pictures with{" "}
              <code>Name | https://image-url</code>.
            </small>
          </label>
          <div className="bw-photo-lookup-actions">
            <button className="bw-time-btn" disabled={isPhotoLookupLoading || !!contenderParse.error} onClick={handlePhotoLookup} type="button">
              {isPhotoLookupLoading ? "Finding photos..." : "Auto-find photos (Wikimedia)"}
            </button>
            {showPhotoReview && foundPhotoSuggestions.length ? (
              <button className="bw-time-btn sel" onClick={applyPhotoSuggestions} type="button">
                Apply {foundPhotoSuggestions.length} suggestion{foundPhotoSuggestions.length === 1 ? "" : "s"}
              </button>
            ) : null}
          </div>
          {photoLookupError ? <p className="bw-error-text">{photoLookupError}</p> : null}
          {showPhotoReview ? (
            <div className="bw-photo-lookup-panel">
              <div className="bw-photo-lookup-header">
                <span className="bw-card-label">Photo suggestions</span>
                <strong>{foundPhotoSuggestions.length} found</strong>
              </div>
              <div className="bw-photo-lookup-list">
                {photoSuggestions.map((suggestion, index) => (
                  <div className="bw-photo-lookup-item" key={`${suggestion.name}-${index}`}>
                    <div>
                      <strong>{suggestion.name}</strong>
                      <small>{suggestion.reason}</small>
                    </div>
                    {suggestion.status === "found" && suggestion.imageUrl ? (
                      <a href={suggestion.sourcePageUrl ?? suggestion.imageUrl} rel="noreferrer" target="_blank">
                        Preview
                      </a>
                    ) : (
                      <span>{suggestion.status === "error" ? "Error" : "No match"}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {contenderParse.error ? <p className="bw-error-text">{contenderParse.error}</p> : null}
          {entrants.length ? (
            <div className="bw-contender-preview">
              <span className="bw-card-label">Preview</span>
              <div className="bw-contender-chips">
                {entrants.slice(0, 32).map((entrant, index) => (
                  <span className="bw-contender-chip" key={`${contenderName(entrant)}-${index}`}>
                    {contenderName(entrant)}
                    {contenderImageUrl(entrant) ? <span className="bw-contender-chip-media">image</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {seedingMode === "manual" && entrants.length > 1 ? (
          <div className="bw-card">
            <div className="bw-card-title">Seed Preview</div>
            <div className="bw-seed-list">
              {entrants.map((entrant, index) => (
                <div className="bw-seed-item" key={`${contenderName(entrant)}-${index}`}>
                  <strong>#{index + 1}</strong>
                  <span>{contenderName(entrant)}</span>
                  <div className="bw-seed-actions">
                    <button
                      disabled={index === 0}
                      onClick={() => updateEntrants(moveContenders(entrants, index, Math.max(0, index - 1)))}
                      type="button"
                    >
                      Up
                    </button>
                    <button
                      disabled={index === entrants.length - 1}
                      onClick={() =>
                        updateEntrants(moveContenders(entrants, index, Math.min(entrants.length - 1, index + 1)))
                      }
                      type="button"
                    >
                      Down
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="bw-card">
          <div className="bw-card-title">Roster</div>
          <label className="bw-field">
            <span>Participants, one per line</span>
            <textarea
              placeholder={"Alex\nSam\nJordan\nTaylor"}
              rows={8}
              value={rosterText}
              onChange={(event) => handleRosterTextChange(event.target.value)}
            />
            <small>These are the people who can vote. Only names on this list get a vote.</small>
          </label>
        </div>

        {error ? <p className="bw-error-text">{error}</p> : null}

        <div className="bw-btn-row">
          <button
            className="bw-btn bw-btn-lime bw-launch-button"
            disabled={isPending}
            name="kind"
            type="submit"
            value="public"
          >
            {isPending ? "Creating tournament..." : "Launch Tournament →"}
          </button>
          <button className="bw-btn bw-btn-outline" disabled={isPending} name="kind" type="submit" value="test">
            {isPending ? "Creating test..." : "Create Test Bracket"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form action={handleSubmit} className="panel stack-lg">
      <div className="stack-sm">
        <span className="eyebrow">Start A Bracket</span>
        <h2>Make the next office showdown in under ten minutes.</h2>
        <p className="muted">
          Paste the entrants, set the first round day, and preview the full board before
          anything goes live. Each round runs from 6:00 AM to 8:00 PM, then the next
          round opens the next day.
        </p>
        {initialTemplate?.sourceTitle ? (
          <p className="muted">Loaded from previous topic: {initialTemplate.sourceTitle}</p>
        ) : null}
      </div>

      <label className="field">
        <span>Bracket title</span>
        <input name="title" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>

      <label className="field">
        <span>First round date</span>
        <input
          type="date"
          value={roundDate}
          onChange={(event) => handleRoundDateChange(event.target.value)}
        />
        <span className="muted">Round one opens at 6:00 AM and closes at 8:00 PM.</span>
      </label>
      <input name="startsAt" type="hidden" value={startsAt} />
      <input name="endsAt" type="hidden" value={endsAt} />

      <label className="field">
        <span>Entrants, one per line</span>
        <textarea
          rows={10}
          value={entrantsText}
          onChange={(event) => handleEntrantsTextChange(event.target.value)}
        />
        <span className="muted">Add optional pictures with `Name | https://image-url`.</span>
      </label>
      <div className="photo-lookup-actions">
        <button className="pill" disabled={isPhotoLookupLoading || !!contenderParse.error} onClick={handlePhotoLookup} type="button">
          {isPhotoLookupLoading ? "Finding photos..." : "Auto-find photos (Wikimedia)"}
        </button>
        {showPhotoReview && foundPhotoSuggestions.length ? (
          <button className="pill active" onClick={applyPhotoSuggestions} type="button">
            Apply {foundPhotoSuggestions.length} suggestion{foundPhotoSuggestions.length === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>
      {photoLookupError ? <p className="error-text">{photoLookupError}</p> : null}
      {showPhotoReview ? (
        <section className="photo-lookup-panel stack-sm">
          <div className="inline-row">
            <span className="eyebrow">Photo Suggestions</span>
            <strong>{foundPhotoSuggestions.length} found</strong>
          </div>
          <div className="photo-lookup-list">
            {photoSuggestions.map((suggestion, index) => (
              <article className="photo-lookup-item" key={`${suggestion.name}-${index}`}>
                <div className="stack-sm">
                  <strong>{suggestion.name}</strong>
                  <span className="muted">
                    {suggestion.reason}
                    {suggestion.status === "found" ? ` • confidence ${(suggestion.confidence * 100).toFixed(0)}%` : ""}
                  </span>
                </div>
                {suggestion.status === "found" && suggestion.imageUrl ? (
                  <a href={suggestion.sourcePageUrl ?? suggestion.imageUrl} rel="noreferrer" target="_blank">
                    Preview
                  </a>
                ) : (
                  <span className="muted">{suggestion.status === "error" ? "Error" : "No match"}</span>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {contenderParse.error ? <p className="error-text">{contenderParse.error}</p> : null}

      <label className="field">
        <span>Team roster, one person per line</span>
        <textarea
          rows={8}
          value={rosterText}
          onChange={(event) => handleRosterTextChange(event.target.value)}
        />
        <span className="muted">We&apos;ll remember this roster on this browser for next time.</span>
      </label>

      <div className="seed-mode">
        <button
          className={seedingMode === "manual" ? "pill active" : "pill"}
          onClick={() => handleSeedingModeChange("manual")}
          type="button"
        >
          Manual seeding
        </button>
        <button
          className={seedingMode === "random" ? "pill active" : "pill"}
          onClick={() => handleSeedingModeChange("random")}
          type="button"
        >
          Random draw
        </button>
        {seedingMode === "random" ? (
          <button className="pill" onClick={reshufflePreview} type="button">
            Reshuffle preview
          </button>
        ) : null}
      </div>

      {seedingMode === "manual" ? (
        <div className="stack-sm">
          <div className="inline-row">
            <h3>Seed preview</h3>
            <span className="muted">Up and down is enough for V1. Fast beats fancy.</span>
          </div>
          <div className="seed-list">
            {entrants.map((entrant, index) => (
              <div className="seed-item" key={`${contenderName(entrant)}-${index}`}>
                <strong>#{index + 1}</strong>
                <span>{contenderName(entrant)}</span>
                <div className="seed-actions">
                  <button
                    disabled={index === 0}
                    onClick={() => updateEntrants(moveContenders(entrants, index, Math.max(0, index - 1)))}
                    type="button"
                  >
                    Up
                  </button>
                  <button
                    disabled={index === entrants.length - 1}
                    onClick={() =>
                      updateEntrants(moveContenders(entrants, index, Math.min(entrants.length - 1, index + 1)))
                    }
                    type="button"
                  >
                    Down
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <section className="preview-panel stack-sm">
        <div className="inline-row">
          <div className="stack-sm">
            <span className="eyebrow">Live Preview</span>
            <h3>Check the full bracket before you create it.</h3>
          </div>
          {isPreviewLoading ? <span className="muted">Updating preview...</span> : null}
        </div>

        {previewIsValid && previewError ? <p className="error-text">{previewError}</p> : null}

        {previewIsValid && previewSnapshot ? (
          <div className="stack-md">
            <div className="preview-summary">
              <strong>{previewSnapshot.title}</strong>
              <span className="muted">
                {previewSnapshot.rosterMembers.length} players, {previewSnapshot.rounds.length} rounds
              </span>
            </div>
            <div className="round-grid">
              {previewSnapshot.rounds.map((round) => (
                <article className="round-panel" key={round.id}>
                  <div className="round-title">
                    <div>
                      <span className="eyebrow">Stage {round.number}</span>
                      <h2>{round.label}</h2>
                    </div>
                  </div>
                  <div className="matchup-list">
                    {round.matchups.map((matchup) => (
                      <div className="matchup-card" key={matchup.id}>
                        <div className="entrant-button preview-entrant">
                          <span>
                            {matchup.entrantA
                              ? `#${matchup.entrantA.seed} ${matchup.entrantA.name}`
                              : "BYE"}
                          </span>
                        </div>
                        <div className="entrant-button preview-entrant">
                          <span>
                            {matchup.entrantB
                              ? `#${matchup.entrantB.seed} ${matchup.entrantB.name}`
                              : "BYE"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <p className="muted">
            Add a title, at least two entrants, a unique team roster, and valid round timing to
            see the full bracket preview.
          </p>
        )}
      </section>

      {error ? <p className="error-text">{error}</p> : null}

      <button className="primary-button" disabled={isPending} name="kind" type="submit" value="public">
        {isPending ? "Creating bracket..." : "Create bracket"}
      </button>
    </form>
  );
}
