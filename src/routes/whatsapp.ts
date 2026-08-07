import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { env } from "../config.js";
import { prisma } from "../db.js";
import { authRequired, changePassword, createUser, login } from "../services/auth.js";
import {
  ensureFlow,
  getFlow,
  restartToBot,
  setWebhookPaused,
  type FlowOption,
} from "../services/whatsapp/flow.js";
import {
  recordWebhookHit,
  webhookStatusPayload,
} from "../services/whatsapp/webhook-hits.js";
import { evolution, EvolutionClient } from "../services/whatsapp/evolution.js";
import {
  deletePushSubscription,
  getVapidPublicKey,
  pendingBadgeCount,
  savePushSubscription,
} from "../services/push.js";
import {
  UPLOADS_DIR,
  assignContact,
  getWhatsAppReports,
  handleEvolutionWebhook,
  listContacts,
  listMessages,
  resolveContact,
  seedDemoReports,
  sendImageMessage,
  sendTextMessage,
  warnInactivity,
} from "../services/whatsapp/service.js";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const fromName = path.extname(file.originalname);
      const mime = file.mimetype || "";
      const fromMime = mime.includes("webm")
        ? ".webm"
        : mime.includes("ogg")
          ? ".ogg"
          : mime.includes("mp4") || mime.includes("quicktime")
            ? ".mp4"
            : mime.includes("mpeg") || mime.includes("mp3")
              ? ".mp3"
              : mime.startsWith("audio/")
                ? ".ogg"
                : mime.startsWith("video/")
                  ? ".mp4"
                  : mime.startsWith("image/")
                    ? ".jpg"
                    : mime.includes("pdf")
                      ? ".pdf"
                      : "";
      const ext = fromName || fromMime || ".bin";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("audio/") ||
      file.mimetype.startsWith("video/") ||
      file.mimetype === "application/pdf" ||
      file.mimetype.includes("word") ||
      file.mimetype.includes("excel") ||
      file.mimetype.includes("spreadsheet") ||
      file.mimetype.includes("officedocument");
    if (ok) cb(null, true);
    else cb(new Error("Tipo de arquivo não suportado"));
  },
});

export const whatsappRouter = Router();

whatsappRouter.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "");
    const password = String(req.body?.password ?? "");
    const result = await login(email, password);
    if (!result) {
      res.status(401).json({ error: "E-mail ou senha inválidos" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/auth/me", authRequired, async (req, res) => {
  res.json({ user: req.user });
});

whatsappRouter.post("/webhook/evolution", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const key = (data.key ?? {}) as Record<string, unknown>;
    const message = (data.message ?? {}) as Record<string, unknown>;
    const preview =
      typeof message.conversation === "string"
        ? message.conversation
        : message.extendedTextMessage && typeof message.extendedTextMessage === "object"
          ? String((message.extendedTextMessage as { text?: string }).text ?? "")
          : null;
    recordWebhookHit({
      path: "/whatsapp/webhook/evolution",
      method: "POST",
      ip: req.ip,
      event: String(body.event ?? body.type ?? "MESSAGES_UPSERT"),
      from: key.remoteJid ? String(key.remoteJid) : null,
      preview,
    });
    // ACK imediato — Evolution não espera o bot terminar (evita fila/atraso).
    res.json({ ok: true });
    void handleEvolutionWebhook(body).catch((err) => console.error("[webhook]", err));
  } catch (err) {
    console.error("[webhook]", err);
    if (!res.headersSent) res.json({ ok: true });
  }
});

whatsappRouter.get("/webhook/status", (_req, res) => {
  res.json(webhookStatusPayload());
});

whatsappRouter.use(authRequired);

whatsappRouter.get("/push/vapid-public", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({ error: "Push não configurado (VAPID)" });
    return;
  }
  res.json({ publicKey: key });
});

