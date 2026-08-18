// Reject wall runs that occupy the same space over a large area.
//
// Two runs meeting at a corner overlap by a corner cell (0.2 x 0.2). That is
// fine and unavoidable: the coincident faces are buried inside solid geometry
// where nothing can see them.
//
// Two PARALLEL runs sharing a z (or x) and overlapping along their length are
// a different thing entirely. Their large faces are coplanar and BOTH visible,
// so the depth buffer cannot decide between them and the surface shimmers
// between the two as the camera moves. That is what produced the grey
// flickering slab across the courtyard's north wall at balcony height:
// `courtyard_north` (y 0-4.5) and the two balcony drop walls (then y 2.9-6.1)
// were stacked in the same 0.4m-thick plane over 8m and 4m spans.
//
// The threshold is deliberately generous. Anything sharing more than a corner
// cell in two dimensions at once is a modelling mistake, not a tolerance.
import assert from 'node:assert';
import { MAP_WALL_RUNS } from '../js/map-layout.js';

const WALL_T = 0.4;                 // must match map.js
const CORNER = WALL_T + 0.01;       // a legitimate corner overlap is at most this

const boxes = MAP_WALL_RUNS.map((w) => {
  const horiz = Math.abs(w.z2 - w.z1) < 0.001;
  const y0 = w.y0 || 0;
  return {
    id: w.id,
    minX: horiz ? Math.min(w.x1, w.x2) : w.x1 - WALL_T / 2,
    maxX: horiz ? Math.max(w.x1, w.x2) : w.x1 + WALL_T / 2,
    minZ: horiz ? w.z1 - WALL_T / 2 : Math.min(w.z1, w.z2),
    maxZ: horiz ? w.z1 + WALL_T / 2 : Math.max(w.z1, w.z2),
    minY: y0, maxY: y0 + w.h,
  };
});

const span = (a, b, k) => Math.min(a[`max${k}`], b[`max${k}`]) - Math.max(a[`min${k}`], b[`min${k}`]);

const bad = [];
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const x = span(a, b, 'X'), y = span(a, b, 'Y'), z = span(a, b, 'Z');
    if (x <= 0.002 || y <= 0.002 || z <= 0.002) continue;   // not intersecting
    // A corner is small in BOTH horizontal axes. A stacked parallel run is
    // large in one of them while still overlapping vertically.
    if (x <= CORNER && z <= CORNER) continue;
    bad.push(`${a.id} <-> ${b.id}: overlap ${x.toFixed(2)} x ${y.toFixed(2)} x ${z.toFixed(2)} m`);
  }
}

assert.deepEqual(bad, [],
  `wall runs overlapping over a large area (these z-fight into a shimmering slab):\n  ${bad.join('\n  ')}`);

console.log(`wall overlaps OK (${boxes.length} runs, corner joins only)`);
