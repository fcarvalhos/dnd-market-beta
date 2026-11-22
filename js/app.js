import { RARITIES, rarityOf, searchBonus, staticModifier, SKILLS, SKILL_LABEL, ABILITY_LABEL, fmt, num } from './engine.js';
import { MODES, runFlow, estimateFlow, buildRecord, recordText, isMagicSale } from './flows.js';
import { isWebhook, canPost, postRecord, postTest, BUILT_IN } from './discord.js';
import { esc, toast } from './sheet.js';
import * as xp from './xp.js';
import * as factions from './factions.js';
import * as travel from './travel.js';

const KEY = 'gilded-ledger-v1';
const $ = (s) => document.querySelector(s);
const localToday = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5);
const pct = (p) => (p > 0.995 && p < 1 ? '>99%' : p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);

// ---------- State ----------

function defaults() {
  const t = localToday();
  return {
    character: { name: '', player: '', mods: { int: 0, wis: 0, cha: 0 }, prof: 2, skills: { persuasion: 'none', deception: 'none', investigation: 'none' }, misc: 0 },
    abilities: {},
    homebrew: [],
    settings: { webhook: '', autoPost: true, strategy: 'max' },
    section: 'market',
    mode: 'buyMagic',
    forms: {
      buyMagic: { itemName: '', rarity: 'uncommon', consumable: false, days: 7, gp: 100, price: '', basePrice: '', date: t },
      buyMaterials: { itemName: '', amount: 2000, rarity: 'uncommon', days: 7, gp: 100, date: t },
      sellMagic: { itemName: '', rarity: 'uncommon', value: '', date: t },
      sellMundane: { itemName: '', value: '', date: t },
      sellRaw: { itemName: '', magical: false, rarity: 'uncommon', value: '', date: t },
    },
    history: [],
    lastResultId: null,
  };
}
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
function merge(base, over) {
  if (!isObj(over)) return base;
  for (const k of Object.keys(over)) base[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
  return base;
}
function load() {
  try { return merge(defaults(), JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return defaults(); }
}
let state = load();
// A new session starts on today's date.
for (const f of Object.values(state.forms)) f.date = localToday();
// A player's own webhook wins; otherwise the table's built-in channel.
const hook = () => (isWebhook(state.settings.webhook) ? state.settings.webhook.trim() : BUILT_IN.market);
const hookStatus = () => (isWebhook(state.settings.webhook) ? '● Webhook looks valid' : state.settings.webhook ? '● Not a Discord webhook URL' : BUILT_IN.market ? "● Using the table's channel" : '○ Not connected');
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: app still works this session */ } };

const getPath = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
function setPath(path, v) {
  const ks = path.split('.');
  let o = state;
  for (const k of ks.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  o[ks.at(-1)] = v;
}

// ---------- Abilities ----------

// Beta: abilities and homebrew are removed, so checks use only the character sheet.
const buildAbilities = () => [];
const parsePortent = (s) => String(s || '').split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 20);
function buildResources(list) {
  const uses = {};
  const portent = {};
  for (const a of list) {
    if (a.uses != null) uses[a.id] = a.uses;
    if (a.effects.some((e) => e.kind === 'portent')) portent[a.id] = parsePortent(a.params.values);
  }
  return { uses, portent };
}
function writeBack(list, res) {
  for (const a of list) {
    const s = (state.abilities[a.id] ||= {});
    if (a.uses != null) { s.uses = res.uses[a.id]; s.max ??= a.max; }
    if (res.portent[a.id]) { s.params = { ...(s.params || {}), values: res.portent[a.id].join(', ') }; }
  }
}
const ctx = (list = buildAbilities()) => ({ character: state.character, abilities: list, resources: buildResources(list), strategy: state.settings.strategy });

// ---------- Render: sidebar ----------

const numInput = (path, attrs = '', value = getPath(path)) => `<input type="number" data-bind="${path}" data-type="num" value="${esc(value)}" ${attrs}>`;

