import { afterEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";

import { listAvailableChatModels, selectModelForRole } from "../../llm/select";
import type { ModelAssignment } from "../../types";

afterEach(() => {
  globalThis.__conductorVscode = undefined;
});

describe("selectModelForRole", () => {
  it("discovers available chat models without a selector and deduplicates vendor-family pairs", async () => {
    globalThis.__conductorVscode = {
      lm: {
        async selectChatModels(selector) {
          expect(selector).toBeUndefined();
          return [
            { name: "GPT-5.4", id: "gpt-54-a", vendor: "copilot", family: "gpt-5.4", version: "1", maxInputTokens: 128_000 },
            { name: "o3", id: "o3-a", vendor: "copilot", family: "o3", version: "1", maxInputTokens: 128_000 },
            { name: "GPT-5.4", id: "gpt-54-b", vendor: "copilot", family: "gpt-5.4", version: "2", maxInputTokens: 128_000 },
          ] as unknown as vscode.LanguageModelChat[];
        },
      },
    };

    await expect(listAvailableChatModels()).resolves.toEqual([
      { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
      { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
    ]);
  });

  it("returns the first matching model for the requested role", async () => {
    const assignments: ModelAssignment[] = [
      { role: "implementor", vendor: "copilot", family: "gpt-4o" },
      { role: "reviewer", vendor: "copilot", family: "gpt-4.1" },
    ];

    globalThis.__conductorVscode = {
      lm: {
        async selectChatModels(selector) {
          expect(selector).toEqual({ vendor: "copilot", family: "gpt-4o" });
          return [{ family: "gpt-4o" }, { family: "gpt-4.1" }] as unknown as vscode.LanguageModelChat[];
        },
      },
    };

    const model = await selectModelForRole("implementor", assignments);

    expect(model.family).toBe("gpt-4o");
  });

  it("treats empty vendor and family assignments as automatic model selection", async () => {
    const assignments: ModelAssignment[] = [
      { role: "implementor", vendor: "", family: "" },
    ];

    globalThis.__conductorVscode = {
      lm: {
        async selectChatModels(selector) {
          expect(selector).toBeUndefined();
          return [{ family: "gpt-5.4" }] as unknown as vscode.LanguageModelChat[];
        },
      },
    };

    const model = await selectModelForRole("implementor", assignments);

    expect(model.family).toBe("gpt-5.4");
  });

  it("returns the matching model for pr-reviewer", async () => {
    const assignments: ModelAssignment[] = [
      { role: "pr-reviewer", vendor: "copilot", family: "o3" },
    ];

    globalThis.__conductorVscode = {
      lm: {
        async selectChatModels(selector) {
          expect(selector).toEqual({ vendor: "copilot", family: "o3" });
          return [{ family: "o3" }] as unknown as vscode.LanguageModelChat[];
        },
      },
    };

    const model = await selectModelForRole("pr-reviewer", assignments);

    expect(model.family).toBe("o3");
  });

  it("throws when no matching model is returned", async () => {
    const assignments: ModelAssignment[] = [
      { role: "implementor", vendor: "copilot", family: "gpt-4o" },
    ];

    globalThis.__conductorVscode = {
      lm: {
        async selectChatModels() {
          return [];
        },
      },
    };

    await expect(selectModelForRole("implementor", assignments)).rejects.toThrow(/no model found/i);
  });
});
