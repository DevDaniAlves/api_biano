import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { applyMetaStatus } from "./gateway.js";
import { MetaClient, meta } from "./meta.js";
import { processInboundBot } from "./flow.js";

/** BR: Meta manda wa_id com 12 dígitos; envio usa 13 com 9º — unificar no contato canônico. */
function brPhoneVariants(raw: string): { canonical: string; alt: string | null } {
  const canonical = MetaClient.toNumber(raw);
  const digits = raw.replace(/\D/g, "");
  if (!canonical) return { canonical: digits, alt: null };
  let alt: string | null = null;
  if (canonical.startsWith("55") && canonical.length === 13 && canonical[4] === "9") {
    alt = `${canonical.slice(0, 4)}${canonical.slice(5)}`;
  } else if (digits.startsWith("55") && digits.length === 12) {
    alt = digits;
  }
  if (alt === canonical) alt = null;
  return { canonical, alt };
}

export async function resolveMetaContact(opts: {
  phone: string;
  profileName?: string | null;
  preview: string;
}) {
  const { canonical, alt } = brPhoneVariants(opts.phone);
  if (!canonical) return { contact: null as null, isNew: false };

  let contact = await prisma.whatsAppContact.findUnique({ where: { phone: canonical } });
  const altRow =
    !contact && alt
      ? await prisma.whatsAppContact.findUnique({ where: { phone: alt } })
      : alt && contact
        ? await prisma.whatsAppContact.findUnique({ where: { phone: alt } })
        : null;

  // Inbound antigo no 12 dígitos + conversa do agente no 13 → fundir no canônico.
  if (contact && altRow && altRow.id !== contact.id) {
    const dupes = await prisma.whatsAppMessage.findMany({
      where: { contactId: altRow.id },
      select: { id: true, externalId: true },
    });
    for (const m of dupes) {
      if (m.externalId) {
        const exists = await prisma.whatsAppMessage.findUnique({
          where: {
            contactId_externalId: { contactId: contact.id, externalId: m.externalId },
          },
        });
        if (exists) {
          await prisma.whatsAppMessage.delete({ where: { id: m.id } });
          continue;
        }
      }
      await prisma.whatsAppMessage.update({
        where: { id: m.id },
        data: { contactId: contact.id },
      });
    }
    await prisma.whatsAppContact.delete({ where: { id: altRow.id } }).catch(() => undefined);
  } else if (!contact && altRow) {
    contact = await prisma.whatsAppContact.update({
      where: { id: altRow.id },
      data: { phone: canonical },
    });
  }

  const isNew = !contact;
  const profileName = opts.profileName?.trim() || null;
  if (!contact) {
    contact = await prisma.whatsAppContact.create({
      data: {
        phone: canonical,
        pushName: profileName,
        name: profileName || canonical,
        status: "bot",
        lastMessageAt: new Date(),
        lastMessagePreview: opts.preview.slice(0, 120),
      },
    });
  } else if (profileName) {
    contact = await prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: { pushName: profileName },
    });
  }

  return { contact, isNew };
}

const MEDIA_TYPES = new Set(["image", "sticker", "audio", "video", "document"]);

function mediaPlaceholder(type: string) {
  if (type === "sticker") return "[figurinha]";
  if (type === "audio") return "[áudio]";
  if (type === "video") return "[vídeo]";
  if (type === "document") return "[documento]";
  if (type === "image") return "[imagem]";
  return `[${type}]`;
}

function parseMetaMedia(m: Record<string, unknown>, type: string) {
  const block = m[type];
  if (!block || typeof block !== "object") {
    return { mediaId: null as string | null, caption: null as string | null, fileName: null as string | null };
  }
  const b = block as {
    id?: string;
    caption?: string;
    filename?: string;
    mime_type?: string;
  };
  return {
    mediaId: b.id ? String(b.id) : null,
    caption: b.caption ? String(b.caption) : null,
    fileName: b.filename ? String(b.filename) : null,
  };
}

async function upsertInboundMessage(opts: {
  phone: string;
  body: string;
  type: string;
  externalId: string;
  profileName?: string | null;
  mediaUrl?: string | null;
  /** ID da mídia Graph (para retry se o download falhar). */
  metaMediaId?: string | null;
}) {
  const { contact, isNew } = await resolveMetaContact({
    phone: opts.phone,
    profileName: opts.profileName,
    preview: opts.body,
  });
  if (!contact) return;

  if (opts.externalId) {
    const existing = await prisma.whatsAppMessage.findUnique({
      where: { contactId_externalId: { contactId: contact.id, externalId: opts.externalId } },
    });
    if (existing) {
      if (
        MEDIA_TYPES.has(opts.type) &&
        opts.mediaUrl &&
        (!existing.mediaUrl || existing.mediaUrl.startsWith("meta-media:"))
      ) {
        await prisma.whatsAppMessage.update({
          where: { id: existing.id },
          data: {
            type: opts.type,
            body: opts.body,
            mediaUrl: opts.mediaUrl,
          },
        });
      }
      return;
    }
  }

  const mediaUrl =
    opts.mediaUrl ||
    (opts.metaMediaId ? `meta-media:${opts.metaMediaId}` : null);

  await prisma.whatsAppMessage.create({
    data: {
      contactId: contact.id,
      direction: "in",
      type: opts.type,
      body: opts.body,
      mediaUrl,
      externalId: opts.externalId || null,
    },
  });
  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: opts.body.slice(0, 120),
      unreadCount: { increment: 1 },
      lastClientMessageAt: new Date(),
    },
  });

  // Bot só processa texto / escolha de menu (caption de mídia não dispara menu).
  if (opts.type === "text" || opts.type === "button" || opts.type === "interactive") {
    await processInboundBot(contact.id, opts.body, isNew);
  }
}

