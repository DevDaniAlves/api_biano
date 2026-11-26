import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Router, raw, type Request, type Response } from "express";
import { prisma } from "../db.js";
import { maskId } from "../services/whatsapp/meta-proxy.js";

/**
 * Rotas administrativas servidor-a-servidor para CONECTAR/EXCLUIR repasse de webhook da Meta para sistemas
 * externos. Isoladas do fluxo interno: so tocam WhatsAppWebhookRoute, so linhas com `source` externo.
 */

export const ROUTE_SOURCES = ["caristeo-healthcare", "delivery-caristeo"] as const;
export type RouteSource = (typeof ROUTE_SOURCES)[number];
export const LEGACY_PHONE_DISPLAY = "556634016000";
/** phone_number_id interno conhecido (src/scripts/set-meta-ids.ts). Alem disso: env e tabela WhatsAppConnection. */
export const KNOWN_INTERNAL_PHONE_IDS = [LEGACY_PHONE_DISPLAY, "1236714352864758"];
export const REQUIRED_PATH = "/functions/v1/whatsapp";
export const REPLAY_WINDOW_SEC = 300;
export const MAX_BODY_BYTES = 4096;
export const MIN_SECRET_LENGTH = 32;

const SECRET_ENV: Record<RouteSource, string> = {
  "caristeo-healthcare": "WA_ROUTE_ADMIN_SECRET_CARISTEO_HEALTHCARE",
  "delivery-caristeo": "WA_ROUTE_ADMIN_SECRET_DELIVERY_CARISTEO",
};
const ALLOWED_IDS_ENV: Record<RouteSource, string> = {
  "caristeo-healthcare": "WA_ROUTE_ALLOWED_PHONE_IDS_CARISTEO_HEALTHCARE",
  "delivery-caristeo": "WA_ROUTE_ALLOWED_PHONE_IDS_DELIVERY_CARISTEO",
};

export interface RouteRow {
  phoneNumberId: string;
  displayPhone: string | null;
  targetUrl: string;
  active: boolean;
  label: string | null;
  source: string | null;
  connectedAt: Date | null;
  deletedAt: Date | null;
}

export interface ConnectInput {
  phoneNumberId: string;
  displayPhone: string | null;
  targetUrl: string;
  label: string | null;
  source: RouteSource;
}

export interface RouteStore {
  find(phoneNumberId: string): Promise<RouteRow | null>;
  /** Atomico: cria, ou atualiza SOMENTE se a linha ja pertence ao mesmo source. "conflict" = outro dono / sem dono. */
  connect(row: ConnectInput): Promise<"ok" | "conflict">;
  /** Atomico: soft delete SOMENTE se a linha pertence ao source. Retorna linhas afetadas. */
  softDelete(phoneNumberId: string, source: RouteSource): Promise<number>;
  /** phone_number_id/numeros de configuracao interna do Biano (falha => erro => fail closed). */
  internalPhoneIds(): Promise<string[]>;
}

export interface RouteAdminConfig {
  /** Segredo por source (so validos: >= 32 chars e distintos). Ausente = 503 para o source. */
  secrets: Partial<Record<RouteSource, string>>;
  /** Hosts EXATOS permitidos. */
  allowedHosts: string[];
  /** Lista contem wildcard/entrada invalida => falha fechada. */
  hostsInvalid?: boolean;
  /** Blocklist de IDs internos (env). Soma-se a KNOWN_INTERNAL_PHONE_IDS e ao banco. */
  internalPhoneIds: string[];
  /** Allowlist opcional por source. Definida => so esses IDs. */
  allowedPhoneIds: Partial<Record<RouteSource, string[]>>;
  now: () => number; // ms
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RouteAdminConfig {
  const raw: Partial<Record<RouteSource, string>> = {};
  for (const s of ROUTE_SOURCES) {
    const v = env[SECRET_ENV[s]]?.trim();
    if (v && v.length >= MIN_SECRET_LENGTH) raw[s] = v;
  }
  const secrets = { ...raw };
  // Segredos iguais entre sources anulariam a separacao: ambos invalidos.
  if (raw["caristeo-healthcare"] && raw["caristeo-healthcare"] === raw["delivery-caristeo"]) {
    delete secrets["caristeo-healthcare"];
    delete secrets["delivery-caristeo"];
  }
  const hosts = csv(env.WA_ROUTE_ALLOWED_HOSTS);
  const allowedPhoneIds: RouteAdminConfig["allowedPhoneIds"] = {};
  for (const s of ROUTE_SOURCES) {
    const l = csv(env[ALLOWED_IDS_ENV[s]]);
    if (l.length) allowedPhoneIds[s] = l;
  }
  return {
    secrets,
    allowedHosts: hosts,
    hostsInvalid: hosts.some((h) => !HOST_RE.test(h)),
    internalPhoneIds: [...csv(env.WA_ROUTE_INTERNAL_PHONE_IDS), ...csv(env.META_PHONE_NUMBER_ID)],
    allowedPhoneIds,
    now: () => Date.now(),
  };
}

export function signRouteAdmin(rawBody: Buffer | string, timestamp: string, secret: string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest("hex");
}

export function verifySignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  nowMs: number
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > REPLAY_WINDOW_SEC) return false;
  const expected = Buffer.from(signRouteAdmin(rawBody, timestamp, secret), "utf8");
  const got = Buffer.from(signature.trim().toLowerCase(), "utf8");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|localdomain|lan|home|corp|intranet)$/;
