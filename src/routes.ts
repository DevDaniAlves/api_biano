import { Router } from "express";
import multer from "multer";
import { prisma } from "./db.js";
import { dispatchPending, resetDispatchStatus } from "./services/boletos.js";
import { todayYmd } from "./services/csv.js";
import { importCsvBuffer, runScrapeJob } from "./services/jobs.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Healthcheck
 *     tags: [System]
 *     responses:
 *       200:
 *         description: OK
 */
router.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * @openapi
 * /scrape:
 *   post:
 *     summary: Login Playwright → API findAll (diasVencimento=0 = Hoje) → salva no banco
 *     tags: [Scrape]
 *     responses:
 *       202:
 *         description: Job iniciado
 *       409:
 *         description: Já há scrape em andamento
 */
router.post("/scrape", async (_req, res) => {
  try {
    const { jobId } = await runScrapeJob();
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("em andamento") ? 409 : 500;
    res.status(code).json({ error: message });
  }
});

/**
 * @openapi
 * /import/csv:
 *   post:
 *     summary: Importa CSV do Extrato (sem Playwright) — útil para teste ou upload manual
 *     tags: [Scrape]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Importado
 */
router.post("/import/csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Envie o arquivo CSV no campo file" });
      return;
    }
    const job = await prisma.scrapeJob.create({
      data: { status: "running", startedAt: new Date(), message: "Import manual CSV" },
    });
    const result = await importCsvBuffer(req.file.buffer, job.id);
    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        rowsFound: result.rows,
        rowsUpserted: result.upserted,
        message: "Import manual CSV",
      },
    });
    res.json({ jobId: job.id, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * @openapi
 * /jobs:
 *   get:
 *     summary: Lista jobs de scrape
 *     tags: [Scrape]
 *     responses:
 *       200:
 *         description: Lista
 */
router.get("/jobs", async (_req, res) => {
  const jobs = await prisma.scrapeJob.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  res.json(jobs);
});

/**
 * @openapi
 * /jobs/{id}:
 *   get:
 *     summary: Detalhe de um job
 *     tags: [Scrape]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job
 *       404:
 *         description: Não encontrado
 */
router.get("/jobs/:id", async (req, res) => {
  const job = await prisma.scrapeJob.findUnique({ where: { id: req.params.id } });
  if (!job) {
    res.status(404).json({ error: "Job não encontrado" });
    return;
  }
  res.json(job);
});

/**
 * @openapi
 * /boletos:
 *   get:
 *     summary: Lista boletos
 *     tags: [Boletos]
 *     parameters:
 *       - in: query
 *         name: vencimento
 *         schema:
 *           type: string
 *           example: "2026-07-30"
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, sent, failed, skipped]
 *       - in: query
 *         name: hoje
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Lista de boletos
 */
router.get("/boletos", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const hoje = req.query.hoje === "1" || req.query.hoje === "true";
  const vencimento =
    typeof req.query.vencimento === "string"
      ? req.query.vencimento
      : hoje
        ? todayYmd()
        : undefined;

  const boletos = await prisma.boleto.findMany({
    where: {
      ...(status ? { status: status as "pending" | "sent" | "failed" | "skipped" } : {}),
      ...(vencimento ? { vencimento } : {}),
    },
    orderBy: [{ vencimento: "asc" }, { clienteNome: "asc" }],
  });
  res.json(boletos);
});

/**
 * @openapi
 * /boletos/stats:
 *   get:
 *     summary: Contagem por status (hoje por padrão)
 *     tags: [Boletos]
 *     parameters:
 *       - in: query
 *         name: hoje
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Stats
 */
router.get("/boletos/stats", async (req, res) => {
  const hoje = req.query.hoje !== "false" && req.query.hoje !== "0";
  const vencimento = hoje ? todayYmd() : undefined;
  const grouped = await prisma.boleto.groupBy({
    by: ["status"],
    where: vencimento ? { vencimento } : undefined,
    _count: { _all: true },
    _sum: { valorVencimento: true },
  });
  res.json({
    vencimento: vencimento ?? null,
    byStatus: Object.fromEntries(
      grouped.map((g) => [
        g.status,
        { count: g._count._all, valor: g._sum.valorVencimento ?? 0 },
      ])
    ),
  });
});

/**
 * @openapi
 * /dispatch:
 *   post:
 *     summary: Dispara mensagens de cobrança para boletos pending
 *     tags: [Dispatch]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hoje:
 *                 type: boolean
 *                 default: true
 *               vencimento:
 *                 type: string
 *     responses:
 *       200:
 *         description: Resultado do disparo
 */
router.post("/dispatch", async (req, res) => {
  try {
    const hoje = req.body?.hoje !== false;
    const vencimento =
      typeof req.body?.vencimento === "string"
        ? req.body.vencimento
        : hoje
          ? todayYmd()
          : undefined;
    const result = await dispatchPending(vencimento);
    res.json({ vencimento: vencimento ?? null, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * @openapi
 * /dispatch/reset:
 *   post:
 *     summary: Desmarca envios (sent/failed/skipped → pending) para retestar
 *     tags: [Dispatch]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hoje:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Quantidade resetada
 */
router.post("/dispatch/reset", async (req, res) => {
  try {
    const hoje = req.body?.hoje !== false;
    const vencimento =
      typeof req.body?.vencimento === "string"
        ? req.body.vencimento
        : hoje
          ? todayYmd()
          : undefined;
    const result = await resetDispatchStatus(vencimento);
    res.json({ vencimento: vencimento ?? null, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * @openapi
 * /boletos:
 *   delete:
 *     summary: Apaga todos os boletos (e jobs de scrape)
 *     tags: [Boletos]
 *     responses:
 *       200:
 *         description: Quantidade apagada
 */
router.delete("/boletos", async (_req, res) => {
  try {
    const boletos = await prisma.boleto.deleteMany({});
    const jobs = await prisma.scrapeJob.deleteMany({});
    res.json({ deletedBoletos: boletos.count, deletedJobs: jobs.count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
