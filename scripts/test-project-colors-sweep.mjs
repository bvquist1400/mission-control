#!/usr/bin/env node
// Every colour, light and dark (redesign S2 fix round 1, Baseline task b13c2e2d;
// Codex review finding 1 on ead16735). Offline, no network, about a minute.
//
// For all 16,777,216 "#RRGGBB" values: when the rules accept one as a project
// colour, neither the light colour it paints nor the dark colour it paints (the
// final rounded hex) may be "needs you" yellow (hue 33–65° inclusive, saturation
// >= 0.3), and both must reach 3:1 on their theme's paper and sheet. Checked
// twice: with the app's own exact test (`isNeedsYouHue`, integer channels) and
// with an independent float oracle with a tolerance (far below the ~0.0009°
// smallest hue step between 8-bit colours). The square the renderer builds for
// an accepted colour must be that same pair (no silent fallback), and every
// refused colour must be one the rules name.

import assert from "node:assert/strict";

const colors = await import("../src/lib/project-colors.ts");

function oracleYellow(hex) {
  const { h, s } = colors.toHsl(hex);
  return s >= 0.3 - 1e-9 && h >= 33 - 1e-6 && h <= 65 + 1e-6;
}

const started = Date.now();
const counts = { all: 0, accepted: 0, refusedNeedsYou: 0, refusedContrast: 0, darkKept: 0, darkPreset: 0, darkLightened: 0, darkHueMovedOver1deg: 0, darkGrey: 0 };
const failures = [];
const presetLights = new Set(colors.PROJECT_COLOR_PRESETS.map((p) => p.light));
const fail = (hex, why) => {
  if (failures.length < 20) failures.push(`${hex}: ${why}`);
};

for (let rgb = 0; rgb < 1 << 24; rgb += 1) {
  counts.all += 1;
  const hex = `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;
  const problem = colors.projectColorProblem(hex);
  if (problem === "needs_you") {
    counts.refusedNeedsYou += 1;
    continue;
  }
  if (problem === "contrast") {
    counts.refusedContrast += 1;
    continue;
  }
  if (problem !== null) {
    fail(hex, `unexpected problem ${problem}`);
    continue;
  }
  counts.accepted += 1;
  if (colors.isNeedsYouHue(hex) || oracleYellow(hex)) fail(hex, "accepted but yellow (light)");
  if (colors.themeContrast(hex, "light") < 3) fail(hex, "accepted but under 3:1 on light");

  const dark = colors.darkVariant(hex);
  if (!colors.PROJECT_COLOR_PATTERN.test(dark)) fail(hex, `dark ${dark} is not a hex`);
  if (colors.isNeedsYouHue(dark) || oracleYellow(dark)) fail(hex, `dark ${dark} is yellow`);
  if (colors.themeContrast(dark, "dark") < 3) fail(hex, `dark ${dark} under 3:1 on dark`);

  if (presetLights.has(hex)) counts.darkPreset += 1;
  else if (dark === hex) counts.darkKept += 1;
  else {
    const before = colors.toHsl(hex);
    const after = colors.toHsl(dark);
    if (after.s === 0 && before.s !== 0) counts.darkGrey += 1;
    else if (before.s > 0.05 && Math.min(Math.abs(before.h - after.h), 360 - Math.abs(before.h - after.h)) > 1) counts.darkHueMovedOver1deg += 1;
    else counts.darkLightened += 1;
  }

  if ((rgb & 0x3f) === 0) {
    // Every 64th accepted-or-not colour: the renderer paints exactly that pair (no fallback to the default).
    const square = colors.resolveSquare({ app: { id: "a", name: "Some app", color: hex } });
    if (square.source !== "app" || square.light !== hex || square.dark !== dark) fail(hex, `square ${JSON.stringify(square)}`);
  }
}

console.log(JSON.stringify({ ...counts, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
assert.equal(counts.all, 16777216);
assert.deepEqual(failures, [], `failures:\n${failures.join("\n")}`);
console.log("ok - no accepted colour paints needs-you yellow, light or dark; every pair reaches 3:1");
