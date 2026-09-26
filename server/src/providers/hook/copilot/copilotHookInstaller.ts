import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  COPILOT_HOOK_BOOTSTRAP,
  COPILOT_HOOK_CONFIG_NAME,
  COPILOT_HOOK_DEADLINE_MS,
  COPILOT_HOOK_DIRECTORY_MODE,
  COPILOT_HOOK_EVENTS,
  COPILOT_HOOK_FILE_MODE,
  COPILOT_HOOK_LEGACY_EVENTS,
  COPILOT_HOOK_NODE_PROBE,
  COPILOT_HOOK_SCRIPT_BANNER,
  COPILOT_HOOK_SCRIPT_NAME,
  COPILOT_HOOK_TIMEOUT_SECONDS,
  COPILOT_HOOK_WRITE_ATTEMPTS,
} from './constants.js';

export function getCopilotHome(): string {
  return path.resolve(process.env['COPILOT_HOME'] || path.join(os.homedir(), '.copilot'));
}

export function getHookConfigPath(): string {
  return path.join(getCopilotHome(), 'hooks', COPILOT_HOOK_CONFIG_NAME);
}

function getScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, COPILOT_HOOK_SCRIPT_NAME);
}

function configuration(legacy = false): object {
  const args = ['-e', COPILOT_HOOK_BOOTSTRAP, getScriptPath()];
  const bashQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  return {
    version: 1,
    hooks: Object.fromEntries(
      (legacy ? COPILOT_HOOK_LEGACY_EVENTS : COPILOT_HOOK_EVENTS).map((event) => [
        event,
        [
          {
            type: 'command',
            // https://docs.github.com/en/copilot/reference/hooks-reference
            // Use the portable shell fields; retain the exact former output for migration only.
            ...(legacy
              ? { exec: 'node', args: [...args, event] }
              : {
                  bash: `node ${[...args, event].map(bashQuote).join(' ')}`,
                  powershell: `& node ${[...args, event].map(powershellQuote).join(' ')}`,
                }),
            timeoutSec: COPILOT_HOOK_TIMEOUT_SECONDS,
          },
        ],
      ]),
    ),
  };
}

function readRegularFile(file: string): string | undefined {
  try {
    if (!fs.lstatSync(path.dirname(file)).isDirectory()) {
      throw new Error('Refusing a non-directory Copilot hook location');
    }
    if (!fs.lstatSync(file).isFile()) {
      throw new Error('Refusing a non-regular Copilot hook file');
    }
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertOwnedConfig(content: string, allowLegacy = true): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Refusing to modify malformed Copilot hooks: pixel-agents.json');
  }
  // A dedicated file needs no backup or merge: every field must be our exact output.
  // A foreign sibling hook or any changed command/argument is NEVER ours to remove.
  if (
    !isDeepStrictEqual(parsed, configuration()) &&
    !(allowLegacy && isDeepStrictEqual(parsed, configuration(true)))
  ) {
    throw new Error('Refusing to modify unowned Copilot hooks: pixel-agents.json');
  }
}

function assertOwnedScript(content: string): void {
  if (!content.startsWith(COPILOT_HOOK_SCRIPT_BANNER + '\n')) {
    throw new Error('Refusing to replace an unowned Copilot hook script');
  }
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error('Refusing a non-directory Copilot hook location');
  }
}

interface QuarantinedFile {
  file: string;
  directory: string;
}

function restoreQuarantinedFile(destination: string, quarantine: QuarantinedFile): void {
  try {
    // link, unlike rename, cannot overwrite a replacement at the original pathname.
    fs.linkSync(quarantine.file, destination);
  } catch (cause) {
    throw new Error(
      `Copilot hook recovery could not restore ${destination}; preserved at ${quarantine.file}. ` +
        'The destination was not overwritten; recover the preserved file manually.',
      { cause },
    );
  }
  fs.unlinkSync(quarantine.file);
  fs.rmdirSync(quarantine.directory);
}

function quarantineOwnedFile(
  file: string,
  assertOwned: (current: string) => void,
): QuarantinedFile | undefined {
  const previous = readRegularFile(file);
  if (previous === undefined) return undefined;
  assertOwned(previous);
  const directory = `${file}.${randomUUID()}.quarantine`;
  fs.mkdirSync(directory, { mode: COPILOT_HOOK_DIRECTORY_MODE });
  const quarantine = { file: path.join(directory, path.basename(file)), directory };
  try {
    fs.renameSync(file, quarantine.file);
  } catch (error) {
    fs.rmdirSync(directory);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    // Validate what rename actually moved, not the stale pre-rename read.
    const moved = readRegularFile(quarantine.file);
    if (moved === undefined) throw new Error('Copilot hook file disappeared during removal');
    assertOwned(moved);
  } catch (error) {
    restoreQuarantinedFile(file, quarantine);
    throw error;
  }
  // This isolates pathname replacements, not writes through an already-open descriptor.
  // No portable filesystem API can lock out uncooperative writers to that inode.
  return quarantine;
}

