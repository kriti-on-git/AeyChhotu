import {
  Activity,
  BellRing,
  ChefHat,
  Columns3,
  EyeOff,
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
import Link from "next/link";
import { Reveal } from "@/components/motion/reveal";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

interface Innovation {
  title: string;
  innovation: string;
  impact: string;
  icon: LucideIcon;
}

const innovations: Innovation[] = [
  {
    title: "The anti-chaos unified cart",
    innovation:
      "Every phone at a table shares one live-syncing room bucket instead of being treated as an independent customer.",
    impact:
      "A digital gatekeeper: the kitchen never receives eight tickets for one table, and course timing is protected without a server merging orders by hand.",
    icon: ShoppingBasket,
  },
  {
    title: "Guardrailed allergy alerts",
    innovation:
      "Dietary notes bypass the standard modifier log and are formatted as bold, high-contrast red directly on the kitchen ticket line.",
    impact:
      "Removes the human error of handwriting and forgotten verbal warnings — chefs see the safety risk without stopping the line.",
    icon: ShieldAlert,
  },
  {
    title: "Two-way micro-status",
    innovation:
      "Prep milestones stream outward: Pending, Preparing, Ready. No static done / not done checkbox.",
    impact:
      "Guests lose waiting anxiety and servers stop running to the kitchen window to ask how long the steaks will be.",
    icon: Activity,
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
  body: string;
  icon: LucideIcon;
}

const features: Feature[] = [
  {
    title: "QR table link",
    body: "Unguessable table tokens instead of numbered tables, opening the menu instantly.",
    icon: QrCode,
  },
  {
    title: "Shared table cart",
    body: "One cart for the whole table, synced across every phone at it.",
    icon: ShoppingBasket,
  },
  {
    title: "Review & fire",
    body: "A single submission with a live inventory check and a duplicate-order guardrail.",
    icon: Flame,
  },
  {
    title: "Kitchen kanban",
    body: "Pending, Preparing and Ready columns with one card per table.",
    icon: Columns3,
  },
  {
    title: "One-tap status",
    body: "Cook, ready, served — the same button changes meaning per column.",
    icon: Hand,
  },
  {
    title: "Live guest tracker",
    body: "A self-updating screen so nobody has to ask where the food is.",
    icon: Timer,
  },
  {
    title: "Red allergy text",
    body: "A dedicated allergy box that renders bold red on the ticket. Normal notes stay normal.",
    icon: ShieldAlert,
  },
  {
    title: "Screen flash & sounds",
    body: "A green flash for the diner, a chime for the kitchen the moment a ticket lands.",
    icon: BellRing,
  },
  {
    title: "Quick item hide",
    body: "86 a dish in one tap and it greys out on every active menu.",
    icon: EyeOff,
  },
  {
    title: "Staff PIN",
    body: "The kitchen board stays behind a shared PIN so diners cannot open it.",
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

const heroStats = [
  { value: "1", label: "ticket per table, not per phone" },
  { value: "3", label: "live status tags streamed to the guest" },
  { value: "0", label: "downloads, logins or hardware" },
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
          <div className="grid items-center gap-16 lg:grid-cols-[1.05fr_1fr] lg:gap-20">
            <div>
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

              <Reveal delay={0.24}>
                <dl className="mt-12 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-8">
                  {heroStats.map((stat) => (
                    <div key={stat.label}>
                      <dt className="font-display text-3xl font-semibold text-ember">
                        {stat.value}
                      </dt>
                      <dd className="mt-1.5 text-xs leading-snug text-ink-muted">
                        {stat.label}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Reveal>
            </div>

            <Reveal delay={0.16}>
              <TicketPipeline />
            </Reveal>
          </div>
        </Container>
      </section>

      <Section id="problem" spacing="lg" tone="surface" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="Gap analysis"
            title="QR ordering removed the typing errors and created three new ones"
            description="Toast, Square, me&u and Mr Yum all stop manual order entry. These are the gaps they leave behind in a rush."
          />

          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {gaps.map((gap, index) => (
              <Reveal key={gap.title} delay={index * 0.08}>
                <Card className="flex h-full flex-col">
                  <span className="font-display text-4xl font-semibold leading-none text-line-strong">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-5 font-display text-subheading text-ink">{gap.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-ink-muted">{gap.friction}</p>
                  <p className="mt-5 border-t border-line pt-5 text-sm leading-relaxed font-medium text-alert">
                    {gap.complaint}
                  </p>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="how-it-works" spacing="lg" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="The workflow"
            title="From the first scan to a green screen"
            description="One table session spans three surfaces: the diner's browser, the kitchen board and the floor view."
          />

          <ol className="mt-14 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map((step, index) => (
              <Reveal key={step.title} delay={index * 0.06}>
                <li className="relative flex h-full flex-col">
                  {/* Connector rail: a hairline that ties the five stages into
                      one pipeline instead of five unrelated cards. */}
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-ember font-display text-sm font-semibold text-on-ember shadow-xs">
                      {index + 1}
                    </span>
                    <span
                      aria-hidden
                      className="hidden h-px flex-1 bg-line-strong lg:block"
                    />
                  </div>
                  <h3 className="mt-5 font-display text-base font-semibold text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">{step.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </Container>
      </Section>

      <Section id="innovations" spacing="lg" tone="ink" className="scroll-mt-20">
        <Container>
          <SectionHeader
            tone="inverse"
            eyebrow="Why it is different"
            title="Three things the incumbents do not do"
          />

          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {innovations.map((item, index) => (
              <Reveal key={item.title} delay={index * 0.08}>
                <div className="flex h-full flex-col rounded-lg border border-ink-inverse/15 bg-ink-inverse/5 p-6">
                  <span className="flex size-10 items-center justify-center rounded-md bg-ember text-on-ember">
                    <item.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-5 font-display text-subheading text-ink-inverse">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-ink-inverse/80">
                    {item.innovation}
                  </p>
                  <p className="mt-5 border-t border-ink-inverse/15 pt-5 text-sm leading-relaxed text-ink-inverse/65">
                    {item.impact}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="features" spacing="lg" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="Features"
            title="What ships, feature by feature"
            description="Ten capabilities, all of them built around protecting kitchen pacing and keeping guests informed."
          />

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, index) => (
              <Reveal key={feature.title} delay={(index % 3) * 0.06}>
                <Card interactive className="h-full p-5">
                  <span className="inline-flex size-10 items-center justify-center rounded-md bg-ember-soft text-ember">
                    <feature.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-display text-base font-semibold text-ink">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">{feature.body}</p>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="personas" spacing="lg" tone="surface" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="Who it is for"
            title="Three people, one live pipeline"
            description="Each role gets an interface shaped around its own bottleneck — not a generic dashboard."
          />

          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {personas.map((persona, index) => (
              <Reveal key={persona.role} delay={index * 0.08}>
                <Card className="flex h-full flex-col" marked>
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-md bg-ink text-ink-inverse">
                      <persona.icon className="size-5" aria-hidden />
                    </span>
                    <div>
                      <p className="text-label text-ember uppercase">{persona.role}</p>
                      <p className="font-display text-base font-semibold text-ink">{persona.name}</p>
                    </div>
                  </div>

                  <p className="mt-5 text-xs font-medium tracking-wide text-ink-subtle uppercase">
                    {persona.interface}
                  </p>

                  <dl className="mt-5 flex flex-1 flex-col gap-4 border-t border-line pt-5">
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
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section spacing="lg" tone="ink">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <SectionHeader
              tone="inverse"
              eyebrow="No payments, no accounts"
              title="Three live surfaces, ready to open"
              description="The diner view is bound to a table token. The kitchen and floor boards sit behind the staff PIN."
            />

            <div className="flex flex-col gap-3">
              {productLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="group flex items-center justify-between gap-4 rounded-lg border border-ink-inverse/15 bg-ink-inverse/5 px-5 py-4 transition-colors duration-[var(--duration-fast)] hover:border-ember hover:bg-ink-inverse/10"
                >
                  <span className="font-display text-base font-semibold text-ink-inverse">
                    {link.label}
                  </span>
                  <span className="text-sm text-ember transition-transform duration-[var(--duration-fast)] group-hover:translate-x-1">
                    →
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </Container>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------
   Hero visual: the kitchen board, rendered from the same status
   tokens the real board uses. Because it is built from tokens rather
   than a screenshot, it can never drift away from the product.
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
    <div className="relative mx-auto w-full max-w-md">
      {/* Offset plate: gives the panel depth without a heavy shadow. */}
      <div
        aria-hidden
        className="absolute inset-x-6 -bottom-3 h-full rounded-xl border border-line bg-surface-sunken"
      />

      <div className="relative overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lg">
        <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/70 px-4 py-3">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-pill bg-line-strong" />
            <span className="size-2.5 rounded-pill bg-line-strong" />
            <span className="size-2.5 rounded-pill bg-line-strong" />
          </span>
          <span className="ml-1.5 text-[0.6875rem] font-semibold tracking-[0.14em] text-ink-subtle uppercase">
            Kitchen display
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-pill bg-ready-surface px-2.5 py-1 text-[0.6875rem] font-semibold tracking-wide text-ready uppercase">
            <span aria-hidden className="size-1.5 rounded-pill bg-ready" />
            Live
          </span>
        </div>

        <div className="flex flex-col gap-3 bg-surface-sunken/50 p-3.5 sm:p-4">
          {miniTickets.map((ticket) => (
            <div
              key={ticket.table}
              className="relative overflow-hidden rounded-lg border border-line bg-paper p-4 shadow-sm"
            >
              <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${ticket.rail}`} />

              <div className="flex items-center justify-between gap-3 pl-1.5">
                <span className="font-display text-sm font-semibold text-ink">{ticket.table}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[0.6875rem] text-ink-subtle">{ticket.elapsed}</span>
                  <Badge tone={ticket.tone}>{ticket.status}</Badge>
                </span>
              </div>

              <ul className="mt-3 flex flex-col gap-1 pl-1.5">
                {ticket.lines.map((line) => (
                  <li key={line} className="text-sm text-ink-muted">
                    {line}
                  </li>
                ))}
              </ul>

              {ticket.allergy ? (
                <p className="mt-3 ml-1.5 flex items-center gap-1.5 rounded-md border border-alert/40 bg-alert-surface px-2.5 py-1.5 text-xs font-bold tracking-wide text-alert uppercase">
                  <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                  {ticket.allergy}
                </p>
              ) : null}

              <span
                className={`mt-3.5 ml-1.5 flex h-9 items-center justify-center rounded-md text-sm font-semibold ${ticket.actionClass}`}
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
