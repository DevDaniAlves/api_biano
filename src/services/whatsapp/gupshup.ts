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

  async credentials(): Promise<{ apiKey: string; appName: string; source: string }> {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    const appName =
      (row?.gupshupAppName || "").trim() || (env.GUPSHUP_APP_NAME || "").trim();
    const source = (
      (row?.gupshupSource || "").trim() ||
      (env.GUPSHUP_SOURCE || "").trim()
    ).replace(/\D/g, "");
    return { apiKey: this.apiKey, appName, source };
  }

  async isConfigured() {
    const c = await this.credentials();
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
    const body = new URLSearchParams(fields);
    let last: GupshupSendResult = { ok: false, status: 0, data: null, text: "sem resposta" };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            apikey: this.apiKey,
            "Content-Type": "application/x-www-form-urlencoded",
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
        // 200 submitted: nunca retry (duplicaria). Retry só 429/502/503/504.
        if (res.ok || !isRetryableStatus(res.status)) {
          if (!res.ok) {
            console.error("[gupshup]", pathName, res.status, text.slice(0, 400));
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
    const fields = await this.sessionFields(to, buildSessionMessage({ kind: "text", text }));
    return this.postForm("/wa/api/v1/msg", fields);
  }

  async sendImage(opts: {
    to: string;
    url: string;
    caption?: string;
  }): Promise<GupshupSendResult> {
    const fields = await this.sessionFields(
      opts.to,
      buildSessionMessage({ kind: "image", url: opts.url, caption: opts.caption })
    );
    return this.postForm("/wa/api/v1/msg", fields);
  }

  async sendFile(opts: {
    to: string;
    url: string;
    filename?: string;
    caption?: string;
  }): Promise<GupshupSendResult> {
    const fields = await this.sessionFields(
      opts.to,
      buildSessionMessage({
        kind: "file",
        url: opts.url,
        filename: opts.filename,
        caption: opts.caption,
      })
    );
    return this.postForm("/wa/api/v1/msg", fields);
  }

  async sendAudio(opts: { to: string; url: string }): Promise<GupshupSendResult> {
    const fields = await this.sessionFields(
      opts.to,
      buildSessionMessage({ kind: "audio", url: opts.url })
    );
    return this.postForm("/wa/api/v1/msg", fields);
  }

  async sendVideo(opts: {
    to: string;
    url: string;
    caption?: string;
  }): Promise<GupshupSendResult> {
    const fields = await this.sessionFields(
      opts.to,
      buildSessionMessage({ kind: "video", url: opts.url, caption: opts.caption })
    );
    return this.postForm("/wa/api/v1/msg", fields);
  }

  async sendTemplate(opts: {
    to: string;
    templateId: string;
    params: string[];
  }): Promise<GupshupSendResult> {
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
