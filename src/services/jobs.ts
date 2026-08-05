import { prisma } from "../db.js";
import { abortActiveBrowser, scrapeExtratoHojeApi, sumarioQtdTotal } from "../scraper/crediario.js";
import { upsertBoletosFromCsv } from "./boletos.js";
import { parseExtratoCsv } from "./csv.js";

const CANCEL_MSG = "Cancelado para iniciar nova coleta";

let running = false;
let scrapeGeneration = 0;

export function isScrapeRunning() {
  return running;
}

/** Cancela jobs queued/running e fecha o Playwright ativo. */
export async function cancelActiveScrapes(message = CANCEL_MSG) {
  scrapeGeneration += 1;
  running = false;
  await abortActiveBrowser();
  await prisma.scrapeJob.updateMany({
    where: { status: { in: ["queued", "running"] } },
    data: { status: "failed", finishedAt: new Date(), message },
  });
}

/** Jobs presos em running após restart do processo. */
export async function failStaleRunningJobs() {
  const r = await prisma.scrapeJob.updateMany({
    where: { status: { in: ["queued", "running"] } },
    data: {
      status: "failed",
      finishedAt: new Date(),
      message: "Interrompido (reinício do servidor)",
    },
  });
  if (r.count) console.log(`[jobs] ${r.count} job(s) órfão(s) cancelado(s)`);
}

async function startScrapeJob() {
  await cancelActiveScrapes();
  const token = scrapeGeneration;
  const job = await prisma.scrapeJob.create({ data: { status: "queued" } });
  return { job, token };
}

export async function runScrapeJob(): Promise<{ jobId: string }> {
  const { job, token } = await startScrapeJob();
  void executeJob(job.id, token);
  return { jobId: job.id };
}

/** Mesmo scrape, mas aguarda o fim (usado pelo automático do Gestor). */
export async function runScrapeJobAndWait() {
  const { job, token } = await startScrapeJob();
  await executeJob(job.id, token);
  return prisma.scrapeJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function markCancelled(jobId: string) {
  await prisma.scrapeJob
    .update({
      where: { id: jobId },
      data: { status: "failed", finishedAt: new Date(), message: CANCEL_MSG },
    })
    .catch(() => {});
}

async function executeJob(jobId: string, token: number): Promise<void> {
  running = true;
  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: { status: "running", startedAt: new Date() },
  });

  try {
    const { rows, rawPath, sumario, itemsRawCount, findAllTopKeys } =
      await scrapeExtratoHojeApi();
    if (token !== scrapeGeneration) {
      await markCancelled(jobId);
      return;
    }

    const qtd = sumarioQtdTotal(sumario);

    if (qtd > 0 && rows.length === 0) {
      await prisma.scrapeJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          rowsFound: 0,
          rowsUpserted: 0,
          csvPath: rawPath,
          message: [
            `Sumário tem ${qtd} parcela(s), mas 0 foram mapeadas.`,
            `Itens brutos: ${itemsRawCount}.`,
            `Chaves findAll: [${findAllTopKeys.join(", ")}].`,
            `Veja dump: ${rawPath}`,
          ].join(" "),
        },
      });
      return;
    }

    const { upserted } = await upsertBoletosFromCsv(rows, jobId);
    if (token !== scrapeGeneration) {
      await markCancelled(jobId);
      return;
    }

    const sumarioTxt =
      sumario && typeof sumario === "object"
        ? ` | sumário: ${JSON.stringify(sumario).slice(0, 200)}`
        : "";

    await prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: "success",
        finishedAt: new Date(),
        rowsFound: rows.length,
        rowsUpserted: upserted,
        csvPath: rawPath,
        message: `API findAll (Hoje): ${rows.length} parcela(s) (brutos: ${itemsRawCount})${sumarioTxt}`,
      },
    });
  } catch (err) {
    if (token !== scrapeGeneration) {
      await markCancelled(jobId);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        finishedAt: new Date(),
        message: message.slice(0, 2000),
      },
    });
  } finally {
    if (token === scrapeGeneration) running = false;
  }
}

export async function importCsvBuffer(
  buffer: Buffer,
  jobId?: string
): Promise<{ rows: number; upserted: number }> {
  const rows = parseExtratoCsv(buffer);
  const { upserted } = await upsertBoletosFromCsv(rows, jobId);
  return { rows: rows.length, upserted };
}
