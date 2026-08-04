import { Router } from "express";
import { env } from "../config.js";
import { prisma } from "../db.js";
import { adminRequired, authRequired } from "../services/auth.js";
import { createCatalogLead } from "../services/whatsapp/flow.js";

export const catalogRouter = Router();

/** Público: config de contato + produtos ativos. */
catalogRouter.get("/config", (_req, res) => {
  const phone = (env.WHATSAPP_BUSINESS_PHONE ?? "").replace(/\D/g, "");
  const keyword = env.CATALOG_WA_KEYWORD;
  const mode = env.CATALOG_CONTACT_MODE;
  const waLink =
    mode === "wa_me" && phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(keyword)}`
      : null;
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
