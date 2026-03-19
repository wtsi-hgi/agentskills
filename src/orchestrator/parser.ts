import type { Phase, PhaseItem } from "../types";

const PHASE_HEADER_PATTERN = /^# Phase (\d+):\s*(.+?)\s*$/;
const BATCH_HEADER_PATTERN = /^### Batch (\d+) \(parallel\)\s*$/;
const ITEM_HEADER_PATTERN = /^(###|####) Item \d+(?:\.\d+)*:\s*([^\s]+)\s*-\s*(.+?)(?:\s+\[parallel\])?\s*$/;
const SPEC_SECTION_PATTERN = /^spec\.md section:\s*(.+?)\s*$/i;
const CHECKBOX_PATTERN = /^- \[([ xX])\] (implemented|reviewed)\s*$/;

export function parsePhaseFile(content: string): Phase {
  const phase: Phase = {
    number: 0,
    title: "",
    items: [],
    batches: [],
  };

  if (content.trim() === "") {
    return phase;
  }

  const lines = content.split(/\r?\n/);
  const batchesByNumber = new Map<number, PhaseItem[]>();
  let activeBatch: number | undefined;
  let currentItem: PhaseItem | undefined;

  const commitCurrentItem = () => {
    if (currentItem === undefined) {
      return;
    }

    phase.items.push(currentItem);

    if (currentItem.batch !== undefined) {
      const batchItems = batchesByNumber.get(currentItem.batch) ?? [];
      batchItems.push(currentItem);
      batchesByNumber.set(currentItem.batch, batchItems);
    }

    currentItem = undefined;
  };

  for (const line of lines) {
    const phaseHeaderMatch = line.match(PHASE_HEADER_PATTERN);

    if (phaseHeaderMatch !== null) {
      phase.number = Number.parseInt(phaseHeaderMatch[1], 10);
      phase.title = phaseHeaderMatch[2];
      continue;
    }

    const batchHeaderMatch = line.match(BATCH_HEADER_PATTERN);

    if (batchHeaderMatch !== null) {
      commitCurrentItem();
      activeBatch = Number.parseInt(batchHeaderMatch[1], 10);
      continue;
    }

    const itemHeaderMatch = line.match(ITEM_HEADER_PATTERN);

    if (itemHeaderMatch !== null) {
      commitCurrentItem();

      const headingLevel = itemHeaderMatch[1];
      const isBatchItem = headingLevel === "####";

      if (!isBatchItem) {
        activeBatch = undefined;
      }

      currentItem = {
        id: itemHeaderMatch[2],
        title: itemHeaderMatch[3],
        specSection: "",
        implemented: false,
        reviewed: false,
        batch: isBatchItem ? activeBatch : undefined,
      };
      continue;
    }

    if (currentItem === undefined) {
      continue;
    }

    const specSectionMatch = line.match(SPEC_SECTION_PATTERN);

    if (specSectionMatch !== null) {
      currentItem.specSection = specSectionMatch[1];
      continue;
    }

    const checkboxMatch = line.match(CHECKBOX_PATTERN);

    if (checkboxMatch === null) {
      continue;
    }

    const isChecked = checkboxMatch[1].toLowerCase() === "x";
    const field = checkboxMatch[2];

    if (field === "implemented") {
      currentItem.implemented = isChecked;
      continue;
    }

    currentItem.reviewed = isChecked;
  }

  commitCurrentItem();
  phase.batches = [...batchesByNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, items]) => items);

  return phase;
}