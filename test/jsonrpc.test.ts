import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcClosedError, JsonRpcPeer } from "../src/extension/acp/jsonrpc";

function make() {
  const input = new PassThrough();
  const output = new PassThrough();
  const outgoing: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => outgoing.push(chunk));
  const notifications: unknown[] = [];
  const peer = new JsonRpcPeer(output, input, undefined);
  peer.onNotification("session/update", (params) => {
    notifications.push(params);
  });
  return { peer, input, output, outgoing, notifications };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("JsonRpcPeer framing", () => {
  it("reassembles a large line delivered in many small chunks", async () => {
    const { input, notifications } = make();
    const payload = "x".repeat(300_000);
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: payload } }) + "\n";
    for (let i = 0; i < line.length; i += 1024) input.write(line.slice(i, i + 1024));
    await flush();
    expect(notifications).toHaveLength(1);
    expect((notifications[0] as { text: string }).text).toHaveLength(300_000);
  });

  it("handles several lines per chunk, CRLF endings, blank lines and a partial tail", async () => {
    const { input, notifications } = make();
    const n = (i: number) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { i } });
    input.write(`${n(1)}\r\n\n${n(2)}\n${n(3).slice(0, 10)}`);
    await flush();
    expect(notifications.map((p) => (p as { i: number }).i)).toEqual([1, 2]);
    input.write(`${n(3).slice(10)}\nnot json\n`);
    await flush();
    expect(notifications.map((p) => (p as { i: number }).i)).toEqual([1, 2, 3]);
  });

  it("rejects pending requests on close and refuses new ones without throwing", async () => {
    const { peer, input, outgoing } = make();
    const pending = peer.request("initialize", {});
    await flush();
    expect(outgoing.join("")).toContain('"method":"initialize"');
    input.end();
    peer.close("gone");
    await expect(pending).rejects.toBeInstanceOf(JsonRpcClosedError);
    await expect(peer.request("session/new", {})).rejects.toThrow("gone");
    expect(() => peer.notify("session/cancel", {})).not.toThrow();
    expect(peer.isClosed).toBe(true);
  });

  it("resolves responses by id and reports remote errors", async () => {
    const { peer, input } = make();
    const ok = peer.request<{ v: number }>("a", {});
    const bad = peer.request("b", {});
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { v: 42 } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "nope" } }) + "\n");
    await expect(ok).resolves.toEqual({ v: 42 });
    await expect(bad).rejects.toThrow("nope");
  });

  it("closes when a single line exceeds the maximum size", async () => {
    const { peer, input } = make();
    const closed: string[] = [];
    peer.onClose((reason) => closed.push(reason));
    const chunk = "y".repeat(8 * 1024 * 1024);
    for (let i = 0; i < 9 && !peer.isClosed; i++) input.write(chunk);
    await flush();
    expect(peer.isClosed).toBe(true);
    expect(closed[0]).toContain("longer than the maximum");
  });
});
