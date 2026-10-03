// Publishes the freshly built installer to the BillTrix server. The server checks GitHub's own
// signed identity for this build (OIDC), so no password or key is stored anywhere.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const BASE = (process.env.BT_URL || '').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function identity() {
  const u = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, t = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!u || !t) throw new Error('No GitHub identity: the workflow needs "permissions: id-token: write".');
  const r = await fetch(u + (u.includes('?') ? '&' : '?') + 'audience=billtrix-desktop', { headers: { authorization: 'Bearer ' + t } });
  const j = await r.json().catch(() => ({}));
  if (!j.value) throw new Error('Could not get the GitHub identity (' + r.status + ').');
  return j.value;
}
async function upload(name, buf) {
  const cs = 16 * 1048576, total = Math.ceil(buf.length / cs);
  let tok = await identity(), at = Date.now();
  for (let i = 0; i < total; i++) {
    if (Date.now() - at > 4 * 60 * 1000) { tok = await identity(); at = Date.now(); }
    for (let attempt = 1; ; attempt++) {
      let r, msg;
      try {
        r = await fetch(`${BASE}/api/desktop/ci-part?name=${encodeURIComponent(name)}&part=${i}&total=${total}&size=${buf.length}`,
          { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/octet-stream' }, body: buf.subarray(i * cs, (i + 1) * cs) });
        if (r.ok) break;
        msg = `${r.status} ${(await r.text()).slice(0, 200)}`;
        if (r.status === 401) { tok = await identity(); at = Date.now(); }
        else if (r.status < 500) throw new Error(`${name} part ${i + 1}/${total}: ${msg}`);
      } catch (e) { if (r && !r.ok && r.status < 500 && r.status !== 401) throw e; msg = String(e.message || e); }
      if (attempt >= 5) throw new Error(`${name} part ${i + 1}/${total} failed: ${msg}`);
      await sleep(2000 * attempt);
    }
    if (i % 10 === 0 || i === total - 1) console.log(`${name}: ${i + 1}/${total}`);
  }
}
(async () => {
  if (!BASE) throw new Error('BT_URL is not set.');
  const dist = process.env.DIST_DIR || 'dist';
  const yml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  const ver = (yml.match(/^version:\s*(\S+)/m) || [])[1], exe = (yml.match(/^path:\s*(\S+)/m) || [])[1], sha = (yml.match(/^sha512:\s*(\S+)/m) || [])[1];
  if (!ver || !exe || !sha) throw new Error('latest.yml is incomplete.');
  const buf = fs.readFileSync(path.join(dist, exe));
  if (crypto.createHash('sha512').update(buf).digest('base64') !== sha) throw new Error('The installer does not match latest.yml.');
  console.log(`Publishing BillTrix Desktop ${ver} (${(buf.length / 1048576).toFixed(1)} MB) to ${BASE}`);
  await upload(exe, buf);
  await upload('latest.yml', Buffer.from(yml));
  const live = await (await fetch(`${BASE}/desktop/latest.yml?check=${Date.now()}`)).text();
  if (!live.includes(`version: ${ver}`)) throw new Error('The server does not show the new version.');
  console.log(`✅ BillTrix Desktop ${ver} is live. Shops get it the next time BillTrix opens.`);
})().catch((e) => { console.error('❌ ' + (e.message || e)); process.exit(1); });
