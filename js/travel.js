// Travel section: trace a route on the Faerûn map, plan the journey by the table's travel rules,
// post the travel log to Discord and roll the daily "Viagens Agitadas" events.
import { esc, uid, toast, getKey, askKey, sheet, shell, tabs, setStatus } from './sheet.js';
import { isWebhook, BUILT_IN } from './discord.js';
import { buildGraph, nearest, trace } from './roads.js';

const W = 4763;
const H = 3185;
export const MI_PER_PX = 0.8; // the poster is 150 px per inch at 1 inch = 120 miles (its scale bar: 603 px = 480 mi)
const POI_API = ''; // Apps Script web app URL of the points-of-interest sheet (apps-script/travel-pois.gs). Empty = this browser only
const KEY = 'travelKey';
const STORE = 'gilded-travel-v1';

// mi: [road, off-road] or one number when roads don't matter. Costs are copper per day: per traveler / per mount.
export const METHODS = {
  foot: { name: 'On foot', pt: 'A Pé', mi: [32, 24], speed: 30, hours: 8, cost: 55 },
  riding: { name: 'Riding horse (60 ft)', pt: 'Cavalo de Montaria', mi: [64, 52], speed: 60, hours: 8, cost: 55, mountCost: 10 },
  draft: { name: 'Draft horse or mule (40 ft)', pt: 'Cavalo de Carga', mi: [46, 36], speed: 40, hours: 8, cost: 55, mountCost: 10 },
  wagon: { name: 'Wagon', pt: 'Carroça', mi: [40, 28], speed: 40, hours: 8, cost: 55, mountCost: 10 },
  caravan: { name: 'Caravan', pt: 'Caravana', mi: [40, 34], speed: 40, hours: 8, cost: 105 },
  ship: { name: 'Sailing ship', pt: 'Navio Veleiro', mi: 75, speed: 30, hours: 24, cost: 500, mountCost: 100, noFood: true },
  riverDown: { name: 'River boat, downstream', pt: 'Barco Fluvial (descendo o rio)', mi: 60, speed: 25, hours: 24, cost: 300, noFood: true },
  riverUp: { name: 'River boat, upstream', pt: 'Barco Fluvial (subindo o rio)', mi: 45, speed: 20, hours: 24, cost: 300, noFood: true },
  // Not in the table's rules: D&D 2024 pace, speed / 10 miles per hour for 8 hours.
  warhorse: { name: 'Warhorse (60 ft) · 2024', pt: 'Cavalo de Guerra', mi: 48, speed: 60, hours: 8, cost: 55, mountCost: 10 },
  carpet: { name: 'Carpet of Flying (80 ft) · 2024', pt: 'Tapete Voador', mi: 64, speed: 80, hours: 8, cost: 55 },
  broom: { name: 'Broom of Flying (50 ft) · 2024', pt: 'Vassoura Voadora', mi: 40, speed: 50, hours: 8, cost: 55 },
  griffon: { name: 'Griffon (fly 80 ft) · 2024', pt: 'Grifo', mi: 64, speed: 80, hours: 8, cost: 55, mountCost: 10 },
  pegasus: { name: 'Pegasus (fly 90 ft) · 2024', pt: 'Pégaso', mi: 72, speed: 90, hours: 8, cost: 55, mountCost: 10 },
  phantom: { name: 'Phantom Steed (13 mph) · 2024', pt: 'Corcel Fantasma', mi: 104, speed: 130, hours: 8, cost: 55 },
  custom: { name: 'Custom…', pt: '', mi: [32, 24], speed: 30, hours: 8, cost: 55 },
};
// Methods with a road and an off-road pace follow the road network; ships and flyers go in straight lines at one pace.
const usesRoads = (k) => Array.isArray(METHODS[k]?.mi);
const paces = (k) => (usesRoads(k) ? METHODS[k].mi : [METHODS[k].mi, METHODS[k].mi]);

