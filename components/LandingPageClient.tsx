"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { AdminHistoryItem } from "@/lib/workquiz/types";

const STEPS = [
  {
    num: "01",
    title: "Topic Drops",
    desc: "The admin picks a random topic and seeds the contenders into a bracket.",
  },
  {
    num: "02",
    title: "Head-to-Head",
    desc: "Options are matched up in a round-robin single elimination format.",
  },
  {
    num: "03",
    title: "Office Votes",
    desc: "Everyone clicks the link and picks their favourite — no sign-up needed.",
  },
  {
    num: "04",
    title: "Champion Crowned",
    desc: "One survivor emerges. Glory is eternal. Rematches are inevitable.",
  },
];

const tournamentDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatTournamentDate(value: string) {
  return tournamentDateFormatter.format(new Date(value));
}

type LandingPageClientProps = {
  initialIsLive: boolean;
  pastTopics: AdminHistoryItem[];
};

export default function LandingPageClient({
  initialIsLive,
  pastTopics,
}: LandingPageClientProps) {
  const [isLive, setIsLive] = useState<boolean | null>(initialIsLive);

  useEffect(() => {
    async function check() {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        const data = (await response.json()) as { live?: boolean };
        setIsLive(Boolean(data.live));
      } catch {
        setIsLive(false);
      }
    }

    void check();
    // Hidden tabs skip polling entirely; we re-check the moment the user
    // returns so the banner never looks stale.
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void check();
      }
    }, 60000);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 },
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const liveKnown = isLive !== null;

  return (
    <main>
      {liveKnown ? (
        <div className={`live-strip ${isLive ? "live-strip--on" : "live-strip--off"}`}>
          <span className="live-strip__dot" />
          {isLive ? (
            <>
              Tournament is live right now —{" "}
              <Link href="/voting" className="live-strip__link">
                join the vote →
              </Link>
            </>
          ) : (
            "No tournament running right now — check back soon"
          )}
        </div>
      ) : null}

      <section className="lp-hero shell">
        <div className="lp-hero__copy">
          <span className="eyebrow">WorkQuiz · Office Tournament</span>
          <h1 className="lp-hero__h1">
            Bored
            <br />
            <span className="lp-hero__accent">@Work.</span>
          </h1>
          <p className="lp-hero__sub">
            A random topic. Your whole team. One winner. The bracket game that turns office
            debates into something you actually look forward to.
          </p>
          <div className="lp-hero__cta">
            <Link
              href="/voting"
              className={`primary-button lp-cta-main ${isLive ? "" : "lp-cta-dim"}`}
            >
              {isLive ? "Cast Your Vote →" : "View Current Tournament →"}
            </Link>
            <a href="#how" className="pill">
              How it works ↓
            </a>
          </div>
        </div>

        <div className="panel lp-bracket-card">
          <span className="eyebrow">Live example</span>
          <p className="lp-bracket-card__topic">🎬 Best 90s Movie</p>
          <div className="lp-bracket">
            <div className="lp-bracket__col">
              <p className="lp-bracket__label">Semis</p>
              <div className="lp-bracket__match">
                <div className="lp-bracket__opt lp-bracket__opt--win">The Matrix</div>
                <div className="lp-bracket__opt lp-bracket__opt--lose">Home Alone</div>
              </div>
              <div className="lp-bracket__match" style={{ marginTop: 10 }}>
                <div className="lp-bracket__opt lp-bracket__opt--lose">Titanic</div>
                <div className="lp-bracket__opt lp-bracket__opt--win">Jurassic Park</div>
              </div>
            </div>
            <div className="lp-bracket__arrow">›</div>
            <div className="lp-bracket__col">
              <p className="lp-bracket__label">Final</p>
              <div className="lp-bracket__match" style={{ marginTop: 28 }}>
                <div className="lp-bracket__opt lp-bracket__opt--win">The Matrix</div>
                <div className="lp-bracket__opt lp-bracket__opt--lose">Jurassic Park</div>
              </div>
            </div>
            <div className="lp-bracket__arrow">›</div>
            <div className="lp-bracket__col">
              <p className="lp-bracket__label">Champion</p>
              <div className="lp-bracket__match" style={{ marginTop: 28 }}>
                <div className="lp-bracket__opt lp-bracket__opt--champ">🏆 The Matrix</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="lp-ticker" aria-hidden>
        <div className="lp-ticker__track">
          {[
            "Round Robin",
            "Single Elimination",
            "Random Topics",
            "Office-wide Voting",
            "One Champion",
            "No Spreadsheets",
            "Round Robin",
            "Single Elimination",
            "Random Topics",
            "Office-wide Voting",
            "One Champion",
            "No Spreadsheets",
          ].map((item, index) => (
            <span key={`${item}-${index}`} className="lp-ticker__item">
              <span className="lp-ticker__dot" />
              {item}
            </span>
          ))}
        </div>
      </div>

      <section id="how" className="lp-how shell">
        <div className="reveal">
          <span className="eyebrow">How It Works</span>
          <h2 className="lp-section-h2">
            Four steps to crowning
            <br />
            an office legend.
          </h2>
        </div>
        <div className="lp-steps">
          {STEPS.map((step, index) => (
            <div
              key={step.num}
              className="panel lp-step reveal"
              style={{ transitionDelay: `${index * 0.1}s` }}
            >
              <span className="lp-step__num">{step.num}</span>
              <h3 className="lp-step__title">{step.title}</h3>
              <p className="muted">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-past shell">
        <div className="reveal">
          <span className="eyebrow">Past Tournaments</span>
          <h2 className="lp-section-h2">
            The debates that
            <br />
            shook the office.
          </h2>
        </div>
        <div className="lp-past-grid">
          {pastTopics.length ? (
            pastTopics.map((topic, index) => (
              <Link
                key={topic.id}
                href={`/past/${encodeURIComponent(topic.id)}`}
                className="panel lp-topic-card reveal"
                style={{ transitionDelay: `${index * 0.08}s` }}
              >
                <span className="eyebrow lp-topic-card__eyebrow">
                  Tournament #{pastTopics.length - index} · {formatTournamentDate(topic.tournamentDate)}
                </span>
                <p className="lp-topic-card__topic">{topic.title}</p>
                <p className="eyebrow lp-topic-card__champion-label">Champion</p>
                <p className="lp-topic-card__winner">🏆 {topic.winnerName}</p>
                <div className="lp-topic-card__tags">
                  {topic.entrantNames.map((contender) => (
                    <span
                      key={contender}
                      className={`lp-topic-card__tag ${
                        contender === topic.winnerName ? "lp-topic-card__tag--win" : ""
                      }`}
                    >
                      {contender}
                    </span>
                  ))}
                </div>
              </Link>
            ))
          ) : (
            <div className="panel lp-topic-card reveal">
              <span className="eyebrow lp-topic-card__eyebrow">Tournament #1</span>
              <p className="lp-topic-card__topic">Best Chocolate Bar</p>
              <p className="eyebrow lp-topic-card__champion-label">Champion</p>
              <p className="lp-topic-card__winner">🏆 Waiting for first winner</p>
              <div className="lp-topic-card__tags">
                <span className="lp-topic-card__tag">Mars</span>
                <span className="lp-topic-card__tag">Kit Kat</span>
                <span className="lp-topic-card__tag">Coffee Crisp</span>
                <span className="lp-topic-card__tag">Reese&apos;s</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="lp-cta-section shell reveal">
        <div className="panel lp-cta-panel">
          <span className="eyebrow">Ready?</span>
          <h2 className="lp-cta-panel__h2">Your vote awaits.</h2>
          <p className="muted lp-cta-panel__sub">Takes 10 seconds. Arguments last all week.</p>
          <div className="lp-cta-panel__actions">
            <Link href="/voting" className="primary-button">
              {isLive ? "Cast Your Vote →" : "View Tournament →"}
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-footer shell">
        <span className="muted">© {new Date().getFullYear()} Bored@Work</span>
        <div className="lp-footer__links">
          <Link href="/voting" className="muted lp-footer__link">
            Player link
          </Link>
          <Link href="/admin" className="muted lp-footer__link">
            Admin
          </Link>
        </div>
      </footer>
    </main>
  );
}
