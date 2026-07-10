// Config files — persists extension settings across sessions.
//
// Precedence (later wins):
//   1. ~/.pi/agent/extensions/tasks-config.json  (legacy global defaults)
//   2. ~/.pi/agent/extensions/pi-tasks.json      (global extension defaults)
//   3. pi-extmgr package settings/filters        (package-manager UI defaults)
//   4. <cwd>/.pi/tasks-config.json               (project override)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type TaskCreationMode = "model" | "manual" | "always";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  taskCreationMode?: TaskCreationMode;  // default: "model"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: "id" | "status" | "recent" | "oldest";  // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
}

const PROJECT_CONFIG_DIR = ".pi";
const PROJECT_CONFIG_FILE = "tasks-config.json";
const GLOBAL_CONFIG_FILE = "pi-tasks.json";
const LEGACY_GLOBAL_CONFIG_FILE = PROJECT_CONFIG_FILE;
const PACKAGE_JSON_FILE = "package.json";
const DEFAULT_PACKAGE_NAME = "@jianbinwei0-blip/pi-tasks";

const EXTMGR_TASK_CREATION_MODE_ENTRYPOINTS: Record<TaskCreationMode, string> = {
  always: "src/extmgr/task-creation-mode-always.ts",
  manual: "src/extmgr/task-creation-mode-manual.ts",
  model: "src/extmgr/task-creation-mode-model.ts",
};

export interface TasksConfigPaths {
  /** Preferred global defaults path under the user extension directory. */
  global: string;
  /** Back-compat global defaults path matching the project config filename. */
  legacyGlobal: string;
  /** Project-local override path. */
  project: string;
}

interface PiPackageSettingsObject {
  source?: unknown;
  extensions?: unknown;
  settings?: unknown;
}

interface PiSettingsFile {
  packages?: unknown;
}

export function getTasksConfigPaths(cwd = process.cwd()): TasksConfigPaths {
  const globalExtensionsDir = join(getAgentDir(), "extensions");
  return {
    global: join(globalExtensionsDir, GLOBAL_CONFIG_FILE),
    legacyGlobal: join(globalExtensionsDir, LEGACY_GLOBAL_CONFIG_FILE),
    project: join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE),
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch { return {}; }
}

function readConfigFile(path: string): TasksConfig {
  return readJsonObject(path) as TasksConfig;
}

function isTaskCreationMode(value: unknown): value is TaskCreationMode {
  return value === "model" || value === "manual" || value === "always";
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesFilterPattern(targetPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern.trim());
  if (!normalizedPattern) return false;
  if (targetPath === normalizedPattern) return true;

  try {
    return matchesGlob(targetPath, normalizedPattern);
  } catch {
    return false;
  }
}

function getPackageFilterState(filters: string[] | undefined, extensionPath: string): "enabled" | "disabled" {
  // Omitted key => all enabled (Pi default).
  if (filters === undefined) return "enabled";

  // Explicit empty array => load none.
  if (filters.length === 0) return "disabled";

  const normalizedTarget = normalizeRelativePath(extensionPath);
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  let markerOverride: "enabled" | "disabled" | undefined;

  for (const rawToken of filters) {
    const token = rawToken.trim();
    if (!token) continue;

    const prefix = token[0];

    if (prefix === "+" || prefix === "-") {
      const markerPath = normalizeRelativePath(token.slice(1));
      if (markerPath === normalizedTarget) {
        markerOverride = prefix === "+" ? "enabled" : "disabled";
      }
      continue;
    }

    if (prefix === "!") {
      const pattern = normalizeRelativePath(token.slice(1));
      if (pattern) excludePatterns.push(pattern);
      continue;
    }

    const include = normalizeRelativePath(token);
    if (include) includePatterns.push(include);
  }

  let enabled = includePatterns.length === 0 || includePatterns.some((p) => matchesFilterPattern(normalizedTarget, p));

  if (enabled && excludePatterns.some((p) => matchesFilterPattern(normalizedTarget, p))) {
    enabled = false;
  }

  if (markerOverride !== undefined) {
    enabled = markerOverride === "enabled";
  }

  return enabled ? "enabled" : "disabled";
}

function tokenMentionsModeEntrypoint(rawToken: string): boolean {
  const token = rawToken.trim();
  if (!token) return false;

  const prefix = token[0];
  const unprefixed = prefix === "+" || prefix === "-" || prefix === "!" ? token.slice(1) : token;
  const pattern = normalizeRelativePath(unprefixed);
  if (!pattern) return false;

  return Object.values(EXTMGR_TASK_CREATION_MODE_ENTRYPOINTS).some((entrypoint) =>
    matchesFilterPattern(entrypoint, pattern)
  );
}

function taskCreationModeFromExtmgrFilters(filters: string[] | undefined): TaskCreationMode | undefined {
  if (!filters?.some(tokenMentionsModeEntrypoint)) return undefined;

  const enabledModes = (Object.keys(EXTMGR_TASK_CREATION_MODE_ENTRYPOINTS) as TaskCreationMode[]).filter(
    (mode) => getPackageFilterState(filters, EXTMGR_TASK_CREATION_MODE_ENTRYPOINTS[mode]) === "enabled",
  );

  // Legacy boolean-entrypoint workaround: if exactly one old mode entry is
  // enabled, honor it. If none or multiple remain enabled, avoid surprising
  // behavior and fall back to model-discretionary mode.
  if (enabledModes.length === 1) return enabledModes[0];
  return "model";
}

