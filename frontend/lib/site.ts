export interface NavLink {
  label: string;
  href: string;
}

/** Section anchors on the landing page. */
export const marketingNav: NavLink[] = [
  { label: "The problem", href: "#problem" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Innovations", href: "#innovations" },
  { label: "MVP features", href: "#features" },
  { label: "Who it's for", href: "#personas" },
];

/** The three documented surfaces. `k7x2p` is the example QR token from the spec. */
export const productLinks: NavLink[] = [
  { label: "Diner menu & cart", href: "/table/k7x2p" },
  { label: "Kitchen board", href: "/kitchen" },
  { label: "Floor view", href: "/floor" },
];

export const demoTableToken = "k7x2p";