// 1d10 event, then 1d2: 1 = setback, 2 = opportunity. 1-5: nothing happens.
const EVENTS = {
  6: { name: '🌧️ Mau tempo', 1: ['a viagem sofre um atraso de 1 dia.', { delay: 1 }], 2: ['você encontra abrigo com bons frutos e uma rota protegida. Ganha +1 ração.', { ration: 1 }] },
  7: { name: '🗡️ Bandidos na estrada', 1: ['você perde 20 PO durante a abordagem.', { gp: -20 }], 2: ['você supera a ameaça e recebe 25 XP.', { xp: 25 }] },
  8: { name: '🧭 Perdido no caminho', 1: ['você segue pelo caminho errado e perde 1 dia de viagem.', { delay: 1 }], 2: ['você encontra uma passagem mais curta e reduz a viagem em 1 dia.', { cut: 1 }] },
  9: { name: '🗣️ Rumores de estrada', 1: ['você segue um rumor falso e perde 1 dia de viagem.', { delay: 1 }], 2: ['você encontra pedras preciosas que juntas somam 20 PO.', { gp: 20 }] },
  10: { name: '🍺 Uma taverna esquecida', 1: ['a hospedagem é péssima e você perde 1 dia de viagem.', { delay: 1 }], 2: ['é uma ótima hospedagem. Você ganha 1 inspiração heroica.', { insp: 1 }] },
};

export const routeMiles = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) * MI_PER_PX;
/** Days for a route that is part road and part off-road: the fractions of a day add up, then round up once. */
export function daysFor(roadMi, offMi, roadPace, offPace) {
  if ((roadMi > 0 && !(roadPace > 0)) || (offMi > 0 && !(offPace > 0))) return 0;
  return Math.ceil((roadMi > 0 ? roadMi / roadPace : 0) + (offMi > 0 ? offMi / offPace : 0) - 1e-9);
}

/** Advances the travel one day: eats supplies and applies the rolled event. */
export function applyDay(t, d10, d2) {
  t.day += 1;
  if (!METHODS[t.method]?.noFood) for (const s of t.supplies) s.qty = Math.max(0, s.qty - (s.k === 'feed' ? t.mounts : s.k ? t.travelers : 0));
  const ev = EVENTS[d10];
  const e = { day: t.day, d10, name: ev ? ev.name : '🕦 Nada acontece' };
  if (ev) {
    const [text, fx] = ev[d2];
    Object.assign(e, { d2, text });
    if (fx.delay) t.total += fx.delay;
    if (fx.cut) t.total = Math.max(t.day, t.total - fx.cut);
    if (fx.gp) t.gp += fx.gp;
    if (fx.xp) t.xp += fx.xp;
    if (fx.insp) t.inspiration += fx.insp;
    if (fx.ration) { const food = t.supplies.find((s) => s.k === 'food'); if (food) food.qty += fx.ration; }
  }
  t.events.push(e);
  return e;
}

const money = (cp) => [[100, 'gp'], [10, 'sp'], [1, 'cp']].map(([v, u]) => { const n = Math.floor(cp / v); cp -= n * v; return n ? `${n} ${u}` : ''; }).filter(Boolean).join(' ') || '0 gp';
const round = (n) => Math.round(n).toLocaleString('en-US');
const supplyText = (list) => list.filter((s) => s.name && s.qty > 0).map((s) => `${s.qty} ${s.name}`).join(', ') || 'Nenhuma';
// Travels saved before road routing have one pace and a terrain; newer ones have road and off-road miles.
const split = (t) => t.roadMi != null && usesRoads(t.method);
const transport = (t) => `${t.methodName}${t.roadMi == null && usesRoads(t.method) ? (t.terrain === 'off' ? ' (Sem estrada)' : ' (Estrada)') : ''}`;
const paceText = (t, unit) => (split(t) ? `${t.mpd} ${unit} (estrada) · ${t.mpdOff} ${unit} (sem estrada)` : `${t.mpd} ${unit}`);

// ---------- State ----------

