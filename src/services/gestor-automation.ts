import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { todayYmd, vencimentosParaDisparoHoje } from "./csv.js";
import { cancelActiveDispatch, dispatchPending, dispatchPendingForVencimentos, isDispatchRunning } from "./boletos.js";
import { cancelActiveScrapes, isScrapeRunning, runScrapeJobAndWait } from "./jobs.js";
import { minutesOfDay, nowInSaoPaulo } from "./whatsapp/schedule.js";

const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

function asWeekdays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return DEFAULT_WEEKDAYS;
  return raw.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

function parseHHMM(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function normalizeHHMM(value: string): string {
  const mins = parseHHMM(value);
  if (mins == null) throw new Error("Horário inválido. Use HH:mm (ex.: 08:00)");
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function ensureGestorAutomation() {
  return prisma.gestorAutomation.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
}

export async function getGestorAutomation() {
  const row = await ensureGestorAutomation();
  return {
    ...row,
    weekdays: asWeekdays(row.weekdays),
    timezone: "America/Sao_Paulo",
  };
}

export async function updateGestorAutomation(input: {
  enabled?: boolean;
  runTimeHHMM?: string;
  weekdays?: number[];
  dispatchAfterScrape?: boolean;
}) {
  const data: Prisma.GestorAutomationUpdateInput = {};

  if (typeof input.enabled === "boolean") data.enabled = input.enabled;
  if (typeof input.dispatchAfterScrape === "boolean") {
    data.dispatchAfterScrape = input.dispatchAfterScrape;
  }
  if (typeof input.runTimeHHMM === "string") {
    data.runTimeHHMM = normalizeHHMM(input.runTimeHHMM);
  }
  if (Array.isArray(input.weekdays)) {
    const days = input.weekdays
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    if (days.length === 0) throw new Error("Selecione ao menos um dia da semana");
    data.weekdays = [...new Set(days)].sort((a, b) => a - b);
  }

  const row = await prisma.gestorAutomation.upsert({
    where: { id: "default" },
    update: data,
    create: {
      id: "default",
      enabled: typeof input.enabled === "boolean" ? input.enabled : false,
      runTimeHHMM:
        typeof input.runTimeHHMM === "string" ? normalizeHHMM(input.runTimeHHMM) : "08:00",
      weekdays: Array.isArray(input.weekdays)
        ? ([...new Set(input.weekdays.map(Number))].sort((a, b) => a - b) as Prisma.InputJsonValue)
        : DEFAULT_WEEKDAYS,
      dispatchAfterScrape:
        typeof input.dispatchAfterScrape === "boolean" ? input.dispatchAfterScrape : true,
    },
  });

  return {
    ...row,
    weekdays: asWeekdays(row.weekdays),
    timezone: "America/Sao_Paulo",
  };
}

export async function resetGestorAutomationRun() {
  await ensureGestorAutomation();
  const row = await prisma.gestorAutomation.update({
    where: { id: "default" },
    data: {
      lastRunAt: null,
      lastRunYmd: null,
      lastRunStatus: null,
      lastRunMessage: null,
    },
  });
  return {
    ...row,
    weekdays: asWeekdays(row.weekdays),
    timezone: "America/Sao_Paulo",
  };
}

let tickRunning = false;
let autoGeneration = 0;

export async function failStaleAutomationRun() {
  const row = await prisma.gestorAutomation.findUnique({ where: { id: "default" } });
  if (row?.lastRunStatus !== "running") return;
  await prisma.gestorAutomation.update({
    where: { id: "default" },
    data: {
      lastRunStatus: "failed",
      lastRunYmd: null,
      lastRunMessage: "Interrompido (reinício do servidor)",
    },
  });
  console.log("[gestor-auto] execução órfã cancelada");
}

async function executeAutomationOnce(token: number) {
  const alive = () => token === autoGeneration;
  const cfg = await ensureGestorAutomation();
  const ymd = todayYmd();

  await prisma.gestorAutomation.update({
    where: { id: "default" },
    data: {
      lastRunAt: new Date(),
      lastRunYmd: ymd,
      lastRunStatus: "running",
      lastRunMessage: "Coletando (Playwright)…",
    },
  });

  const job = await runScrapeJobAndWait();
  if (!alive()) return { ok: false as const, message: "cancelado" };
  if (job.status !== "success") {
    await prisma.gestorAutomation.update({
      where: { id: "default" },
      data: {
        lastRunStatus: "failed",
        lastRunYmd: null,
        lastRunMessage: `Scrape falhou: ${job.message ?? job.status}`,
      },
    });
    return { ok: false as const, message: job.message ?? job.status };
  }

  let msg = `Scrape OK: ${job.rowsUpserted} boleto(s)`;
  if (cfg.dispatchAfterScrape) {
    const vencimentos = vencimentosParaDisparoHoje(nowInSaoPaulo());
    const d = await dispatchPendingForVencimentos(vencimentos);
    if (!alive()) return { ok: false as const, message: "cancelado" };
    const vencLabel =
      vencimentos.length > 1 ? vencimentos.map((v) => v.slice(5)).join(", ") : vencimentos[0] ?? ymd;
    msg += ` · Disparo (${vencLabel}): ${d.sent} enviados, ${d.failed} falhas, ${d.skipped} ignorados`;
  }

  if (!alive()) return { ok: false as const, message: "cancelado" };
  await prisma.gestorAutomation.update({
    where: { id: "default" },
    data: {
      lastRunStatus: "success",
      lastRunMessage: msg,
    },
  });
  console.log(`[gestor-auto] ${ymd} ${cfg.runTimeHHMM} — ${msg}`);
  return { ok: true as const, message: msg };
}

/** Dispara agora (teste), ignorando horário e trava do dia. */
export async function runGestorAutomationNow() {
  autoGeneration += 1;
  const token = autoGeneration;
  tickRunning = true;
  try {
    await cancelActiveScrapes("Cancelado para iniciar nova execução");
    cancelActiveDispatch();
    const ymd = todayYmd();
    await prisma.gestorAutomation.update({
      where: { id: "default" },
      data: {
        lastRunAt: new Date(),
        lastRunYmd: ymd,
        lastRunStatus: "running",
        lastRunMessage: "Coletando (Playwright)…",
      },
    });
  } catch (err) {
    if (token === autoGeneration) tickRunning = false;
    throw err;
  }
  void (async () => {
    try {
      await executeAutomationOnce(token);
    } catch (err) {
      if (token !== autoGeneration) return;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.gestorAutomation.update({
        where: { id: "default" },
        data: {
          lastRunStatus: "failed",
          lastRunYmd: null,
          lastRunMessage: message.slice(0, 1000),
        },
      });
      console.error("[gestor-auto]", message);
    } finally {
      if (token === autoGeneration) tickRunning = false;
    }
  })();
  return { started: true, message: "Execução iniciada" };
}

/** Chamado a cada ~30s: se automático ativo e horário SP bate, scrape (+ disparo). */
export async function tickGestorAutomation() {
  if (tickRunning || isScrapeRunning() || isDispatchRunning()) return;
  const cfg = await ensureGestorAutomation();
  if (!cfg.enabled) return;

  const target = parseHHMM(cfg.runTimeHHMM);
  if (target == null) return;

  const now = nowInSaoPaulo();
  const weekdays = asWeekdays(cfg.weekdays);
  if (!weekdays.includes(now.getDay())) return;

  const nowMin = minutesOfDay(now);
  // Roda a partir do horário configurado (não só no minuto exato)
  if (nowMin < target) return;

  const ymd = todayYmd();
  // Sucesso (ou em andamento) trava o dia. Falha libera retry num horário posterior.
  if (cfg.lastRunYmd === ymd && cfg.lastRunStatus !== "failed") return;

  if (cfg.lastRunStatus === "failed" && cfg.lastRunAt) {
    const lastSp = new Date(
      cfg.lastRunAt.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    );
    const lastYmd = `${lastSp.getFullYear()}-${String(lastSp.getMonth() + 1).padStart(2, "0")}-${String(lastSp.getDate()).padStart(2, "0")}`;
    if (lastYmd === ymd) {
      const lastMin = minutesOfDay(lastSp);
      // Evita loop a cada 30s: só tenta de novo no minuto agendado, se for depois da falha
      if (nowMin !== target || target <= lastMin) return;
    }
  }

  autoGeneration += 1;
  const token = autoGeneration;
  tickRunning = true;
  try {
    await executeAutomationOnce(token);
  } catch (err) {
    if (token !== autoGeneration) return;
    const message = err instanceof Error ? err.message : String(err);
    await prisma.gestorAutomation.update({
      where: { id: "default" },
      data: {
        lastRunStatus: "failed",
        lastRunYmd: null,
        lastRunMessage: message.slice(0, 1000),
      },
    });
    console.error("[gestor-auto]", message);
  } finally {
    if (token === autoGeneration) tickRunning = false;
  }
}
