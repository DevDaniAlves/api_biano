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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, "../../../uploads");

export { listContactsForUser, assumeOnOpen, expireStaleRatings };

const RATING_MSG =
  "Como foi o atendimento? Responda com uma nota de *1* a *5* (sendo 5 excelente). Obrigado!";

const INACTIVITY_MSG =
  "Olá! Ainda está por aí? Caso precise de mais alguma informação, estamos à disposição.";

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

  const [msg] = await prisma.$transaction([
    prisma.whatsAppMessage.create({
      data: {
        contactId: contact.id,
        direction: "out",
        type: "text",
        body: text,
        sentById: opts.userId,
      },
    }),
    prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 120),
        status: "human",
        assignedToId: opts.userId,
      },
    }),
  ]);

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

  const [msg] = await prisma.$transaction([
    prisma.whatsAppMessage.create({
      data: {
        contactId: contact.id,
        direction: "out",
        type: "image",
        body: caption,
        mediaUrl: opts.publicUrl,
        sentById: opts.userId,
      },
    }),
    prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: caption.slice(0, 120),
        status: "human",
        assignedToId: opts.userId,
      },
    }),
  ]);

  return msg;
}

export async function assignContact(opts: {
  contactId: string;
  userId?: string | null;
  queueId?: string | null;
}) {
  return prisma.whatsAppContact.update({
    where: { id: opts.contactId },
    data: {
      ...(opts.userId !== undefined
        ? {
            assignedToId: opts.userId,
            status: opts.userId ? "human" : "waiting",
            offeredToId: null,
            openToAll: false,
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

  if (evolution.enabled) {
    await evolution.sendText(contact.phone, RATING_MSG);
  }

  await prisma.whatsAppMessage.create({
    data: {
      contactId,
      direction: "out",
      type: "text",
      body: RATING_MSG,
    },
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

  await prisma.whatsAppMessage.create({
    data: {
      contactId,
      direction: "out",
      type: "text",
      body: text,
      sentById: userId,
    },
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
    if (evolution.enabled) await evolution.sendText(contact.phone, hint);
    await prisma.whatsAppMessage.create({
      data: { contactId, direction: "out", type: "text", body: hint },
    });
    return;
  }

  const rating = Number(match[0]);
  const thanks = `Obrigado pela avaliação (*${rating}*)! Até logo.`;
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  if (evolution.enabled) await evolution.sendText(contact.phone, thanks);
  await prisma.whatsAppMessage.create({
    data: { contactId, direction: "out", type: "text", body: thanks },
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
  } else {
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
}

export async function getWhatsAppReports() {
  const byStatus = await prisma.whatsAppContact.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const rated = await prisma.whatsAppContact.findMany({
    where: { rating: { not: null } },
    select: { rating: true },
  });
  const avgRating =
    rated.length > 0
      ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
      : null;
  const messagesToday = await prisma.whatsAppMessage.count({
    where: {
      createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  });
  return {
    byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    avgRating,
    ratingsCount: rated.length,
    messagesToday,
  };
}
