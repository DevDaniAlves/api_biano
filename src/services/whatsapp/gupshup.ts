import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import {
  buildAccessInteractiveMessage,
  buildSessionMessage,
  buildTemplateJson,
  extractGupshupMessageId,
  gupshupSubmitOk,
  isRetryableStatus,
} from "./gupshup-mapper.js";
import { normalizeGupshupAudioMime } from "./gupshup-audio.js";

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

/** MIME para upload Gupshup (áudio exige codecs=opus no ogg). */
export function normalizeGupshupUploadMime(mimetype?: string, fileName?: string): string {
  const raw = (mimetype || "").trim().toLowerCase();
  if (raw.startsWith("audio/") || fileName?.match(/\.(ogg|webm|mp3|m4a|mp4|aac|amr)$/i)) {
    return normalizeGupshupAudioMime(mimetype, fileName);
  }
  return (mimetype || "application/octet-stream").split(";")[0].trim();
}

export function toPublicMediaUrl(link?: string | null): string | null {
  const raw = (link || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = env.API_PUBLIC_URL.replace(/\/+$/, "");
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${p}`;
}

/** URL que a Gupshup não consegue baixar (localhost / rede privada). */
export function isUnreachableMediaUrl(url?: string | null): boolean {
  const raw = (url || "").trim();
  if (!raw) return true;
  const full = raw.startsWith("/") ? toPublicMediaUrl(raw) : raw;
  if (!full) return true;
  try {
    const u = new URL(full);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

/** @deprecated use isUnreachableMediaUrl */
export function isInternalMediaUrl(url?: string | null): boolean {
  return isUnreachableMediaUrl(url);
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

export function persistBufferUpload(opts: {
  buffer: Buffer;
  fileName?: string;
  mimetype?: string;
}): string | null {
  if (opts.buffer.length < 40) return null;
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${mimeExt(
    opts.mimetype,
    opts.fileName
  )}`;
  fs.writeFileSync(path.join(dir, name), opts.buffer);
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
    const appId =
      (env.GUPSHUP_APP_ID || "").trim() || (row?.gupshupAppId || "").trim();
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

  /** Apps CAPI/FBC: upload direto → mediaId (evita Invalid Media URL na URL do Railway). */
  async uploadPartnerMedia(opts: {
    buffer: Buffer;
    mimetype?: string;
    fileName?: string;
  }): Promise<string | null> {
    const c = await this.credentials();
    if (!this.apiKey || opts.buffer.length < 40) return null;
    if (!c.appId) {
      console.error("[gupshup] media upload ignorado: GUPSHUP_APP_ID ausente (env ou Admin → Conectar WhatsApp)");
      return null;
    }

    const mime = normalizeGupshupUploadMime(opts.mimetype, opts.fileName);
    const name = opts.fileName || `media.${mimeExt(mime, opts.fileName)}`;
    const form = new FormData();
    form.append("file_type", mime);
    form.append("file", new Blob([Uint8Array.from(opts.buffer)], { type: mime.split(";")[0].trim() }), name);

    const headers: Record<string, string> = { token: this.apiKey };
    if (this.apiKey.startsWith("sk_")) headers.Authorization = this.apiKey;

    try {
      const res = await fetch(`https://partner.gupshup.io/partner/app/${c.appId}/media`, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text().catch(() => "");
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      const mediaId =
        data && typeof data === "object" && "mediaId" in data
          ? String((data as { mediaId?: unknown }).mediaId ?? "")
          : "";
      if (!res.ok || !mediaId) {
        console.error("[gupshup] media upload", res.status, text.slice(0, 400));
        return null;
      }
      console.log("[gupshup] media upload ok", mediaId.slice(0, 16));
      return mediaId;
    } catch (err) {
      console.error("[gupshup] media upload", err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async sendSession(to: string, formMessage: string): Promise<GupshupSendResult> {
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
    return this.sendSession(to, buildSessionMessage({ kind: "text", text }));
  }

  async sendImage(opts: {
    to: string;
    url?: string;
    caption?: string;
    filename?: string;
    mediaId?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({
        kind: "image",
        url: opts.url,
        caption: opts.caption,
        filename: opts.filename,
        mediaId: opts.mediaId,
      })
    );
  }

  async sendFile(opts: {
    to: string;
    url?: string;
    filename?: string;
    caption?: string;
    mediaId?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({
        kind: "file",
        url: opts.url,
        filename: opts.filename,
        caption: opts.caption,
        mediaId: opts.mediaId,
      })
    );
  }

  async sendAudio(opts: {
    to: string;
    url?: string;
    filename?: string;
    mediaId?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({
        kind: "audio",
        url: opts.url,
        filename: opts.filename,
        mediaId: opts.mediaId,
      })
    );
  }

  async sendVideo(opts: {
    to: string;
    url?: string;
    caption?: string;
    mediaId?: string;
  }): Promise<GupshupSendResult> {
    return this.sendSession(
      opts.to,
      buildSessionMessage({
        kind: "video",
        url: opts.url,
        caption: opts.caption,
        mediaId: opts.mediaId,
      })
    );
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

  async sendInteractive(to: string, interactive: Record<string, unknown>): Promise<GupshupSendResult> {
    return this.sendSession(to, buildAccessInteractiveMessage(interactive));
  }

  static extractMessageId(data: unknown): string | null {
    return extractGupshupMessageId(data);
  }

  static submitOk(data: unknown, httpOk: boolean): boolean {
    return gupshupSubmitOk(data, httpOk);
  }
}

export const gupshup = new GupshupClient();
