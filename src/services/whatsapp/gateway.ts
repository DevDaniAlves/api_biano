import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { evolution, EvolutionClient } from "./evolution.js";
import { meta, MetaClient } from "./meta.js";

export type SendSource = "boleto" | "bot" | "agent" | "system";
export type SendKind = "text" | "template" | "media" | "audio";
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
  provider: "meta" | "evolution";
  logId?: string;
};

export async function activeProvider(): Promise<"meta" | "evolution"> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
  const fromDb = (row?.provider || "").trim().toLowerCase();
  if (fromDb === "meta" || fromDb === "evolution") return fromDb;
  return env.WHATSAPP_PROVIDER === "meta" ? "meta" : "evolution";
}

export async function messagingEnabled() {
  const p = await activeProvider();
  if (p === "meta") return meta.enabled;
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
  };
  media?: {
    mediatype: "image" | "document" | "audio" | "video";
    link?: string;
    base64?: string;
    mimetype?: string;
    caption?: string;
    fileName?: string;
  };
  contactId?: string | null;
  boletoId?: string | null;
  category?: SendCategory;
  billable?: boolean;
  bodyPreview?: string | null;
}): Promise<OutboundResult> {
  const provider = await activeProvider();
  const rawPhone = (opts.to.includes("@") ? opts.to.split("@")[0] : opts.to).replace(/\D/g, "");
  const phone = provider === "meta" ? MetaClient.toNumber(rawPhone) : rawPhone;
  const kind: SendKind =
    opts.kind ??
    (opts.template
      ? "template"
      : opts.media?.mediatype === "audio"
        ? "audio"
        : opts.media
          ? "media"
          : "text");

  const category: SendCategory =
    opts.category ??
    (kind === "template" ? "utility" : provider === "meta" ? "service" : "free");
  const billable =
    opts.billable ?? (provider === "meta" && category !== "free" && category !== "unknown");

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
        if (!opts.media.link) {
          const err = "Meta mídia exige link HTTPS público (media.link)";
          await prisma.whatsAppSendLog.update({
            where: { id: log.id },
            data: { status: "failed", error: err },
          });
          return { ok: false, externalId: null, error: err, provider, logId: log.id };
        }
        r = await meta.sendMediaLink({
          to: phone,
          mediatype: opts.media.mediatype,
          link: opts.media.link,
          caption: opts.media.caption,
          fileName: opts.media.fileName,
        });
      } else {
        r = await meta.sendText(phone, opts.text ?? "");
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
      r = await evolution.sendText(opts.to, opts.text ?? "");
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
