import Link from "next/link";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Container } from "@/components/ui/container";
import { Text } from "@/components/ui/text";
import { marketingNav, productLinks } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="relative isolate overflow-hidden bg-ink pt-16 pb-10 text-ink-inverse">
      <LogoMark className="pointer-events-none absolute -top-10 right-[6%] size-40 opacity-10" />

      <Container className="relative">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr]">
          <div className="flex flex-col gap-4">
            <Logo tone="inverse" />
            <Text variant="small" tone="inverseMuted" className="max-w-sm">
              A zero-download, real-time operational bridge that groups individual table requests
              into one unified cart and streams live status between diners and the kitchen.
            </Text>
          </div>

          <nav aria-label="Sections" className="flex flex-col gap-3">
            <p className="text-label text-ember uppercase">Sections</p>
            {marketingNav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-ink-inverse/75 transition-colors duration-[var(--duration-fast)] hover:text-ink-inverse"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <nav aria-label="Live screens" className="flex flex-col gap-3">
            <p className="text-label text-ember uppercase">Live screens</p>
            {productLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-ink-inverse/75 transition-colors duration-[var(--duration-fast)] hover:text-ink-inverse"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </Container>
    </footer>
  );
}
