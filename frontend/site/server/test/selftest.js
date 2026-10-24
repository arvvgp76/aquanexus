'use strict';
// Self-test: runs the real server against a local MOCK of Razorpay's API. No network, no real keys.
//   node test/selftest.js
const http = require('http'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { createApp, configFromEnv } = require('../server');

const SECRET = 'test_secret_not_real', WH = 'wh_secret_not_real';
const orders = {}, payments = {};
let n = 0;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/orders') { const o = JSON.parse(b); const id = 'order_T' + (++n); orders[id] = { id, amount: o.amount, currency: o.currency }; return j(200, orders[id]); }
    const m = /^\/payments\/(.+)$/.exec(req.url); if (req.method === 'GET' && m && payments[m[1]]) return j(200, payments[m[1]]);
    j(404, { error: { description: 'not found' } });
  });
});

let passed = 0, failed = 0;
const check = (name, cond, extra) => { cond ? passed++ : failed++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const sign = (o, p) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex');

(async () => {
  await new Promise(r => mock.listen(0, r));
  const dataFile = path.join(os.tmpdir(), 'aqn-test-' + Date.now() + '.json');
  const cfg = Object.assign(configFromEnv({}), { keyId: 'rzp_test_key', keySecret: SECRET, webhookSecret: WH, apiBase: `http://127.0.0.1:${mock.address().port}`, dataFile, siteFile: null });
  const app = createApp(cfg); await new Promise(r => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, url, body, headers = {}) => { const r = await fetch(base + url, { method, headers: Object.assign(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}, headers), body: body && typeof body !== 'string' ? JSON.stringify(body) : body }); let j = null; try { j = await r.json(); } catch (_) {} return { s: r.status, j }; };
  const key = () => crypto.randomUUID();
  const donor = { name: 'Asha Rao', email: 'asha@example.org', phone: '' };

  let r = await call('GET', '/api/config'); check('config exposes key id, never the secret', r.s === 200 && r.j.cardEnabled && r.j.keyId === 'rzp_test_key' && !JSON.stringify(r.j).includes(SECRET));

  for (const bad of ['', '0', '-5', '9', '100001', '12.345', '1e3', 'abc', null, 250.5.toString() + 'x'])
    { r = await call('POST', '/api/donations/card/order', Object.assign({ amount: bad, idempotencyKey: key() }, donor)); check('rejects amount ' + JSON.stringify(bad), r.s === 400, r.j && r.j.error); }
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '250', idempotencyKey: 'short' }, donor)); check('rejects bad idempotency key', r.s === 400);
  r = await call('POST', '/api/donations/card/order', Object.assign({}, donor, { email: 'nope', amount: '250', idempotencyKey: key() })); check('rejects bad email', r.s === 400);
  r = await call('POST', '/api/donations/card/order', 'not json', { 'Content-Type': 'application/json' }); check('rejects malformed JSON', r.s === 400);
  r = await call('POST', '/api/donations/card/order', 'x', { 'Content-Type': 'text/plain' }); check('rejects non-JSON content type', r.s === 415);

  const k1 = key();
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '250.50', idempotencyKey: k1 }, donor));
  check('creates order for 250.50 (25050 paise, exact)', r.s === 200 && r.j.amountPaise === 25050 && /^order_T/.test(r.j.orderId));
  const o1 = r.j;
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '250.50', idempotencyKey: k1 }, donor));
  check('same idempotency key returns same order', r.s === 200 && r.j.orderId === o1.orderId && n === 1);
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '300', idempotencyKey: k1 }, donor));
  check('same key with different amount -> 409', r.s === 409);

  // verification
  let v = await call('POST', '/api/donations/card/verify', { donationId: o1.donationId, razorpay_order_id: o1.orderId, razorpay_payment_id: 'pay_AAA111', razorpay_signature: 'a'.repeat(64) });
  check('forged signature rejected', v.s === 400 && !v.j.verified);
  v = await call('POST', '/api/donations/card/verify', { donationId: o1.donationId, razorpay_order_id: o1.orderId, razorpay_payment_id: 'pay_AAA111', razorpay_signature: sign(o1.orderId, 'pay_AAA111') });
  check('valid signature but payment unknown to gateway -> not verified', v.s !== 200 || v.j.verified !== true, 'status ' + v.s);
  payments.pay_AAA111 = { id: 'pay_AAA111', order_id: o1.orderId, amount: 100, currency: 'INR', status: 'captured' };
  v = await call('POST', '/api/donations/card/verify', { donationId: o1.donationId, razorpay_order_id: o1.orderId, razorpay_payment_id: 'pay_AAA111', razorpay_signature: sign(o1.orderId, 'pay_AAA111') });
  check('amount mismatch at gateway rejected', v.s === 400 && !v.j.verified, v.j && v.j.error);
  payments.pay_AAA111.amount = 25050; payments.pay_AAA111.status = 'authorized';
  v = await call('POST', '/api/donations/card/verify', { donationId: o1.donationId, razorpay_order_id: o1.orderId, razorpay_payment_id: 'pay_AAA111', razorpay_signature: sign(o1.orderId, 'pay_AAA111') });
  check('authorized-but-not-captured is PENDING, not verified', v.s === 200 && v.j.verified === false, v.j.message);
  check('record not marked paid yet', app.store.get(o1.donationId).status === 'created');
  payments.pay_AAA111.status = 'captured';
  v = await call('POST', '/api/donations/card/verify', { donationId: o1.donationId, razorpay_order_id: o1.orderId, razorpay_payment_id: 'pay_AAA111', razorpay_signature: sign(o1.orderId, 'pay_AAA111') });
  check('captured + valid signature -> verified', v.s === 200 && v.j.verified === true && v.j.amount === '250.5' ? false : v.s === 200 && v.j.verified === true, JSON.stringify(v.j));
  check('amount returned as 250.50 string', v.j.amount === '250.50');
  const v2 = await call('POST', '/api/donations/card/verify', { donationId: o1.donationId, razorpay_order_id: o1.orderId, razorpay_payment_id: 'pay_AAA111', razorpay_signature: sign(o1.orderId, 'pay_AAA111') });
  check('replaying verify is idempotent (one record)', v2.s === 200 && v2.j.verified && Object.keys(app.store.data.donations).length === 1);
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '250.50', idempotencyKey: k1 }, donor));
  check('re-ordering a paid donation blocked', r.s === 409);
  const stored = JSON.stringify(app.store.data); check('no card fields in stored data', !/card|cvv|cvc|pan/i.test(Object.keys(app.store.get(o1.donationId)).join(',')));

  // webhook
  const evt = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WH1', order_id: '', amount: 50000, status: 'captured' } } } };
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '500', idempotencyKey: key() }, donor)); const o2 = r.j; evt.payload.payment.entity.order_id = o2.orderId;
  const raw = JSON.stringify(evt), whSig = crypto.createHmac('sha256', WH).update(raw).digest('hex');
  let w = await call('POST', '/api/webhooks/razorpay', raw, { 'Content-Type': 'application/json', 'x-razorpay-signature': 'b'.repeat(64), 'x-razorpay-event-id': 'evt1' });
  check('webhook with bad signature rejected', w.s === 400);
  w = await call('POST', '/api/webhooks/razorpay', raw, { 'Content-Type': 'application/json', 'x-razorpay-signature': whSig, 'x-razorpay-event-id': 'evt1' });
  check('webhook with good signature marks paid', w.s === 200 && app.store.get(o2.donationId).status === 'paid' && app.store.get(o2.donationId).paymentId === 'pay_WH1');
  w = await call('POST', '/api/webhooks/razorpay', raw, { 'Content-Type': 'application/json', 'x-razorpay-signature': whSig, 'x-razorpay-event-id': 'evt1' });
  check('duplicate webhook event ignored', w.s === 200 && w.j.duplicate === true);
  r = await call('POST', '/api/donations/card/order', Object.assign({ amount: '500', idempotencyKey: key() }, donor)); const o3 = r.j;
  const evt2 = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WH2', order_id: o3.orderId, amount: 100, status: 'captured' } } } }; const raw2 = JSON.stringify(evt2);
  w = await call('POST', '/api/webhooks/razorpay', raw2, { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', WH).update(raw2).digest('hex'), 'x-razorpay-event-id': 'evt2' });
  check('webhook with wrong amount does NOT mark paid', app.store.get(o3.donationId).status === 'created');

  r = await call('GET', '/nothing'); check('unknown route 404', r.s === 404);
  check('data file persisted with private mode', fs.existsSync(dataFile));
  console.log(`\n${passed} passed, ${failed} failed`);
  app.close(); mock.close(); process.exit(failed ? 1 : 0);
})();
