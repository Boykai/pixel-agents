import { type MockCopilot, spawnMockCopilot } from '../helpers/mock-copilot';
import { test as base } from './standalone';

export const test = base.extend<{
  copilot: (sessionId: string) => Promise<MockCopilot>;
}>({
  copilot: async ({ standalone }, use, testInfo) => {
    const processes: MockCopilot[] = [];
    try {
      await use(async (sessionId) => {
        const mock = await spawnMockCopilot({
          homeDir: standalone.tmpHome,
          workspaceDir: standalone.workspaceDir,
          sessionId,
        });
        processes.push(mock);
        return mock;
      });
    } finally {
      for (const [index, mock] of processes.entries()) {
        await mock.stop();
        await testInfo.attach(`mock-copilot-${index}`, {
          body: mock.logs(),
          contentType: 'text/plain',
        });
      }
    }
  },
});

export { expect } from './standalone';
