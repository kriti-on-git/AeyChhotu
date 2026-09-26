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
import { LandscapeScene } from "@/components/landscape/landscape-scene";
import { OrganicShape } from "@/components/landscape/organic-shape";
import { SectionDivider } from "@/components/landscape/section-divider";
import { Reveal } from "@/components/motion/reveal";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function LandingPage() {
  return (
    <>
      <section className="relative isolate overflow-hidden">
        <LandscapeScene />

        <Container className="relative z-10 flex min-h-[88svh] flex-col justify-center pt-16 pb-44 sm:pb-40">
          <Reveal className="max-w-3xl">
            <Badge tone="outline" className="bg-cream/70">
              Zero download · no logins · live updates
            </Badge>
          </Reveal>

          <Reveal delay={0.06} className="mt-6 max-w-3xl">
            <h1 className="text-display font-display font-semibold text-balance text-ink">
              Every phone at the table.
              <br className="hidden sm:block" /> One ticket for the kitchen.
            </h1>
          </Reveal>

          <Reveal delay={0.12} className="mt-6 max-w-2xl">
            <Text variant="lead" tone="muted">
              AeyChhotu is a zero-download, real-time operational bridge that groups individual
              table requests into a single unified cart and provides two-way live status updates
              between diners and the kitchen.
            </Text>
          </Reveal>

          <Reveal delay={0.18} className="mt-10">
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={`/table/${demoTableToken}`}
                className={buttonStyles({ variant: "primary", size: "lg" })}
              >
                Open the diner view
              </Link>
              <Link href="/kitchen" className={buttonStyles({ variant: "secondary", size: "lg" })}>
                Kitchen board
              </Link>
              <a href="#how-it-works" className={buttonStyles({ variant: "ghost", size: "lg" })}>
                How it works
              </a>
            </div>
          </Reveal>

          <Reveal delay={0.24} className="mt-6">
            <Text variant="caption" tone="subtle">
              Table {demoTableToken} is a live demo link. Staff screens are behind the shared kitchen
              PIN.
            </Text>
          </Reveal>
        </Container>
      </section>

      <Section id="problem" spacing="lg" tone="surface" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="Gap analysis"
            title="QR ordering removed the typing errors and created three new ones"
            description="Toast, Square, me&u and Mr Yum all stop manual order entry. These are the gaps they leave behind in a rush."
          />

          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {gaps.map((gap, index) => (
              <Reveal key={gap.title} delay={index * 0.08}>
                <Card tone="canvas" className="h-full">
                  <CardHeader>
                    <Badge tone="pending">Gap {index + 1}</Badge>
                    <CardTitle className="mt-3">{gap.title}</CardTitle>
                    <CardDescription>{gap.friction}</CardDescription>
                  </CardHeader>
                  <Text variant="small" tone="alert" className="mt-5 border-t border-line pt-5">
                    {gap.complaint}
                  </Text>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="how-it-works" spacing="lg" className="relative scroll-mt-20 overflow-hidden">
        <OrganicShape
          variant="blob"
          className="absolute -top-24 -left-32 h-80 w-80 text-beige/60"
        />
        <Container className="relative">
          <SectionHeader
            eyebrow="The workflow"
            title="From the first scan to a green screen"
            description="One table session spans three surfaces: the diner's browser, the kitchen board and the floor view."
          />

          <ol className="mt-14 flex flex-col gap-4">
            {steps.map((step, index) => (
              <Reveal key={step.title} delay={index * 0.06}>
                <li className="grid gap-4 rounded-lg border border-line bg-surface p-6 sm:grid-cols-[auto_1fr] sm:items-start sm:gap-6">
                  <span className="flex size-11 items-center justify-center rounded-pill bg-dark-brown font-display text-lg text-cream">
                    {index + 1}
                  </span>
                  <div className="flex flex-col gap-2">
                    <h3 className="font-display text-subheading text-ink">{step.title}</h3>
                    <Text variant="small" tone="muted" className="max-w-2xl">
                      {step.body}
                    </Text>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
        </Container>
      </Section>

      <SectionDivider fill="text-dark-brown" />

      <Section id="innovations" spacing="lg" tone="ink" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="Why it is different"
            title="Three things the incumbents do not do"
            description="The MVP exists to close these three gaps — everything else is deliberately out of scope."
          />

          <div className="mt-14 grid gap-6 lg:grid-cols-3">
            {innovations.map((item, index) => (
              <Reveal key={item.title} delay={index * 0.08}>
                <Card tone="outline" className="h-full border-cream/20 bg-cream/5 text-cream">
                  <item.icon className="size-6 text-tan" aria-hidden />
                  <h3 className="mt-5 font-display text-subheading text-cream">{item.title}</h3>
                  <Text variant="small" tone="inverse" className="mt-3 opacity-85">
                    {item.innovation}
                  </Text>
                  <Text variant="small" tone="inverse" className="mt-4 border-t border-cream/15 pt-4 opacity-70">
                    {item.impact}
                  </Text>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <SectionDivider fill="text-canvas" />

      <Section id="features" spacing="lg" className="scroll-mt-20">
        <Container>
          <SectionHeader
            eyebrow="MVP scope"
            title="What ships, feature by feature"
            description="Ten capabilities, all of them built around protecting kitchen pacing and keeping guests informed."
          />

          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, index) => (
              <Reveal key={feature.title} delay={(index % 3) * 0.06}>
                <Card interactive className="h-full">
                  <span className="flex size-10 items-center justify-center rounded-md bg-beige/70 text-brown">
                    <feature.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-5 font-display text-subheading text-ink">{feature.title}</h3>
                  <Text variant="small" tone="muted" className="mt-2">
                    {feature.body}
                  </Text>
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

          <div className="mt-14 grid gap-6 lg:grid-cols-3">
            {personas.map((persona, index) => (
              <Reveal key={persona.role} delay={index * 0.08}>
                <Card tone="canvas" className="h-full">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-pill bg-dark-brown text-cream">
                      <persona.icon className="size-5" aria-hidden />
                    </span>
                    <div>
                      <p className="text-label text-ink-muted uppercase">{persona.role}</p>
                      <p className="font-display text-base text-ink">{persona.name}</p>
                    </div>
                  </div>

                  <Badge tone="outline" className="mt-5">
                    {persona.interface}
                  </Badge>

                  <dl className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
                    {[
                      ["Goal", persona.goal],
                      ["Biggest pain", persona.pain],
                      ["Value metric", persona.metric],
                    ].map(([term, description]) => (
                      <div key={term}>
                        <dt className="text-label text-ink-subtle uppercase">{term}</dt>
                        <dd className="mt-1 text-sm leading-relaxed text-ink-muted">{description}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section spacing="lg" className="relative overflow-hidden">
        <Container className="relative">
          <div className="rounded-2xl border border-line bg-surface p-8 sm:p-12 lg:p-16">
            <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
              <div className="flex flex-col gap-5">
                <SectionHeader
                  eyebrow="Deliberately out of scope"
                  title="No payments. No accounts."
                  description="Diners pay the waiter through the house POS, and a guest's physical table is their authorisation token. AeyChhotu manages operations, not transactions."
                />
              </div>

              <div className="flex flex-col gap-3">
                {productLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={buttonStyles({
                      variant: link.href === "/kitchen" ? "outline" : "primary",
                      size: "lg",
                      fullWidth: true,
                    })}
                  >
                    {link.label}
                  </Link>
                ))}
                <Text variant="caption" tone="subtle" className="mt-1">
                  The kitchen and floor screens ask for the shared staff PIN.
                </Text>
              </div>
            </div>
          </div>
        </Container>
      </Section>
    </>
  );
}
