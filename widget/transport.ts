export interface MessengerTransport {
  sendIntent(name: string, payload: unknown): string;
  onPatch(listener: (patch: unknown) => void): () => void;
  onVisibility(listener: (visible: boolean) => void): () => void;
  setLauncher(value: {
    readonly label?: string;
    readonly icon?: string | null;
    readonly hidden?: boolean;
    readonly badge?: string | number | null;
  }): void;
  closeShell(): void;
  destroy(): void;
}
