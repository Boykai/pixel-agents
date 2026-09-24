import * as childProcess from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONSENT_DISCLOSURE } from '../src/providers/hook/copilot/consentCopy.js';
import {
  COPILOT_HOOK_BOOTSTRAP,
  COPILOT_HOOK_EVENTS,
  COPILOT_HOOK_SCRIPT_BANNER,
} from '../src/providers/hook/copilot/constants.js';
import {
  areHooksInstalled,
  copyCopilotHookScript,
  copyHookScript,
  getCopilotHome,
  getHookConfigPath,
  installHooks,
  uninstallHooks,
} from '../src/providers/hook/copilot/copilotHookInstaller.js';

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()) }));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
}));

let home: string;
let packageRoot: string;
let script: string;
const bridge = `${COPILOT_HOOK_SCRIPT_BANNER}\nprocess.exit(0);\n`;

beforeEach(() => {
  home = path.resolve(`.copilot-installer-test-${randomUUID()}`);
  packageRoot = path.join(home, 'package');
  script = path.join(home, '.pixel-agents', 'hooks', 'copilot-hook.js');
  fs.mkdirSync(path.join(packageRoot, 'dist', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'hooks', 'copilot-hook.js'), bridge);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('COPILOT_HOME', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function seedConfig(content: string): void {
  fs.mkdirSync(path.dirname(getHookConfigPath()), { recursive: true });
  fs.writeFileSync(getHookConfigPath(), content);
}

describe('Copilot hook installer ownership', () => {
  it('shares an absolute COPILOT_HOME resolver and a provider-qualified copy alias', () => {
    expect(getCopilotHome()).toBe(path.join(home, '.copilot'));
    vi.stubEnv('COPILOT_HOME', path.relative(process.cwd(), path.join(home, 'relative-home')));
    expect(getCopilotHome()).toBe(path.join(home, 'relative-home'));
    expect(getHookConfigPath()).toBe(
      path.join(home, 'relative-home', 'hooks', 'pixel-agents.json'),
    );
    expect(copyCopilotHookScript).toBe(copyHookScript);
  });

  it('copies first, installs only documented exec hooks and is idempotent', async () => {
    expect(areHooksInstalled()).toBe(false);
    await expect(installHooks()).rejects.toThrow('Copy');
    expect(copyHookScript(packageRoot)).toBe(true);
    await installHooks();
    const file = getHookConfigPath();
    const before = fs.statSync(file).mtimeMs;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks)).toEqual([...COPILOT_HOOK_EVENTS]);
    expect(config.hooks.sessionEnd).toBeUndefined();
    expect(config.hooks.permissionRequest).toBeUndefined();
    for (const event of COPILOT_HOOK_EVENTS) {
      expect(config.hooks[event]).toEqual([
        {
          type: 'command',
          exec: 'node',
          args: ['-e', COPILOT_HOOK_BOOTSTRAP, script, event],
          timeoutSec: 3,
        },
      ]);
    }
    expect(areHooksInstalled()).toBe(true);
    await installHooks();
    expect(copyHookScript(packageRoot)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['pixel-agents.json']);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('honors COPILOT_HOME without rewriting settings, repository hooks or other user files', async () => {
    const alternate = path.join(home, 'custom copilot home');
    vi.stubEnv('COPILOT_HOME', alternate);
    expect(getHookConfigPath()).toBe(path.join(alternate, 'hooks', 'pixel-agents.json'));
    fs.mkdirSync(path.join(alternate, 'hooks'), { recursive: true });
    const foreign = path.join(alternate, 'hooks', 'other.json');
    const settings = path.join(alternate, 'settings.json');
    fs.writeFileSync(foreign, 'foreign hook');
    fs.writeFileSync(settings, 'foreign settings');
    expect(copyHookScript(packageRoot)).toBe(true);
    await installHooks();
    await uninstallHooks();
    await uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign hook');
    expect(fs.readFileSync(settings, 'utf8')).toBe('foreign settings');
    expect(fs.readFileSync(script, 'utf8')).toBe(bridge);
    expect(fs.existsSync(path.join(home, '.copilot'))).toBe(false);
  });

  it.each(['{broken', 'null', '[]', '{}', '{"version":1,"hooks":{}}'])(
    'refuses malformed or unowned file %s on both operations',
    async (content) => {
      expect(copyHookScript(packageRoot)).toBe(true);
      seedConfig(content);
      expect(areHooksInstalled()).toBe(false);
      await expect(installHooks()).rejects.toThrow('Refusing');
      await expect(uninstallHooks()).rejects.toThrow('Refusing');
      expect(fs.readFileSync(getHookConfigPath(), 'utf8')).toBe(content);
    },
  );

  it.each(['extra-hook', 'extra-field', 'changed-exec', 'changed-script', 'changed-timeout'])(
    'does not claim or remove a modified owned configuration: %s',
    async (change) => {
      copyHookScript(packageRoot);
      await installHooks();
      const config = JSON.parse(fs.readFileSync(getHookConfigPath(), 'utf8'));
      if (change === 'extra-hook') config.hooks.sessionStart.push({ exec: 'foreign' });
      if (change === 'extra-field') config.foreign = true;
      if (change === 'changed-exec') config.hooks.sessionStart[0].exec = 'wrapper';
      if (change === 'changed-script') config.hooks.sessionStart[0].args[2] += '.backup';
      if (change === 'changed-timeout') config.hooks.sessionStart[0].timeoutSec = 4;
      const content = JSON.stringify(config);
      seedConfig(content);
      expect(areHooksInstalled()).toBe(false);
      await expect(uninstallHooks()).rejects.toThrow('unowned');
      await expect(installHooks()).rejects.toThrow('unowned');
      expect(fs.readFileSync(getHookConfigPath(), 'utf8')).toBe(content);
    },
  );

  it('accepts harmless formatting/key order differences as its own configuration', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    const config = JSON.parse(fs.readFileSync(getHookConfigPath(), 'utf8'));
    seedConfig(JSON.stringify({ hooks: config.hooks, version: config.version }));
    expect(areHooksInstalled()).toBe(true);
    await uninstallHooks();
    expect(fs.existsSync(getHookConfigPath())).toBe(false);
  });

  it('does not report installed when the script is absent or unowned', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    fs.unlinkSync(script);
    expect(areHooksInstalled()).toBe(false);
    fs.writeFileSync(script, 'foreign');
    expect(areHooksInstalled()).toBe(false);
    expect(copyHookScript(packageRoot)).toBe(false);
    expect(fs.readFileSync(script, 'utf8')).toBe('foreign');
    await uninstallHooks();
  });

  it('refuses a directory at the hook file location', async () => {
    copyHookScript(packageRoot);
    fs.mkdirSync(getHookConfigPath(), { recursive: true });
    await expect(installHooks()).rejects.toThrow('non-regular');
    await expect(uninstallHooks()).rejects.toThrow('non-regular');
    expect(areHooksInstalled()).toBe(false);
  });

  it('refuses symlinked hook directories rather than writing through them', async () => {
    copyHookScript(packageRoot);
    const target = path.join(home, 'foreign-hooks');
    fs.mkdirSync(target);
    fs.mkdirSync(path.dirname(path.dirname(getHookConfigPath())), { recursive: true });
    fs.symlinkSync(
      target,
      path.dirname(getHookConfigPath()),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(installHooks()).rejects.toThrow('non-directory');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('preserves a foreign file appearing immediately before exclusive publish', async () => {
    copyHookScript(packageRoot);
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, 'foreign racing writer');
      link(source, destination);
    });
    await expect(installHooks()).rejects.toThrow('malformed');
    expect(fs.readFileSync(getHookConfigPath(), 'utf8')).toBe('foreign racing writer');
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual(['pixel-agents.json']);
  });

  it('throws on publish failure and leaves neither a config nor staging files', async () => {
    copyHookScript(packageRoot);
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    });
    await expect(installHooks()).rejects.toThrow('disk failure');
    expect(areHooksInstalled()).toBe(false);
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual([]);
  });

  it('throws removal errors without pretending hooks are uninstalled', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('cannot remove');
    });
    await expect(uninstallHooks()).rejects.toThrow('cannot remove');
    expect(areHooksInstalled()).toBe(true);
  });

  it('fails copying a missing or unrecognized artifact without creating config', () => {
    expect(copyHookScript(path.join(home, 'absent'))).toBe(false);
    fs.writeFileSync(path.join(packageRoot, 'dist', 'hooks', 'copilot-hook.js'), 'foreign');
    expect(copyHookScript(packageRoot)).toBe(false);
    expect(fs.existsSync(getHookConfigPath())).toBe(false);
  });

  it('refuses installation if Node cannot start rather than breaking preToolUse', async () => {
    copyHookScript(packageRoot);
    vi.spyOn(childProcess, 'execFileSync').mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    await expect(installHooks()).rejects.toThrow('Node.js 18 or later');
    expect(fs.existsSync(getHookConfigPath())).toBe(false);
  });

  it('discloses scope, data, writes, undo, restart and the unverified capability gap', () => {
    for (const fact of [
      '$COPILOT_HOME/hooks/pixel-agents.json',
      '~/.pixel-agents/hooks/copilot-hook.js',
      `${COPILOT_HOOK_EVENTS.length} Copilot CLI events`,
      'tool arguments',
      'not forwarded',
      'Settings',
      'Restart',
      'sessionEnd',
      'Node.js',
      '--host',
    ]) {
      expect(CONSENT_DISCLOSURE).toContain(fact);
    }
  });
});
