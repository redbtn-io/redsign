import type { Metadata, Viewport } from "next";
import "../index.css";
import "../App.css";

export const metadata: Metadata = {
  title: "redSign",
  description: "E-signatures by redbtn — redSuite",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
