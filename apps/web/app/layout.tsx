import type { Metadata } from "next";
import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource/work-sans/600.css";
import "@fontsource/anton/400.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import "./premium.css";
export const metadata: Metadata = {
  title: {
    default: "Aftermark — agent outcomes, on record",
    template: "%s · Aftermark",
  },
  description:
    "Know what your agent actually changed. Verify outcomes with independent evidence, review uncertain findings, and protect your next release.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