const BLOCKED_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data"]);

/** Somente host exato (sem wildcard). */
export function hostMatches(host: string, allowed: string[]): boolean {
  return allowed.includes(host);
}

/** Valida targetUrl. Retorna URL normalizada ou mensagem de erro. */
export function validateTargetUrl(
  input: unknown,
  allowedHosts: string[]
): { ok: true; url: string; host: string } | { ok: false; error: string } {
  if (typeof input !== "string" || input.length === 0 || input.length > 300) {
    return { ok: false, error: "targetUrl invalida" };
  }
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "targetUrl invalida" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "targetUrl deve usar https" };
  if (u.username || u.password) return { ok: false, error: "targetUrl nao pode ter credenciais" };
  if (u.port && u.port !== "443") return { ok: false, error: "targetUrl nao pode ter porta" };
  if (u.search || u.hash) return { ok: false, error: "targetUrl nao pode ter query/fragmento" };
  const host = u.hostname.toLowerCase();
  if (isIP(host) || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return { ok: false, error: "host nao pode ser IP" };
  }
  if (BLOCKED_NAMES.has(host) || BLOCKED_HOST.test(host) || !host.includes(".")) {
    return { ok: false, error: "host proibido" };
  }
  if (!hostMatches(host, allowedHosts)) return { ok: false, error: "host nao permitido" };
  if (u.pathname !== REQUIRED_PATH) return { ok: false, error: `path deve ser ${REQUIRED_PATH}` };
  return { ok: true, url: `https://${host}${REQUIRED_PATH}`, host };
}

const PHONE_ID_RE = /^\d{5,30}$/;

function log(msg: string, data: Record<string, unknown> = {}): void {
  console.log(`[wa-route-admin] ${msg} ${JSON.stringify(data)}`);
}

export interface AdminResult {
  status: number;
  body: Record<string, unknown>;
}
const fail = (status: number, error: string): AdminResult => ({ status, body: { error } });

