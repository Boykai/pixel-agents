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
  COPILOT_HOOK_TIMEOUT_SECONDS,
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

function legacyConfig(): { version: number; hooks: Record<string, object[]> } {
  return {
    version: 1,
    hooks: Object.fromEntries(
      [
        'sessionStart',
        'agentStop',
        'userPromptSubmitted',
        'preToolUse',
        'postToolUse',
        'postToolUseFailure',
        'notification',
      ].map((event) => [
        event,
        [
          {
            type: 'command',
            exec: 'node',
            args: ['-e', COPILOT_HOOK_BOOTSTRAP, script, event],
            timeoutSec: COPILOT_HOOK_TIMEOUT_SECONDS,
          },
        ],
      ]),
    ),
  };
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

  it('copies first, installs portable documented shell hooks and is idempotent', async () => {
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
          bash: `node '-e' '${COPILOT_HOOK_BOOTSTRAP}' '${script}' '${event}'`,
          powershell: `& node '-e' '${COPILOT_HOOK_BOOTSTRAP}' '${script}' '${event}'`,
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

  it.each([
    ['bash', 'bash', ['--noprofile', '--norc', '-c']],
    ...(process.platform === 'win32'
      ? [['powershell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command']] as const]
      : []),
  ] as const)(
    'executes %s hooks literally with special characters and preserves stdin',
    async (field, shell, flags) => {
      // npm's node package also contains a non-executable Unix placeholder named "node".
      // Give Git Bash the real executable, not that placeholder or an older host Node.
      const bin = path.join(home, 'command-bin');
      fs.mkdirSync(bin);
      fs.copyFileSync(
        process.execPath,
        path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'),
      );
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
      const specialHome = path.join(home, "space ' $dollar & ; (paren) `tick ! [bracket] café");
      vi.mocked(os.homedir).mockReturnValue(specialHome);
      script = path.join(specialHome, '.pixel-agents', 'hooks', 'copilot-hook.js');
      fs.writeFileSync(
        path.join(packageRoot, 'dist', 'hooks', 'copilot-hook.js'),
        `${COPILOT_HOOK_SCRIPT_BANNER}\nprocess.stdout.write(Buffer.from(JSON.stringify({ argv: process.argv.slice(1), input: require('fs').readFileSync(0, 'utf8') })).toString('base64'));\n`,
      );
      expect(copyHookScript(packageRoot)).toBe(true);
      await installHooks();
      const config = JSON.parse(fs.readFileSync(getHookConfigPath(), 'utf8'));
      for (const event of COPILOT_HOOK_EVENTS) {
        const result = childProcess.execFileSync(shell, [...flags, config.hooks[event][0][field]], {
          input: '{"toolName":"read_file","toolArgs":{"path":"literal"}}',
          encoding: 'utf8',
          env,
          timeout: 10000,
          windowsHide: true,
        });
        expect(JSON.parse(Buffer.from(result.trim(), 'base64').toString('utf8'))).toEqual({
          argv: [script, event],
          input: '{"toolName":"read_file","toolArgs":{"path":"literal"}}',
        });
      }
      for (const broken of [undefined, 'invalid { javascript']) {
        if (broken === undefined) fs.unlinkSync(script);
        else fs.writeFileSync(script, broken);
        expect(
          childProcess.execFileSync(shell, [...flags, config.hooks.sessionStart[0][field]], {
            input: '{}',
            encoding: 'utf8',
            env,
            timeout: 10000,
            windowsHide: true,
          }),
        ).toBe('');
      }
    },
    30000,
  );

  it('migrates only the exact legacy exec/args output and does not report it as installed', async () => {
    copyHookScript(packageRoot);
    seedConfig(JSON.stringify(legacyConfig()));
    expect(areHooksInstalled()).toBe(false);
    await installHooks();
    const config = JSON.parse(fs.readFileSync(getHookConfigPath(), 'utf8'));
    expect(config.hooks.sessionStart[0]).toHaveProperty('bash');
    expect(config.hooks.sessionStart[0]).toHaveProperty('powershell');
    expect(config.hooks.sessionStart[0]).not.toHaveProperty('exec');
    expect(config.hooks.sessionStart[0]).not.toHaveProperty('args');
    expect(areHooksInstalled()).toBe(true);
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual(['pixel-agents.json']);
  });

  it('can uninstall an exactly owned legacy installation', async () => {
    seedConfig(JSON.stringify(legacyConfig()));
    await uninstallHooks();
    expect(fs.existsSync(getHookConfigPath())).toBe(false);
  });

  it.each(['exec', 'args', 'timeout', 'sibling', 'field', 'event'])(
    'refuses modified legacy %s data during migration and removal',
    async (change) => {
      copyHookScript(packageRoot);
      const config = legacyConfig();
      const hook = config.hooks.sessionStart[0] as Record<string, unknown>;
      if (change === 'exec') hook.exec = 'wrapper';
      if (change === 'args')
        hook.args = ['-e', COPILOT_HOOK_BOOTSTRAP, script + '.backup', 'sessionStart'];
      if (change === 'timeout') hook.timeoutSec = 4;
      if (change === 'sibling') config.hooks.sessionStart.push({ exec: 'foreign' });
      if (change === 'field') hook.foreign = true;
      if (change === 'event') delete config.hooks.agentStop;
      const content = JSON.stringify(config);
      seedConfig(content);
      await expect(installHooks()).rejects.toThrow('unowned');
      await expect(uninstallHooks()).rejects.toThrow('unowned');
      expect(fs.readFileSync(getHookConfigPath(), 'utf8')).toBe(content);
    },
  );

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

  it.each(['extra-hook', 'extra-field', 'changed-bash', 'changed-powershell', 'changed-timeout'])(
    'does not claim or remove a modified owned configuration: %s',
    async (change) => {
      copyHookScript(packageRoot);
      await installHooks();
      const config = JSON.parse(fs.readFileSync(getHookConfigPath(), 'utf8'));
      if (change === 'extra-hook') config.hooks.sessionStart.push({ exec: 'foreign' });
      if (change === 'extra-field') config.foreign = true;
      if (change === 'changed-bash') config.hooks.sessionStart[0].bash += ' foreign';
      if (change === 'changed-powershell') config.hooks.sessionStart[0].powershell += ' foreign';
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
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual(['pixel-agents.json']);
  });

  it('leaves the installation intact when quarantine rename fails', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });
    await expect(uninstallHooks()).rejects.toThrow('rename failed');
    expect(areHooksInstalled()).toBe(true);
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual(['pixel-agents.json']);
  });

  it('handles another remover winning the race without leaving a quarantine directory', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, destination) => {
      fs.unlinkSync(source);
      rename(source, destination);
    });
    await uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual([]);
  });

  it.each(['install', 'uninstall'])(
    'restores a foreign file replaced immediately before %s quarantine without deleting it',
    async (operation) => {
      copyHookScript(packageRoot);
      seedConfig(JSON.stringify(legacyConfig()));
      const file = getHookConfigPath();
      const rename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, destination) => {
        fs.unlinkSync(source);
        fs.writeFileSync(source, '{"foreign":"replacement"}');
        rename(source, destination);
      });
      await expect(operation === 'install' ? installHooks() : uninstallHooks()).rejects.toThrow(
        'unowned',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe('{"foreign":"replacement"}');
      expect(fs.readdirSync(path.dirname(file))).toEqual(['pixel-agents.json']);
    },
  );

  it('never unlinks a foreign replacement published after the owned file was quarantined', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    const file = getHookConfigPath();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce((quarantined) => {
      expect(quarantined).not.toBe(file);
      fs.writeFileSync(file, '{"foreign":"replacement"}');
      unlink(quarantined);
    });
    await expect(uninstallHooks()).rejects.toThrow('verification');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"foreign":"replacement"}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['pixel-agents.json']);
  });

  it('preserves both foreign files and reports recovery when restoring would overwrite a racer', async () => {
    copyHookScript(packageRoot);
    await installHooks();
    const file = getHookConfigPath();
    const rename = fs.renameSync;
    let quarantined = '';
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, destination) => {
      fs.unlinkSync(source);
      fs.writeFileSync(source, '{"foreign":"first"}');
      rename(source, destination);
      quarantined = String(destination);
      fs.writeFileSync(source, '{"foreign":"second"}');
    });
    await expect(uninstallHooks()).rejects.toThrow('preserved at');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"foreign":"second"}');
    expect(fs.readFileSync(quarantined, 'utf8')).toBe('{"foreign":"first"}');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(quarantined)).mode & 0o777).toBe(0o700);
    }
  });

  it('does not overwrite a foreign file appearing during migration publish', async () => {
    copyHookScript(packageRoot);
    const original = JSON.stringify(legacyConfig());
    seedConfig(original);
    const file = getHookConfigPath();
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, '{"foreign":"replacement"}');
      link(source, destination);
    });
    await expect(installHooks()).rejects.toThrow('preserved at');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"foreign":"replacement"}');
    const directories = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.endsWith('.quarantine'));
    expect(directories).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(path.dirname(file), directories[0], path.basename(file)), 'utf8'),
    ).toBe(original);
  });

  it('restores the prior owned file when migration publish fails', async () => {
    copyHookScript(packageRoot);
    const original = JSON.stringify(legacyConfig());
    seedConfig(original);
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw new Error('publish failed');
    });
    await expect(installHooks()).rejects.toThrow('publish failed');
    expect(fs.readFileSync(getHookConfigPath(), 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(getHookConfigPath()))).toEqual(['pixel-agents.json']);
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
