import { describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer } from '../src/httpServer.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';

describe('Copilot HTTP ingress', () => {
  it('accepts camelCase hooks only for an enabled provider and authenticated client', async () => {
    const onHookEvent = vi.fn();
    const { app } = await createHttpServer({
      embedded: true,
      token: 'test-token',
      store: new AgentStateStore(),
      activeProviders: [copilotProvider],
      onHookEvent,
    });
    try {
      const payload = { sessionId: 'session-a', hookType: 'agentStop', stopReason: 'end_turn' };
      const response = await app.inject({
        method: 'POST',
        url: '/api/hooks/copilot',
        headers: { authorization: 'Bearer test-token' },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(onHookEvent).toHaveBeenCalledExactlyOnceWith('copilot', payload);

      for (const [provider, authorization, body, status] of [
        ['claude', 'Bearer test-token', payload, 404],
        ['copilot', 'Bearer wrong', payload, 401],
        ['copilot', 'Bearer test-token', {}, 400],
        ['copilot', 'Bearer test-token', { sessionId: [], hookType: 'agentStop' }, 400],
      ] as const) {
        const rejected = await app.inject({
          method: 'POST',
          url: `/api/hooks/${provider}`,
          headers: { authorization },
          payload: body,
        });
        expect(rejected.statusCode).toBe(status);
      }
      expect(onHookEvent).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
