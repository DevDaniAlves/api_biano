import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";
import {
  createRateLimiter, createRouteAdminRouter, signRouteAdmin, validateTargetUrl,
  type RouteRow, type RouteStore, type RouteAdminConfig,
} from "./webhook-routes-admin.js";

const SECRET = "segredo-healthcare-0123456789-abcdefghij";
const SECRET_D = "segredo-delivery-0123456789-abcdefghijkl";
const secretOf = (src: string): string => (src === "delivery-caristeo" ? SECRET_D : SECRET);
const NOW = 1_800_000_000_000;
const OK_URL = "https://abcdefgh.supabase.co/functions/v1/whatsapp";

function memStore(): RouteStore & { rows: Map<string, RouteRow> } {
  const rows = new Map<string, RouteRow>();
  return {
    rows,
    async find(id) { return rows.get(id) ?? null; },
    async connect(r) {
      const cur = rows.get(r.phoneNumberId);
      if (cur && cur.source !== r.source) return "conflict";
      rows.set(r.phoneNumberId, { ...r, active: true, connectedAt: new Date(), deletedAt: null });
      return "ok";
    },
    async softDelete(id, source) {
      const cur = rows.get(id);
      if (!cur || cur.source !== source) return 0;
      rows.set(id, { ...cur, active: false, deletedAt: new Date() });
      return 1;
    },
    async internalPhoneIds() { return []; },
  };
}

const opened: http.Server[] = [];
after(() => { for (const s of opened) { s.close(); s.closeAllConnections(); } });

