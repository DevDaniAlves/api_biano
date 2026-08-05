import { Router } from "express";
import multer from "multer";
import { prisma } from "./db.js";
import { adminRequired, authRequired } from "./services/auth.js";
import { dispatchPending, resetDispatchStatus } from "./services/boletos.js";
import { todayYmd } from "./services/csv.js";
import {
  getGestorAutomation,
  resetGestorAutomationRun,
  runGestorAutomationNow,
  updateGestorAutomation,
} from "./services/gestor-automation.js";
import { importCsvBuffer, runScrapeJob } from "./services/jobs.js";
import {
  recordWebhookHit,
  webhookStatusPayload,
} from "./services/whatsapp/webhook-hits.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** Ping público para validar ngrok → API (abra no browser ou curl). */
router.all("/webhook/ping", (req, res) => {
  recordWebhookHit({
    path: "/webhook/ping",
    method: req.method,
    ip: req.ip,
    preview: "ping ok",
  });
  res.json({
    message: "ngrok está batendo na API",
    time: new Date().toISOString(),
    ...webhookStatusPayload(),
  });
});

router.get("/webhook/status", (_req, res) => {
  res.json(webhookStatusPayload());
});

const adminOnly = [authRequired, adminRequired] as const;

router.post("/scrape", ...adminOnly, async (_req, res) => {
  try {
    const { jobId } = await runScrapeJob();
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("em andamento") ? 409 : 500;
    res.status(code).json({ error: message });
  }
});

router.post("/import/csv", ...adminOnly, upload.single("file"), async (req, res) => {
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

router.get("/jobs", ...adminOnly, async (_req, res) => {
  const jobs = await prisma.scrapeJob.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  res.json(jobs);
});

router.get("/jobs/:id", ...adminOnly, async (req, res) => {
  const job = await prisma.scrapeJob.findUnique({ where: { id: String(req.params.id) } });
  if (!job) {
    res.status(404).json({ error: "Job não encontrado" });
    return;
  }
  res.json(job);
});

router.get("/boletos", ...adminOnly, async (req, res) => {
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

router.get("/boletos/stats", ...adminOnly, async (req, res) => {
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

router.post("/dispatch", ...adminOnly, async (req, res) => {
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

router.post("/dispatch/reset", ...adminOnly, async (req, res) => {
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

router.delete("/boletos", ...adminOnly, async (_req, res) => {
  try {
    const boletos = await prisma.boleto.deleteMany({});
    const jobs = await prisma.scrapeJob.deleteMany({});
    res.json({ deletedBoletos: boletos.count, deletedJobs: jobs.count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/gestor/automation", ...adminOnly, async (_req, res) => {
  try {
    res.json(await getGestorAutomation());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch("/gestor/automation", ...adminOnly, async (req, res) => {
  try {
    const body = req.body ?? {};
    const updated = await updateGestorAutomation({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      runTimeHHMM: typeof body.runTimeHHMM === "string" ? body.runTimeHHMM : undefined,
      weekdays: Array.isArray(body.weekdays) ? body.weekdays : undefined,
      dispatchAfterScrape:
        typeof body.dispatchAfterScrape === "boolean" ? body.dispatchAfterScrape : undefined,
    });
    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("inválido") || message.includes("Selecione") ? 400 : 500;
    res.status(code).json({ error: message });
  }
});

router.post("/gestor/automation/reset-run", ...adminOnly, async (_req, res) => {
  try {
    res.json(await resetGestorAutomationRun());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/gestor/automation/run-now", ...adminOnly, async (_req, res) => {
  try {
    const result = await runGestorAutomationNow();
    res.json({ ok: true, ...result, automation: await getGestorAutomation() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("em andamento") ? 409 : 500;
    res.status(code).json({ error: message });
  }
});
