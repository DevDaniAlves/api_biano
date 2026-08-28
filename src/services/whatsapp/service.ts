import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { notifyUsersSafe, recipientIdsForOpenQueue } from "../push.js";
import { submitSellerPhotoToGallery } from "../gallery.js";
import { evolution, EvolutionClient } from "./evolution.js";
import { activeProvider, messagingEnabled, sendOutbound } from "./gateway.js";
import { meta } from "./meta.js";
import {
  assumeOnOpen,
  expireStaleRatings,
  listContactsForUser,
  maybeCloseForClientIdle,
  processInboundBot,
  setWebhookPaused,
} from "./flow.js";
import { contactDisplayName, saveContactSavedName, serializeContact } from "./contacts.js";
import { assumeMetricStart } from "./schedule.js";

export const UPLOADS_DIR = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), "uploads"));

export { listContactsForUser, assumeOnOpen, expireStaleRatings, openContactToAllSellers } from "./flow.js";
export { saveContactSavedName } from "./contacts.js";

/** Atualiza metadados do contato após nova mensagem (direção define quem deve responder). */
export async function touchContactAfterMessage(
  contactId: string,
  direction: "in" | "out",
  preview: string
) {
  const now = new Date();
  const base = {
    lastMessageAt: now,
    lastMessagePreview: preview.slice(0, 120),
    lastMessageDirection: direction,
  };
  if (direction === "in") {
    await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        ...base,
        lastClientMessageAt: now,
        inactivityWarnedAt: null,
        sellerInactivityNotifiedAt: null,
        boletoReminderAt: null,
      },
    });
  } else {
    await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        ...base,
        inactivityWarnedAt: null,
        sellerInactivityNotifiedAt: null,
      },
    });
  }
}

async function ensureLastMessageDirection(contactId: string): Promise<"in" | "out" | null> {
  const row = await prisma.whatsAppContact.findUnique({
    where: { id: contactId },
    select: { lastMessageDirection: true },
  });
  if (row?.lastMessageDirection) return row.lastMessageDirection;
  const last = await prisma.whatsAppMessage.findFirst({
    where: { contactId },
    orderBy: [{ createdAt: "desc" }],
    select: { direction: true },
  });
  if (!last) return null;
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: { lastMessageDirection: last.direction },
  });
  return last.direction;
}

function waitingOnClient(contact: { lastMessageDirection?: "in" | "out" | null }) {
  return contact.lastMessageDirection === "out";
}

function waitingOnSeller(contact: { lastMessageDirection?: "in" | "out" | null }) {
  return contact.lastMessageDirection === "in";
}

const RATING_MSG =
  "Como foi o atendimento? Responda com uma nota de *1* a *5* (sendo 5 excelente). Obrigado!";

const INACTIVITY_RECOVERY_MSG = "Olá! Você ainda está por aí? 😊";

const INACTIVITY_CLOSE_MSG =
  "Como não recebemos retorno, vamos encerrar este atendimento por enquanto.\n\nQuando quiser falar conosco de novo, é só enviar uma mensagem. Até logo! 👋";

/** @deprecated use INACTIVITY_RECOVERY_MSG */
const INACTIVITY_MSG = INACTIVITY_RECOVERY_MSG;

function mimeExt(mimetype?: string | null, type?: string, fileName?: string | null) {
  const fromName = fileName?.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const m = (mimetype || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("msword") || m.includes("wordprocessingml")) return "docx";
  if (m.includes("spreadsheet") || m.includes("excel")) return "xlsx";
  if (m.includes("mp4") || type === "video") return "mp4";
  if (m.includes("mpeg") && type === "audio") return "mp3";
  if (m.includes("ogg") || m.includes("opus") || type === "audio") return "ogg";
  if (type === "document") return "bin";
  if (type === "audio") return "ogg";
  return "jpg";
}

function saveBuffer(
  buf: Buffer,
  mimetype?: string | null,
  type?: string,
  fileName?: string | null
) {
  if (buf.length < 40) return null;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${mimeExt(mimetype, type, fileName)}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
  return `/uploads/${name}`;
}

function saveBase64Media(
  b64: string,
  mimetype?: string | null,
  type?: string,
  fileName?: string | null
) {
  const raw = b64.replace(/^data:[^;]+;base64,/, "");
  return saveBuffer(Buffer.from(raw, "base64"), mimetype, type, fileName);
}

function localFileName(url: string) {
  const name = url.replace(/^\/uploads\//, "").split("?")[0];
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  return name;
}

function localUploadExists(url?: string | null) {
  if (!url?.startsWith("/uploads/")) return false;
  const name = localFileName(url);
  if (!name) return false;
  try {
    return fs.statSync(path.join(UPLOADS_DIR, name)).size > 40;
  } catch {
    return false;
  }
}

async function saveRemoteUrl(url: string, type: string, fileName?: string | null) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return saveBuffer(buf, res.headers.get("content-type"), type, fileName);
  } catch {
    return null;
  }
}

function unwrapWaMessage(message: Record<string, unknown>): Record<string, unknown> {
  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
    "editedMessage",
  ];
  for (const w of wrappers) {
    const inner = message[w];
    if (inner && typeof inner === "object") {
      const msg = (inner as { message?: Record<string, unknown> }).message;
      if (msg) return unwrapWaMessage(msg);
    }
  }
  return message;
}