let el;
let ctx;
let map;
let line;
let offLine;
let graph = null;
let dots;
let poiLayer;
let tab = 'plan';
let placing = false;
let pois = [];
const newDraft = () => ({
  character: '', player: '', from: '', to: '', method: 'foot', methodName: 'A Pé', speed: 30, hours: 8, mpd: 32, mpdOff: 24, travelers: 1, mounts: 0,
  supplies: [{ k: 'food', name: 'Rações', qty: 0 }, { k: 'water', name: 'Água', qty: 0 }, { k: 'feed', name: 'Ração de Cavalo', qty: 0 }], points: [],
});
let store = { draft: newDraft(), travels: [], settings: { webhook: '', forum: true }, pois: [] };
const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(store)); } catch { /* storage blocked */ } };
const canEdit = () => !POI_API || !!getKey(KEY);
const hook = () => (isWebhook(store.settings.webhook) ? store.settings.webhook.trim() : BUILT_IN.travel || ctx.webhook());

// ---------- Map ----------

const ll = (p) => [-p[1], p[0]]; // image pixel (x, y) to Leaflet's simple CRS

/** The route with its road and off-road miles and the days it takes. Works on a draft or a saved travel. */
function plan(d) {
  const roads = usesRoads(d.method);
  // Snapped waypoints are stored with a flag; their vertex is looked up again so saved routes survive a data update.
  const pts = d.points.map((p) => (p[2] && graph ? [p[0], p[1], nearest(graph, p, 2)] : [p[0], p[1]]));
  const r = trace(graph, pts, roads);
  const roadMi = r.roadPx * MI_PER_PX;
  const offMi = r.offPx * MI_PER_PX;
  return { ...r, roadMi, offMi, miles: roadMi + offMi, days: daysFor(roadMi, offMi, d.mpd, roads ? d.mpdOff : d.mpd) };
}

function drawRoute() {
  const d = store.draft;
  const r = plan(d);
  line.setLatLngs(r.legs.filter((l) => l.road).map((l) => l.line.map(ll)));
  offLine.setLatLngs(r.legs.filter((l) => !l.road).map((l) => l.line.map(ll)));
  dots.clearLayers();
  d.points.forEach((p, i) => {
    const last = i === d.points.length - 1;
    const m = L.circleMarker(ll(p), { radius: i === 0 || last ? 6 : 4, color: '#fff', weight: 2, fillColor: '#b3261e', fillOpacity: 1, interactive: false }).addTo(dots);
    if (last && i > 0) m.bindTooltip(`${round(r.miles)} mi · ${r.days} days`, { permanent: true, direction: 'top', offset: [0, -6] });
  });
  summary(r);
}

function drawPois() {
  poiLayer.clearLayers();
  for (const p of pois) {
    L.circleMarker(ll([p.x, p.y]), { radius: 7, color: '#3a2405', weight: 2, fillColor: '#f3d999', fillOpacity: 1, bubblingMouseEvents: false }).addTo(poiLayer)
      .bindTooltip(esc(p.name))
      .bindPopup(`<b>${esc(p.name)}</b>${p.note ? `<p>${esc(p.note)}</p>` : ''}
        <div class="poi-btns"><button type="button" class="btn tiny" data-act="poi-route" data-id="${esc(p.id)}">Add to route</button>
        ${canEdit() ? `<button type="button" class="btn tiny" data-act="poi-edit" data-id="${esc(p.id)}">Edit</button><button type="button" class="btn tiny danger" data-act="poi-del" data-id="${esc(p.id)}">Delete</button>` : ''}</div>`);
  }
}

function poiForm(p) {
  L.popup({ minWidth: 220 }).setLatLng(ll([p.x, p.y])).setContent(`
    <label class="field">Name<input type="text" id="poi-name" maxlength="60" value="${esc(p.name || '')}"></label>
    <label class="field">Note<textarea id="poi-note" rows="3" maxlength="500">${esc(p.note || '')}</textarea></label>
    <button type="button" class="btn gold" data-act="poi-save" data-id="${esc(p.id || '')}" data-x="${p.x}" data-y="${p.y}">Save location</button>`).openOn(map);
}

async function loadPois() {
  if (!POI_API) { pois = store.pois; setStatus(el, '○ Points of interest are saved in this browser only'); }
  else {
    try {
      pois = (await sheet(POI_API)).pois || [];
      setStatus(el, canEdit() ? '● Locations synced with the Google Sheet' : '● Locations synced · enter the DM key to add points of interest', 'ok');
    } catch (e) { setStatus(el, `● Could not load the locations: ${e.message}`, 'bad'); }
  }
  drawPois();
}

