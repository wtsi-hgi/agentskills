import { describe, expect, it } from "vitest";

import { parsePhaseFile } from "../../orchestrator/parser";

describe("parsePhaseFile", () => {
  it("parses the phase header and sequential items", () => {
    const content = `# Phase 2: Tool System

## Items

### Item 2.1: B1 - Tool schema

spec.md section: B1

- [ ] implemented
- [ ] reviewed

### Item 2.2: B2 - Bash tool

spec.md section: B2

- [ ] implemented
- [ ] reviewed
`;

    const phase = parsePhaseFile(content);

    expect(phase.number).toBe(2);
    expect(phase.title).toBe("Tool System");
    expect(phase.items).toHaveLength(2);
  });

  it("parses implemented and reviewed checkbox state", () => {
    const content = `# Phase 1: Core

### Item 1.1: A1 - Extension Activation and Commands

spec.md section: A1

- [x] implemented
- [ ] reviewed
`;

    const phase = parsePhaseFile(content);

    expect(phase.items[0]).toMatchObject({
      implemented: true,
      reviewed: false,
    });
  });

  it("groups parallel items into batches", () => {
    const content = `# Phase 1: Core Extension

### Batch 1 (parallel)

#### Item 1.2: B1 - Tool schema [parallel]

spec.md section: B1

- [ ] implemented
- [ ] reviewed

#### Item 1.3: B2 - Bash tool [parallel]

spec.md section: B2

- [ ] implemented
- [ ] reviewed

#### Item 1.4: C1 - Model selection [parallel]

spec.md section: C1

- [ ] implemented
- [ ] reviewed
`;

    const phase = parsePhaseFile(content);

    expect(phase.batches).toHaveLength(1);
    expect(phase.batches[0]).toHaveLength(3);
    expect(phase.batches[0].every((item) => item.batch === 1)).toBe(true);
  });

  it("extracts item id, title, and spec section reference", () => {
    const content = `# Phase 1: Core Extension

### Item 1.2: B1 - Tool dispatch

spec.md section: B1

- [ ] implemented
- [ ] reviewed
`;

    const phase = parsePhaseFile(content);

    expect(phase.items[0]).toMatchObject({
      id: "B1",
      title: "Tool dispatch",
      specSection: "B1",
    });
  });

  it("returns an empty phase for empty content", () => {
    const phase = parsePhaseFile("");

    expect(phase).toMatchObject({
      number: 0,
      title: "",
      items: [],
      batches: [],
    });
  });
});