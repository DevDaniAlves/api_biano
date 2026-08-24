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

export type MetaBusinessProfile = {
  about: string;
  address: string;
  description: string;
  email: string;
  vertical: string;
  websites: string[];
  profilePictureUrl: string | null;
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

  /**
   * Baixa mídia inbound (Cloud API): GET /{mediaId} → url → GET binário com Bearer.
   * Retorna path público `/uploads/...` ou null.
   */
  async downloadMediaToUploads(
    mediaId: string,
    opts?: { type?: string; fileName?: string | null }
  ): Promise<{ localUrl: string; mimeType: string | null } | null> {
    const id = mediaId.trim();
    if (!id || !env.META_ACCESS_TOKEN) return null;

    const meta = await this.graph("GET", `/${encodeURIComponent(id)}`);
    if (!meta.ok || !meta.data || typeof meta.data !== "object") {
      console.error("[meta] media meta", id, meta.status, meta.text.slice(0, 200));
      return null;
    }
    const row = meta.data as { url?: string; mime_type?: string };
    const url = (row.url || "").trim();
    if (!url) return null;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.error("[meta] media download", res.status, url.slice(0, 80));
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 40) return null;

      const mime = row.mime_type || res.headers.get("content-type") || null;
      const type = opts?.type || "image";
      const fromName = opts?.fileName?.split(".").pop()?.toLowerCase();
      const ext =
        fromName && /^[a-z0-9]{2,5}$/.test(fromName)
          ? fromName
          : (mime || "").includes("png")
            ? "png"
            : (mime || "").includes("webp")
              ? "webp"
              : (mime || "").includes("gif")
                ? "gif"
                : (mime || "").includes("pdf")
                  ? "pdf"
                  : (mime || "").includes("mp4") || type === "video"
                    ? "mp4"
                    : (mime || "").includes("ogg") ||
                        (mime || "").includes("opus") ||
                        type === "audio"
                      ? "ogg"
                      : type === "document"
                        ? "bin"
                        : "jpg";

      const fs = await import("node:fs");
      const path = await import("node:path");
      const crypto = await import("node:crypto");
      const uploadsDir = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), "uploads"));
      fs.mkdirSync(uploadsDir, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, name), buf);
      return { localUrl: `/uploads/${name}`, mimeType: mime };
    } catch (err) {
      console.error("[meta] media download fail", err instanceof Error ? err.message : err);
      return null;
    }
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

    // Variáveis posicionais {{1}}..{{n}} — example.body_text DEVE ser array de arrays.
    const varIndexes = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const varCount = varIndexes.length ? Math.max(...varIndexes) : 0;
    const defaults = ["Maria", "129,90", "20/08/2026", "https://calangusmoda.crediario.digital/login"];
    const examples: string[] = [];
    for (let i = 0; i < varCount; i++) {
      examples.push((opts.bodyExamples[i] || defaults[i] || `exemplo${i + 1}`).trim());
    }

    const bodyComponent: Record<string, unknown> = {
      type: "BODY",
      text: bodyText,
    };
    if (varCount > 0) {
      bodyComponent.example = { body_text: [examples] };
    }

    return this.graph("POST", `/${encodeURIComponent(wabaId)}/message_templates`, {
      name,
      language,
      category,
      parameter_format: "positional",
      components: [bodyComponent],
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

  async sendText(to: string, text: string, contextMessageId?: string | null) {
    return this.req({
      to: MetaClient.toNumber(to),
      type: "text",
      text: { preview_url: false, body: text },
      ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    });
  }

  async sendInteractive(to: string, interactive: Record<string, unknown>) {
    return this.req({
      to: MetaClient.toNumber(to),
      type: "interactive",
      interactive,
    });
  }

  /** Marca mensagem (e anteriores da conversa) como lida no WhatsApp. */
  async markAsRead(messageId: string) {
    return this.req({
      status: "read",
      message_id: messageId,
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

  /**
   * Upload binário → media id (Cloud API).
   * Preferir isto a image.link: a Meta precisa baixar a URL e /uploads locais não são URI válidas.
   */
  async uploadMedia(opts: {
    buffer: Buffer;
    mimetype: string;
    fileName?: string;
  }): Promise<{ ok: true; id: string } | { ok: false; status: number; text: string }> {
    const phoneNumberId = await this.resolvePhoneNumberId();
    if (!phoneNumberId || !env.META_ACCESS_TOKEN) {
      return { ok: false, status: 0, text: "Meta não configurada" };
    }
    if (opts.buffer.length < 40) {
      return { ok: false, status: 0, text: "Arquivo de mídia vazio" };
    }
    const mimeRaw = (opts.mimetype || "application/octet-stream").trim();
    // Meta exige "audio/ogg; codecs=opus" completo; para o restante, base type basta.
    const mime = mimeRaw.toLowerCase().includes("ogg")
      ? mimeRaw
      : mimeRaw.split(";")[0].trim();
    const name =
      opts.fileName ||
      `media.${mime.includes("mpeg") ? "mp3" : mime.split("/")[1]?.split(";")[0] || "bin"}`;
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append(
      "file",
      new Blob([Uint8Array.from(opts.buffer)], { type: mime.split(";")[0].trim() }),
      name
    );

    try {
      const res = await fetch(`${GRAPH}/${encodeURIComponent(phoneNumberId)}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
        body: form,
      });
      const text = await res.text().catch(() => "");
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      const id =
        data && typeof data === "object" && "id" in data
          ? String((data as { id?: unknown }).id ?? "").trim()
          : "";
      if (!res.ok || !id) {
        console.error("[meta] media upload", res.status, text.slice(0, 400));
        return { ok: false, status: res.status, text: text.slice(0, 500) };
      }
      console.log("[meta] media upload ok", id.slice(0, 24));
      return { ok: true, id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[meta] media upload", msg);
      return { ok: false, status: 0, text: msg };
    }
  }

  async sendMedia(opts: {
    to: string;
    mediatype: "image" | "document" | "audio" | "video";
    /** Media id retornado por uploadMedia. */
    id?: string;
    /** Só se for HTTPS público acessível pela Meta. */
    link?: string;
    caption?: string;
    fileName?: string;
  }) {
    const type = opts.mediatype;
    const payload: Record<string, unknown> = {};
    if (opts.id) payload.id = opts.id;
    else if (opts.link) payload.link = opts.link;
    else {
      return { ok: false, status: 0, data: null, text: "Meta mídia exige id ou link HTTPS" };
    }
    if (opts.caption && type !== "audio") payload.caption = opts.caption;
    if (type === "document" && opts.fileName) payload.filename = opts.fileName;
    return this.req({
      to: MetaClient.toNumber(opts.to),
      type,
      [type]: payload,
    });
  }

  /** @deprecated use sendMedia */
  async sendMediaLink(opts: {
    to: string;
    mediatype: "image" | "document" | "audio" | "video";
    link: string;
    caption?: string;
    fileName?: string;
  }) {
    return this.sendMedia(opts);
  }

  /** Lê o perfil comercial do número (Cloud API). */
  async getBusinessProfile() {
    const phoneNumberId = await this.resolvePhoneNumberId();
    if (!phoneNumberId) {
      return {
        ok: false as const,
        status: 0,
        data: null,
        text: "Phone Number ID ausente",
        profile: null as MetaBusinessProfile | null,
      };
    }
    const fields =
      "about,address,description,email,profile_picture_url,websites,vertical";
    const r = await this.graph(
      "GET",
      `/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile?fields=${fields}`
    );
    let profile: MetaBusinessProfile | null = null;
    if (r.data && typeof r.data === "object") {
      const list = (r.data as { data?: unknown[] }).data;
      const row =
        Array.isArray(list) && list[0] && typeof list[0] === "object"
          ? (list[0] as Record<string, unknown>)
          : (r.data as Record<string, unknown>);
      if (row) {
        const websites = Array.isArray(row.websites)
          ? row.websites.map((w) => String(w)).filter(Boolean)
          : [];
        profile = {
          about: row.about != null ? String(row.about) : "",
          address: row.address != null ? String(row.address) : "",
          description: row.description != null ? String(row.description) : "",
          email: row.email != null ? String(row.email) : "",
          vertical: row.vertical != null ? String(row.vertical) : "",
          websites,
          profilePictureUrl:
            row.profile_picture_url != null ? String(row.profile_picture_url) : null,
        };
      }
    }
    return { ...r, profile };
  }

  /** Atualiza campos do perfil comercial (não inclui nome de exibição nem horário). */
  async updateBusinessProfile(opts: {
    about?: string;
    address?: string;
    description?: string;
    email?: string;
    vertical?: string;
    websites?: string[];
    profilePictureHandle?: string;
  }) {
    const phoneNumberId = await this.resolvePhoneNumberId();
    if (!phoneNumberId) {
      return { ok: false as const, status: 0, data: null, text: "Phone Number ID ausente" };
    }
    const body: Record<string, unknown> = { messaging_product: "whatsapp" };
    if (opts.about != null) body.about = String(opts.about).slice(0, 139);
    if (opts.address != null) body.address = String(opts.address).slice(0, 256);
    if (opts.description != null) body.description = String(opts.description).slice(0, 512);
    if (opts.email != null) body.email = String(opts.email).slice(0, 128);
    if (opts.vertical != null) body.vertical = String(opts.vertical);
    if (opts.websites) {
      body.websites = opts.websites
        .map((w) => String(w).trim())
        .filter(Boolean)
        .slice(0, 2);
    }
    if (opts.profilePictureHandle) {
      body.profile_picture_handle = opts.profilePictureHandle;
    }
    return this.graph(
      "POST",
      `/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile`,
      body
    );
  }

  /**
   * Upload resumável → handle para foto de perfil.
   * https://developers.facebook.com/docs/graph-api/guides/upload
   */
  async uploadProfilePicture(file: Buffer, mimeType: string, fileName: string) {
    const appId = (env.META_APP_ID || "").trim();
    if (!appId || !env.META_ACCESS_TOKEN) {
      return {
        ok: false as const,
        status: 0,
        handle: null as string | null,
        text: "META_APP_ID / META_ACCESS_TOKEN ausentes",
      };
    }
    const startUrl = new URL(`${GRAPH}/${encodeURIComponent(appId)}/uploads`);
    startUrl.searchParams.set("file_length", String(file.length));
    startUrl.searchParams.set("file_type", mimeType || "image/jpeg");
    startUrl.searchParams.set("file_name", fileName || "profile.jpg");
    const startRes = await fetch(startUrl.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
    });
    const startText = await startRes.text().catch(() => "");
    let startData: unknown = null;
    try {
      startData = startText ? JSON.parse(startText) : null;
    } catch {
      startData = startText;
    }
    if (!startRes.ok) {
      console.error("[meta] upload start", startRes.status, startText.slice(0, 400));
      return {
        ok: false as const,
        status: startRes.status,
        handle: null,
        text: startText.slice(0, 500),
      };
    }
    const sessionId =
      startData && typeof startData === "object"
        ? String((startData as { id?: string }).id ?? "")
        : "";
    if (!sessionId) {
      return {
        ok: false as const,
        status: 0,
        handle: null,
        text: "Sessão de upload sem id",
      };
    }

    const uploadRes = await fetch(`${GRAPH}/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${env.META_ACCESS_TOKEN}`,
        file_offset: "0",
        "Content-Type": mimeType || "application/octet-stream",
      },
      body: new Uint8Array(file),
    });
    const uploadText = await uploadRes.text().catch(() => "");
    let uploadData: unknown = null;
    try {
      uploadData = uploadText ? JSON.parse(uploadText) : null;
    } catch {
      uploadData = uploadText;
    }
    if (!uploadRes.ok) {
      console.error("[meta] upload file", uploadRes.status, uploadText.slice(0, 400));
      return {
        ok: false as const,
        status: uploadRes.status,
        handle: null,
        text: uploadText.slice(0, 500),
      };
    }
    const handle =
      uploadData && typeof uploadData === "object"
        ? String((uploadData as { h?: string }).h ?? "")
        : "";
    if (!handle) {
      return {
        ok: false as const,
        status: 0,
        handle: null,
        text: "Upload sem handle (h)",
      };
    }
    return { ok: true as const, status: uploadRes.status, handle, text: uploadText };
  }

  async getPhoneNumberInfo() {
    const phoneNumberId = await this.resolvePhoneNumberId();
    if (!phoneNumberId) {
      return {
        ok: false as const,
        status: 0,
        data: null,
        text: "Phone Number ID ausente",
        info: null as {
          displayPhoneNumber: string | null;
          verifiedName: string | null;
          qualityRating: string | null;
          status: string | null;
        } | null,
      };
    }
    const r = await this.graph(
      "GET",
      `/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,status`
    );
    let info: {
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      qualityRating: string | null;
      status: string | null;
    } | null = null;
    if (r.data && typeof r.data === "object") {
      const row = r.data as Record<string, unknown>;
      info = {
        displayPhoneNumber: row.display_phone_number
          ? String(row.display_phone_number)
          : null,
        verifiedName: row.verified_name ? String(row.verified_name) : null,
        qualityRating: row.quality_rating ? String(row.quality_rating) : null,
        status: row.status
          ? String(row.status)
          : row.code_verification_status
            ? String(row.code_verification_status)
            : null,
      };
    }
    return { ...r, info };
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