function parseJson(rawBody: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(rawBody.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ids que nunca podem virar rota externa: blocklist (codigo + env + banco). */
async function isInternal(cfg: RouteAdminConfig, store: RouteStore, ...ids: (string | null)[]): Promise<boolean> {
  const set = new Set<string>([...KNOWN_INTERNAL_PHONE_IDS, ...cfg.internalPhoneIds, ...(await store.internalPhoneIds())]);
  return ids.some((i) => i !== null && i !== "" && set.has(i));
}

export async function handleConnect(
  cfg: RouteAdminConfig, store: RouteStore, b: Record<string, unknown>, source: RouteSource
): Promise<AdminResult> {
  if (cfg.allowedHosts.length === 0 || cfg.hostsInvalid) return fail(503, "Servico nao configurado");
  const phoneNumberId = b.phoneNumberId;
  if (typeof phoneNumberId !== "string" || !PHONE_ID_RE.test(phoneNumberId)) {
    return fail(400, "phoneNumberId invalido");
  }
  let displayPhone: string | null = null;
  if (b.displayPhone != null) {
    if (typeof b.displayPhone !== "string") return fail(400, "displayPhone invalido");
    displayPhone = b.displayPhone.replace(/\D/g, "") || null;
    if (displayPhone && displayPhone.length > 20) return fail(400, "displayPhone invalido");
  }
  let label: string | null = null;
  if (b.label != null) {
    if (typeof b.label !== "string" || b.label.length > 100) return fail(400, "label invalido");
    label = b.label.trim() || null;
  }
  if (await isInternal(cfg, store, phoneNumberId, displayPhone)) return fail(403, "Numero reservado");
  const allow = cfg.allowedPhoneIds[source];
  if (allow && !allow.includes(phoneNumberId)) return fail(403, "Numero nao autorizado para este sistema");
  const t = validateTargetUrl(b.targetUrl, cfg.allowedHosts);
  if (!t.ok) return fail(400, t.error);

  const r = await store.connect({ phoneNumberId, displayPhone, targetUrl: t.url, label, source });
  if (r === "conflict") return fail(409, "Numero pertence a outro sistema");
  log("connect", { source, targetHost: t.host, phoneNumberId: maskId(phoneNumberId) });
  return { status: 200, body: { ok: true, status: "connected", phoneNumberId, targetHost: t.host } };
}

export async function handleDisconnect(
  cfg: RouteAdminConfig, store: RouteStore, b: Record<string, unknown>, source: RouteSource, pathId: string
): Promise<AdminResult> {
  if (!PHONE_ID_RE.test(pathId)) return fail(400, "phoneNumberId invalido");
  // O id da URL nao e coberto pela assinatura: exigir o mesmo valor dentro do corpo assinado.
  if (b.phoneNumberId !== pathId) return fail(400, "phoneNumberId divergente");
  const existing = await store.find(pathId);
  if (await isInternal(cfg, store, pathId, existing?.displayPhone ?? null)) return fail(403, "Numero reservado");
  if (!existing) return { status: 200, body: { ok: true, status: "absent", phoneNumberId: pathId } };
  if (existing.source !== source) return fail(409, "Numero pertence a outro sistema");
  if (!existing.active) return { status: 200, body: { ok: true, status: "already_disconnected", phoneNumberId: pathId } };
  const n = await store.softDelete(pathId, source);
  if (n === 0) return fail(409, "Numero pertence a outro sistema");
  log("disconnect", { source, phoneNumberId: maskId(pathId) });
  return { status: 200, body: { ok: true, status: "disconnected", phoneNumberId: pathId } };
}

const SELECT = {
  phoneNumberId: true, displayPhone: true, targetUrl: true, active: true,
  label: true, source: true, connectedAt: true, deletedAt: true,
} as const;

export const prismaRouteStore: RouteStore = {
  async find(phoneNumberId) {
    return prisma.whatsAppWebhookRoute.findUnique({ where: { phoneNumberId }, select: SELECT });
  },
  async connect(r) {
    const now = new Date();
    try {
      await prisma.whatsAppWebhookRoute.create({
        data: {
          phoneNumberId: r.phoneNumberId, displayPhone: r.displayPhone, targetUrl: r.targetUrl,
          label: r.label, source: r.source, active: true, connectedAt: now,
        },
      });
      return "ok";
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
    // Ja existe: so o mesmo source (inclusive linha com soft delete) pode atualizar. Condicao no proprio UPDATE.
    const { count } = await prisma.whatsAppWebhookRoute.updateMany({
      where: { phoneNumberId: r.phoneNumberId, source: r.source },
      data: {
        displayPhone: r.displayPhone, targetUrl: r.targetUrl, label: r.label, active: true,
        connectedAt: now, deletedAt: null, deletedBy: null,
      },
    });
    return count > 0 ? "ok" : "conflict";
  },
  async softDelete(phoneNumberId, source) {
    const { count } = await prisma.whatsAppWebhookRoute.updateMany({
      where: { phoneNumberId, source },
      data: { active: false, deletedAt: new Date(), deletedBy: source },
    });
    return count;
  },
  async internalPhoneIds() {
    const rows = await prisma.whatsAppConnection.findMany({ select: { metaPhoneNumberId: true } });
    return rows.map((r) => (r.metaPhoneNumberId ?? "").trim()).filter(Boolean);
  },
};

/** Rate limit em memoria (janela fixa; com backoff opcional: cada estouro dobra a janela, ate 15 min). */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now, backoff = false) {
  const hits = new Map<string, { n: number; reset: number; strikes: number }>();
  return (key: string): boolean => {
    const t = now();
    const cur = hits.get(key);
    if (!cur || cur.reset <= t) {
      if (hits.size >= 5000) hits.delete(hits.keys().next().value as string); // descarta o mais antigo, nunca zera tudo
      hits.set(key, { n: 1, reset: t + windowMs, strikes: cur?.strikes ?? 0 });
      return true;
    }
    cur.n += 1;
    if (cur.n <= max) return true;
    if (backoff && cur.n === max + 1) {
      cur.strikes += 1;
      cur.reset = t + Math.min(windowMs * 2 ** cur.strikes, 15 * 60_000);
    }
    return false;
  };
}

/** IP do cliente. Padrao seguro: endereco do socket. Atras de proxy, TRUST_PROXY=<n saltos> usa o X-Forwarded-For. */
export function clientIp(req: Request, trustHops: number = Number(process.env.TRUST_PROXY ?? 0) || 0): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (trustHops <= 0) return socketIp;
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - trustHops] ?? socketIp;
}

