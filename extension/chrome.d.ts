interface ExtensionEvent<T> {
  addListener(listener: T): void;
}

interface ExtensionPort {
  name: string;
  sender?: {
    tab?: { id?: number; windowId?: number };
    frameId?: number;
  };
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
    onInstalled: ExtensionEvent<(details: { reason: "install" | "update" | "chrome_update" | "shared_module_update" }) => void>;
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
  commands: {
    onCommand: ExtensionEvent<
      (command: string, tab?: { id?: number; windowId?: number }) => void
    >;
  };
  contextMenus: {
    create(
      options: {
        id: string;
        title: string;
        contexts: Array<"link">;
      },
      callback?: () => void,
    ): string | number;
    update(
      id: string,
      options: { title: string; contexts: Array<"link"> },
      callback?: () => void,
    ): void;
    removeAll(callback?: () => void): void;
    onClicked: ExtensionEvent<
      (
        info: { menuItemId: string | number; linkUrl?: string },
        tab?: { id?: number; windowId?: number },
      ) => void
    >;
  };
  tabs: {
    create(options: { url: string }): Promise<{ id?: number }>;
  };
};
declare module "qrcode-generator" {
  interface QrCode {
    addData(value: string): void;
    make(): void;
    createDataURL(cellSize?: number, margin?: number): string;
  }
  export default function qrcode(typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H"): QrCode;
}