function findNearestPackageRoot(startDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, PACKAGE_JSON_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readCurrentPackageName(packageRoot: string | undefined): string {
  if (!packageRoot) return DEFAULT_PACKAGE_NAME;

  const parsed = readJsonObject(join(packageRoot, PACKAGE_JSON_FILE));
  return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : DEFAULT_PACKAGE_NAME;
}

function normalizeSource(source: string): string {
  return source
    .trim()
    .replace(/\s+\((filtered|pinned)\)$/i, "")
    .trim();
}

function parseNpmPackageName(source: string): string | undefined {
  const normalized = normalizeSource(source);
  const spec = normalized.startsWith("npm:") ? normalized.slice("npm:".length).trim() : normalized;
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) return undefined;
  if (/^(?:git|https?|ssh):/i.test(spec) || spec.startsWith("git@")) return undefined;

  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
  return match?.[1];
}

function resolvePathFromBase(input: string, baseDir: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return resolve(process.env.HOME ?? "");
  if (trimmed.startsWith("~/")) return resolve(process.env.HOME ?? "", trimmed.slice(2));
  if (trimmed.startsWith("~")) return resolve(process.env.HOME ?? "", trimmed.slice(1));
  return resolve(baseDir, trimmed);
}

function sourceMatchesCurrentPackage(
  source: string,
  baseDir: string,
  packageRoot: string | undefined,
  packageName: string,
): boolean {
  const parsedNpmName = parseNpmPackageName(source);
  if (parsedNpmName && parsedNpmName === packageName) return true;

  if (!packageRoot) return false;

  const normalized = normalizeSource(source);
  const isLocalPathLike =
    normalized.startsWith(".") ||
    normalized.startsWith("/") ||
    normalized === "~" ||
    normalized.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized.startsWith("\\\\");

  if (!isLocalPathLike) return false;

  return resolvePathFromBase(normalized, baseDir) === resolve(packageRoot);
}

function packageEntryMentionsModeFilters(entry: PiPackageSettingsObject): boolean {
  if (!Array.isArray(entry.extensions)) return false;
  return entry.extensions.some((token) => typeof token === "string" && tokenMentionsModeEntrypoint(token));
}

function taskCreationModeFromExtmgrSettings(settings: unknown): TaskCreationMode | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const mode = (settings as Record<string, unknown>).taskCreationMode;
  return isTaskCreationMode(mode) ? mode : undefined;
}

function extmgrConfigFromPiSettingsFile(
  settingsPath: string,
  baseDir: string,
  packageRoot: string | undefined,
  packageName: string,
): TasksConfig {
  const settings = readJsonObject(settingsPath) as PiSettingsFile;
  if (!Array.isArray(settings.packages)) return {};

  let fallbackEntry: PiPackageSettingsObject | undefined;

  for (const entry of settings.packages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const packageEntry = entry as PiPackageSettingsObject;
    const extensionFilters = Array.isArray(packageEntry.extensions) &&
      packageEntry.extensions.every((token) => typeof token === "string")
      ? packageEntry.extensions as string[]
      : undefined;

    if (packageEntryMentionsModeFilters(packageEntry)) {
      fallbackEntry = packageEntry;
    }

    if (
      typeof packageEntry.source === "string" &&
      sourceMatchesCurrentPackage(packageEntry.source, baseDir, packageRoot, packageName)
    ) {
      const taskCreationMode =
        taskCreationModeFromExtmgrSettings(packageEntry.settings) ??
        taskCreationModeFromExtmgrFilters(extensionFilters);
      return taskCreationMode ? { taskCreationMode } : {};
    }
  }

  // Back-compat for the short-lived boolean-entrypoint workaround: if a package
  // row mentions the old pi-tasks mode entrypoints, accept it as the active
  // package config even when its source is not locally resolvable.
  const taskCreationMode = taskCreationModeFromExtmgrFilters(fallbackEntry?.extensions as string[] | undefined);
  return taskCreationMode ? { taskCreationMode } : {};
}

function loadExtmgrPackageConfig(cwd: string): TasksConfig {
  const packageRoot = findNearestPackageRoot();
  const packageName = readCurrentPackageName(packageRoot);

  return {
    ...extmgrConfigFromPiSettingsFile(join(getAgentDir(), "settings.json"), getAgentDir(), packageRoot, packageName),
    ...extmgrConfigFromPiSettingsFile(join(cwd, PROJECT_CONFIG_DIR, "settings.json"), join(cwd, PROJECT_CONFIG_DIR), packageRoot, packageName),
  };
}

export function loadTasksConfig(cwd = process.cwd()): TasksConfig {
  const paths = getTasksConfigPaths(cwd);
  return {
    ...readConfigFile(paths.legacyGlobal),
    ...readConfigFile(paths.global),
    ...loadExtmgrPackageConfig(cwd),
    ...readConfigFile(paths.project),
  };
}

/** Save project-local task settings. Used by `/tasks` → Settings. */
export function saveTasksConfig(config: TasksConfig, cwd = process.cwd()): void {
  const { project } = getTasksConfigPaths(cwd);
  mkdirSync(dirname(project), { recursive: true });
  writeFileSync(project, JSON.stringify(config, null, 2));
}
