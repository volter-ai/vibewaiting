# Third-party notices

## Grok Build

The browser Grok experiment translates portions of xAI's Grok Build request,
Responses-stream, and conversation replay behavior into TypeScript.

- Source: https://github.com/xai-org/grok-build
- Reference revision: `9684fa3cdbf2995e30ea8b9b637f1db008f144fc`
- Copyright: 2023-2026 SpaceXAI
- License: Apache-2.0
- License text: `LICENSES/Apache-2.0.txt`

The browser experiment also bundles Mozilla PDF.js (`pdfjs-dist` 6.2.108,
Apache-2.0) for in-browser document rendering and a WebAssembly workflow runtime
built with Rhai 1.25.1 (MIT OR Apache-2.0), wasm-bindgen (MIT OR Apache-2.0),
Serde (MIT OR Apache-2.0), SHA-2 (MIT OR Apache-2.0), and jsonschema 0.30.0
(MIT). Acorn 8.18.0 (MIT) provides browser-side JavaScript syntax checking.
Their exact transitive dependency versions are recorded in `package-lock.json` and
`experiments/browser-agent/rhai-wasm/Cargo.lock`.

The Vibewaiting CLI release bundles the production packages below. Exact versions and
dependency relationships are also recorded in the release CycloneDX SBOM. License
files supplied by each package remain beside that package under `node_modules` in the
CLI tarball.

| Package | Version | License |
| --- | --- | --- |
| `@termfleet/terminal` | 0.1.9 | Apache-2.0 |
| `@volter-ai-dev/supercode-client` | 0.3.41 | MIT OR Apache-2.0 |
| `@volter-ai-dev/supercode-harness-sdk` | 0.3.18 | MIT OR Apache-2.0 |
| `@volter-ai-dev/supercode-remote-access` | 0.2.0 | MIT OR Apache-2.0 |
| `@volter-ai-dev/supercode-terminal` | 0.2.13 | MIT OR Apache-2.0 |
| `@volter-ai-dev/supercode-ui` | 0.1.66 | MIT OR Apache-2.0 |
| `@volter-ai-dev/widget-shell` | 0.4.0 | MIT |
| `@volter/tunnel` | 2.0.5 | Apache-2.0 |
| `@volter/tunnel-core` | 0.1.3 | Apache-2.0 |
| `argparse` | 2.0.1 | Python-2.0 |
| `entities` | 4.5.0 | BSD-2-Clause |
| `linkify-it` | 5.0.2 | MIT |
| `lucarne` | 1.7.5 | MIT |
| `markdown-it` | 14.3.0 | MIT |
| `mdurl` | 2.1.0 | MIT |
| `punycode.js` | 2.3.1 | MIT |
| `qrcode-terminal` | 0.12.0 | Apache-2.0 |
| `uc.micro` | 2.1.0 | MIT |
| `ws` | 8.21.3 | MIT |

The Apache License 2.0 text used by the Apache-licensed packages is included at
`node_modules/@volter/tunnel/LICENSE` and `node_modules/qrcode-terminal/LICENSE` in the
bundle. `argparse` includes its complete Python license history in
`node_modules/argparse/LICENSE`. The remaining packages that supply license files keep
them in their own directories.

The Supercode packages are distributed here under their MIT option:

> MIT License
>
> Copyright (c) 2026 supercode contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the
> Software without restriction, including without limitation the rights to use, copy,
> modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
> and to permit persons to whom the Software is furnished to do so, subject to the
> following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies
> or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
> PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
> OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
