# AquaNexus — website files

Everything needed to run and edit the AquaNexus site, in one folder.

## 1. `site/` — the main AquaNexus website

| Path | What it is |
| --- | --- |
| `site/index.html` | The complete website in one self-contained file: HTML, CSS, JavaScript, the map data, the embedded sub-pages (River Recovery Teams, Leaderboard), the language engine (English / हिन्दी / ಕನ್ನಡ), the header logo and the Donate view. Images and the logo are embedded, so it works offline and from a plain folder. |
| `site/server/` | The Donate feature's payment backend (Node.js + Razorpay): creates the order, verifies the payment signature and handles the webhook. Not required for the UPI QR code, which runs fully in the browser. |
| `site/server/.env.example` | The variables the backend reads. Copy to `.env` and add your Razorpay keys. |
| `site/server/test/selftest.js` | Self-test for the backend. |
| `site/tools/brand/` | The header emblem (`aquanexus-mark.png`), its base64 form, and the two scripts that cropped it and injected it into the page. |
| `site/DONATION-README.md` | How the donation/payment configuration works. |

### Run the website

Any static server works — no build step:

```bash
cd site
python -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly by double-clicking also works; a local server is
better because map tiles, the language switcher and the Donate view then behave
exactly as they will online.

### Run the payment backend (card donations)

Requires Node.js 18 or newer.

```bash
cd site/server
cp .env.example .env      # then fill in your Razorpay key id, key secret and webhook secret
npm install
npm start                 # http://localhost:8080
```

Without those keys the site still works: the UPI tab generates its QR code and
the card tab reports that the gateway is not configured. No payment is ever
reported as successful without server-side verification.

## 2. `pollution-report-site/index.html`

A second, separately built AquaNexus variant that focuses on reporting river
pollution (photo upload + location). It is also a single self-contained file and
is included unchanged so both builds are in one place. It does not share the
look or the code of `site/index.html`.

## Notes on the file structure

The main site is intentionally one file: the interactive map, the embedded
sub-pages, the images, the logo, the donation view and the translations are all
inline. That keeps it portable (email it, open it offline, drop it on any host)
and is why there is no CSS/JS folder for it. Editing it means editing
`site/index.html`; the `<style>` blocks sit in the `<head>`, and the page
behaviour is in the `<script>` blocks at the end of the document.

## Credits and safety notes

* The archive's station readings and the River Recovery Teams records are
  simulated demonstration data, as labelled in the pages themselves.
* Donation payments go through Razorpay; card details are entered in the
  gateway's own secure window and never touch this site's code.
* Never commit `site/server/.env` — it holds your secret keys.