function discardQuarantinedFile(quarantine: QuarantinedFile): void {
  fs.unlinkSync(quarantine.file);
  fs.rmdirSync(quarantine.directory);
}

/** Same-directory staging; an absent destination is published WITHOUT overwriting a racer. */
function writeVerified(
  file: string,
  content: string,
  assertOwned: (current: string) => void,
): void {
  for (let attempt = 0; attempt < COPILOT_HOOK_WRITE_ATTEMPTS; attempt++) {
    const previous = readRegularFile(file);
    if (previous !== undefined) assertOwned(previous);
    if (previous === content) return;
    ensureDirectory(path.dirname(file));
    const staging = `${file}.${randomUUID()}.staging`;
    try {
      const mode = previous === undefined ? COPILOT_HOOK_FILE_MODE : fs.statSync(file).mode;
      fs.writeFileSync(staging, content, { flag: 'wx', mode });
      if (readRegularFile(file) !== previous) continue;
      if (previous === undefined) {
        try {
          fs.linkSync(staging, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
      } else {
        const quarantine = quarantineOwnedFile(file, assertOwned);
        try {
          fs.linkSync(staging, file);
        } catch (error) {
          if (quarantine) restoreQuarantinedFile(file, quarantine);
          throw error;
        }
        if (quarantine) discardQuarantinedFile(quarantine);
      }
      if (readRegularFile(file) !== content) {
        throw new Error('Copilot hook write verification failed');
      }
      return;
    } finally {
      fs.rmSync(staging, { force: true });
    }
  }
  throw new Error('Copilot hook file changed during installation; retry from Settings');
}

/** Report only a complete owned installation with a present bridge, never the preference. */
export function areHooksInstalled(): boolean {
  try {
    const config = readRegularFile(getHookConfigPath());
    const script = readRegularFile(getScriptPath());
    if (config === undefined || script === undefined) return false;
    assertOwnedConfig(config, false);
    assertOwnedScript(script);
    return true;
  } catch {
    return false;
  }
}

/** Caller must obtain consent and successfully copyHookScript BEFORE installing entries. */
export async function installHooks(): Promise<void> {
  const script = readRegularFile(getScriptPath());
  if (script === undefined) throw new Error('Copy the Copilot hook script before installing hooks');
  assertOwnedScript(script);
  try {
    execFileSync('node', ['-e', COPILOT_HOOK_NODE_PROBE], {
      timeout: COPILOT_HOOK_DEADLINE_MS,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    throw new Error('Copilot hooks require Node.js 18 or later on PATH; no hooks were installed');
  }
  writeVerified(
    getHookConfigPath(),
    JSON.stringify(configuration(), null, 2) + '\n',
    assertOwnedConfig,
  );
}

export async function uninstallHooks(): Promise<void> {
  const file = getHookConfigPath();
  const quarantine = quarantineOwnedFile(file, assertOwnedConfig);
  if (quarantine === undefined) return;
  try {
    fs.unlinkSync(quarantine.file);
  } catch (error) {
    restoreQuarantinedFile(file, quarantine);
    throw error;
  }
  fs.rmdirSync(quarantine.directory);
  if (readRegularFile(file) !== undefined)
    throw new Error('Copilot hook removal verification failed');
  // Keep the shared bridge: another adapter or already-running CLI may still refer to it.
}

/** False means no entries may be installed; this never touches any Copilot settings file. */
export function copyHookScript(packageRoot: string): boolean {
  try {
    const source = readRegularFile(
      path.join(packageRoot, 'dist', 'hooks', COPILOT_HOOK_SCRIPT_NAME),
    );
    if (source === undefined) return false;
    assertOwnedScript(source);
    writeVerified(getScriptPath(), source, assertOwnedScript);
    return true;
  } catch (error) {
    console.error(
      '[Pixel Agents] Unable to copy Copilot hook script; hooks were not installed',
      error,
    );
    return false;
  }
}
export { copyHookScript as copyCopilotHookScript };
