/**
 * Joins class names, dropping falsy values.
 *
 * Deliberately not `tailwind-merge`: the UI primitives express every
 * conflicting utility (colour, padding, radius, font size) as a `variant` /
 * `size` / `tone` prop, so a caller's `className` only ever carries layout
 * utilities — margin, width, flex, grid placement — which cannot collide with
 * the base classes. Keep it that way and no merge step is needed.
 */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
