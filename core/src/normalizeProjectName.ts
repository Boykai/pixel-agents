/** Display a project rather than an owner prefix or an App-generated worktree name. */
export function normalizeProjectName(value: string | undefined): string | undefined {
  const parts = value
    ?.trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!parts?.length) return undefined;
  const worktrees = parts.lastIndexOf('copilot-worktrees');
  const name =
    worktrees >= 0 && parts.length > worktrees + 2 ? parts[worktrees + 1] : parts[parts.length - 1];
  return name.replace(/\.git$/i, '') || undefined;
}
