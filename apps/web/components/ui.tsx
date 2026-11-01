"use client";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  ArrowUpRight,
  RotateCw,
  AlertCircle,
  Check,
  Copy,
} from "lucide-react";
import { useState } from "react";
import { RequestError } from "../lib/api";
export function Badge({
  value,
  label,
}: {
  value?: string | null;
  label?: string;
}) {
  const status = value ?? "pending";
  return (
    <span className={`badge badge-${status}`}>
      <span className="status-dot" />
      {label ?? status.replaceAll("_", " ")}
    </span>
  );
}
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="header-actions">{action}</div>}
    </header>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children && <div className="empty-description">{children}</div>}
      {action}
    </div>
  );
}
export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading data" className="loading-state">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => unknown;
}) {
  const e = error as RequestError;
  const title =
    e.status === 403
      ? "Permission denied"
      : e.status === 410
        ? "Trace content has expired"
        : e.status === 404
          ? "We could not find this record"
          : "Could not load this data";
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>{title}</strong>
        <p>{e.message ?? "The service is unavailable. Please try again."}</p>
        {retry && (
          <button className="btn secondary small" onClick={() => retry()}>
            <RotateCw size={13} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <button
      type="button"
      className="btn secondary small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setError(false);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setError(true);
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
      {copied ? "Copied" : error ? "Select text to copy" : label}
    </button>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <Dialog.Close
            className="icon-button modal-close"
            aria-label="Close dialog"
          >
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function SectionTitle({
  children,
  link,
  href,
}: {
  children: React.ReactNode;
  link?: string;
  href?: string;
}) {
  return (
    <div className="section-heading">
      <h2>{children}</h2>
      {href && (
        <Link href={href}>
          {link ?? "View all"}
          <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
