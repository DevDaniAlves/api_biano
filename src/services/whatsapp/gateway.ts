import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { evolution, EvolutionClient } from "./evolution.js";
import { gupshup, isUnreachableMediaUrl, persistBase64Upload, persistBufferUpload, toPublicMediaUrl } from "./gupshup.js";
import { prepareGupshupAudioUpload } from "./gupshup-audio.js";
import { extractGupshupMessageId, gupshupSubmitOk, templateParamsFromComponents } from "./gupshup-mapper.js";
import { meta, MetaClient } from "./meta.js";

export type WhatsAppProvider = "meta" | "evolution" | "gupshup";
export type SendSource = "boleto" | "bot" | "agent" | "system";
export type SendKind = "text" | "template" | "media" | "audio" | "interactive";
export type SendCategory =
  | "utility"
  | "service"
  | "marketing"
  | "authentication"
  | "free"
  | "unknown";

export type OutboundResult = {
  ok: boolean;
  externalId: string | null;
  error?: string;
  provider: WhatsAppProvider;
  logId?: string;
};

export async function activeProvider(): Promise<WhatsAppProvider> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
  const fromDb = (row?.provider || "").trim().toLowerCase();
  if (fromDb === "meta" || fromDb === "evolution" || fromDb === "gupshup") return fromDb;
  if (env.WHATSAPP_PROVIDER === "meta") return "meta";
  if (env.WHATSAPP_PROVIDER === "gupshup") return "gupshup";
  return "evolution";
}

export async function messagingEnabled() {
  const p = await activeProvider();
  if (p === "meta") return meta.enabled;
  if (p === "gupshup") return gupshup.isConfigured();
  return evolution.enabled;
}

