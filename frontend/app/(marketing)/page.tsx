import {
  BellRing,
  ChefHat,
  Columns3,
  Flame,
  Hand,
  KeyRound,
  QrCode,
  ShieldAlert,
  ShoppingBasket,
  Timer,
  Utensils,
  Users,
  type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { LogoWatermark } from "@/components/brand/logo";
import { ExpandableCard } from "@/components/marketing/expandable-card";
import { FlipCard } from "@/components/marketing/flip-card";
import { HeroVisual } from "@/components/marketing/hero-visual";
import { InnovationDeck } from "@/components/marketing/innovation-deck";
import { TiltSurface } from "@/components/marketing/tilt-surface";
import { WorkflowTimeline } from "@/components/marketing/workflow-timeline";
import { Reveal } from "@/components/motion/reveal";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Section } from "@/components/ui/section";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { demoTableToken, productLinks } from "@/lib/site";

interface Gap {
  title: string;
  friction: string;
  complaint: string;
}

const gaps: Gap[] = [
  {
    title: "Mixed up ticket timing",
    friction:
      "Orders hit the kitchen the moment a guest taps submit. Eight people ordering separately become eight separate tickets.",
    complaint: "Kitchens get overwhelmed — they cannot group or pause orders for the same table.",
  },
  {
    title: "Bad allergy formats, slow inventory sync",
    friction:
      "Rigid check-boxes hide serious allergy warnings, and an ingredient running out does not reach the guest's menu instantly.",
    complaint: "Chefs miss critical allergy notes and guests order food that no longer exists.",
  },
  {
    title: "One-way kitchen screens",
    friction:
      "The screen only shows done or not done. Nothing travels back to the server or the guest while food is being cooked.",
    complaint: "Servers walk to the pass to ask, and guests stare at a frozen screen.",
  },
];

const steps = [
  {
    title: "Scan the table QR",
    body: "A randomised link like /table/k7x2p opens the menu and binds the session to the physical table. No login, no download.",
  },
  {
    title: "Everyone adds to one cart",
    body: "Every phone at the table edits the same shared cart and sees the others' lines appear live.",
  },
  {
    title: "Review & fire",
    body: "One button checks live inventory, empties the cart and sends the table's order to the kitchen as a single ticket.",
  },
  {
    title: "The kitchen taps tags",
    body: "One tap moves a ticket Pending → Preparing → Ready → Served on a three-column board.",
  },
  {
    title: "Everyone sees it live",
    body: "The diner's screen turns grey, amber, then flashes green. The floor view tracks every table without a walk to the pass.",
  },
];

interface Feature {
  title: string;
  teaser: string;
  body: string;
  icon: LucideIcon;
}

/* Nine cards, three by three: the grid stays symmetric on every
   breakpoint, and each teaser names the win while the back carries the how. */
const features: Feature[] = [
  {
    title: "QR table link",
    teaser: "Scan, sit, order.",
    body: "Unguessable table tokens instead of numbered tables, opening the menu instantly — no app store between the guest and the food.",
    icon: QrCode,
  },
  {
    title: "Shared table cart",
    teaser: "One bucket per table.",
    body: "One cart for the whole table, synced across every phone at it, so eight people build one order instead of eight.",
    icon: ShoppingBasket,
  },
  {
    title: "Review & fire",
    teaser: "One tap sends it all.",
    body: "A single submission with a live inventory check and a duplicate-order guardrail before anything reaches the kitchen.",
    icon: Flame,
  },
  {
    title: "Kitchen kanban",
    teaser: "One card per table.",
    body: "Pending, Preparing and Ready columns with one card per table, so the line sees the whole rush at a glance.",
    icon: Columns3,
  },
  {
    title: "One-tap status",
    teaser: "Cook, ready, served.",
    body: "The same button changes meaning per column — one tap moves the ticket, and the whole floor sees it move.",
    icon: Hand,
  },
  {
    title: "Live guest tracker",
    teaser: "No more “how long?”",
    body: "A self-updating screen so nobody has to ask where the food is — the table watches its ticket cook.",
    icon: Timer,
  },
  {
    title: "Red allergy text",
    teaser: "Impossible to miss.",
    body: "A dedicated allergy box that renders bold red on the ticket, while normal notes stay normal and quiet.",
    icon: ShieldAlert,
  },
  {
    title: "Screen flash & sounds",
    teaser: "You'll know it landed.",
    body: "A green flash for the diner, a chime for the kitchen the moment a ticket lands — no polling, no staring.",
    icon: BellRing,
  },
  {
    title: "Quick item hide",
    teaser: "86 a dish in a tap.",
    body: "Pull a dish in one tap and it greys out on every active menu — behind a staff PIN, so diners cannot open it.",
    icon: KeyRound,
  },
];

