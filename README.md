# Mock Trading

An ptions mock trading trainer. A five-strike options board starts sparse; an
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

## Play on iPhone

**Same Wi-Fi (instant):** run `npm run lan` on the Mac, then open
`http://<mac-ip>:4173` in Safari on the phone (the command prints the address).
Playable immediately; no offline support (service workers need HTTPS), and some
managed networks block device-to-device traffic.

**Hosted (permanent):** push this repo to GitHub — `.github/workflows/deploy.yml`
builds, tests, and deploys to GitHub Pages on every push to `main`. One-time setup:

```sh
gh auth login
gh repo create mockTrading --public --source=. --push
```

then in the repo's Settings → Pages set Source to "GitHub Actions" (or run
`gh api -X POST repos/{owner}/mockTrading/pages -f build_type=workflow`).
Open the Pages URL in Safari, Share → Add to Home Screen: standalone app,
works offline.