async function savePois() {
  drawPois();
  if (!POI_API) { store.pois = pois; persist(); return; }
  try { pois = (await sheet(POI_API, { key: getKey(KEY), pois })).pois || pois; } catch (e) { toast(`Save failed: ${e.message}`, 'bad'); await loadPois(); }
}

function addPoint(p, name) {
  const d = store.draft;
  // A click close to a road (about 14 screen px) lands on it; the flag marks the waypoint as on the network.
  const v = graph ? nearest(graph, p, Math.max(6, 14 / map.getZoomScale(map.getZoom(), 0))) : -1;
  d.points.push(v < 0 ? p : [+graph.verts[v][0].toFixed(2), +graph.verts[v][1].toFixed(2), 1]);
  if (name) { if (d.points.length === 1) d.from = name; else d.to = name; renderForm(); }
  persist();
  drawRoute();
}

function initMap(node) {
  const bounds = [[-H, 0], [0, W]];
  map = L.map(node, { crs: L.CRS.Simple, minZoom: -4, maxZoom: 2, zoomSnap: 0.25, maxBounds: bounds, maxBoundsViscosity: 0.8 });
  map.attributionControl.setPrefix(false).addAttribution('Faerûn map © Wizards of the Coast, via <a href="https://github.com/jonovotny/vectorized-realms" target="_blank" rel="noopener">vectorized-realms</a>. Unofficial Fan Content.');
  L.imageOverlay('img/faerun.jpg', bounds).addTo(map);
  line = L.polyline([], { color: '#b3261e', weight: 4, opacity: 0.9, interactive: false }).addTo(map);
  offLine = L.polyline([], { color: '#b3261e', weight: 4, opacity: 0.9, dashArray: '2 9', interactive: false }).addTo(map);
  dots = L.layerGroup().addTo(map);
  poiLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    const p = [Math.round(e.latlng.lng), Math.round(-e.latlng.lat)];
    if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) return;
    if (placing) { placing = false; node.classList.remove('placing'); poiForm({ x: p[0], y: p[1] }); } else addPoint(p);
  });
  // Leaflet stops clicks inside popups from bubbling, so the section's click handler is attached to each one.
  map.on('popupopen', (e) => { e.popup.getElement().onclick = (ev) => { ev.stopPropagation(); onClick(ev); }; });
  // Keep the whole map in view through layout changes until the player first pans or zooms.
  let touched = false;
  for (const ev of ['pointerdown', 'wheel', 'keydown']) node.addEventListener(ev, () => { touched = true; }, { capture: true });
  let fitted = false;
  new ResizeObserver(() => { map.invalidateSize(); if (node.clientWidth && !(fitted && touched)) { fitted = true; map.fitBounds(bounds); } }).observe(node);
}

// ---------- Views ----------

const field = (label, f, attrs = '') => `<label class="field">${label}<input data-f="${f}" value="${esc(store.draft[f])}" ${attrs}></label>`;

