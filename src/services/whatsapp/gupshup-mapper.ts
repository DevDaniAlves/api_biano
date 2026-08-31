/** Payloads oficiais Gupshup Access API (sessão + inbound v2). Sem fetch. */

export type GupshupEventKind = "message" | "message-event" | "user-event" | "other";

export type ParsedGupshup = {
  kind: GupshupEventKind;
  envelopeType: string;
  phone: string;
  profileName: string | null;
  messageType: string;
  body: string;
  crmType: "text" | "image" | "audio" | "video" | "document";
  externalId: string | null;
  gsId: string | null;
  mediaUrl: string | null;
  mediaFileName: string | null;
  quotedExternalId: string | null;
  status: string | null;
  statusError: string | null;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export function extractGupshupMessageId(data: unknown): string | null {
  if (!isObj(data)) return null;
  const id = data.messageId ?? data.messageid;
  if (typeof id === "string" && id.length > 3) return id;
  const messages = data.messages;
  if (Array.isArray(messages) && messages[0] && typeof messages[0] === "object") {
    const mid = (messages[0] as { id?: unknown }).id;
    if (typeof mid === "string" && mid.length > 3) return mid;
  }
  return null;
}

export function gupshupSubmitOk(data: unknown, httpOk: boolean): boolean {
  if (!httpOk) return false;
  if (!isObj(data)) return true;
  const st = str(data.status).toLowerCase();
  if (st === "error" || st === "failed") return false;
  return true;
}

export function unwrapGupshupBodies(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isObj);
  if (!isObj(body)) return [];
  if (Array.isArray(body.entries)) return body.entries.filter(isObj);
  return [body];
}

export function buildSessionMessage(opts: {
  kind: "text" | "image" | "file" | "audio" | "video" | "location";
  text?: string;
  url?: string;
  caption?: string;
  filename?: string;
  mediaId?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
}): string {
  if (opts.kind === "text") {
    return JSON.stringify({ type: "text", text: opts.text ?? "" });
  }
  if (opts.kind === "location") {
    return JSON.stringify({
      type: "location",
      latitude: opts.latitude,
      longitude: opts.longitude,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.address ? { address: opts.address } : {}),
    });
  }
  if (opts.kind === "image") {
    if (opts.mediaId) {
      return JSON.stringify({
        type: "image",
        id: opts.mediaId,
        ...(opts.caption ? { caption: opts.caption } : {}),
      });
    }
    const url = opts.url ?? "";
    const filename = opts.filename || url.split("/").pop()?.split("?")[0] || "image.jpg";
    return JSON.stringify({
      type: "image",
      caption: opts.caption ?? "",
      originalUrl: url,
      previewUrl: url,
      url,
      filename,
    });
  }
  if (opts.kind === "file") {
    if (opts.mediaId) {
      return JSON.stringify({
        type: "file",
        id: opts.mediaId,
        filename: opts.filename || "file",
        ...(opts.caption ? { caption: opts.caption } : {}),
      });
    }
    return JSON.stringify({
      type: "file",
      url: opts.url ?? "",
      filename: opts.filename || "file",
      ...(opts.caption ? { caption: opts.caption } : {}),
    });
  }
  if (opts.kind === "audio") {
    if (opts.mediaId) {
      return JSON.stringify({ type: "audio", id: opts.mediaId });
    }
    const url = opts.url ?? "";
    const filename = opts.filename || url.split("/").pop()?.split("?")[0] || "audio.mp3";
    return JSON.stringify({
      type: "audio",
      caption: opts.caption ?? "",
      filename,
      url,
    });
  }
  if (opts.mediaId) {
    return JSON.stringify({
      type: "video",
      id: opts.mediaId,
      ...(opts.caption ? { caption: opts.caption } : {}),
    });
  }
  return JSON.stringify({
    type: "video",
    url: opts.url ?? "",
    ...(opts.caption ? { caption: opts.caption } : {}),
  });
}

export function buildTemplateJson(opts: { id: string; params: string[] }): string {
  return JSON.stringify({ id: opts.id, params: opts.params });
}

