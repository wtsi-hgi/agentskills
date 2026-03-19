import type * as vscode from "vscode";

import type { InvocationResult, ToolCall, TranscriptMessage } from "../types";
import { dispatchTool } from "../tools/dispatch";

const MAX_LLM_ATTEMPTS = 3;
const TOOL_CALL_PATTERN = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const DONE_PATTERN = /<done>([\s\S]*?)<\/done>/;
const ADDENDUM_PATTERN = /<addendum>([\s\S]*?)<\/addendum>/;

type RequestMessage = {
  role: string;
  content: string;
};

function createResult(messages: TranscriptMessage[]): InvocationResult {
  return {
    response: "",
    totalTokensIn: 0,
    totalTokensOut: 0,
    turns: 0,
    done: false,
    messages,
    addendum: null,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function stripTags(text: string): string {
  return text
    .replace(TOOL_CALL_PATTERN, "")
    .replace(DONE_PATTERN, "")
    .replace(ADDENDUM_PATTERN, "")
    .trim();
}

function buildToolResultMessage(toolCalls: ToolCall[], results: Array<{ success: boolean; output: string; error?: string }>): string {
  const lines = ["Tool results:"];

  for (const [index, call] of toolCalls.entries()) {
    lines.push(JSON.stringify({
      tool: call.name,
      arguments: call.arguments,
      success: results[index]?.success ?? false,
      output: results[index]?.output ?? "",
      error: results[index]?.error,
    }));
  }

  return lines.join("\n");
}

async function countMessageTokens(
  model: vscode.LanguageModelChat,
  messages: TranscriptMessage[],
  token: vscode.CancellationToken,
): Promise<number> {
  let total = 0;

  for (const message of messages) {
    total += await model.countTokens(message.content, token);
  }

  return total;
}

async function readResponseText(response: vscode.LanguageModelChatResponse): Promise<string> {
  let text = "";

  for await (const chunk of response.text) {
    text += chunk;
  }

  return text;
}

async function sendRequestWithRetry(
  model: vscode.LanguageModelChat,
  messages: TranscriptMessage[],
  token: vscode.CancellationToken,
): Promise<string> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < MAX_LLM_ATTEMPTS) {
    if (token.isCancellationRequested) {
      throw new Error("Invocation cancelled");
    }

    attempt += 1;

    try {
      const response = await model.sendRequest(messages as unknown as vscode.LanguageModelChatMessage[], undefined, token);
      return await readResponseText(response);
    } catch (error) {
      lastError = error;

      if (attempt >= MAX_LLM_ATTEMPTS) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`LLM API error after ${MAX_LLM_ATTEMPTS} attempts: ${message}`);
      }

      await delay(attempt * 10);
    }
  }

  const fallbackMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`LLM API error after ${MAX_LLM_ATTEMPTS} attempts: ${fallbackMessage}`);
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const match of text.matchAll(TOOL_CALL_PATTERN)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ToolCall>;
      if (
        typeof parsed.name === "string"
        && typeof parsed.arguments === "object"
        && parsed.arguments !== null
      ) {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments as Record<string, unknown>,
        });
      }
    } catch {
      continue;
    }
  }

  return calls;
}

export function parseDoneSignal(text: string): { done: boolean; result?: string } {
  const match = text.match(DONE_PATTERN);
  if (!match) {
    return { done: false };
  }

  return {
    done: true,
    result: match[1]?.trim() ?? "",
  };
}

export function parseAddendum(text: string): string | null {
  const match = text.match(ADDENDUM_PATTERN);
  return match?.[1]?.trim() ?? null;
}

export async function invokeWithToolLoop(
  model: vscode.LanguageModelChat,
  systemPrompt: string,
  userPrompt: string,
  projectDir: string,
  options: {
    maxTurns: number;
    token: vscode.CancellationToken;
  },
): Promise<InvocationResult> {
  const messages: TranscriptMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const result = createResult(messages);

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    if (options.token.isCancellationRequested) {
      result.turns = turn - 1;
      result.error = "Invocation cancelled";
      return result;
    }

    result.totalTokensIn += await countMessageTokens(model, messages, options.token);

    let responseText: string;
    try {
      responseText = await sendRequestWithRetry(model, messages, options.token);
    } catch (error) {
      result.turns = turn - 1;
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }

    result.turns = turn;
    result.totalTokensOut += await model.countTokens(responseText, options.token);
    messages.push({ role: "assistant", content: responseText });

    const doneSignal = parseDoneSignal(responseText);
    const addendum = parseAddendum(responseText);
    if (addendum !== null) {
      result.addendum = addendum;
    }

    if (doneSignal.done) {
      result.done = true;
      result.response = doneSignal.result ?? "";
      return result;
    }

    const toolCalls = parseToolCalls(responseText);
    if (toolCalls.length > 0) {
      const toolResults = await Promise.all(toolCalls.map(async (call) => dispatchTool(call, projectDir)));
      messages.push({
        role: "user",
        content: buildToolResultMessage(toolCalls, toolResults),
      });
    }

    if (options.token.isCancellationRequested) {
      result.response = stripTags(responseText);
      result.error = "Invocation cancelled";
      return result;
    }

    result.response = stripTags(responseText);
  }

  result.error = `Exceeded max turns (${options.maxTurns}) without receiving <done>`;
  return result;
}