function previewOf(text?: string | null) {
  if (!text) return null;
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Envio unificado + WhatsAppSendLog (custo Meta). */
export async function sendOutbound(opts: {
  to: string;
  source: SendSource;
  kind?: SendKind;
  text?: string;
  template?: {
    name: string;
    language?: string;
    components?: unknown[];
    gupshupId?: string;
    params?: string[];
  };
  media?: {
    mediatype: "image" | "document" | "audio" | "video";
    link?: string;
    base64?: string;
    mimetype?: string;
    caption?: string;
    fileName?: string;
  };
  /** Botões/lista Cloud API (Meta / Gupshup FBC). */
  interactive?: Record<string, unknown>;
  contactId?: string | null;
  boletoId?: string | null;
  category?: SendCategory;
  billable?: boolean;
  bodyPreview?: string | null;
  /** Resposta a mensagem específica (Evolution quoted / Meta context). */
  quoted?: {
    externalId: string;
    fromMe: boolean;
    remoteJid?: string | null;
    body?: string | null;
  } | null;
}): Promise<OutboundResult> {
  const provider = await activeProvider();
  const rawPhone = (opts.to.includes("@") ? opts.to.split("@")[0] : opts.to).replace(/\D/g, "");
  const phone = provider === "evolution" ? rawPhone : MetaClient.toNumber(rawPhone);
  const kind: SendKind =
    opts.kind ??
    (opts.template
      ? "template"
      : opts.interactive
        ? "interactive"
        : opts.media?.mediatype === "audio"
          ? "audio"
          : opts.media
            ? "media"
            : "text");

  const category: SendCategory =
    opts.category ??
    (kind === "template" ? "utility" : provider === "evolution" ? "free" : "service");
  const billable =
    opts.billable ??
    ((provider === "meta" || provider === "gupshup") &&
      category !== "free" &&
      category !== "unknown");

  const log = await prisma.whatsAppSendLog.create({
    data: {
      provider,
      source: opts.source,
      direction: "out",
      phone,
      kind,
      templateName: opts.template?.name ?? null,
      category,
      billable,
      status: "queued",
      contactId: opts.contactId ?? null,
      boletoId: opts.boletoId ?? null,
      bodyPreview: opts.bodyPreview ?? previewOf(opts.text ?? opts.media?.caption),
    },
  });

  try {
    if (provider === "meta") {
      if (!meta.enabled) {
        await prisma.whatsAppSendLog.update({
          where: { id: log.id },
          data: { status: "failed", error: "Meta não configurada" },
        });
        return {
          ok: false,
          externalId: null,
          error: "Meta não configurada",
          provider,
          logId: log.id,
        };
      }

      let r;
      if (opts.template) {
        r = await meta.sendTemplate({
          to: phone,
          name: opts.template.name,
          language: opts.template.language,
          components: opts.template.components,
        });
      } else if (opts.media) {
        // Cloud API: upload binário → media id. image.link só vale com HTTPS público
        // (path /uploads/... local gera "#100 Param image.link is not a valid URI").
        let mediaId: string | null = null;
        if (opts.media.base64) {
          const raw = opts.media.base64.replace(/^data:[^;]+;base64,/, "");
          const buf = Buffer.from(raw, "base64");
          const mime =
            opts.media.mimetype ||
            (opts.media.mediatype === "image"
              ? "image/jpeg"
              : opts.media.mediatype === "audio"
                ? "audio/ogg"
                : opts.media.mediatype === "video"
                  ? "video/mp4"
                  : "application/octet-stream");
          const up = await meta.uploadMedia({
            buffer: buf,
            mimetype: mime,
            fileName: opts.media.fileName,
          });
          if (!up.ok) {
            const error = `Upload mídia Meta: HTTP ${up.status}: ${up.text}`;
            await prisma.whatsAppSendLog.update({
              where: { id: log.id },
              data: { status: "failed", error },
            });
            return { ok: false, externalId: null, error, provider, logId: log.id };
          }
          mediaId = up.id;
        }
        const publicLink = toPublicMediaUrl(opts.media.link);
        const canUseLink =
          !mediaId &&
          publicLink &&
          /^https:\/\//i.test(publicLink) &&
          !isUnreachableMediaUrl(publicLink);
        if (!mediaId && !canUseLink) {
          const err =
            "Meta mídia: envie o arquivo (base64) para upload, ou um link HTTPS público";
          await prisma.whatsAppSendLog.update({
            where: { id: log.id },
            data: { status: "failed", error: err },
          });
          return { ok: false, externalId: null, error: err, provider, logId: log.id };
        }
        r = await meta.sendMedia({
          to: phone,
          mediatype: opts.media.mediatype,
          ...(mediaId ? { id: mediaId } : { link: publicLink! }),
          caption: opts.media.caption,
          fileName: opts.media.fileName,
        });
      } else if (opts.interactive) {
        r = await meta.sendInteractive(phone, opts.interactive);
      } else {
        r = await meta.sendText(phone, opts.text ?? "", opts.quoted?.externalId);
      }

      const externalId = MetaClient.extractMessageId(r.data);
      if (!r.ok) {
        const error = `HTTP ${r.status}: ${r.text.slice(0, 500)}`;
        await prisma.whatsAppSendLog.update({
          where: { id: log.id },
          data: { status: "failed", error, externalId },
        });
        return { ok: false, externalId, error, provider, logId: log.id };
      }
      await prisma.whatsAppSendLog.update({
        where: { id: log.id },
        data: { status: "sent", externalId },
      });
      return { ok: true, externalId, provider, logId: log.id };
    }

    if (provider === "gupshup") {
      if (!(await gupshup.isConfigured())) {
        await prisma.whatsAppSendLog.update({
          where: { id: log.id },
          data: { status: "failed", error: "Gupshup não configurada" },
        });
        return {
          ok: false,
          externalId: null,
          error: "Gupshup não configurada",
          provider,
          logId: log.id,
        };
      }

      let r;
      if (opts.template) {
        const templateId = (opts.template.gupshupId || opts.template.name || "").trim();
        const params =
          opts.template.params ?? templateParamsFromComponents(opts.template.components);
        if (!templateId) {
          const err = "GUPSHUP_BOLETO_TEMPLATE_ID / template.gupshupId ausente";
          await prisma.whatsAppSendLog.update({
            where: { id: log.id },
            data: { status: "failed", error: err },
          });
          return { ok: false, externalId: null, error: err, provider, logId: log.id };
        }
        r = await gupshup.sendTemplate({ to: phone, templateId, params });
      } else if (opts.media) {
        let url = toPublicMediaUrl(opts.media.link);
        let mediaFileName = opts.media.fileName;
        if (opts.media.base64) {
          const raw = opts.media.base64.replace(/^data:[^;]+;base64,/, "");
          let buf = Buffer.from(raw, "base64");
          let uploadMime = opts.media.mimetype;
          let uploadName = opts.media.fileName;
          if (buf.length >= 40 && opts.media.mediatype === "audio") {
            try {
              const prep = await prepareGupshupAudioUpload({
                buffer: buf,
                mimetype: uploadMime,
                fileName: uploadName,
              });
              buf = Buffer.from(prep.buffer);
              uploadMime = prep.mimetype;
              uploadName = prep.fileName;
              mediaFileName = prep.fileName;
              console.log("[gupshup] audio preparado", uploadMime, uploadName);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const errOut = `Áudio: conversão para MP3 falhou (${msg}).`;
              console.error("[gupshup] audio prepare", msg);
              await prisma.whatsAppSendLog.update({
                where: { id: log.id },
                data: { status: "failed", error: errOut },
              });
              return { ok: false, externalId: null, error: errOut, provider, logId: log.id };
            }
            const local = persistBufferUpload({
              buffer: buf,
              fileName: uploadName,
              mimetype: uploadMime,
            });
            url = toPublicMediaUrl(local);
          } else if (!url && buf.length >= 40) {
            const local = persistBase64Upload({
              base64: opts.media.base64,
              fileName: opts.media.fileName,
              mimetype: opts.media.mimetype,
            });
            url = toPublicMediaUrl(local);
          }
        }
        if (!url) {
          const err = "Gupshup mídia exige URL pública (API_PUBLIC_URL + /uploads)";
          await prisma.whatsAppSendLog.update({
            where: { id: log.id },
            data: { status: "failed", error: err },
          });
          return { ok: false, externalId: null, error: err, provider, logId: log.id };
        }
        const mt = opts.media.mediatype;
        if (isUnreachableMediaUrl(url)) {
          const err =
            "Gupshup precisa baixar a mídia por HTTPS público (POST /wa/api/v1/msg com originalUrl). localhost não funciona — use ngrok ou API_PUBLIC_URL do Railway.";
          console.error("[gupshup] mídia URL inacessível:", mt, url.slice(0, 80));
          await prisma.whatsAppSendLog.update({
            where: { id: log.id },
            data: { status: "failed", error: err },
          });
          return { ok: false, externalId: null, error: err, provider, logId: log.id };
        }
        console.log("[gupshup] mídia", mt, `url=${url.slice(0, 96)}`);
        const cap = opts.media.caption;
        if (mt === "audio") {
          r = await gupshup.sendAudio({ to: phone, url, filename: mediaFileName });
          console.log("[gupshup] send audio", r.status, (r.text || "").slice(0, 200));
        } else if (mt === "video") {
          r = await gupshup.sendVideo({ to: phone, url, caption: cap });
        } else if (mt === "document") {
          r = await gupshup.sendFile({
            to: phone,
            url,
            filename: opts.media.fileName,
            caption: cap,
          });
        } else {
          r = await gupshup.sendImage({
            to: phone,
            url,
            caption: cap,
            filename: opts.media.fileName,
          });
        }
      } else if (opts.interactive) {
        r = await gupshup.sendInteractive(phone, opts.interactive);
      } else {
        r = await gupshup.sendText(phone, opts.text ?? "");
      }

      const externalId = extractGupshupMessageId(r.data);
      const ok = gupshupSubmitOk(r.data, r.ok);
      if (!ok) {
        const error = `HTTP ${r.status}: ${r.text.slice(0, 500)}`;
        await prisma.whatsAppSendLog.update({
          where: { id: log.id },
          data: { status: "failed", error, externalId },
        });
        return { ok: false, externalId, error, provider, logId: log.id };
      }
      await prisma.whatsAppSendLog.update({
        where: { id: log.id },
        data: { status: "sent", externalId },
      });
      return { ok: true, externalId, provider, logId: log.id };
    }

    if (!evolution.enabled) {
      await prisma.whatsAppSendLog.update({
        where: { id: log.id },
        data: { status: "failed", error: "Evolution não configurada" },
      });
      return {
        ok: false,
        externalId: null,
        error: "Evolution não configurada",
        provider,
        logId: log.id,
      };
    }

    let r;
    if (opts.media) {
      const mediaPayload = opts.media.base64 ?? opts.media.link ?? "";
      if (opts.media.mediatype === "audio" && opts.media.base64) {
        r = await evolution.sendWhatsAppAudio({ phone: opts.to, audio: opts.media.base64 });
        if (!r.ok) {
          r = await evolution.sendMedia({
            phone: opts.to,
            media: mediaPayload,
            mimetype: opts.media.mimetype || "audio/ogg; codecs=opus",
            caption: "",
            fileName: opts.media.fileName || "audio.ogg",
            mediatype: "audio",
          });
        }
      } else {
        r = await evolution.sendMedia({
          phone: opts.to,
          media: mediaPayload,
          mimetype: opts.media.mimetype || "application/octet-stream",
          caption: opts.media.caption ?? "",
          fileName: opts.media.fileName || "file",
          mediatype: opts.media.mediatype,
        });
      }
    } else {
      r = await evolution.sendText(
        opts.to,
        opts.text ?? "",
        opts.quoted
          ? {
              id: opts.quoted.externalId,
              fromMe: opts.quoted.fromMe,
              remoteJid: opts.quoted.remoteJid,
              body: opts.quoted.body,
            }
          : null
      );
    }

    const externalId = EvolutionClient.extractMessageId(r.data);
    if (!r.ok) {
      const error = `HTTP ${r.status}: ${r.text.slice(0, 500)}`;
      await prisma.whatsAppSendLog.update({
        where: { id: log.id },
        data: { status: "failed", error, externalId },
      });
      return { ok: false, externalId, error, provider, logId: log.id };
    }
    await prisma.whatsAppSendLog.update({
      where: { id: log.id },
      data: { status: "sent", externalId },
    });
    return { ok: true, externalId, provider, logId: log.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await prisma.whatsAppSendLog.update({
      where: { id: log.id },
      data: { status: "failed", error: error.slice(0, 1000) },
    });
    return { ok: false, externalId: null, error, provider, logId: log.id };
  }
}

/** Atualiza log a partir do webhook statuses da Meta. */
export async function applyMetaStatus(opts: {
  wamid: string;
  status: string;
  pricing?: {
    billable?: boolean;
    category?: string;
    pricing_model?: string;
    type?: string;
  } | null;
  error?: string | null;
}) {
  const row = await prisma.whatsAppSendLog.findFirst({
    where: { externalId: opts.wamid },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;

  const statusMap: Record<string, string> = {
    sent: "sent",
    delivered: "delivered",
    read: "read",
    failed: "failed",
  };
  const status = statusMap[opts.status] ?? opts.status;
  const pricing = opts.pricing;
  const category = pricing?.category ?? row.category;
  const pricingType = pricing?.type ?? pricing?.pricing_model ?? row.pricingType;
  let billable = row.billable;
  if (typeof pricing?.billable === "boolean") billable = pricing.billable;
  else if (pricingType && String(pricingType).startsWith("free")) billable = false;

  return prisma.whatsAppSendLog.update({
    where: { id: row.id },
    data: {
      status,
      category: category ?? undefined,
      pricingType: pricingType ?? undefined,
      billable,
      error: opts.error ? opts.error.slice(0, 1000) : undefined,
      deliveredAt: status === "delivered" || status === "read" ? new Date() : row.deliveredAt,
    },
  });
}

/** Atualiza log a partir de message-event Gupshup (gsId / id). */
export async function applyGupshupStatus(opts: {
  ids: string[];
  status: string;
  error?: string | null;
}) {
  const ids = opts.ids.map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return null;
  const row = await prisma.whatsAppSendLog.findFirst({
    where: { externalId: { in: ids } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;

  const status = opts.status || row.status;
  return prisma.whatsAppSendLog.update({
    where: { id: row.id },
    data: {
      status,
      error: opts.error ? opts.error.slice(0, 1000) : undefined,
      deliveredAt: status === "delivered" || status === "read" ? new Date() : row.deliveredAt,
    },
  });
}
