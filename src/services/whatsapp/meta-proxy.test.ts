import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildProxyHeaders, forwardRawMetaWebhook, signProxyBody } from "./meta-proxy.js";

const CARISTEO_SHARED =
  process.env.CARISTEO_META_SHARED_TS ??
  "/mnt/dev/linux-daniel/dev/Host/caristeo-healthcare/supabase/functions/_shared/metaWhatsApp.ts";

describe("meta-proxy", () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account", "x": "ção"}'); // espaços/UTF-8 preservados
  it("sem segredo não assina e repassa hub signature", () => {
    const h = buildProxyHeaders({ "x-hub-signature-256": "sha256=abc" }, raw, undefined);
    assert.equal(h["x-hub-signature-256"], "sha256=abc");
    assert.equal(h["x-wa-proxy-signature"], undefined);
  });
  it("com segredo assina <ts>.<corpo>", () => {
    const h = buildProxyHeaders({}, raw, "s3", 1700000000);
    assert.equal(h["x-wa-proxy-timestamp"], "1700000000");
    assert.equal(h["x-wa-proxy-signature"], signProxyBody(raw, "1700000000", "s3"));
  });
  it("reenvia bytes originais com timeout", async () => {
    let seen: { body?: unknown; signal?: AbortSignal } = {};
    const f = (async (_u: string, init: RequestInit) => {
      seen = { body: init.body, signal: init.signal ?? undefined };
      return new Response("ok");
    }) as unknown as typeof fetch;
    await forwardRawMetaWebhook("https://x.test/h", raw, {}, "s", f);
    assert.ok(Buffer.from(seen.body as Uint8Array).equals(raw));
    assert.ok(seen.signal);
  });
  it("aceita assinatura no receptor Caristeo (authenticateWebhook)", { skip: !fs.existsSync(CARISTEO_SHARED) }, async () => {
    const mod = await import(pathToFileURL(CARISTEO_SHARED).href);
    const secret = "segredo-compartilhado-teste";
    const now = Math.floor(Date.now() / 1000);
    const h = buildProxyHeaders({}, raw, secret, now);
    const call = (sig: string | null) =>
      mod.authenticateWebhook({
        rawBody: raw.toString("utf8"),
        hubSignature256: null,
        proxySignature: sig,
        proxyTimestamp: h["x-wa-proxy-timestamp"],
        secrets: { proxySharedSecret: secret },
      });
    const ok = await call(h["x-wa-proxy-signature"]);
    assert.deepEqual(ok, { ok: true, origin: "biano_proxy", method: "proxy_signature" });
    const bad = await call("0".repeat(64));
    assert.equal(bad.ok, false);
  });
});
