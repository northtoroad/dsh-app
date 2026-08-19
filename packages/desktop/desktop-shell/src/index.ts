export interface DesktopNotification {
  title: string;
  body?: string;
}

export interface DesktopShell {
  notify(notification: DesktopNotification): Promise<void>;
  revealPath(path: string): Promise<void>;
}

export type DesktopShellProvider = () => DesktopShell;

export const noopDesktopShell: DesktopShell = {
  notify: async () => undefined,
  revealPath: async () => undefined,
};

export function createDesktopShell(provider: DesktopShellProvider | undefined): DesktopShell {
  return provider?.() ?? noopDesktopShell;
}