interface Persona {
  role: string;
  name: string;
  interface: string;
  goal: string;
  pain: string;
  metric: string;
  icon: LucideIcon;
}

const personas: Persona[] = [
  {
    role: "The Diner",
    name: "Diner mobile web app",
    interface: "QR scan · zero download",
    goal: "Order accurately, flag allergies safely and track the wait without anxiety.",
    pain: "Finding out ten minutes later that the dish is sold out; watching a frozen screen.",
    metric: "Seconds between ordering and the first live cooking update.",
    icon: Utensils,
  },
  {
    role: "The Line Chef",
    name: "Mr. Baawarchi",
    interface: "Wall-mounted KDS dashboard",
    goal: "Receive grouped tickets and update prep status without leaving the line.",
    pain: "Five small tickets from the same table; allergy alerts lost in tiny text.",
    metric: "Zero split tickets per table and zero missed allergy notes.",
    icon: ChefHat,
  },
  {
    role: "The Server",
    name: "Chhotu",
    interface: "Handheld floor view",
    goal: "Keep floor pacing, stop walking to the pass, manage out-of-stock dishes.",
    pain: 'Running into a loud kitchen to ask, "how much longer on Table 4?"',
    metric: "Fewer physical trips to the kitchen pass.",
    icon: Users,
  },
];

