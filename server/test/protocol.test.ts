import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, parseClientMessage } from "../src/protocol.ts";

describe("parseClientMessage", () => {
  it("accepts well-formed messages", () => {
    expect(parseClientMessage('{"t":"create"}')).toEqual({ t: "create" });
    expect(parseClientMessage('{"t":"join","nameplate":"42"}')).toEqual({ t: "join", nameplate: "42" });
    expect(
      parseClientMessage(JSON.stringify({ t: "signal", data: { kind: "offer", sdp: "v=0" } })),
    ).toEqual({ t: "signal", data: { kind: "offer", sdp: "v=0" } });
    expect(
      parseClientMessage(
        JSON.stringify({
          t: "signal",
          data: { kind: "candidate", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "abcd" } },
        }),
      ),
    ).toMatchObject({ t: "signal", data: { kind: "candidate" } });
  });

  it.each([
    ["not json", "{"],
    ["array", "[]"],
    ["unknown type", '{"t":"nope"}'],
    ["extra keys", '{"t":"create","x":1}'],
    ["nameplate with words", '{"t":"join","nameplate":"4-apple-river"}'],
    ["leading zero", '{"t":"join","nameplate":"04"}'],
    ["too long nameplate", '{"t":"join","nameplate":"1234567"}'],
    ["numeric nameplate", '{"t":"join","nameplate":4}'],
    ["bad signal kind", '{"t":"signal","data":{"kind":"x"}}'],
    ["empty sdp", '{"t":"signal","data":{"kind":"offer","sdp":""}}'],
    ["huge sdp", JSON.stringify({ t: "signal", data: { kind: "offer", sdp: "a".repeat(17000) } })],
    ["huge candidate", JSON.stringify({ t: "signal", data: { kind: "candidate", candidate: { candidate: "a".repeat(2000) } } })],
    ["bad mline", JSON.stringify({ t: "signal", data: { kind: "candidate", candidate: { candidate: "a", sdpMLineIndex: -1 } } })],
    ["oversize frame", JSON.stringify({ t: "create", pad: "a".repeat(MAX_MESSAGE_BYTES) })],
  ])("rejects %s", (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
