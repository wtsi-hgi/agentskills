import type * as vscode from "vscode";

import type { ModelAssignment, Role } from "../types";

type LanguageModelSelector = Pick<ModelAssignment, "vendor" | "family">;

type VscodeLmApi = {
  lm?: {
    selectChatModels(selector: LanguageModelSelector): Promise<vscode.LanguageModelChat[]>;
  };
};

declare global {
  var __conductorVscode: VscodeLmApi | undefined;
}

function getVscodeApi(): VscodeLmApi {
  if (globalThis.__conductorVscode?.lm) {
    return globalThis.__conductorVscode;
  }

  return require("vscode") as VscodeLmApi;
}

export async function selectModelForRole(
  role: Role,
  assignments: ModelAssignment[],
): Promise<vscode.LanguageModelChat> {
  const assignment = assignments.find((candidate) => candidate.role === role);

  if (!assignment) {
    throw new Error(`no model found for role \"${role}\"`);
  }

  const models = await getVscodeApi().lm?.selectChatModels({
    vendor: assignment.vendor,
    family: assignment.family,
  });

  if (!models?.length) {
    throw new Error(
      `no model found for role \"${role}\" with vendor \"${assignment.vendor}\" and family \"${assignment.family}\"`,
    );
  }

  return models[0];
}