export function templateParamsFromComponents(components: unknown[] | undefined): string[] {
  if (!Array.isArray(components)) return [];
  for (const c of components) {
    if (!isObj(c)) continue;
    if (str(c.type).toLowerCase() !== "body") continue;
    const parameters = Array.isArray(c.parameters) ? c.parameters : [];
    return parameters.map((p) => (isObj(p) ? str(p.text) : str(p)));
  }
  return [];
}

export function mapGupshupDeliveryStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s === "enqueued") return "queued";
  if (s === "sent") return "sent";
  if (s === "delivered") return "delivered";
  if (s === "read") return "read";
  if (s === "failed" || s === "mismatch") return "failed";
  return s || "unknown";
}

function innerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return isObj(payload.payload) ? payload.payload : {};
}

function interactiveChoiceId(
  payload: Record<string, unknown>,
  inner: Record<string, unknown>
): string {
  const nested = isObj(payload.interactive)
    ? payload.interactive
    : isObj(inner.interactive)
      ? inner.interactive
      : {};
  const button = isObj(inner.button_reply)
    ? inner.button_reply
    : isObj(nested.button_reply)
      ? nested.button_reply
      : {};
  const list = isObj(inner.list_reply)
    ? inner.list_reply
    : isObj(nested.list_reply)
      ? nested.list_reply
      : {};
  const postback =
    str(inner.postbackText) ||
    str(inner.postback) ||
    str(button.id) ||
    str(list.id);
  const rawId = str(inner.id);
  const id = postback || (rawId && rawId.toLowerCase() !== "list" ? rawId : "");
  if (id) return id;
  const title = str(button.title || list.title || inner.title || inner.text);
  const t = title.trim().toLowerCase();
  if (t === "voltar" || t.startsWith("0")) return "0";
  if (t.includes("financeiro")) return "2";
  if (t.includes("atendimento")) return "1";
  return "";
}

export function waTitle(s: string, max = 20) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

/** Converte interactive Meta (button/list) para o JSON da Access API (`/wa/api/v1/msg`). */
export function buildAccessInteractiveMessage(interactive: Record<string, unknown>): string {
  const type = str(interactive.type).toLowerCase();
  const bodyObj = isObj(interactive.body) ? interactive.body : {};
  let bodyText = str(bodyObj.text);
  const footerObj = isObj(interactive.footer) ? interactive.footer : {};
  const footerText = str(footerObj.text);
  if (footerText) {
    bodyText = `${bodyText}\n\n${footerText}`;
  }
  const action = isObj(interactive.action) ? interactive.action : {};

  if (type === "list") {
    const sections = Array.isArray(action.sections) ? action.sections : [];
    const items = sections.map((sec) => {
      const s = isObj(sec) ? sec : {};
      const rows = Array.isArray(s.rows) ? s.rows : [];
      return {
        title: waTitle(str(s.title) || "Opções", 24),
        options: rows.map((row) => {
          const r = isObj(row) ? row : {};
          return {
            type: "text",
            title: waTitle(str(r.title), 24),
            postbackText: str(r.id) || str(r.title),
          };
        }),
      };
    });
    return JSON.stringify({
      type: "list",
      title: waTitle(bodyText, 60) || "Menu",
      body: bodyText,
      msgid: "list",
      globalButtons: [{ type: "text", title: waTitle(str(action.button) || "Ver opções", 20) }],
      items,
    });
  }

  const buttons = Array.isArray(action.buttons) ? action.buttons : [];
  const options = buttons.slice(0, 3).map((b) => {
    const btn = isObj(b) ? b : {};
    const reply = isObj(btn.reply) ? btn.reply : {};
    return {
      title: waTitle(str(reply.title), 20),
      postbackText: str(reply.id) || str(reply.title),
    };
  });
  return JSON.stringify({
    type: "quick_reply",
    content: { type: "text", text: bodyText },
    options,
  });
}

function senderOf(payload: Record<string, unknown>): Record<string, unknown> {
  return isObj(payload.sender) ? payload.sender : {};
}

function crmTypeOf(messageType: string): ParsedGupshup["crmType"] {
  const t = messageType.toLowerCase();
  if (t === "image" || t === "sticker") return "image";
  if (t === "audio") return "audio";
  if (t === "video") return "video";
  if (t === "file" || t === "document") return "document";
  return "text";
}

