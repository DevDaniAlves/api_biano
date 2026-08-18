import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import {
  buildSessionMessage,
  buildTemplateJson,
  extractGupshupMessageId,
  gupshupSubmitOk,
  isRetryableStatus,
} from "./gupshup-mapper.js";

export type GupshupSendResult = {
  ok: boolean;
  status: number;
  data: unknown;
  text: string;
};

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 25_000;

/** Body no formato do curl Gupshup (`src.name` sem encode no nome do campo). */
function encodeForm(fields: Array<[string, string]>): string {
  return fields
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, "+")}`)
    .join("&");
}

function uploadsDir() {
  return path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), "uploads"));
}

function mimeExt(mimetype?: string | null, fileName?: string | null) {
  const fromName = fileName?.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const m = (mimetype || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("mp4") || m.includes("video")) return "mp4";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") && m.includes("audio")) return "mp3";
  if (m.includes("audio")) return "ogg";
  return "bin";
}

export function toPublicMediaUrl(link?: string | null): string | null {
  const raw = (link || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = env.API_PUBLIC_URL.replace(/\/+$/, "");
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${p}`;
}

export function persistBase64Upload(opts: {
  base64: string;
  fileName?: string;
  mimetype?: string;
}): string | null {
  const raw = opts.base64.replace(/^data:[^;]+;base64,/, "");
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length < 40) return null;
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${mimeExt(
    opts.mimetype,
    opts.fileName
  )}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/uploads/${name}`;
}

export class GupshupClient {
  get enabled() {
    return Boolean(
      (env.GUPSHUP_API_KEY || "").trim() &&
        (env.GUPSHUP_APP_NAME || "").trim() &&
        (env.GUPSHUP_SOURCE || "").replace(/\D/g, "")
    );
  }

  private get apiKey() {
    return (env.GUPSHUP_API_KEY || "").trim();
  }

  private get baseUrl() {
    return (env.GUPSHUP_API_BASE_URL || "https://api.gupshup.io").replace(/\/+$/, "");
  }

  async credentials(): Promise<{ apiKey: string; appName: string; source: string; appId: string }> {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    const appName =
      (env.GUPSHUP_APP_NAME || "").trim() || (row?.gupshupAppName || "").trim();
    const source = (
      (env.GUPSHUP_SOURCE || "").trim() ||
      (row?.gupshupSource || "").trim()
    ).replace(/\D/g, "");
    const appId = (env.GUPSHUP_APP_ID || "").trim();
    return { apiKey: this.apiKey, appName, source, appId };
  }

  async isConfigured() {
    const c = await this.credentials();
    if (c.appId) return Boolean(c.apiKey && c.source);
    return Boolean(c.apiKey && c.appName && c.source);
  }

  private async postForm(
    pathName: string,
    fields: Record<string, string>
  ): Promise<GupshupSendResult> {
    if (!this.apiKey) {
      return { ok: false, status: 0, data: null, text: "Gupshup não configurada (GUPSHUP_API_KEY)" };
    }

    const url = `${this.baseUrl}${pathName}`;
    const ordered: Array<[string, string]> = [];
    const add = (k: string, v?: string) => {
      if (v) ordered.push([k, v]);
    };
    add("channel", fields.channel ?? "whatsapp");
    add("source", fields.source);
    add("destination", fields.destination);
    add("message", fields.message);
    add("src.name", fields["src.name"]);
    add("template", fields.template);
    const body = encodeForm(ordered);
    const key = this.apiKey;
    const headers: Record<string, string> = {
      apikey: key,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    };
    // Token de app ACP (sk_…) também vai em Authorization; a Access API usa apikey da conta.
    if (key.startsWith("sk_")) headers.Authorization = key;

    let last: GupshupSendResult = { ok: false, status: 0, data: null, text: "sem resposta" };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text().catch(() => "");
        let data: unknown = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        last = { ok: res.ok, status: res.status, data, text };
        // 200 submitted: nunca retry (duplicaria). Retry só 429/502/503/504.
        if (res.ok || !isRetryableStatus(res.status)) {
          if (!res.ok) {
            console.error(
              "[gupshup]",
              pathName,
              res.status,
              text.slice(0, 400),
              "src.name=",
              fields["src.name"] || "(vazio)",
              "source=",
              fields.source || "(vazio)",
              "key=",
              key.startsWith("sk_") ? "sk_ (token de app — Access API pede apikey da conta no perfil)" : "account"
            );
          }
          return last;
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        last = { ok: false, status: 0, data: null, text: msg };
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          continue;
        }
        console.error("[gupshup]", pathName, msg);
        return last;
      }
    }
    return last;
  }

  /** Apps FBC/Live (Settings → App ID + API key do app). */
  private async postFbc(to: string, payload: Record<string, unknown>): Promise<GupshupSendResult> {
    const appId = (env.GUPSHUP_APP_ID || "").trim();
    if (!this.apiKey || !appId) {
      return {
        ok: false,
        status: 0,
        data: null,
        text: "Gupshup FBC: defina GUPSHUP_API_KEY (Settings do app) e GUPSHUP_APP_ID",
      };
    }
    const urls = [
      `https://partner.gupshup.io/partner/app/${appId}/v3/message`,
      `${this.baseUrl}/wa/app/${appId}/v3/message`,
    ];
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      ...payload,
    });
    let last: GupshupSendResult = { ok: false, status: 0, data: null, text: "sem resposta" };
    for (const url of urls) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: this.apiKey,
              "Content-Type": "application/json",
              "Cache-Control": "no-cache",
            },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const text = await res.text().catch(() => "");
          let data: unknown = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text;
          }
          last = { ok: res.ok, status: res.status, data, text };
          if (res.ok) return last;
          if (!isRetryableStatus(res.status)) break;
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          last = { ok: false, status: 0, data: null, text: msg };
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
            continue;
          }
        }
      }
    }
    console.error(
      "[gupshup] fbc/v3",
      last.status,
      last.text.slice(0, 400),
      "appId=",
      appId,
      "to=",
      to
    );
    return last;
  }

  private async sendSession(
    to: string,
    formMessage: string,
    fbcPayload: Record<string, unknown>
  ): Promise<GupshupSendResult> {
    if ((env.GUPSHUP_APP_ID || "").trim()) {
      return this.postFbc(to, fbcPayload);
    }
    if (this.apiKey.startsWith("sk_")) {
      console.warn(
        "[gupshup] key do Settings (sk_) sem GUPSHUP_APP_ID — app FBC não usa /wa/api/v1/msg"
      );
    }
    const fields = await this.sessionFields(to, formMessage);
    return this.postForm("/wa/api/v1/msg", fields);
  }

  private async sessionFields(destination: string, message: string) {
    const c = await this.credentials();
    return {
      channel: "whatsapp",
      source: c.source,
      destination,
      "src.name": c.appName,
      message,
    };
  }

  async sendText(to: string, text: string): Promise<GupshupSendResult> {
    return this.sendSession(to, buildSessionMessage({ kind: "text", text }), {
      type: "text",
      text: { body: text },
    });
  }

  async sendImage(opts: {
    to: string;
    url: string;
    caption?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({ kind: "image", url: opts.url, caption: opts.caption }),
      {
        type: "image",
        image: { link: opts.url, ...(opts.caption ? { caption: opts.caption } : {}) },
      }
    );
  }

  async sendFile(opts: {
    to: string;
    url: string;
    filename?: string;
    caption?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({
        kind: "file",
        url: opts.url,
        filename: opts.filename,
        caption: opts.caption,
      }),
      {
        type: "document",
        document: {
          link: opts.url,
          filename: opts.filename || "file",
          ...(opts.caption ? { caption: opts.caption } : {}),
        },
      }
    );
  }

  async sendAudio(opts: { to: string; url: string }): Promise<GupshupSendResult> {
    return this.sendSession(opts.to, buildSessionMessage({ kind: "audio", url: opts.url }), {
      type: "audio",
      audio: { link: opts.url },
    });
  }

  async sendVideo(opts: {
    to: string;
    url: string;
    caption?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({ kind: "video", url: opts.url, caption: opts.caption }),
      {
        type: "video",
        video: { link: opts.url, ...(opts.caption ? { caption: opts.caption } : {}) },
      }
    );
  }

  async sendTemplate(opts: {
    to: string;
    templateId: string;
    params: string[];
  }): Promise<GupshupSendResult> {
    if ((env.GUPSHUP_APP_ID || "").trim()) {
      return this.postFbc(opts.to, {
        type: "template",
        template: {
          name: opts.templateId,
          language: { code: "pt_BR" },
          components: [
            {
              type: "body",
              parameters: opts.params.map((text) => ({ type: "text", text })),
            },
          ],
        },
      });
    }
    const c = await this.credentials();
    return this.postForm("/wa/api/v1/template/msg", {
      channel: "whatsapp",
      source: c.source,
      destination: opts.to,
      "src.name": c.appName,
      template: buildTemplateJson({ id: opts.templateId, params: opts.params }),
    });
  }

  static extractMessageId(data: unknown): string | null {
    return extractGupshupMessageId(data);
  }

  static submitOk(data: unknown, httpOk: boolean): boolean {
    return gupshupSubmitOk(data, httpOk);
  }
}

export const gupshup = new GupshupClient();