/** Processa payload webhook Cloud API (messages + statuses). */
export async function handleMetaWebhook(payload: Record<string, unknown>) {
  const entry = Array.isArray(payload.entry) ? payload.entry : [];
  for (const ent of entry) {
    if (!ent || typeof ent !== "object") continue;
    const changes = Array.isArray((ent as { changes?: unknown[] }).changes)
      ? (ent as { changes: unknown[] }).changes
      : [];
    for (const ch of changes) {
      if (!ch || typeof ch !== "object") continue;
      const value = (ch as { value?: Record<string, unknown> }).value;
      if (!value || typeof value !== "object") continue;

      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const st of statuses) {
        if (!st || typeof st !== "object") continue;
        const s = st as Record<string, unknown>;
        const wamid = String(s.id ?? "");
        if (!wamid) continue;
        const pricing =
          s.pricing && typeof s.pricing === "object"
            ? (s.pricing as {
                billable?: boolean;
                category?: string;
                pricing_model?: string;
                type?: string;
              })
            : null;
        const errors = Array.isArray(s.errors) ? s.errors : [];
        const err0 =
          errors[0] && typeof errors[0] === "object"
            ? (errors[0] as {
                code?: number;
                title?: string;
                message?: string;
                error_data?: { details?: string };
              })
            : null;
        const errDetails = err0?.error_data?.details?.trim();
        const errMsg = [err0?.message, errDetails].filter(Boolean).join(" — ") || null;
        if (String(s.status ?? "") === "failed") {
          console.error(
            "[meta] status failed",
            String(s.id ?? "").slice(0, 40),
            err0?.code ?? "",
            errMsg ?? "(sem detalhe)"
          );
        }
        await applyMetaStatus({
          wamid,
          status: String(s.status ?? ""),
          pricing,
          error: errMsg,
        });
      }

      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const profileName =
        contacts[0] && typeof contacts[0] === "object"
          ? String(
              ((contacts[0] as { profile?: { name?: string } }).profile?.name ?? "") || ""
            )
          : "";

      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        const from = String(m.from ?? "").replace(/\D/g, "");
        const id = String(m.id ?? "");
        const type = String(m.type ?? "text");
        if (!from || !id) continue;

        if (type === "text" && m.text && typeof m.text === "object") {
          const body = String((m.text as { body?: string }).body ?? "");
          if (!body) continue;
          await upsertInboundMessage({
            phone: from,
            body,
            type: "text",
            externalId: id,
            profileName: profileName || null,
          });
          continue;
        }

        if (type === "button" && m.button && typeof m.button === "object") {
          const body = String((m.button as { text?: string }).text ?? "");
          if (!body) continue;
          await upsertInboundMessage({
            phone: from,
            body,
            type: "button",
            externalId: id,
            profileName: profileName || null,
          });
          continue;
        }

        if (type === "interactive" && m.interactive && typeof m.interactive === "object") {
          const inter = m.interactive as {
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
          const body = String(
            inter.button_reply?.id ??
              inter.list_reply?.id ??
              inter.button_reply?.title ??
              inter.list_reply?.title ??
              "[interactive]"
          );
          await upsertInboundMessage({
            phone: from,
            body,
            type: "interactive",
            externalId: id,
            profileName: profileName || null,
          });
          continue;
        }

        if (MEDIA_TYPES.has(type)) {
          const crmType = type === "sticker" ? "sticker" : type;
          const { mediaId, caption, fileName } = parseMetaMedia(m, type);
          const body = caption?.trim() || mediaPlaceholder(crmType);
          let mediaUrl: string | null = null;
          if (mediaId) {
            const saved = await meta.downloadMediaToUploads(mediaId, {
              type: crmType,
              fileName,
            });
            mediaUrl = saved?.localUrl ?? null;
            if (!mediaUrl) {
              console.warn("[meta] inbound media sem arquivo local", type, mediaId);
            }
          }
          await upsertInboundMessage({
            phone: from,
            body,
            type: crmType,
            externalId: id,
            profileName: profileName || null,
            mediaUrl,
            metaMediaId: mediaId,
          });
          continue;
        }

        // Outros tipos (reaction, location, contacts…) — placeholder texto.
        await upsertInboundMessage({
          phone: from,
          body: mediaPlaceholder(type),
          type: "text",
          externalId: id,
          profileName: profileName || null,
        });
      }
    }
  }
}

export async function getWhatsAppUsage(opts: { from?: Date; to?: Date }) {
  const to = opts.to ?? new Date();
  const from = opts.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const rows = await prisma.whatsAppSendLog.findMany({
    where: { createdAt: { gte: from, lte: to }, direction: "out" },
    select: {
      provider: true,
      source: true,
      category: true,
      billable: true,
      status: true,
      kind: true,
    },
  });

  const total = rows.length;
  const billable = rows.filter((r) => r.billable).length;
  const bySource: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byCategory[r.category || "unknown"] = (byCategory[r.category || "unknown"] ?? 0) + 1;
    byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  const rate = env.META_ESTIMATED_BRL_PER_MSG;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    total,
    billable,
    estimatedBrl: Math.round(billable * rate * 100) / 100,
    rateBrlPerMsg: rate,
    bySource,
    byCategory,
    byProvider,
    byStatus,
    note: "Estimativa até rate card oficial Meta (set/2026). A partir de out/2026 service + utility na janela passam a ser cobrados.",
  };
}
