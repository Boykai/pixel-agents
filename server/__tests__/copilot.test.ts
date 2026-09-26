import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import { copilotToolHookPayloads } from './fixtures/copilotHookPayloads.js';

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
    it('does not invent a Claude team registry for Copilot', () => {
      expect(copilotProvider.team).toBeUndefined();
    });
  });

  describe('normalizeHookEvent', () => {
    it('ignores malformed or non-hook payloads', () => {
      expect(copilotProvider.normalizeHookEvent({})).toBeNull();
      expect(
        copilotProvider.normalizeHookEvent({ type: 'tool.execution_start', data: {} }),
      ).toBeNull();
    });
    it('maps interaction completion without ending the session', () => {
      expect(
        copilotProvider.normalizeHookEvent({
          hookType: 'agentStop',
          sessionId: 'session-a',
          stopReason: 'end_turn',
        }),
      ).toEqual({ sessionId: 'session-a', event: { kind: 'turnEnd' } });
      expect(
        copilotProvider.normalizeHookEvent({
          hookType: 'sessionEnd',
          sessionId: 'session-a',
          reason: 'complete',
        }),
      ).toBeNull();
    });
    it('distinguishes an actual permission prompt from permission evaluation', () => {
      expect(
        copilotProvider.normalizeHookEvent({
          hookType: 'permissionRequest',
          sessionId: 'session-a',
        }),
      ).toBeNull();
      expect(
        copilotProvider.normalizeHookEvent({
          hookType: 'notification',
          sessionId: 'session-a',
          notification_type: 'permission_prompt',
        }),
      ).toEqual({ sessionId: 'session-a', event: { kind: 'permissionRequest' } });
      expect(
        copilotProvider.normalizeHookEvent({
          hookType: 'notification',
          sessionId: 'session-a',
          notification_type: 'elicitation_dialog',
        }),
      ).toEqual({ sessionId: 'session-a', event: { kind: 'turnEnd', awaitingInput: true } });
    });
    it.each(copilotToolHookPayloads)(
      'ignores documented $event payloads rather than claiming hook delivery',
      ({ event, input }) => {
        expect(copilotProvider.normalizeHookEvent({ hookType: event, ...input })).toBeNull();
      },
    );
  });

  describe('hooks disclosure', () => {
    it('describes the integration before installation', () => {
      const { headline, disclosure } = copilotProvider.consentDisclosure();
      expect(headline.length).toBeGreaterThan(0);
      expect(disclosure).toContain('Copilot');
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
      expect(copilotProvider.formatToolStatus('rg', {})).toBe('Searching code');
      expect(copilotProvider.formatToolStatus('apply_patch', 'patch text')).toBe('Applying patch');
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
    it('builds an exact-session command that can create a fresh UUID session', () => {
      const cmd = copilotProvider.buildLaunchCommand?.('sess-123', 'C:\\work');
      expect(cmd?.command).toBe('copilot');
      expect(cmd?.args).toEqual(['--session-id', 'sess-123']);
      expect(cmd?.env?.PWD).toBe('C:\\work');
    });
  });

  describe('getSessionDirs', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-copilot-test-'));
      vi.stubEnv('COPILOT_HOME', path.join(tmpRoot, '.copilot'));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
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

    it('predicts a fresh session transcript without reusing an existing session directory', () => {
      makeSessionDir('existing-session', '/my/workspace');
      const expectedFile = path.join(
        tmpRoot,
        '.copilot',
        'session-state',
        'new-session',
        'events.jsonl',
      );
      expect(copilotProvider.expectedTranscriptPath?.('new-session', '/my/workspace')).toBe(
        expectedFile,
      );
      expect(copilotProvider.resolveSessionId?.(expectedFile)).toBe('new-session');
      expect(fs.existsSync(expectedFile)).toBe(false);
      expect(() =>
        copilotProvider.expectedTranscriptPath?.('../escape', '/my/workspace'),
      ).toThrow();
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
    it('matches a quoted workspace path without treating its quotes as path characters', () => {
      makeSessionDir('session-quoted', "'/my/workspace'");
      expect(copilotProvider.getSessionDirs?.('/my/workspace')).toHaveLength(1);
    });

    it('skips session dirs with no workspace.yaml or no cwd line', () => {
      makeSessionDir('session-no-yaml', undefined);
      const dir = path.join(tmpRoot, '.copilot', 'session-state', 'session-no-yaml');
      expect(fs.existsSync(path.join(dir, 'workspace.yaml'))).toBe(false);
      expect(copilotProvider.getSessionDirs?.('/my/workspace')).toEqual([]);
    });
  });

  describe('resolveSessionFolderName / resolveSessionName', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-copilot-yaml-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeWorkspaceYaml(content: string): void {
      fs.writeFileSync(path.join(tmpDir, 'workspace.yaml'), content);
    }

    it('resolveSessionFolderName prefers repository ("owner/repo") over the cwd basename', () => {
      writeWorkspaceYaml('cwd: /home/user/onie\nrepository: Boykai/onie\nbranch: main\n');
      expect(copilotProvider.resolveSessionFolderName?.(tmpDir)).toBe('Boykai/onie');
    });

    it('resolveSessionFolderName falls back to the cwd basename when repository is absent', () => {
      writeWorkspaceYaml('cwd: /home/user/some-project\nclient_name: github/autopilot\n');
      expect(copilotProvider.resolveSessionFolderName?.(tmpDir)).toBe('some-project');
    });

    it('resolveSessionFolderName returns undefined when workspace.yaml is missing', () => {
      expect(copilotProvider.resolveSessionFolderName?.(tmpDir)).toBeUndefined();
    });

    it.each([
      'C:\\Users\\dev\\copilot-worktrees\\pixel-agents\\random-branch',
      '/home/dev/copilot-worktrees/pixel-agents/random-branch/src',
    ])('resolves the project rather than the App worktree name: %s', (cwd) => {
      writeWorkspaceYaml(`cwd: ${cwd}\n`);
      expect(copilotProvider.resolveSessionFolderName?.(tmpDir)).toBe('pixel-agents');
    });

    it('resolveSessionName reads a plain inline name', () => {
      writeWorkspaceYaml('cwd: /home/user/onie\nname: Unraid docker network\nuser_named: true\n');
      expect(copilotProvider.resolveSessionName?.(tmpDir)).toBe('Unraid docker network');
    });

    it('resolveSessionName reads a single-quoted inline name', () => {
      writeWorkspaceYaml("cwd: /home/user/onie\nname: 'Fix: the thing that broke'\n");
      expect(copilotProvider.resolveSessionName?.(tmpDir)).toBe('Fix: the thing that broke');
    });

    it('resolveSessionName reads a block-scalar name (collapsed to its first line)', () => {
      writeWorkspaceYaml(
        'cwd: /home/user/onie\n' +
          'name: |-\n' +
          '  Do deep research to create a planning prompt for setting up Comicarr\n' +
          '  on the Unraid server, including networking considerations.\n' +
          'user_named: false\n',
      );
      expect(copilotProvider.resolveSessionName?.(tmpDir)).toBe(
        'Do deep research to create a planning prompt for setting up \u2026',
      );
    });

    it('resolveSessionName returns undefined when name is absent', () => {
      writeWorkspaceYaml('cwd: /home/user/onie\n');
      expect(copilotProvider.resolveSessionName?.(tmpDir)).toBeUndefined();
    });
  });
});
