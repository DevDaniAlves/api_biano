// QA adversarial das rotas admin de repasse. Rodar: npx tsx --test src/routes/webhook-routes-admin.qa.test.ts
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";
import {
  clientIp, configFromEnv, createRateLimiter, createRouteAdminRouter, signRouteAdmin, validateTargetUrl, verifySignature,
  type RouteRow, type RouteStore, type RouteAdminConfig, type RouteSource,
} from "./webhook-routes-admin.js";
import { forwardRawMetaWebhook } from "../services/whatsapp/meta-proxy.js";

const SECRET_H = "segredo-healthcare-0123456789-abcdefghij";
const SECRET_D = "segredo-delivery-0123456789-abcdefghijkl";
const SECRET = SECRET_H;
const secretOf = (src: string): string => (src === "delivery-caristeo" ? SECRET_D : SECRET_H);
const NOW = 1_800_000_000_000;
const NOW_S = Math.floor(NOW / 1000);
const OK_URL = "https://abcdefgh.supabase.co/functions/v1/whatsapp";
const HOSTS = ["abcdefgh.supabase.co"];

function memStore(seed: RouteRow[] = [], delayMs = 0, internal: string[] = []) {
  const rows = new Map<string, RouteRow>(seed.map((r) => [r.phoneNumberId, r]));
  const store: RouteStore = {
    async find(id) { return rows.get(id) ?? null; },
    // Atomico como o banco: o atraso vem ANTES; checagem e gravacao sao sincronas.
    async connect(r) {
      if (delayMs) await new Promise((x) => setTimeout(x, delayMs));
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
    async internalPhoneIds() { return internal; },
  };
  return { rows, store };
}

async function setup(seed: RouteRow[] = [], cfgOver: Partial<RouteAdminConfig> = {}, delayMs = 0, internal: string[] = []) {
  const { rows, store } = memStore(seed, delayMs, internal);
  const cfg: RouteAdminConfig = {
    secrets: { "caristeo-healthcare": SECRET_H, "delivery-caristeo": SECRET_D }, allowedHosts: HOSTS,
    internalPhoneIds: [], allowedPhoneIds: {}, now: () => NOW, ...cfgOver,
  };
  const app = express();
  app.use("/r", createRouteAdminRouter({ getConfig: () => cfg, store, rateLimit: () => true, failLimit: () => true }));
  const srv = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  opened.push(srv);
  const port = (srv.address() as AddressInfo).port;
  /** Envia bytes crus com cabecalhos arbitrarios (inclusive duplicados) via http.request. */
  function rawCall(path: string, body: string, headers: [string, string][]): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/r" + path, method: "POST", rawHeaders: undefined } as http.RequestOptions, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : {} }));
      });
      req.on("error", reject);
      for (const [k, v] of headers) req.appendHeader ? (req as unknown as { appendHeader(k: string, v: string): void }).appendHeader(k, v) : req.setHeader(k, v);
      req.write(body); req.end();
    });
  }
  const signed = (path: string, body: string, o: { ts?: string; secret?: string } = {}) => {
    const ts = o.ts ?? String(NOW_S);
    let declared = "caristeo-healthcare";
    try { declared = String((JSON.parse(body) as { source?: string }).source); } catch { /* corpo nao-JSON */ }
    return rawCall(path, body, [["content-type", "application/json"], ["x-route-timestamp", ts], ["x-route-signature", signRouteAdmin(body, ts, o.secret ?? secretOf(declared))]]);
  };
  return { rows, signed, rawCall, close: () => { srv.close(); srv.closeAllConnections(); } };
}

const conn = (o: Record<string, unknown> = {}) => JSON.stringify({
  phoneNumberId: "123456789012345", targetUrl: OK_URL, label: "x", source: "caristeo-healthcare", ...o,
});

const opened: http.Server[] = [];
after(() => { for (const s of opened) { s.close(); s.closeAllConnections(); } });

