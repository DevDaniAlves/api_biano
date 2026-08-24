import { Router } from "express";
import { env } from "../config.js";
import { prisma } from "../db.js";
import { adminRequired, authRequired } from "../services/auth.js";
import { createCatalogLead } from "../services/whatsapp/flow.js";
import { buildWaMeLink } from "../services/wa-link.js";

export const catalogRouter = Router();

function businessPhone(): string {
  return (env.WHATSAPP_BUSINESS_PHONE ?? "").replace(/\D/g, "");
}

/** Público: config de contato + produtos ativos. */
catalogRouter.get("/config", (_req, res) => {
  const phone = businessPhone();
  const keyword = env.CATALOG_WA_KEYWORD;
  const mode = env.CATALOG_CONTACT_MODE;
  const preview =
    `Olá! Vim pelo catálogo da Calangus Moda Jovem e gostaria de falar com um vendedor.\n\n${keyword}`;
  const waLink = mode === "wa_me" && phone ? buildWaMeLink(phone, preview) : null;
  res.json({ mode, waLink, keyword, phone: phone || null });
});

catalogRouter.get("/products", async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
  });
  res.json(products);
});

catalogRouter.post("/leads", async (req, res) => {
  try {
    if (env.CATALOG_CONTACT_MODE !== "form") {
      res.status(400).json({ error: "Modo de contato não é formulário" });
      return;
    }
    const name = String(req.body?.name ?? "").trim();
    const phone = String(req.body?.phone ?? "").trim();
    const message = req.body?.message ? String(req.body.message).trim() : undefined;
    if (!name || !phone) {
      res.status(400).json({ error: "name e phone obrigatórios" });
      return;
    }
    const contact = await createCatalogLead({ name, phone, message });
    res.status(201).json({ ok: true, contactId: contact.id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Admin CRUD */
catalogRouter.get("/admin/products", authRequired, adminRequired, async (_req, res) => {
  res.json(
    await prisma.product.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    })
  );
});

catalogRouter.post("/admin/products", authRequired, adminRequired, async (req, res) => {
  try {
    const product = await prisma.product.create({
      data: {
        name: String(req.body?.name ?? "").trim(),
        description: req.body?.description ? String(req.body.description) : null,
        price: Number(req.body?.price ?? 0),
        imageUrl: req.body?.imageUrl ? String(req.body.imageUrl) : null,
        active: req.body?.active !== false,
        sortOrder: Number(req.body?.sortOrder ?? 0),
      },
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.put("/admin/products/:id", authRequired, adminRequired, async (req, res) => {
  try {
    const product = await prisma.product.update({
      where: { id: String(req.params.id) },
      data: {
        ...(req.body?.name != null ? { name: String(req.body.name).trim() } : {}),
        ...(req.body?.description !== undefined
          ? { description: req.body.description ? String(req.body.description) : null }
          : {}),
        ...(req.body?.price != null ? { price: Number(req.body.price) } : {}),
        ...(req.body?.imageUrl !== undefined
          ? { imageUrl: req.body.imageUrl ? String(req.body.imageUrl) : null }
          : {}),
        ...(req.body?.active !== undefined ? { active: Boolean(req.body.active) } : {}),
        ...(req.body?.sortOrder != null ? { sortOrder: Number(req.body.sortOrder) } : {}),
      },
    });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.delete("/admin/products/:id", authRequired, adminRequired, async (req, res) => {
  try {
    await prisma.product.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Público: só fotos aprovadas para a LP. */
catalogRouter.get("/gallery", async (_req, res) => {
  const items = await prisma.galleryImage.findMany({
    where: { status: "approved" },
    orderBy: [{ sortOrder: "asc" }, { reviewedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      imageUrl: true,
      caption: true,
      sortOrder: true,
      createdAt: true,
    },
  });
  res.json(items);
});

const galleryInclude = {
  submittedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

/** Admin: listar (filtro status opcional). */
catalogRouter.get("/admin/gallery", authRequired, adminRequired, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const where =
    status === "pending" || status === "approved" || status === "rejected"
      ? { status: status as "pending" | "approved" | "rejected" }
      : {};
  res.json(
    await prisma.galleryImage.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: galleryInclude,
    })
  );
});

/** Admin: aprovar / rejeitar / ordenar. */
catalogRouter.patch("/admin/gallery/:id", authRequired, adminRequired, async (req, res) => {
  try {
    const data: {
      status?: "pending" | "approved" | "rejected";
      sortOrder?: number;
      caption?: string | null;
      reviewedById?: string;
      reviewedAt?: Date;
    } = {};
    if (
      req.body?.status === "pending" ||
      req.body?.status === "approved" ||
      req.body?.status === "rejected"
    ) {
      data.status = req.body.status;
      data.reviewedById = req.user!.id;
      data.reviewedAt = new Date();
    }
    if (typeof req.body?.sortOrder === "number") data.sortOrder = req.body.sortOrder;
    if (req.body?.caption !== undefined) {
      data.caption = req.body.caption ? String(req.body.caption).trim() : null;
    }
    if (!Object.keys(data).length) {
      res.status(400).json({ error: "Nada para atualizar" });
      return;
    }
    const row = await prisma.galleryImage.update({
      where: { id: String(req.params.id) },
      data,
      include: galleryInclude,
    });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.delete("/admin/gallery/:id", authRequired, adminRequired, async (req, res) => {
  try {
    await prisma.galleryImage.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