async function setup(cfgOver: Partial<RouteAdminConfig> = {}, limit?: (k: string) => boolean) {
  const store = memStore();
  const cfg: RouteAdminConfig = {
    secrets: { "caristeo-healthcare": SECRET, "delivery-caristeo": SECRET_D }, allowedHosts: ["abcdefgh.supabase.co"],
    internalPhoneIds: [], allowedPhoneIds: {}, now: () => NOW, ...cfgOver,
  };
  const app = express();
  app.use("/integrations/webhook-routes", createRouteAdminRouter({ getConfig: () => cfg, store, rateLimit: limit, failLimit: () => true }));
  const srv = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  opened.push(srv);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/integrations/webhook-routes`;
  async function call(path: string, bodyObj: unknown, o: { ts?: string; sig?: string; secret?: string; raw?: string } = {}) {
    const body = o.raw ?? JSON.stringify(bodyObj);
    const ts = o.ts ?? String(Math.floor(NOW / 1000));
    let declared = "caristeo-healthcare";
    try { declared = String((JSON.parse(body) as { source?: string }).source); } catch { /* nao-JSON */ }
    const sig = o.sig ?? signRouteAdmin(body, ts, o.secret ?? secretOf(declared));
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-route-timestamp": ts, "x-route-signature": sig },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  return { store, call, close: () => srv.close() };
}

const conn = (over: Record<string, unknown> = {}) => ({
  phoneNumberId: "123456789012345", displayPhone: "+55 11 99999-0000", targetUrl: OK_URL,
  label: "x", source: "caristeo-healthcare", ...over,
});

describe("route-admin auth", () => {
  it("assinatura valida conecta", async () => {
    const t = await setup();
    const r = await t.call("/connect", conn());
    t.close();
    assert.equal(r.status, 200);
    assert.equal(t.store.rows.get("123456789012345")?.targetUrl, OK_URL);
    assert.equal(t.store.rows.get("123456789012345")?.displayPhone, "5511999990000");
  });
  it("assinatura invalida / secret errado => 401", async () => {
    const t = await setup();
    assert.equal((await t.call("/connect", conn(), { secret: "outro" })).status, 401);
    assert.equal((await t.call("/connect", conn(), { sig: "abc" })).status, 401);
    t.close();
    assert.equal(t.store.rows.size, 0);
  });
  it("corpo alterado depois de assinar => 401", async () => {
    const t = await setup();
    const sig = signRouteAdmin(JSON.stringify(conn()), String(NOW / 1000), SECRET);
    const r = await t.call("/connect", null, { raw: JSON.stringify(conn({ label: "y" })), sig });
    t.close();
    assert.equal(r.status, 401);
  });
  it("replay fora da janela de 5 min => 401", async () => {
    const t = await setup();
    const old = String(NOW / 1000 - 301);
    const r = await t.call("/connect", conn(), { ts: old });
    const ok = await t.call("/connect", conn(), { ts: String(NOW / 1000 - 299) });
    t.close();
    assert.equal(r.status, 401);
    assert.equal(ok.status, 200);
  });
  it("sem segredo configurado => 503 (falha fechada)", async () => {
    const t = await setup({ secrets: {} });
    const r = await t.call("/connect", conn());
    t.close();
    assert.equal(r.status, 503);
    assert.equal(t.store.rows.size, 0);
  });
  it("sem lista de hosts => 503", async () => {
    const t = await setup({ allowedHosts: [] });
    const r = await t.call("/connect", conn());
    t.close();
    assert.equal(r.status, 503);
  });
  it("rate limit => 429", async () => {
    const t = await setup({}, createRateLimiter(2, 60000, () => 0));
    await t.call("/connect", conn({ label: "a" }));
    await t.call("/connect", conn({ label: "b" }));
    const r = await t.call("/connect", conn({ label: "c" }));
    t.close();
    assert.equal(r.status, 429);
  });
  it("corpo grande => 413", async () => {
    const t = await setup();
    const r = await t.call("/connect", conn({ label: "a".repeat(6000) }));
    t.close();
    assert.equal(r.status, 413);
  });
});

describe("validateTargetUrl (SSRF)", () => {
  const allow = ["abcdefgh.supabase.co", "exato.example.com"];
  const bad = [
    "http://abcdefgh.supabase.co/functions/v1/whatsapp",
    "https://127.0.0.1/functions/v1/whatsapp",
    "https://[::1]/functions/v1/whatsapp",
    "https://169.254.169.254/functions/v1/whatsapp",
    "https://2130706433/functions/v1/whatsapp",
    "https://localhost/functions/v1/whatsapp",
    "https://metadata.google.internal/functions/v1/whatsapp",
    "https://user:pw@abcdefgh.supabase.co/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co:8443/functions/v1/whatsapp",
    "https://evil.com/functions/v1/whatsapp",
    "https://supabase.co.evil.com/functions/v1/whatsapp",
    "https://evilsupabase.co/functions/v1/whatsapp",
    "https://supabase.co/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co/functions/v1/other",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp/x",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp?a=1",
    "https://abcdefgh.supabase.co/",
    "ftp://abcdefgh.supabase.co/functions/v1/whatsapp",
    "nao-e-url", "", 42,
  ];
  for (const u of bad) {
    it(`rejeita ${String(u)}`, () => assert.equal(validateTargetUrl(u, allow).ok, false));
  }
  it("aceita padrao e host exato; normaliza host", () => {
    assert.equal(validateTargetUrl(OK_URL, allow).ok, true);
    assert.equal(validateTargetUrl("https://exato.example.com/functions/v1/whatsapp", allow).ok, true);
    const r = validateTargetUrl("https://ABCDEFGH.supabase.co/functions/v1/whatsapp", allow);
    assert.ok(r.ok && r.url === OK_URL);
  });
  it("rota rejeita host proibido e phoneNumberId nao numerico", async () => {
    const t = await setup();
    assert.equal((await t.call("/connect", conn({ targetUrl: "https://127.0.0.1/functions/v1/whatsapp" }))).status, 400);
    assert.equal((await t.call("/connect", conn({ phoneNumberId: "12ab" }))).status, 400);
    assert.equal((await t.call("/connect", conn({ source: "outro" }))).status, 401);
    t.close();
    assert.equal(t.store.rows.size, 0);
  });
});

describe("connect/disconnect", () => {
  it("upsert idempotente e atualiza URL", async () => {
    const t = await setup({ allowedHosts: ["abcdefgh.supabase.co", "zzzzzzzz.supabase.co"] });
    assert.equal((await t.call("/connect", conn())).status, 200);
    assert.equal((await t.call("/connect", conn(), { ts: String(NOW / 1000 - 1) })).status, 200);
    const newUrl = "https://zzzzzzzz.supabase.co/functions/v1/whatsapp";
    assert.equal((await t.call("/connect", conn({ targetUrl: newUrl }))).status, 200);
    t.close();
    assert.equal(t.store.rows.size, 1);
    assert.equal(t.store.rows.get("123456789012345")?.targetUrl, newUrl);
  });
  it("conflito de source => 409 e nada muda", async () => {
    const t = await setup();
    await t.call("/connect", conn());
    const r = await t.call("/connect", conn({ source: "delivery-caristeo" }));
    const d = await t.call("/disconnect/123456789012345", { phoneNumberId: "123456789012345", source: "delivery-caristeo" });
    t.close();
    assert.equal(r.status, 409);
    assert.equal(d.status, 409);
    assert.equal(t.store.rows.get("123456789012345")?.source, "caristeo-healthcare");
    assert.equal(t.store.rows.get("123456789012345")?.active, true);
  });
  it("linha manual sem source => 409", async () => {
    const t = await setup();
    t.store.rows.set("999999", { phoneNumberId: "999999", displayPhone: null, targetUrl: "x", active: true, label: null, source: null, connectedAt: null, deletedAt: null });
    const r = await t.call("/connect", conn({ phoneNumberId: "999999" }));
    t.close();
    assert.equal(r.status, 409);
  });
  it("exclui (soft), idempotente; reconectar so pelo mesmo source", async () => {
    const t = await setup();
    await t.call("/connect", conn());
    const body = { phoneNumberId: "123456789012345", source: "caristeo-healthcare" };
    const d1 = await t.call("/disconnect/123456789012345", body);
    const d2 = await t.call("/disconnect/123456789012345", body, { ts: String(NOW / 1000 - 1) });
    assert.equal(d1.status, 200);
    assert.equal(d1.json.status, "disconnected");
    assert.equal(d2.json.status, "already_disconnected");
    const row = t.store.rows.get("123456789012345")!;
    assert.equal(row.active, false);
    assert.ok(row.deletedAt);
    const other = await t.call("/connect", conn({ source: "delivery-caristeo" }));
    const same = await t.call("/connect", conn({ label: "de novo" }));
    t.close();
    assert.equal(other.status, 409, "outro source nao assume linha excluida");
    assert.equal(same.status, 200);
    assert.equal(t.store.rows.get("123456789012345")?.active, true);
  });
  it("excluir inexistente => 200 absent; id da URL divergente => 400", async () => {
    const t = await setup();
    const a = await t.call("/disconnect/555555", { phoneNumberId: "555555", source: "caristeo-healthcare" });
    const b = await t.call("/disconnect/555555", { phoneNumberId: "666666", source: "caristeo-healthcare" });
    t.close();
    assert.equal(a.json.status, "absent");
    assert.equal(b.status, 400);
  });
  it("numero legado 556634016000 bloqueado", async () => {
    const t = await setup();
    const a = await t.call("/connect", conn({ phoneNumberId: "556634016000" }));
    const b = await t.call("/connect", conn({ displayPhone: "556634016000" }));
    const c = await t.call("/disconnect/556634016000", { phoneNumberId: "556634016000", source: "caristeo-healthcare" });
    t.close();
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);
    assert.equal(c.status, 403);
    assert.equal(t.store.rows.size, 0);
  });
});

describe("rotas internas do Biano intactas", () => {
  it("admin nunca altera linhas sem source (internas) nem o legado; webhook segue lendo so ativas", async () => {
    const t = await setup();
    const internal: RouteRow = { phoneNumberId: "777777", displayPhone: "5511000", targetUrl: "https://interno.example/x", active: true, label: "biano", source: null, connectedAt: null, deletedAt: null };
    t.store.rows.set("777777", { ...internal });
    const before = JSON.stringify(t.store.rows.get("777777"));
    const a = await t.call("/connect", conn({ phoneNumberId: "777777" }));
    const b = await t.call("/disconnect/777777", { phoneNumberId: "777777", source: "caristeo-healthcare" });
    await t.call("/connect", conn()); // outro numero: nao mexe no interno
    t.close();
    assert.equal(a.status, 409);
    assert.equal(b.status, 409);
    assert.equal(JSON.stringify(t.store.rows.get("777777")), before);
  });
  it("forwardRawMetaWebhook segue entregando bytes originais (sem alteracao)", async () => {
    const { forwardRawMetaWebhook } = await import("../services/whatsapp/meta-proxy.js");
    let got = "";
    const target = http.createServer((q, r) => { q.on("data", (c) => (got += c)); q.on("end", () => r.end("x")); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    await forwardRawMetaWebhook(`http://127.0.0.1:${(target.address() as AddressInfo).port}/`, Buffer.from('{"a": 1}'), {}, undefined);
    target.close();
    assert.equal(got, '{"a": 1}');
  });
});

describe("log diag mascarado", () => {
  it("diagLog nao imprime phone ids completos", async () => {
    const { diagLog } = await import("../services/whatsapp/meta-proxy.js");
    const lines: string[] = []; const o = console.log; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { diagLog("x", { phoneNumberId: "1236714352864758", displayPhone: "556634016000", eventType: "messages" }); } finally { console.log = o; }
    const out = lines.join("\n");
    assert.ok(!out.includes("1236714352864758") && !out.includes("556634016000"));
    assert.ok(out.includes("***4758") && out.includes("messages"));
  });
});