function renderCharacter() {
  const c = state.character;
  const skillRow = (k) => `
    <div class="skill-row">
      <span class="skill-name">${SKILL_LABEL[k]} <small>${ABILITY_LABEL[SKILLS[k]]}</small></span>
      <select data-bind="character.skills.${k}" data-rerender="derived" aria-label="${SKILL_LABEL[k]} proficiency">
        ${[['none', 'Untrained'], ['prof', 'Proficient'], ['expert', 'Expertise']].map(([v, l]) => `<option value="${v}" ${c.skills[k] === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <output class="skill-mod" id="mod-${k}"></output>
    </div>`;
  $('#character').innerHTML = `
    <h2><span class="glyph">⚜</span> Adventurer</h2>
    <div class="grid2">
      <label class="field">Character<input type="text" data-bind="character.name" value="${esc(c.name)}" placeholder="Name" list="roster-names" autocomplete="off"></label>
      <label class="field">Player (Discord)<input type="text" data-bind="character.player" value="${esc(c.player)}" placeholder="@handle" autocomplete="off"></label>
    </div>
    <div class="grid4">
      <label class="field stat">INT<br>${numInput('character.mods.int', 'min="-5" max="10"')}</label>
      <label class="field stat">WIS<br>${numInput('character.mods.wis', 'min="-5" max="10"')}</label>
      <label class="field stat">CHA<br>${numInput('character.mods.cha', 'min="-5" max="10"')}</label>
      <label class="field stat">Prof.<br>${numInput('character.prof', 'min="0" max="9"')}</label>
    </div>
    <p class="hint">Ability <em>modifiers</em>, not scores.</p>
    ${Object.keys(SKILLS).map(skillRow).join('')}
    <label class="field inline">Other bonus to market checks ${numInput('character.misc', 'class="small"')}</label>`;
}

function renderSettings(status = '') {
  const s = state.settings;
  const ok = canPost(hook());
  $('#settings').innerHTML = `
    <h2><span class="glyph">✉</span> Discord Raven</h2>
    <label class="field">Channel webhook URL
      <span class="with-btn">
        <input type="password" data-bind="settings.webhook" data-rerender="settings-status" value="${esc(s.webhook)}" placeholder="${BUILT_IN.market ? 'Empty = use the table channel' : 'https://discord.com/api/webhooks/…'}" autocomplete="off" spellcheck="false" id="webhook-input">
        <button type="button" class="btn tiny ghost" data-action="toggle-webhook" aria-label="Show or hide the webhook URL">👁</button>
      </span>
    </label>
    <p class="hint">In Discord: <em>Edit Channel → Integrations → Webhooks → New Webhook → Copy URL</em>. Only needed to post to a different channel. Yours is saved only in this browser.</p>
    <label class="check"><input type="checkbox" data-bind="settings.autoPost" data-type="bool" ${s.autoPost ? 'checked' : ''}> Post every roll automatically</label>
    <div class="row-between">
      <span class="status ${s.webhook && !isWebhook(s.webhook) ? 'bad' : ok ? 'ok' : ''}" id="webhook-status">${status || hookStatus()}</span>
      <button type="button" class="btn ghost" data-action="test-webhook" ${ok ? '' : 'disabled'}>Send test</button>
    </div>`;
}

// ---------- Sections ----------

const SECTIONS = ['market', 'xp', 'factions', 'travel'];
function showSection() {
  if (!SECTIONS.includes(state.section)) state.section = 'market';
  for (const s of SECTIONS) $(`#view-${s}`).hidden = s !== state.section;
  for (const b of document.querySelectorAll('#sections .mode')) {
    const on = b.dataset.section === state.section;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  }
}

// ---------- Render: main ----------

function renderModes() {
  $('#modes').innerHTML = Object.entries(MODES).map(([k, m]) => `
    <button type="button" role="tab" aria-selected="${state.mode === k}" class="mode ${state.mode === k ? 'active' : ''}" data-action="mode" data-mode="${k}">
      <span class="mode-icon">${m.icon}</span><span class="mode-label">${m.short}</span>
    </button>`).join('');
}

const formPath = (f) => `forms.${state.mode}.${f}`;
const text = (f, label, ph = '') => `<label class="field">${label}<input type="text" data-bind="${formPath(f)}" value="${esc(state.forms[state.mode][f])}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
const number = (f, label, attrs = '') => `<label class="field">${label}${numInput(formPath(f), attrs)}</label>`;
const date = () => `<label class="field">Attempt date<input type="date" data-bind="${formPath('date')}" data-rerender="derived" value="${esc(state.forms[state.mode].date)}"></label>`;
const raritySel = (label = 'Rarity') => `<label class="field">${label}
  <select data-bind="${formPath('rarity')}" data-rerender="objective">
    ${RARITIES.map((r) => `<option value="${r.key}" ${state.forms[state.mode].rarity === r.key ? 'selected' : ''}>${r.label} (DC ${r.dc})</option>`).join('')}
  </select></label>`;
const checkbox = (f, label, rerender = 'derived') => `<label class="check"><input type="checkbox" data-bind="${formPath(f)}" data-type="bool" data-rerender="${rerender}" ${state.forms[state.mode][f] ? 'checked' : ''}> ${label}</label>`;

function renderObjective() {
  const m = MODES[state.mode];
  const f = state.forms[state.mode];
  let body = '';
  switch (state.mode) {
    case 'buyMagic':
      body = `
        <div class="grid2">${text('itemName', 'Magic item', 'e.g. Cloak of Elvenkind')}${raritySel()}</div>
        <div class="grid2">${number('days', 'Days of searching', 'min="0" step="7"')}${number('gp', 'GP spent searching', 'min="0" step="100"')}</div>
        <div id="search-info" class="search-info"></div>
        <fieldset class="price"><legend>Price (optional, once a vendor is found)</legend>
          <div class="grid2">${number('price', 'Sane Magic Market price (GP)', 'min="0"')}${number('basePrice', 'Base mundane item (GP)', 'min="0"')}</div>
          ${checkbox('consumable', 'Consumable (potion etc.): half price')}
          <p class="hint"><a href="https://sanemagicmarket.com/pricing" target="_blank" rel="noopener">Look up the price at Sane Magic Market ↗</a></p>
        </fieldset>
        ${date()}`;
      break;
    case 'buyMaterials':
      body = `
        <div class="grid2">${text('itemName', 'Materials for', 'e.g. Cloak of Protection materials')}${number('amount', 'Materials to buy (GP)', 'min="0" step="100"')}</div>
        <div class="grid2">${raritySel('Rarity of the item to craft')}${date()}</div>
        <div class="grid2">${number('days', 'Days of searching', 'min="0" step="7"')}${number('gp', 'GP spent searching', 'min="0" step="100"')}</div>
        <div id="search-info" class="search-info"></div>`;
      break;
    case 'sellMagic':
      body = `
        <div class="grid2">${text('itemName', 'Magic item', 'e.g. +1 Longsword')}${raritySel()}</div>
        <div class="grid2">${number('value', 'Reference value (GP)', 'min="0"')}${date()}</div>`;
      break;
    case 'sellMundane':
      body = `
        <div class="grid2">${text('itemName', 'Item(s)', 'e.g. 3 chain shirts')}${number('value', 'Total reference value (GP)', 'min="0"')}</div>
        ${date()}`;
      break;
    case 'sellRaw':
      body = `
        <div class="grid2">${text('itemName', 'Materials', 'e.g. Owlbear pelts')}${number('value', 'Reference value (GP)', 'min="0"')}</div>
        ${checkbox('magical', 'Magical materials (sold like a magic item)', 'objective')}
        <div class="grid2">${f.magical ? raritySel() : ''}${date()}</div>`;
      break;
  }
  $('#objective').innerHTML = `
    <h2><span class="glyph">${m.icon}</span> ${m.label}</h2>
    <p class="blurb">${m.blurb}</p>
    ${body}
    <div id="warnings"></div>`;
}

function getIssues() {
  const mode = state.mode;
  const f = state.forms[mode];
  const block = [];
  const info = [];
  const name = (f.itemName || '').trim().toLowerCase();
  if (mode === 'buyMagic' || mode === 'buyMaterials') {
    const sb = searchBonus(f.rarity, f.days, f.gp);
    if (!sb.valid) block.push(`The minimum search is ${sb.baseDays} days and ${sb.baseGp} GP${sb.plane === 'other' ? ' (other planes)' : ''}.`);
    if (sb.plane === 'other') info.push(mode === 'buyMagic' ? 'Rare and rarer items are only sold on other planes. You need a quest or a way to travel there.' : 'Materials for Rare and rarer items come from other planes (14 days and 200 GP minimum).');
    if (mode === 'buyMagic') info.push('Magic items can only be bought in cities of the Kingdom.');
    if (name) {
      const fail = state.history.find((r) => (r.mode === 'buyMagic' || r.mode === 'buyMaterials') && !r.outcome.success
        && (r.itemName || '').trim().toLowerCase() === name && r.character === (state.character.name || 'Unnamed adventurer')
        && daysBetween(r.date, f.date) >= 0 && daysBetween(r.date, f.date) < 30);
      if (fail) block.push(`No vendor was found for “${f.itemName}” on ${fail.date}. You can try again on ${addDays(fail.date, 30)}.`);
    }
  } else {
    if (num(f.value) <= 0) block.push('Enter the reference value of what you are selling.');
    if (isMagicSale(mode, f)) {
      const today = state.history.find((r) => r.date === f.date && r.character === (state.character.name || 'Unnamed adventurer')
        && (r.mode === 'sellMagic' || (r.mode === 'sellRaw' && r.checks.length && r.checks[0].title === 'Buyer search')));
      if (today) block.push(`${state.character.name || 'This character'} already searched for a magic-item buyer on ${f.date}. Only one search per day.`);
    }
  }
  return { block, info };
}

function refreshDerived() {
  const list = buildAbilities();
  for (const k of Object.keys(SKILLS)) {
    const st = staticModifier(state.character, list, k);
    const el = $(`#mod-${k}`);
    if (el) el.textContent = `${fmt(st.total)}${st.minRoll ? ` · min ${st.minRoll}` : ''}${st.passiveAdv ? ' · adv' : ''}`;
  }
  const f = state.forms[state.mode];
  const si = $('#search-info');
  if (si) {
    const sb = searchBonus(f.rarity, f.days, f.gp);
    si.innerHTML = `<span>Base: <b>${sb.baseDays} days</b> &amp; <b>${sb.baseGp} GP</b></span>
      <span>Extra time <b>+${sb.dayBonus}</b></span><span>Extra gold <b>+${sb.gpBonus}</b></span>
      <span class="bonus-total">Search bonus <b>+${sb.total}</b>${sb.capped ? ' <small>(max +10)</small>' : ''}</span>`;
  }
  const { block, info } = getIssues();
  const w = $('#warnings');
  if (w) w.innerHTML = [...block.map((b) => `<p class="warn">⚠ ${esc(b)}</p>`), ...info.map((i) => `<p class="info">ℹ ${esc(i)}</p>`)].join('');
  const btn = $('#roll-btn');
  btn.disabled = block.length > 0;
  btn.title = block.join(' ');
  scheduleOdds();
}

