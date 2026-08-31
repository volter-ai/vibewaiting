# Chrome Web Store artwork

These assets use only deliberate demo data. They contain no maintainer username, home
directory, repository secret, real session text, terminal handle, or customer content.

- `messenger-1280x800.png` mounts the production messenger with the bounded, sanitized
  inventory in `scripts/store-messenger-demo.tsx` on a neutral demo page.
- `terminal-1280x800.png` mounts the production messenger and terminal components using
  `scripts/store-terminal-demo.tsx` and a local, sanitized terminal stream.
- `website-access-1280x800.png` is the clean-profile first-run disclosure.
- `promo-440x280.png` is generated from the adjacent editable SVG source.

After replacing any asset, run `npm run verify:store-assets` and review the candidate at
100% scale before uploading it. Screenshots are release collateral, not browser tests;
they do not run in merge CI.

Rebuild the messenger fixture with `node scripts/build-store-messenger-demo.mjs`, serve
`/tmp/vibewaiting-store-messenger-demo`, and capture its 1280×800 viewport.