function quotePreviewFromMessage(quoted: Record<string, unknown> | null | undefined) {
  if (!quoted) return null;
  const q = unwrapWaMessage(quoted);
  if (typeof q.conversation === "string" && q.conversation.trim()) return q.conversation;
  const ext = q.extendedTextMessage;
  if (ext && typeof ext === "object") {
    const text = (ext as { text?: string }).text;
    if (text) return text;
  }
  if (q.imageMessage) {
    const cap = (q.imageMessage as { caption?: string }).caption;
    return cap?.trim() || "[imagem]";
  }
  if (q.videoMessage) {
    const cap = (q.videoMessage as { caption?: string }).caption;
    return cap?.trim() || "[vídeo]";
  }
  if (q.audioMessage || q.pttMessage) return "[áudio]";
  if (q.documentMessage) {
    return String((q.documentMessage as { fileName?: string }).fileName ?? "[documento]");
  }
  if (q.stickerMessage) return "[figurinha]";
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

function quotedKind(quoted: Record<string, unknown> | null | undefined) {
  if (!quoted) return null;
  const q = unwrapWaMessage(quoted);
  if (q.imageMessage) return "image";
  if (q.stickerMessage) return "sticker";
  if (q.videoMessage) return "video";
  if (q.audioMessage || q.pttMessage) return "audio";
  if (q.documentMessage) return "document";
  return "text";
}

function saveQuoteThumb(quoted: Record<string, unknown> | null | undefined) {
  if (!quoted) return null;
  const q = unwrapWaMessage(quoted);
  const node = (q.imageMessage || q.stickerMessage || q.videoMessage || {}) as {
    jpegThumbnail?: unknown;
  };
  const thumb = node.jpegThumbnail;
  if (!thumb) return null;
  if (typeof thumb === "string" && thumb.length > 40) {
    return saveBase64Media(thumb, "image/jpeg", "image");
  }
  if (thumb && typeof thumb === "object") {
    const bufLike = thumb as { type?: string; data?: number[] };
    if (Array.isArray(bufLike.data)) return saveBuffer(Buffer.from(bufLike.data), "image/jpeg", "image");
  }
  if (Array.isArray(thumb)) return saveBuffer(Buffer.from(thumb as number[]), "image/jpeg", "image");
  return null;
}

type QuoteInfo = {
  stanzaId: string | null;
  preview: string | null;
  quotedType: string | null;
  quotedMediaUrl: string | null;
};

function extractQuote(message: Record<string, unknown>, data: Record<string, unknown>): QuoteInfo {
  const skip = new Set([
    "deviceListMetadata",
    "messageSecret",
    "jpegThumbnail",
    "thumbnailDirectPath",
    "mediaKey",
    "waveform",
  ]);
  function walk(node: unknown, depth: number): QuoteInfo | null {
    node = parseMaybeJson(node);
    if (!node || typeof node !== "object" || depth > 8) return null;
    if (ArrayBuffer.isView(node)) return null;
    const o = node as Record<string, unknown>;
    const stanzaId = String(o.stanzaId ?? o.stanzaID ?? o.quotedStanzaID ?? o.quotedId ?? "").trim();
    const quoted = parseMaybeJson(o.quotedMessage ?? o.quotedMsg ?? o.quoted) as
      | Record<string, unknown>
      | undefined;
    const quotedObj = quoted && typeof quoted === "object" && !Array.isArray(quoted) ? quoted : undefined;
    const preview = quotePreviewFromMessage(quotedObj);
    if (stanzaId || preview) {
      return {
        stanzaId: stanzaId || null,
        preview,
        quotedType: quotedKind(quotedObj),
        quotedMediaUrl: saveQuoteThumb(quotedObj),
      };
    }
    for (const [k, v] of Object.entries(o)) {
      if (skip.has(k) || v == null || typeof v !== "object") continue;
      const found = walk(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return (
    walk(
      {
        message,
        data,
        contextInfo: parseMaybeJson(data.contextInfo),
        quoted: data.quoted,
      },
      0
    ) ?? {
      stanzaId: null,
      preview: null,
      quotedType: null,
      quotedMediaUrl: null,
    }
  );
}

async function resolveMediaFile(opts: {
  type: string;
  remoteJid: string;
  fromMe: boolean;
  externalId: string;
  message: Record<string, unknown>;
  data: Record<string, unknown>;
  fallbackUrl?: string | null;
  fileName?: string | null;
}) {
  if (!["image", "video", "sticker", "audio", "document"].includes(opts.type)) return null;
  const inline =
    (typeof opts.data.base64 === "string" && opts.data.base64) ||
    (typeof opts.message.base64 === "string" && opts.message.base64) ||
    "";
  if (inline.length > 80) {
    const saved = saveBase64Media(inline, null, opts.type, opts.fileName);
    if (saved) return saved;
  }
  if (opts.externalId && evolution.enabled) {
    const r = await evolution.getBase64FromMedia({
      remoteJid: opts.remoteJid,
      fromMe: opts.fromMe,
      id: opts.externalId,
      message: opts.message,
      data: opts.data,
    });
    const extracted = EvolutionClient.extractMediaBase64(r.data);
    if (extracted) {
      const saved = saveBase64Media(extracted.base64, extracted.mimetype, opts.type, opts.fileName);
      if (saved) return saved;
    } else if (!r.ok) {
      console.warn("[media] getBase64 falhou", r.status, (r.text || "").slice(0, 180));
    }
  }
  const url = opts.fallbackUrl || "";
  if (url.startsWith("http")) {
    const saved = await saveRemoteUrl(url, opts.type, opts.fileName);
    if (saved) return saved;
  }
  if (url.startsWith("/uploads/") && localUploadExists(url)) return url;
  return null;
}

function takeAssumirCommand(text: string | null) {
  if (!text) return { assumed: false, cleaned: text };
  if (!/#assumir\b/i.test(text)) return { assumed: false, cleaned: text };
  const cleaned = text
    .replace(/#assumir\b/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { assumed: true, cleaned: cleaned || null };
}

/** Grava out após envio, reutilizando eco do webhook se já chegou. */
async function upsertOutboundMessage(opts: {
  contactId: string;
  type: string;
  body: string | null;
  sentById?: string | null;
  externalId?: string | null;
  mediaUrl?: string | null;
  clientKey?: string | null;
  quotedExternalId?: string | null;
  quotedBody?: string | null;
  quotedType?: string | null;
  quotedMediaUrl?: string | null;
}) {
  const since = new Date(Date.now() - 120_000);
  const clientKey = (opts.clientKey || "").trim() || null;

  if (clientKey) {
    const byKey = await prisma.whatsAppMessage.findUnique({
      where: {
        contactId_clientKey: { contactId: opts.contactId, clientKey },
      },
    });
    if (byKey) {
      return prisma.whatsAppMessage.update({
        where: { id: byKey.id },
        data: {
          ...(opts.externalId && !byKey.externalId ? { externalId: opts.externalId } : {}),
          ...(opts.sentById && !byKey.sentById ? { sentById: opts.sentById } : {}),
          ...(opts.mediaUrl && !localUploadExists(byKey.mediaUrl) ? { mediaUrl: opts.mediaUrl } : {}),
          ...(opts.body && !byKey.body ? { body: opts.body } : {}),
        },
      });
    }
  }

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
      const data = {
        ...(opts.sentById && !byExt.sentById ? { sentById: opts.sentById } : {}),
        ...(opts.mediaUrl && !localUploadExists(byExt.mediaUrl) ? { mediaUrl: opts.mediaUrl } : {}),
        ...(opts.body && !byExt.body ? { body: opts.body } : {}),
        ...(clientKey && !byExt.clientKey ? { clientKey } : {}),
      };
      if (Object.keys(data).length) {
        return prisma.whatsAppMessage.update({ where: { id: byExt.id }, data });
      }
      return byExt;
    }
  }

  // Com clientKey: sempre cria linha nova (1 request = 1 mensagem).
  // Sem key: mantém merge antigo só para eco webhook de texto.
  if (!clientKey) {
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
      const isMedia = ["image", "video", "audio", "document"].includes(opts.type);
      const differentMediaFile =
        isMedia &&
        Boolean(opts.mediaUrl) &&
        Boolean(recent.mediaUrl) &&
        opts.mediaUrl !== recent.mediaUrl &&
        localUploadExists(recent.mediaUrl);
      const differentExternal =
        Boolean(opts.externalId) &&
        Boolean(recent.externalId) &&
        opts.externalId !== recent.externalId;

      if (!differentMediaFile && !differentExternal) {
        return prisma.whatsAppMessage.update({
          where: { id: recent.id },
          data: {
            ...(opts.externalId && !recent.externalId ? { externalId: opts.externalId } : {}),
            ...(opts.sentById && !recent.sentById ? { sentById: opts.sentById } : {}),
            ...(opts.mediaUrl && !localUploadExists(recent.mediaUrl)
              ? { mediaUrl: opts.mediaUrl }
              : {}),
          },
        });
      }
    }
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
      clientKey,
      quotedExternalId: opts.quotedExternalId ?? null,
      quotedBody: opts.quotedBody ?? null,
      quotedType: opts.quotedType ?? null,
      quotedMediaUrl: opts.quotedMediaUrl ?? null,
    },
  });
}

/** Grava conversa do disparo de boleto para aparecer no menu WhatsApp (admin). */
export async function recordBoletoDispatchConversation(opts: {
  phone: string;
  clienteNome: string;
  bodyPreview: string;
  externalId?: string | null;
  boletoId: string;
  logId?: string;
}) {
  const phone = opts.phone.replace(/\D/g, "");
  if (phone.length < 12) return null;

  const nome = opts.clienteNome.trim();
  const preview = opts.bodyPreview.replace(/\s+/g, " ").trim().slice(0, 120);
  const now = new Date();

  const existing = await prisma.whatsAppContact.findUnique({ where: { phone } });
  const contact = await prisma.whatsAppContact.upsert({
    where: { phone },
    create: {
      phone,
      remoteJid: `${phone}@s.whatsapp.net`,
      savedName: nome || null,
      pushName: nome || null,
      name: nome || null,
      status: "closed",
      botFlow: "financeiro",
      lastMessageAt: now,
      lastMessagePreview: preview,
      boletoReminderAt: now,
    },
    update: {
      lastMessageAt: now,
      lastMessagePreview: preview,
      boletoReminderAt: now,
      ...(nome && !existing?.savedName ? { savedName: nome } : {}),
      ...(nome && !existing?.name ? { name: nome } : {}),
      ...(nome && !existing?.pushName ? { pushName: nome } : {}),
      ...(!existing?.botFlow ? { botFlow: "financeiro" as const } : {}),
    },
  });

  await upsertOutboundMessage({
    contactId: contact.id,
    type: "template",
    body: opts.bodyPreview,
    externalId: opts.externalId ?? null,
    clientKey: `boleto-${opts.boletoId}`,
  });

  if (opts.logId) {
    await prisma.whatsAppSendLog.update({
      where: { id: opts.logId },
      data: { contactId: contact.id },
    });
  } else {
    await prisma.whatsAppSendLog.updateMany({
      where: { boletoId: opts.boletoId, contactId: null },
      data: { contactId: contact.id },
    });
  }

  return contact.id;
}

export function contactFlags(contact: {
  status: string;
  lastClientMessageAt: Date | null;
  lastMessageAt: Date | null;
  lastMessageDirection?: "in" | "out" | null;
  inactivityWarnedAt: Date | null;
}) {
  const now = Date.now();
  const warnMs = env.INACTIVITY_WARN_MINUTES * 60_000;
  const resolveMs = env.INACTIVITY_RESOLVE_MINUTES * 60_000;
  const isHuman = contact.status === "human";
  const onClient = waitingOnClient(contact);
  const onSeller = waitingOnSeller(contact);

  const lastOut = onClient ? (contact.lastMessageAt?.getTime() ?? 0) : 0;
  const clientInactiveMs = lastOut ? now - lastOut : 0;

  const lastClient = contact.lastClientMessageAt?.getTime() ?? 0;
  const sellerInactiveMs = onSeller && lastClient ? now - lastClient : 0;

  return {
    waitingOn: onClient ? ("client" as const) : onSeller ? ("seller" as const) : null,
    canWarnInactivity: isHuman && onClient && clientInactiveMs >= warnMs,
    canResolveInactivity: isHuman && onClient && clientInactiveMs >= resolveMs,
    inactiveMinutes: onClient && lastOut ? Math.floor(clientInactiveMs / 60_000) : 0,
    sellerInactive: isHuman && onSeller && sellerInactiveMs >= warnMs,
    sellerInactiveMinutes: onSeller && lastClient ? Math.floor(sellerInactiveMs / 60_000) : 0,
  };
}

export async function saveContactName(opts: Parameters<typeof saveContactSavedName>[0]) {
  const contact = await saveContactSavedName(opts);
  return { ...contact, ...contactFlags(contact) };
}

export async function listContacts(opts: {
  userId: string;
  role: "admin" | "seller";
  status?: string;
  search?: string;
  sellerId?: string;
}) {
  const contacts = await listContactsForUser(opts);
  return contacts.map((c) => ({
    ...serializeContact(c),
    ...contactFlags(c),
    isBoletoReminder: Boolean(c.boletoReminderAt),
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
  let contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  if (contact.unreadCount > 0) {
    await markContactReadOnWhatsApp(contact).catch((err) =>
      console.warn("[read]", err instanceof Error ? err.message : err)
    );
    contact = { ...contact, unreadCount: 0 };
  }
  const messages = await prisma.whatsAppMessage.findMany({
    where: { contactId },
    orderBy: [{ createdAt: "asc" }, { direction: "asc" }],
    include: { sentBy: { select: { id: true, name: true } } },
  });
  const missing = messages.filter(
    (m) =>
      ["image", "video", "sticker", "audio", "document"].includes(m.type) &&
      !localUploadExists(m.mediaUrl)
  );
  if (missing.length) {
    const chunk = missing.slice(-12);
    const updated = await Promise.all(chunk.map((m) => hydrateMessageMedia(m, contact)));
    const byId = new Map(updated.map((u) => [u.id, u]));
    for (let i = 0; i < messages.length; i++) {
      const next = byId.get(messages[i].id);
      if (next) messages[i] = next as typeof messages[number];
    }
  }
  messages.sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    if (t !== 0) return t;
    if (a.direction === b.direction) return 0;
    return a.direction === "in" ? -1 : 1;
  });
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < messages.length - 1; i++) {
      const a = messages[i];
      const b = messages[i + 1];
      const dt = b.createdAt.getTime() - a.createdAt.getTime();
      if (a.direction === "out" && !a.sentById && b.direction === "in" && dt >= 0 && dt <= 20_000) {
        messages[i] = b;
        messages[i + 1] = a;
        swapped = true;
      }
    }
  }
  return {
    contact: {
      ...serializeContact(contact),
      ...contactFlags(contact),
      isBoletoReminder: Boolean(contact.boletoReminderAt),
    },
    messages: withQuotedPayload(messages, contactDisplayName(contact)),
    readOnly:
      (contact.status === "closed" || contact.status === "awaiting_rating") &&
      !contact.webhookPaused,
  };
}

