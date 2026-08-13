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

  async sendText(
    to: string,
    text: string,
    quoted?: {
      id: string;
      fromMe: boolean;
      remoteJid?: string | null;
      body?: string | null;
    } | null
  ) {
    const instance = await this.resolveInstance();
    if (!instance) {
      console.error("[evolution] sendText: nenhuma instância em Conectar WhatsApp");
      return { ok: false, status: 0, data: null, text: "Configure a instância em Conectar WhatsApp" };
    }
    const number = this.sendNumber(to);
    const remoteJid =
      (quoted?.remoteJid && String(quoted.remoteJid)) ||
      `${number}@s.whatsapp.net`;
    const r = await this.req("POST", `/message/sendText/${encodeURIComponent(instance)}`, {
      number,
      text,
      ...(quoted?.id
        ? {
            quoted: {
              key: {
                id: quoted.id,
                fromMe: Boolean(quoted.fromMe),
                remoteJid,
              },
              message: {
                conversation: (quoted.body || " ").slice(0, 500),
              },
            },
          }
        : {}),
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

  async sendWhatsAppAudio(opts: { phone: string; audio: string }) {
    const instance = await this.resolveInstance();
    if (!instance) {
      console.error("[evolution] sendWhatsAppAudio: nenhuma instância em Conectar WhatsApp");
      return { ok: false, status: 0, data: null, text: "Configure a instância em Conectar WhatsApp" };
    }
    const number = this.sendNumber(opts.phone);
    const r = await this.req("POST", `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, {
      number,
      audio: opts.audio,
      encoding: true,
    });
    if (!r.ok) {
      console.error("[evolution] sendWhatsAppAudio", instance, number, r.status, r.text.slice(0, 300));
    } else {
      console.log("[evolution] sendWhatsAppAudio", instance, number, "ok");
    }
    return r;
  }

  async createInstance(instanceName: string, number?: string) {
    return this.req("POST", "/instance/create", {
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      ...(number ? { number } : {}),
    });
  }

  async connectInstance(instanceName: string, number?: string) {
    const q = number ? `?number=${encodeURIComponent(number)}` : "";
    return this.req("GET", `/instance/connect/${encodeURIComponent(instanceName)}${q}`);
  }

  async connectionState(instanceName: string) {
    return this.req("GET", `/instance/connectionState/${encodeURIComponent(instanceName)}`);
  }

  async fetchInstances() {
    return this.req("GET", "/instance/fetchInstances");
  }

  static parseInstanceList(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      for (const key of ["value", "instances", "data", "response"]) {
        if (Array.isArray(o[key])) return o[key] as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  static extractPairingCode(data: unknown): string | null {
    const bag: unknown[] = [];
    if (Array.isArray(data)) bag.push(...data);
    else if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      bag.push(data, o.qrcode, o.response);
      if (Array.isArray(o.response)) bag.push(...o.response);
    }
    for (const item of bag) {
      if (!item || typeof item !== "object") continue;
      const pc = (item as { pairingCode?: unknown }).pairingCode;
      if (typeof pc !== "string") continue;
      const clean = pc.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (clean.length >= 6 && !clean.includes("@")) return clean;
    }
    return null;
  }

  static extractQrBase64(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const o = data as Record<string, unknown>;
    const nested = o.qrcode && typeof o.qrcode === "object" ? (o.qrcode as Record<string, unknown>) : null;
    const qr =
      (typeof o.base64 === "string" && o.base64) ||
      (typeof nested?.base64 === "string" && nested.base64) ||
      (typeof o.qrcode === "string" && o.qrcode) ||
      null;
    return qr || null;
  }

  static extractLiveState(data: unknown): string {
    if (!data || typeof data !== "object") return "";
    const o = data as Record<string, unknown>;
    const inst = (o.instance ?? o.response) as Record<string, unknown> | undefined;
    const nested =
      inst && typeof inst === "object"
        ? String(inst.state ?? inst.connectionStatus ?? inst.status ?? "")
        : "";
    return nested || String(o.state ?? o.connectionStatus ?? o.status ?? "");
  }

  async logoutInstance(instanceName: string) {
    return this.req("DELETE", `/instance/logout/${encodeURIComponent(instanceName)}`);
  }

  async deleteInstance(instanceName: string) {
    return this.req("DELETE", `/instance/delete/${encodeURIComponent(instanceName)}`);
  }

  async getBase64FromMedia(opts: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    message?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }) {
    const instance = await this.resolveInstance();
    if (!instance) {
      return { ok: false, status: 0, data: null, text: "Configure a instância em Conectar WhatsApp" };
    }
    const path = `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`;
    const attempts: unknown[] = [
      {
        message: {
          key: { remoteJid: opts.remoteJid, fromMe: opts.fromMe, id: opts.id },
          ...(opts.message ? { message: opts.message } : {}),
        },
      },
    ];
    if (opts.data) attempts.push({ message: opts.data });
    let last = { ok: false, status: 0, data: null as unknown, text: "" };
    for (const body of attempts) {
      last = await this.req("POST", path, body);
      if (last.ok && EvolutionClient.extractMediaBase64(last.data)) return last;
    }
    return last;
  }

  static extractMediaBase64(data: unknown): { base64: string; mimetype?: string } | null {
    if (!data) return null;
    if (typeof data === "string" && data.length > 80) return { base64: data };
    if (typeof data !== "object") return null;
    const o = data as Record<string, unknown>;
    const nested = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : null;
    const msg = o.message && typeof o.message === "object" ? (o.message as Record<string, unknown>) : null;
    const bags = [o, nested, msg].filter(Boolean) as Record<string, unknown>[];
    for (const bag of bags) {
      const b64 = bag.base64 ?? bag.base64Data;
      if (typeof b64 === "string" && b64.length > 80) {
        return {
          base64: b64,
          mimetype: String(bag.mimetype ?? bag.mimeType ?? o.mimetype ?? nested?.mimetype ?? "") || undefined,
        };
      }
    }
    return null;
  }

  async deleteOwnMessage(remoteJid: string, messageId: string) {
    const instance = await this.resolveInstance();
    if (!instance) {
      return { ok: false, status: 0, data: null, text: "Configure a instância em Conectar WhatsApp" };
    }
    const r = await this.req("DELETE", `/chat/deleteMessageForEveryone/${encodeURIComponent(instance)}`, {
      id: messageId,
      remoteJid,
      fromMe: true,
    });
    if (!r.ok) {
      console.warn("[evolution] deleteMessage", instance, r.status, r.text.slice(0, 200));
    }
    return r;
  }
}

export const evolution = new EvolutionClient();
