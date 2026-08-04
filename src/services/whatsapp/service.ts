import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { evolution, EvolutionClient } from "./evolution.js";
import {
  assumeOnOpen,
  expireStaleRatings,
  listContactsForUser,
  processInboundBot,
} from "./flow.js";
import { assumeMetricStart } from "./schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, "../../../uploads");

export { listContactsForUser, assumeOnOpen, expireStaleRatings };

const RATING_MSG =
  "Como foi o atendimento? Responda com uma nota de *1* a *5* (sendo 5 excelente). Obrigado!";

const INACTIVITY_MSG =
  "Olá! Ainda está por aí? Caso precise de mais alguma informação, estamos à disposição.";

/** Grava out após envio, reutilizando eco do webhook se já chegou. */
async function upsertOutboundMessage(opts: {
  contactId: string;
  type: string;
  body: string | null;
  sentById?: string | null;
  externalId?: string | null;
  mediaUrl?: string | null;
}) {
  const since = new Date(Date.now() - 120_000);

  if (opts.externalId) {
    const byExt = await prisma.whatsAppMessage.findUnique({
      where: {
        contactId_externalId: {
          contactId: opts.contactId,
          externalId: opts.externalId,
        },
      },
    });
    if (byExt) {
      if (opts.sentById && !byExt.sentById) {
        return prisma.whatsAppMessage.update({
          where: { id: byExt.id },
          data: {
            sentById: opts.sentById,
            ...(opts.mediaUrl && !byExt.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
            ...(opts.body && !byExt.body ? { body: opts.body } : {}),
          },
        });
      }
      return byExt;
    }
  }

  const recent = await prisma.whatsAppMessage.findFirst({
    where: {
      contactId: opts.contactId,
      direction: "out",
      type: opts.type,
      createdAt: { gte: since },
      ...(opts.body != null ? { body: opts.body } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  if (recent) {
    return prisma.whatsAppMessage.update({
      where: { id: recent.id },
      data: {
        ...(opts.externalId && !recent.externalId ? { externalId: opts.externalId } : {}),
        ...(opts.sentById && !recent.sentById ? { sentById: opts.sentById } : {}),
        ...(opts.mediaUrl && !recent.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
      },
    });
  }

  return prisma.whatsAppMessage.create({
    data: {
      contactId: opts.contactId,
      direction: "out",
      type: opts.type,
      body: opts.body,
      mediaUrl: opts.mediaUrl ?? null,
      sentById: opts.sentById ?? null,
      externalId: opts.externalId || null,
    },
  });
}

export function contactFlags(contact: {
  status: string;
  lastClientMessageAt: Date | null;
  inactivityWarnedAt: Date | null;
}) {
  const now = Date.now();
  const lastClient = contact.lastClientMessageAt?.getTime() ?? 0;
  const inactiveMs = lastClient ? now - lastClient : 0;
  const warnMs = env.INACTIVITY_WARN_MINUTES * 60_000;
  const resolveMs = env.INACTIVITY_RESOLVE_MINUTES * 60_000;
  const isHuman = contact.status === "human";
  return {
    canWarnInactivity: isHuman && inactiveMs >= warnMs,
    canResolveInactivity: isHuman && inactiveMs >= resolveMs,
    inactiveMinutes: lastClient ? Math.floor(inactiveMs / 60_000) : 0,
  };
}

export async function listContacts(opts: {
  userId: string;
  role: "admin" | "seller";
  status?: string;
  search?: string;
}) {
  const contacts = await listContactsForUser(opts);
  return contacts.map((c) => ({
    ...c,
    ...contactFlags(c),
  }));
}

export async function listMessages(
  contactId: string,
  userId: string,
  role: "admin" | "seller" = "seller",
  opts?: { assume?: boolean }
) {
  if (opts?.assume !== false) {
    await assumeOnOpen(contactId, userId, role);
  }
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const messages = await prisma.whatsAppMessage.findMany({
    where: { contactId },
    orderBy: { createdAt: "asc" },
    include: { sentBy: { select: { id: true, name: true } } },
  });
  return {
    contact: {
      ...contact,
      ...contactFlags(contact),
    },
    messages,
    readOnly: contact.status === "closed" || contact.status === "awaiting_rating",
  };
}

async function sellerPrefix(userId: string, body: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return `*${user.name}:*\n${body}`;
}

export async function sendTextMessage(opts: {
  contactId: string;
  body: string;
  userId: string;
  role?: "admin" | "seller";
}) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (contact.status === "closed" || contact.status === "awaiting_rating") {
    throw new Error("Conversa finalizada — somente leitura");
  }

  const alreadyMine =
    contact.status === "human" && contact.assignedToId === opts.userId;
  if (!alreadyMine) {
    await assumeOnOpen(opts.contactId, opts.userId, opts.role ?? "seller");
  }

  if (!evolution.enabled) throw new Error("Evolution não configurada");

  const text = await sellerPrefix(opts.userId, opts.body);
  const r = await evolution.sendText(contact.phone, text);
  if (!r.ok) throw new Error(`Falha Evolution: ${r.status}`);

  const externalId = EvolutionClient.extractMessageId(r.data);
  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: "text",
    body: text,
    sentById: opts.userId,
    externalId,
  });
  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 120),
      status: "human",
      assignedToId: opts.userId,
    },
  });

  return msg;
}

