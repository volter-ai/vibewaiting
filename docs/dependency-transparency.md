# Dependency transparency

Vibewaiting is MIT-licensed and can be cloned, built, packaged, and modified from this
repository. It deliberately composes smaller projects instead of copying their code.

## Shared Supercode packages

The cross-agent session protocol, normalized messenger model, terminal adapter, remote
access primitives, and reusable UI are consumed as pinned `@volter-ai-dev/supercode-*`
packages. Every shipped package is source-readable JavaScript, carries an MIT or
Apache-2.0 license, and is recorded at its exact version in `THIRD_PARTY_NOTICES.md` and
the release SBOM.

The Supercode upstream repository is private at the time of Vibewaiting's first public
alpha. Consequently:

- anyone can audit and replace the code that Vibewaiting actually bundles;
- anyone can change Vibewaiting's extension, native companion, integration, and product
  behavior in this repository;
- a contributor cannot yet send a public upstream change to the shared Supercode
  implementation or rebuild a modified Supercode package from its canonical history.

This is a contribution-boundary limitation, not a hidden hosted service: released
Vibewaiting runs locally from the files in its archive. Issues that belong in a shared
package should still be filed in Vibewaiting; maintainers will keep the public issue
attributable while coordinating the upstream change.

## Release evidence

`npm run package:release` checks that the packed runtime and third-party notice table
contain the same package names and versions. It then emits the native package, extension
ZIP, CycloneDX SBOM, and `SHA256SUMS`. The tag workflow additionally requires the final
Chrome Web Store ID and publishes public artifact attestations.
