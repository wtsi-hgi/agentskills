import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dispatchTool } from "../../tools/dispatch";
import { formatToolsForPrompt, getToolDefinitions } from "../../tools/schema";

const workspacesToCleanup: string[] = [];

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "conductor-b1-"));
}

afterEach(async () => {
  await Promise.all(
    workspacesToCleanup.splice(0).map(async (workspaceDir) => {
      await rm(workspaceDir, { recursive: true, force: true });
    }),
  );
});

describe("tool schema and dispatch B1", () => {
  it("reads an entire file", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "f.ts"), "hello\nworld\n", "utf8");

    const result = await dispatchTool({ name: "Read", arguments: { path: "f.ts" } }, workspaceDir);

    expect(result).toEqual({ success: true, output: "hello\nworld\n" });
  });

  it("reads a specific line range", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "f.ts"), "one\ntwo\nthree\n", "utf8");

    const result = await dispatchTool(
      { name: "Read", arguments: { path: "f.ts", startLine: 2, endLine: 2 } },
      workspaceDir,
    );

    expect(result).toEqual({ success: true, output: "two\n" });
  });

  it("edits the first matching string in a file", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const filePath = path.join(workspaceDir, "f.ts");
    await writeFile(filePath, "aXb", "utf8");

    const result = await dispatchTool(
      { name: "Edit", arguments: { path: "f.ts", oldString: "X", newString: "Y" } },
      workspaceDir,
    );

    expect(result.success).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("aYb");
  });

  it("writes a new file", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const filePath = path.join(workspaceDir, "new.ts");

    const result = await dispatchTool(
      { name: "Write", arguments: { path: "new.ts", content: "hi" } },
      workspaceDir,
    );

    expect(result.success).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("hi");
  });

  it("moves an LLM-written deleted file into .trash preserving its relative path", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const filePath = path.join(workspaceDir, "src", "generated.ts");

    await dispatchTool(
      { name: "Write", arguments: { path: "src/generated.ts", content: "export const value = 1;\n" } },
      workspaceDir,
    );

    const result = await dispatchTool(
      { name: "Delete", arguments: { path: "src/generated.ts" } },
      workspaceDir,
    );

    expect(result).toEqual({ success: true, output: ".trash/src/generated.ts" });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    expect(await readFile(path.join(workspaceDir, ".trash", "src", "generated.ts"), "utf8")).toContain("value = 1");
  });

  it("deletes non-LLM-written files without moving them to .trash", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const filePath = path.join(workspaceDir, "src", "manual.ts");
    await mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await writeFile(filePath, "manual\n", "utf8");

    const result = await dispatchTool(
      { name: "Delete", arguments: { path: "src/manual.ts" } },
      workspaceDir,
    );

    expect(result).toEqual({ success: true, output: "src/manual.ts" });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspaceDir, ".trash", "src", "manual.ts"), "utf8")).rejects.toThrow();
  });

  it("does not move files to .trash when they are emptied but not deleted", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const filePath = path.join(workspaceDir, "src", "empty.ts");
    const initialContent = "export const value = 1;\n";

    await dispatchTool(
      { name: "Write", arguments: { path: "src/empty.ts", content: initialContent } },
      workspaceDir,
    );
    await dispatchTool(
      { name: "Edit", arguments: { path: "src/empty.ts", oldString: initialContent, newString: "" } },
      workspaceDir,
    );

    expect(await readFile(filePath, "utf8")).toBe("");
    await expect(readFile(path.join(workspaceDir, ".trash", "src", "empty.ts"), "utf8")).rejects.toThrow();
  });

  it("does not error when .trash does not exist at run start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "f.ts"), "hello\n", "utf8");
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({ status: "done" }),
      "utf8",
    );

    const result = await dispatchTool({ name: "Read", arguments: { path: "f.ts" } }, workspaceDir);

    expect(result).toEqual({ success: true, output: "hello\n" });
  });

  it("greps matching content with file and line output", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "f.ts"), "TODO: fix\n", "utf8");

    const result = await dispatchTool(
      { name: "Grep", arguments: { pattern: "TODO" } },
      workspaceDir,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("f.ts:1:TODO: fix");
  });

  it("globs matching files", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "a.ts"), "a", "utf8");
    await writeFile(path.join(workspaceDir, "b.ts"), "b", "utf8");

    const result = await dispatchTool(
      { name: "Glob", arguments: { pattern: "*.ts" } },
      workspaceDir,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
  });

  it("rejects glob patterns that traverse above the project root", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);

    const result = await dispatchTool(
      { name: "Glob", arguments: { pattern: "../*" } },
      workspaceDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("outside project");
  });

  it("dispatches Bash commands through the public tool surface", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);

    const result = await dispatchTool(
      { name: "Bash", arguments: { command: "echo hello" } },
      workspaceDir,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("rejects unknown tools", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);

    const result = await dispatchTool({ name: "Unknown", arguments: {} }, workspaceDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown tool");
  });

  it("rejects reads outside the project directory", async () => {
    const result = await dispatchTool(
      { name: "Read", arguments: { path: "../../etc/passwd" } },
      "/proj",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("outside project");
  });

  it("rejects writes through symlinked directories that escape the project", async () => {
    const workspaceDir = await createWorkspace();
    const externalDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir, externalDir);
    await symlink(externalDir, path.join(workspaceDir, "linked"));

    const result = await dispatchTool(
      { name: "Write", arguments: { path: "linked/out.txt", content: "hello" } },
      workspaceDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("outside project");
  });

  it("includes the filename in grep fallback output for single-file searches", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "f.ts"), "TODO: fix\n", "utf8");

    const toolDir = await createWorkspace();
    workspacesToCleanup.push(toolDir);
    const grepPath = execFileSync("which", ["grep"], { encoding: "utf8" }).trim();
    await symlink(grepPath, path.join(toolDir, "grep"));

    const originalPath = process.env.PATH;
    process.env.PATH = toolDir;

    try {
      const result = await dispatchTool(
        { name: "Grep", arguments: { pattern: "TODO", path: "f.ts" } },
        workspaceDir,
      );

      expect(result).toEqual({ success: true, output: "f.ts:1:TODO: fix" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns seven non-empty tool definitions", () => {
    const definitions = getToolDefinitions();

    expect(definitions).toHaveLength(7);
    for (const definition of definitions) {
      expect(definition.name).toBeTruthy();
      expect(definition.description).toBeTruthy();
      expect(Object.keys(definition.parameters)).not.toHaveLength(0);
    }
  });

  it("formats all tool definitions for prompts", () => {
    const definitions = getToolDefinitions();
    const formatted = formatToolsForPrompt(definitions);

    for (const definition of definitions) {
      expect(formatted).toContain(definition.name);
      for (const parameterName of Object.keys(definition.parameters)) {
        expect(formatted).toContain(parameterName);
      }
    }
  });
});
