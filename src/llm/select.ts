import type * as vscode from "vscode";

import type { ChatModelOption, ModelAssignment, Role } from "../types";

type LanguageModelSelector = Pick<ModelAssignment, "vendor" | "family">;

type VscodeLmApi = {
  lm?: {
    selectChatModels(selector?: LanguageModelSelector): Promise<vscode.LanguageModelChat[]>;
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

function getModelBaseName(model: vscode.LanguageModelChat): string {
  const name = model.name.trim();
  if (name.length > 0) {
    return name;
  }

  if (model.family.trim().length > 0) {
    return model.family;
  }

  return `${model.vendor}/${model.id}`;
}

export async function listAvailableChatModels(vscodeApi: VscodeLmApi = getVscodeApi()): Promise<ChatModelOption[]> {
  const models = await vscodeApi.lm?.selectChatModels();
  if (!models?.length) {
    return [];
  }

  const deduplicated: vscode.LanguageModelChat[] = [];
  const seenPairs = new Set<string>();
  for (const model of models) {
    const key = `${model.vendor}\u0000${model.family}`;
    if (seenPairs.has(key)) {
      continue;
    }

    seenPairs.add(key);
    deduplicated.push(model);
  }

  const nameCounts = new Map<string, number>();
  for (const model of deduplicated) {
    const baseName = getModelBaseName(model);
    nameCounts.set(baseName, (nameCounts.get(baseName) ?? 0) + 1);
  }

  return deduplicated
    .map((model) => {
      const name = getModelBaseName(model);
      const label = (nameCounts.get(name) ?? 0) > 1
        ? `${name} (${model.vendor}/${model.family})`
        : name;

      return {
        vendor: model.vendor,
        family: model.family,
        name,
        label,
      } satisfies ChatModelOption;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function selectModelForRole(
  role: Role,
  assignments: ModelAssignment[],
): Promise<vscode.LanguageModelChat> {
  const assignment = assignments.find((candidate) => candidate.role === role);

  if (!assignment) {
    throw new Error(`no model found for role \"${role}\"`);
  }

  const selector = assignment.vendor || assignment.family
    ? {
      vendor: assignment.vendor,
      family: assignment.family,
    }
    : undefined;
  const models = await getVscodeApi().lm?.selectChatModels(selector);

  if (!models?.length) {
    if (!selector) {
      throw new Error(`no model found for role "${role}" in automatic selection mode`);
    }

    throw new Error(
      `no model found for role \"${role}\" with vendor \"${assignment.vendor}\" and family \"${assignment.family}\"`,
    );
  }

  return models[0];
}
