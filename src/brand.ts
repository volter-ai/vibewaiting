import { BRAND_DARK, BRAND_FONT, BRAND_LIGHT, BRAND_SHADOW, type BrandRole } from "./brand-colours.generated.js";

export { BRAND_DARK, BRAND_FONT, BRAND_LIGHT, BRAND_SHADOW, type BrandRole };

/**
 * CSS custom properties holding Volter brand roles for `selector`: the light values, and the dark
 * ones under `prefers-color-scheme: dark`. For styles injected where the brand's tokens.css is not
 * loaded (third-party pages, the pairing page); the values were resolved at build.
 */
export function brandProperties(selector: string, properties: Record<string, BrandRole>): string {
  const declarations = (values: Record<BrandRole, string>) =>
    Object.entries(properties).map(([name, role]) => `${name}:${values[role]}`).join(";");
  return `${selector}{${declarations(BRAND_LIGHT)}}@media (prefers-color-scheme:dark){${selector}{${declarations(BRAND_DARK)}}}`;
}