/** Envia lido ao WhatsApp (Evolution/Meta) e zera unreadCount no BIANO. */
async function markContactReadOnWhatsApp(contact: {
  id: string;
  phone: string;
  remoteJid: string | null;
  unreadCount: number;
}) {
  const limit = Math.min(Math.max(contact.unreadCount, 1), 40);
  const inbound = await prisma.whatsAppMessage.findMany({
    where: {
      contactId: contact.id,
      direction: "in",
      NOT: { externalId: null },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { externalId: true },
  });
  const ids = inbound
    .map((m) => (m.externalId || "").trim())
    .filter((id) => id.length > 4);

  if (ids.length && (await messagingEnabled())) {
    const provider = await activeProvider();
    const remoteJid =
      contact.remoteJid ||
      `${contact.phone.replace(/\D/g, "")}@s.whatsapp.net`;
    if (provider === "meta") {
      const r = await meta.markAsRead(ids[0]);
      if (!r.ok) console.warn("[read/meta]", r.status, r.text.slice(0, 200));
    } else if (provider === "evolution") {
      const r = await evolution.markMessagesAsRead(
        ids.map((id) => ({ remoteJid, id, fromMe: false }))
      );
      if (!r.ok) console.warn("[read/evolution]", r.status, r.text.slice(0, 200));
    }
  }

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: { unreadCount: 0 },
  });
}

function withQuotedPayload<
  T extends {
    id: string;
    direction: string;
    type: string;
    body: string | null;
    mediaUrl: string | null;
    externalId: string | null;
    quotedExternalId: string | null;
    quotedBody: string | null;
    quotedType: string | null;
    quotedMediaUrl: string | null;
    sentBy?: { id: string; name: string } | null;
  },
>(messages: T[], contactName: string) {
  return messages.map((m) => {
    const target = m.quotedExternalId
      ? messages.find((x) => {
          if (x.id === m.quotedExternalId) return true;
          const a = x.externalId || "";
          const b = m.quotedExternalId || "";
          return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
        })
      : null;
    if (!target && !m.quotedBody && !m.quotedMediaUrl && !m.quotedExternalId) {
      return { ...m, quoted: null };
    }
    return {
      ...m,
      quoted: {
        messageId: target?.id ?? null,
        type: target?.type || m.quotedType || "text",
        body: target?.body ?? m.quotedBody,
        mediaUrl: target?.mediaUrl ?? m.quotedMediaUrl,
        author:
          target?.direction === "out"
            ? target.sentBy?.name || "Você"
            : contactName,
      },
    };
  });
}

const mediaRetryAt = new Map<string, number>();

async function hydrateMessageMedia<
  T extends {
    id: string;
    type: string;
    direction: string;
    externalId: string | null;
    mediaUrl: string | null;
  },
