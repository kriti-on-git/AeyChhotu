"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/logo";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Drawer } from "@/components/ui/drawer";
import { IconButton } from "@/components/ui/icon-button";
import { marketingNav, productLinks } from "@/lib/site";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full transition-colors duration-[var(--duration-base)] ease-gentle",
        scrolled ? "border-b border-line/70 bg-cream/85 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <Container className="flex h-18 items-center justify-between gap-6">
        <Link href="/" aria-label="AeyChhotu — home" className="shrink-0">
          <Logo />
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-8 lg:flex">
          {marketingNav.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Link href="/kitchen" className={buttonStyles({ variant: "ghost", size: "sm" })}>
            Kitchen board
          </Link>
          <Link href="/table/k7x2p" className={buttonStyles({ variant: "primary", size: "sm" })}>
            Open a table
          </Link>
        </div>

        <IconButton
          label="Open navigation"
          tone="outline"
          className="lg:hidden"
          onClick={() => setMenuOpen(true)}
        >
          <Menu className="size-5" aria-hidden />
        </IconButton>
      </Container>

      <Drawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="AeyChhotu"
        description="Real-time table and kitchen operations."
      >
        <nav aria-label="Mobile" className="flex flex-col gap-8">
          <ul className="flex flex-col gap-1">
            {marketingNav.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-md px-3 py-3 text-base font-medium text-ink transition-colors duration-[var(--duration-fast)] hover:bg-beige/50"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-3 border-t border-line pt-6">
            <p className="text-label text-ink-muted uppercase">Live screens</p>
            {productLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={buttonStyles({ variant: "outline", size: "md", fullWidth: true })}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      </Drawer>
    </header>
  );
}
