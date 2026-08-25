# Releasing

Releases are tag-driven and do not add work to pull-request CI.

1. Update `package.json`, `extension/manifest.json`, and `CHANGELOG.md` to the same
   semantic version.
2. Run `npm ci`, `npm run check`, and `npm run package:release` from a clean checkout.
3. Install the generated tarball in a clean temporary npm prefix, register its native
   host, and load the generated extension ZIP in an isolated browser profile. Complete
   the website-access grant, deny, revoke, and re-grant proof described in the
   [Chrome Web Store checklist](chrome-web-store.md).
4. Commit and merge the release change.
5. Create and push the signed tag `vX.Y.Z` on the merge commit.

The release workflow verifies that the tag version matches both manifests and that the
tagged commit belongs to `main`, repeats the merge gate, and publishes:

- `vibewaiting-X.Y.Z.tgz`: native companion and CLI package
- `vibewaiting-extension-X.Y.Z.zip`: unpacked Chromium extension
- `vibewaiting-X.Y.Z.sbom.json`: CycloneDX dependency inventory
- `SHA256SUMS`: checksums for every artifact

The CLI tarball pins and bundles its production dependency tree. Build-only packages
stay outside the artifact, and the SBOM omits them, so the reviewed tarball installs the
same runtime tree represented by its SBOM without resolving newer registry packages.

GitHub generates release notes from the merged pull requests. Never publish an artifact
built from an uncommitted tree. Browser-store signing is a separate release lane and is
not implied by the GitHub ZIP. Public releases also receive GitHub/Sigstore build
provenance, verifiable with `gh attestation verify <artifact> --repo volter-ai/vibewaiting`.
The attestation step stays off while the repository is private because GitHub Free and
Team plans expose private attestations only through Enterprise Cloud.
