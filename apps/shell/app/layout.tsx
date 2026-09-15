import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "VerityOS",
  description: "Governed, grounded, auditable operating environment",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </body>
    </html>
  );
}
