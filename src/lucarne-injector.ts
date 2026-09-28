// Delivery through Lucarne: a WidgetHost.attach({ injector }) adapter. Lucarne keeps ownership of
// browser attachment, state envelopes and intent draining; the injected runtime (widget/lucarne-runtime.ts,
// bundled into lucarne-runtime.generated.ts by scripts/build-lucarne-runtime.mjs) owns only the window.
import type { OverlayPlacement, OverlayPresentation, OverlayTheme } from "@volter/widget-shell";
import { LUCARNE_RUNTIME_SOURCE } from "./lucarne-runtime.generated.js";

export interface LucarneInjectorInput {
  readonly ns: string;
  readonly html: string;
}

export interface LucarneDeliveryOptions {
  readonly id?: string;
  readonly title?: string;
  readonly launcherLabel: string;
  readonly launcherIcon?: string;
  readonly launcherHidden?: boolean;
  readonly initiallyOpen?: boolean;
  readonly viewport?: {
    readonly width?: number;
    readonly height?: number;
    readonly gutter?: number;
  };
  readonly placement?: OverlayPlacement;
  readonly presentation?: OverlayPresentation;
  readonly presentations?: Readonly<Record<string, OverlayPresentation>>;
  readonly initialPresentation?: string;
  /** The same shell tokens accepted by `createOverlay`; delivery must not narrow customization. */
  readonly theme?: OverlayTheme;
}

export type LucarneInjector = (input: LucarneInjectorInput) => string;

function revision(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Build a Lucarne `WidgetHost.attach({ injector })` adapter. Lucarne keeps ownership of browser
 * attachment, state envelopes, and intent draining; Widget Shell owns only the injected launcher/window.
 */
export function createLucarneInjector(options: LucarneDeliveryOptions): LucarneInjector {
  if (!options.launcherLabel.trim()) throw new Error("Lucarne launcherLabel is required");
  if (options.presentation && options.presentations) {
    throw new Error("Use either presentation or presentations, not both");
  }
  if (options.initialPresentation && !options.presentations) {
    throw new Error("initialPresentation requires named presentations");
  }

  return ({ ns, html }) => {
    const prefix = `__lw_${ns}`;
    const overlayId = options.id ?? `lucarne-${ns}`;
    const overlay = {
      id: overlayId,
      title: options.title ?? options.launcherLabel,
      launcherLabel: options.launcherLabel,
      ...(options.launcherIcon ? { launcherIcon: options.launcherIcon } : {}),
      launcherHidden: options.launcherHidden ?? false,
      initiallyOpen: options.initiallyOpen ?? false,
      width: options.viewport?.width ?? 390,
      height: options.viewport?.height ?? 667,
      gutter: options.viewport?.gutter ?? 16,
      placement: options.placement ?? "bottom-end",
      ...(options.presentation ? { presentation: options.presentation } : {}),
      ...(options.presentations ? { presentations: options.presentations } : {}),
      ...(options.initialPresentation ? { initialPresentation: options.initialPresentation } : {}),
      ...(options.theme ? { theme: options.theme } : {}),
    };
    const bootstrap = {
      ns,
      html,
      revision: revision(JSON.stringify({ html, overlay })),
      hostId: `${prefix}_host`,
      iframeGlobal: `${prefix}_iframe`,
      guardGlobal: `${prefix}_guard`,
      disposeGlobal: `${prefix}_dispose`,
      chromeKey: prefix,
      intentQueuePrefix: `${prefix}_intent_`,
      overlay,
    };
    return `(function(){window.__widgetShellLucarneBootstrap__=${JSON.stringify(bootstrap)};${LUCARNE_RUNTIME_SOURCE}})()`;
  };
}
