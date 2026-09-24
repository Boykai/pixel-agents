import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

type CopilotAction =
  | { kind: 'append'; record: Record<string, unknown> }
  | { kind: 'hook'; hookType: string; input: Record<string, unknown> };

export class CopilotScenario {
  private readonly actions: CopilotAction[] = [];

  append(
    type: string,
    data: Record<string, unknown> = {},
    envelope: { agentId?: string } = {},
  ): this {
    this.actions.push({ kind: 'append', record: { type, data, ...envelope } });
    return this;
  }

  toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): this {
    return this.append('tool.execution_start', { toolCallId, toolName, arguments: args });
  }

  toolComplete(toolCallId: string): this {
    return this.append('tool.execution_complete', { toolCallId, success: true });
  }

  subagentStart(
    agentId: string,
    data: {
      toolCallId: string;
      agentName: string;
      agentDisplayName: string;
      agentType: string;
      executionMode: 'sync' | 'background';
    },
  ): this {
    return this.append('subagent.started', data, { agentId });
  }

  interactionDone(sessionId: string): this {
    return this.append('hook.start', {
      hookType: 'agentStop',
      input: { sessionId, stopReason: 'end_turn' },
    });
  }

  emitHook(hookType: string, input: Record<string, unknown> = {}): this {
    this.actions.push({ kind: 'hook', hookType, input });
    return this;
  }

  build(): CopilotAction[] {
    return [...this.actions];
  }
}

export function copilotScenario(): CopilotScenario {
  return new CopilotScenario();
}

export interface MockCopilot {
  run(scenario: CopilotScenario): Promise<void>;
  stop(): Promise<void>;
  logs(): string;
}

/** Commands cross stdin; only the child writes transcripts or invokes hooks. */
export async function spawnMockCopilot(options: {
  homeDir: string;
  workspaceDir: string;
  sessionId: string;
}): Promise<MockCopilot> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      path.join(__dirname, '..', 'fixtures', 'mock-copilot-runner.cjs'),
      '--session-id',
      options.sessionId,
    ],
    {
      cwd: options.workspaceDir,
      env: {
        ...process.env,
        HOME: options.homeDir,
        USERPROFILE: options.homeDir,
        COPILOT_HOME: path.join(options.homeDir, '.copilot'),
        PIXEL_AGENTS_MOCK_HOME: options.homeDir,
      },
      stdio: 'pipe',
    },
  );
  let logs = '';
  let sequence = 0;
  let failure: Error | undefined;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const rejectPending = (error: Error): void => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stdin.on('error', rejectPending);
  child.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(new Error(`mock-copilot exited ${code}\n${logs}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    logs += `${line}\n`;
    try {
      const response = JSON.parse(line) as { ready?: boolean; id?: number; error?: string };
      const id = response.ready ? 0 : response.id;
      if (id === undefined) return;
      const request = pending.get(id);
      if (response.error) request?.reject(new Error(response.error));
      else request?.resolve();
      pending.delete(id);
    } catch {
      rejectPending(new Error(`Invalid mock-copilot response: ${line}`));
    }
  });
  function waitForReply(id: number): Promise<void> {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mock-copilot request ${id} timed out\n${logs}`));
      }, 15_000);
      pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  async function stop(): Promise<void> {
    lines.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  }
  try {
    await waitForReply(0);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    run: async (scenario) => {
      const id = ++sequence;
      const reply = waitForReply(id);
      child.stdin.write(`${JSON.stringify({ id, actions: scenario.build() })}\n`);
      await reply;
    },
    stop,
    logs: () => logs,
  };
}
