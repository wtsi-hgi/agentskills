---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces that avoid generic AI aesthetics. Use when building web components, pages, dashboards, or styling web UI.
---

Build distinctive, production-grade frontend interfaces. Implement real working
code with exceptional aesthetic attention.

## Design Thinking

Before coding, commit to a BOLD aesthetic direction:

- **Purpose/audience.** What problem does this interface solve?
- **Tone.** Pick a strong direction: brutally minimal, maximalist, retro-
  futuristic, organic, luxury, playful, editorial, brutalist, art deco, soft
  pastel, industrial, etc. Use for inspiration but make it your own.
- **Differentiation.** What makes this UNFORGETTABLE?

Execute with precision. Bold maximalism and refined minimalism both work - the
key is intentionality.

## Aesthetics

- **Typography:** Distinctive, characterful fonts. NEVER generic (Arial, Inter,
  Roboto, system fonts). Pair a display font with a refined body font.
- **Color:** Cohesive palette via CSS variables. Dominant colors with sharp
  accents > timid, evenly-distributed palettes.
- **Motion:** CSS-first animations; Motion library for React. Focus on high-
  impact moments (staggered page-load reveals, surprising hover states).
- **Layout:** Asymmetry, overlap, diagonal flow, grid-breaking elements,
  generous negative space OR controlled density.
- **Atmosphere:** Gradient meshes, noise textures, geometric patterns, layered
  transparencies, dramatic shadows, decorative borders, grain overlays.

NEVER: overused fonts, cliche purple-on-white gradients, predictable layouts,
cookie-cutter components. No two designs should look the same. Vary themes,
fonts, aesthetics across generations.

Match implementation complexity to vision: maximalist needs elaborate code;
minimalist needs restraint and precision.

## Project Integration

When building for a specific project, also read the project's conventions skill
for tech stack, component patterns, and styling rules.

## Visual Verification

- For UI changes where success is perceptual, verify the rendered result in a
  real browser. Source CSS checks, class-name checks, and jsdom computed styles
  are not enough on their own.
- Test light/dark modes through the same mechanism the application uses in
  production. With Tailwind v4, confirm generated utilities and theme variables
  actually respond at runtime before tuning colours or specificity.
- Prefer screenshot or focused pixel/contrast assertions for borders, focus
  rings, selection states, hover states, and animation end states. Compare the
  visible element against its own fill and nearby surfaces, not just token names
  or raw CSS declarations.
