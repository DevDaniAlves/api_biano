import { env } from "../../config.js";
import { prisma } from "../../db.js";

export class EvolutionClient {
  private baseUrl: string;
  private apiKey: string;
  private instanceFallback: string;

  constructor() {
    this.baseUrl = (env.WHATSAPP_API_URL ?? "").replace(/\/+$/, "");
    this.apiKey = env.WHATSAPP_API_KEY ?? "";
    this.instanceFallback = env.WHATSAPP_INSTANCE ?? "BIANO";
  }

  get credentialsOk() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  get enabled() {
    return this.credentialsOk;
  }

  async resolveInstance(): Promise<string> {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    return row?.instanceName || this.instanceFallback;
  }

  get instanceName() {
    return this.instanceFallback;
  }

  private headers() {
    return { "Content-Type": "application/json", apikey: this.apiKey };
  }

  private async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data, text };
  }

  static toNumber(phone: string) {
    return phone.replace(/\D/g, "");
  }

  static phoneFromJid(jid?: string | null) {
    return (jid || "").split("@")[0].replace(/\D/g, "");
  }

  async sendText(phone: string, text: string) {
    const instance = await this.resolveInstance();
    const number = EvolutionClient.toNumber(phone);
    const r = await this.req("POST", `/message/sendText/${encodeURIComponent(instance)}`, {
      number,
      text,
    });
    if (!r.ok) console.error("[evolution] sendText", r.status, r.text.slice(0, 300));
    return r;
  }

  /** Evolution v2 — imagem/documento via base64 ou URL. */
  async sendMedia(opts: {
    phone: string;
    media: string;
    mimetype: string;
    caption?: string;
    fileName?: string;
    mediatype?: "image" | "document" | "audio" | "video";
  }) {
    const instance = await this.resolveInstance();
    const number = EvolutionClient.toNumber(opts.phone);
    const r = await this.req("POST", `/message/sendMedia/${encodeURIComponent(instance)}`, {
      number,
      mediatype: opts.mediatype ?? "image",
      mimetype: opts.mimetype,
      caption: opts.caption ?? "",
      media: opts.media,
      fileName: opts.fileName ?? "file",
    });
    if (!r.ok) console.error("[evolution] sendMedia", r.status, r.text.slice(0, 300));
    return r;
  }

  async createInstance(instanceName: string) {
    return this.req("POST", "/instance/create", {
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    });
  }

  async connectInstance(instanceName: string) {
    return this.req("GET", `/instance/connect/${encodeURIComponent(instanceName)}`);
  }

  async connectionState(instanceName: string) {
    return this.req("GET", `/instance/connectionState/${encodeURIComponent(instanceName)}`);
  }

  async logoutInstance(instanceName: string) {
    return this.req("DELETE", `/instance/logout/${encodeURIComponent(instanceName)}`);
  }

  async deleteInstance(instanceName: string) {
    return this.req("DELETE", `/instance/delete/${encodeURIComponent(instanceName)}`);
  }
}

export const evolution = new EvolutionClient();
