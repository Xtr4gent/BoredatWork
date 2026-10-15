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

const CREATE_STEPS = ["Details", "Contenders", "Players", "Review"];

/** "Mon, Oct 19" for a yyyy-mm-dd value; noon avoids any time-zone day shift. */
function formatRoundDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** yyyy-mm-dd plus whole days, without going through the local clock. */
function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "6:00 AM" from a yyyy-mm-ddThh:mm local value, read as written (no time-zone conversion). */
function formatClock(value: string) {
  const match = /T(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const hours = Number(match[1]);
  return `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]} ${hours < 12 ? "AM" : "PM"}`;
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

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
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
}: {
  initialTemplate?: {
    title: string;
    entrants: EntrantInput[];
    rosterMembers: string[];
    seedingMode: SeedingMode;
    sourceTitle?: string;
  } | null;
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
  const [showAppliedPhotoPreview, setShowAppliedPhotoPreview] = useState(false);
  const [manualPhotoUrlByName, setManualPhotoUrlByName] = useState<Record<string, string>>({});
  const [refreshingSuggestionByName, setRefreshingSuggestionByName] = useState<Record<string, boolean>>({});
  const [directQualifierNames, setDirectQualifierNames] = useState<string[]>([]);
  // Admin form steps: 0 Details, 1 Contenders, 2 Players, 3 Review.
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);

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
  const entrantNames = useMemo(() => entrants.map((entrant) => contenderName(entrant)), [entrants]);
  const entrantsWithImages = useMemo(
    () =>
      entrants.flatMap((entrant) => {
        const imageUrl = contenderImageUrl(entrant);
        if (!imageUrl) {
          return [];
        }
        return [{ name: contenderName(entrant), imageUrl }];
      }),
    [entrants],
  );
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
    // The round-one preview is only needed on the Review step.
    if (step !== 3) {
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
          directQualifierNames,
          rosterMembers,
          seededEntrants: previewSeededEntrants,
          seedingMode,
          startsAt: startsAtIso,
          endsAt: endsAtIso,
        }),
        signal: controller.signal,
      }).catch(() => null);

      if (!response) {
        if (!controller.signal.aborted) {
          setPreviewSnapshot(null);
          setPreviewError("Couldn't work out the first round. Check your connection and try again.");
        }
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
  }, [directQualifierNames, endsAt, entrants, previewIsValid, previewSeededEntrants, rosterMembers, seedingMode, startsAt, step, title]);

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

  function syncQualifierNames(nextEntrants: EntrantInput[]) {
    const availableEntrants = new Set(nextEntrants.map((entrant) => contenderName(entrant).toLowerCase()));
    setDirectQualifierNames((previous) =>
      previous.filter((name) => availableEntrants.has(name.toLowerCase())),
    );
  }

  function setEntrantsState(
    next: EntrantInput[],
    options?: { clearPhotoReview?: boolean; clearAppliedPhotoPreview?: boolean },
  ) {
    setEntrantsText(next.map(contenderLine).join("\n"));
    setPreviewSeededEntrants(seedingMode === "random" ? shufflePreview(next) : next);
    syncQualifierNames(next);
    if (options?.clearPhotoReview) {
      setPhotoLookupError(null);
      setShowPhotoReview(false);
      setPhotoSuggestions([]);
      setManualPhotoUrlByName({});
      setRefreshingSuggestionByName({});
    }
    if (options?.clearAppliedPhotoPreview) {
      setShowAppliedPhotoPreview(false);
    }
  }

  function updateEntrants(next: EntrantInput[]) {
    setEntrantsState(next, {
      clearPhotoReview: true,
      clearAppliedPhotoPreview: true,
    });
  }

  function suggestionNameKey(name: string) {
    return normalizeName(name).toLowerCase();
  }

  function updateEntrantImageByName(name: string, imageUrl: string) {
    const normalizedName = name.toLowerCase();
    const nextEntrants = entrants.map((entrant) => {
      if (contenderName(entrant).toLowerCase() !== normalizedName) {
        return entrant;
      }
      return { name: contenderName(entrant), imageUrl };
    });
    setEntrantsState(nextEntrants, {
      clearPhotoReview: false,
      clearAppliedPhotoPreview: false,
    });
    setShowAppliedPhotoPreview(true);
  }

  async function fetchPhotoSuggestions(
    names: string[],
    options?: { skipCache?: boolean; searchVariant?: "default" | "alt" },
  ) {
    const response = await fetch("/api/images/wikimedia-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        names,
        skipCache: Boolean(options?.skipCache),
        searchVariant: options?.searchVariant ?? "default",
      }),
    }).catch(() => null);

    if (!response) {
      throw new Error("Could not reach photo suggestions. Try again.");
    }

    const result = (await response.json()) as { error?: string; suggestions?: PhotoSuggestion[] };
    if (!response.ok || !Array.isArray(result.suggestions)) {
      throw new Error(result.error ?? "Could not fetch photo suggestions.");
    }

    return result.suggestions;
  }

  async function refreshPhotoSuggestion(name: string) {
    const key = suggestionNameKey(name);
    setRefreshingSuggestionByName((previous) => ({ ...previous, [key]: true }));
    setPhotoLookupError(null);
    try {
      const [nextSuggestion] = await fetchPhotoSuggestions([name], {
        skipCache: true,
        searchVariant: "alt",
      });
      if (nextSuggestion) {
        setPhotoSuggestions((previous) =>
          previous.map((suggestion) =>
            suggestionNameKey(suggestion.name) === key ? nextSuggestion : suggestion,
          ),
        );
      }
    } catch (error) {
      setPhotoLookupError(error instanceof Error ? error.message : "Could not fetch photo suggestions.");
    } finally {
      setRefreshingSuggestionByName((previous) => ({ ...previous, [key]: false }));
    }
  }

  function setManualPhotoValue(name: string, value: string) {
    const key = suggestionNameKey(name);
    setManualPhotoUrlByName((previous) => ({ ...previous, [key]: value }));
  }

  function reshufflePreview() {
    setPreviewSeededEntrants(shufflePreview(entrants));
  }

  function handleEntrantsTextChange(value: string) {
    setEntrantsText(value);
    setPhotoLookupError(null);
    setShowPhotoReview(false);
    setPhotoSuggestions([]);
    setManualPhotoUrlByName({});
    setRefreshingSuggestionByName({});
    setShowAppliedPhotoPreview(false);
    try {
      const nextEntrants = parseContendersFromText(value);
      setPreviewSeededEntrants(seedingMode === "random" ? shufflePreview(nextEntrants) : nextEntrants);
      syncQualifierNames(nextEntrants);
    } catch {
      setPreviewSeededEntrants([]);
      setDirectQualifierNames([]);
    }
  }

  function handleRosterTextChange(value: string) {
    setRosterText(value);
  }

  function toggleDirectQualifier(name: string) {
    setDirectQualifierNames((previous) => {
      if (previous.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
        return previous.filter((entry) => entry.toLowerCase() !== name.toLowerCase());
      }
      return [...previous, name];
    });
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
      title,
      kind,
      publish: kind === "public",
      entrants,
      directQualifierNames,
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
    try {
      const suggestions = await fetchPhotoSuggestions(missingImageEntrants.map(({ entrant }) => contenderName(entrant)));
      setPhotoSuggestions(suggestions);
      setManualPhotoUrlByName({});
      setShowPhotoReview(true);
    } catch (error) {
      setPhotoLookupError(error instanceof Error ? error.message : "Could not fetch photo suggestions.");
    } finally {
      setIsPhotoLookupLoading(false);
    }
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
    setManualPhotoUrlByName({});
    setRefreshingSuggestionByName({});
    setShowAppliedPhotoPreview(true);
  }

  function renderSuggestionActions(suggestion: PhotoSuggestion) {
    const key = suggestionNameKey(suggestion.name);
    const manualUrl = manualPhotoUrlByName[key] ?? "";
    const isRefreshing = Boolean(refreshingSuggestionByName[key]);
    const hasFoundImage = suggestion.status === "found" && Boolean(suggestion.imageUrl);
    const applyButtonClass = "bw-time-btn sel";
    const secondaryButtonClass = "bw-time-btn";
    const inputClass = "bw-photo-manual-input";

    return (
      <div className="bw-photo-suggestion-actions">
        {hasFoundImage ? (
          <>
            <a href={suggestion.sourcePageUrl ?? suggestion.imageUrl} rel="noreferrer" target="_blank">
              Preview
            </a>
            <button
              className={applyButtonClass}
              onClick={() => updateEntrantImageByName(suggestion.name, suggestion.imageUrl ?? "")}
              type="button"
            >
              Use this
            </button>
          </>
        ) : (
          <span className="bw-card-label">
            {suggestion.status === "error" ? "Error" : "No match"}
          </span>
        )}
        <button
          className={secondaryButtonClass}
          disabled={isRefreshing}
          onClick={() => refreshPhotoSuggestion(suggestion.name)}
          type="button"
        >
          {isRefreshing ? "Searching..." : "Find another"}
        </button>
        <div className="bw-photo-manual-row">
          <input
            className={inputClass}
            onChange={(event) => setManualPhotoValue(suggestion.name, event.target.value)}
            placeholder="Paste image URL"
            value={manualUrl}
          />
          <button
            className={secondaryButtonClass}
            disabled={!manualUrl.trim()}
            onClick={() => updateEntrantImageByName(suggestion.name, manualUrl.trim())}
            type="button"
          >
            Save URL
          </button>
        </div>
      </div>
    );
  }

  const foundPhotoSuggestions = photoSuggestions.filter((suggestion) => suggestion.status === "found");

  const rosterIsUnique =
    new Set(rosterMembers.map((member) => member.toLowerCase())).size === rosterMembers.length;
  const stepProblems = [
    !title.trim()
      ? "Give the tournament a topic."
      : !/^\d{4}-\d{2}-\d{2}$/.test(roundDate) || Number.isNaN(new Date(startsAt).getTime())
        ? "Pick a date for round one."
        : null,
    contenderParse.error ?? (entrants.length < 2 ? "Add at least two contenders." : null),
    rosterMembers.length < 2
      ? "Add at least two players."
      : !rosterIsUnique
        ? "Each player name must be different."
        : null,
    null,
  ];
  const canOpenStep = (index: number) =>
    index <= furthestStep && stepProblems.slice(0, index).every((problem) => !problem);
  const goToStep = (index: number) => {
    if (step === 3 && index !== 3) {
      // Anything changed after this would make the shown matchups wrong;
      // Review rebuilds the preview when it opens again.
      setPreviewSnapshot(null);
      setPreviewError(null);
    }
    setStep(index);
    setFurthestStep((current) => Math.max(current, index));
  };
  const goNext = () => {
    if (!stepProblems[step]) {
      goToStep(Math.min(step + 1, CREATE_STEPS.length - 1));
    }
  };
  const firstDayLabel = formatRoundDate(roundDate);
  const windowLabel = `${formatClock(startsAt)} to ${formatClock(endsAt)}`;
  const previewRoundCount = previewSnapshot?.rounds.length ?? null;
  const lastDayLabel =
    previewRoundCount && previewRoundCount > 1 ? formatRoundDate(addDays(roundDate, previewRoundCount - 1)) : null;

  return (
    <form
      action={handleSubmit}
      className="bw-create-form"
      onKeyDown={(event) => {
        // Enter in a text box moves to the next step instead of submitting early.
        if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT" && step < 3) {
          event.preventDefault();
          goNext();
        }
      }}
    >
      <ol className="bw-steps" aria-label="New tournament steps">
        {CREATE_STEPS.map((label, index) => (
          <li key={label}>
            <button
              aria-current={index === step ? "step" : undefined}
              className={`bw-step ${index === step ? "active" : ""} ${index < step ? "done" : ""}`}
              disabled={!canOpenStep(index)}
              onClick={() => goToStep(index)}
              type="button"
            >
              <span className="bw-step-num">{index + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="bw-card">
          <div className="bw-card-title">Details</div>
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
          <label className="bw-field">
            <span>First round date</span>
            <input type="date" value={roundDate} onChange={(event) => handleRoundDateChange(event.target.value)} />
            <small>
              Round one runs {firstDayLabel} from {windowLabel}. Each later round runs the same hours on the next
              day, one round per day, and closes on its own.
            </small>
          </label>
        </div>
      ) : null}

      {step === 1 ? (
        <>
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
              <button
                className="bw-time-btn"
                disabled={isPhotoLookupLoading || !!contenderParse.error}
                onClick={handlePhotoLookup}
                type="button"
              >
                {isPhotoLookupLoading ? "Finding photos..." : "Find photos"}
              </button>
              {showPhotoReview && foundPhotoSuggestions.length ? (
                <button className="bw-time-btn sel" onClick={applyPhotoSuggestions} type="button">
                  Apply {foundPhotoSuggestions.length} suggestion{foundPhotoSuggestions.length === 1 ? "" : "s"}
                </button>
              ) : null}
            </div>
            <small className="bw-muted">Searches Wikimedia and Google Images for any contender without a picture.</small>
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
                      <div className="bw-photo-suggestion-content">
                        {suggestion.status === "found" && suggestion.imageUrl ? (
                          <span
                            className="bw-photo-suggestion-thumb"
                            style={{ backgroundImage: `url("${suggestion.thumbnailUrl ?? suggestion.imageUrl}")` }}
                          />
                        ) : null}
                        {renderSuggestionActions(suggestion)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {showAppliedPhotoPreview ? (
              <div className="bw-photo-applied-preview">
                <div className="bw-photo-applied-header">
                  <span className="bw-card-label">Applied photo preview</span>
                  <strong>
                    {entrantsWithImages.length}/{entrants.length} with images
                  </strong>
                </div>
                <small>Click any tile to open the image. Edit any line above to swap a bad URL before launch.</small>
                <div className="bw-photo-applied-grid">
                  {entrantsWithImages.map((entrant) => (
                    <a
                      className="bw-photo-applied-card"
                      href={entrant.imageUrl}
                      key={`${entrant.name}-${entrant.imageUrl}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span
                        className="bw-photo-applied-image"
                        style={{ backgroundImage: `url("${entrant.imageUrl}")` }}
                      />
                      <span>{entrant.name}</span>
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
            {contenderParse.error ? <p className="bw-error-text">{contenderParse.error}</p> : null}
            {entrants.length >= 4 ? (
              <div className="bw-qualifier-panel">
                <span className="bw-card-label">Play-in round (optional)</span>
                <small>
                  Pick contenders that go straight into the main bracket. Everyone else plays a play-in match first,
                  and the winners fill the remaining spots.
                </small>
                <div className="bw-qualifier-chips">
                  {entrantNames.map((name) => {
                    const selected = directQualifierNames.some((entry) => entry.toLowerCase() === name.toLowerCase());
                    return (
                      <button
                        className={selected ? "bw-time-btn sel" : "bw-time-btn"}
                        key={name}
                        onClick={() => toggleDirectQualifier(name)}
                        type="button"
                      >
                        {selected ? "Straight in: " : "Play-in: "}
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {entrants.length > 1 ? (
            <div className="bw-card">
              <div className="bw-card-header-row">
                <div className="bw-card-title">Seeding</div>
                <div className="bw-seed-mode">
                  <button
                    className={seedingMode === "manual" ? "bw-time-btn sel" : "bw-time-btn"}
                    onClick={() => handleSeedingModeChange("manual")}
                    type="button"
                  >
                    My order
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
              </div>
              <p className="bw-muted">
                {seedingMode === "manual"
                  ? "Seed 1 meets the lowest seed. Move contenders up or down to set the order."
                  : "This shuffled order is the one that will be used. Reshuffle until you like it."}
              </p>
              <div className="bw-seed-list">
                {(seedingMode === "manual" ? entrants : previewSeededEntrants).map((entrant, index, list) => (
                  <div className="bw-seed-item" key={`${contenderName(entrant)}-${index}`}>
                    <strong>#{index + 1}</strong>
                    <span>{contenderName(entrant)}</span>
                    {seedingMode === "manual" ? (
                      <div className="bw-seed-actions">
                        <button
                          disabled={index === 0}
                          onClick={() => updateEntrants(moveContenders(entrants, index, Math.max(0, index - 1)))}
                          type="button"
                        >
                          Up
                        </button>
                        <button
                          disabled={index === list.length - 1}
                          onClick={() =>
                            updateEntrants(moveContenders(entrants, index, Math.min(entrants.length - 1, index + 1)))
                          }
                          type="button"
                        >
                          Down
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {step === 2 ? (
        <div className="bw-card">
          <div className="bw-card-title">Players</div>
          <label className="bw-field">
            <span>Who can vote, one name per line</span>
            <textarea
              placeholder={"Alex\nSam\nJordan\nTaylor"}
              rows={10}
              value={rosterText}
              onChange={(event) => handleRosterTextChange(event.target.value)}
            />
            <small>
              {rosterMembers.length} player{rosterMembers.length === 1 ? "" : "s"}. Each person picks their name on
              /voting. You can add more players later from the tournament&apos;s Players page.
            </small>
          </label>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="bw-card">
          <div className="bw-card-title">Review</div>
          <dl className="bw-review-list">
            <div>
              <dt>Topic</dt>
              <dd>{title}</dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>
                {previewRoundCount ? `${previewRoundCount} round${previewRoundCount === 1 ? "" : "s"}, ` : ""}
                {firstDayLabel}
                {lastDayLabel ? ` to ${lastDayLabel}` : ""}, {windowLabel} each day
              </dd>
            </div>
            <div>
              <dt>Contenders</dt>
              <dd>
                {entrants.length}
                {entrantsWithImages.length ? ` (${entrantsWithImages.length} with photos)` : ""} ·{" "}
                {seedingMode === "manual" ? "your order" : "random order"}
                {directQualifierNames.length ? ` · ${directQualifierNames.length} straight into the main bracket` : ""}
              </dd>
            </div>
            <div>
              <dt>Players</dt>
              <dd>{rosterMembers.length}</dd>
            </div>
          </dl>
          {isPreviewLoading ? <p className="bw-muted">Working out the first round...</p> : null}
          {previewError ? <p className="bw-error-text">{previewError}</p> : null}
          {previewSnapshot?.rounds[0] ? (
            <div className="bw-review-matchups">
              <span className="bw-card-label">{previewSnapshot.rounds[0].label}</span>
              <ul>
                {previewSnapshot.rounds[0].matchups
                  // Both sides empty: an unused slot in a bracket that isn't a power of two.
                  .filter((matchup) => matchup.entrantA || matchup.entrantB)
                  .map((matchup) =>
                    matchup.entrantA && matchup.entrantB ? (
                      <li key={matchup.id}>
                        {matchup.entrantA.name} vs {matchup.entrantB.name}
                      </li>
                    ) : (
                      <li key={matchup.id}>
                        {(matchup.entrantA ?? matchup.entrantB)?.name} gets a bye (goes straight through)
                      </li>
                    ),
                  )}
              </ul>
            </div>
          ) : null}
          <p className="bw-muted">
            Launch puts it on /voting straight away, replacing whatever is showing there now. A test stays private:
            only people signed in to admin can vote, using its test link.
          </p>
        </div>
      ) : null}

      {error ? <p className="bw-error-text">{error}</p> : null}
      {step < 3 && stepProblems[step] ? <p className="bw-muted">{stepProblems[step]}</p> : null}

      <div className="bw-btn-row">
        {step > 0 ? (
          <button className="bw-btn bw-btn-outline" onClick={() => goToStep(step - 1)} type="button">
            Back
          </button>
        ) : null}
        {step < 3 ? (
          <button className="bw-btn bw-btn-lime" disabled={Boolean(stepProblems[step])} onClick={goNext} type="button">
            Next: {CREATE_STEPS[step + 1]}
          </button>
        ) : (
          <>
            <button
              className="bw-btn bw-btn-lime bw-launch-button"
              disabled={isPending}
              name="kind"
              type="submit"
              value="public"
            >
              {isPending ? "Launching..." : "Launch and put on /voting"}
            </button>
            <button className="bw-btn bw-btn-outline" disabled={isPending} name="kind" type="submit" value="test">
              {isPending ? "Creating test..." : "Create as test instead"}
            </button>
          </>
        )}
      </div>
    </form>
  );
}
