import { describe, expect, it } from 'vitest';

import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';

/** HookProvider.editedFilePaths: the files a tool call edits, for the Architect
 *  Achievement. Each provider knows its own CLI's tool names and input shapes. */

const claude = (toolName: string, input: unknown) =>
  claudeProvider.editedFilePaths!(toolName, input);
const copilot = (toolName: string, input: unknown) =>
  copilotProvider.editedFilePaths!(toolName, input);

describe('Claude editedFilePaths', () => {
  it.each(['Edit', 'MultiEdit', 'Write'])('%s edits its file_path', (toolName) => {
    expect(claude(toolName, { file_path: '/repo/src/app.ts', old_string: 'a' })).toEqual([
      '/repo/src/app.ts',
    ]);
  });

  it('NotebookEdit edits its notebook_path', () => {
    expect(claude('NotebookEdit', { notebook_path: 'C:\\repo\\nb.ipynb', cell_id: 'x' })).toEqual([
      'C:\\repo\\nb.ipynb',
    ]);
  });

  it('keeps a relative path as written (the tracker resolves it)', () => {
    expect(claude('Write', { file_path: 'src/new.ts', content: '' })).toEqual(['src/new.ts']);
  });

  it.each([
    ['Read', { file_path: '/repo/src/app.ts' }],
    ['Bash', { command: 'echo hi > /repo/out.txt' }],
    ['Grep', { pattern: 'x', path: '/repo' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Task', { prompt: 'edit everything' }],
  ])('%s edits nothing', (toolName, input) => {
    expect(claude(toolName, input)).toEqual([]);
  });

  it.each([
    ['no input', undefined],
    ['a string input', '/repo/a.ts'],
    ['an array input', ['/repo/a.ts']],
    ['an empty path', { file_path: '' }],
    ['a non-string path', { file_path: 42 }],
  ])('tolerates %s', (_label, input) => {
    expect(claude('Edit', input)).toEqual([]);
  });

  it("does not read another tool's path field", () => {
    expect(claude('Edit', { notebook_path: '/repo/nb.ipynb' })).toEqual([]);
    expect(claude('NotebookEdit', { file_path: '/repo/a.ts' })).toEqual([]);
  });
});

describe('Copilot editedFilePaths', () => {
  it.each(['edit', 'create', 'write'])('%s edits its path', (toolName) => {
    expect(copilot(toolName, { path: '/repo/src/app.ts', old_str: 'a' })).toEqual([
      '/repo/src/app.ts',
    ]);
  });

  it('falls back to file_path', () => {
    expect(copilot('edit', { file_path: 'C:\\repo\\a.ts' })).toEqual(['C:\\repo\\a.ts']);
  });

  it('str_replace_editor edits its path unless it only views it', () => {
    expect(
      copilot('str_replace_editor', { command: 'str_replace', path: '/repo/a.ts', old_str: 'x' }),
    ).toEqual(['/repo/a.ts']);
    expect(copilot('str_replace_editor', { command: 'create', path: '/repo/b.ts' })).toEqual([
      '/repo/b.ts',
    ]);
    expect(copilot('str_replace_editor', { command: 'view', path: '/repo/a.ts' })).toEqual([]);
  });

  const patch = [
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '@@',
    '-old',
    '+new',
    '*** Add File: /repo/src/new.ts',
    '+export {};',
    '*** Delete File: src/gone.ts',
    '*** Update File: src/old-name.ts',
    '*** Move to: src/new-name.ts',
    '@@',
    '-a',
    '+b',
    '*** Update File: src/app.ts',
    '*** End Patch',
  ].join('\n');

  it('apply_patch edits the files its Update and Add headers name, each once', () => {
    // A deleted file is not an edit; a move is counted by its Update header.
    const expected = ['src/app.ts', '/repo/src/new.ts', 'src/old-name.ts'];
    expect(copilot('apply_patch', patch)).toEqual(expected);
    expect(copilot('apply_patch', { input: patch })).toEqual(expected);
    expect(copilot('apply_patch', { patch })).toEqual(expected);
  });

  it('apply_patch reads CRLF patches', () => {
    expect(copilot('apply_patch', patch.replace(/\n/g, '\r\n'))).toEqual([
      'src/app.ts',
      '/repo/src/new.ts',
      'src/old-name.ts',
    ]);
  });

  it.each([
    ['view', { path: '/repo/a.ts' }],
    ['powershell', { command: 'Set-Content a.ts x' }],
    ['grep', { pattern: 'x', path: '/repo' }],
    ['task', { prompt: 'edit' }],
  ])('%s edits nothing', (toolName, input) => {
    expect(copilot(toolName, input)).toEqual([]);
  });

  it.each([
    ['no input', undefined],
    ['an array input', ['/repo/a.ts']],
    ['an empty path', { path: '' }],
    ['a patch without headers', 'just text'],
  ])('tolerates %s', (_label, input) => {
    expect(copilot('edit', input)).toEqual([]);
    expect(copilot('apply_patch', input)).toEqual([]);
  });
});
