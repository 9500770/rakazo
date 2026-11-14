/**
 * Win32-only path helpers, stubbed for the POSIX agent build. `desktop-sandbox.ts` imports them but
 * never reaches them off Windows, so they only have to exist and fail loudly if they ever run.
 * Swapped in by `build.mjs`; the adapter source stays untouched.
 */
export type Win32FileHandle = never;

const unavailable = () => {
  throw new Error("Windows file handles are not available on this computer");
};

export function win32NtRelativeAvailable(): boolean {
  return false;
}

export function pathFromDirectoryFd(_fd: number): string {
  return unavailable();
}

export function pathFromWindowsHandle(_handle: number | bigint): string {
  return unavailable();
}

export function fileHandleFromFd(_fd: number): never {
  return unavailable();
}

export function openExistingChildViaDirectoryFdWin32(_parentFd: number, _name: string): never {
  return unavailable();
}

export function createExclusiveChildViaDirectoryFdWin32(_parentFd: number, _name: string): never {
  return unavailable();
}

export function mkdirChildViaDirectoryFdWin32(_parentFd: number, _name: string): string | undefined {
  return unavailable();
}

export function openChildDirectoryViaDirectoryFdWin32(_parentFd: number, _name: string): never {
  return unavailable();
}
