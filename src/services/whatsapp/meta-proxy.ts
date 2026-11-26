import { createHmac } from "node:crypto";

export const PROXY_TIMEOUT_MS = 5000;

/** Logs de diagnóstico ligados por padrão; desligar com WA_DIAG_LOG=false. Nunca logar segredos/conteúdo. */
export function diagEnabled(): boolean {
  return (process.env.WA_DIAG_LOG ?? "").trim().toLowerCase() !== "false";
}

/** Mascara identificador de telefone/numero para logs (so os 4 ultimos digitos). */
export function maskId(v: string): string {
  const d = v.replace(/\s/g, "");
  return d.length <= 4 ? "***" : `***${d.slice(-4)}`;
}

const MASKED_DIAG_KEYS = new Set(["phoneNumberId", "displayPhone", "from"]);

export function diagLog(message: string, data: Record<string, unknown> = {}): void {
  if (!diagEnabled()) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) safe[k] = MASKED_DIAG_KEYS.has(k) && typeof v === "string" && v ? maskId(v) : v;
  console.log(`[webhook/meta][diag] ${message} ${JSON.stringify(safe)}`);
}

/** Retorna só o host de uma URL (nunca a URL inteira, pode conter chaves). */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(url invalida)";
  }
}

type Headers = Record<string, string | string[] | undefined>;

/** HMAC-SHA256 hex de "<timestamp>.<corpo>" (formato esperado pelo receptor Caristeo). */
export function signProxyBody(raw: Buffer, timestamp: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), raw]))
    .digest("hex");
}

/** Monta headers do reenvio. Sem segredo, não adiciona assinatura de proxy. */
export function buildProxyHeaders(
  incoming: Headers,
  raw: Buffer,
  secret: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000)
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const k of ["x-hub-signature-256", "x-hub-signature", "user-agent"]) {
    const v = incoming[k];
    if (typeof v === "string") headers[k] = v;
  }
  if (secret) {
    const ts = String(nowSec);
    headers["x-wa-proxy-timestamp"] = ts;
    headers["x-wa-proxy-signature"] = signProxyBody(raw, ts, secret);
  }
  return headers;
}

/** Reenvia os bytes originais. Nunca lança; loga sem corpo/segredos. */
export async function forwardRawMetaWebhook(
  url: string,
  raw: Buffer,
  incoming: Headers,
  secret: string | undefined = process.env.WA_PROXY_SHARED_SECRET?.trim() || undefined,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  const host = safeHost(url);
  const started = Date.now();
  diagLog("forward: iniciando", { host, proxySecretSet: Boolean(secret), bytes: raw.length });
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: buildProxyHeaders(incoming, raw, secret),
      body: new Uint8Array(raw),
      redirect: "manual", // rota externa: nunca seguir redirecionamento (SSRF)
      signal: ctrl.signal,
    });
    diagLog("forward: resposta", { host, status: res.status, ok: res.ok, ms: Date.now() - started });
    if (res.status >= 300 && res.status < 400) console.error(`[webhook/route] ${host} respondeu redirecionamento ${res.status}: recusado`);
    else if (!res.ok) console.warn(`[webhook/route] ${host} respondeu ${res.status}`);
  } catch (err) {
    const reason = err instanceof Error ? err.name : "erro";
    diagLog("forward: erro", { host, error: reason, timeout: reason === "AbortError", ms: Date.now() - started });
    console.error(`[webhook/route] falha ao encaminhar para ${host}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
