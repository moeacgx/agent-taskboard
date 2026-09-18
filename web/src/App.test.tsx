import { describe, expect, it, vi } from "vitest";

import { createPaseoAutomationRequestGate } from "./App";

describe("Paseo automation request gate", () => {
  it("does not let a quiet poll supersede or strand an active foreground read", () => {
    const onPendingChange = vi.fn();
    const gate = createPaseoAutomationRequestGate(onPendingChange);

    const foreground = gate.begin(false);
    expect(foreground).not.toBeNull();
    expect(gate.begin(true)).toBeNull();

    gate.end(foreground!);
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("lets a foreground request supersede an older quiet poll and still clears pending", () => {
    const onPendingChange = vi.fn();
    const gate = createPaseoAutomationRequestGate(onPendingChange);

    const quiet = gate.begin(true);
    const foreground = gate.begin(false);
    expect(quiet).not.toBeNull();
    expect(foreground).not.toBeNull();
    expect(gate.isCurrent(quiet!)).toBe(false);
    expect(gate.isCurrent(foreground!)).toBe(true);

    gate.end(quiet!);
    gate.end(foreground!);
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  });
});
