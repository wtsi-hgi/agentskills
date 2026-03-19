import { describe, expect, it } from "vitest";

import { validateAuth } from "../../server/auth";

describe("validateAuth", () => {
  it("rejects missing auth when a token is configured", () => {
    expect(validateAuth(undefined, "secret123")).toBe(false);
  });

  it("accepts a matching bearer token", () => {
    expect(validateAuth("Bearer secret123", "secret123")).toBe(true);
  });

  it("disables auth checks when the configured token is empty", () => {
    expect(validateAuth(undefined, "")).toBe(true);
    expect(validateAuth("Bearer anything", "")).toBe(true);
  });
});