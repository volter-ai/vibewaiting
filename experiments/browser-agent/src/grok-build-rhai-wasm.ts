// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import initialize, {
  evaluate_json,
  initSync,
  type InitInput,
  type SyncInitInput,
} from "./generated-rhai-wasm/grok_workflow_rhai_wasm.js";
import type {
  GrokBuildRhaiContinuationModule,
  GrokBuildRhaiStep,
} from "./grok-build-workflow-engine.js";

let initialization: Promise<unknown> | undefined;

function evaluator(): GrokBuildRhaiContinuationModule {
  return {
    evaluate(input): GrokBuildRhaiStep {
      const result: unknown = JSON.parse(evaluate_json(JSON.stringify(input)));
      if (!result || typeof result !== "object" || !("type" in result)) {
        return { type: "failed", error: "Rhai WASM returned an invalid continuation result" };
      }
      return result as GrokBuildRhaiStep;
    },
  };
}

/** Lazily loads the checked-in browser WASM through Vite's asset pipeline. */
export async function loadGrokBuildRhaiWasm(
  moduleOrPath?: InitInput | Promise<InitInput>,
): Promise<GrokBuildRhaiContinuationModule> {
  initialization ??= initialize(moduleOrPath);
  await initialization;
  return evaluator();
}

/** Synchronous initializer used by deterministic Node/Vitest corpus tests. */
export function loadGrokBuildRhaiWasmSync(module: SyncInitInput): GrokBuildRhaiContinuationModule {
  initSync({ module });
  return evaluator();
}