whatsappRouter.post("/push/subscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint ?? "");
    const p256dh = String(req.body?.keys?.p256dh ?? req.body?.p256dh ?? "");
    const auth = String(req.body?.keys?.auth ?? req.body?.auth ?? "");
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: "Subscription inválida" });
      return;
    }
    await savePushSubscription({
      userId: req.user!.id,
      endpoint,
      p256dh,
      auth,
      userAgent: req.get("user-agent"),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/push/badge", async (req, res) => {
  try {
    const count = await pendingBadgeCount(req.user!.id, req.user!.role);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/push/subscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint ?? req.query.endpoint ?? "");
    if (!endpoint) {
      res.status(400).json({ error: "endpoint obrigatório" });
      return;
    }
    await deletePushSubscription(endpoint, req.user!.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/auth/password", async (req, res) => {
  try {
    await changePassword({
      userId: req.user!.id,
      currentPassword: String(req.body?.currentPassword ?? ""),
      newPassword: String(req.body?.newPassword ?? ""),
    });
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      message.includes("incorreta") ||
      message.includes("diferente") ||
      message.includes("6 caracteres")
        ? 400
        : 500;
    res.status(code).json({ error: message });
  }
});

whatsappRouter.get("/contacts", async (req, res) => {
  try {
    const contacts = await listContacts({
      userId: req.user!.id,
      role: req.user!.role,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      sellerId:
        req.user!.role === "admin" && typeof req.query.sellerId === "string"
          ? req.query.sellerId
          : undefined,
    });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/messages", async (req, res) => {
  try {
    const contactId = String(req.query.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    const peek = req.query.peek === "1" || req.query.peek === "true";
    res.json(
      await listMessages(contactId, req.user!.id, req.user!.role as "admin" | "seller", {
        assume: !peek,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const forbidden =
      msg.includes("assumida") || msg.includes("oferecida a outro");
    res.status(forbidden ? 403 : 500).json({ error: msg });
  }
});

whatsappRouter.post("/messages", async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "");
    const body = String(req.body?.body ?? "").trim();
    if (!contactId || !body) {
      res.status(400).json({ error: "contactId e body obrigatórios" });
      return;
    }
    const msg = await sendTextMessage({
      contactId,
      body,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function mediaKind(mimetype: string): "image" | "audio" | "video" | "document" {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "audio";
  if (mimetype.startsWith("video/")) return "video";
  return "document";
}

whatsappRouter.post("/messages/image", upload.single("file"), async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId || !req.file) {
      res.status(400).json({ error: "contactId e file obrigatórios" });
      return;
    }
    const publicUrl = `/uploads/${req.file.filename}`;
    const msg = await sendImageMessage({
      contactId,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
      filePath: req.file.path,
      mimetype: req.file.mimetype,
      fileName: req.file.originalname,
      caption: req.body?.caption ? String(req.body.caption) : undefined,
      publicUrl,
      mediatype: mediaKind(req.file.mimetype),
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/assign", async (req, res) => {
  try {
    const contact = await assignContact({
      contactId: String(req.body?.contactId ?? ""),
      userId: req.body?.userId === undefined ? req.user!.id : req.body.userId,
      queueId: req.body?.queueId ?? undefined,
    });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/resolve", async (req, res) => {
  try {
    res.json(await resolveContact(String(req.body?.contactId ?? "")));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/restart-bot", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin pode reiniciar no bot" });
      return;
    }
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    res.json(await restartToBot(contactId));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/webhook-pause", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin pode pausar o webhook" });
      return;
    }
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    res.json(await setWebhookPaused(contactId, Boolean(req.body?.paused)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/inactivity-warn", async (req, res) => {
  try {
    res.json(
      await warnInactivity(String(req.body?.contactId ?? ""), req.user!.id)
    );
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/reports", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    res.json(
      await getWhatsAppReports({
        preset: typeof req.query.preset === "string" ? req.query.preset : undefined,
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
        month: typeof req.query.month === "string" ? req.query.month : undefined,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/reports/seed-demo", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const count = Number(req.body?.count ?? 90);
    const result = await seedDemoReports(
      Number.isFinite(count) ? Math.min(Math.max(count, 20), 200) : 90
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/connection", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default", instanceName: "", status: "disconnected" },
    });
    let live: unknown = null;
    if (evolution.credentialsOk && row.instanceName) {
      const [st, listed] = await Promise.all([
        evolution.connectionState(row.instanceName),
        evolution.fetchInstances(),
      ]);
      const instances = EvolutionClient.parseInstanceList(listed.data);
      const mine = instances.find((i) => {
        const name = String(i.name ?? i.instanceName ?? "");
        return name.toLowerCase() === row.instanceName.toLowerCase();
      });
      live = { connectionState: st.data, instance: mine ?? null };

      const fromList = mine
        ? String(mine.connectionStatus ?? mine.state ?? mine.status ?? "")
        : "";
      const fromState = st.ok ? EvolutionClient.extractLiveState(st.data) : "";
      const state = (fromList || fromState || row.status).toLowerCase();

      if (!mine && !st.ok) {
        const hint = `${st.status} ${st.text} ${listed.status} ${listed.text}`.toLowerCase();
        if (st.status === 404 || hint.includes("not found") || hint.includes("does not exist")) {
          await prisma.whatsAppConnection.update({
            where: { id: "default" },
            data: { status: "disconnected", lastQr: null, lastPairingCode: null },
          });
          row.status = "disconnected";
          row.lastQr = null;
          row.lastPairingCode = null;
        }
      } else if (state) {
        await prisma.whatsAppConnection.update({
          where: { id: "default" },
          data: { status: state },
        });
        row.status = state;
      }
    }
    if ((row.status === "open" || row.status === "connected") && row.lastPairingCode) {
      await prisma.whatsAppConnection.update({
        where: { id: "default" },
        data: { lastPairingCode: null, lastQr: null },
      });
      row.lastPairingCode = null;
      row.lastQr = null;
    }

    res.json({
      ...row,
      credentialsOk: evolution.credentialsOk,
      defaultPhone: env.WHATSAPP_BUSINESS_PHONE ?? "",
      live,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/connection", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    if (!evolution.credentialsOk) {
      res.status(400).json({ error: "Configure WHATSAPP_API_URL e WHATSAPP_API_KEY no .env" });
      return;
    }
    const instanceName = String(req.body?.instanceName ?? "").trim();
    if (!instanceName) {
      res.status(400).json({ error: "Informe o nome da instância em Conectar WhatsApp" });
      return;
    }
    const number = String(req.body?.number ?? req.body?.phone ?? "").replace(/\D/g, "");
    if (number && number.length < 10) {
      res.status(400).json({ error: "Informe o telefone com DDI e DDD (ex: 556634016000)" });
      return;
    }

    const created = await evolution.createInstance(instanceName, number || undefined);
    if (!created.ok) {
      const hint = `${created.status} ${created.text}`.toLowerCase();
      const exists =
        created.status === 403 ||
        created.status === 409 ||
        hint.includes("already") ||
        hint.includes("exist") ||
        hint.includes("já existe");
      if (!exists) {
        res.status(400).json({
          error: created.text?.slice(0, 280) || `Falha ao criar instância (${created.status})`,
        });
        return;
      }
    }

    if (number) {
      const listed = await evolution.fetchInstances();
      const mine = EvolutionClient.parseInstanceList(listed.data).find((i) => {
        const name = String(i.name ?? i.instanceName ?? "");
        return name.toLowerCase() === instanceName.toLowerCase();
      });
      const liveStatus = String(mine?.connectionStatus ?? mine?.state ?? "").toLowerCase();
      if (liveStatus === "open" || liveStatus === "connected") {
        res.status(400).json({ error: "Instância já está conectada. Desconecte antes de gerar um código novo." });
        return;
      }
      if (liveStatus === "connecting") {
        await evolution.logoutInstance(instanceName).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    let connect = await evolution.connectInstance(instanceName, number || undefined);
    let pairingCode = number ? EvolutionClient.extractPairingCode(connect.data) : null;
    if (number && !pairingCode) {
      for (let i = 0; i < 3 && !pairingCode; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        connect = await evolution.connectInstance(instanceName, number);
        pairingCode = EvolutionClient.extractPairingCode(connect.data);
      }
    }
    if (number && !pairingCode) {
      res.status(400).json({
        error:
          "A Evolution não devolveu o código. Desconecte, espere uns segundos e tente de novo. Número só com DDI+DDD.",
      });
      return;
    }

    const qr = number ? null : EvolutionClient.extractQrBase64(connect.data);

    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      update: {
        instanceName,
        status: "connecting",
        lastQr: qr,
        lastPairingCode: pairingCode,
      },
      create: {
        id: "default",
        instanceName,
        status: "connecting",
        lastQr: qr,
        lastPairingCode: pairingCode,
      },
    });
    res.json({ ...row, pairingCode, connect: connect.data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/connection", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    if (row && evolution.credentialsOk) {
      await evolution.logoutInstance(row.instanceName).catch(() => {});
    }
    await prisma.whatsAppConnection.update({
      where: { id: "default" },
      data: { status: "disconnected", lastQr: null, lastPairingCode: null },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/queues", async (_req, res) => {
  res.json(await prisma.whatsAppQueue.findMany({ orderBy: { name: "asc" } }));
});

whatsappRouter.post("/queues", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name obrigatório" });
      return;
    }
    res.status(201).json(await prisma.whatsAppQueue.create({ data: { name } }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/queues/:id", async (req, res) => {
  try {
    await prisma.whatsAppQueue.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/agents", async (_req, res) => {
  const agents = await prisma.whatsAppAgent.findMany({
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
      queue: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(agents);
});

whatsappRouter.post("/agents", async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? "");
    const queueId = req.body?.queueId ? String(req.body.queueId) : null;
    const sortOrder = Number(req.body?.sortOrder ?? 0);
    if (!userId) {
      res.status(400).json({ error: "userId obrigatório" });
      return;
    }
    const agent = await prisma.whatsAppAgent.create({
      data: { userId, queueId, sortOrder },
      include: {
        user: { select: { id: true, name: true, email: true } },
        queue: { select: { id: true, name: true } },
      },
    });
    res.status(201).json(agent);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/flow", async (_req, res) => {
  res.json(await getFlow());
});

whatsappRouter.put("/flow", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin edita o fluxo" });
      return;
    }
    await ensureFlow();
    const options = (req.body?.options ?? []) as FlowOption[];
    const flow = await prisma.whatsAppFlow.update({
      where: { id: "default" },
      data: {
        ...(req.body?.welcomeMessage != null
          ? { welcomeMessage: String(req.body.welcomeMessage) }
          : {}),
        ...(req.body?.closedMessage != null
          ? { closedMessage: String(req.body.closedMessage) }
          : {}),
        menuEnabled: req.body?.menuEnabled !== false,
        options: options as object[],
      },
    });
    res.json(flow);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/users/:id/unavailability", async (req, res) => {
  res.json(
    await prisma.userUnavailability.findMany({
      where: { userId: req.params.id },
      orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }],
    })
  );
});

whatsappRouter.post("/users/:id/unavailability", async (req, res) => {
  try {
    if (req.user?.role !== "admin" && req.user?.id !== req.params.id) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    const row = await prisma.userUnavailability.create({
      data: {
        userId: req.params.id,
        dayOfWeek: Number(req.body?.dayOfWeek ?? 0),
        startMin: Number(req.body?.startMin ?? 0),
        endMin: Number(req.body?.endMin ?? 0),
        label: req.body?.label ? String(req.body.label) : null,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/unavailability/:id", async (req, res) => {
  try {
    await prisma.userUnavailability.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function canManageUser(req: { user?: { id: string; role: string } }, userId: string) {
  return req.user?.role === "admin" || req.user?.id === userId;
}

whatsappRouter.get("/users/:id/schedule", async (req, res) => {
  res.json(
    await prisma.userScheduleSlot.findMany({
      where: { userId: req.params.id },
      orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }],
    })
  );
});

whatsappRouter.post("/users/:id/schedule", async (req, res) => {
  try {
    if (!canManageUser(req, req.params.id)) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    const dayOfWeek = Number(req.body?.dayOfWeek);
    const startMin = Number(req.body?.startMin);
    const endMin = Number(req.body?.endMin);
    if (
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 0 ||
      dayOfWeek > 6 ||
      !Number.isFinite(startMin) ||
      !Number.isFinite(endMin) ||
      startMin < 0 ||
      endMin > 24 * 60 ||
      endMin <= startMin
    ) {
      res.status(400).json({ error: "Intervalo inválido (dia 0–6, início < fim)" });
      return;
    }
    const row = await prisma.userScheduleSlot.create({
      data: { userId: req.params.id, dayOfWeek, startMin, endMin },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/schedule/:id", async (req, res) => {
  try {
    await prisma.userScheduleSlot.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/users/:id/leaves", async (req, res) => {
  res.json(
    await prisma.userLeave.findMany({
      where: { userId: req.params.id },
      orderBy: { startsAt: "desc" },
    })
  );
});

whatsappRouter.post("/users/:id/leaves", async (req, res) => {
  try {
    if (!canManageUser(req, req.params.id)) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    const startsAt = new Date(String(req.body?.startsAt ?? ""));
    const endsAt = new Date(String(req.body?.endsAt ?? ""));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt < startsAt) {
      res.status(400).json({ error: "Informe startsAt e endsAt válidos" });
      return;
    }
    const typeRaw = String(req.body?.type ?? "outro");
    const type = ["ferias", "folga", "outro"].includes(typeRaw) ? typeRaw : "outro";
    const row = await prisma.userLeave.create({
      data: {
        userId: req.params.id,
        type,
        label: req.body?.label ? String(req.body.label) : null,
        startsAt,
        endsAt,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/leaves/:id", async (req, res) => {
  try {
    await prisma.userLeave.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/agents/:id", async (req, res) => {
  try {
    await prisma.whatsAppAgent.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  res.json(users);
});

whatsappRouter.patch("/users/:id", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin altera usuários" });
      return;
    }
    if (req.params.id === req.user.id && req.body?.active === false) {
      res.status(400).json({ error: "Você não pode desativar a si mesmo" });
      return;
    }
    const data: { active?: boolean; name?: string } = {};
    if (typeof req.body?.active === "boolean") data.active = req.body.active;
    if (typeof req.body?.name === "string") {
      const name = req.body.name.trim();
      if (!name) {
        res.status(400).json({ error: "Nome obrigatório" });
        return;
      }
      data.name = name;
    }
    if (!Object.keys(data).length) {
      res.status(400).json({ error: "Nada para atualizar" });
      return;
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, name: true, email: true, role: true, active: true },
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/users", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin cria usuários" });
      return;
    }
    const user = await createUser({
      name: String(req.body?.name ?? ""),
      email: String(req.body?.email ?? ""),
      password: String(req.body?.password ?? ""),
      role: req.body?.role === "admin" ? "admin" : "seller",
    });
    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
