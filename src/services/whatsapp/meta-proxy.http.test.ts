import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { forwardRawMetaWebhook, signProxyBody } from "./meta-proxy.js";

function listen(handler: http.RequestListener): Promise<{ srv: http.Server; url: string }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, "127.0.0.1", () => {
      resolve({ srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/h` });
    });
  });
}

function captureLogs() {
  const lines: string[] = [];
  const o = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push; console.warn = push; console.error = push;
  return { lines, restore: () => Object.assign(console, o) };
}

describe("meta-proxy http local", () => {
  const raw = Buffer.from('{ "a" : 1,  "t":"ção" }\n');
  it("preserva bytes e headers de assinatura", async () => {
    let got: { body: Buffer; headers: http.IncomingHttpHeaders } | null = null;
    const { srv, url } = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { got = { body: Buffer.concat(chunks), headers: req.headers }; res.end("ok"); });
    });
    await forwardRawMetaWebhook(url, raw, { "x-hub-signature-256": "sha256=zz", "user-agent": "facebookplatform" }, "segredo");
    srv.close();
    assert.ok(got);
    const g = got as unknown as { body: Buffer; headers: http.IncomingHttpHeaders };
    assert.ok(g.body.equals(raw));
    assert.equal(g.headers["x-hub-signature-256"], "sha256=zz");
    const ts = g.headers["x-wa-proxy-timestamp"] as string;
    assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) < 5);
    assert.equal(g.headers["x-wa-proxy-signature"], signProxyBody(raw, ts, "segredo"));
  });
  it("aborta em ~5s e log sem corpo/segredo", { timeout: 15000 }, async () => {
    const { srv, url } = await listen(() => { /* nunca responde */ });
    const cap = captureLogs();
    const t0 = Date.now();
    try { await forwardRawMetaWebhook(url, raw, {}, "SEGREDOXYZ"); } finally { cap.restore(); }
    const dt = Date.now() - t0;
    srv.closeAllConnections?.(); srv.close();
    assert.ok(dt >= 4900 && dt < 7000, `dt=${dt}`);
    const all = cap.lines.join("\n");
    assert.ok(all.includes("falha ao encaminhar"));
    assert.ok(!all.includes("SEGREDOXYZ") && !all.includes("ção"));
  });
  it("status != 2xx apenas loga warn", async () => {
    const { srv, url } = await listen((_q, res) => { res.statusCode = 500; res.end(); });
    const cap = captureLogs();
    try { await forwardRawMetaWebhook(url, raw, {}, undefined); } finally { cap.restore(); }
    srv.close();
    assert.match(cap.lines.join("\n"), /respondeu 500/);
  });
});