describe("QA HMAC", () => {
  it("timestamp: ms, futuro, limites, formatos", () => {
    const body = Buffer.from("{}");
    const ok = (ts: string, now = NOW) => verifySignature(body, ts, signRouteAdmin(body, ts, SECRET), SECRET, now);
    assert.equal(ok(String(NOW_S)), true);
    assert.equal(ok(String(NOW_S - 300)), true);
    assert.equal(ok(String(NOW_S - 301)), false);
    assert.equal(ok(String(NOW_S + 300)), true);
    assert.equal(ok(String(NOW_S + 301)), false);
    assert.equal(ok(String(NOW)), false, "ms rejeitado");
    for (const bad of ["-1", "1.5", "1e9", "0x10", " 1800000000", "", "+1800000000"]) assert.equal(ok(bad), false, bad);
  });
  it("assinatura: maiuscula aceita, tamanho errado/nao-hex/vazia rejeitada", () => {
    const body = Buffer.from("{}"); const ts = String(NOW_S);
    const s = signRouteAdmin(body, ts, SECRET);
    assert.equal(verifySignature(body, ts, s.toUpperCase(), SECRET, NOW), true);
    assert.equal(verifySignature(body, ts, s.slice(0, -1), SECRET, NOW), false);
    assert.equal(verifySignature(body, ts, s + "0", SECRET, NOW), false);
    assert.equal(verifySignature(body, ts, "z".repeat(64), SECRET, NOW), false);
    assert.equal(verifySignature(body, ts, "", SECRET, NOW), false);
  });
  it("HMAC cobre bytes exatos: espacos, ordem de chaves, unicode re-serializado => 401", async () => {
    const t = await setup();
    const body = conn({ label: "Clínica ✓" });
    const sig = signRouteAdmin(body, String(NOW_S), SECRET);
    const variants = [
      JSON.stringify(JSON.parse(body), null, 1),
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(body)).reverse())),
      body.replace("Clínica ✓", "Cl\\u00ednica \\u2713"),
      body + " ",
    ];
    for (const v of variants) {
      const r = await t.rawCall("/connect", v, [["content-type", "application/json"], ["x-route-timestamp", String(NOW_S)], ["x-route-signature", sig]]);
      assert.equal(r.status, 401, v.slice(0, 40));
    }
    assert.equal((await t.signed("/connect", body)).status, 200, "bytes originais ok (utf8)");
    t.close();
  });
  it("cabecalhos duplicados de assinatura/timestamp => 401 (nunca aceita)", async () => {
    const t = await setup(); const body = conn(); const ts = String(NOW_S); const sig = signRouteAdmin(body, ts, SECRET);
    const dupSig = await t.rawCall("/connect", body, [["x-route-timestamp", ts], ["x-route-signature", sig], ["x-route-signature", sig]]);
    const dupTs = await t.rawCall("/connect", body, [["x-route-timestamp", ts], ["x-route-timestamp", ts], ["x-route-signature", sig]]);
    assert.equal(dupSig.status, 401); assert.equal(dupTs.status, 401);
    t.close();
  });
  it("segredo curto (<32) e segredo ausente do source => 503; segredos iguais => ambos invalidos", async () => {
    const t = await setup([], { secrets: {} });
    assert.equal((await t.signed("/connect", conn())).status, 503);
    t.close();
    const env = { WA_ROUTE_ADMIN_SECRET_CARISTEO_HEALTHCARE: "curto", WA_ROUTE_ADMIN_SECRET_DELIVERY_CARISTEO: SECRET_D } as NodeJS.ProcessEnv;
    assert.deepEqual(configFromEnv(env).secrets, { "delivery-caristeo": SECRET_D });
    const same = { WA_ROUTE_ADMIN_SECRET_CARISTEO_HEALTHCARE: SECRET_D, WA_ROUTE_ADMIN_SECRET_DELIVERY_CARISTEO: SECRET_D } as NodeJS.ProcessEnv;
    assert.deepEqual(configFromEnv(same).secrets, {});
    assert.deepEqual(configFromEnv({ WA_ROUTE_ADMIN_SECRET: SECRET_D } as NodeJS.ProcessEnv).secrets, {}, "segredo unico antigo ignorado");
  });
  it("corpo exatamente 4096 ok / 4097 => 413; nao-JSON assinado => 401 (sem source); array => 401", async () => {
    const t = await setup();
    const pad = (n: number) => { const base = conn({ label: "" }); const fixed = base.slice(0, -1) + `,"x":""}`; return fixed.slice(0, -2) + "a".repeat(n - fixed.length) + `"}`; };
    assert.equal(pad(4096).length, 4096);
    assert.equal((await t.signed("/connect", pad(4096))).status, 200);
    assert.equal((await t.signed("/connect", pad(4097))).status, 413);
    assert.equal((await t.signed("/connect", "nao-json")).status, 401);
    assert.equal((await t.signed("/connect", "[]")).status, 401);
    t.close();
  });
  it("disconnect: id da URL != corpo => 400; replay identico devolve o mesmo resultado", async () => {
    const t = await setup();
    await t.signed("/connect", conn());
    const b = JSON.stringify({ phoneNumberId: "123456789012345", source: "caristeo-healthcare" });
    assert.equal((await t.signed("/disconnect/999999999", b)).status, 400);
    assert.equal((await t.signed("/disconnect/123456789012345", b)).json.status, "disconnected");
    // mesma assinatura (replay): devolve o resultado em cache, nao reexecuta
    assert.equal((await t.signed("/disconnect/123456789012345", b)).json.status, "disconnected");
    assert.equal((await t.signed("/disconnect/123456789012345", b, { ts: String(NOW_S - 1) })).json.status, "already_disconnected");
    t.close();
  });
});

