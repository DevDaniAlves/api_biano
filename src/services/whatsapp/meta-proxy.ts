import { createHmac } from "node:crypto";

export const PROXY_TIMEOUT_MS = 5000;

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
  let host = "(url invalida)";
  try {
    host = new URL(url).host;
  } catch {
    /* mantém placeholder */
  }
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: buildProxyHeaders(incoming, raw, secret),
      body: new Uint8Array(raw),
      signal: ctrl.signal,
    });
    if (!res.ok) console.warn(`[webhook/route] ${host} respondeu ${res.status}`);
  } catch (err) {
    const reason = err instanceof Error ? err.name : "erro";
    console.error(`[webhook/route] falha ao encaminhar para ${host}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