function emptyParsed(kind: GupshupEventKind, envelopeType: string): ParsedGupshup {
  return {
    kind,
    envelopeType,
    phone: "",
    profileName: null,
    messageType: "",
    body: "",
    crmType: "text",
    externalId: null,
    gsId: null,
    mediaUrl: null,
    mediaFileName: null,
    quotedExternalId: null,
    status: null,
    statusError: null,
  };
}

export function parseGupshupEnvelope(raw: Record<string, unknown>): ParsedGupshup {
  const envelopeType = str(raw.type).toLowerCase();
  const payload = isObj(raw.payload) ? raw.payload : {};
  const inner = innerPayload(payload);
  const sender = senderOf(payload);

  if (envelopeType === "message-event") {
    const gsId = str(payload.gsId || payload.gsid) || null;
    const id = str(payload.id) || null;
    const st = str(payload.type);
    const err =
      str(inner.reason || inner.message || payload.reason || payload.message) || null;
    return {
      ...emptyParsed("message-event", envelopeType),
      phone: str(payload.destination || payload.phone).replace(/\D/g, ""),
      externalId: id || gsId,
      gsId,
      status: mapGupshupDeliveryStatus(st),
      statusError: err && err !== "undefined" ? err : null,
    };
  }

  if (
    envelopeType === "user-event" ||
    envelopeType === "account-event" ||
    envelopeType === "template-event" ||
    envelopeType === "billing-event" ||
    envelopeType === "system-event"
  ) {
    return {
      ...emptyParsed(envelopeType === "user-event" ? "user-event" : "other", envelopeType),
      phone: str(payload.phone || payload.source).replace(/\D/g, ""),
      messageType: str(payload.type),
      body: str(payload.type || envelopeType),
    };
  }

  if (envelopeType !== "message") {
    return emptyParsed("other", envelopeType || "unknown");
  }

  const messageType = str(payload.type || inner.type || "text").toLowerCase();
  const phone = str(payload.source || sender.phone).replace(/\D/g, "");
  const profileName = str(sender.name) || null;
  const wamid = str(payload.id) || null;
  const gsId = str(payload.gsId || payload.gsid) || null;
  const context = isObj(payload.context) ? payload.context : {};
  const quotedExternalId =
    str(context.id || context.gsId || context.gsid) || null;

  let body = "";
  let mediaUrl: string | null = null;
  let mediaFileName: string | null = null;

  if (messageType === "text" || messageType === "quick_reply" || messageType === "button") {
    body =
      interactiveChoiceId(payload, inner) ||
      str(inner.text || payload.text || inner.title || inner.payload);
  } else if (
    messageType === "button_reply" ||
    messageType === "list_reply" ||
    messageType === "list" ||
    messageType === "interactive"
  ) {
    body =
      interactiveChoiceId(payload, inner) ||
      str(inner.title || inner.text) ||
      `[${messageType}]`;
  } else if (messageType === "image" || messageType === "sticker") {
    mediaUrl = str(inner.url || inner.originalUrl || inner.contentUrl) || null;
    body = str(inner.caption || inner.text) || "[imagem]";
  } else if (messageType === "file" || messageType === "document") {
    mediaUrl = str(inner.url || inner.contentUrl) || null;
    mediaFileName = str(inner.name || inner.filename || inner.fileName) || null;
    body = str(inner.caption || inner.text) || mediaFileName || "[documento]";
  } else if (messageType === "audio") {
    mediaUrl = str(inner.url || inner.contentUrl) || null;
    body = "[áudio]";
  } else if (messageType === "video") {
    mediaUrl = str(inner.url || inner.contentUrl) || null;
    body = str(inner.caption || inner.text) || "[vídeo]";
  } else if (messageType === "location") {
    const lat = str(inner.latitude || inner.lat);
    const lng = str(inner.longitude || inner.lng || inner.long);
    body = lat && lng ? `Localização: ${lat}, ${lng}` : "[localização]";
  } else {
    body = str(inner.text || inner.caption || inner.title) || `[${messageType || "mensagem"}]`;
  }

  return {
    kind: "message",
    envelopeType,
    phone,
    profileName,
    messageType,
    body,
    crmType: crmTypeOf(messageType),
    externalId: wamid || gsId,
    gsId,
    mediaUrl,
    mediaFileName,
    quotedExternalId,
    status: null,
    statusError: null,
  };
}
