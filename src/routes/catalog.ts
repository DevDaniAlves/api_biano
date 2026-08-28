import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { env } from "../config.js";
import { prisma } from "../db.js";
import {
  adminRequired,
  authRequired,
  catalogManageRequired,
} from "../services/auth.js";
import {
  ensureCatalogSettings,
  productInclude,
  serializeProduct,
  syncProductCover,
} from "../services/catalog.js";
import { createCatalogLead } from "../services/whatsapp/flow.js";
import { UPLOADS_DIR } from "../services/whatsapp/service.js";
import { buildWaMeLink } from "../services/wa-link.js";

export const catalogRouter = Router();

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || (file.mimetype.startsWith("image/") ? ".jpg" : ".bin");
      cb(null, `catalog-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Envie apenas imagens"));
  },
});

function businessPhone(): string {
  return (env.WHATSAPP_BUSINESS_PHONE ?? "").replace(/\D/g, "");
}

/** Público: config de contato + flag em construção. */
catalogRouter.get("/config", async (_req, res) => {
  const phone = businessPhone();
  const keyword = env.CATALOG_WA_KEYWORD;
  const mode = env.CATALOG_CONTACT_MODE;
  const preview =
    `Olá! Vim pelo catálogo da Calangus Moda Jovem e gostaria de falar com um vendedor.\n\n${keyword}`;
  const waLink = mode === "wa_me" && phone ? buildWaMeLink(phone, preview) : null;
  const settings = await ensureCatalogSettings();
  res.json({
    mode,
    waLink,
    keyword,
    phone: phone || null,
    underConstruction: settings.underConstruction,
  });
});

catalogRouter.get("/products", async (_req, res) => {
  const settings = await ensureCatalogSettings();
  if (settings.underConstruction) {
    res.json([]);
    return;
  }
  const products = await prisma.product.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    include: productInclude,
  });
  res.json(products.map((p) => serializeProduct(p, { admin: true })));
});

catalogRouter.get("/gallery", async (_req, res) => {
  const settings = await ensureCatalogSettings();
  if (settings.underConstruction) {
    res.json([]);
    return;
  }
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

/** Config admin (em construção). */
catalogRouter.get("/admin/settings", authRequired, catalogManageRequired, async (_req, res) => {
  const settings = await ensureCatalogSettings();
  res.json({ underConstruction: settings.underConstruction });
});

catalogRouter.put("/admin/settings", authRequired, catalogManageRequired, async (req, res) => {
  const underConstruction = Boolean(req.body?.underConstruction);
  const settings = await prisma.catalogSettings.upsert({
    where: { id: "default" },
    update: { underConstruction },
    create: { id: "default", underConstruction },
  });
  res.json({ underConstruction: settings.underConstruction });
});

/** CRUD produtos */
catalogRouter.get("/admin/products", authRequired, catalogManageRequired, async (_req, res) => {
  const products = await prisma.product.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    include: productInclude,
  });
  res.json(products.map((p) => serializeProduct(p, { admin: true })));
});

catalogRouter.post("/admin/products", authRequired, catalogManageRequired, async (req, res) => {
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
      include: productInclude,
    });
    res.status(201).json(serializeProduct(product, { admin: true }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.put("/admin/products/:id", authRequired, catalogManageRequired, async (req, res) => {
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
      include: productInclude,
    });
    res.json(serializeProduct(product, { admin: true }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

catalogRouter.delete("/admin/products/:id", authRequired, catalogManageRequired, async (req, res) => {
  try {
    await prisma.product.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Upload de uma ou várias fotos por produto. */
catalogRouter.post(
  "/admin/products/:id/images",
  authRequired,
  catalogManageRequired,
  upload.array("files", 12),
  async (req, res) => {
    try {
      const productId = String(req.params.id);
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) {
        res.status(404).json({ error: "Produto não encontrado" });
        return;
      }
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length) {
        res.status(400).json({ error: "Envie ao menos uma imagem" });
        return;
      }
      const maxSort = await prisma.productImage.aggregate({
        where: { productId },
        _max: { sortOrder: true },
      });
      let sort = (maxSort._max.sortOrder ?? -1) + 1;
      for (const file of files) {
        await prisma.productImage.create({
          data: { productId, imageUrl: `/uploads/${file.filename}`, sortOrder: sort++ },
        });
      }
      await syncProductCover(productId);
      const updated = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        include: productInclude,
      });
      res.status(201).json(serializeProduct(updated, { admin: true }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

/** Reordena fotos do produto (primeira = capa na loja). */
catalogRouter.put(
  "/admin/products/:productId/images/order",
  authRequired,
  catalogManageRequired,
  async (req, res) => {
    try {
      const productId = String(req.params.productId);
      const imageIds = req.body?.imageIds;
      if (!Array.isArray(imageIds) || !imageIds.length) {
        res.status(400).json({ error: "imageIds obrigatório" });
        return;
      }
      const existing = await prisma.productImage.findMany({ where: { productId } });
      if (
        imageIds.length !== existing.length ||
        !imageIds.every((id: unknown) => typeof id === "string" && existing.some((r) => r.id === id))
      ) {
        res.status(400).json({ error: "Lista de fotos inválida" });
        return;
      }
      await prisma.$transaction(
        imageIds.map((id: string, sortOrder: number) =>
          prisma.productImage.update({ where: { id }, data: { sortOrder } })
        )
      );
      await syncProductCover(productId);
      const updated = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        include: productInclude,
      });
      res.json(serializeProduct(updated, { admin: true }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

catalogRouter.delete(
  "/admin/products/:productId/images/:imageId",
  authRequired,
  catalogManageRequired,
  async (req, res) => {
    try {
      const productId = String(req.params.productId);
      const imageId = String(req.params.imageId);
      const row = await prisma.productImage.findFirst({
        where: { id: imageId, productId },
      });
      if (!row) {
        res.status(404).json({ error: "Foto não encontrada" });
        return;
      }
      await prisma.productImage.delete({ where: { id: imageId } });
      await syncProductCover(productId);
      const updated = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        include: productInclude,
      });
      res.json(serializeProduct(updated, { admin: true }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

const galleryInclude = {
  submittedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

/** Admin galeria — só admin */
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
