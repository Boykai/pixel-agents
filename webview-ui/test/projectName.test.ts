import { expect, test } from 'vitest';

import { normalizeProjectName } from '../../core/src/normalizeProjectName.js';

test.each([
  ['pixel-agents-hq/pixel-agents', 'pixel-agents'],
  ['  Pixel Agents  ', 'Pixel Agents'],
  ['C:\\repos\\Laughingman\\', 'Laughingman'],
  ['/repos/project.git/', 'project'],
  ['/home/dev/copilot-worktrees/pixel-agents/generated-branch/src', 'pixel-agents'],
  ['C:\\Users\\dev\\copilot-worktrees\\Laughingman\\generated-branch', 'Laughingman'],
  ['', undefined],
  [undefined, undefined],
])('normalizes project identity %s without inventing status or changing case', (value, name) => {
  expect(normalizeProjectName(value)).toBe(name);
});