describe("QA SSRF/URL", () => {
  const bad = [
    "https://user:pw@abcdefgh.supabase.co/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co:8443/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp?x=1",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp#f",
    "https://127.0.0.1/functions/v1/whatsapp", "https://2130706433/functions/v1/whatsapp",
    "https://0x7f000001/functions/v1/whatsapp", "https://0177.0.0.1/functions/v1/whatsapp",
    "https://[::1]/functions/v1/whatsapp", "https://[::ffff:127.0.0.1]/functions/v1/whatsapp",
    "https://169.254.169.254/functions/v1/whatsapp", "https://localhost/functions/v1/whatsapp",
    "https://metadata.google.internal/functions/v1/whatsapp",
    "https://evil-supabase.co/functions/v1/whatsapp", "https://supabase.co.evil.com/functions/v1/whatsapp",
    "https://supabase.co/functions/v1/whatsapp", "https://.supabase.co/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co./functions/v1/whatsapp",
    "https://xn--abcdefgh-supabase.co/functions/v1/whatsapp", "https://аbcdefgh.supabase.co.evil.com/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp/", "https://abcdefgh.supabase.co/Functions/v1/whatsapp",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp%2f", "https://abcdefgh.supabase.co/functions/v1/other",
    "https://abcdefgh.supabase.co\\@evil.com/functions/v1/whatsapp", "https://evil.com\\@abcdefgh.supabase.co/functions/v1/whatsapp",
    "http://abcdefgh.supabase.co/functions/v1/whatsapp", "//abcdefgh.supabase.co/functions/v1/whatsapp",
    "https://abcdefgh.supabase.co/functions/v1/whatsapp/../../../x",
  ];
  for (const u of bad) it(`rejeita ${u}`, () => assert.equal(validateTargetUrl(u, HOSTS).ok, false, u));
  it("normaliza maiusculas e porta 443; path normalizado por dot-segments", () => {
    const a = validateTargetUrl("HTTPS://ABCDEFGH.SUPABASE.CO:443/functions/v1/whatsapp", HOSTS);
    assert.deepEqual(a.ok && a.url, OK_URL);
    const b = validateTargetUrl("https://abcdefgh.supabase.co/x/../functions/v1/whatsapp", HOSTS);
    assert.deepEqual(b.ok && b.url, OK_URL);
  });
  it("so host exato: outros projetos e subdominios multinivel recusados; wildcard na config => hostsInvalid + 503", async () => {
    for (const h of ["qualquercliente.supabase.co", "a.b.supabase.co", "x.abcdefgh.supabase.co"]) assert.equal(validateTargetUrl(`https://${h}/functions/v1/whatsapp`, HOSTS).ok, false);
    assert.equal(validateTargetUrl(OK_URL, ["*.supabase.co"]).ok, false, "'*.' nunca casa");
    assert.equal(configFromEnv({ WA_ROUTE_ALLOWED_HOSTS: "*.supabase.co" } as NodeJS.ProcessEnv).hostsInvalid, true);
    assert.equal(configFromEnv({ WA_ROUTE_ALLOWED_HOSTS: "*" } as NodeJS.ProcessEnv).hostsInvalid, true);
    assert.equal(configFromEnv({ WA_ROUTE_ALLOWED_HOSTS: "abcdefgh.supabase.co, outro.supabase.co" } as NodeJS.ProcessEnv).hostsInvalid, false);
    const t = await setup([], { hostsInvalid: true });
    assert.equal((await t.signed("/connect", conn())).status, 503);
    t.close();
  });
  it("ref exato restringe", () => {
    assert.equal(validateTargetUrl("https://outro.supabase.co/functions/v1/whatsapp", ["abcdefgh.supabase.co"]).ok, false);
  });
  it("fetch (meta-proxy) NAO segue redirecionamento (302) e registra erro", async () => {
    let hit: { headers: http.IncomingHttpHeaders; body: string; method?: string } | null = null;
    const sink = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { hit = { headers: req.headers, body: b, method: req.method }; res.end("ok"); }); });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const sp = (sink.address() as AddressInfo).port;
    const redir = http.createServer((_q, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${sp}/interno` }); res.end(); });
    await new Promise<void>((r) => redir.listen(0, "127.0.0.1", r));
    const rp = (redir.address() as AddressInfo).port;
    const errs: string[] = []; const oe = console.error; console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    try { await forwardRawMetaWebhook(`http://127.0.0.1:${rp}/x`, Buffer.from('{"msg":"segredo"}'), { "x-hub-signature-256": "sha256=abc" }, "proxysecret"); } finally { console.error = oe; }
    redir.close(); sink.close(); redir.closeAllConnections(); sink.closeAllConnections();
    assert.equal(hit, null, "redirect nao pode ser seguido");
    assert.ok(errs.some((e) => e.includes("redirecionamento 302")));
  });
});