export default function LandingPage() {
  return (
    <>
      {/* ============================ HERO ============================
          The old hero stretched a flat mid-tone photo across the whole
          viewport and then veiled it in cream, which left the page with no
          focal point at all. The visual is now a mock of the actual product:
          three live tickets in the states the kitchen moves them through. */}
      <section className="relative isolate overflow-hidden border-b border-line bg-canvas">
        <div
          aria-hidden
          className="hairline-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-48 -right-32 size-[36rem] rounded-pill bg-ember/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 -left-32 size-[30rem] rounded-pill bg-tan/25 blur-3xl"
        />

        <Container className="relative py-20 lg:py-28">
          {/* minmax(0, …) keeps the image's intrinsic 1672px width from
              inflating the track past the column (the grid auto-min trap). */}
          <div className="grid items-center gap-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20">
            {/* z-10 keeps the copy above the cut-out where it slides under
                it; the soft canvas veil behind the text carries the
                legibility where the chef's tablet pixels reach this far. */}
            <div className="relative z-10 lg:order-2">
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-x-8 -inset-y-6 -z-10 rounded-3xl bg-canvas/75 blur-2xl"
              />
              <Reveal>
                <Badge tone="accent" size="md">
                  Zero download · no logins · live updates
                </Badge>
              </Reveal>

              <Reveal delay={0.06}>
                <h1 className="mt-7 text-display font-display font-semibold text-balance text-ink">
                  Every phone at the table.
                  <br className="hidden sm:block" />{" "}
                  <span className="text-ember">One ticket</span> for the kitchen.
                </h1>
              </Reveal>

              <Reveal delay={0.12}>
                <Text variant="lead" tone="muted" className="mt-6 max-w-xl">
                  AeyChhotu is the real-time bridge between the floor and the line. Individual
                  table requests merge into a single unified cart, and every prep milestone
                  streams back to the guest who is waiting for it.
                </Text>
              </Reveal>

              <Reveal delay={0.18}>
                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <Link
                    href={`/table/${demoTableToken}`}
                    className={buttonStyles({ variant: "ember", size: "lg" })}
                  >
                    Open the diner view
                  </Link>
                  <Link
                    href="/kitchen"
                    className={buttonStyles({ variant: "soft", size: "lg" })}
                  >
                    Kitchen board
                  </Link>
                  <a href="#how-it-works" className={buttonStyles({ variant: "ghost", size: "lg" })}>
                    How it works
                  </a>
                </div>
              </Reveal>

            </div>

            {/* The visual sizes itself to 75% of this section's measured
                height and anchors its own bottom edge to the section's
                border — see hero-visual.tsx. */}
            <Reveal delay={0.16} className="lg:order-1">
              <HeroVisual />
            </Reveal>
          </div>
        </Container>
      </section>

      <Section id="problem" spacing="lg" tone="surface" className="scroll-mt-20">
        <Container>
          <SectionHeader align="center" size="heading" title="What gaps are we bridging?" />

          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {gaps.map((gap, index) => (
              <Reveal key={gap.title} delay={index * 0.08}>
                <ExpandableCard
                  meta={String(index + 1).padStart(2, "0")}
                  title={gap.title}
                  teaser="Tap to see what breaks in a rush"
                >
                  <p className="text-sm leading-relaxed text-ink-muted">{gap.friction}</p>
                  <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed font-medium text-alert">
                    {gap.complaint}
                  </p>
                </ExpandableCard>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="how-it-works" spacing="lg" className="scroll-mt-20">
        <Container>
          <SectionHeader align="center" size="heading" title="How do we work?" />

          <div className="mt-14">
            <Reveal>
              <WorkflowTimeline steps={steps} />
            </Reveal>
          </div>
        </Container>
      </Section>

      <Section id="innovations" spacing="lg" tone="ink" className="scroll-mt-20">
        {/* Still charcoal, with a warm ember glow gathering through the lower
            third — the ground starts warming up before the page ever reaches
            the closing ramp. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-2/3 bg-gradient-to-b from-ink/0 via-ember/5 to-ember/20"
        />
        <Container>
          <SectionHeader align="center" size="heading" tone="inverse" title="What makes us different?" />

          {/* The display carries the same weight as the deck beside it, so the
              row reads as one composition rather than a mock and a card. */}
          <div className="mt-14 grid items-center gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16">
            <Reveal>
              <TiltSurface className="mx-auto w-full max-w-xl lg:max-w-none">
                <TicketPipeline />
              </TiltSurface>
            </Reveal>

            <Reveal delay={0.08}>
              <InnovationDeck />
            </Reveal>
          </div>
        </Container>
      </Section>

      <Section id="features" spacing="lg" className="scroll-mt-20">
        <Container>
          <SectionHeader align="center" size="heading" title="What do we actually ship?" />

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, index) => (
              <Reveal key={feature.title} delay={(index % 3) * 0.06}>
                <FlipCard
                  icon={<feature.icon className="size-5" aria-hidden />}
                  title={feature.title}
                  teaser={feature.teaser}
                >
                  <p className="text-sm leading-relaxed">{feature.body}</p>
                </FlipCard>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="personas" spacing="lg" tone="surface" className="scroll-mt-20">
        <Container>
          <SectionHeader align="center" size="heading" title="Who is this for?" />

          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {personas.map((persona, index) => (
              <Reveal key={persona.role} delay={index * 0.08}>
                <ExpandableCard
                  icon={<persona.icon className="size-5" aria-hidden />}
                  meta={persona.role}
                  title={persona.name}
                  teaser={persona.interface}
                >
                  <dl className="flex flex-col gap-4">
                    {[
                      ["Goal", persona.goal],
                      ["Biggest pain", persona.pain],
                      ["Value metric", persona.metric],
                    ].map(([term, description]) => (
                      <div key={term}>
                        <dt className="text-label text-ink-subtle uppercase">{term}</dt>
                        <dd className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                          {description}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </ExpandableCard>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* The close. The card keeps its shape but drops from bright ember to a
          muted ember gradient, and the section's own ground fades out of the
          cream into the exact tone the footer opens on — so the page sinks
          from charcoal to deep ember instead of stopping on an orange block. */}
      <Section spacing="lg" className="scroll-mt-20">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-canvas/0 to-ember-dusk sm:h-52"
        />
        <Container className="relative">
          <Reveal>
            <div className="relative isolate overflow-hidden rounded-2xl border border-on-ember/15 bg-gradient-to-br from-ember-strong to-ember-dusk px-7 py-14 text-on-ember sm:px-12 sm:py-16">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-15 [background-image:linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)] [background-size:3rem_3rem]"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-pill bg-on-ember/10 blur-3xl"
              />
              <LogoWatermark className="absolute -right-10 -bottom-14 h-64 w-auto opacity-10" />

              <div className="relative max-w-2xl">
                <h2 className="text-title font-display font-semibold text-balance">Ready to open?</h2>
                <p className="mt-4 text-lead text-on-ember/85">
                  Three live surfaces, no signup. Open the diner view, then watch the ticket land on
                  the kitchen board and the floor.
                </p>
              </div>

              <div className="relative mt-10 grid gap-3 sm:grid-cols-3">
                {productLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="group flex items-center justify-between gap-3 rounded-lg border border-on-ember/25 bg-on-ember/10 px-5 py-4 transition-[transform,background-color,border-color] duration-[var(--duration-base)] ease-organic hover:-translate-y-0.5 hover:border-on-ember/50 hover:bg-on-ember/20"
                  >
                    <span className="font-display text-base font-semibold">{link.label}</span>
                    <span aria-hidden className="transition-transform duration-[var(--duration-fast)] group-hover:translate-x-1">
                      →
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------
   TicketPipeline: the kitchen board, rendered from the same status tokens
   the real board uses. Because it is built from tokens rather than a
   screenshot, it can never drift away from the product.
   --------------------------------------------------------------- */

interface MiniTicketProps {
  table: string;
  elapsed: string;
  status: string;
  tone: BadgeTone;
  rail: string;
  lines: string[];
  allergy?: string;
  action: string;
  actionClass: string;
}

const miniTickets: MiniTicketProps[] = [
  {
    table: "Table 04",
    elapsed: "0:42",
    status: "Pending",
    tone: "pending",
    rail: "bg-pending",
    lines: ["2× Masala Dosa", "1× Filter Coffee"],
    action: "Cook",
    actionClass: "bg-ember text-on-ember",
  },
  {
    table: "Table 07",
    elapsed: "4:15",
    status: "Preparing",
    tone: "preparing",
    rail: "bg-preparing",
    lines: ["1× Paneer Butter Masala", "2× Butter Naan"],
    allergy: "NO PEANUTS",
    action: "Ready",
    actionClass: "bg-ink text-ink-inverse",
  },
  {
    table: "Table 02",
    elapsed: "6:03",
    status: "Ready",
    tone: "ready",
    rail: "bg-ready",
    lines: ["3× Veg Noodles"],
    action: "Mark served",
    actionClass: "border border-line-strong text-ink",
  },
];

function TicketPipeline() {
  return (
    <div className="relative w-full">
      {/* A panel, not a phone: it fills the column, and the width it gains is
          spent on padding rather than on stretching the tickets inside it. */}
      <div className="relative overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-lg [transform-style:preserve-3d]">
        <div className="flex items-center gap-2.5 border-b border-line bg-surface-sunken/70 px-5 py-4 sm:px-6 lg:px-7">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-pill bg-line-strong" />
            <span className="size-2.5 rounded-pill bg-line-strong" />
            <span className="size-2.5 rounded-pill bg-line-strong" />
          </span>
          <span className="ml-2 text-[0.6875rem] font-semibold tracking-[0.14em] text-ink-subtle uppercase">
            Kitchen display
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-pill bg-ready-surface px-3 py-1.5 text-[0.6875rem] font-semibold tracking-wide text-ready uppercase">
            <span aria-hidden className="size-1.5 rounded-pill bg-ready" />
            Live
          </span>
        </div>

        <div className="flex flex-col gap-4 bg-canvas p-4 sm:gap-5 sm:p-6 lg:p-7">
          {miniTickets.map((ticket) => (
            <div
              key={ticket.table}
              className="relative overflow-hidden rounded-xl border border-line bg-paper p-5 shadow-sm sm:p-6"
            >
              <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${ticket.rail}`} />

              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pl-2">
                <span className="font-display text-base font-semibold text-ink">{ticket.table}</span>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-xs text-ink-subtle">{ticket.elapsed}</span>
                  <Badge tone={ticket.tone}>{ticket.status}</Badge>
                </span>
              </div>

              <ul className="mt-4 flex flex-col gap-2 pl-2">
                {ticket.lines.map((line) => (
                  <li key={line} className="text-sm leading-relaxed text-ink-muted">
                    {line}
                  </li>
                ))}
              </ul>

              {ticket.allergy ? (
                <p className="mt-5 ml-2 flex items-center gap-2 rounded-lg border border-alert/40 bg-alert-surface px-3 py-2 text-xs font-bold tracking-wide text-alert uppercase">
                  <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                  {ticket.allergy}
                </p>
              ) : null}

              <span
                className={`mt-5 ml-2 flex h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold ${ticket.actionClass}`}
              >
                {ticket.action}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
