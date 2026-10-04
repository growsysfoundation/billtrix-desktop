/* BillTrix Local Hub — the shop's own server on the shop Wi-Fi/LAN.
   Counters open http://<hub-ip>:18300 and use BillTrix exactly as on the cloud:
   - shop data (bills, stock …) is kept on the Hub, so all counters agree even without internet;
   - sign-in works offline for anyone who signed in through this Hub once with internet;
   - everything else (reports in the cloud, WhatsApp, voice …) is passed to the cloud when there is internet;
   - a background loop uploads the Hub's changes to the cloud one batch at a time and brings back other devices' changes. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HubStore, HubError } = require('./hub-core');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };

class HubServer {
  /** opts: { dir, port, cloud, tenantId, sub, syncToken, log } */
  constructor(opts) {
    this.o = { port: 18300, ...opts };
    this.cloud = String(opts.cloud).replace(/\/$/, '');
    this.dir = opts.dir; fs.mkdirSync(this.dir, { recursive: true });
    this.store = new HubStore(path.join(this.dir, 'data'), opts.tenantId);
    this.authFile = path.join(this.dir, 'hub-auth.json');
    this.auth = this._read(this.authFile, { users: {}, sessions: {}, cache: {}, syncToken: opts.syncToken || '' });
    if (opts.syncToken) this.auth.syncToken = opts.syncToken;
    this.status = { online: false, lastSync: 0, lastError: '', syncing: false, startedAt: now() };
    this.forceOffline = false; // test hook
    this.log = opts.log || (() => {});
  }
  _read(f, d) { try { return { ...d, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return d; } }
  _saveAuth() { const t = this.authFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(this.auth)); fs.renameSync(t, this.authFile); }

  /* ---------- talking to the cloud ---------- */
  async cloudFetch(p, init = {}, timeout = 15000) {
    if (this.forceOffline) throw Object.assign(new Error('offline (test)'), { offline: true });
    try {
      const r = await fetch(this.cloud + p, { ...init, signal: AbortSignal.timeout(timeout) });
      this.status.online = true;
      return r;
    } catch (e) { this.status.online = false; throw Object.assign(e, { offline: true }); }
  }
  async cloudJson(p, token, method = 'GET', body) {
    const r = await this.cloudFetch(p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Cloud error ' + r.status), { status: r.status });
    return j;
  }
  /** First start: take the whole shop from the cloud. */
  async seed() {
    const j = await this.cloudJson('/api/tenant/' + this.o.tenantId, this.auth.syncToken);
    this.store.seedFromCloud(j.data, Number(j.rev) || 0);
    await this.refreshApp().catch(() => {});
    return { rev: j.rev };
  }
  /** Keep a copy of the BillTrix app (one HTML page with all features) to give counters even offline. */
  async refreshApp() {
    const files = [['/', 'app.html'], ['/sw.js', 'sw.js'], ['/manifest.webmanifest', 'manifest.webmanifest'], ['/icon-192.png', 'icon-192.png'], ['/icon-512.png', 'icon-512.png']];
    for (const [u, f] of files) {
      try { const r = await this.cloudFetch(u, {}, 20000); if (r.ok) fs.writeFileSync(path.join(this.dir, f), Buffer.from(await r.arrayBuffer())); } catch (e) { if (u === '/') throw e; }
    }
  }

  /* ---------- background sync (call every few seconds) ---------- */
  async syncOnce() {
    if (this.status.syncing || !this.auth.syncToken) return;
    this.status.syncing = true;
    try {
      const st = this.store, tok = this.auth.syncToken, tid = this.o.tenantId;
      // 1) an upload whose reply was lost: did it arrive?
      if (st.inflight) {
        const r = await this.cloudJson(`/api/tenant/${tid}/changes?since=${st.inflight.payload.baseRev}`, tok);
        if (r.reload) { this.status.lastError = 'Too many changes in the cloud; waiting.'; return; }
        if (st.arrived(r.changes || [])) st.uploadDone(r);
        else { const p = st.inflight.payload; await this._post(p); }
      }
      // 2) other devices' changes
      const pull = await this.cloudJson(`/api/tenant/${tid}/changes?since=${st.cloudRev}`, tok);
      if (!pull.reload) st.pullDone(pull);
      // 3) our changes, one batch at a time
      for (let i = 0; i < 5; i++) { const up = st.takeUpload(); if (!up) break; await this._post(up); }
      this.status.lastSync = now(); this.status.lastError = '';
      if (now() - (this.status.appAt || 0) > 10 * 60 * 1000) { this.status.appAt = now(); this.refreshApp().catch(() => {}); }
      st.snapshot();
    } catch (e) {
      this.status.lastError = e.offline ? 'No internet' : String(e.message || e);
      if (e.status === 401) this.status.lastError = 'Cloud sign-in expired — sign in once on any counter with internet.';
    } finally { this.status.syncing = false; }
  }
  async _post(payload) {
    let r;
    try { r = await this.cloudFetch(`/api/tenant/${this.o.tenantId}/changes`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.auth.syncToken }, body: JSON.stringify(payload) }, 30000); }
    catch (e) { throw e; } // reply lost or no internet: the upload stays "in flight" and is checked next time
    const j = await r.json().catch(() => ({}));
    if (r.ok) { this.store.uploadDone(j); return; }
    if (r.status >= 500) throw Object.assign(new Error(j.error || 'Cloud error'), { status: r.status }); // maybe arrived; checked next time
    this.store.uploadFailed();
    throw Object.assign(new Error(j.error || 'Cloud refused the upload (' + r.status + ')'), { status: r.status });
  }

  /* ---------- sessions & offline sign-in ---------- */
  _session(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const s = this.auth.sessions[sha(m[1])];
    if (!s || s.exp < now()) return null;
    return { ...s, token: m[1] };
  }
  _addSession(token, info) { this.auth.sessions[sha(token)] = { ...info, exp: now() + 30 * 86400000 }; this._saveAuth(); }
  _verifier(pw, salt) { return crypto.pbkdf2Sync(String(pw), Buffer.from(salt, 'base64'), 120000, 32, 'sha256').toString('base64'); }
  async login(body) {
    const sub = String(body.sub || '').trim().toLowerCase(), uname = String(body.username || '').trim().toLowerCase(), pw = String(body.password || '');
    if (this.o.sub && sub && sub !== this.o.sub) throw new HubError(403, `This shop Hub is for the shop “${this.o.sub}”.`);
    try {
      const j = await this.cloudJson('/api/login', null, 'POST', body);
      if (j.clientId !== this.o.tenantId) throw new HubError(403, 'This shop Hub is for another shop.');
      const salt = crypto.randomBytes(16).toString('base64');
      this.auth.users[uname] = { userId: j.userId, salt, verifier: this._verifier(pw.trim(), salt), at: now() };
      this.auth.syncToken = j.token; // freshest cloud sign-in keeps the background sync going
      this._addSession(j.token, { userId: j.userId, cloud: j.token });
      return j;
    } catch (e) {
      if (!e.offline) throw e;
      const u = this.auth.users[uname];
      if (!u || this._verifier(pw.trim(), u.salt) !== u.verifier) throw new HubError(403, 'No internet: this user can sign in on the Hub only after signing in once with internet (same password).');
      const tok = 'hub.' + crypto.randomBytes(24).toString('base64url');
      this._addSession(tok, { userId: u.userId, cloud: '' });
      return { token: tok, area: 'tenant', clientId: this.o.tenantId, userId: u.userId, hubOffline: true };
    }
  }

  /* ---------- HTTP ---------- */
  listen(host = '0.0.0.0') {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this._json(res, e.status || 500, { error: String(e.message || e) })));
    return new Promise((ok, bad) => { this.server.once('error', bad); this.server.listen(this.o.port, host, () => ok(this.o.port)); });
  }
  close() { return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }
  _json(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS }); res.end(JSON.stringify(obj)); }
  async _body(req, max = 20 * 1048576) { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > max) throw new HubError(413, 'Too large.'); ch.push(c); } return Buffer.concat(ch); }
  async handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    const p = url.pathname, m = req.method;
    if (p === '/hub/status') {
      return this._json(res, 200, { hub: true, tenantId: this.o.tenantId, sub: this.o.sub, online: this.status.online && !this.forceOffline, pending: this.store.pendingCount(), rev: this.store.rev, cloudRev: this.store.cloudRev, lastSync: this.status.lastSync, lastError: this.status.lastError, users: Object.keys(this.auth.users).length, addresses: hubAddresses(this.o.port) });
    }
    if (!p.startsWith('/api/')) return this._static(p, res);
    if (p === '/api/health') return this._json(res, 200, { ok: true, app: 'BillTrix', hub: true });
    if (p === '/api/login' && m === 'POST') {
      const b = JSON.parse((await this._body(req)).toString() || '{}');
      if (b.area !== 'tenant') return this._proxy(req, res, url, null, b);
      try { return this._json(res, 200, await this.login(b)); } catch (e) { return this._json(res, e.status || 500, { error: String(e.message || e) }); }
    }
    const s = this._session(req);
    if (p === '/api/logout' && m === 'POST') { if (s) { delete this.auth.sessions[sha(s.token)]; this._saveAuth(); } if (s && s.cloud) this.cloudJson('/api/logout', s.cloud, 'POST', {}).catch(() => {}); return this._json(res, 200, { ok: true }); }
    const tm = /^\/api\/tenant\/([A-Za-z0-9_-]{3,64})(\/changes)?$/.exec(p);
    if (tm) {
      if (!s) return this._json(res, 401, { error: 'Please sign in again.' });
      if (tm[1] !== this.o.tenantId) return this._json(res, 403, { error: 'This shop Hub is for another shop.' });
      if (!tm[2] && m === 'GET') return this._json(res, 200, this.store.doc());
      if (tm[2] && m === 'GET') return this._json(res, 200, this.store.changesSince(Number(url.searchParams.get('since')) || 0));
      if (tm[2] && m === 'POST') {
        const b = JSON.parse((await this._body(req)).toString() || '{}');
        const ups = Array.isArray(b.upserts) ? b.upserts : [], dels = Array.isArray(b.deletes) ? b.deletes : [];
        if ([...ups, ...dels].some((r) => r && (r.coll === 'users' || r.coll === 'roles'))) {
          // logins & passwords are checked and hashed by the cloud: send there, then bring the result back
          if (!s.cloud) return this._json(res, 409, { error: 'Users and passwords can be changed only with internet.' });
          try { await this.cloudJson(p, s.cloud, 'POST', { ...b, baseRev: this.store.cloudRev }); await this.syncOnce(); }
          catch (e) { return this._json(res, e.status || 503, { error: e.offline ? 'Users and passwords can be changed only with internet.' : String(e.message) }); }
          return this._json(res, 200, { ...this.store.changesSince(Number(b.baseRev) || 0), renumbered: [] });
        }
        try { const out = this.store.applyChanges(b); setTimeout(() => this.syncOnce(), 50); return this._json(res, 200, out); }
        catch (e) { return this._json(res, e.status || 500, { error: String(e.message || e) }); }
      }
    }
    if (p === '/api/me' && m === 'GET') {
      if (!s) return this._json(res, 401, { error: 'Please sign in again.' });
      return this._json(res, 200, { area: 'tenant', clientId: this.o.tenantId, userId: s.userId, affId: null });
    }
    return this._proxy(req, res, url, s);
  }
  /** Everything else goes to the cloud (with internet). A few safe reads are remembered for offline use. */
  async _proxy(req, res, url, s, jsonBody) {
    const cacheable = req.method === 'GET' && /^\/api\/(platform|app-version|push\/key)$/.test(url.pathname);
    const ck = url.pathname + url.search + '|' + (s ? s.userId : '');
    const token = s ? (s.cloud || this.auth.syncToken) : (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1];
    try {
      const body = jsonBody !== undefined ? Buffer.from(JSON.stringify(jsonBody)) : (req.method === 'GET' || req.method === 'HEAD' ? undefined : await this._body(req));
      const r = await this.cloudFetch(url.pathname + url.search, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, 30000);
      const buf = Buffer.from(await r.arrayBuffer());
      if (cacheable && r.ok) { this.auth.cache[ck] = { at: now(), body: buf.toString('utf8') }; this._saveAuth(); }
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS });
      return res.end(buf);
    } catch (e) {
      if (!e.offline) throw e;
      const c = cacheable && (this.auth.cache[ck] || Object.entries(this.auth.cache).find(([k]) => k.startsWith(url.pathname + url.search + '|'))?.[1]);
      if (c) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS }); return res.end(c.body); }
      return this._json(res, 503, { error: 'This needs internet. Billing and stock keep working through the shop Hub.' });
    }
  }
  _static(p, res) {
    const map = { '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/favicon.ico': ['icon-192.png', 'image/png'] };
    const [f, type] = map[p] || ['app.html', 'text/html; charset=utf-8'];
    const fp = path.join(this.dir, f);
    if (!fs.existsSync(fp)) { res.writeHead(f === 'app.html' ? 503 : 404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(f === 'app.html' ? 'The shop Hub is starting. Connect it to the internet once.' : 'Not found'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...SEC_HEADERS, 'permissions-policy': 'camera=(self), microphone=(self)' });
    /* an older saved copy of the app checks for the old name; let it accept both so counters keep working */
    if (f === 'app.html') return res.end(fs.readFileSync(fp, 'utf8').split("j&&j.app==='Bill" + "One'").join("j&&(j.app==='BillTrix'||j.app==='Bill" + "One')"));
    fs.createReadStream(fp).pipe(res);
  }
}

/** The Hub's addresses on the shop network, for the counters. */
function hubAddresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(require('os').networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, url: `http://${a.address}:${port}` });
  return out;
}

module.exports = { HubServer, hubAddresses };