describe("QA autorizacao / isolamento", () => {
  const row = (o: Partial<RouteRow>): RouteRow => ({
    phoneNumberId: "123456789012345", displayPhone: null, targetUrl: OK_URL, active: true, label: null,
    source: null, connectedAt: null, deletedAt: null, ...o,
  });
  it("linha sem source (interna/manual): connect 409 e disconnect 409; nada muda", async () => {
    const t = await setup([row({})]);
    assert.equal((await t.signed("/connect", conn())).status, 409);
    assert.equal((await t.signed("/disconnect/123456789012345", JSON.stringify({ phoneNumberId: "123456789012345", source: "delivery-caristeo" }))).status, 409);
    assert.equal(t.rows.get("123456789012345")!.active, true);
    t.close();
  });
  it("source em body invalido/ausente => 401 (nao ha segredo para validar) (ex.: internal, proto)", async () => {
    const t = await setup();
    for (const s of ["internal", "", null, 1, "__proto__"]) assert.equal((await t.signed("/connect", conn({ source: s }))).status, 401);
    t.close();
  });
  it("legado: phoneNumberId=556634016000 ou displayPhone => 403", async () => {
    const t = await setup();
    assert.equal((await t.signed("/connect", conn({ phoneNumberId: "556634016000" }))).status, 403);
    assert.equal((await t.signed("/connect", conn({ displayPhone: "+55 66 3401-6000" }))).status, 403);
    t.close();
  });
  it("soft delete so pode ser reconectado pelo MESMO source (outro => 409; mesmo => 200)", async () => {
    const t = await setup([row({ source: "caristeo-healthcare", active: false, deletedAt: new Date() })]);
    assert.equal((await t.signed("/connect", conn({ source: "delivery-caristeo" }))).status, 409);
    assert.equal(t.rows.get("123456789012345")!.source, "caristeo-healthcare");
    assert.equal((await t.signed("/connect", conn({ source: "caristeo-healthcare" }))).status, 200);
    assert.equal(t.rows.get("123456789012345")!.active, true);
    t.close();
  });
  it("segredo por source: delivery nao consegue agir como healthcare (assinatura com o segredo errado => 401)", async () => {
    const t = await setup([row({ source: "caristeo-healthcare" })]);
    const b = JSON.stringify({ phoneNumberId: "123456789012345", source: "caristeo-healthcare" });
    assert.equal((await t.signed("/disconnect/123456789012345", b, { secret: SECRET_D })).status, 401);
    assert.equal((await t.signed("/connect", conn({ source: "caristeo-healthcare" }), { secret: SECRET_D })).status, 401);
    assert.equal(t.rows.get("123456789012345")!.active, true);
    // delivery assinando como ele mesmo contra rota do healthcare: 409
    const own = JSON.stringify({ phoneNumberId: "123456789012345", source: "delivery-caristeo" });
    assert.equal((await t.signed("/disconnect/123456789012345", own)).status, 409);
    t.close();
  });
  it("corrida (QA-A2): duas conexoes simultaneas de sources diferentes => exatamente um 200 e um 409", async () => {
    const t = await setup([], {}, 40);
    const rs = await Promise.all([
      t.signed("/connect", conn({ source: "caristeo-healthcare" })),
      t.signed("/connect", conn({ source: "delivery-caristeo" })),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const owner = t.rows.get("123456789012345")!.source;
    assert.equal(rs.find((r) => r.status === 200) === rs[0] ? "caristeo-healthcare" : "delivery-caristeo", owner);
    t.close();
  });
  it("QA-C1: numero interno (set-meta-ids, env, banco) => 403 e nada gravado", async () => {
    const t = await setup([], { internalPhoneIds: ["777000111222"] }, 0, ["888000111222"]);
    for (const id of ["1236714352864758", "777000111222", "888000111222", "556634016000"]) {
      assert.equal((await t.signed("/connect", conn({ phoneNumberId: id }))).status, 403, id);
    }
    assert.equal((await t.signed("/connect", conn({ displayPhone: "+55 66 3401-6000" }))).status, 403);
    const b = JSON.stringify({ phoneNumberId: "1236714352864758", source: "caristeo-healthcare" });
    assert.equal((await t.signed("/disconnect/1236714352864758", b)).status, 403);
    assert.equal(t.rows.size, 0);
    t.close();
  });
  it("QA-C1: allowlist por source (quando definida so esses IDs; sem ela, so fora da blocklist)", async () => {
    const t = await setup([], { allowedPhoneIds: { "caristeo-healthcare": ["123456789012345"] } });
    assert.equal((await t.signed("/connect", conn({ phoneNumberId: "999888777666555" }))).status, 403);
    assert.equal((await t.signed("/connect", conn())).status, 200);
    assert.equal((await t.signed("/connect", conn({ phoneNumberId: "999888777666555", source: "delivery-caristeo" }))).status, 200, "delivery sem allowlist");
    t.close();
    assert.deepEqual(configFromEnv({ WA_ROUTE_ALLOWED_PHONE_IDS_DELIVERY_CARISTEO: "111111, 222222" } as NodeJS.ProcessEnv).allowedPhoneIds, { "delivery-caristeo": ["111111", "222222"] });
  });
  it("QA-B1: replay da mesma assinatura devolve o resultado em cache e nao reativa rota apos disconnect legitimo", async () => {
    const t = await setup();
    const body = conn();
    assert.equal((await t.signed("/connect", body)).status, 200);
    await t.signed("/disconnect/123456789012345", JSON.stringify({ phoneNumberId: "123456789012345", source: "caristeo-healthcare" }));
    assert.equal(t.rows.get("123456789012345")!.active, false);
    assert.equal((await t.signed("/connect", body)).status, 200, "resposta em cache");
    assert.equal(t.rows.get("123456789012345")!.active, false, "replay nao reexecutou");
    t.close();
  });
  it("QA-M4: requisicoes invalidas nao consomem o limite de quem tem assinatura valida; limite por source|ip", async () => {
    const store = memStore().store;
    const cfg: RouteAdminConfig = { secrets: { "caristeo-healthcare": SECRET_H }, allowedHosts: HOSTS, internalPhoneIds: [], allowedPhoneIds: {}, now: () => NOW };
    const app = express();
    app.use("/r", createRouteAdminRouter({ getConfig: () => cfg, store, rateLimit: createRateLimiter(3, 60000), failLimit: createRateLimiter(5, 60000, Date.now, true) }));
    const srv = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  opened.push(srv);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r/connect`;
    const post = async (body: string, secret: string) => {
      const ts = String(NOW_S);
      const res = await fetch(url, { method: "POST", headers: { "x-route-timestamp": ts, "x-route-signature": signRouteAdmin(body, ts, secret) }, body });
      return res.status;
    };
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push(await post(conn({ label: `l${i}` }), "x".repeat(40)));
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.ok(statuses.slice(5).every((s) => s === 429), "falhas acima do teto => 429");
    // legitima segue passando mesmo com o ip em 429 para assinaturas invalidas, ate o proprio limite (3)
    const ok: number[] = [];
    for (let i = 0; i < 4; i++) ok.push(await post(conn({ label: `ok${i}` }), SECRET_H));
    assert.deepEqual(ok, [200, 200, 200, 429]);
    srv.close(); srv.closeAllConnections();
  });
  it("QA-M4: clientIp usa socket por padrao e X-Forwarded-For so com TRUST_PROXY", () => {
    const req = { socket: { remoteAddress: "10.0.0.1" }, headers: { "x-forwarded-for": "9.9.9.9, 1.2.3.4" } } as unknown as Parameters<typeof clientIp>[0];
    assert.equal(clientIp(req, 0), "10.0.0.1");
    assert.equal(clientIp(req, 1), "1.2.3.4");
    assert.equal(clientIp(req, 2), "9.9.9.9");
  });
});

// tipo usado so para manter RouteSource importado e coberto
export type _Src = RouteSource;