>(msg: T, contact: { phone: string; remoteJid: string | null }): Promise<T> {
  if (localUploadExists(msg.mediaUrl)) return msg;
  const last = mediaRetryAt.get(msg.id) ?? 0;
  if (Date.now() - last < 45_000) return msg;
  mediaRetryAt.set(msg.id, Date.now());

  async function persist(url: string) {
    await prisma.whatsAppMessage.update({ where: { id: msg.id }, data: { mediaUrl: url } });
    return { ...msg, mediaUrl: url };
  }

  if (
    msg.mediaUrl?.startsWith("http") &&
    !msg.mediaUrl.includes("whatsapp.net") &&
    !msg.mediaUrl.includes("mmg.")
  ) {
    const saved = await saveRemoteUrl(msg.mediaUrl, msg.type);
    if (saved) return persist(saved);
  }

  // Retry download Meta Cloud API (media id guardado quando o 1º download falhou).
  if (msg.mediaUrl?.startsWith("meta-media:")) {
    const mediaId = msg.mediaUrl.slice("meta-media:".length).trim();
    if (mediaId) {
      const saved = await meta.downloadMediaToUploads(mediaId, { type: msg.type });
      if (saved?.localUrl) return persist(saved.localUrl);
    }
  }

  if (msg.externalId && evolution.enabled) {
    const r = await evolution.getBase64FromMedia({
      remoteJid: contact.remoteJid || `${contact.phone}@s.whatsapp.net`,
      fromMe: msg.direction === "out",
      id: msg.externalId,
    });
    const extracted = EvolutionClient.extractMediaBase64(r.data);
    if (extracted) {
      const saved = saveBase64Media(extracted.base64, extracted.mimetype, msg.type);
      if (saved) return persist(saved);
    }
  }

  if (msg.mediaUrl?.startsWith("http")) {
    const saved = await saveRemoteUrl(msg.mediaUrl, msg.type);
    if (saved) return persist(saved);
  }

  return msg;
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
  /** ID interno da mensagem sendo respondida. */
  quotedMessageId?: string | null;
}) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (
    (contact.status === "closed" || contact.status === "awaiting_rating") &&
    !contact.webhookPaused
  ) {
    throw new Error("Conversa finalizada — somente leitura");
  }

  const role = opts.role ?? "seller";
  const alreadyMine =
    contact.status === "human" && contact.assignedToId === opts.userId;
  if (!alreadyMine && role !== "admin") {
    await assumeOnOpen(opts.contactId, opts.userId, role);
  }

  if (!(await messagingEnabled())) throw new Error("WhatsApp não configurado (Evolution, Meta ou Gupshup)");

  let quoted: {
    externalId: string;
    fromMe: boolean;
    remoteJid?: string | null;
    body?: string | null;
    quotedBody: string | null;
    quotedType: string | null;
    quotedMediaUrl: string | null;
  } | null = null;

  if (opts.quotedMessageId) {
    const target = await prisma.whatsAppMessage.findFirst({
      where: { id: opts.quotedMessageId, contactId: contact.id },
    });
    if (!target?.externalId) {
      throw new Error("Não é possível responder a esta mensagem (sem ID do WhatsApp)");
    }
    quoted = {
      externalId: target.externalId,
      fromMe: target.direction === "out",
      remoteJid: contact.remoteJid || `${contact.phone.replace(/\D/g, "")}@s.whatsapp.net`,
      body: target.body,
      quotedBody: target.body,
      quotedType: target.type || "text",
      quotedMediaUrl: target.mediaUrl,
    };
  }

  const text = await sellerPrefix(opts.userId, opts.body);
  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "agent",
    contactId: contact.id,
    kind: "text",
    text,
    category: "service",
    quoted: quoted
      ? {
          externalId: quoted.externalId,
          fromMe: quoted.fromMe,
          remoteJid: quoted.remoteJid,
          body: quoted.body,
        }
      : null,
  });
  if (!r.ok) throw new Error(`Falha WhatsApp: ${r.error}`);

  const externalId = r.externalId;
  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: "text",
    body: text,
    sentById: opts.userId,
    externalId,
    quotedExternalId: quoted?.externalId ?? null,
    quotedBody: quoted?.quotedBody ?? null,
    quotedType: quoted?.quotedType ?? null,
    quotedMediaUrl: quoted?.quotedMediaUrl ?? null,
  });
  await touchContactAfterMessage(contact.id, "out", text);
  if (role !== "admin") {
    await prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: { status: "human", assignedToId: opts.userId },
    });
  }

  return msg;
}

/** Disparo proativo: template Marketing com foto do produto + nome do cliente/produto. */
export async function sendProductOutreach(opts: {
  contactId: string;
  productName: string;
  userId: string;
  role?: "admin" | "seller";
  filePath: string;
  mimetype: string;
  fileName: string;
  publicUrl: string;
}) {
  const productName = opts.productName.trim();
  if (!productName) throw new Error("Informe o nome do produto");
  if (!opts.filePath || !fs.existsSync(opts.filePath)) {
    throw new Error("Envie a foto do produto");
  }

  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  const role = opts.role ?? "seller";
  const provider = await activeProvider();
  if (provider !== "meta") {
    throw new Error("Entrar em contato com foto exige provider Meta (Cloud API)");
  }
  if (!meta.enabled) throw new Error("Meta não configurada");

  const templateName = (env.META_PRODUTO_TEMPLATE_NAME || "produto_disponivel").trim();
  const clientName =
    (contact.name || contact.pushName || "Cliente").trim().slice(0, 60) || "Cliente";

  const buf = fs.readFileSync(opts.filePath);
  const up = await meta.uploadMedia({
    buffer: buf,
    mimetype: opts.mimetype || "image/jpeg",
    fileName: opts.fileName || "produto.jpg",
  });
  if (!up.ok) {
    throw new Error(`Upload foto Meta: HTTP ${up.status}: ${up.text}`);
  }

  const preview = `Produto disponível: ${productName}`;
  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "agent",
    contactId: contact.id,
    kind: "template",
    category: "marketing",
    billable: true,
    bodyPreview: preview,
    template: {
      name: templateName,
      language: env.META_BOLETO_TEMPLATE_LANG || "pt_BR",
      components: [
        {
          type: "header",
          parameters: [{ type: "image", image: { id: up.id } }],
        },
        {
          type: "body",
          parameters: [
            { type: "text", text: clientName },
            { type: "text", text: productName.slice(0, 60) },
          ],
        },
      ],
    },
  });
  if (!r.ok) throw new Error(`Falha ao enviar template: ${r.error}`);

  if (role !== "admin") {
    await assumeOnOpen(opts.contactId, opts.userId, role).catch(() => {});
  }
  await setWebhookPaused(contact.id, true).catch(() => {});

  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: "image",
    body: preview,
    mediaUrl: opts.publicUrl,
    sentById: opts.userId,
    externalId: r.externalId,
  });

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: preview.slice(0, 120),
      webhookPaused: true,
      ...(role === "admin"
        ? {}
        : { status: "human" as const, assignedToId: opts.userId }),
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
  mediatype?: "image" | "audio" | "video" | "document";
  /** Batch concorrente: assume uma vez fora. */
  skipAssume?: boolean;
  /** Key única do cliente (1 request = 1 mídia). */
  clientKey?: string;
}) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (
    (contact.status === "closed" || contact.status === "awaiting_rating") &&
    !contact.webhookPaused
  ) {
    throw new Error("Conversa finalizada — somente leitura");
  }
  const role = opts.role ?? "seller";
  const alreadyMine =
    contact.status === "human" && contact.assignedToId === opts.userId;
  if (!alreadyMine && role !== "admin" && !opts.skipAssume) {
    await assumeOnOpen(opts.contactId, opts.userId, role);
  }
  if (!(await messagingEnabled())) throw new Error("WhatsApp não configurado (Evolution, Meta ou Gupshup)");

  const mediatype = opts.mediatype ?? "image";
  const fallback =
    mediatype === "audio"
      ? "[áudio]"
      : mediatype === "video"
        ? "[vídeo]"
        : mediatype === "document"
          ? opts.fileName || "[documento]"
          : "[imagem]";
  const caption =
    mediatype === "audio"
      ? ""
      : opts.caption
        ? await sellerPrefix(opts.userId, opts.caption)
        : "";

  const buf = fs.readFileSync(opts.filePath);
  const b64 = buf.toString("base64");
  const to = contact.remoteJid || contact.phone;

  const r = await sendOutbound({
    to,
    source: "agent",
    contactId: contact.id,
    kind: mediatype === "audio" ? "audio" : "media",
    category: "service",
    bodyPreview: caption || fallback,
    media: {
      mediatype,
      link: opts.publicUrl || undefined,
      base64: b64,
      mimetype: opts.mimetype,
      caption,
      fileName: opts.fileName,
    },
  });
  if (!r.ok) throw new Error(`Falha WhatsApp mídia: ${r.error}`);

  const externalId = r.externalId;
  const body = mediatype === "audio" ? fallback : caption || fallback;
  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: mediatype,
    body,
    mediaUrl: opts.publicUrl,
    sentById: opts.userId,
    externalId,
    clientKey: opts.clientKey ?? null,
  });
  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: body.slice(0, 120),
      ...(role === "admin" ? {} : { status: "human" as const, assignedToId: opts.userId }),
    },
  });

  // Fotos de vendedor → galeria pendente (admin aprova o que vai pra LP).
  if (mediatype === "image" && role === "seller" && opts.publicUrl) {
    try {
      await submitSellerPhotoToGallery({
        imageUrl: opts.publicUrl,
        caption: opts.caption ?? null,
        submittedById: opts.userId,
        sourceMessageId: msg.id,
      });
    } catch (err) {
      console.warn(
        "[gallery] falha ao enfileirar foto",
        err instanceof Error ? err.message : err
      );
    }
  }

  return msg;
}