function renderForm() {
  const d = store.draft;
  const fixed = !Array.isArray(METHODS[d.method].mi);
  el.querySelector('[data-form]').innerHTML = `
    <h2><span class="glyph">🧭</span> Travel log</h2>
    <p class="hint">Click the map to trace your path. Clicks on a road or trail follow it (solid line, road pace); anywhere else is a straight off-road line (dotted, off-road pace). Zoom in to click beside a road without snapping to it.</p>
    <div class="grid2">${field('Character', 'character', 'type="text" list="roster-names" autocomplete="off"')}${field('Player (Discord)', 'player', 'type="text" placeholder="@handle" autocomplete="off"')}</div>
    <div class="grid2">${field('Departure', 'from', 'type="text"')}${field('Destination', 'to', 'type="text"')}</div>
    <div class="grid2">
      <label class="field">Travel method<select data-f="method">${Object.entries(METHODS).map(([k, m]) => `<option value="${k}"${k === d.method ? ' selected' : ''}>${m.name}</option>`).join('')}</select></label>
      ${field('Name in the log', 'methodName', 'type="text"')}
    </div>
    <div class="${fixed ? 'grid3' : 'grid4'}">${field('Speed (ft)', 'speed', 'type="number" min="0" step="5"')}${field('Hours / day', 'hours', 'type="number" min="1" max="24"')}${fixed ? field('Miles per day', 'mpd', 'type="number" min="1"') : field('Road mi/day', 'mpd', 'type="number" min="1"') + field('Off-road mi/day', 'mpdOff', 'type="number" min="1"')}</div>
    <p class="hint">${fixed ? 'This method ignores roads: one pace, straight lines.' : 'Road miles use the road pace and the rest the off-road pace.'} Changing speed or hours recalculates the pace (speed ÷ 10 per hour); you can also type it directly.</p>
    <div class="grid2">${field('Travelers', 'travelers', 'type="number" min="1"')}${field('Mounts / animals', 'mounts', 'type="number" min="0"')}</div>
    <h3 class="sub">Supplies</h3>
    ${d.supplies.map((s, i) => `<div class="supply"><input type="text" data-s="${i}.name" value="${esc(s.name)}" aria-label="Supply name"><input type="number" min="0" data-s="${i}.qty" value="${esc(s.qty)}" aria-label="Quantity of ${esc(s.name)}"><button type="button" class="btn tiny danger" data-act="del-supply" data-i="${i}" aria-label="Remove ${esc(s.name)}">✕</button></div>`).join('')}
    <button type="button" class="btn tiny" data-act="add-supply">+ Add supply</button>
    <div data-summary></div>
    <div class="form-row">
      <button type="button" class="btn" data-act="undo">↶ Undo point</button>
      <button type="button" class="btn" data-act="clear">Clear route</button>
      ${canEdit() ? '<button type="button" class="btn" data-act="place">📍 Add point of interest</button>' : ''}
    </div>
    <div class="form-row end"><button type="button" class="btn gold" data-act="create">✉ Create travel &amp; post to Discord</button></div>
    <details class="travel-discord"><summary>Discord channel for travels</summary>
      <label class="field">Travel channel webhook URL<input type="password" data-set="webhook" value="${esc(store.settings.webhook)}" placeholder="Empty = use the table's travel channel" autocomplete="off" spellcheck="false"></label>
      <label class="check"><input type="checkbox" data-set="forum" ${store.settings.forum ? 'checked' : ''}> It is a forum channel: create one topic per travel</label>
    </details>`;
  summary();
}

function summary(r = plan(store.draft)) {
  const d = store.draft;
  const box = el.querySelector('[data-summary]');
  if (!box) return;
  const m = METHODS[d.method];
  const { days } = r;
  const roads = usesRoads(d.method);
  const cost = days * (m.cost * d.travelers + (m.mountCost || 0) * d.mounts);
  const warn = [];
  if (r.gaps) warn.push('Two of your road points are not connected by the road network, so that stretch counts as off-road.');
  if (!m.noFood && days) {
    for (const s of d.supplies) {
      const need = days * (s.k === 'feed' ? d.mounts : s.k ? d.travelers : 0);
      if (s.qty < need) warn.push(`${s.name}: ${need} needed for ${days} days, you carry ${s.qty}.`);
    }
  }
  box.innerHTML = `<div class="search-info"><span>Distance <b>${round(r.miles)} mi</b></span>${roads ? `<span>Road <b>${round(r.roadMi)} mi</b> at ${d.mpd || 0}/day</span><span>Off-road <b>${round(r.offMi)} mi</b> at ${d.mpdOff || 0}/day</span>` : `<span>Pace <b>${d.mpd || 0} mi/day</b></span>`}<span>Rule cost <b>${money(cost)}</b></span><span class="bonus-total">Travel time <b>${days} days</b></span></div>
    ${warn.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}`;
}

