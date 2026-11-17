// Road network of the Travel map: snap a point to the nearest road and follow roads between snapped points.
// No DOM here; the data (data/roads.json) is passed in.

export const SVG_TO_PX = 4763 / 3055.4079; // the network is in the vector map's units; the app works in map-image pixels
const STEP = 8; // px between vertices after densifying, so a click on a road always has one close by

export function buildGraph(data, k = SVG_TO_PX) {
  const index = new Map(data.nodes.map((n, i) => [n.id, i]));
  const verts = data.nodes.map((n) => [n.x * k, n.y * k]);
  const adj = verts.map(() => []);
  const link = (a, b) => {
    const d = Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1]);
    adj[a].push([b, d]);
    adj[b].push([a, d]);
  };
  for (const e of data.edges) {
    const pts = e.path.map((p) => [p[0] * k, p[1] * k]);
    let prev = index.get(e.a);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
      for (let j = 1; j <= n; j++) {
        let v = index.get(e.b);
        if (i < pts.length - 1 || j < n) { v = verts.length; verts.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n]); adj.push([]); }
        link(prev, v);
        prev = v;
      }
    }
  }
  return { verts, adj };
}

/** Index of the vertex closest to p within max px, or -1. */
export function nearest(g, p, max) {
  let best = -1;
  let bd = max * max;
  for (let i = 0; i < g.verts.length; i++) {
    const dx = g.verts[i][0] - p[0];
    const dy = g.verts[i][1] - p[1];
    const d = dx * dx + dy * dy;
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}

/** Shortest path along the network as vertex indexes, or null when a and b are not connected. */
export function shortest(g, a, b) {
  const dist = new Float64Array(g.verts.length).fill(Infinity);
  const prev = new Int32Array(g.verts.length).fill(-1);
  const heap = [[0, a]];
  dist[a] = 0;
  while (heap.length) {
    // pop the smallest (binary heap)
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
        if (heap[c][0] >= last[0]) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    const [d, u] = top;
    if (d > dist[u]) continue;
    if (u === b) break;
    for (const [v, w] of g.adj[u]) {
      const nd = d + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        let i = heap.push([nd, v]) - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= nd) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      }
    }
  }
  if (dist[b] === Infinity) return null;
  const path = [];
  for (let v = b; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

const length = (line) => line.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - line[i][0], p[1] - line[i][1]), 0);

/**
 * Turns waypoints into legs. A waypoint is [x, y] or [x, y, vertex] when it sits on the network.
 * Two consecutive on-network waypoints follow the roads; any other pair is a straight off-road line.
 * `gaps` counts on-network pairs that the network does not connect.
 */
export function trace(g, pts, useRoads = true) {
  const out = { legs: [], roadPx: 0, offPx: 0, gaps: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    let ids = null;
    if (g && useRoads && a[2] >= 0 && b[2] >= 0) { ids = shortest(g, a[2], b[2]); if (!ids) out.gaps++; }
    const line = ids ? ids.map((v) => g.verts[v]) : [[a[0], a[1]], [b[0], b[1]]];
    const px = length(line);
    out.legs.push({ road: !!ids, line, px });
    out[ids ? 'roadPx' : 'offPx'] += px;
  }
  return out;
}
