import Link from "next/link";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`brand-mark ${className}`}
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 27 15.3 4h6.3L9.3 27H3Z" fill="currentColor" />
      <path d="m18.5 14.8 6.4 12.2H31L21.6 9.2l-3.1 5.6Z" fill="currentColor" />
      <path d="M13 23.2h9.8l-2.5-4.8h-4.7L13 23.2Z" fill="currentColor" />
    </svg>
  );
}

export function Brand({
  href = "/",
  className = "",
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`wordmark ${className}`}
      aria-label="Aftermark home"
    >
      <BrandMark />
      <span>Aftermark</span>
    </Link>
  );
}
