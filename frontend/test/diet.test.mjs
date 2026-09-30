import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The diet filters decide what a guest is offered before they order, so the
   classification is pinned here: the seed must give every filter something to
   find, and the categories must stay mutually honest (egg dishes are never
   claimed as veg, Jain dishes are never claimed as containing root veg). */

import { seedMenu } from "../lib/api/seed.ts";
import { DIET_FILTERS, hasEgg, isJain, matchesDiet } from "../lib/diner/diet.ts";

const byName = (name) => seedMenu.find((item) => item.name === name);

describe("matchesDiet over the seeded menu", () => {
  it("gives every filter at least one dish, so the bar never dead-ends", () => {
    for (const option of DIET_FILTERS) {
      const count = seedMenu.filter((item) => matchesDiet(item, option.id)).length;
      assert.ok(count > 0, `${option.label} found nothing`);
    }
  });

  it("treats \"all\" as everything", () => {
    assert.equal(seedMenu.filter((item) => matchesDiet(item, "all")).length, seedMenu.length);
  });

  it("separates veg from non-veg with no dish in both", () => {
    for (const item of seedMenu) {
      const veg = matchesDiet(item, "veg");
      const nonVeg = matchesDiet(item, "non-veg");
      assert.notEqual(veg, nonVeg, item.name);
    }
  });

  it("never counts an egg dish as plain veg", () => {
    assert.equal(matchesDiet(byName("Egg Dosa"), "egg"), true);
    assert.equal(matchesDiet(byName("Egg Dosa"), "veg"), false);
    assert.equal(matchesDiet(byName("Egg Fried Rice"), "egg"), true);
    assert.equal(matchesDiet(byName("Egg Curry"), "egg"), true);
  });

  it("keeps Jain inside veg and off anything with a root vegetable", () => {
    for (const item of seedMenu) {
      if (matchesDiet(item, "jain")) assert.equal(matchesDiet(item, "veg"), true, item.name);
    }
    // Potato and onion are the honest disqualifiers.
    assert.equal(matchesDiet(byName("Masala Dosa"), "jain"), false);
    assert.equal(matchesDiet(byName("Onion Uttapam"), "jain"), false);
    assert.equal(matchesDiet(byName("Idli Sambar"), "jain"), true);
  });

  it("reads egg out of a dish's own words", () => {
    assert.equal(hasEgg({ name: "Anda Bhurji", description: "", category: "" }), true);
    assert.equal(hasEgg({ name: "Masala Dosa", description: "", category: "" }), false);
    assert.equal(isJain({ name: "Garlic Naan", description: "", category: "", vegetarian: true }), false);
  });
});
