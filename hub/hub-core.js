/* BillTrix Local Hub — core store.
   Speaks the same "changes" protocol as the cloud server (GET/POST /api/tenant/:id/changes):
   every batch gets a new revision, stock is merged as +/- amounts, number counters only go up,
   a bill number used twice gets the next free number. On top of that it keeps an outbox of what
   the cloud has not seen yet and syncs it one upload at a time (never applying stock twice).
   No outside libraries: a JSON snapshot + an append-only journal on disk. */
'use strict';
const fs = require('fs');
const path = require('path');

const COLL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const WH_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RECORD_BYTES = 1500000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const key = (coll, rid) => coll + '\u0001' + rid;
class HubError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

class HubStore {
  constructor(dir, tenantId) {
    this.dir = dir; this.tenantId = tenantId;
    this.rev = 0; this.seq = 0;                 // local revision; insertion order for stable output
    this.recs = new Map();                      // key -> {coll,rid,data(string),deleted,rev,seq}
    this.out = { dirty: new Set(), dels: new Set(), delta: {} };   // not yet in the cloud
    this.inflight = null;                       // what the last unanswered upload carried
    this.cloudRev = 0;                          // last cloud revision we have
    this.colls = new Set();                     // every list the shop has (also empty ones, like the cloud sends)
    this.journal = null;
    if (dir) this._load();
  }

