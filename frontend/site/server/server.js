'use strict';
/**
 * AquaNexus donation server — zero dependencies (Node 18+).
 *
 * What it does
 *  - Creates Razorpay orders for card donations (secret key stays on this server).
 *  - Verifies the checkout signature, then confirms the payment with Razorpay's API before saying "verified".
 *  - Receives Razorpay webhooks (signature-checked, de-duplicated) so records stay correct even if the donor closes the tab.
 *  - Stores one record per donation in a JSON file (no card data is ever received, logged or stored).
 *
 * What it does NOT do
 *  - It never sees card numbers / CVV: those are typed into Razorpay's own checkout window.
 *  - It cannot verify a plain UPI QR / deep-link payment (see README → "UPI verification").
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- tiny .env loader (no dependency) ---------- */
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (_) { /* no .env file: rely on real environment variables */ }
}

function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: (env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').replace(/\/$/, ''),
    minInr: Number(env.MIN_AMOUNT_INR || 10),
    maxInr: Number(env.MAX_AMOUNT_INR || 100000),
    allowedOrigin: env.ALLOWED_ORIGIN || '',
    dataFile: env.DATA_FILE || path.join(__dirname, 'data', 'donations.json'),
    siteFile: env.SITE_FILE === 'off' ? null : (env.SITE_FILE || path.join(__dirname, '..', 'index.html')),
    trustProxy: env.TRUST_PROXY === 'true',
    merchantName: env.MERCHANT_NAME || 'AquaNexus'
  };
}

/* ---------- money helpers (exact integer arithmetic, no floats) ---------- */
const AMOUNT_RE = /^(0|[1-9]\d{0,6})(\.\d{1,2})?$/;
function parseAmountToPaise(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).trim();
  if (!AMOUNT_RE.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}
function paiseToString(p) {
  const w = Math.floor(p / 100), f = p % 100;
  return f === 0 ? String(w) : `${w}.${String(f).padStart(2, '0')}`;
}

/* ---------- JSON file store with serialized atomic writes ---------- */
class Store {
  constructor(file) {
    this.file = file;
    this.data = { donations: {}, events: {} };
    this.queue = Promise.resolve();
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first run */ }
    this.data.donations = this.data.donations || {};
    this.data.events = this.data.events || {};
  }
  byKey(key) { return Object.values(this.data.donations).find(d => d.idempotencyKey === key); }
  byOrder(orderId) { return Object.values(this.data.donations).find(d => d.orderId === orderId); }
  get(id) { return this.data.donations[id]; }
  save() {
    const snapshot = JSON.stringify(this.data);
    this.queue = this.queue.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    }).catch(e => console.error('store write failed:', e.message));
    return this.queue;
  }
}

