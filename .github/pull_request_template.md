## Problem

What user problem does this solve?

## Change

What changed, and where does the responsibility belong?

## Verification

List the commands and focused manual checks you ran.

## Trust boundary

Describe any effect on browser permissions, page context, native messages, local paths,
terminal handles, remote access, credentials, or persistence. Write “none” when there
is no effect.

## Checklist

- [ ] `npm run check` passes.
- [ ] Public behavior, setup, permissions, and security documentation are updated or
      not affected.
- [ ] Any new test meets the repository's strict inclusion bar.
- [ ] Chromium-dependent validation remains manual or nightly-only.
- [ ] The change contains no generated `dist/` output, local state, credentials, or
      private session data.