  /* ---------- disk ---------- */
  _file(n) { return path.join(this.dir, n); }
  _state() {
    return { tenantId: this.tenantId, rev: this.rev, seq: this.seq, cloudRev: this.cloudRev, inflight: this.inflight,
      out: { dirty: [...this.out.dirty], dels: [...this.out.dels], delta: this.out.delta },
      recs: [...this.recs.values()], colls: [...this.colls] };
  }
  _restore(s) {
    this.tenantId = s.tenantId || this.tenantId; this.rev = s.rev || 0; this.seq = s.seq || 0; this.cloudRev = s.cloudRev || 0; this.inflight = s.inflight || null;
    this.out = { dirty: new Set(s.out?.dirty || []), dels: new Set(s.out?.dels || []), delta: s.out?.delta || {} };
    this.recs = new Map((s.recs || []).map((r) => [key(r.coll, r.rid), r]));
    this.colls = new Set(s.colls || []);
  }
  _load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try { this._restore(JSON.parse(fs.readFileSync(this._file('hub-state.json'), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // replay anything written after the last snapshot (each line is a complete state change)
    try {
      const lines = fs.readFileSync(this._file('hub-journal.jsonl'), 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) { let j; try { j = JSON.parse(ln); } catch { break; } if (j.rev > this.rev || j.kind === 'sync') this._replay(j); }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.snapshot();
  }
  _replay(j) {
    for (const r of j.recs) this.recs.set(key(r.coll, r.rid), r);
    this.rev = Math.max(this.rev, j.rev); this.seq = Math.max(this.seq, j.seq || 0);
    if (j.out) this.out = { dirty: new Set(j.out.dirty), dels: new Set(j.out.dels), delta: j.out.delta };
    if ('cloudRev' in j) this.cloudRev = j.cloudRev;
    if ('inflight' in j) this.inflight = j.inflight;
  }
  _log(kind, recs) {
    if (!this.dir) return;
    const line = JSON.stringify({ kind, rev: this.rev, seq: this.seq, recs, cloudRev: this.cloudRev, inflight: this.inflight,
      out: { dirty: [...this.out.dirty], dels: [...this.out.dels], delta: this.out.delta } }) + '\n';
    const fd = fs.openSync(this._file('hub-journal.jsonl'), 'a'); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  snapshot() {
    if (!this.dir) return;
    const tmp = this._file('hub-state.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this._state())); const fd = fs.openSync(tmp, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, this._file('hub-state.json'));
    fs.writeFileSync(this._file('hub-journal.jsonl'), '');
  }

  /* ---------- reading (same shapes as the cloud) ---------- */
  _out(r) { const data = r.deleted ? null : JSON.parse(r.data); if (data && r.coll === 'users') delete data.passHash; return { coll: r.coll, rid: r.rid, data, deleted: !!r.deleted }; }
  changesSince(since) {
    const rows = [...this.recs.values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev || a.seq - b.seq);
    if (rows.length > 5000) return { rev: this.rev, changes: [], reload: true };
    return { rev: this.rev, changes: rows.map((r) => this._out(r)) };
  }
  doc() {
    const d = { attendance: {} };
    for (const k of this.colls) d[k] = [];
    for (const r of [...this.recs.values()].filter((x) => !x.deleted).sort((a, b) => a.seq - b.seq)) {
      const v = JSON.parse(r.data); if (r.coll === 'users') delete v.passHash;
      if (r.coll === '_meta') d[r.rid] = v; else if (r.coll === 'attendance') d.attendance[r.rid] = v; else (d[r.coll] ||= []).push(v);
    }
    if (Array.isArray(d.audit)) d.audit.reverse();
    return { data: d, rev: this.rev };
  }

  /* ---------- a counter's changes (POST /changes) ---------- */
  applyChanges(b, opts = {}) {
    const baseRev = num(b.baseRev);
    const upserts = (Array.isArray(b.upserts) ? b.upserts : []).map((u) => ({ coll: u && u.coll, rid: String(u?.rid ?? ''), data: u && u.data }));
    const deletes = (Array.isArray(b.deletes) ? b.deletes : []).map((d) => ({ coll: d && d.coll, rid: String(d?.rid ?? '') }));
    if (upserts.length + deletes.length > 3000) throw new HubError(413, 'Too many changes at once. Please try again.');
    for (const r of [...upserts, ...deletes]) if (!COLL_RE.test(String(r.coll)) || !r.rid || r.rid.length > 120 || /[\u0000-\u001f]/.test(r.rid)) throw new HubError(400, 'Invalid record.');
    for (const u of upserts) { if (u.data === undefined) throw new HubError(400, 'Invalid record.'); if (JSON.stringify(u.data).length > MAX_RECORD_BYTES) throw new HubError(413, 'One record is too large to save.'); }
    if (!opts.fromCloud && [...upserts, ...deletes].some((r) => r.coll === 'users' || r.coll === 'roles'))
      throw new HubError(409, 'Users and roles can be changed only with internet (on the cloud).');

    // a bill number already used by another bill gets the next free number (same rule as the cloud)
    const renumbered = [];
    const taken = new Map();
    for (const r of this.recs.values()) if (r.coll === 'sales' && !r.deleted) { const no = JSON.parse(r.data).no; if (no != null) taken.set(String(no), r.rid); }
    const split = (no) => { const m = /^(.*?)(\d+)$/.exec(no); return m ? [m[1], Number(m[2]), m[2].length] : [no + '-', 0, 4]; };
    const maxFor = (p) => { let mx = 0; for (const n of taken.keys()) { const [q, v] = split(n); if (q === p) mx = Math.max(mx, v); } return mx; };
    const bumps = {};
    for (const u of upserts) {
      if (u.coll !== 'sales' || !u.data || u.data.no == null) continue;
      const owner = taken.get(String(u.data.no));
      if (owner && owner !== u.rid) {
        const [prefix, , width] = split(String(u.data.no)); const next = maxFor(prefix) + 1;
        u.data = { ...u.data, no: `${prefix}${String(next).padStart(Math.max(4, width), '0')}` };
        renumbered.push({ rid: u.rid, no: u.data.no });
        const fy = /\/(\d{2})-(\d{2})\/$/.exec(prefix); bumps[fy ? `sale_20${fy[1]}_${fy[2]}` : 'sale'] = next + 1;
      }
      taken.set(String(u.data.no), u.rid);
    }
    if (Object.keys(bumps).length) {
      let c = upserts.find((u) => u.coll === '_meta' && u.rid === 'counters');
      if (!c) { c = { coll: '_meta', rid: 'counters', data: {} }; upserts.push(c); }
      c.data = { ...c.data }; for (const [k, v] of Object.entries(bumps)) c.data[k] = Math.max(num(c.data[k]), v);
    }

    this.rev += 1; const rev = this.rev; const written = [];
    for (const u of upserts) {
      const k = key(u.coll, u.rid); const cur = this.recs.get(k); let data = { ...u.data };
      if (u.coll === 'products' && data._stockDelta && typeof data._stockDelta === 'object') {
        const delta = data._stockDelta; delete data._stockDelta;
        if (cur && !cur.deleted) {
          const old = JSON.parse(cur.data).stock || {};
          const whs = Object.keys({ ...(data.stock || {}), ...delta }).filter((w) => WH_RE.test(w)).slice(0, 28);
          if (whs.length) { data.stock = { ...(data.stock || {}) }; for (const w of whs) data.stock[w] = r3(num(old[w]) + num(delta[w])); }
        }
        if (!opts.fromCloud) for (const [w, v] of Object.entries(delta)) if (WH_RE.test(w)) { const d = (this.out.delta[u.rid] ||= {}); d[w] = r3(num(d[w]) + num(v)); }
      } else if (u.coll === '_meta' && u.rid === 'counters' && cur && !cur.deleted) {
        const old = JSON.parse(cur.data); data = { ...data };
        for (const [kk, v] of Object.entries(old)) if (typeof v === 'number') data[kk] = typeof data[kk] === 'number' ? Math.max(v, data[kk]) : (kk in data ? data[kk] : v);
      }
      delete data._stockDelta;
      const rec = { coll: u.coll, rid: u.rid, data: JSON.stringify(data), deleted: 0, rev, seq: cur ? cur.seq : ++this.seq };
      this.recs.set(k, rec); written.push(rec);
      if (!opts.fromCloud) { this.out.dirty.add(k); this.out.dels.delete(k); }
    }
    for (const d of deletes) {
      const k = key(d.coll, d.rid); const cur = this.recs.get(k);
      const rec = { coll: d.coll, rid: d.rid, data: '{}', deleted: 1, rev, seq: cur ? cur.seq : ++this.seq };
      this.recs.set(k, rec); written.push(rec);
      if (!opts.fromCloud) { this.out.dels.add(k); this.out.dirty.delete(k); if (d.coll === 'products') delete this.out.delta[d.rid]; }
    }
    this._log('apply', written);
    return { ...this.changesSince(baseRev), renumbered };
  }

  /* ---------- cloud sync ---------- */
  pendingCount() { return this.out.dirty.size + this.out.dels.size + (this.inflight ? 1 : 0); }
  /** What to send next (and remember it as "in flight" until the cloud answers). */
  takeUpload() {
    if (this.inflight) return this.inflight.payload;
    if (!this.out.dirty.size && !this.out.dels.size) return null;
    const upserts = [], deletes = [];
    for (const k of this.out.dirty) {
      const r = this.recs.get(k); if (!r || r.deleted) continue;
      const data = JSON.parse(r.data);
      if (r.coll === 'products' && this.out.delta[r.rid]) data._stockDelta = { ...this.out.delta[r.rid] };
      upserts.push({ coll: r.coll, rid: r.rid, data });
    }
    for (const k of this.out.dels) { const [coll, rid] = k.split('\u0001'); deletes.push({ coll, rid }); }
    const payload = { baseRev: this.cloudRev, upserts, deletes };
    this.inflight = { payload, at: Date.now() };
    this.out = { dirty: new Set(), dels: new Set(), delta: {} };
    this._log('sync', []);
    return payload;
  }
  /** The cloud accepted the upload: take its answer (renumbered bills, other devices' changes). */
  uploadDone(resp) {
    const sent = this.inflight && this.inflight.payload; this.inflight = null;
    const ren = new Map((resp.renumbered || []).map((x) => [x.rid, x.no]));
    if (ren.size) for (const [rid, no] of ren) { const r = this.recs.get(key('sales', rid)); if (r && !r.deleted) { const d = JSON.parse(r.data); d.no = no; r.data = JSON.stringify(d); r.rev = ++this.rev; } }
    this._mergeCloud(resp.changes || [], resp.rev, sent);
  }
  /** The upload failed for sure (the cloud said no): put it back in the queue. */
  uploadFailed() {
    const p = this.inflight && this.inflight.payload; this.inflight = null; if (!p) return;
    for (const u of p.upserts) {
      const k = key(u.coll, u.rid); if (!this.out.dels.has(k)) this.out.dirty.add(k);
      if (u.coll === 'products' && u.data._stockDelta) for (const [w, v] of Object.entries(u.data._stockDelta)) { const d = (this.out.delta[u.rid] ||= {}); d[w] = r3(num(d[w]) + num(v)); }
    }
    for (const d of p.deletes) this.out.dels.add(key(d.coll, d.rid));
    this._log('sync', []);
  }
  /** The reply was lost: did the upload arrive? (checked against the cloud's changes since baseRev) */
  arrived(cloudChanges) {
    const sent = this.inflight && this.inflight.payload; if (!sent) return true;
    const got = new Map(cloudChanges.map((c) => [key(c.coll, c.rid), c]));
    const strip = (d) => { const x = { ...d }; delete x._stockDelta; delete x.stock; return JSON.stringify(x); };
    const unique = sent.upserts.filter((u) => u.coll !== 'products' && u.coll !== '_meta');
    if (unique.length) return unique.every((u) => got.has(key(u.coll, u.rid)));
    const prods = sent.upserts.filter((u) => u.coll === 'products');
    if (prods.length) return prods.every((u) => { const c = got.get(key('products', u.rid)); return c && !c.deleted && strip(c.data) === strip(u.data); });
    return sent.deletes.length > 0 && sent.deletes.every((d) => { const c = got.get(key(d.coll, d.rid)); return c && c.deleted; });
  }
  /** Other devices' changes from the cloud (GET /changes on the cloud). */
  pullDone(resp) { this._mergeCloud(resp.changes || [], resp.rev, null); }
  _mergeCloud(changes, cloudRev, justSent) {
    const sentKeys = new Set(justSent ? [...justSent.upserts, ...justSent.deletes].map((x) => key(x.coll, x.rid)) : []);
    const written = []; let bumped = false;
    for (const c of changes) {
      const k = key(c.coll, c.rid); const cur = this.recs.get(k);
      // something changed here again after the upload: keep the newer local version (it is queued)
      if ((this.out.dirty.has(k) || this.out.dels.has(k)) && !(c.coll === 'products' && !c.deleted)) continue;
      if (!bumped) { this.rev += 1; bumped = true; }
      if (c.deleted) { const rec = { coll: c.coll, rid: c.rid, data: '{}', deleted: 1, rev: this.rev, seq: cur ? cur.seq : ++this.seq }; this.recs.set(k, rec); written.push(rec); continue; }
      let data = c.data;
      if (c.coll === 'users' && cur && !cur.deleted) { const old = JSON.parse(cur.data); if (old.passHash && !data.passHash) data = { ...data, passHash: old.passHash }; }
      if (c.coll === 'products') {
        // cloud stock is the truth; add what this shop sold that the cloud has not seen yet
        const pend = this.out.delta[c.rid];
        if (this.out.dirty.has(k) && cur && !cur.deleted) data = { ...JSON.parse(cur.data), stock: { ...(c.data.stock || {}) } };
        if (pend) { data = { ...data, stock: { ...(data.stock || {}) } }; for (const [w, v] of Object.entries(pend)) data.stock[w] = r3(num(data.stock[w]) + num(v)); }
      }
      const rec = { coll: c.coll, rid: c.rid, data: JSON.stringify(data), deleted: 0, rev: this.rev, seq: cur ? cur.seq : ++this.seq };
      this.recs.set(k, rec); written.push(rec);
    }
    if (typeof cloudRev === 'number') this.cloudRev = Math.max(this.cloudRev, cloudRev);
    this._log('sync', written);
  }
  /** First start: take the whole shop from the cloud. */
  seedFromCloud(doc, cloudRev) {
    this.recs = new Map(); this.rev = 1; this.seq = 0; this.colls = new Set(Object.keys(doc).filter((k) => Array.isArray(doc[k]))); this.out = { dirty: new Set(), dels: new Set(), delta: {} }; this.inflight = null;
    for (const [k, v] of Object.entries(doc)) {
      if (Array.isArray(v)) { const items = k === 'audit' ? [...v].reverse() : v; for (const x of items) if (x && typeof x === 'object' && x.id != null) this.recs.set(key(k, String(x.id)), { coll: k, rid: String(x.id), data: JSON.stringify(x), deleted: 0, rev: 1, seq: ++this.seq }); }
      else if (k === 'attendance' && v && typeof v === 'object') { for (const [d, m] of Object.entries(v)) this.recs.set(key('attendance', d), { coll: 'attendance', rid: d, data: JSON.stringify(m), deleted: 0, rev: 1, seq: ++this.seq }); }
      else this.recs.set(key('_meta', k), { coll: '_meta', rid: k, data: JSON.stringify(v), deleted: 0, rev: 1, seq: ++this.seq });
    }
    this.cloudRev = cloudRev; this.snapshot();
  }
}

module.exports = { HubStore, HubError };