/* ---------- helpers ---------- */
const safeEqualHex = (a, b) => {
  try {
    const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (_) { return false; }
};
const hmacHex = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createApp(cfg) {
  const store = new Store(cfg.dataFile);
  const cardEnabled = !!(cfg.keyId && cfg.keySecret);
  const locks = new Map();           // per-donation mutex to stop double processing
  const hits = new Map();            // naive per-IP rate limiter
  const withLock = async (id, fn) => {
    const prev = locks.get(id) || Promise.resolve();
    let release; const next = new Promise(r => (release = r));
    const chain = prev.then(() => next);
    locks.set(id, chain);
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(id) === chain) locks.delete(id); }
  };

  async function razorpay(method, endpoint, body) {
    const res = await fetch(cfg.apiBase + endpoint, {
      method,
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64'), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
    if (!res.ok) { console.error(`razorpay ${method} ${endpoint} -> ${res.status}`, json && json.error ? json.error.description : ''); throw new HttpError(502, 'The payment gateway rejected the request.'); }
    return json;
  }

  function clientIp(req) {
    if (cfg.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }
  function rateLimit(req) {
    const ip = clientIp(req), now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
    arr.push(now); hits.set(ip, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
    if (arr.length > 30) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
  }

  function send(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra));
    res.end(body);
  }

  async function jsonBody(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
    const raw = await readBody(req);
    try { const o = JSON.parse(raw.toString('utf8')); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; return o; }
    catch (_) { throw new HttpError(400, 'Invalid JSON body'); }
  }

  /* ---- POST /api/donations/card/order ---- */
  async function createOrder(req) {
    if (!cardEnabled) throw new HttpError(503, 'Card payments are not configured on this server.');
    const b = await jsonBody(req);
    const paise = parseAmountToPaise(b.amount);
    if (paise === null) throw new HttpError(400, 'Enter a valid amount with up to two decimal places.');
    if (paise < cfg.minInr * 100) throw new HttpError(400, `The minimum donation is ₹${cfg.minInr}.`);
    if (paise > cfg.maxInr * 100) throw new HttpError(400, `The maximum donation is ₹${cfg.maxInr.toLocaleString("en-IN")} per payment.`);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
    if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Enter your full name.');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (phone && !/^\+?[0-9][0-9\s-]{7,14}$/.test(phone)) throw new HttpError(400, 'Enter a valid mobile number or leave it blank.');
    const key = typeof b.idempotencyKey === 'string' ? b.idempotencyKey : '';
    if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) throw new HttpError(400, 'Missing or invalid idempotency key.');

    return withLock('key:' + key, async () => {
      const existing = store.byKey(key);
      if (existing) {
        if (existing.amountPaise !== paise || existing.donor.email !== email) throw new HttpError(409, 'This checkout attempt was already created with different details. Please start again.');
        if (existing.status === 'paid') throw new HttpError(409, 'This donation has already been paid.');
        return { donationId: existing.id, orderId: existing.orderId, keyId: cfg.keyId, amountPaise: existing.amountPaise, currency: 'INR' };
      }
      const id = crypto.randomUUID();
      const order = await razorpay('POST', '/orders', {
        amount: paise, currency: 'INR', receipt: 'dn_' + id.replace(/-/g, '').slice(0, 32),
        notes: { donation_id: id, purpose: 'donation' }   // no personal data sent in notes
      });
      if (!order || !order.id || order.amount !== paise) throw new HttpError(502, 'Unexpected response from the payment gateway.');
      const now = new Date().toISOString();
      store.data.donations[id] = { id, idempotencyKey: key, orderId: order.id, amountPaise: paise, currency: 'INR', status: 'created', donor: { name, email, phone }, paymentId: null, createdAt: now, updatedAt: now, paidAt: null, failureReason: null };
      await store.save();
      return { donationId: id, orderId: order.id, keyId: cfg.keyId, amountPaise: paise, currency: 'INR' };
    });
  }

  function markPaid(d, paymentId) {
    if (d.status === 'paid') return false;
    d.status = 'paid'; d.paymentId = paymentId; d.paidAt = d.updatedAt = new Date().toISOString(); d.failureReason = null;
    return true;
  }

  /* ---- POST /api/donations/card/verify ---- */
  async function verifyPayment(req) {
    if (!cardEnabled) throw new HttpError(503, 'Card payments are not configured on this server.');
    const b = await jsonBody(req);
    const idRe = /^[A-Za-z0-9_]{6,64}$/;
    if (typeof b.donationId !== 'string' || !/^[0-9a-f-]{36}$/.test(b.donationId) || !idRe.test(b.razorpay_order_id || '') || !idRe.test(b.razorpay_payment_id || '') || !/^[0-9a-f]{64}$/i.test(b.razorpay_signature || '')) throw new HttpError(400, 'Invalid verification request.');
    return withLock(b.donationId, async () => {
      const d = store.get(b.donationId);
      if (!d || d.orderId !== b.razorpay_order_id) throw new HttpError(404, 'Donation not found.');
      if (d.status === 'paid') {
        if (d.paymentId === b.razorpay_payment_id) return { verified: true, amount: paiseToString(d.amountPaise), paymentId: d.paymentId };
        throw new HttpError(409, 'This donation is already settled with a different payment.');
      }
      // 1. Cryptographic check of the checkout response.
      const expected = hmacHex(cfg.keySecret, `${b.razorpay_order_id}|${b.razorpay_payment_id}`);
      if (!safeEqualHex(expected, b.razorpay_signature)) { console.warn(`signature mismatch for donation ${d.id}`); throw new HttpError(400, 'Payment signature could not be verified.'); }
      // 2. Confirm with the gateway: right order, right amount, captured.
      const p = await razorpay('GET', '/payments/' + encodeURIComponent(b.razorpay_payment_id));
      if (!p || p.order_id !== d.orderId || p.amount !== d.amountPaise || p.currency !== 'INR') { console.warn(`payment/order mismatch for donation ${d.id}`); throw new HttpError(400, 'Payment details do not match this donation.'); }
      if (p.status === 'captured') { markPaid(d, p.id); await store.save(); return { verified: true, amount: paiseToString(d.amountPaise), paymentId: d.paymentId }; }
      if (p.status === 'failed') { d.status = 'failed'; d.failureReason = (p.error_description || 'failed').slice(0, 200); d.updatedAt = new Date().toISOString(); await store.save(); return { verified: false, status: 'failed', message: 'The gateway reports this payment failed. You can try again.' }; }
      return { verified: false, status: p.status, message: 'The gateway has not captured this payment yet. Please check again shortly and do not pay twice.' };
    });
  }

  /* ---- POST /api/webhooks/razorpay ---- */
  async function webhook(req) {
    if (!cfg.webhookSecret) throw new HttpError(503, 'Webhook secret is not configured.');
    const raw = await readBody(req, 256 * 1024);
    if (!safeEqualHex(hmacHex(cfg.webhookSecret, raw), req.headers['x-razorpay-signature'] || '')) throw new HttpError(400, 'Invalid signature.');
    const eventId = String(req.headers['x-razorpay-event-id'] || '');
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { throw new HttpError(400, 'Invalid JSON.'); }
    if (eventId && store.data.events[eventId]) return { ok: true, duplicate: true };
    const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
    const ord = evt.payload && evt.payload.order && evt.payload.order.entity;
    const orderId = (pay && pay.order_id) || (ord && ord.id);
    const d = orderId && store.byOrder(orderId);
    let result = { ok: true, ignored: true };
    if (d) {
      await withLock(d.id, async () => {
        const amountOk = pay ? pay.amount === d.amountPaise : (ord ? ord.amount === d.amountPaise : false);
        if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && amountOk && pay && pay.status === 'captured') markPaid(d, pay.id);
        else if (evt.event === 'payment.failed' && d.status !== 'paid') { d.status = 'failed'; d.failureReason = String((pay && pay.error_description) || 'failed').slice(0, 200); d.updatedAt = new Date().toISOString(); }
        if (eventId) { store.data.events[eventId] = Date.now(); const ks = Object.keys(store.data.events); if (ks.length > 5000) ks.sort((a, b) => store.data.events[a] - store.data.events[b]).slice(0, ks.length - 5000).forEach(k => delete store.data.events[k]); }
        await store.save();
      });
      result = { ok: true };
    } else if (eventId) { store.data.events[eventId] = Date.now(); await store.save(); }
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // CORS: only if ALLOWED_ORIGIN is set (needed when the static site and this API live on different origins).
      const cors = {};
      if (cfg.allowedOrigin && req.headers.origin === cfg.allowedOrigin) Object.assign(cors, { 'Access-Control-Allow-Origin': cfg.allowedOrigin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        return send(res, 200, { cardEnabled, keyId: cardEnabled ? cfg.keyId : '', minAmount: cfg.minInr, maxAmount: cfg.maxInr, upiVerification: false }, cors);
      }
      if (req.method === 'POST' && url.pathname === '/api/donations/card/order') { rateLimit(req); return send(res, 200, await createOrder(req), cors); }
      if (req.method === 'POST' && url.pathname === '/api/donations/card/verify') { rateLimit(req); return send(res, 200, await verifyPayment(req), cors); }
      if (req.method === 'POST' && url.pathname === '/api/webhooks/razorpay') return send(res, 200, await webhook(req));
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && cfg.siteFile && fs.existsSync(cfg.siteFile)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return fs.createReadStream(cfg.siteFile).pipe(res);
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('unhandled error:', e && e.message);
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong on the server.' });
    }
  });
  server.store = store;
  return server;
}

module.exports = { createApp, configFromEnv, parseAmountToPaise, paiseToString };

if (require.main === module) {
  loadDotEnv(path.join(__dirname, '.env'));
  const cfg = configFromEnv();
  createApp(cfg).listen(cfg.port, () => {
    console.log(`AquaNexus donation server on http://localhost:${cfg.port}`);
    console.log(cfg.keyId && cfg.keySecret ? 'Card payments: ENABLED (Razorpay keys found)' : 'Card payments: DISABLED (set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env)');
    if (!cfg.webhookSecret) console.log('Webhook: DISABLED (set RAZORPAY_WEBHOOK_SECRET to record payments even if the donor closes the tab)');
  });
}
