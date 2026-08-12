import { env } from "../../config.js";
import { prisma } from "../../db.js";

const GRAPH = "https://graph.facebook.com/v21.0";

export type MetaSendResult = {
  ok: boolean;
  status: number;
  data: unknown;
  text: string;
};

export class MetaClient {
  get enabled() {
    return Boolean(env.META_ACCESS_TOKEN);
  }

  /** Prefer ID salvo na connection; senão .env. */
  async resolvePhoneNumberId(): Promise<string> {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    const fromDb = (row?.metaPhoneNumberId || "").trim();
    if (fromDb) return fromDb;
    return (env.META_PHONE_NUMBER_ID ?? "").trim();
  }

  private headers() {
    return {
      Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Normaliza E.164 só dígitos.
   * BR: wa_id às vezes vem sem o 9º dígito (12 chars) → Meta allow list espera 13 (55+DDD+9+8).
   */
  static toNumber(phone: string) {
    let n = phone.replace(/\D/g, "");
    if (n.startsWith("55") && n.length === 12) {
      n = `${n.slice(0, 4)}9${n.slice(4)}`;
    }
    return n;
  }

  static extractMessageId(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const root = data as Record<string, unknown>;
    const messages = root.messages;
    if (Array.isArray(messages) && messages[0] && typeof messages[0] === "object") {
      const id = (messages[0] as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 4) return id;
    }
    if (typeof root.id === "string" && root.id.length > 4) return root.id;
    return null;
  }

  private async req(body: Record<string, unknown>): Promise<MetaSendResult> {
    const phoneNumberId = await this.resolvePhoneNumberId();
    if (!phoneNumberId || !env.META_ACCESS_TOKEN) {
      return {
        ok: false,
        status: 0,
        data: null,
        text: "Meta não configurada (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID)",
      };
    }
    const res = await fetch(`${GRAPH}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      console.error("[meta] send", res.status, text.slice(0, 400));
    } else {
      console.log("[meta] send ok", body.to, "id=", MetaClient.extractMessageId(data) ?? "-");
    }
    return { ok: res.ok, status: res.status, data, text };
  }

  async sendText(to: string, text: string) {
    return this.req({
      to: MetaClient.toNumber(to),
      type: "text",
      text: { preview_url: false, body: text },
    });
  }

  async sendTemplate(opts: {
    to: string;
    name: string;
    language?: string;
    components?: unknown[];
  }) {
    return this.req({
      to: MetaClient.toNumber(opts.to),
      type: "template",
      template: {
        name: opts.name,
        language: { code: opts.language ?? env.META_BOLETO_TEMPLATE_LANG },
        ...(opts.components?.length ? { components: opts.components } : {}),
      },
    });
  }

  async sendMediaLink(opts: {
    to: string;
    mediatype: "image" | "document" | "audio" | "video";
    link: string;
    caption?: string;
    fileName?: string;
  }) {
    const type = opts.mediatype;
    const payload: Record<string, unknown> = { link: opts.link };
    if (opts.caption && type !== "audio") payload.caption = opts.caption;
    if (type === "document" && opts.fileName) payload.filename = opts.fileName;
    return this.req({
      to: MetaClient.toNumber(opts.to),
      type,
      [type]: payload,
    });
  }

  /** Troca code OAuth do Embedded Signup por access_token. */
  async exchangeCode(code: string) {
    if (!env.META_APP_ID || !env.META_APP_SECRET) {
      return { ok: false as const, error: "META_APP_ID / META_APP_SECRET ausentes" };
    }
    const url = new URL(`${GRAPH}/oauth/access_token`);
    url.searchParams.set("client_id", env.META_APP_ID);
    url.searchParams.set("client_secret", env.META_APP_SECRET);
    url.searchParams.set("code", code);
    const res = await fetch(url.toString());
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      return { ok: false as const, error: text.slice(0, 500), data };
    }
    const token =
      data && typeof data === "object"
        ? String((data as { access_token?: string }).access_token ?? "")
        : "";
    return { ok: true as const, accessToken: token || null, data };
  }
}

export const meta = new MetaClient();
