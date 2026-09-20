/**
 * Where the dashes go along a segment `span` long: `count` dashes of `length`
 * with `gap` between them, the pattern centred so both ends of the segment look
 * the same. `centers` are distances from the start of the segment.
 *
 * A segment shorter than one dash gets a single dash covering all of it, so two
 * picked atoms are always visibly joined.
 */
export function dashLayout(
  span: number,
  dash: number,
  gap: number,
): { length: number; centers: number[] } {
  if (!(span > 0)) return { length: 0, centers: [] };
  const count = Math.max(1, Math.floor((span + gap) / (dash + gap)));
  const length = Math.min(dash, span);
  const used = count * length + (count - 1) * gap;
  const first = (span - used) / 2 + length / 2;
  return {
    length,
    centers: Array.from({ length: count }, (_, n) => first + n * (length + gap)),
  };
}
