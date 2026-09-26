// The Volter brand's roles for Vibewaiting's build. The brand's tokens.json is
// read once per build process (scripts/brand-roles.mjs) and nothing is fetched
// at runtime: the extension and the mobile page ship resolved values only.
//
// - brandCss(text): each `brand(<role>)` becomes var(--volter-<role>, light-dark(<light>, <dark>)).
// - brandHtml(text): each `brand-light(<role>)` / `brand-dark(<role>)` becomes that scheme's plain
//   value, for places CSS cannot reach (a theme-color meta tag).
// An unknown role ends the build with a nonzero exit.
import { brandResolver } from "./brand-roles.mjs";

const resolver = await brandResolver("vibewaiting build");
export const tokens = resolver.tokens;

const lookup = (tree, role) => role.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);

export function brandCss(text) {
  const css = resolver.resolve(text);
  resolver.finish();
  return css;
}

export function brandHtml(text) {
  return text.replace(/brand-(light|dark)\(([A-Za-z0-9.]+)\)/g, (placeholder, scheme, role) => {
    const value = lookup(scheme === "light" ? tokens.semantic : tokens.semanticDark, role);
    if (typeof value === "string") return value;
    console.error(`vibewaiting build: unknown brand role: ${role}`);
    process.exit(1);
  });
}
