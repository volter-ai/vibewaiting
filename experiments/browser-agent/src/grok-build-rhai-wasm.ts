// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import initialize, {
  evaluate_json,
  initSync,
  validate_contract_json,
  type InitInput,
  type SyncInitInput,
} from "./generated-rhai-wasm/grok_workflow_rhai_wasm.js";
import type {
  GrokBuildRhaiContinuationModule,
  GrokBuildRhaiStep,
} from "./grok-build-workflow-engine.js";

export type GrokBuildContractVerdict =
  | { status: "valid"; value: unknown }
  | { status: "invalid"; error: string };

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

/** Uses the upstream jsonschema 0.30 engine compiled into the browser WASM. */
export function validateGrokBuildContract(schema: unknown, finalText?: string): GrokBuildContractVerdict {
  const result: unknown = JSON.parse(validate_contract_json(JSON.stringify(schema), finalText));
  if (!result || typeof result !== "object" || !("status" in result)) {
    return { status: "invalid", error: "Rhai WASM returned an invalid output-contract verdict" };
  }
  return result as GrokBuildContractVerdict;
}
