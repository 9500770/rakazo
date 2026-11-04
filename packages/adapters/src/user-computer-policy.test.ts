import { describe, expect, it } from "vitest";
import {
  activeUserComputerPolicy,
  describeUserComputerPolicy,
  USER_COMPUTER_POLICY_ALL,
  userComputerPolicyExpiry,
} from "./user-computer-policy.js";

const now = new Date("2026-11-04T05:00:00Z");

describe("activeUserComputerPolicy", () => {
  it("reads the row for the computer before the row for all of them", () => {
    const rows = [
      { deviceKey: USER_COMPUTER_POLICY_ALL, mode: "allow", expiresAt: null },
      { deviceKey: "device-1", mode: "ask", expiresAt: null },
    ];
    expect(activeUserComputerPolicy(rows, "device-1", now)).toBe("ask");
    expect(activeUserComputerPolicy(rows, "device-2", now)).toBe("allow");
  });

  it("ignores an expired row and falls back", () => {
    const rows = [
      { deviceKey: USER_COMPUTER_POLICY_ALL, mode: "allow", expiresAt: null },
      { deviceKey: "device-1", mode: "ask", expiresAt: new Date(now.getTime() - 1) },
    ];
    expect(activeUserComputerPolicy(rows, "device-1", now)).toBe("allow");
    expect(activeUserComputerPolicy([], "device-1", now)).toBeUndefined();
  });

  it("does not read an unknown mode as a permission", () => {
    expect(
      activeUserComputerPolicy(
        [{ deviceKey: "device-1", mode: "yes", expiresAt: null }],
        "device-1",
      ),
    ).toBeUndefined();
  });
});

describe("userComputerPolicyExpiry", () => {
  it("turns minutes into a time, and clamps what a row may say", () => {
    expect(userComputerPolicyExpiry(undefined, now)).toBeNull();
    expect(userComputerPolicyExpiry(90, now)?.toISOString()).toBe("2026-11-04T06:30:00.000Z");
    expect(userComputerPolicyExpiry(0, now)?.toISOString()).toBe("2026-11-04T05:01:00.000Z");
    expect(userComputerPolicyExpiry(99_999, now)?.toISOString()).toBe("2026-12-04T05:00:00.000Z");
  });
});

describe("describeUserComputerPolicy", () => {
  it("stays short and turns an expired grant back into ask", () => {
    expect(describeUserComputerPolicy({ mode: "allow", expiresAt: null }, now)).toBe(
      "allow until revoked",
    );
    expect(
      describeUserComputerPolicy(
        { mode: "allow", expiresAt: new Date(now.getTime() + 90 * 60_000) },
        now,
      ),
    ).toBe("allow for 90m");
    expect(describeUserComputerPolicy({ mode: "allow", expiresAt: now }, now)).toBe("auto");
    expect(describeUserComputerPolicy({ mode: "ask", expiresAt: null }, now)).toBe("ask");
  });
});
