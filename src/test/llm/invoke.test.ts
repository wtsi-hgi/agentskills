import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { invokeWithToolLoop, parseAddendum, parseDoneSignal, parseToolCalls } from "../../llm/invoke";

type MockResponse = {
  text: string;
};

type MockModel = {
  calls: string[][];
  requestCount: number;
  sendRequest: (messages: unknown[], options?: unknown, token?: unknown) => Promise<{ text: AsyncIterable<string> }>;
  countTokens: (value: string | { content?: unknown }) => Promise<number>;
};

function createToken() {
  const listeners: Array<() => void> = [];

  return {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      listeners.push(listener);
      return {
        dispose() {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners.slice()) {
        listener();
      }
    },
  };
}

async function* toAsyncIterable(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createMockModel(
  responses: Array<MockResponse | Error>,
  countTokenMap: Record<string, number> = {},
  onRequest?: (requestCount: number, messages: string[]) => void,
): MockModel {
  const calls: string[][] = [];

  return {
    calls,
    requestCount: 0,
    async sendRequest(messages) {
      const normalizedMessages = (messages as Array<{ content?: unknown }>).map((message) => String(message.content ?? ""));
      calls.push(normalizedMessages);
      this.requestCount += 1;
      onRequest?.(this.requestCount, normalizedMessages);

      const next = responses.shift();
      if (!next) {
        throw new Error("no mock response configured");
      }

      if (next instanceof Error) {
        throw next;
      }

      return {
        text: toAsyncIterable([next.text]),
      };
    },
    async countTokens(value) {
      const normalized = typeof value === "string"
        ? value
        : typeof value.content === "string"
          ? value.content
          : JSON.stringify(value.content ?? "");

      return countTokenMap[normalized] ?? normalized.length;
    },
  };
}

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-c2-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("invokeWithToolLoop", () => {
  it("returns a done PASS result when the model emits no tool calls", async () => {
    const model = createMockModel([{ text: "<done>PASS</done>" }]);
    const token = createToken();

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      "/project",
      { maxTurns: 5, token: token as never },
    );

    expect(result.done).toBe(true);
    expect(result.response).toBe("PASS");
    expect(result.turns).toBe(1);
    expect(result.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
      { role: "assistant", content: "<done>PASS</done>" },
    ]);
  });

  it("parses a single tool call block", () => {
    const calls = parseToolCalls('<tool_call>{"name":"Read","arguments":{"path":"f.ts"}}</tool_call>');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: "Read", arguments: { path: "f.ts" } });
  });

  it("dispatches two tool calls and feeds both results back in one user message", async () => {
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "alpha.ts"), "alpha\n", "utf8");

    const firstResponse = [
      '<tool_call>{"name":"Read","arguments":{"path":"alpha.ts"}}</tool_call>',
      '<tool_call>{"name":"Glob","arguments":{"pattern":"*.ts"}}</tool_call>',
    ].join("\n");
    const model = createMockModel([
      { text: firstResponse },
      { text: "<done>PASS</done>" },
    ]);
    const token = createToken();

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      workspaceDir,
      { maxTurns: 3, token: token as never },
    );

    expect(result.done).toBe(true);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]).toHaveLength(4);
    expect(model.calls[1][3]).toContain("Tool results:");
    expect(model.calls[1][3]).toContain('"tool":"Read"');
    expect(model.calls[1][3]).toContain('"tool":"Glob"');
    expect(model.calls[1][3]).toContain('"output":"alpha\\n"');
    expect(model.calls[1][3]).toContain('"output":"alpha.ts"');
  });

  it("stops with an error when maxTurns is exceeded without a done signal", async () => {
    const model = createMockModel([
      { text: "still working" },
      { text: "still working" },
      { text: "still working" },
    ]);
    const token = createToken();

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      "/project",
      { maxTurns: 3, token: token as never },
    );

    expect(result.done).toBe(false);
    expect(result.turns).toBe(3);
    expect(result.error).toMatch(/max turns/i);
  });

  it("skips malformed JSON tool calls gracefully", () => {
    const calls = parseToolCalls("<tool_call>{not json}</tool_call>");

    expect(calls).toEqual([]);
  });

  it("returns a partial result when the cancellation token is cancelled mid-loop", async () => {
    const token = createToken();
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "alpha.ts"), "alpha\n", "utf8");
    const model = createMockModel(
      [{ text: '<tool_call>{"name":"Read","arguments":{"path":"alpha.ts"}}</tool_call>' }],
      {},
      () => {
        token.cancel();
      },
    );

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      workspaceDir,
      { maxTurns: 3, token: token as never },
    );

    expect(result.done).toBe(false);
    expect(result.error).toMatch(/cancel/i);
    expect(result.turns).toBe(1);
  });

  it("sums token counts across two turns", async () => {
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "alpha.ts"), "alpha\n", "utf8");
    const firstResponse = '<tool_call>{"name":"Read","arguments":{"path":"alpha.ts"}}</tool_call>';
    const model = createMockModel([
      { text: firstResponse },
      { text: "<done>PASS</done>" },
    ]);
    const token = createToken();

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      workspaceDir,
      { maxTurns: 3, token: token as never },
    );

    const expectedInputTokens = model.calls
      .flat()
      .reduce((total, message) => total + message.length, 0);
    const expectedOutputTokens = firstResponse.length + "<done>PASS</done>".length;

    expect(result.totalTokensIn).toBe(expectedInputTokens);
    expect(result.totalTokensOut).toBe(expectedOutputTokens);
  });

  it("extracts addendum text", () => {
    expect(parseAddendum("before<addendum>deviation text</addendum>after")).toBe("deviation text");
  });

  it("returns null when no addendum tag is present", () => {
    expect(parseAddendum("plain response")).toBeNull();
  });

  it("retries once after an LLM API error and then succeeds", async () => {
    const model = createMockModel([
      new Error("temporary failure"),
      { text: "<done>PASS</done>" },
    ]);
    const token = createToken();

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      "/project",
      { maxTurns: 3, token: token as never },
    );

    expect(result.done).toBe(true);
    expect(model.requestCount).toBe(2);
  });

  it("returns an LLM API error after three consecutive request failures", async () => {
    const model = createMockModel([
      new Error("failure one"),
      new Error("failure two"),
      new Error("failure three"),
    ]);
    const token = createToken();

    const result = await invokeWithToolLoop(
      model as never,
      "system prompt",
      "user prompt",
      "/project",
      { maxTurns: 3, token: token as never },
    );

    expect(result.done).toBe(false);
    expect(result.error).toMatch(/llm api error/i);
    expect(model.requestCount).toBe(3);
  });
});

describe("parseDoneSignal", () => {
  it("returns the done result text when a done tag is present", () => {
    expect(parseDoneSignal("prefix<done>PASS</done>suffix")).toEqual({ done: true, result: "PASS" });
  });
});