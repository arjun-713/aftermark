"use client";
import Link from "next/link";
import { useScope } from "./app-shell";
export function SettingsNav({ current }: { current: string }) {
  const { role } = useScope();
  return (
    <nav className="tabs settings-tabs" aria-label="Workspace settings">
      {[
        ["keys", "API keys"],
        ["team", "Team"],
        ["billing", "Usage & billing"],
        ["retention", "Retention"],
        ...(["owner", "admin"].includes(role)
          ? [
              ["alerts", "Alerts"],
              ["operations", "Processing health"],
            ]
          : []),
      ].map(([id, label]) => (
        <Link
          key={id}
          href={`/app/settings/${id}`}
          className={current === id ? "selected" : ""}
          aria-current={current === id ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
