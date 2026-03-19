import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeBash, validateBashCommand } from "../../tools/bash";

const projectDirsToCleanup: string[] = [];

async function createProjectDir(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "conductor-b2-"));
  projectDirsToCleanup.push(projectDir);
  return projectDir;
}

afterEach(async () => {
  await Promise.all(
    projectDirsToCleanup.splice(0).map(async (projectDir) => {
      await rm(projectDir, { recursive: true, force: true });
    }),
  );
});

describe("bash tool B2", () => {
  it("executes a valid command inside the project directory", async () => {
    const projectDir = await createProjectDir();

    const result = await executeBash("echo hello", projectDir);

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("rejects sudo commands", () => {
    expect(validateBashCommand("sudo apt install foo", "/proj")).toEqual({
      valid: false,
      reason: "sudo is prohibited",
    });
  });

  it("rejects git push commands", () => {
    const result = validateBashCommand("git push origin main", "/proj");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("git push");
  });

  it("rejects interactive commands", () => {
    const result = validateBashCommand("ssh user@host", "/proj");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("interactive");
  });

  it("rejects commands that access paths outside the project directory", () => {
    const result = validateBashCommand("cd /etc && cat passwd", "/proj");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("outside project");
  });

  it("rejects relative path traversal operands", () => {
    const result = validateBashCommand("cat ../secret", "/proj");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("outside project");
  });

  it("rejects mixed in-project and escaping path operands", () => {
    const result = validateBashCommand("cp ./a ../b", "/proj");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("outside project");
  });

  it("rejects commands that traverse through symlinked paths escaping the project", async () => {
    const projectDir = await createProjectDir();
    const externalDir = await mkdtemp(path.join(os.tmpdir(), "conductor-b2-external-"));
    projectDirsToCleanup.push(externalDir);
    await writeFile(path.join(externalDir, "secret.txt"), "secret", "utf8");
    await symlink(externalDir, path.join(projectDir, "linked"));

    const result = validateBashCommand("cat linked/secret.txt", projectDir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("outside project");
  });

  it("rejects command substitution to keep validation aligned with execution", () => {
    const result = validateBashCommand("echo $(pwd)", "/proj");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("shell metacharacters");
  });

  it("rejects shell control operators such as pipes and redirections", () => {
    expect(validateBashCommand("printf hello | cat", "/proj")).toEqual({
      valid: false,
      reason: "shell metacharacters and expansions are prohibited",
    });

    expect(validateBashCommand("echo hello > out.txt", "/proj")).toEqual({
      valid: false,
      reason: "shell metacharacters and expansions are prohibited",
    });
  });

  it("fails when the command exceeds the timeout", async () => {
    const projectDir = await createProjectDir();

    const result = await executeBash("sleep 60", projectDir, 100);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });

  it("captures the exit code in output for failed commands", async () => {
    const projectDir = await createProjectDir();

    const result = await executeBash("exit 1", projectDir);

    expect(result.success).toBe(false);
    expect(result.output).toContain("exit code: 1");
  });
});