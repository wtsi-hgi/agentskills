import { afterEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";

import { selectModelForRole } from "../../llm/select";
import type { ModelAssignment } from "../../types";

afterEach(() => {
  globalThis.__conductorVscode = undefined;
});

describe("selectModelForRole", () => {
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