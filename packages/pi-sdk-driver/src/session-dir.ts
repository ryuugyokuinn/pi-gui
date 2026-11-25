import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Mirrors pi's `ENV_SESSION_DIR` (`<APP_NAME>_CODING_AGENT_SESSION_DIR`), which pi does not export. */
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/** Git Bash / MSYS / Cygwin / WSL drive paths (`/d/foo`) to native Windows form, like pi's `normalizeWindowsShellPath`. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  const drive = match?.[1];
  if (!match || !drive) {
    return filePath;
  }
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Local equivalent of pi's `expandTildePath` (pi does not export it from its package root). */
function expandTildePath(input: string): string {
  let path = input;
  if (process.platform === "win32") {
    path = normalizeWindowsShellPath(path);
  }
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  if (/^file:\/\//.test(path)) {
    return fileURLToPath(path);
  }
  return path;
}

/**
 * Resolve the session directory the way the pi CLI does (minus `--session-dir`):
 * `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting, then `undefined`
 * so every `SessionManager` call falls back to pi's per-cwd default location.
 * Relative values resolve from `cwd`, the workspace, as pi documents.
 */
export function resolveSessionDir(cwd: string, agentDir?: string): string | undefined {
  const fromEnv = process.env[PI_SESSION_DIR_ENV];
  const configured =
    (fromEnv ? expandTildePath(fromEnv) : undefined) ??
    sessionDirFromSettings(cwd, agentDir ?? getAgentDir());
  if (!configured) {
    return undefined;
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

function sessionDirFromSettings(cwd: string, agentDir: string): string | undefined {
  try {
    return SettingsManager.create(cwd, agentDir).getSessionDir() || undefined;
  } catch {
    // A missing or unreadable cwd must not break session listing; use pi's default.
    return undefined;
  }
}