function journeyCard(t) {
  const done = t.day >= t.total;
  return `<section class="card"><div class="row-between"><h2><span class="glyph">🧭</span> ${esc(t.character)} → ${esc(t.to)}</h2><button type="button" class="btn tiny danger" data-act="del-travel" data-id="${t.id}" aria-label="Delete this travel">✕</button></div>
    <div class="search-info"><span>From <b>${esc(t.from)}</b></span><span>${esc(transport(t))} <b>${split(t) ? `${t.mpd} / ${t.mpdOff}` : t.mpd} mi/day</b></span><span>Distance <b>${round(t.distance)} mi</b>${split(t) ? ` (${round(t.roadMi)} road · ${round(t.offMi)} off-road)` : ''}</span><span class="bonus-total">Day <b>${t.day} / ${t.total}</b>${done ? ' · arrived' : ''}</span></div>
    <p class="hint">Supplies: ${esc(supplyText(t.supplies))} · Gold ${t.gp >= 0 ? '+' : ''}${t.gp} GP · XP +${t.xp} · Heroic inspiration +${t.inspiration}</p>
    ${t.events.map((e) => `<div class="log-entry"><b>Day ${e.day}</b> · d10 ${e.d10}: ${esc(e.name)}${e.text ? ` · d2 ${e.d2}: <span class="${e.d2 === 2 ? 'up' : 'down'}">${e.d2 === 2 ? 'Oportunidade' : 'Contratempo'}</span>: ${esc(e.text)}` : ''}</div>`).join('')}
    <div class="form-row end"><span class="status ${t.discord === 'sent' ? 'ok' : t.discord ? 'bad' : ''}">${t.discord === 'sent' ? '● Posted to Discord' : esc(t.discord || '○ Not posted')}</span><span class="grow"></span>
      <button type="button" class="btn" data-act="repost" data-id="${t.id}">✉ Post log again</button>
      <button type="button" class="btn gold" data-act="roll-day" data-id="${t.id}" ${done ? 'disabled' : ''}>🎲 Roll next day</button></div></section>`;
}

function render() {
  el.querySelector('[data-nav]').innerHTML = tabs([['plan', 'Plan a travel'], ['journeys', `Journeys (${store.travels.length})`]], tab);
  el.querySelector('[data-plan]').hidden = tab !== 'plan';
  const j = el.querySelector('[data-journeys]');
  j.hidden = tab !== 'journeys';
  j.innerHTML = store.travels.map(journeyCard).join('') || '<section class="card"><p class="hint">No travels yet. Trace a route in “Plan a travel”.</p></section>';
}

// ---------- Discord ----------

