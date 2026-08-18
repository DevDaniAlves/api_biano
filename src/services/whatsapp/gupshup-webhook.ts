import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { notifyUsersSafe, recipientIdsForOpenQueue } from "../push.js";
import { processInboundBot } from "./flow.js";
import { applyGupshupStatus } from "./gateway.js";
import { parseGupshupEnvelope, unwrapGupshupBodies, type ParsedGupshup } from "./gupshup-mapper.js";
import { gupshup } from "./gupshup.js";
import { resolveMetaContact } from "./meta-webhook.js";
import { handleRatingReply, UPLOADS_DIR } from "./service.js";

function mimeExt(mimetype?: string | null, type?: string, fileName?: string | null) {
  const fromName = fileName?.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const m = (mimetype || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("mp4") || type === "video") return "mp4";
  if (m.includes("ogg") || m.includes("opus") || type === "audio") return "ogg";
  if (type === "document") return "bin";
  return "jpg";
}

async function downloadGupshupMedia(
  url: string,
  type: string,
  fileName?: string | null
): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    const key = (env.GUPSHUP_API_KEY || "").trim();
    if (key) headers.apikey = key;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 40) return null;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${mimeExt(
      res.headers.get("content-type"),
      type,
      fileName
    )}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
    return `/uploads/${name}`;
  } catch {
    return null;
  }
}

async function applyInboundMessage(parsed: ParsedGupshup) {
  if (!parsed.phone) return;
  const ourSource = (
    (env.GUPSHUP_SOURCE || "").trim() ||
    (await gupshup.credentials()).source
  ).replace(/\D/g, "");
  if (ourSource && parsed.phone.replace(/\D/g, "") === ourSource) {
    return;
  }
  let mediaUrl = parsed.mediaUrl;
  if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) {
    mediaUrl =
      (await downloadGupshupMedia(mediaUrl, parsed.crmType, parsed.mediaFileName)) || mediaUrl;
  }

  const { contact, isNew } = await resolveMetaContact({
    phone: parsed.phone,
    profileName: parsed.profileName,
    preview: parsed.body,
  });
  if (!contact) return;

  if (parsed.externalId) {
    const existing = await prisma.whatsAppMessage.findUnique({
      where: {
        contactId_externalId: { contactId: contact.id, externalId: parsed.externalId },
      },
    });
    if (existing) {
      if (
        (!existing.quotedExternalId && parsed.quotedExternalId) ||
        (!existing.mediaUrl && mediaUrl)
      ) {
        await prisma.whatsAppMessage.update({
          where: { id: existing.id },
          data: {
            quotedExternalId: parsed.quotedExternalId ?? existing.quotedExternalId,
            mediaUrl: mediaUrl ?? existing.mediaUrl,
          },
        });
      }
      return;
    }
  }

  try {
    await prisma.whatsAppMessage.create({
      data: {
        contactId: contact.id,
        direction: "in",
        type: parsed.crmType,
        body: parsed.body,
        mediaUrl,
        externalId: parsed.externalId,
        quotedExternalId: parsed.quotedExternalId,
        createdAt: new Date(),
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002" && parsed.externalId) {
      console.warn("[gupshup] dup ignorado", parsed.phone, parsed.externalId);
      return;
    }
    throw err;
  }

  await prisma.whatsAppContact.update({
    where: { id: contact.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: parsed.body.slice(0, 120),
      unreadCount: { increment: 1 },
      lastClientMessageAt: new Date(),
    },
  });

  const fresh = await prisma.whatsAppContact.findUniqueOrThrow({ where: { id: contact.id } });
  if (fresh.webhookPaused) return;

  if (fresh.status === "awaiting_rating") {
    await handleRatingReply(contact.id, parsed.body);
    return;
  }

  if (isNew || fresh.status === "bot" || fresh.status === "closed") {
    await processInboundBot(contact.id, parsed.body, isNew || fresh.status === "closed");
    return;
  }

  const preview = parsed.body.slice(0, 120);
  const who = fresh.name || fresh.phone;
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
}

/** ACK já foi enviado pela rota. Não lança para o Express. */
export async function handleGupshupWebhook(body: unknown) {
  const envelopes = unwrapGupshupBodies(body);
  for (const raw of envelopes) {
    const parsed = parseGupshupEnvelope(raw);
    try {
      if (parsed.kind === "message-event") {
        const ids = [parsed.gsId, parsed.externalId].filter((id): id is string => Boolean(id));
        await applyGupshupStatus({
          ids,
          status: parsed.status || "unknown",
          error: parsed.statusError,
        });
        continue;
      }
      if (parsed.kind === "user-event" || parsed.kind === "other") {
        console.log(
          "[gupshup]",
          parsed.envelopeType,
          parsed.messageType || "-",
          JSON.stringify(raw).slice(0, 400)
        );
        continue;
      }
      await applyInboundMessage(parsed);
    } catch (err) {
      console.error("[gupshup] event", parsed.kind, err);
    }
  }
}