// ---------- Odds ----------

let oddsTimer = 0;
function scheduleOdds() {
  clearTimeout(oddsTimer);
  $('#odds').classList.add('busy');
  oddsTimer = setTimeout(renderOdds, 220);
}

function renderOdds() {
  const mode = state.mode;
  const f = state.forms[mode];
  const c = ctx();
  const est = estimateFlow(mode, f, c, 2500);
  let html = '';
  const meter = (p, label, sub) => `
    <div class="meter-wrap">
      <div class="meter-label"><span>${label}</span><b>${pct(p)}</b></div>
      <div class="meter"><div class="meter-fill" style="width:${(p * 100).toFixed(1)}%"></div></div>
      ${sub ? `<small>${sub}</small>` : ''}
    </div>`;
  if (mode === 'buyMagic' || mode === 'buyMaterials') {
    html += meter(est.p, 'Chance to find a vendor');
    const sb = searchBonus(f.rarity, f.days, f.gp);
    const chips = [];
    for (let b = 0; b <= 10; b++) {
      const e = estimateFlow(mode, { ...f, days: sb.baseDays, gp: sb.baseGp + 100 * b }, c, 500);
      const extraGp = 100 * Math.max(0, b - sb.dayBonus);
      chips.push(`<button type="button" class="chip ${b === sb.total ? 'current' : ''}" data-action="set-bonus" data-gp="${sb.baseGp + extraGp}" title="Spend ${sb.baseGp + extraGp} GP with your current ${num(f.days)} days">
        <b>+${b}</b><span>${pct(e.p)}</span></button>`);
    }
    html += `<p class="chips-title">Search bonus vs. chance <small>(click to set the gold)</small></p><div class="chips">${chips.join('')}</div>`;
  } else if (isMagicSale(mode, f)) {
    const t = est.tiers;
    html += meter(1 - t.fail, 'Chance to find a buyer and sell');
    html += tierBar([[t.great, 'great', '150%'], [t.success, 'success', '100%'], [t.partial, 'partial', '50%'], [t.fail, 'fail', 'no buyer']]);
    html += `<p class="expect">Expected value: <b>${Math.round(est.expected)} GP</b> of ${num(f.value)} GP</p>`;
  } else if (mode === 'sellMundane') {
    const t = est.tiers;
    html += meter(t.great + t.success, 'Chance to sell at full value or better');
    html += tierBar([[t.great, 'great', '150%'], [t.success, 'success', '100%'], [t.partial, 'partial', '50%']]);
    html += `<p class="expect">Expected value: <b>${Math.round(est.expected)} GP</b> of ${num(f.value)} GP</p>`;
  } else {
    const t = est.tiers;
    html += meter(t.great, 'Chance to sell at 150%');
    html += `<p class="expect">Expected value: <b>${Math.round(est.expected)} GP</b> of ${num(f.value)} GP</p>`;
  }
  const odds = $('#odds');
  odds.innerHTML = `<h2><span class="glyph">☉</span> The Omens</h2>${html}<p class="hint">Estimated from thousands of simulated rolls.</p>`;
  odds.classList.remove('busy');
}
const tierBar = (rows) => `<div class="tiers">${rows.filter(([p]) => p > 0.0005).map(([p, cls, l]) => `<div class="tier ${cls}" style="flex:${p}" title="${l}: ${pct(p)}"><span>${l} ${pct(p)}</span></div>`).join('')}</div>`;