/**
 * Várias mídias em paralelo (Promise.all) — acelera atendimento multi-foto.
 * Sem fila Kafka: I/O da Meta já é concorrente por request.
 */
export async function sendImageMessagesConcurrent(opts: {
  contactId: string;
  userId: string;
  role?: "admin" | "seller";
  items: Array<{
    filePath: string;
    mimetype: string;
    fileName: string;
    publicUrl: string;
    caption?: string;
    clientKey?: string;
  }>;
}) {
  const role = opts.role ?? "seller";
  if (!opts.items.length)
    return [] as Array<{
      ok: boolean;
      clientKey?: string;
      index: number;
      message?: Awaited<ReturnType<typeof sendImageMessage>>;
      error?: string;
    }>;

  if (role !== "admin") {
    await assumeOnOpen(opts.contactId, opts.userId, role).catch(() => {});
  }

  const settled = await Promise.all(
    opts.items.map(async (item, index) => {
      try {
        const message = await sendImageMessage({
          contactId: opts.contactId,
          userId: opts.userId,
          role,
          filePath: item.filePath,
          mimetype: item.mimetype,
          fileName: item.fileName,
          publicUrl: item.publicUrl,
          caption: item.caption,
          clientKey: item.clientKey,
          mediatype: item.mimetype.startsWith("image/")
            ? "image"
            : item.mimetype.startsWith("video/")
              ? "video"
              : item.mimetype.startsWith("audio/")
                ? "audio"
                : "document",
          skipAssume: true,
        });
        return {
          ok: true as const,
          index,
          clientKey: item.clientKey,
          message,
        };
      } catch (err) {
        return {
          ok: false as const,
          index,
          clientKey: item.clientKey,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  return settled.sort((a, b) => a.index - b.index);
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

  const updated = await prisma.whatsAppContact.update({
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

  if (opts.userId) {
    notifyUsersSafe([opts.userId], {
      title: "Atendimento transferido",
      body: `${contactDisplayName(updated)} foi atribuído a você`,
      contactId: updated.id,
      tag: `wa-assign-${updated.id}`,
    });
  }

  return updated;
}

/** Finaliza atendimento e pede avaliação (1–5). */
export async function resolveContact(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  if (contact.webhookPaused) {
    throw new Error("Cliente em atendimento manual — volte ao webhook antes de finalizar");
  }
  if (contact.status === "awaiting_rating" || contact.status === "closed") {
    return contact;
  }

  const claimed = await prisma.whatsAppContact.updateMany({
    where: {
      id: contactId,
      webhookPaused: false,
      status: { in: ["human", "waiting"] },
    },
    data: {
      status: "awaiting_rating",
      ratingAskedAt: new Date(),
      rating: null,
      offeredToId: null,
      openToAll: false,
    },
  });
  if (claimed.count === 0) {
    return prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contactId } });
  }

  let externalId: string | null = null;
  if (await messagingEnabled()) {
    const r = await sendOutbound({
      to: contact.remoteJid || contact.phone,
      source: "system",
      contactId,
      kind: "text",
      text: RATING_MSG,
      category: "service",
    });
    externalId = r.externalId;
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
      lastMessageAt: new Date(),
      lastMessagePreview: RATING_MSG.slice(0, 120),
    },
  });
}

/** Aviso de inatividade manual (vendedor). */
export async function warnInactivity(contactId: string, userId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  if (contact.webhookPaused) {
    throw new Error("Cliente em atendimento manual");
  }
  const direction =
    contact.lastMessageDirection ?? (await ensureLastMessageDirection(contactId));
  if (direction !== "out") {
    throw new Error(
      "A última mensagem foi do cliente — responda no chat. Mensagens de inatividade só quando o cliente não responde."
    );
  }
  const flags = contactFlags(contact);
  if (!flags.canWarnInactivity) {
    throw new Error(
      `Cliente inativo há menos de ${env.INACTIVITY_WARN_MINUTES} minutos`
    );
  }
  if (!(await messagingEnabled())) throw new Error("WhatsApp não configurado");

  const text = await sellerPrefix(userId, INACTIVITY_RECOVERY_MSG);
  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "agent",
    contactId,
    kind: "text",
    text,
    category: "service",
  });
  if (!r.ok) throw new Error(`Falha WhatsApp: ${r.error}`);

  await upsertOutboundMessage({
    contactId,
    type: "text",
    body: text,
    sentById: userId,
    externalId: r.externalId,
  });
  await touchContactAfterMessage(contactId, "out", text);
  return prisma.whatsAppContact.update({
    where: { id: contactId },
    data: { inactivityWarnedAt: new Date() },
  });
}

async function sendSystemText(contactId: string, text: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contactId } });
  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "system",
    contactId,
    kind: "text",
    text,
    category: "service",
  });
  if (!r.ok) throw new Error(`Falha WhatsApp: ${r.error}`);
  await upsertOutboundMessage({
    contactId,
    type: "text",
    body: text,
    externalId: r.externalId,
  });
  await touchContactAfterMessage(contactId, "out", text);
}

/** Recuperação automática — só se a última msg foi nossa (cliente deve responder). */
export async function autoWarnInactivity(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contactId } });
  if (contact.webhookPaused || contact.status !== "human" || contact.inactivityWarnedAt) return false;
  const direction = contact.lastMessageDirection ?? (await ensureLastMessageDirection(contactId));
  if (direction !== "out") return false;
  const flags = contactFlags(contact);
  if (!flags.canWarnInactivity) return false;
  if (!(await messagingEnabled())) return false;

  const text = INACTIVITY_RECOVERY_MSG;
  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "system",
    contactId,
    kind: "text",
    text,
    category: "service",
  });
  if (!r.ok) {
    console.error("[idle] warn falhou", contact.phone, r.error);
    return false;
  }
  await upsertOutboundMessage({ contactId, type: "text", body: text, externalId: r.externalId });
  await touchContactAfterMessage(contactId, "out", text);
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: { inactivityWarnedAt: new Date() },
  });
  console.log(`[idle] aviso ${env.INACTIVITY_WARN_MINUTES}min → ${contact.phone}`);
  return true;
}

