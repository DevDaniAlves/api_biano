import { prisma } from "../db.js";
import { scrapeExtratoHojeApi, sumarioQtdTotal } from "../scraper/crediario.js";
import { upsertBoletosFromCsv } from "./boletos.js";
import { parseExtratoCsv } from "./csv.js";

/** Evita scrapes paralelos. */
let running = false;

export async function runScrapeJob(): Promise<{ jobId: string }> {
  if (running) {
    throw new Error("Já existe um scrape em andamento");
  }

  const job = await prisma.scrapeJob.create({ data: { status: "queued" } });
  void executeJob(job.id);
  return { jobId: job.id };
}

async function executeJob(jobId: string): Promise<void> {
  running = true;
  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: { status: "running", startedAt: new Date() },
  });

  try {
    const { rows, rawPath, sumario, itemsRawCount, findAllTopKeys } =
      await scrapeExtratoHojeApi();
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
    running = false;
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