export async function sendImageMessage(opts: {
  contactId: string;
  userId: string;
  role?: "admin" | "seller";
  filePath: string;
  mimetype: string;
  fileName: string;
  caption?: string;
  publicUrl: string;
}) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (contact.status === "closed" || contact.status === "awaiting_rating") {
    throw new Error("Conversa finalizada — somente leitura");
  }
  const alreadyMine =
    contact.status === "human" && contact.assignedToId === opts.userId;
  if (!alreadyMine) {
    await assumeOnOpen(opts.contactId, opts.userId, opts.role ?? "seller");
  }
  if (!evolution.enabled) throw new Error("Evolution não configurada");

  const caption = opts.caption
    ? await sellerPrefix(opts.userId, opts.caption)
    : await sellerPrefix(opts.userId, "[imagem]");

  const buf = fs.readFileSync(opts.filePath);
  const b64 = buf.toString("base64");

  const r = await evolution.sendMedia({
    phone: contact.phone,
    media: b64,
    mimetype: opts.mimetype,
    caption,
    fileName: opts.fileName,
    mediatype: "image",
  });
  if (!r.ok) throw new Error(`Falha Evolution mídia: ${r.status} ${r.text.slice(0, 200)}`);

  const externalId = EvolutionClient.extractMessageId(r.data);
  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: "image",
    body: caption,
    mediaUrl: opts.publicUrl,
    sentById: opts.userId,
    externalId,
  });
  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: caption.slice(0, 120),
      status: "human",
      assignedToId: opts.userId,
    },
  });

  return msg;
}

export async function assignContact(opts: {
  contactId: string;
  userId?: string | null;
  queueId?: string | null;
}) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  const now = new Date();
  let assumeWaitSeconds: number | undefined;
  let assignedAt: Date | undefined;

  if (opts.userId) {
    const start = assumeMetricStart(
      {
        openToAll: contact.openToAll,
        firstOfferedAt: contact.firstOfferedAt,
        firstOfferedToId: contact.firstOfferedToId,
        openedToAllAt: contact.openedToAllAt,
        offeredAt: contact.offeredAt,
        createdAt: contact.createdAt,
      },
      opts.userId
    );
    assumeWaitSeconds = Math.max(0, Math.round((now.getTime() - start.getTime()) / 1000));
    assignedAt = contact.assignedAt ?? now;
  }

  return prisma.whatsAppContact.update({
    where: { id: opts.contactId },
    data: {
      ...(opts.userId !== undefined
        ? {
            assignedToId: opts.userId,
            status: opts.userId ? "human" : "waiting",
            offeredToId: null,
            openToAll: false,
            ...(opts.userId
              ? {
                  assignedAt,
                  assumeWaitSeconds: contact.assumeWaitSeconds ?? assumeWaitSeconds,
                }
              : { assignedAt: null, assumeWaitSeconds: null }),
          }
        : {}),
      ...(opts.queueId !== undefined ? { queueId: opts.queueId } : {}),
    },
    include: {
      assignedTo: { select: { id: true, name: true } },
      queue: { select: { id: true, name: true } },
    },
  });
}

/** Finaliza atendimento e pede avaliação (1–5). */
export async function resolveContact(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });

  let externalId: string | null = null;
  if (evolution.enabled) {
    const r = await evolution.sendText(contact.phone, RATING_MSG);
    externalId = EvolutionClient.extractMessageId(r.data);
  }

  await upsertOutboundMessage({
    contactId,
    type: "text",
    body: RATING_MSG,
    externalId,
  });

  return prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "awaiting_rating",
      ratingAskedAt: new Date(),
      rating: null,
      offeredToId: null,
      openToAll: false,
      lastMessageAt: new Date(),
      lastMessagePreview: RATING_MSG.slice(0, 120),
    },
  });
}