// ---------- Result ----------

const D20 = (v, cls = '') => `
  <svg class="d20 ${cls}" viewBox="0 0 100 100" aria-label="d20 showing ${v}" role="img">
    <polygon class="d20-face" points="50,3 93,27 93,73 50,97 7,73 7,27"/>
    <polygon class="d20-inner" points="50,24 77,68 23,68"/>
    <path class="d20-edge" d="M50 3L50 24M93 27L50 24M93 27L77 68M93 73L77 68M50 97L77 68M50 97L23 68M7 73L23 68M7 27L23 68M7 27L50 24"/>
    <text x="50" y="58" class="d20-num" data-final="${v}">${v}</text>
  </svg>`;

function checkCard(c, i) {
  const dice = c.forced != null
    ? D20(c.forced, 'kept portent')
    : c.dice.map((v, idx) => D20(v, `${v === c.kept && c.dice.indexOf(v) === idx ? 'kept' : 'dropped'} ${v === 20 ? 'nat20' : v === 1 ? 'nat1' : ''}`)).join('');
  return `
    <article class="roll-check ${c.success ? 'ok' : 'ko'}">
      <header>
        <h4>${i + 1}. ${esc(c.title)} <small>${SKILL_LABEL[c.skill]} (${ABILITY_LABEL[SKILLS[c.skill]]})</small></h4>
        <span class="badge ${c.success ? 'ok' : 'ko'}">${c.success ? 'Success' : 'Failure'}</span>
      </header>
      <div class="roll-line">
        <div class="dice">${dice}</div>
        <div class="vs">
          <span class="total">${c.total}</span>
          <span class="dc">vs DC ${c.dc}</span>
          ${c.set != null ? `<span class="note">d20 counts as ${c.set}</span>` : c.minRoll ? `<span class="note">d20 counts as ${c.minRoll}</span>` : ''}
          ${c.nat20 ? '<span class="note gold">Natural 20!</span>' : ''}
        </div>
      </div>
      <ul class="parts">${c.parts.map((p) => `<li class="${p.rolled ? 'rolled' : ''}">${esc(p.label)} <b>${fmt(p.value)}</b></li>`).join('')}</ul>
      ${c.used.length ? `<div class="used"><span>Abilities used:</span> ${c.used.map((u) => `<span class="used-chip" title="${esc(u.detail)}">✦ ${esc(u.name)}: ${esc(u.detail)}</span>`).join('')}</div>` : ''}
      <details><summary>Roll log</summary><ol class="steps">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
    </article>`;
}