/** Finalização automática — só se o cliente não respondeu após nossa última msg. */
export async function autoResolveInactivity(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contactId } });
  if (contact.webhookPaused || contact.status !== "human") return false;
  const direction = contact.lastMessageDirection ?? (await ensureLastMessageDirection(contactId));
  if (direction !== "out") return false;
  const flags = contactFlags(contact);
  if (!flags.canResolveInactivity) return false;
  if (!(await messagingEnabled())) return false;

  await sendSystemText(contactId, INACTIVITY_CLOSE_MSG);
  await resolveContact(contactId);
  console.log(`[idle] encerramento ${env.INACTIVITY_RESOLVE_MINUTES}min → ${contact.phone}`);
  return true;
}

/** Cron: aviso/encerramento ao cliente + alerta in-app ao vendedor. */
export async function processAutoInactivity() {
  if (!(await messagingEnabled())) return { warned: 0, closed: 0, sellerAlerts: 0 };
  const warnCutoff = new Date(Date.now() - env.INACTIVITY_WARN_MINUTES * 60_000);
  const resolveCutoff = new Date(Date.now() - env.INACTIVITY_RESOLVE_MINUTES * 60_000);

  const toWarn = await prisma.whatsAppContact.findMany({
    where: {
      status: "human",
      webhookPaused: false,
      lastMessageDirection: "out",
      inactivityWarnedAt: null,
      lastMessageAt: { lt: warnCutoff },
    },
    take: 80,
  });

  let warned = 0;
  for (const c of toWarn) {
    try {
      if (await autoWarnInactivity(c.id)) warned++;
    } catch (err) {
      console.error("[idle] warn", c.phone, err);
    }
  }

  const toClose = await prisma.whatsAppContact.findMany({
    where: {
      status: "human",
      webhookPaused: false,
      lastMessageDirection: "out",
      inactivityWarnedAt: { not: null },
      lastMessageAt: { lt: resolveCutoff },
    },
    take: 80,
  });

  let closed = 0;
  for (const c of toClose) {
    try {
      if (await autoResolveInactivity(c.id)) closed++;
    } catch (err) {
      console.error("[idle] close", c.phone, err);
    }
  }

  const sellerAlerts = await processSellerInactivityAlerts(warnCutoff);
  return { warned, closed, sellerAlerts };
}

/** Cliente aguardando vendedor — só notifica no app, sem msg ao cliente. */
async function processSellerInactivityAlerts(cutoff: Date): Promise<number> {
  const waiting = await prisma.whatsAppContact.findMany({
    where: {
      status: "human",
      webhookPaused: false,
      lastMessageDirection: "in",
      lastClientMessageAt: { lt: cutoff },
      sellerInactivityNotifiedAt: null,
    },
    take: 80,
  });

  let sent = 0;
  for (const c of waiting) {
    try {
      const recipients: string[] = [];
      if (c.assignedToId) recipients.push(c.assignedToId);
      else if (c.offeredToId) recipients.push(c.offeredToId);
      else if (c.openToAll && c.queueId) {
        const ids = await recipientIdsForOpenQueue(c.queueId);
        recipients.push(...ids);
      }
      const unique = [...new Set(recipients.filter(Boolean))];
      if (!unique.length) continue;

      notifyUsersSafe(unique, {
        title: "Cliente aguardando resposta",
        body: `${contactDisplayName(c)} está esperando há ${env.INACTIVITY_WARN_MINUTES}+ min`,
        contactId: c.id,
        tag: `wa-seller-idle-${c.id}`,
      });
      await prisma.whatsAppContact.update({
        where: { id: c.id },
        data: { sellerInactivityNotifiedAt: new Date() },
      });
      sent++;
    } catch (err) {
      console.error("[idle] seller alert", c.phone, err);
    }
  }
  return sent;
}

export type StoreLocationConfig = {
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  address: string | null;
  message: string | null;
};

export async function getStoreLocationConfig(): Promise<StoreLocationConfig> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
  return {
    latitude: row?.storeLatitude ?? null,
    longitude: row?.storeLongitude ?? null,
    name: row?.storeLocationName ?? null,
    address: row?.storeLocationAddress ?? null,
    message: row?.storeLocationMessage ?? null,
  };
}

export async function updateStoreLocationConfig(data: Partial<StoreLocationConfig>) {
  const patch: Record<string, unknown> = {};
  if (data.latitude !== undefined) patch.storeLatitude = data.latitude;
  if (data.longitude !== undefined) patch.storeLongitude = data.longitude;
  if (data.name !== undefined) patch.storeLocationName = data.name?.trim() || null;
  if (data.address !== undefined) patch.storeLocationAddress = data.address?.trim() || null;
  if (data.message !== undefined) patch.storeLocationMessage = data.message?.trim() || null;
  return prisma.whatsAppConnection.upsert({
    where: { id: "default" },
    update: patch,
    create: { id: "default", instanceName: "", status: "disconnected", ...patch },
    select: {
      storeLatitude: true,
      storeLongitude: true,
      storeLocationName: true,
      storeLocationAddress: true,
      storeLocationMessage: true,
    },
  });
}

function formatLocationBody(name?: string | null, address?: string | null) {
  const parts = [name, address].filter(Boolean);
  return parts.length ? `📍 ${parts.join("\n")}` : "📍 Localização";
}

function locationMediaUrl(lat: number, lng: number) {
  return `${lat},${lng}`;
}

export async function sendLocationMessage(opts: {
  contactId: string;
  latitude: number;
  longitude: number;
  name?: string | null;
  address?: string | null;
  /** Texto enviado antes do pin (ex.: mensagem da loja). */
  preamble?: string | null;
  userId: string;
  role?: "admin" | "seller";
}) {
  const lat = Number(opts.latitude);
  const lng = Number(opts.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Coordenadas inválidas");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error("Coordenadas fora do intervalo");
  }

  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (
    (contact.status === "closed" || contact.status === "awaiting_rating") &&
    !contact.webhookPaused
  ) {
    throw new Error("Conversa finalizada — somente leitura");
  }

  const role = opts.role ?? "seller";
  if (!(role === "admin" || contact.assignedToId === opts.userId)) {
    await assumeOnOpen(opts.contactId, opts.userId, role);
  }
  if (!(await messagingEnabled())) throw new Error("WhatsApp não configurado");

  const name = opts.name?.trim() || "Localização";
  const address = opts.address?.trim() || name;
  const preamble = opts.preamble?.trim();

  if (preamble) {
    const text = await sellerPrefix(opts.userId, preamble);
    const tr = await sendOutbound({
      to: contact.remoteJid || contact.phone,
      source: "agent",
      contactId: contact.id,
      kind: "text",
      text,
      category: "service",
    });
    if (!tr.ok) throw new Error(`Falha WhatsApp: ${tr.error}`);
    await upsertOutboundMessage({
      contactId: contact.id,
      type: "text",
      body: text,
      sentById: opts.userId,
      externalId: tr.externalId,
    });
  }

  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "agent",
    contactId: contact.id,
    kind: "location",
    location: { latitude: lat, longitude: lng, name, address },
    category: "service",
  });
  if (!r.ok) throw new Error(`Falha WhatsApp: ${r.error}`);

  const body = formatLocationBody(name, address);
  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: "location",
    body,
    mediaUrl: locationMediaUrl(lat, lng),
    sentById: opts.userId,
    externalId: r.externalId,
  });

  await touchContactAfterMessage(contact.id, "out", body);
  if (role !== "admin") {
    await prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: { status: "human", assignedToId: opts.userId },
    });
  }

  return msg;
}

export type PixKeyType = "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "EVP";

export type PixConfig = {
  key: string | null;
  keyType: PixKeyType;
  merchantName: string | null;
  message: string | null;
};

