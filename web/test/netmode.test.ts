import { describe, expect, it } from "vitest";
import {
  DEFAULT_NET_MODE,
  iceConfigFor,
  isNetMode,
  lanModeAvailable,
  loadNetMode,
  saveNetMode,
} from "../src/netmode.ts";

const SERVERS = [
  { urls: ["stun:stun.example:3478"] },
  { urls: ["turn:turn.example:3478"], username: "u", credential: "c" },
];

describe("iceConfigFor", () => {
  it("offers no ICE servers in local mode, so no relay can ever be used", () => {
    const cfg = iceConfigFor("local", SERVERS, "all");
    expect(cfg.iceServers).toEqual([]);
    expect(cfg.iceTransportPolicy).toBe("all");
  });

  it("passes the server's servers and policy through in any mode", () => {
    expect(iceConfigFor("any", SERVERS, "all")).toEqual({ iceServers: SERVERS, iceTransportPolicy: "all" });
  });

  it("cannot honour local mode when the server forces relay, so the server wins", () => {
    expect(lanModeAvailable("relay")).toBe(false);
    expect(iceConfigFor("local", SERVERS, "relay")).toEqual({
      iceServers: SERVERS,
      iceTransportPolicy: "relay",
    });
  });
});

describe("net mode persistence", () => {
  const store = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it("round-trips a saved mode", () => {
    const s = store();
    saveNetMode("local", s);
    expect(loadNetMode(s)).toBe("local");
  });

  it("falls back to the default for missing or junk values", () => {
    const s = store();
    expect(loadNetMode(s)).toBe(DEFAULT_NET_MODE);
    s.setItem("dropcode.netmode", "sideways");
    expect(loadNetMode(s)).toBe(DEFAULT_NET_MODE);
  });

  it("survives storage that throws, as in private browsing", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(loadNetMode(hostile)).toBe(DEFAULT_NET_MODE);
    expect(() => saveNetMode("local", hostile)).not.toThrow();
  });

  it("validates mode strings", () => {
    expect(isNetMode("local")).toBe(true);
    expect(isNetMode("any")).toBe(true);
    expect(isNetMode("lan")).toBe(false);
    expect(isNetMode(undefined)).toBe(false);
  });
});