/** Aviso de inatividade (somente se ≥ 10 min sem msg do cliente). */
export async function warnInactivity(contactId: string, userId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const flags = contactFlags(contact);
  if (!flags.canWarnInactivity) {
    throw new Error(
      `Cliente inativo há menos de ${env.INACTIVITY_WARN_MINUTES} minutos`
    );
  }
  if (!evolution.enabled) throw new Error("Evolution não configurada");

  const text = await sellerPrefix(userId, INACTIVITY_MSG);
  const r = await evolution.sendText(contact.phone, text);
  if (!r.ok) throw new Error(`Falha Evolution: ${r.status}`);

  await upsertOutboundMessage({
    contactId,
    type: "text",
    body: text,
    sentById: userId,
    externalId: EvolutionClient.extractMessageId(r.data),
  });

  return prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      inactivityWarnedAt: new Date(),
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 120),
    },
  });
}

async function handleRatingReply(contactId: string, body: string | null) {
  const match = body?.trim().match(/^[1-5]$/);
  if (!match) {
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    const hint = "Por favor, responda apenas com um número de *1* a *5*.";
    let externalId: string | null = null;
    if (evolution.enabled) {
      const r = await evolution.sendText(contact.phone, hint);
      externalId = EvolutionClient.extractMessageId(r.data);
    }
    await upsertOutboundMessage({
      contactId,
      type: "text",
      body: hint,
      externalId,
    });
    return;
  }

  const rating = Number(match[0]);
  const thanks = `Obrigado pela avaliação (*${rating}*)! Até logo.`;
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  let externalId: string | null = null;
  if (evolution.enabled) {
    const r = await evolution.sendText(contact.phone, thanks);
    externalId = EvolutionClient.extractMessageId(r.data);
  }
  await upsertOutboundMessage({
    contactId,
    type: "text",
    body: thanks,
    externalId,
  });
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      rating,
      status: "closed",
      lastMessageAt: new Date(),
      lastMessagePreview: thanks.slice(0, 120),
      offeredToId: null,
      openToAll: false,
    },
  });
}

