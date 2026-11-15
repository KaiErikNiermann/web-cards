// On/off settings remembered in the browser. Storage can be blocked (private mode, a sandboxed
// frame): reads then come back unset and writes are dropped, so a setting is simply not
// remembered.

/** The stored setting, or undefined when there is none or storage is blocked. */
export function loadFlag(key: string): boolean | undefined {
  try {
    const value = localStorage.getItem(key);
    return value === null ? undefined : value === "1";
  } catch {
    return undefined;
  }
}

/** Remembers the setting when storage allows it. */
export function saveFlag(key: string, isOn: boolean): void {
  try {
    localStorage.setItem(key, isOn ? "1" : "0");
  } catch {
    // Not remembered; see above.
  }
}
