# Mock Trading

A SIG-style options mock trading trainer. A five-strike options board starts sparse; an
instructor quotes markets in singles and structures (buy-writes, puts & stock, straddles,
strangles, spreads, flies, iron flies, boxes, risk reversals, rolls) and you take, leave,
or make markets. Score is net edge after hedging, marked against hidden theoretical values.

## Conventions

- Parity: `C − P = (S − K) + r/c`, with r/c (cost of carry) constant across strikes.
- Buy-write quoted vs strike: `BW = C − (S − K) = P + r/c`. Puts & stock: `P + (S − K) = C − r/c`.
- Iron fly = straddle − strangle, so `fly + iron fly = strike width`.
- Boxes = strike width. Risk reversals quoted positive with "puts over" / "calls over".
- Roll spreads (needs the two-expiration setting) = carry difference between months.

## Run

```sh
npm install
npm run dev      # dev server
npm test         # engine tests (parity identities, P&L, no-arb)
npm run build    # production build in dist/
```

## Install on iPhone

Deploy `dist/` to any static host (GitHub Pages, Vercel, Netlify), open the URL in
Safari, then Share → Add to Home Screen. It runs standalone and offline (service worker).
