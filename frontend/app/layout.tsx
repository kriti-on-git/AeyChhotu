import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import { displayFont, sansFont } from "@/lib/fonts";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AeyChhotu — one table, one order, live from the kitchen",
    template: "%s · AeyChhotu",
  },
  description:
    "A zero-download, real-time operational bridge that groups individual table requests into a single unified cart and streams two-way status updates between diners and the kitchen.",
};

export const viewport: Viewport = {
  themeColor: "#f7ead7",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn(displayFont.variable, sansFont.variable)}>
      <body className="min-h-dvh bg-canvas font-sans text-base text-ink antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
