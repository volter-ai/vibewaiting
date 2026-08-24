import { resolve } from "node:path";

export interface DevelopmentBrowserProcess {
  port: number;
  extensions: string[];
}

export function parseDevelopmentBrowserProcesses(
  processList: string,
): DevelopmentBrowserProcess[] {
  const processes: DevelopmentBrowserProcess[] = [];
  for (const commandLine of processList.split("\n")) {
    const port = commandLine.match(/--remote-debugging-port=(\d+)/)?.[1];
    const extensions = commandLine.match(/--load-extension=(\S+)/)?.[1];
    if (!port || !extensions) continue;
    processes.push({
      port: Number(port),
      extensions: extensions
        .split(",")
        .map((directory) => resolve(directory)),
    });
  }
  return processes;
}

export function matchingDevelopmentBrowserPort(
  processes: DevelopmentBrowserProcess[],
  extensionDirectory: string,
): number | null {
  return processes.find((process) =>
    process.extensions.includes(resolve(extensionDirectory)))?.port ?? null;
}
