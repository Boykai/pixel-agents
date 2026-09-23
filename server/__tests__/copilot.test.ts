import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';

describe('copilotProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(copilotProvider.kind).toBe('hook');
    });
    it('has id "copilot"', () => {
      expect(copilotProvider.id).toBe('copilot');
    });
    it('has a displayName', () => {
      expect(copilotProvider.displayName).toBe('GitHub Copilot CLI');
    });
    it('has protocolVersion 1', () => {
      expect(copilotProvider.protocolVersion).toBe(1);
    });
    it('has task/agent in subagentToolNames', () => {
      expect(copilotProvider.subagentToolNames.has('task')).toBe(true);
      expect(copilotProvider.subagentToolNames.has('agent')).toBe(true);
    });
    it('has reading tools view/read/grep/glob/web_fetch', () => {
      for (const tool of ['view', 'read', 'grep', 'glob', 'web_fetch']) {
        expect(copilotProvider.readingTools.has(tool)).toBe(true);
      }
      expect(copilotProvider.readingTools.has('edit')).toBe(false);
    });
    it('has no team extension (single-agent CLI)', () => {
      expect(copilotProvider.team).toBeUndefined();
    });
  });

  describe('normalizeHookEvent', () => {
    it('always returns null (no hooks API exists)', () => {
      expect(copilotProvider.normalizeHookEvent({})).toBeNull();
      expect(
        copilotProvider.normalizeHookEvent({ type: 'tool.execution_start', data: {} }),
      ).toBeNull();
    });
  });

  describe('hooks install (no-op provider)', () => {
    it('areHooksInstalled resolves true (nothing to install, skips consent gate)', async () => {
      await expect(copilotProvider.areHooksInstalled()).resolves.toBe(true);
    });
    it('installHooks resolves without doing anything', async () => {
      await expect(copilotProvider.installHooks('http://x', 'token')).resolves.toBeUndefined();
    });
    it('uninstallHooks resolves without doing anything', async () => {
      await expect(copilotProvider.uninstallHooks()).resolves.toBeUndefined();
    });
    it('consentDisclosure returns non-empty headline + disclosure mentioning the transcript path', () => {
      const { headline, disclosure } = copilotProvider.consentDisclosure();
      expect(headline.length).toBeGreaterThan(0);
      expect(disclosure).toContain('events.jsonl');
    });
  });

  describe('formatToolStatus', () => {
    it('formats view/read as Reading <basename>', () => {
      expect(copilotProvider.formatToolStatus('view', { path: 'C:\\a\\b\\foo.ts' })).toBe(
        'Reading foo.ts',
      );
      expect(copilotProvider.formatToolStatus('read', { file_path: '/a/bar.ts' })).toBe(
        'Reading bar.ts',
      );
    });
    it('formats edit as Editing <basename>', () => {
      expect(copilotProvider.formatToolStatus('edit', { path: '/a/b/baz.ts' })).toBe(
        'Editing baz.ts',
      );
    });
    it('formats create/write as Writing <basename>', () => {
      expect(copilotProvider.formatToolStatus('create', { path: '/a/qux.ts' })).toBe(
        'Writing qux.ts',
      );
      expect(copilotProvider.formatToolStatus('write', { path: '/a/quux.ts' })).toBe(
        'Writing quux.ts',
      );
    });
    it('formats grep/glob/web_fetch generically', () => {
      expect(copilotProvider.formatToolStatus('grep', {})).toBe('Searching code');
      expect(copilotProvider.formatToolStatus('glob', {})).toBe('Searching files');
      expect(copilotProvider.formatToolStatus('web_fetch', {})).toBe('Fetching web content');
    });
    it('formats shell/bash/powershell as Running: <command>', () => {
      expect(copilotProvider.formatToolStatus('powershell', { command: 'npm test' })).toBe(
        'Running: npm test',
      );
      expect(copilotProvider.formatToolStatus('shell', { command: 'ls' })).toBe('Running: ls');
    });
    it('truncates long shell commands', () => {
      const longCmd = 'x'.repeat(100);
      const result = copilotProvider.formatToolStatus('bash', { command: longCmd });
      expect(result.length).toBeLessThan(longCmd.length);
      expect(result.startsWith('Running: ')).toBe(true);
    });
    it('formats task/agent as Subtask: <description>', () => {
      expect(copilotProvider.formatToolStatus('task', { description: 'Explore repo' })).toBe(
        'Subtask: Explore repo',
      );
      expect(copilotProvider.formatToolStatus('agent', {})).toBe('Running subtask');
    });
    it('formats ask_user as waiting for input', () => {
      expect(copilotProvider.formatToolStatus('ask_user', {})).toBe('Waiting for your answer');
    });
    it('falls back to "Using <toolName>" for unknown tools', () => {
      expect(copilotProvider.formatToolStatus('some_future_tool', {})).toBe(
        'Using some_future_tool',
      );
    });
  });

  describe('getAllSessionRoots', () => {
    it('returns the ~/.copilot/session-state root', () => {
      const roots = copilotProvider.getAllSessionRoots?.();
      expect(roots).toHaveLength(1);
      expect(roots?.[0]).toContain('.copilot');
      expect(roots?.[0]).toContain('session-state');
    });
  });

  describe('buildLaunchCommand', () => {
    it('builds a `copilot --resume <sessionId>` command', () => {
      const cmd = copilotProvider.buildLaunchCommand?.('sess-123', 'C:\\work');
      expect(cmd?.command).toBe('copilot');
      expect(cmd?.args).toEqual(['--resume', 'sess-123']);
      expect(cmd?.env?.PWD).toBe('C:\\work');
    });
  });

  describe('getSessionDirs', () => {
    let tmpRoot: string;
    let homedirSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-copilot-test-'));
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    });

    afterEach(() => {
      homedirSpy.mockRestore();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function makeSessionDir(id: string, cwd: string | undefined): void {
      const dir = path.join(tmpRoot, '.copilot', 'session-state', id);
      fs.mkdirSync(dir, { recursive: true });
      if (cwd !== undefined) {
        fs.writeFileSync(
          path.join(dir, 'workspace.yaml'),
          `id: ${id}\ncwd: ${cwd}\nclient_name: github/autopilot\n`,
        );
      }
    }

    it('returns [] when the session-state root does not exist', () => {
      expect(copilotProvider.getSessionDirs?.('/some/workspace')).toEqual([]);
    });

    it('matches a session dir whose workspace.yaml cwd equals the workspace path', () => {
      makeSessionDir('session-a', '/my/workspace');
      makeSessionDir('session-b', '/other/workspace');
      const dirs = copilotProvider.getSessionDirs?.('/my/workspace') ?? [];
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toContain('session-a');
    });

    it('returns multiple matches for the same workspace', () => {
      makeSessionDir('session-a', '/my/workspace');
      makeSessionDir('session-c', '/my/workspace');
      const dirs = copilotProvider.getSessionDirs?.('/my/workspace') ?? [];
      expect(dirs).toHaveLength(2);
    });

    it('skips session dirs with no workspace.yaml or no cwd line', () => {
      makeSessionDir('session-no-yaml', undefined);
      const dir = path.join(tmpRoot, '.copilot', 'session-state', 'session-no-yaml');
      expect(fs.existsSync(path.join(dir, 'workspace.yaml'))).toBe(false);
      expect(copilotProvider.getSessionDirs?.('/my/workspace')).toEqual([]);
    });
  });
});