async function routeImage(t) {
  const img = new Image();
  img.src = 'img/faerun.jpg';
  await img.decode();
  const legs = t.legs || [{ road: true, line: t.points }];
  const all = legs.flatMap((l) => l.line);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const pad = 160;
  const x0 = Math.max(0, Math.min(...xs) - pad);
  const y0 = Math.max(0, Math.min(...ys) - pad);
  const w = Math.min(W, Math.max(...xs) + pad) - x0;
  const h = Math.min(H, Math.max(...ys) + pad) - y0;
  const k = Math.min(1, 1400 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = w * k;
  c.height = h * k;
  const g = c.getContext('2d');
  g.drawImage(img, x0, y0, w, h, 0, 0, c.width, c.height);
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const [color, width] of [['#fff', 7], ['#b3261e', 4]]) {
    for (const l of legs) {
      g.setLineDash(l.road ? [] : [2, 10]); // off-road stretches are dotted, as on the map
      g.strokeStyle = color; g.lineWidth = width;
      g.beginPath(); l.line.forEach((p, i) => g[i ? 'lineTo' : 'moveTo']((p[0] - x0) * k, (p[1] - y0) * k)); g.stroke();
    }
  }
  g.setLineDash([]);
  for (const p of [t.points[0], t.points.at(-1)]) { g.beginPath(); g.arc((p[0] - x0) * k, (p[1] - y0) * k, 7, 0, 7); g.fillStyle = '#b3261e'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

const logText = (t) => `**Personagem:** ${t.character}${t.player ? ` (${t.player})` : ''}${t.travelers > 1 ? ` · grupo de ${t.travelers}` : ''}
**Partida:** ${t.from}
**Destino:** ${t.to}

**Transporte:** ${transport(t)} · ${paceText(t, 'milhas/dia')}
**Distância:** ${round(t.distance)} milhas${split(t) ? ` (${round(t.roadMi)} por estrada · ${round(t.offMi)} sem estrada)` : ''}
**Provisões:** ${supplyText(t.supplies)}
**Dias de Viagem:** ${t.day} / ${t.total}`;

function dayText(t, e) {
  let s = `**Dia ${e.day} / ${t.total}** · 🎲 1d10: **${e.d10}** ${e.name}`;
  if (e.text) s += `\n🎲 1d2: **${e.d2}** ${e.d2 === 2 ? '🟢 Oportunidade' : '🔴 Contratempo'}: ${e.text}`;
  s += `\n**Provisões:** ${supplyText(t.supplies)}`;
  if (t.day >= t.total) s += `\n\n🏁 **${t.character} chegou a ${t.to}** após ${t.day} dias. Ouro: ${t.gp >= 0 ? '+' : ''}${t.gp} PO · XP: +${t.xp} · Inspiração heroica: +${t.inspiration}`;
  return s;
}

/** Posts to the travel's topic (creating it on the first post in a forum channel). */
async function post(t, content, file, retried) {
  const url = hook();
  if (!isWebhook(url)) { t.discord = '○ No Discord webhook set'; return; }
  const title = `${t.character} viaja para ${t.to}`;
  const payload = { allowed_mentions: { parse: [] } };
  if (t.thread) payload.content = content;
  else if (store.settings.forum) Object.assign(payload, { content, thread_name: title.slice(0, 100) });
  else payload.content = `## ${title}\n${content}`;
  const body = new FormData();
  body.append('payload_json', JSON.stringify(payload));
  if (file) body.append('files[0]', file, 'rota.jpg');
  try {
    const r = await fetch(`${url}?wait=true${t.thread ? `&thread_id=${t.thread}` : ''}`, { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    // Discord's 2200xx errors mean the forum / text channel guess was wrong: flip it and try once more.
    if (!r.ok && !t.thread && !retried && String(j.code).startsWith('2200')) { store.settings.forum = !store.settings.forum; return post(t, content, file, true); }
    if (!r.ok) throw new Error(j.message || `Discord answered ${r.status}`);
    if (store.settings.forum && !t.thread) t.thread = j.channel_id;
    t.discord = 'sent';
    toast('Raven delivered to Discord ✉', 'ok');
  } catch (e) {
    t.discord = `● ${e.message}`;
    toast(`Discord: ${e.message}`, 'bad');
  }
  persist();
  render();
}

// ---------- Events ----------

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  const d = store.draft;
  const t = store.travels.find((x) => x.id === b.dataset.id);
  const poi = pois.find((x) => x.id === b.dataset.id);
  if (a === 'tab') { tab = b.dataset.t; render(); }
  else if (a === 'key') { if (askKey(KEY, 'the locations sheet')) { await loadPois(); renderForm(); } }
  else if (a === 'undo') { d.points.pop(); persist(); drawRoute(); }
  else if (a === 'clear') { d.points = []; persist(); drawRoute(); }
  else if (a === 'add-supply') { d.supplies.push({ name: '', qty: 0 }); persist(); renderForm(); }
  else if (a === 'del-supply') { d.supplies.splice(+b.dataset.i, 1); persist(); renderForm(); }
  else if (a === 'place') { placing = true; el.querySelector('.travel-map').classList.add('placing'); toast('Click the map where the new location is.'); }
  else if (a === 'poi-route' && poi) { map.closePopup(); addPoint([poi.x, poi.y], poi.name); }
  else if (a === 'poi-edit' && poi) poiForm(poi);
  else if (a === 'poi-del' && poi) { if (confirm(`Delete “${poi.name}”?`)) { pois = pois.filter((x) => x !== poi); map.closePopup(); await savePois(); } }
  else if (a === 'poi-save') {
    const name = document.querySelector('#poi-name').value.trim();
    if (!name) return toast('Give the location a name.', 'bad');
    const p = { id: b.dataset.id || uid(), name, note: document.querySelector('#poi-note').value.trim(), x: +b.dataset.x, y: +b.dataset.y };
    pois = [...pois.filter((x) => x.id !== p.id), p];
    map.closePopup();
    await savePois();
  } else if (a === 'create') {
    const miss = !d.character.trim() ? 'the character' : !d.from.trim() ? 'the departure' : !d.to.trim() ? 'the destination' : d.points.length < 2 ? 'a route on the map (at least two points)' : !(d.mpd > 0) || (usesRoads(d.method) && !(d.mpdOff > 0)) ? 'the miles per day' : '';
    if (miss) return toast(`Enter ${miss} first.`, 'bad');
    const r = plan(d);
    const legs = r.legs.map((l) => ({ road: l.road, line: l.line.map((p) => [Math.round(p[0]), Math.round(p[1])]) }));
    const nt = { ...structuredClone(d), id: uid(), distance: r.miles, roadMi: r.roadMi, offMi: r.offMi, legs, total: r.days, day: 0, events: [], gp: 0, xp: 0, inspiration: 0 };
    store.travels.unshift(nt);
    store.draft = { ...newDraft(), character: d.character, player: d.player };
    tab = 'journeys';
    persist(); renderForm(); drawRoute(); render();
    await post(nt, logText(nt), await routeImage(nt));
  } else if (a === 'roll-day' && t) {
    const d10 = 1 + Math.floor(Math.random() * 10);
    const ev = applyDay(t, d10, 1 + Math.floor(Math.random() * 2));
    persist(); render();
    await post(t, dayText(t, ev));
  } else if (a === 'repost' && t) await post(t, logText(t), await routeImage(t));
  else if (a === 'del-travel' && t) { if (confirm('Delete this travel from your list? The Discord topic stays.')) { store.travels = store.travels.filter((x) => x !== t); persist(); render(); } }
}

function onInput(e) {
  const t = e.target;
  const d = store.draft;
  if (t.dataset.f) {
    const f = t.dataset.f;
    d[f] = t.type === 'number' ? Math.max(0, +t.value || 0) : t.value;
    const [road, off] = paces(d.method);
    if (f === 'speed' || f === 'hours') {
      d.mpd = Math.round((d.speed / 10) * d.hours);
      d.mpdOff = Math.round((d.mpd * off) / road); // keep the method's own road to off-road ratio
      for (const k of ['mpd', 'mpdOff']) { const i = el.querySelector(`[data-f=${k}]`); if (i) i.value = d[k]; }
    }
    if (f === 'method') {
      const m = METHODS[d.method];
      Object.assign(d, { speed: m.speed, hours: m.hours, mpd: road, mpdOff: off, methodName: m.pt || d.methodName });
      renderForm();
    }
    drawRoute();
  } else if (t.dataset.s) {
    const [i, k] = t.dataset.s.split('.');
    d.supplies[i][k] = k === 'qty' ? Math.max(0, Math.round(+t.value) || 0) : t.value;
    summary();
  } else if (t.dataset.set) store.settings[t.dataset.set] = t.type === 'checkbox' ? t.checked : t.value;
  else return;
  persist();
}

export function mount(node, context) {
  el = node;
  ctx = context;
  try { store = { ...store, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { /* keep defaults */ }
  // A draft saved before road routing has one pace and a terrain: take both paces from its method.
  if (store.draft.mpdOff == null && METHODS[store.draft.method]) { const [mpd, mpdOff] = paces(store.draft.method); Object.assign(store.draft, { mpd, mpdOff }); }
  store.draft = { ...newDraft(), ...store.draft };
  if (!store.draft.character) Object.assign(store.draft, { character: ctx.character().name, player: ctx.character().player });
  shell(el);
  el.querySelector('[data-body]').innerHTML = `
    <div class="travel-plan" data-plan><div class="travel-map" role="application" aria-label="Map of Faerûn. Click to add route points."></div><section class="card" data-form></section></div>
    <div class="tracker-body" data-journeys hidden></div>`;
  if (!POI_API) el.querySelector('[data-act=key]').hidden = true;
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  initMap(el.querySelector('.travel-map'));
  renderForm();
  render();
  drawRoute();
  fetch('data/roads.json').then((r) => r.json()).then((data) => { graph = buildGraph(data); drawRoute(); })
    .catch(() => toast('Could not load the road network; routes will be straight lines.', 'bad'));
  return loadPois();
}
