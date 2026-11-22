import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('no Discord webhook URL is shipped with the site', () => {
  for (const dir of ['js', '.']) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!/\.(js|html|json|md)$/.test(f)) continue;
      const text = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/, `${dir}/${f}`);
    }
  }
});
