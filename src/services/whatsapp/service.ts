import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../db.js";
import { evolution, EvolutionClient } from "./evolution.js";
import { assumeOnOpen, listContactsForUser, processInboundBot } from "./flow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, "../../../uploads");

export { listContactsForUser, assumeOnOpen };

export async function listContacts(opts: {
  userId: string;
  role: "admin" | "seller";
  status?: string;
  search?: string;
}) {
  return listContactsForUser(opts);
}

export async function listMessages(
  contactId: string,
  userId: string,
  role: "admin" | "seller" = "seller"
) {
  await assumeOnOpen(contactId, userId, role);
  return prisma.whatsAppMessage.findMany({
    where: { contactId },
    orderBy: { createdAt: "asc" },
    include: { sentBy: { select: { id: true, name: true } } },
  });
}

export async function sendTextMessage(opts: {
  contactId: string;
  body: string;
  userId: string;
  role?: "admin" | "seller";
}) {
  await assumeOnOpen(opts.contactId, opts.userId, opts.role ?? "seller");
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (!evolution.enabled) throw new Error("Evolution não configurada");

  const r = await evolution.sendText(contact.phone, opts.body);
  if (!r.ok) throw new Error(`Falha Evolution: ${r.status}`);

  const msg = await prisma.whatsAppMessage.create({
    data: {
      contactId: contact.id,
      direction: "out",
      type: "text",
      body: opts.body,
      sentById: opts.userId,
    },
  });

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: opts.body.slice(0, 120),
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
  await assumeOnOpen(opts.contactId, opts.userId, opts.role ?? "seller");
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (!evolution.enabled) throw new Error("Evolution não configurada");

  const buf = fs.readFileSync(opts.filePath);
  const b64 = buf.toString("base64");

  const r = await evolution.sendMedia({
    phone: contact.phone,
    media: b64,
    mimetype: opts.mimetype,
    caption: opts.caption,
    fileName: opts.fileName,
    mediatype: "image",
  });
  if (!r.ok) throw new Error(`Falha Evolution mídia: ${r.status} ${r.text.slice(0, 200)}`);

  const msg = await prisma.whatsAppMessage.create({
    data: {
      contactId: contact.id,
      direction: "out",
      type: "image",
      body: opts.caption ?? null,
      mediaUrl: opts.publicUrl,
      sentById: opts.userId,
    },
  });

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: opts.caption || "[imagem]",
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

export async function resolveContact(contactId: string) {
  return prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "closed",
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
      unreadCount: fromMe ? 0 : 1,
    },
    update: {
      remoteJid,
      ...(pushName ? { name: pushName } : {}),
      lastMessageAt: new Date(),
      lastMessagePreview: (body ?? "").slice(0, 120),
      ...(!fromMe ? { unreadCount: { increment: 1 } } : {}),
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
    // Bot / novo / reaberto; fora do horário o fluxo avisa e deixa na fila
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
