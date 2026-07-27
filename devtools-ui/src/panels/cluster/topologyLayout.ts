/**
 * Node placement for the cluster topology.
 *
 * A ring, not a force-directed simulation.  Force layouts earn their
 * complexity when the edges carry information; here every node gossips
 * with every other, so the graph is complete and a simulation would
 * only produce a slowly-settling circle anyway — with the added
 * downside that nodes move between frames, making a cluster hard to
 * read at a glance.  A ring is deterministic: the same membership
 * always draws the same picture.
 */

/** A placed node in SVG user units. */
export interface PlacedNode {
  readonly x: number;
  readonly y: number;
}

/**
 * Place `count` nodes evenly on a circle, starting at twelve o'clock
 * and going clockwise.
 */
export function ringLayout(
  count: number,
  centerX: number,
  centerY: number,
  radius: number,
): ReadonlyArray<PlacedNode> {
  if (count <= 0) return [];
  // A lone node belongs in the middle; a ring of one is just an
  // off-centre dot with no circle to imply.
  if (count === 1) return [{ x: centerX, y: centerY }];

  const step = (Math.PI * 2) / count;
  const out: PlacedNode[] = [];
  for (let index = 0; index < count; index++) {
    const angle = -Math.PI / 2 + step * index;
    out.push({
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  }
  return out;
}