function normalizePixKeyType(v: string | null | undefined): PixKeyType {
  const u = (v || "CNPJ").toUpperCase();
  if (u === "CPF" || u === "CNPJ" || u === "EMAIL" || u === "PHONE" || u === "EVP") return u;
  return "CNPJ";
}

export async function getPixConfig(): Promise<PixConfig> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
  return {
    key: row?.pixKey?.trim() || env.PIX_KEY?.trim() || null,
    keyType: normalizePixKeyType(row?.pixKeyType ?? env.PIX_KEY_TYPE),
    merchantName: row?.pixMerchantName?.trim() || env.PIX_MERCHANT_NAME?.trim() || null,
    message: row?.pixMessage?.trim() || env.PIX_MESSAGE?.trim() || null,
  };
}

export async function updatePixConfig(data: {
  key?: string | null;
  keyType?: string | null;
  merchantName?: string | null;
  message?: string | null;
}) {
  const patch: Record<string, unknown> = {};
  if (data.key !== undefined) patch.pixKey = data.key?.replace(/\s/g, "") || null;
  if (data.keyType !== undefined) patch.pixKeyType = normalizePixKeyType(data.keyType);
  if (data.merchantName !== undefined) patch.pixMerchantName = data.merchantName?.trim() || null;
  if (data.message !== undefined) patch.pixMessage = data.message?.trim() || null;
  return prisma.whatsAppConnection.upsert({
    where: { id: "default" },
    update: patch,
    create: { id: "default", instanceName: "", status: "disconnected", ...patch },
    select: {
      pixKey: true,
      pixKeyType: true,
      pixMerchantName: true,
      pixMessage: true,
    },
  });
}

function pixKeyTypeLabel(keyType: PixKeyType): string {
  const map: Record<PixKeyType, string> = {
    CPF: "CPF",
    CNPJ: "CNPJ",
    EMAIL: "E-mail",
    PHONE: "Celular",
    EVP: "Chave aleatória",
  };
  return map[keyType];
}

function formatPixKeyDisplay(key: string, keyType: PixKeyType): string {
  const digits = key.replace(/\D/g, "");
  if (keyType === "CNPJ" && digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }
  if (keyType === "CPF" && digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  if (keyType === "PHONE" && digits.length >= 10) {
    const d = digits.length === 13 && digits.startsWith("55") ? digits.slice(2) : digits;
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return key;
}

function normalizePixKeyRaw(key: string, keyType: PixKeyType): string {
  if (keyType === "EMAIL" || keyType === "EVP") return key.trim();
  return key.replace(/\D/g, "");
}

function formatPixBody(merchantName: string, key: string, keyType: PixKeyType): string {
  return `${merchantName}\n${pixKeyTypeLabel(keyType)}: ${formatPixKeyDisplay(key, keyType)}`;
}

export async function sendPixKeyMessage(opts: {
  contactId: string;
  userId: string;
  role?: "admin" | "seller";
}) {
  const cfg = await getPixConfig();
  if (!cfg.key) {
    throw new Error("Chave Pix não configurada. Cadastre em Conectar WhatsApp.");
  }

  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  if (
    (contact.status === "closed" || contact.status === "awaiting_rating") &&
    !contact.webhookPaused
  ) {
    throw new Error("Conversa finalizada — somente leitura");
  }

  const role = opts.role ?? "seller";
  if (!(role === "admin" || contact.assignedToId === opts.userId)) {
    await assumeOnOpen(opts.contactId, opts.userId, role);
  }
  if (!(await messagingEnabled())) throw new Error("WhatsApp não configurado");

  const merchantName = cfg.merchantName || "Pix";
  const rawKey = normalizePixKeyRaw(cfg.key, cfg.keyType);
  const bodyPreview = formatPixBody(merchantName, cfg.key, cfg.keyType);

  let r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "agent",
    contactId: contact.id,
    kind: "pix",
    pix: {
      merchantName,
      key: cfg.key,
      keyType: cfg.keyType,
      bodyText: cfg.message ?? undefined,
    },
    category: "service",
    bodyPreview,
  });

  let msgType: "pix" | "text" = "pix";
  let externalId = r.externalId;
  let storedBody = bodyPreview;

  if (!r.ok) {
    console.warn("[pix] nativo falhou, fallback texto:", r.error);
    const fallback = [
      cfg.message?.trim(),
      `💳 *${merchantName}*`,
      `${pixKeyTypeLabel(cfg.keyType)}: ${formatPixKeyDisplay(cfg.key, cfg.keyType)}`,
      "",
      `_Chave: ${rawKey}_`,
    ]
      .filter((line) => line != null && line !== "")
      .join("\n");
    const text = await sellerPrefix(opts.userId, fallback);
    r = await sendOutbound({
      to: contact.remoteJid || contact.phone,
      source: "agent",
      contactId: contact.id,
      kind: "text",
      text,
      category: "service",
    });
    if (!r.ok) throw new Error(`Falha WhatsApp: ${r.error}`);
    msgType = "text";
    externalId = r.externalId;
    storedBody = text;
  }

  const msg = await upsertOutboundMessage({
    contactId: contact.id,
    type: msgType,
    body: storedBody,
    mediaUrl: msgType === "pix" ? rawKey : null,
    sentById: opts.userId,
    externalId,
  });

  await touchContactAfterMessage(contact.id, "out", storedBody);
  if (role !== "admin") {
    await prisma.whatsAppContact.update({
      where: { id: contact.id },
      data: { status: "human", assignedToId: opts.userId },
    });
  }

  return msg;
}

