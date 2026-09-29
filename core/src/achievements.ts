/**
 * Achievement definitions shared by the server (which counts and persists
 * progress) and the webview (which renders the popup and the gallery).
 * Ported from hootbu/pixel-agents' achievementManager (d0843a9): ids, names,
 * descriptions and targets are the fork's. Pure data, no side effects.
 */
export const ACHIEVEMENTS = [
  { id: 'first_agent', name: 'First Agent', description: 'Create your first agent', target: 1 },
  { id: 'team_player', name: 'Team Player', description: '5 agents running at once', target: 5 },
  {
    id: 'token_millionaire',
    name: 'Token Millionaire',
    description: 'Use 1M total tokens',
    target: 1_000_000,
  },
  { id: 'night_owl', name: 'Night Owl', description: 'Use a tool at 3 AM', target: 1 },
  { id: 'bug_squasher', name: 'Bug Squasher', description: '10 error tool results', target: 10 },
  { id: 'architect', name: 'Architect', description: 'Edit 50 unique files', target: 50 },
  { id: 'marathon', name: 'Marathon Runner', description: 'Complete 100 turns', target: 100 },
  {
    id: 'decorator',
    name: 'Interior Decorator',
    description: 'Place 20 furniture items',
    target: 20,
  },
] as const;

export type AchievementId = (typeof ACHIEVEMENTS)[number]['id'];

export type AchievementDefinition = (typeof ACHIEVEMENTS)[number];

export function getAchievement(id: string): AchievementDefinition | undefined {
  return ACHIEVEMENTS.find((achievement) => achievement.id === id);
}
