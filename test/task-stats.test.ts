import { describe, expect, it } from "vitest";
import {
  calculateOutputTokenRate,
  calculateTotalTokens,
  formatCompactOutputTokenRate,
  formatCompactTotalTokens,
  formatOutputTokenRate,
  formatTotalTokens,
} from "../src/task-stats.js";

describe("total token count", () => {
  it("uses Pi's provider-reported total, including cache traffic", () => {
    const stats = { inputTokens: 1200, outputTokens: 400, totalTokens: 81_600 };

    expect(calculateTotalTokens(stats)).toBe(81_600);
    expect(formatTotalTokens(stats)).toBe("81.6k tok");
  });

  it("falls back to input plus output for legacy execution stats", () => {
    const stats = { inputTokens: 1200, outputTokens: 400 };

    expect(calculateTotalTokens(stats)).toBe(1600);
    expect(formatTotalTokens(stats)).toBe("1.6k tok");
  });

  it("formats compact widget totals with sigma and truncated million precision", () => {
    expect(formatCompactTotalTokens({ totalTokens: 3_347_800 })).toBe("Σ3.347M");
    expect(formatCompactTotalTokens({ totalTokens: 87_600 })).toBe("Σ87.6k");
    expect(formatCompactTotalTokens({ inputTokens: 500, outputTokens: 200 })).toBe("Σ700");
  });

  it.each([
    {},
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    { inputTokens: Number.NaN, outputTokens: 100 },
    { inputTokens: -1, outputTokens: 100 },
  ])("omits unavailable or invalid totals for %j", (stats) => {
    expect(calculateTotalTokens(stats)).toBeUndefined();
    expect(formatTotalTokens(stats)).toBeUndefined();
  });
});

describe("output token rate", () => {
  it("calculates average output tokens per second from a completed duration", () => {
    const stats = {
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_065_000,
      durationMs: 65_000,
      outputTokens: 400,
    };

    expect(calculateOutputTokenRate(stats)).toBeCloseTo(400 / 65);
    expect(formatOutputTokenRate(stats)).toBe("6.2 tok/s");
    expect(formatCompactOutputTokenRate(stats)).toBe("6.2 t/s");
  });

  it("derives live duration from the start time", () => {
    const stats = { startedAt: 10_000, outputTokens: 250 };

    expect(calculateOutputTokenRate(stats, 15_000)).toBe(50);
    expect(formatOutputTokenRate(stats, 15_000)).toBe("50.0 tok/s");
  });

  it.each([
    { startedAt: 10_000, outputTokens: 0 },
    { startedAt: 10_000, durationMs: 0, outputTokens: 100 },
    { startedAt: 10_000, durationMs: -1, outputTokens: 100 },
    { startedAt: 10_000, durationMs: 1000, outputTokens: Number.NaN },
  ])("omits unavailable or invalid rates for %j", (stats) => {
    expect(calculateOutputTokenRate(stats, 10_000)).toBeUndefined();
    expect(formatOutputTokenRate(stats, 10_000)).toBeUndefined();
  });
});
