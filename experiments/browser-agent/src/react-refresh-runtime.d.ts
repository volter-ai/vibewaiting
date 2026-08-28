declare module "react-refresh/runtime-development" {
  interface ReactRefreshRuntime {
    injectIntoGlobalHook(target: Window): void;
    register(type: unknown, id: string): void;
    createSignatureFunctionForTransform(): (type: unknown) => unknown;
    performReactRefresh(): void;
  }

  const runtime: ReactRefreshRuntime;
  export default runtime;
}
