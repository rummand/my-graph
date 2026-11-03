# My Graph design

My Graph is where a family keeps its life: who the people are, what is coming, and where every fact came from.
It is an app people work in (Operate mode) with one reading surface (wiki, Read mode). The old look, a grey
admin kit of identical outlined white boxes, is gone. Do not bring any of it back.

## The idea

**The family is the interface.** Each person in the household has their own colour, and that colour carries them
everywhere: their avatar, their timeline lane, their chips in an answer, their column in the week. A parent
should be able to glance at any screen and see *whose* thing each item is before reading a word.

The second idea is **provenance you can touch**. Every fact has a source. Sources show as small citation
marks in cobalt, the one hue the chrome is allowed to use, so "where did this come from?" is always one
click away and always looks the same.

Everything else is quiet: one typeface, flat surfaces, structure from space and tone instead of boxes.

## Tokens (all in `src/app/globals.css`, use the Tailwind names)

| Role | Light | Dark | Tailwind |
| --- | --- | --- | --- |
| Ground (page) | `#F1F3EF` lichen | `#121513` | `bg-bg` |
| Surface (raised area) | `#FFFFFF` | `#1A1E1B` | `bg-surface` |
| Sunken / hover | `#E7EAE5` | `#232824` | `bg-surface-2` |
| Ink (text, primary buttons) | `#17201C` | `#E8ECE9` | `text-fg`, `bg-fg` |
| Muted text | `#5B6660` | `#99A39D` | `text-muted` |
| Line (only where a line carries meaning) | `#DCE0DA` | `#2C322E` | `border-line` |
| Cobalt: links, focus, provenance, the one data hue | `#2F4BB0` | `#8FA3F0` | `text-accent`, `bg-accent`, `bg-accent-tint` |
| Warn / danger / inferred | amber, brick, plum | | `text-warn`, `text-danger`, `text-inferred` |

**People colours.** `personHue(id)` in `src/lib/ui/person-color.ts` gives every person a stable hue. Use
`<Avatar>` and `<PersonChip>` from `src/components/ui`; never colour a person by hand. Tints stay pale; the
saturated version is used only for a person's own lane line or dot.

**Type.** One family: Schibsted Grotesk (`font-sans`), loaded with `next/font`. Wiki page bodies use Literata
(`font-read`) because they are read, not scanned. Five sizes, far apart:

- `text-[28px]/[1.15] font-semibold tracking-[-0.02em]`: page title (one per page, about five words)
- `text-lg font-semibold`: section heading
- `text-[15px]`: body (the default, set on body)
- `text-sm`: secondary
- `text-xs`: metadata only

Numbers in tables and times use `tabular-nums`. No monospace anywhere except code. No all-caps labels, no
tracked uppercase eyebrows, no "01 / 02" numbering, no "A · B · C" strings of metadata.

**Shape.** Radius `rounded-lg` (8px) for surfaces, `rounded-md` (6px) for controls, `rounded-full` for people and
chips. No drop shadows except floating layers (menus, drawers, dialogs: `shadow-float`).

**Surfaces.** Separate by tone, not by outline. A section sits on the ground with a heading; a group that needs a
container uses `bg-surface` with no border. Borders are for inputs, tables (horizontal rules only) and the one
selected item. Never wrap a whole page section in an outlined box. Never put identical cards in a row as decoration.

**Colour budget.** Chrome is ink and grey. Colour goes on people (their hues), on data (cobalt), and on state
(amber for "needs a decision", brick for errors, plum for inferred). Under 5% of pixels are coloured on a normal
screen.

## Shell

Left rail on desktop (on the ground, no border): the My Graph mark and household name, an "Ask anything" field
that opens the assistant with the question, the navigation with icons and labels, and the signed-in person at
the bottom. The active item is a white surface pill with ink text. On phones, a bottom bar with Today, Ask,
People, Timeline and More.

## Motion (the `motion` package, `motion/react`)

Motion answers what a person did: a drawer slides in from where it opens, a new message appears, a checked
reminder collapses away, a filter change reflows the list (`layout`). Durations 150–250ms, ease-out
(`[0.22, 1, 0.36, 1]`). No entrance animations on page load, no hover lift on cards, no bounce, no infinite loops.
Respect `prefers-reduced-motion` (`MotionConfig reducedMotion="user"` is set in the shell).

## Copy

Plain, specific, sentence case, from the parent's point of view. Buttons name the action ("Add reminder", not
"Submit"). Empty states say what will appear here and offer the one action that fills it. Use the family's own
words: "Emma's school", "permission slip", "Aula letter", never "items", "records" or "entities".

## Components (`src/components/ui`)

`Button` (primary = ink, secondary = surface, ghost, danger), `IconButton`, `Input`, `Textarea`, `Select`,
`Field` (label + hint + error), `Section` (heading + optional action + content, no box), `Panel` (bg-surface, no
border), `PageHeader`, `EmptyState`, `Avatar`, `PersonChip`, `NodeChip`, `CitationChip`, `Tabs`, `Badge`,
`Kbd`. Use them; if one is missing, add it there rather than styling a one-off.

## Checks before a screen is done

Screenshot it at 1440×900 and 390×844, light and dark. Every block the page is for shows above the fold on
desktop. Keyboard focus is visible. Nothing is centred except empty states. No outlined box wraps a whole section.
