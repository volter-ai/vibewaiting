interface ExtensionEvent<T> {
  addListener(listener: T): void;
}

interface ExtensionPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ExtensionEvent<(message: unknown) => void>;
  onDisconnect: ExtensionEvent<() => void>;
}

declare const chrome: {
  runtime: {
    id: string;
    lastError?: { message?: string };
    getURL(path: string): string;
    connect(options: { name: string }): ExtensionPort;
    connectNative(name: string): ExtensionPort;
    openOptionsPage(): Promise<void>;
    sendMessage(message: unknown): Promise<unknown>;
    onConnect: ExtensionEvent<(port: ExtensionPort) => void>;
    onMessage: ExtensionEvent<(message: unknown) => void>;
    onInstalled: ExtensionEvent<() => void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
    onClicked: ExtensionEvent<() => void>;
  };
};
