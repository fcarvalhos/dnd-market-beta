# The Gilded Ledger (beta)

Beta copy of [dnd-market](https://github.com/fcarvalhos/dnd-market). In this version the Market has no Abilities & Boons or Homebrew Tomes sections: checks use only the character sheet.

A D&D market companion for the table's downtime rules. It rolls the checks to find **magic item vendors**, **crafting material suppliers** and **buyers for loot**. It spends your character's abilities automatically to maximize your odds, and posts the result to a Discord channel.

Static site: plain HTML, CSS and JS modules with no build step and no dataset. Everything runs in the browser.

## Features

- **Five activities:** Buy Magic Item, Buy Raw Materials, Sell Magic Item, Sell Mundane Item, Sell Raw Materials (mundane or magical).
- **Table rules built in:** DC by rarity (10/15/20/25/30). Minimum search is 7 days / 100 GP on the Material Plane and 14 days / 200 GP on other planes, with +1 per extra 7 days or 100 GP (max +10). Also: the 30-day wait after a failed purchase, one magic-item buyer search per day, full/half/150% payouts and consumables at half price.
- **Abilities as checkboxes:** Guidance, Enhance Ability, Tides of Chaos, Portent, Reliable Talent, Silver Tongue, Jack of All Trades, Halfling Luck, Bardic Inspiration, Flash of Genius, Tactical Mind, Lucky, Heroic Inspiration and Stroke of Luck. Limited uses are tracked, with a *Long rest* button.
- **Automatic spending, by strategy:**
  1. Free help (Guidance) is applied first.
  2. Portent uses the lowest foretold roll that guarantees success.
  3. Paid pre-roll help (advantage, bonus dice) is spent only if the check isn't already certain and isn't impossible.
  4. After a failed roll, the ledger spends the ability most likely to turn it into a success, cheapest first on ties, and stops as soon as the check passes.
  5. *Conserve resources* only spends pre-roll help when the base chance is below 50%.
- **Odds preview** from thousands of simulated rolls, with a chart of search bonus vs. chance so you can see how much gold is worth spending.
- **Homebrew JSON upload** for classes, subclasses, heritages, feats, items and spells. Files from the `dnd-sheet` app are accepted too.
- **Discord** via a channel webhook. Each post shows the objective, every die, the modifiers and the abilities used.
- **Experience section:** the party roster with level progress bars, session XP awards and the session log. It syncs with the XP tracker's Google Sheet (`js/xp.js`).
- **Factions section:** reputation per adventurer, faction relations with ripple effects and a chronicle. It syncs with the faction tracker's Google Sheet (`js/factions.js`), and the Company can be imported from the XP roster.
- **Travel section** (`js/travel.js`): trace a route on the Faerûn map (0.8 miles per pixel, from the poster's scale bar) and get distance, days and cost by the table's travel rules. Preset and custom travel methods, supplies, DM points of interest, a Discord travel log with the route image, and the daily *Viagens Agitadas* rolls. To share points of interest, deploy `apps-script/travel-pois.gs` and paste its URL into `POI_API` in `js/travel.js`.
- **DM keys:** both sheets are read-only until the DM enters the key with the *DM key* button. Keys are stored in the browser, never in the code.
- **Ledger** of every roll, with *Copy record* in the table's registration template.

## Deploy to GitHub Pages

1. Create a repository and push this folder's contents (`index.html` at the root).
2. Go to **Settings → Pages → Build and deployment** and pick *Deploy from a branch*, then `main` / `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`.

## Connect Discord

In your server: **Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL**. In the app, paste it into **Discord Raven** and click *Send test*.

The table's Market and Travel webhooks are built in (`BUILT_IN` in `js/discord.js`), so players paste nothing; a webhook a player pastes overrides them in that browser only. The built-in URLs are public with the site: if a channel gets spammed, delete that webhook in Discord and replace it in the code.

## Homebrew JSON format

```json
{
  "format": "dnd-market-content",
  "version": 1,
  "source": "My homebrew",
  "entries": [
    {
      "kind": "feat",
      "name": "Silver Merchant",
      "summary": "+2 Persuasion; once per rest add 1d6 after failing.",
      "uses": 1,
      "effects": [
        { "type": "bonus", "value": 2, "skills": ["persuasion"] },
        { "type": "bonus", "value": "1d6", "timing": "reactive" }
      ]
    }
  ]
}
```

| `type` | fields | meaning |
| --- | --- | --- |
| `bonus` | `value`: number, `"cha"`/`"int"`/`"wis"`, `"prof"`, `"half-prof"` or `"1dN"` | add to the check |
| `advantage` | | advantage (use `"timing": "pre"` plus `uses` for limited sources) |
| `reroll` | `keep`: `"new"` (default) or `"best"` | reroll the d20 after a failed roll |
| `min-roll` | `value`, `requiresProficiency` | a d20 below `value` counts as `value` |
| `proficiency` | `level`: `proficient` / `expertise` / `half` | proficiency in the skills |
| `set-roll` | `value` (default 20) | turn a failed d20 into this value |
| `reroll-ones` | | reroll natural 1s |

- **`timing`:** `passive` (default), `pre` (before the roll) or `reactive` (only after a failed roll).
- **`skills`:** any of `persuasion`, `deception`, `investigation`, `cha`, `int`. Leave it out to apply to every check.
- **`uses` / `cost`:** set per entry. `cost` is a rank where lower is spent first; the default is 2.
- **Built-in names:** an entry named like a built-in ability with no effects (e.g. `{ "name": "Lucky" }`) just switches that ability on.
- **Ignored effects:** effects that don't touch these checks (AC, damage, saves…) are skipped.

See [`examples/market-homebrew-example.json`](examples/market-homebrew-example.json).

## Development

```bash
npm test                     # unit tests (Node 20+)
python -m http.server 5510   # then open http://localhost:5510
```

ES modules need a web server. Opening `index.html` straight from disk won't work.

## Map credit

The Faerûn map is the 2001 poster map © Wizards of the Coast, taken from [vectorized-realms](https://github.com/jonovotny/vectorized-realms). The Gilded Ledger is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