/** Webhook Evolution MESSAGES_UPSERT */
export async function handleEvolutionWebhook(payload: Record<string, unknown>) {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const key = (data.key ?? {}) as Record<string, unknown>;
  const fromMe = Boolean(key.fromMe);
  const remoteJid = String(key.remoteJid ?? "");
  if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === "status@broadcast") return;

  const phone = EvolutionClient.phoneFromJid(remoteJid);
  if (!phone) return;

  const message = (data.message ?? {}) as Record<string, unknown>;
  const pushName = (data.pushName as string) || null;
  const externalId = String(key.id ?? "");

  let type = "text";
  let body: string | null = null;
  let mediaUrl: string | null = null;

  if (typeof message.conversation === "string") {
    body = message.conversation;
  } else if (message.extendedTextMessage && typeof message.extendedTextMessage === "object") {
    body = String((message.extendedTextMessage as { text?: string }).text ?? "");
  } else if (message.imageMessage) {
    type = "image";
    const img = message.imageMessage as { caption?: string; url?: string };
    body = img.caption ?? "[imagem]";
    mediaUrl = img.url ?? null;
  } else if (message.audioMessage) {
    type = "audio";
    body = "[áudio]";
  } else if (message.videoMessage) {
    type = "video";
    body = "[vídeo]";
  } else if (message.documentMessage) {
    type = "document";
    body = String((message.documentMessage as { fileName?: string }).fileName ?? "[documento]");
  } else {
    body = "[mensagem]";
  }

  const existingContact = await prisma.whatsAppContact.findUnique({ where: { phone } });
  const isNew = !existingContact;

  const contact = await prisma.whatsAppContact.upsert({
    where: { phone },
    create: {
      phone,
      remoteJid,
      name: pushName,
      status: "bot",
      lastMessageAt: new Date(),
      lastMessagePreview: (body ?? "").slice(0, 120),
      lastClientMessageAt: fromMe ? null : new Date(),
      unreadCount: fromMe ? 0 : 1,
    },
    update: {
      remoteJid,
      ...(pushName ? { name: pushName } : {}),
      lastMessageAt: new Date(),
      lastMessagePreview: (body ?? "").slice(0, 120),
      ...(!fromMe
        ? { unreadCount: { increment: 1 }, lastClientMessageAt: new Date() }
        : {}),
    },
  });

  if (externalId) {
    const dup = await prisma.whatsAppMessage.findUnique({
      where: { contactId_externalId: { contactId: contact.id, externalId } },
    });
    if (dup) return;
  }

  if (!fromMe) {
    await prisma.whatsAppMessage.create({
      data: {
        contactId: contact.id,
        externalId: externalId || null,
        direction: "in",
        type,
        body,
        mediaUrl,
      },
    });

    const fresh = await prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contact.id } });

    if (fresh.status === "awaiting_rating") {
      await handleRatingReply(contact.id, body);
      return;
    }

    if (isNew || fresh.status === "bot" || fresh.status === "closed") {
      await processInboundBot(contact.id, body, isNew || fresh.status === "closed");
    }
    return;
  }

  // fromMe: eco da Evolution — não criar de novo se a API já gravou o envio
  const since = new Date(Date.now() - 120_000);
  let recentOut = body
    ? await prisma.whatsAppMessage.findFirst({
        where: {
          contactId: contact.id,
          direction: "out",
          type,
          body,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (!recentOut) {
    recentOut = await prisma.whatsAppMessage.findFirst({
      where: {
        contactId: contact.id,
        direction: "out",
        type,
        externalId: null,
        createdAt: { gte: since },
        ...(body ? { body } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  }

  if (!recentOut && (type === "image" || type === "video" || type === "audio")) {
    recentOut = await prisma.whatsAppMessage.findFirst({
      where: {
        contactId: contact.id,
        direction: "out",
        type,
        externalId: null,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  if (recentOut) {
    if (externalId && !recentOut.externalId) {
      try {
        await prisma.whatsAppMessage.update({
          where: { id: recentOut.id },
          data: { externalId },
        });
      } catch {
        /* unique race */
      }
    }
    return;
  }

  await prisma.whatsAppMessage.create({
    data: {
      contactId: contact.id,
      externalId: externalId || null,
      direction: "out",
      type,
      body,
      mediaUrl,
    },
  });
}

export async function getWhatsAppReports() {
  const byStatus = await prisma.whatsAppContact.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  const rated = await prisma.whatsAppContact.findMany({
    where: { rating: { not: null } },
    select: {
      rating: true,
      assignedToId: true,
      assignedTo: { select: { id: true, name: true } },
      ratingAskedAt: true,
      phone: true,
      name: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const avgRating =
    rated.length > 0
      ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
      : null;

  const ratingDistribution: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
  };
  for (const r of rated) {
    const k = String(r.rating ?? "");
    if (k in ratingDistribution) ratingDistribution[k] += 1;
  }

  const bySellerMap = new Map<
    string,
    { sellerId: string; sellerName: string; count: number; sum: number }
  >();
  for (const r of rated) {
    const id = r.assignedToId ?? "sem-vendedor";
    const name = r.assignedTo?.name ?? "Sem vendedor";
    const cur = bySellerMap.get(id) ?? { sellerId: id, sellerName: name, count: 0, sum: 0 };
    cur.count += 1;
    cur.sum += r.rating ?? 0;
    bySellerMap.set(id, cur);
  }
  const ratingsBySeller = [...bySellerMap.values()]
    .map((s) => ({
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      count: s.count,
      avgRating: s.count ? s.sum / s.count : null,
    }))
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0));

  const assumed = await prisma.whatsAppContact.findMany({
    where: { assumeWaitSeconds: { not: null }, assignedToId: { not: null } },
    select: {
      assumeWaitSeconds: true,
      assignedToId: true,
      assignedTo: { select: { id: true, name: true } },
      firstOfferedToId: true,
      openedToAllAt: true,
    },
  });

  const assumeAll = assumed.map((c) => c.assumeWaitSeconds ?? 0);
  const avgAssumeSeconds =
    assumeAll.length > 0
      ? Math.round(assumeAll.reduce((a, b) => a + b, 0) / assumeAll.length)
      : null;

  const assumeBySellerMap = new Map<
    string,
    { sellerId: string; sellerName: string; count: number; sum: number }
  >();
  for (const c of assumed) {
    const id = c.assignedToId!;
    const name = c.assignedTo?.name ?? "—";
    const cur = assumeBySellerMap.get(id) ?? {
      sellerId: id,
      sellerName: name,
      count: 0,
      sum: 0,
    };
    cur.count += 1;
    cur.sum += c.assumeWaitSeconds ?? 0;
    assumeBySellerMap.set(id, cur);
  }
  const assumeBySeller = [...assumeBySellerMap.values()]
    .map((s) => ({
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      count: s.count,
      avgSeconds: s.count ? Math.round(s.sum / s.count) : null,
    }))
    .sort((a, b) => (a.avgSeconds ?? 0) - (b.avgSeconds ?? 0));

  const messagesToday = await prisma.whatsAppMessage.count({
    where: {
      createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  });

  return {
    byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    avgRating,
    ratingsCount: rated.length,
    ratingDistribution,
    ratingsBySeller,
    recentRatings: rated.slice(0, 20).map((r) => ({
      rating: r.rating,
      sellerName: r.assignedTo?.name ?? null,
      contactName: r.name,
      phone: r.phone,
      at: r.updatedAt,
    })),
    avgAssumeSeconds,
    assumeCount: assumed.length,
    assumeBySeller,
    messagesToday,
  };
}
