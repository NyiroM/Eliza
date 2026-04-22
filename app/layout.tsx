import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ELIZA Dashboard",
  description: "Deterministic AI-assisted job application copilot",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
