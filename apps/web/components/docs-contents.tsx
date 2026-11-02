"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ArrowDown } from "lucide-react";

const sections = [
  ["start", "Get started"],
  ["outcomes", "Expected outcomes"],
  ["verifiers", "Verification"],
  ["reviews", "Human review"],
  ["ci", "Regression & CI"],
  ["privacy", "Data handling"],
  ["alerts", "Alerts"],
  ["billing", "Billing & access"],
] as const;

export function DocsContents() {
  const [active, setActive] = useState("start");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => {
      let next: string = sections[0][0];
      for (const [id] of sections) {
        const section = document.getElementById(id);
        if (section && section.getBoundingClientRect().top <= 160) next = id;
      }
      setActive(next);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  function navigate(id: string) {
    setActive(id);
    setOpen(false);
    window.setTimeout(
      () => document.getElementById(id)?.focus({ preventScroll: true }),
      0,
    );
  }
  return (
    <aside
      className={`docs-toc ${open ? "is-open" : ""}`}
      aria-label="Documentation contents"
    >
      <button
        className="docs-toc-toggle"
        aria-expanded={open}
        aria-controls="docs-contents-list"
        onClick={() => setOpen(!open)}
      >
        Contents <span>{sections.find(([id]) => id === active)?.[1]}</span>
        <ChevronDown size={16} />
      </button>
      <div className="docs-toc-inner" id="docs-contents-list">
        <p className="docs-toc-title">On this page</p>
        <nav>
          {sections.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={active === id ? "location" : undefined}
              onClick={() => navigate(id)}
            >
              <span>{label}</span>
              {active === id && <ArrowDown size={13} />}
            </a>
          ))}
        </nav>
        <div className="docs-toc-note">
          From first run
          <br />
          to next release.
        </div>
      </div>
    </aside>
  );
}
