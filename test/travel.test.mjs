import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeMiles, daysFor, applyDay, MI_PER_PX } from '../js/travel.js';
import { buildGraph, nearest, shortest, trace } from '../js/roads.js';

const trip = () => ({ method: 'riding', travelers: 2, mounts: 2, day: 0, total: 5, gp: 0, xp: 0, inspiration: 0, events: [],
  supplies: [{ k: 'food', name: 'Rações', qty: 10 }, { k: 'water', name: 'Água', qty: 1 }, { k: 'feed', name: 'Ração', qty: 10 }, { name: 'Corda', qty: 1 }] });

test('distance follows the map scale', () => {
  assert.equal(MI_PER_PX, 0.8);
  assert.equal(routeMiles([[0, 0], [300, 400], [300, 500]]), 480); // 600 px
  assert.equal(routeMiles([[5, 5]]), 0);
});
test('days add road and off-road fractions, then round up once', () => {
  assert.equal(daysFor(32, 24, 32, 24), 2); // a day of road + a day off-road, on foot
  assert.equal(daysFor(16, 12, 32, 24), 1); // half a day of each
  assert.equal(daysFor(16, 13, 32, 24), 2);
  assert.equal(daysFor(65, 0, 32, 24), 3);
  assert.equal(daysFor(0, 48, 32, 24), 2);
  assert.equal(daysFor(10, 0, 0, 24), 0); // no pace, no answer
});
test('a quiet day only eats supplies', () => {
  const t = trip();
  const e = applyDay(t, 3, 1);
  assert.equal(e.text, undefined);
  assert.deepEqual(t.supplies.map((s) => s.qty), [8, 0, 8, 1]);
  assert.deepEqual([t.day, t.total], [1, 5]);
});
test('events change the journey', () => {
  const t = trip();
  applyDay(t, 6, 1); assert.equal(t.total, 6); // delay
  applyDay(t, 8, 2); assert.equal(t.total, 5); // shortcut
  applyDay(t, 7, 1); assert.equal(t.gp, -20);
  applyDay(t, 7, 2); assert.equal(t.xp, 25);
  applyDay(t, 10, 2); assert.equal(t.inspiration, 1);
  applyDay(t, 6, 2); assert.equal(t.supplies[0].qty, 1); // 10 - 6 days * 2 = 0, then +1 ration
  assert.equal(t.day, 6);
});
test('a shortcut never ends the travel before today', () => {
  const t = { ...trip(), day: 4, total: 5 };
  applyDay(t, 8, 2);
  assert.deepEqual([t.day, t.total], [5, 5]);
});

// A bent road 0 → 1 → 2 (100 + 100 units) and a separate road 3 → 4.
const toy = { nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 100, y: 0 }, { id: 2, x: 100, y: 100 }, { id: 7, x: 500, y: 500 }, { id: 8, x: 600, y: 500 }],
  edges: [{ a: 0, b: 1, path: [[0, 0], [100, 0]] }, { a: 1, b: 2, path: [[100, 0], [100, 100]] }, { a: 7, b: 8, path: [[500, 500], [600, 500]] }] };

test('routes follow the road instead of the straight line', () => {
  const g = buildGraph(toy, 1);
  const a = nearest(g, [1, 2], 5);
  const b = nearest(g, [99, 101], 5);
  assert.deepEqual([g.verts[a], g.verts[b]], [[0, 0], [100, 100]]);
  const r = trace(g, [[0, 0, a], [100, 100, b], [300, 100]]);
  assert.equal(Math.round(r.roadPx), 200); // around the bend, not the 141 diagonal
  assert.equal(r.offPx, 200); // the last waypoint is off the network
  assert.deepEqual(r.legs.map((l) => l.road), [true, false]);
});
test('clicks far from a road do not snap, and densified roads snap mid-way', () => {
  const g = buildGraph(toy, 1);
  assert.equal(nearest(g, [50, 40], 10), -1);
  assert.deepEqual(g.verts[nearest(g, [52, 3], 10)].map(Math.round), [54, 0]);
});
test('unconnected road points fall back to a straight off-road leg', () => {
  const g = buildGraph(toy, 1);
  const r = trace(g, [[0, 0, 0], [500, 500, 3]]);
  assert.equal(shortest(g, 0, 3), null);
  assert.deepEqual([r.gaps, r.roadPx, r.legs[0].road], [1, 0, false]);
});
test('methods without roads go straight even between road points', () => {
  const g = buildGraph(toy, 1);
  const r = trace(g, [[0, 0, 0], [100, 100, 2]], false);
  assert.equal(r.roadPx, 0);
  assert.equal(Math.round(r.offPx), 141);
});
test('the real network keeps its miles', () => {
  const data = JSON.parse(readFileSync(new URL('../data/roads.json', import.meta.url)));
  const g = buildGraph(data);
  const e = data.edges.reduce((m, x) => (x.miles > m.miles ? x : m)); // the longest edge
  const ids = shortest(g, data.nodes.findIndex((n) => n.id === e.a), data.nodes.findIndex((n) => n.id === e.b));
  const px = ids.slice(1).reduce((s, v, i) => s + Math.hypot(g.verts[v][0] - g.verts[ids[i]][0], g.verts[v][1] - g.verts[ids[i]][1]), 0);
  assert.ok(px * MI_PER_PX <= e.miles * 1.01); // never longer than the edge itself (a shorter way round is fine)
  const direct = Math.hypot(...[0, 1].map((k) => g.verts[ids[0]][k] - g.verts[ids.at(-1)][k]));
  assert.ok(px >= direct);
});
