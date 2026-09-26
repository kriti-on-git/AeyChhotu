import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { Container } from "@/components/ui/container";
import { Text } from "@/components/ui/text";
import { marketingNav, productLinks } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="relative overflow-hidden bg-dark-brown pt-16 pb-10 text-cream">
      <LogoMark tone="inverse" className="absolute -top-10 right-[6%] size-40 opacity-10" />

      <Container className="relative">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr]">
          <div className="flex flex-col gap-4">
            <span className="flex items-center gap-2.5">
              <LogoMark tone="inverse" />
              <span className="font-display text-xl font-semibold tracking-tight">
                AeyChhotu<span className="text-tan">!</span>
              </span>
            </span>
            <Text variant="small" tone="inverse" className="max-w-sm opacity-80">
              A zero-download, real-time operational bridge that groups individual table requests
              into one unified cart and streams live status between diners and the kitchen.
            </Text>
          </div>

          <nav aria-label="Sections" className="flex flex-col gap-3">
            <p className="text-label text-tan uppercase">Sections</p>
            {marketingNav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-cream/80 transition-colors duration-[var(--duration-fast)] hover:text-cream"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <nav aria-label="Live screens" className="flex flex-col gap-3">
            <p className="text-label text-tan uppercase">Live screens</p>
            {productLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-cream/80 transition-colors duration-[var(--duration-fast)] hover:text-cream"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-14 flex flex-col gap-2 border-t border-cream/15 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <Text variant="caption" tone="inverse" className="opacity-60">
            MVP scope: no payments and no accounts — the table is the authorisation token.
          </Text>
          <Text variant="caption" tone="inverse" className="opacity-60">
            AeyChhotu · built on the documented MVP specification
          </Text>
        </div>
      </Container>
    </footer>
  );
}