function discordStatus(rec) {
  const d = rec.discord || {};
  if (d.status === 'sent') return '<span class="status ok">● Posted to Discord</span>';
  if (d.status === 'sending') return '<span class="status">◌ Sending raven…</span>';
  if (d.status === 'error') return `<span class="status bad" title="${esc(d.error)}">● ${esc(d.error)}</span>`;
  return '<span class="status">○ Not posted</span>';
}

function renderResult(rec, animate = false) {
  const el = $('#result');
  if (!rec) {
    el.innerHTML = `<div class="empty"><div class="empty-sigil">⚖</div><p>Set your objective and roll. The outcome and the dice will appear here.</p></div>`;
    return;
  }
  const o = rec.outcome;
  el.innerHTML = `
    <div class="result-head tier-${o.tier}">
      <div class="seal" aria-hidden="true">${o.tier === 'fail' ? '✗' : o.tier === 'great' ? '★' : '✓'}</div>
      <div>
        <p class="eyebrow">${esc(rec.character)} · ${esc(rec.date)}</p>
        <h3>${esc(o.label)}</h3>
        <p>${esc(o.detail || '')}</p>
      </div>
    </div>
    <dl class="objective-list">${rec.objective.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${rec.checks.map(checkCard).join('')}
    <div class="result-actions">
      <span id="result-discord">${discordStatus(rec)}</span>
      <span class="btns">
        <button type="button" class="btn ghost" data-action="copy" data-id="${rec.id}">⎘ Copy record</button>
        <button type="button" class="btn gold" data-action="post" data-id="${rec.id}" ${canPost(hook()) ? '' : 'disabled title="Add a webhook in Discord Raven first"'}>✉ Post to Discord</button>
      </span>
    </div>`;
  if (animate) {
    el.classList.remove('reveal');
    void el.offsetWidth;
    el.classList.add('reveal');
    el.querySelectorAll('.d20').forEach((svg, i) => {
      const t = svg.querySelector('.d20-num');
      const final = t.dataset.final;
      svg.classList.add('rolling');
      let n = 0;
      const iv = setInterval(() => { t.textContent = 1 + Math.floor(Math.random() * 20); if (++n > 9 + i * 2) { clearInterval(iv); t.textContent = final; svg.classList.remove('rolling'); } }, 70);
    });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderHistory() {
  const h = state.history;
  $('#history').innerHTML = `
    <div class="row-between"><h2><span class="glyph">📖</span> The Ledger</h2>${h.length ? '<button type="button" class="btn tiny ghost" data-action="clear-history">Clear</button>' : ''}</div>
    ${h.length ? `<ul class="ledger">${h.slice(0, 60).map((r) => `
      <li class="tier-${r.outcome.tier}">
        <button type="button" class="ledger-main" data-action="view" data-id="${r.id}">
          <span class="ledger-icon">${MODES[r.mode].icon}</span>
          <span class="ledger-text"><b>${esc(r.title)}</b><small>${esc(r.character)} · ${esc(r.date)} · ${esc(r.outcome.label)}</small></span>
        </button>
        <span class="ledger-discord" title="${esc(r.discord?.status === 'error' ? r.discord.error : r.discord?.status || 'not posted')}">${r.discord?.status === 'sent' ? '✉✓' : r.discord?.status === 'error' ? '✉!' : ''}</span>
        <button type="button" class="btn tiny ghost" data-action="delete" data-id="${r.id}" aria-label="Delete entry">✕</button>
      </li>`).join('')}</ul>` : '<p class="hint">No rolls yet. Each roll is recorded here, and its date is used for the 30-day and once-per-day limits.</p>'}`;
}

// ---------- Actions ----------

function doRoll() {
  const { block } = getIssues();
  if (block.length) { toast(block[0], 'bad'); return; }
  const list = buildAbilities();
  const c = ctx(list);
  const form = { ...state.forms[state.mode] };
  const result = runFlow(state.mode, form, c);
  writeBack(list, c.resources);
  const rec = buildRecord(state.mode, form, state.character, result);
  state.history.unshift(rec);
  state.history = state.history.slice(0, 200);
  state.lastResultId = rec.id;
  save();
  renderResult(rec, true);
  renderHistory();
  refreshDerived();
  if (state.settings.autoPost && canPost(hook())) postRec(rec);
}

async function postRec(rec) {
  rec.discord = { status: 'sending' };
  updateDiscordViews(rec);
  try {
    await postRecord(hook(), rec);
    rec.discord = { status: 'sent', at: Date.now() };
    toast('Raven delivered to Discord ✉', 'ok');
  } catch (e) {
    rec.discord = { status: 'error', error: e.message || 'Network error' };
    toast(rec.discord.error, 'bad');
  }
  save();
  updateDiscordViews(rec);
}
function updateDiscordViews(rec) {
  if (state.lastResultId === rec.id && $('#result-discord')) $('#result-discord').innerHTML = discordStatus(rec);
  renderHistory();
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); } catch {
    const ta = document.createElement('textarea');
    ta.value = s; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

function rerender(what) {
  for (const w of what.split(',')) {
    if (w === 'objective') {
      const f = state.forms[state.mode];
      if (state.mode === 'buyMagic' || state.mode === 'buyMaterials') {
        const sb = searchBonus(f.rarity, f.days, f.gp);
        f.days = Math.max(num(f.days), sb.baseDays);
        f.gp = Math.max(num(f.gp), sb.baseGp);
      }
      renderObjective();
    }
    if (w === 'settings-status') {
      const ok = canPost(hook());
      const st = $('#webhook-status');
      st.className = `status ${state.settings.webhook && !isWebhook(state.settings.webhook) ? 'bad' : ok ? 'ok' : ''}`;
      st.textContent = hookStatus();
      $('[data-action="test-webhook"]').disabled = !ok;
      const pb = $('[data-action="post"]');
      if (pb) pb.disabled = !ok;
    }
  }
  refreshDerived();
}

function onBind(ev) {
  const el = ev.target;
  const path = el.dataset?.bind;
  if (!path) return;
  const type = el.dataset.type;
  let v = el.value;
  if (type === 'bool') v = el.checked;
  else if (type === 'num') v = v === '' ? '' : Number(v);
  setPath(path, v);
  save();
  if (ev.type === 'change' && el.dataset.rerender) rerender(el.dataset.rerender);
  else if (ev.type === 'input' && el.dataset.rerender === 'settings-status') rerender('settings-status');
  else if (ev.type === 'input' || !el.dataset.rerender) refreshDerived();
}

document.addEventListener('input', (ev) => { if (ev.target.type !== 'checkbox' && ev.target.tagName !== 'SELECT') onBind(ev); });
document.addEventListener('change', onBind);

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  const rec = b.dataset.id ? state.history.find((r) => r.id === b.dataset.id) : null;
  switch (a) {
    case 'section': state.section = b.dataset.section; save(); showSection(); break;
    case 'mode': state.mode = b.dataset.mode; save(); renderModes(); renderObjective(); refreshDerived(); break;
    case 'roll': doRoll(); break;
    case 'set-bonus': state.forms[state.mode].gp = Number(b.dataset.gp); save(); renderObjective(); refreshDerived(); break;
    case 'toggle-webhook': { const i = $('#webhook-input'); i.type = i.type === 'password' ? 'text' : 'password'; break; }
    case 'test-webhook':
      try { await postTest(hook(), state.character.name); toast('Test raven delivered ✉', 'ok'); renderSettings('● Connected, test message sent'); } catch (e) { toast(e.message, 'bad'); renderSettings(`● ${e.message}`); }
      break;
    case 'post': if (rec) postRec(rec); break;
    case 'copy': if (rec) { await copyText(recordText(rec)); toast('Record copied in the table template format', 'ok'); } break;
    case 'view': if (rec) { state.lastResultId = rec.id; save(); renderResult(rec); $('#result').scrollIntoView({ behavior: 'smooth' }); } break;
    case 'delete':
      state.history = state.history.filter((r) => r.id !== b.dataset.id);
      if (state.lastResultId === b.dataset.id) { state.lastResultId = null; renderResult(null); }
      save(); renderHistory(); refreshDerived(); break;
    case 'clear-history':
      if (confirm('Clear the whole ledger? This also resets the 30-day and once-per-day limits.')) { state.history = []; state.lastResultId = null; save(); renderHistory(); renderResult(null); refreshDerived(); }
      break;
    default: break;
  }
});

// ---------- Boot ----------
renderCharacter();
renderSettings();
renderModes();
renderObjective();
renderHistory();
renderResult(state.history.find((r) => r.id === state.lastResultId) || null);
refreshDerived();
showSection();
// The Adventurer name field suggests characters from the XP roster.
xp.onRoster(() => { $('#roster-names').innerHTML = xp.heroes().map((p) => `<option value="${esc(p.name)}"></option>`).join(''); });
xp.mount($('#view-xp'));
factions.mount($('#view-factions'));
travel.mount($('#view-travel'), { webhook: hook, character: () => state.character });