export interface RouterDeps {
  getConfig: () => RouteAdminConfig;
  store: RouteStore;
  /** Limite das requisicoes AUTENTICADAS, por source|ip. */
  rateLimit?: (key: string) => boolean;
  /** Limite das falhas de autenticacao, por ip|source declarado (teto maior, com backoff). */
  failLimit?: (key: string) => boolean;
  trustHops?: number;
}

/** Montar ANTES do express.json global: usa corpo bruto com limite proprio. */
export function createRouteAdminRouter(deps: RouterDeps): Router {
  const router = Router();
  const okLimit = deps.rateLimit ?? createRateLimiter(30, 60_000);
  const badLimit = deps.failLimit ?? createRateLimiter(60, 60_000, Date.now, true);
  // Respostas ja processadas por assinatura (replay dentro da janela devolve o mesmo resultado, sem reexecutar).
  const seen = new Map<string, AdminResult & { exp: number }>();
  router.use(raw({ type: () => true, limit: MAX_BODY_BYTES }));

  const hdr = (req: Request, k: string): string | undefined => {
    const v = req.headers[k];
    return typeof v === "string" ? v : undefined;
  };

  async function process(
    req: Request, body: Buffer,
    action: (cfg: RouteAdminConfig, b: Record<string, unknown>, source: RouteSource) => Promise<AdminResult>
  ): Promise<{ result: AdminResult; retryAfter?: number }> {
    const cfg = deps.getConfig();
    const ip = clientIp(req, deps.trustHops);
    const parsed = parseJson(body);
    const src = typeof parsed?.source === "string" && (ROUTE_SOURCES as readonly string[]).includes(parsed.source)
      ? (parsed.source as RouteSource) : null;
    const authFail = (): { result: AdminResult; retryAfter?: number } =>
      badLimit(`${ip}|${src ?? "?"}`) ? { result: fail(401, "Assinatura invalida") } : { result: fail(429, "Muitas requisicoes"), retryAfter: 60 };
    if (!src || !parsed) return authFail();
    const secret = cfg.secrets[src];
    if (!secret) return { result: fail(503, "Servico nao configurado") };
    const ts = hdr(req, "x-route-timestamp");
    const sig = hdr(req, "x-route-signature");
    if (!verifySignature(body, ts, sig, secret, cfg.now())) return authFail();
    const key = `${req.path}|${String(sig).trim().toLowerCase()}`; // o id da URL nao e assinado: entra na chave
    const nowMs = cfg.now();
    const cached = seen.get(key);
    if (cached && cached.exp > nowMs) return { result: { status: cached.status, body: cached.body } };
    if (!okLimit(`${src}|${ip}`)) return { result: fail(429, "Muitas requisicoes"), retryAfter: 60 };
    const result = await action(cfg, parsed, src);
    if (result.status < 500) {
      if (seen.size >= 5000) seen.delete(seen.keys().next().value as string);
      seen.set(key, { ...result, exp: nowMs + REPLAY_WINDOW_SEC * 1000 });
    }
    return { result };
  }

  const run = (action: (req: Request) => (cfg: RouteAdminConfig, b: Record<string, unknown>, s: RouteSource) => Promise<AdminResult>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const { result, retryAfter } = await process(req, body, action(req));
        if (result.status >= 400 && result.status !== 409 && result.status !== 401 && result.status !== 429) {
          log("rejeitado", { status: result.status });
        }
        if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
        res.status(result.status).json(result.body);
      } catch (err) {
        console.error("[wa-route-admin] erro", err instanceof Error ? err.name : "erro");
        res.status(500).json({ error: "Erro interno" });
      }
    };

  router.post("/connect", run(() => (cfg, b, s) => handleConnect(cfg, deps.store, b, s)));
  router.post("/disconnect/:phoneNumberId", run((req) => (cfg, b, s) =>
    handleDisconnect(cfg, deps.store, b, s, String(req.params.phoneNumberId))));
  // Erros do parser (corpo grande demais etc.)
  router.use((err: { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res.status(err.status === 413 ? 413 : 400).json({ error: "Corpo invalido" });
  });
  return router;
}

export const routeAdminRouter = createRouteAdminRouter({
  getConfig: configFromEnv,
  store: prismaRouteStore,
});
