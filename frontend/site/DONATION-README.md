# AquaNexus — Donation feature

## What changed
| File | Purpose |
|---|---|
| `index.html` | Your site with the donation feature added. Everything else in the page is untouched. |
| `server/server.js` | Small Node server (no dependencies): creates Razorpay orders, verifies payments, receives webhooks, stores donation records. |
| `server/.env.example` | Settings template. Copy to `server/.env`. |
| `server/test/selftest.js` | Automated test of the server against a mock gateway (`npm test` inside `server/`). |
| `server/package.json`, `server/.gitignore` | Run scripts; keeps `.env` and donation data out of version control. |

Inside `index.html` the additions are: a **Donate** link in the header nav, a scoped `<style id="aqn-donate-styles">`, a `<section id="donate">` view, a bundled QR encoder (`<script id="aqn-qr">`, MIT, Kazuhiko Arase), the donation logic (`<script id="aqn-donate">`), and one-line additions to the embedded-page router so Donate also works from the River Recovery Teams and Leaderboard pages.

## Preview it
**Just the UPI QR (no setup):** open `index.html` in a browser, click **Donate**. For the "Open UPI App" and Copy buttons to behave exactly as they will live, serve it over http(s), e.g. `python3 -m http.server 8000` in this folder, then visit http://localhost:8000.

**With card checkout:**
1. Install Node 18+.
2. `cd server && cp .env.example .env`, then add your Razorpay **test** key id and secret.
3. `node server.js`, then open http://localhost:8080 (the server also serves `index.html`).
4. Use Razorpay's test card numbers from their docs to try a payment.

## Setting up the gateway securely
1. Create/verify a Razorpay account (live mode needs completed KYC/merchant activation).
2. Put the key id + secret **only** in `server/.env` or your host's secret store. They are never sent to the browser; only the key id is, which Razorpay designs to be public.
3. In Razorpay → Webhooks add `https://YOUR-DOMAIN/api/webhooks/razorpay`, events `payment.captured`, `payment.failed`, `order.paid`, and put the same secret in `RAZORPAY_WEBHOOK_SECRET`.
4. Serve everything over HTTPS. If the site and API are on different hosts, set `ALLOWED_ORIGIN` in `.env` and `apiBase` in the `AQN_DONATE_CONFIG` block near the end of `index.html`.
5. In the Razorpay dashboard confirm card payments are enabled for your account. The page asks the checkout to show cards only; if your Razorpay version ignores that option, hide other methods in the dashboard.
6. Back up `server/data/donations.json` (or swap `Store` in `server.js` for your database). It holds donor name/email, so treat it as personal data.

## What works now vs. what needs your credentials
| Works immediately | Needs gateway/backend |
|---|---|
| Donate nav item and view, amount presets/custom/validation, method tabs | Card order creation, checkout, signature + gateway verification |
| UPI URI + live QR for `8273391827@ybl`, Open UPI App, Copy UPI ID, Download QR | Webhook-based recording of completed donations |
| Honest status messaging ("Payment initiated. Completion has not yet been verified.") | Any claim of a *verified* donation |

Without a running server, the card tab shows a clear notice and the Pay button stays disabled. Nothing is faked.

## UPI verification
A plain `upi://pay` link or QR is a request your donor approves in their own app. Nothing is sent back to the website, so **it cannot be verified from the browser or from this server.** The page says so and never shows "successful" for UPI. To get verified UPI donations, use a UPI-capable gateway flow (for example Razorpay Checkout with UPI enabled, or their UPI QR/Smart Collect products) and reconcile through the same webhook endpoint, or reconcile your bank statement manually.

Also note the donor's app displays the *registered* name for `8273391827@ybl`; the `pn=AquaNexus` value is only a hint. Ask donors to check the name before paying, and make sure that VPA is one you control.

## Configuration in the page
`window.AQN_DONATE_CONFIG` (just before the donation script in `index.html`): `upiId`, `payeeName`, `minAmount`, `maxAmount`, `apiBase`. When a server is reachable its limits (`MIN_AMOUNT_INR` / `MAX_AMOUNT_INR`) override the page's, so both sides always agree.
