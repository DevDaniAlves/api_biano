import { env } from "../../config.js";
import { prisma } from "../../db.js";

export class EvolutionClient {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = (env.WHATSAPP_API_URL ?? "").replace(/\/+$/, "");
    this.apiKey = env.WHATSAPP_API_KEY ?? "";
  }

  get credentialsOk() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  get enabled() {
    return this.credentialsOk;
  }

  /** Sempre a instância salva em Conectar WhatsApp. */
  async resolveInstance(): Promise<string> {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    return (row?.instanceName || "").trim();
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
    if (!jid || jid.includes("@lid") || jid.includes("@g.us") || jid.includes("broadcast")) {
      return "";
    }
    return jid.split("@")[0].replace(/\D/g, "");
  }

  /** Telefone + JID de resposta = o mesmo que o WhatsApp usou nesta mensagem. */
  static identityFromKey(key: Record<string, unknown>, data?: Record<string, unknown>) {
    const remoteJid = String(key.remoteJid ?? "");
    const remoteJidAlt = String(key.remoteJidAlt ?? "");
    const senderPn = String(
      key.senderPn ?? data?.senderPn ?? data?.sender_pn ?? key.sender_pn ?? ""
    );
    const jids = [remoteJid, remoteJidAlt].filter(Boolean);
    const lidJid = jids.find((j) => j.includes("@lid")) ?? "";
    const pnJid =
      jids.find((j) => j.includes("@s.whatsapp.net")) ||
      (senderPn ? `${String(senderPn).replace(/\D/g, "")}@s.whatsapp.net` : "");
    const phone =
      EvolutionClient.phoneFromJid(pnJid) || EvolutionClient.toNumber(senderPn);
    const sendJid = remoteJid || pnJid || lidJid;
    return { phone, sendJid, lidJid, pnJid, remoteJid, remoteJidAlt };
  }

  private sendNumber(to: string) {
    const trimmed = to.trim();
    if (trimmed.includes("@")) return trimmed;
    return EvolutionClient.toNumber(trimmed);
  }

  /** Extrai o id da mensagem na resposta do send (vários formatos Evolution). */
  static extractMessageId(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const root = data as Record<string, unknown>;
    const candidates: unknown[] = [
      root,
      root.data,
      root.message,
      (root.data as Record<string, unknown> | undefined)?.key,
      (root.key as Record<string, unknown> | undefined),
    ];
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const key = o.key;
      if (key && typeof key === "object" && (key as { id?: unknown }).id) {
        return String((key as { id: unknown }).id);
      }
      if (typeof o.id === "string" && o.id.length > 8) return o.id;
      if (typeof o.messageId === "string") return o.messageId;
    }
    return null;
  }

  async sendText(to: string, text: string) {
    const instance = await this.resolveInstance();
    if (!instance) {
      console.error("[evolution] sendText: nenhuma instância em Conectar WhatsApp");
      return { ok: false, status: 0, data: null, text: "Configure a instância em Conectar WhatsApp" };
    }
    const number = this.sendNumber(to);
    const r = await this.req("POST", `/message/sendText/${encodeURIComponent(instance)}`, {
      number,
      text,
    });
    if (!r.ok) {
      console.error("[evolution] sendText", instance, number, r.status, r.text.slice(0, 300));
    } else {
      const d = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
      console.log(
        "[evolution] sendText",
        instance,
        number,
        "ok",
        "status=",
        d.status ?? d.messageStatus ?? "-",
        "id=",
        EvolutionClient.extractMessageId(r.data) ?? "-"
      );
    }
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
    if (!instance) {
      console.error("[evolution] sendMedia: nenhuma instância em Conectar WhatsApp");
      return { ok: false, status: 0, data: null, text: "Configure a instância em Conectar WhatsApp" };
    }
    const number = this.sendNumber(opts.phone);
    const r = await this.req("POST", `/message/sendMedia/${encodeURIComponent(instance)}`, {
      number,
      mediatype: opts.mediatype ?? "image",
      mimetype: opts.mimetype,
      caption: opts.caption ?? "",
      media: opts.media,
      fileName: opts.fileName ?? "file",
    });
    if (!r.ok) console.error("[evolution] sendMedia", instance, number, r.status, r.text.slice(0, 300));
    else console.log("[evolution] sendMedia", instance, number, "ok");
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
