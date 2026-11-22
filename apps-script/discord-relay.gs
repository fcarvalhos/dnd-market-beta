// Discord relay for The Gilded Ledger: keeps the table's webhook URLs out of the public site.
//
// Setup (once):
// 1. Go to script.google.com and create a new project. Paste this file into it.
// 2. Open Project Settings and go to Script properties. Add WEBHOOK_MARKET and WEBHOOK_TRAVEL with the webhook URLs.
// 3. Click Deploy, then New deployment, then Web app. Set "Execute as" to Me and "Who has access" to Anyone.
//    Authorize the script when asked; it needs to call Discord.
// 4. Copy the web app URL into RELAY in js/discord.js.
//
// The site only names a channel ("market" or "travel"). The relay sends text, embeds and one image.
// It never lets anyone mention @everyone or a role, and it sets the bot name itself.

const NAMES = { market: 'The Gilded Ledger', travel: '' }; // '' keeps the name set on the webhook in Discord
const PER_MINUTE = 20; // posts per minute for the whole table, to blunt spam through the relay

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const hook = Object.prototype.hasOwnProperty.call(NAMES, req.channel) && PropertiesService.getScriptProperties().getProperty(`WEBHOOK_${String(req.channel).toUpperCase()}`);
    if (!hook) return out(400, { message: 'Unknown channel' });
    if (!underLimit()) return out(429, { message: 'Too many posts, try again in a minute' });

    const p = req.payload || {};
    const payload = { allowed_mentions: { parse: [] } };
    if (NAMES[req.channel]) payload.username = NAMES[req.channel];
    if (p.content) payload.content = String(p.content).slice(0, 2000);
    if (Array.isArray(p.embeds)) payload.embeds = p.embeds.slice(0, 10);
    if (p.thread_name) payload.thread_name = String(p.thread_name).slice(0, 100);

    const thread = /^\d+$/.test(String(req.thread || '')) ? `&thread_id=${req.thread}` : '';
    const opts = { method: 'post', muteHttpExceptions: true };
    if (req.file && req.file.b64) {
      const blob = Utilities.newBlob(Utilities.base64Decode(req.file.b64), 'image/jpeg', 'rota.jpg');
      opts.payload = { payload_json: JSON.stringify(payload), 'files[0]': blob };
    } else {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(payload);
    }
    const r = UrlFetchApp.fetch(`${hook}?wait=true${thread}`, opts);
    let j = {};
    try { j = JSON.parse(r.getContentText()); } catch (_) { /* empty answer */ }
    // Only what the site needs: never echo the webhook back.
    return out(r.getResponseCode(), { code: j.code, message: j.message, channel_id: j.channel_id });
  } catch (err) {
    return out(500, { message: String(err) });
  }
}

function underLimit() {
  const cache = CacheService.getScriptCache();
  const key = `n${Math.floor(Date.now() / 60000)}`;
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  return n <= PER_MINUTE;
}

function out(status, body) {
  return ContentService.createTextOutput(JSON.stringify({ status, body })).setMimeType(ContentService.MimeType.JSON);
}
