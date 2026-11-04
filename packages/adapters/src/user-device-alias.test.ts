import { describe, expect, it } from "vitest";
import {
  computerAlias,
  onlineUserComputers,
  pairedUserComputers,
  resolveUserDevice,
  safeDeviceLabel,
} from "./user-device-alias.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

describe("computerAlias", () => {
  it("slugs the name and appends the last four of the device id", () => {
    expect(computerAlias("Desk PC", "clx9k2f3abcd")).toBe("desk-pc-abcd");
    expect(computerAlias("MacBook", "DEV-7F3A")).toBe("macbook-7f3a");
  });

  it("lowercases and collapses everything that is not a letter or digit", () => {
    expect(computerAlias("Kai's Laptop!!", "id00001")).toBe("kai-s-laptop-0001");
    expect(computerAlias("  Büro--Ecke  ", "idx-99")).toBe("b-ro-ecke-x-99");
    expect(computerAlias("Über PC", "iddqde")).toBe("ber-pc-dqde");
  });

  it("falls back to computer when nothing survives the slug", () => {
    expect(computerAlias("!!!", "deviceabcd")).toBe("computer-abcd");
    expect(computerAlias("", "deviceabcd")).toBe("computer-abcd");
    expect(computerAlias("---", "deviceabcd")).toBe("computer-abcd");
  });

  it("truncates the slug to 32 characters and keeps the id tail", () => {
    expect(computerAlias("a".repeat(40), "device-wxyz")).toBe(`${"a".repeat(32)}-wxyz`);
    expect(computerAlias("a".repeat(40), "device-wxyz")).toHaveLength(32 + 1 + 4);
  });

  it("tells same-named devices apart by their ids", () => {
    expect(computerAlias("Studio", "first-1111")).not.toBe(computerAlias("Studio", "second-2222"));
    expect(computerAlias("Studio", "first-1111")).toBe("studio-1111");
  });

  it("is deterministic", () => {
    expect(computerAlias("Desk PC", "clx9k2f3abcd")).toBe(computerAlias("Desk PC", "clx9k2f3abcd"));
  });
});

describe("resolveUserDevice", () => {
  const devices = [
    {
      deviceId: "dev-latest01",
      name: "Desk PC",
      platform: "darwin",
      alias: computerAlias("Desk PC", "dev-latest01"),
    },
    {
      deviceId: "dev-old0002",
      name: "MacBook",
      platform: "win32",
      alias: computerAlias("MacBook", "dev-old0002"),
    },
  ];

  it("returns the latest device without a reference", () => {
    expect(resolveUserDevice(devices)).toBe(devices[0]);
    expect(resolveUserDevice(devices, "")).toBe(devices[0]);
    expect(resolveUserDevice(devices, "   ")).toBe(devices[0]);
  });

  it("matches by alias without regard to case, then by full id, then by exact name", () => {
    expect(resolveUserDevice(devices, "macbook-0002")).toBe(devices[1]);
    expect(resolveUserDevice(devices, "MacBook-0002")).toBe(devices[1]);
    expect(resolveUserDevice(devices, "dev-old0002")).toBe(devices[1]);
    expect(resolveUserDevice(devices, "MacBook")).toBe(devices[1]);
  });

  it("returns null for a reference nothing matches", () => {
    expect(resolveUserDevice(devices, "office-pc")).toBeNull();
    expect(resolveUserDevice(devices, "old0002")).toBeNull();
    expect(resolveUserDevice([], "desk-pc")).toBeNull();
    expect(resolveUserDevice([])).toBeNull();
  });
});

describe("onlineUserComputers", () => {
  it("lists every device a listing gateway has online", async () => {
    const gateway = {
      connected: async () => ({ deviceId: "dev-a1", name: "Desk", platform: "darwin" }),
      connectedAll: async () => [
        { deviceId: "dev-a1", name: "Desk", platform: "darwin", alias: "desk-0-a1" },
        { deviceId: "dev-b2", name: "Lap", platform: "win32", alias: "lap-0-b2" },
      ],
      connectedDevice: async () => null,
    } as unknown as UserDeviceGateway;
    await expect(onlineUserComputers(gateway, "user-1")).resolves.toHaveLength(2);
  });

  it("keeps the latest single device on a gateway that cannot list, and reads failure as offline", async () => {
    const listing = {
      connected: async () => ({ deviceId: "dev-a1", name: "Desk PC", platform: "darwin" }),
    } as unknown as UserDeviceGateway;
    await expect(onlineUserComputers(listing, "user-1")).resolves.toEqual([
      { deviceId: "dev-a1", name: "Desk PC", platform: "darwin", alias: "desk-pc-v-a1" },
    ]);
    const failing = {
      connected: async () => {
        throw new Error("db down");
      },
    } as unknown as UserDeviceGateway;
    await expect(onlineUserComputers(failing, "user-1")).resolves.toEqual([]);
    await expect(
      onlineUserComputers({} as unknown as UserDeviceGateway, "user-1"),
    ).resolves.toEqual([]);
  });
});

describe("pairedUserComputers", () => {
  it("lists paired devices when the gateway can, including ones that are offline", async () => {
    const gateway = {
      connected: async () => ({ deviceId: "dev-a1", name: "Desk", platform: "darwin" }),
      connectedAll: async () => [
        { deviceId: "dev-a1", name: "Desk", platform: "darwin", alias: "desk-0-a1" },
      ],
      connectedDevice: async () => null,
      pairedAll: async () => [
        { deviceId: "dev-a1", name: "Desk", platform: "darwin", alias: "desk-0-a1" },
        { deviceId: "dev-b2", name: "Lap", platform: "win32", alias: "lap-0-b2" },
      ],
    } as unknown as UserDeviceGateway;
    await expect(pairedUserComputers(gateway, "user-1")).resolves.toHaveLength(2);
  });

  it("falls back to the online list when the gateway cannot list paired devices", async () => {
    const gateway = {
      connected: async () => ({ deviceId: "dev-a1", name: "Desk PC", platform: "darwin" }),
      connectedAll: async () => [
        { deviceId: "dev-a1", name: "Desk PC", platform: "darwin", alias: "desk-pc-v-a1" },
      ],
      connectedDevice: async () => null,
    } as unknown as UserDeviceGateway;
    await expect(pairedUserComputers(gateway, "user-1")).resolves.toEqual([
      { deviceId: "dev-a1", name: "Desk PC", platform: "darwin", alias: "desk-pc-v-a1" },
    ]);
  });
});

describe("safeDeviceLabel", () => {
  it("strips newlines and control characters and caps the length", () => {
    expect(safeDeviceLabel("dar\nwin")).toBe("dar win");
    expect(safeDeviceLabel("win\u0002dows")).toBe("win dows");
    expect(safeDeviceLabel("  a\t b  ")).toBe("a b");
    expect(safeDeviceLabel("x".repeat(80))).toHaveLength(60);
  });
});
