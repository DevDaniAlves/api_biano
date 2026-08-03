import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { env } from "../config.js";
import { prisma } from "../db.js";
import { authRequired, createUser, login } from "../services/auth.js";
import {
  ensureFlow,
  getFlow,
  type FlowOption,
} from "../services/whatsapp/flow.js";
import {
  UPLOADS_DIR,
  assignContact,
  handleEvolutionWebhook,
  listContacts,
  listMessages,
  resolveContact,
  sendImageMessage,
  sendTextMessage,
} from "../services/whatsapp/service.js";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Apenas imagens"));
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
    await handleEvolutionWebhook(req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) {
    console.error("[webhook]", err);
    res.status(500).json({ error: "webhook error" });
  }
});

whatsappRouter.use(authRequired);

whatsappRouter.get("/contacts", async (req, res) => {
  try {
    const contacts = await listContacts({
      userId: req.user!.id,
      role: req.user!.role,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
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
    // Abrir conversa = assumir (se elegível)
    res.json(
      await listMessages(contactId, req.user!.id, req.user!.role as "admin" | "seller")
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

whatsappRouter.post("/messages/image", upload.single("file"), async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId || !req.file) {
      res.status(400).json({ error: "contactId e file obrigatórios" });
      return;
    }
    const publicUrl = `${env.API_PUBLIC_URL}/uploads/${req.file.filename}`;
    const msg = await sendImageMessage({
      contactId,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
      filePath: req.file.path,
      mimetype: req.file.mimetype,
      fileName: req.file.originalname,
      caption: req.body?.caption ? String(req.body.caption) : undefined,
      publicUrl,
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
    where: { active: true },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });
  res.json(users);
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
