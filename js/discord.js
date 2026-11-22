// Posts a roll record to a Discord channel through a webhook.
import { SKILL_LABEL, ABILITY_LABEL, SKILLS, fmt } from './engine.js';
import { MODES } from './flows.js';

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;
export const isWebhook = (url) => WEBHOOK_RE.test(String(url || '').trim());
// The table's channels, used when a player has not pasted a webhook of their own.
// They go through a relay (apps-script/discord-relay.gs) that holds the webhook URLs, so the site never shows them.
export const RELAY = 'https://script.google.com/macros/s/AKfycbyvEFQvRT0T_7_AGSYaGhma8Up5oP28sy3ZjxZc0Aqci6h-AoB6BAwPspzkz3b1AxBqxg/exec';
export const BUILT_IN = RELAY ? { market: 'table:market', travel: 'table:travel' } : {};
export const canPost = (t) => isWebhook(t) || (!!RELAY && /^table:(market|travel)$/.test(t));

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Sends one message, straight to a webhook or through the relay. Resolves to { ok, status, json }. */
export async function send(target, payload, { file, thread } = {}) {
  if (isWebhook(target)) {
    const url = `${target.trim().replace(/\/$/, '')}?wait=true${thread ? `&thread_id=${thread}` : ''}`;
    let init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    if (file) {
      const body = new FormData();
      body.append('payload_json', JSON.stringify(payload));
      body.append('files[0]', file, 'rota.jpg');
      init = { method: 'POST', body };
    }
    const r = await fetch(url, init);
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
  }
  if (!canPost(target)) throw new Error('No Discord channel set.');
  const req = { channel: target.slice(6), payload, thread };
  if (file) req.file = { b64: await toBase64(file) };
  // No content-type header, so the browser sends it without a CORS preflight (Apps Script cannot answer one).
  const r = await fetch(RELAY, { method: 'POST', body: JSON.stringify(req) });
  const { status = r.status, body = {} } = await r.json().catch(() => ({}));
  return { ok: status >= 200 && status < 300, status, json: body };
}

const COLORS = { great: 0xf1c40f, success: 0x4caf6a, partial: 0xd9893b, fail: 0xc0392b };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function checkField(c, i) {
  const diceTxt = c.forced != null ? `🔮 ${c.forced} (Portent)` : c.dice.map((v) => (v === c.kept ? `**${v}**` : `~~${v}~~`)).join(' · ');
  const lines = [
    `🎲 ${diceTxt}${c.advantage ? ` *(advantage: ${c.advantage})*` : ''}${c.set != null ? ` → counts as **${c.set}**` : ''}${c.minRoll ? ` → counts as **${c.minRoll}**` : ''}`,
    `➕ ${c.parts.map((p) => `${p.label} ${fmt(p.value)}`).join(', ') || 'no modifiers'}`,
    `**Total ${c.total}** vs DC ${c.dc} → ${c.success ? '✅ Success' : '❌ Failure'}${c.nat20 ? ' · 🌟 Natural 20' : ''}`,
  ];
  if (c.used.length) lines.push(`✨ ${c.used.map((u) => `**${u.name}**: ${u.detail}`).join('\n✨ ')}`);
  return {
    name: clip(`${i + 1}. ${c.title}: ${SKILL_LABEL[c.skill]} (${ABILITY_LABEL[SKILLS[c.skill]]})`, 256),
    value: clip(lines.join('\n'), 1024),
  };
}

export function buildPayload(rec) {
  const m = MODES[rec.mode];
  const used = [...new Set(rec.checks.flatMap((c) => c.used.map((u) => u.name)))];
  const embed = {
    title: clip(`${m.icon} ${rec.title}`, 256),
    color: COLORS[rec.outcome.tier] ?? COLORS.success,
    description: clip([
      `**Character:** ${rec.character}${rec.player ? ` (${rec.player})` : ''}`,
      `**Objective:** ${m.label}`,
      ...rec.objective.map(([k, v]) => `**${k}:** ${v}`),
      `**Date:** ${rec.date}`,
    ].join('\n'), 4000),
    fields: [
      ...rec.checks.map(checkField),
      { name: 'Abilities used', value: clip(used.length ? used.join(', ') : 'None', 1024) },
      { name: `${rec.outcome.success ? '🏆' : '💀'} Result: ${clip(rec.outcome.label, 200)}`, value: clip(rec.outcome.detail || '—', 1024) },
    ].slice(0, 25),
    footer: { text: 'The Gilded Ledger · market roll' },
    timestamp: new Date(rec.ts).toISOString(),
  };
  return { username: 'The Gilded Ledger', embeds: [embed], allowed_mentions: { parse: [] } };
}

export async function postPayload(url, payload) {
  if (!canPost(url)) throw new Error('That is not a Discord webhook URL (https://discord.com/api/webhooks/…).');
  const r = await send(url, payload);
  if (!r.ok) throw new Error(`Discord refused the post (${r.status}${r.json.message ? `: ${r.json.message}` : ''}).`);
  return true;
}

export const postRecord = (url, rec) => postPayload(url, buildPayload(rec));

export const postTest = (url, who) => postPayload(url, {
  username: 'The Gilded Ledger',
  embeds: [{ title: '🕯️ The Gilded Ledger is connected', description: `Market rolls${who ? ` for **${who}**` : ''} will be posted in this channel.`, color: 0xd4af6a }],
  allowed_mentions: { parse: [] },
});
