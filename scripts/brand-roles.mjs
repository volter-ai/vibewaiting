// Copied from volter-ai/supercode scripts/brand-roles.mjs (commit 9d9c912c); keep the two
// identical below this header. Vibewaiting cannot import from supercode.

// Build-time resolver for the Volter brand's roles, shared by every package
// whose stylesheet is generated from a source (sdk/ui, sdk/terminal,
// sdk/frontend-browser).
//
// A source names a role as `brand(<role>)`. The brand's tokens.json is read
// once per build and each placeholder becomes `var(--volter-<role>, <value>)`:
// a Volter host that loads the brand's tokens.css governs, and a standalone
// embed gets the brand's own values. Colour roles come from `semantic` (light)
// and `semanticDark`, as light-dark(); other roles (`shadow.*`, `font.*`) are
// one value. Nothing is fetched at runtime. A failed fetch or an unknown role
// ends the build with a nonzero exit.
export const BRAND_TOKENS = 'https://brand.volter.ai/tokens.json';

const lookup = (tree, role) => role.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), tree);
const kebab = (role) => role.replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export async function brandResolver(label) {
  let brand;
  try {
    const response = await fetch(BRAND_TOKENS, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    brand = await response.json();
  } catch (error) {
    console.error(`${label}: cannot read ${BRAND_TOKENS}: ${error.message}`);
    process.exit(1);
  }
  const unknown = new Set();
  return {
    // The fetched tokens.json, for builds that need plain values (a generated
    // module of colours, an HTML meta tag) instead of CSS.
    tokens: brand,
    resolve(text) {
      return text.replace(/brand\(([A-Za-z0-9.]+)\)/g, (placeholder, role) => {
        const light = lookup(brand.semantic, role);
        const dark = lookup(brand.semanticDark, role);
        if (typeof light === 'string' && typeof dark === 'string') return `var(--volter-${kebab(role)}, light-dark(${light}, ${dark}))`;
        const single = lookup(brand, role);
        if (typeof single === 'string' && !role.startsWith('semantic')) return `var(--volter-${kebab(role)}, ${single})`;
        unknown.add(role);
        return placeholder;
      });
    },
    // Call after every resolve(): exits nonzero if any role was unknown.
    finish() {
      if (!unknown.size) return;
      console.error(`${label}: unknown brand role(s): ${[...unknown].join(', ')}`);
      process.exit(1);
    },
  };
}
