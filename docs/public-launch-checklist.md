# Public launch checklist

The repository stays private until a maintainer completes the decisions and sequence
below. “Public” means an anonymous developer can understand, install, audit, remove,
and contribute—not merely that GitHub visibility changed.

## Decisions before the flip

- Confirm the maintainer name, copyright holder, security/conduct email, and Chrome Web
  Store publisher identity.
- Decide whether Supercode source will be public at launch. Vibewaiting can be built
  from its public packages, but contributors cannot independently change or audit its
  shared agent semantics and UI while that repository is private.
- Decide whether the first announcement targets developer alpha users who will load an
  unpacked extension or waits for signed Chrome Web Store distribution.

## Repository gate

- Main CI passes in under one minute; nightly Chromium remains separate.
- Full-history secret scan, `npm audit`, license inventory, and clean-room `npm ci` pass.
- `npm run package:release` produces the native tarball, extension ZIP, CycloneDX SBOM,
  and verified `SHA256SUMS` from a clean tree.
- A clean Node 22 global install can print install and uninstall help and contains the
  same extension manifest as the ZIP.
- README, support matrix, privacy policy, security policy, notices, screenshots, and
  release notes describe the same version and supported surfaces.

## Visibility and first release

1. Change repository visibility to public.
2. Enable secret scanning, push protection, private vulnerability reporting, and the
   public dependency-review surface.
3. Verify anonymous clone, `npm ci`, `npm run check`, issue forms, Discussions, and all
   README links.
4. Push the signed `v0.1.0` tag on the reviewed main commit. Do not tag while private:
   public GitHub/Sigstore provenance is unavailable to non-Enterprise private repos.
5. Verify the release workflow, every checksum, and
   `gh attestation verify <artifact> --repo volter-ai/vibewaiting`.
6. Install that exact release—not a worktree build—in a new browser profile and prove
   website-access grant, deny, revoke, re-grant, native update, and complete uninstall.

## Arrival experience

- Upload a real, sanitized product recording or screenshot as the GitHub social preview;
  do not use private sessions, paths, terminal output, or generated fake UI.
- Confirm the first screen says what the product does before naming Supercode, Widget
  Shell, Lucarne, or tunnel internals.
- Follow [the Chrome Web Store checklist](chrome-web-store.md) for listing disclosures,
  screenshots, support information, and permission review.
- Test the announcement link while logged out and from a phone.

## First 48 hours

- Monitor security mail, Discussions, issues, release downloads, and store-review mail.
- Reproduce setup reports in a clean profile before changing documentation.
- Treat permission confusion, fabricated harness capability, exposed native state, or
  an uninstall residue as release-blocking defects.
