/** Ring buffer de hits públicos (ngrok / webhook) para diagnóstico. */

export type WebhookHit = {
  at: string;
  path: string;
  method: string;
  event?: string | null;
  from?: string | null;
  preview?: string | null;
  ip?: string | null;
};

const MAX = 30;
const hits: WebhookHit[] = [];

export function recordWebhookHit(hit: Omit<WebhookHit, "at"> & { at?: string }) {
  const row: WebhookHit = {
    at: hit.at ?? new Date().toISOString(),
    path: hit.path,
    method: hit.method,
    event: hit.event ?? null,
    from: hit.from ?? null,
    preview: hit.preview ?? null,
    ip: hit.ip ?? null,
  };
  hits.unshift(row);
  if (hits.length > MAX) hits.length = MAX;
  console.log(
    `[webhook] ${row.method} ${row.path}` +
      (row.event ? ` event=${row.event}` : "") +
      (row.from ? ` from=${row.from}` : "") +
      (row.preview ? ` "${row.preview.slice(0, 60)}"` : "")
  );
  return row;
}

export function listWebhookHits() {
  return [...hits];
}

export function webhookStatusPayload() {
  return {
    ok: true,
    hits: hits.length,
    lastHitAt: hits[0]?.at ?? null,
    lastHit: hits[0] ?? null,
    recent: hits.slice(0, 10),
    tip: "Abra /webhook/ping no ngrok. Se aparecer aqui, o túnel está ok. Webhook Evolution: POST /whatsapp/webhook/evolution",
  };
}
