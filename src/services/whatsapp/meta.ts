import { env } from "../../config.js";
import { prisma } from "../../db.js";

const GRAPH = "https://graph.facebook.com/v21.0";

export type MetaSendResult = {
  ok: boolean;
  status: number;
  data: unknown;
  text: string;
};

export type MetaMessageTemplate = {
  id: string;
  name: string;
  status: string;
  language: string;
  category: string;
  rejectedReason?: string | null;
  components?: unknown[];
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

  async resolveWabaId(): Promise<string> {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    const fromDb = (row?.metaWabaId || "").trim();
    if (fromDb) return fromDb;
    return (env.META_WABA_ID ?? "").trim();
  }

  private headers() {
    return {
      Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  private async graph(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<MetaSendResult> {
    if (!env.META_ACCESS_TOKEN) {
      return { ok: false, status: 0, data: null, text: "Meta não configurada (META_ACCESS_TOKEN)" };
    }
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) console.error("[meta]", method, path, res.status, text.slice(0, 400));
    return { ok: res.ok, status: res.status, data, text };
  }

  async listMessageTemplates() {
    const wabaId = await this.resolveWabaId();
    if (!wabaId) {
      return {
        ok: false as const,
        status: 0,
        data: null,
        text: "META_WABA_ID / metaWabaId ausente",
        templates: [] as MetaMessageTemplate[],
      };
    }
    const r = await this.graph(
      "GET",
      `/${encodeURIComponent(wabaId)}/message_templates?limit=100&fields=name,status,language,category,components,id,rejected_reason`
    );
    const templates: MetaMessageTemplate[] = [];
    if (r.data && typeof r.data === "object") {
      const list = (r.data as { data?: unknown[] }).data;
      if (Array.isArray(list)) {
        for (const row of list) {
          if (!row || typeof row !== "object") continue;
          const t = row as Record<string, unknown>;
          templates.push({
            id: String(t.id ?? ""),
            name: String(t.name ?? ""),
            status: String(t.status ?? ""),
            language: String(t.language ?? ""),
            category: String(t.category ?? ""),
            rejectedReason: t.rejected_reason ? String(t.rejected_reason) : null,
            components: Array.isArray(t.components) ? t.components : [],
          });
        }
      }
    }
    return { ...r, templates };
  }

  async createMessageTemplate(opts: {
    name: string;
    language?: string;
    category?: "UTILITY" | "MARKETING" | "AUTHENTICATION";
    bodyText: string;
    bodyExamples: string[];
  }) {
    const wabaId = await this.resolveWabaId();
    if (!wabaId) {
      return {
        ok: false as const,
        status: 0,
        data: null,
        text: "META_WABA_ID / metaWabaId ausente",
      };
    }
    const name = opts.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const language = (opts.language || env.META_BOLETO_TEMPLATE_LANG || "pt_BR").trim();
    const category = opts.category || "UTILITY";
    const bodyText = opts.bodyText.trim();
    if (!name || !bodyText) {
      return { ok: false as const, status: 0, data: null, text: "name e bodyText obrigatórios" };
    }
    return this.graph("POST", `/${encodeURIComponent(wabaId)}/message_templates`, {
      name,
      language,
      category,
      components: [
        {
          type: "BODY",
          text: bodyText,
          example: { body_text: [opts.bodyExamples.length ? opts.bodyExamples : ["exemplo"]] },
        },
      ],
    });
  }

  async deleteMessageTemplate(name: string) {
    const wabaId = await this.resolveWabaId();
    if (!wabaId) {
      return {
        ok: false as const,
        status: 0,
        data: null,
        text: "META_WABA_ID / metaWabaId ausente",
      };
    }
    const n = name.trim();
    if (!n) {
      return { ok: false as const, status: 0, data: null, text: "name obrigatório" };
    }
    return this.graph(
      "DELETE",
      `/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(n)}`
    );
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
