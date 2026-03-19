import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

export async function loadSkill(skillsDir: string, skillName: string): Promise<string> {
  const skillPath = path.join(skillsDir, skillName, "SKILL.md");

  try {
    return await readFile(skillPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`skill not found: ${skillName}`);
    }

    throw error;
  }
}

export async function discoverSkills(skillsDir: string): Promise<string[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          await readFile(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
          return entry.name;
        } catch (error) {
          if (isMissingPathError(error)) {
            return undefined;
          }

          throw error;
        }
      }),
  );

  return skills.filter((skillName): skillName is string => typeof skillName === "string").sort();
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}