export async function handleRatingReply(contactId: string, body: string | null) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  // Já avaliou — não reenvia obrigado.
  if (contact.rating != null) return;

  const match = body?.trim().match(/(?:^|\D)([1-5])(?:\D|$)/);
  if (!match) {
    const hint = "Por favor, responda apenas com um número de *1* a *5*.";
    let externalId: string | null = null;
    if (await messagingEnabled()) {
      const r = await sendOutbound({
        to: contact.remoteJid || contact.phone,
        source: "system",
        contactId,
        kind: "text",
        text: hint,
        category: "service",
      });
      if (!r.ok) console.error("[rating] hint falhou", r.error);
      externalId = r.externalId;
    }
    await upsertOutboundMessage({
      contactId,
      type: "text",
      body: hint,
      externalId,
    });
    return;
  }

  const rating = Number(match[1]);
  const thanks = `Obrigado pela avaliação (*${rating}*)! Até logo.`;
  let externalId: string | null = null;
  if (await messagingEnabled()) {
    const r = await sendOutbound({
      to: contact.remoteJid || contact.phone,
      source: "system",
      contactId,
      kind: "text",
      text: thanks,
      category: "service",
    });
    if (!r.ok) console.error("[rating] thanks falhou", contact.phone, r.error);
    else console.log("[rating] ok", contact.phone, rating);
    externalId = r.externalId;
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
  if ((await activeProvider()) !== "evolution") {
    return;
  }
  let data = (payload.data ?? payload) as Record<string, unknown> | unknown[];
  if (Array.isArray(data)) data = (data[0] ?? {}) as Record<string, unknown>;
  if (data && typeof data === "object" && Array.isArray((data as { messages?: unknown[] }).messages)) {
    data = (((data as { messages: unknown[] }).messages[0] ?? data) as Record<string, unknown>);
  }
  data = data as Record<string, unknown>;
  const key = (data.key ?? {}) as Record<string, unknown>;
  const fromMe = Boolean(key.fromMe);
  const ident = EvolutionClient.identityFromKey(key, data);
  const remoteJid = ident.sendJid || ident.remoteJid;
  if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === "status@broadcast") return;

  const phone = ident.phone;
  if (!phone) return;

  const message = unwrapWaMessage((data.message ?? {}) as Record<string, unknown>);
  const pushName = (data.pushName as string) || null;
  const externalId = String(key.id ?? "");

  let type = "text";
  let body: string | null = null;
  let mediaUrl: string | null = null;
  let mediaFileName: string | null = null;

  if (typeof message.conversation === "string") {
    body = message.conversation;
  } else if (message.extendedTextMessage && typeof message.extendedTextMessage === "object") {
    body = String((message.extendedTextMessage as { text?: string }).text ?? "");
  } else if (message.imageMessage || message.stickerMessage) {
    type = message.stickerMessage ? "sticker" : "image";
    const img = (message.imageMessage || message.stickerMessage) as { caption?: string; url?: string };
    body = img.caption ?? (type === "sticker" ? "[figurinha]" : "[imagem]");
    mediaUrl = img.url ?? null;
  } else if (message.audioMessage || message.pttMessage) {
    type = "audio";
    body = "[áudio]";
    const aud = (message.audioMessage || message.pttMessage) as { url?: string };
    mediaUrl = aud.url ?? null;
  } else if (message.videoMessage) {
    type = "video";
    const vid = message.videoMessage as { caption?: string; url?: string };
    body = vid.caption ?? "[vídeo]";
    mediaUrl = vid.url ?? null;
  } else if (message.documentMessage || message.documentWithCaptionMessage) {
    type = "document";
    const wrapped = message.documentWithCaptionMessage as
      | { message?: { documentMessage?: Record<string, unknown> } }
      | undefined;
    const doc = (message.documentMessage || wrapped?.message?.documentMessage || {}) as {
      fileName?: string;
      caption?: string;
      url?: string;
      mimetype?: string;
    };
    body = doc.caption || doc.fileName || "[documento]";
    mediaUrl = doc.url ?? null;
    mediaFileName = doc.fileName ?? null;
  } else {
    body = "[mensagem]";
  }

  const existingContact = await prisma.whatsAppContact.findUnique({ where: { phone } });
  const isNew = !existingContact;

  const quote = extractQuote(message, data);
  if (quote.stanzaId || quote.preview) {
    console.log("[webhook] quote", phone, quote.stanzaId ?? "-", (quote.preview ?? "").slice(0, 80));
  } else if (!fromMe) {
    console.log("[webhook] sem-quote", phone, type, Object.keys(message).join(","));
  }
  if (["image", "sticker", "video", "audio", "document"].includes(type)) {
    mediaUrl = await resolveMediaFile({
      type,
      remoteJid,
      fromMe,
      externalId,
      message,
      data,
      fallbackUrl: mediaUrl,
      fileName: mediaFileName,
    });
  }

  const assumir = fromMe ? takeAssumirCommand(body) : { assumed: false, cleaned: body };
  if (assumir.assumed) body = assumir.cleaned;

  if (!fromMe) {
    const prev = await prisma.whatsAppContact.findUnique({ where: { phone } });
    if (prev) await maybeCloseForClientIdle(prev.id);
  }

  const contact = await prisma.whatsAppContact.upsert({
    where: { phone },
    create: {
      phone,
      remoteJid,
      pushName: fromMe ? null : pushName,
      name: fromMe ? null : pushName,
      status: "bot",
      webhookPaused: fromMe,
      lastMessageAt: new Date(),
      lastMessagePreview: (body ?? "").slice(0, 120),
      lastClientMessageAt: fromMe ? null : new Date(),
      unreadCount: fromMe ? 0 : 1,
    },
    update: {
      remoteJid,
      ...(!fromMe && pushName ? { pushName } : {}),
      lastMessageAt: new Date(),
      lastMessagePreview: (body ?? "").slice(0, 120),
      ...(!fromMe
        ? {
            unreadCount: { increment: 1 },
            lastClientMessageAt: new Date(),
            lastMessageDirection: "in" as const,
            inactivityWarnedAt: null,
            sellerInactivityNotifiedAt: null,
            boletoReminderAt: null,
          }
        : {
            lastMessageDirection: "out" as const,
            inactivityWarnedAt: null,
            sellerInactivityNotifiedAt: null,
          }),
    },
  });

  if (assumir.assumed) {
    await setWebhookPaused(contact.id, true);
    console.log("[webhook] #assumir → manual", phone);
    if (!body) {
      if (externalId) void evolution.deleteOwnMessage(remoteJid, externalId);
      return;
    }
  }

  if (externalId) {
    const dup = await prisma.whatsAppMessage.findUnique({
      where: { contactId_externalId: { contactId: contact.id, externalId } },
    });
    if (dup) {
      if (
        (!dup.quotedBody && quote.preview) ||
        (!dup.quotedExternalId && quote.stanzaId) ||
        (!dup.quotedMediaUrl && quote.quotedMediaUrl)
      ) {
        await prisma.whatsAppMessage.update({
          where: { id: dup.id },
          data: {
            quotedExternalId: quote.stanzaId ?? dup.quotedExternalId,
            quotedBody: quote.preview ?? dup.quotedBody,
            quotedType: quote.quotedType ?? dup.quotedType,
            quotedMediaUrl: quote.quotedMediaUrl ?? dup.quotedMediaUrl,
          },
        });
      }
      // Janela anti-reprocess (60s / recentOut) removida para teste de latência do webhook.
      if (
        !fromMe &&
        !contact.webhookPaused &&
        (contact.status === "bot" || contact.status === "closed")
      ) {
        await processInboundBot(contact.id, body, contact.status === "closed" || isNew);
      }
      return;
    }
  }

  if (!fromMe) {
    try {
      await prisma.whatsAppMessage.create({
        data: {
          contactId: contact.id,
          externalId: externalId || null,
          direction: "in",
          type,
          body,
          mediaUrl,
          quotedExternalId: quote.stanzaId,
          quotedBody: quote.preview,
          quotedType: quote.quotedType,
          quotedMediaUrl: quote.quotedMediaUrl,
        },
      });
    } catch (err) {
      // Dois Evolution / webhook duplicado
      if ((err as { code?: string })?.code === "P2002" && externalId) {
        console.warn("[webhook] dup ignorado", phone, externalId);
        return;
      }
      throw err;
    }

    const fresh = await prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contact.id } });
    const preview = (body ?? "[mensagem]").slice(0, 120);
    const who = contactDisplayName(fresh);

    if (fresh.webhookPaused) return;

    if (fresh.status === "awaiting_rating") {
      await handleRatingReply(contact.id, body);
      return;
    }

    if (isNew || fresh.status === "bot" || fresh.status === "closed") {
      await processInboundBot(contact.id, body, isNew || fresh.status === "closed");
      return;
    }
    if (fresh.status === "human" && fresh.assignedToId) {
      notifyUsersSafe([fresh.assignedToId], {
        title: who,
        body: preview,
        contactId: fresh.id,
      });
    } else if (fresh.status === "waiting" && fresh.offeredToId && !fresh.openToAll) {
      notifyUsersSafe([fresh.offeredToId], {
        title: who,
        body: preview,
        contactId: fresh.id,
      });
    } else if (fresh.status === "waiting" && fresh.openToAll) {
      void recipientIdsForOpenQueue(fresh.queueId).then((ids) => {
        notifyUsersSafe(ids, {
          title: who,
          body: preview,
          contactId: fresh.id,
        });
      });
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
    const data = {
      ...(externalId && !recentOut.externalId ? { externalId } : {}),
      ...(mediaUrl && !localUploadExists(recentOut.mediaUrl) ? { mediaUrl } : {}),
    };
    if (Object.keys(data).length) {
      try {
        await prisma.whatsAppMessage.update({ where: { id: recentOut.id }, data });
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
      quotedExternalId: quote.stanzaId,
      quotedBody: quote.preview,
      quotedType: quote.quotedType,
      quotedMediaUrl: quote.quotedMediaUrl,
    },
  });
}

export { getWhatsAppReports, seedDemoReports } from "./reports.js";

