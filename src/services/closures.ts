import { prisma } from "../db.js";
import { addDaysYmd, todayYmd } from "./csv.js";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function saoPauloNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
}

export function assertYmd(value: string): string {
  const v = value.trim();
  if (!YMD_RE.test(v)) throw new Error("Data inválida. Use YYYY-MM-DD");
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error("Data inválida");
  }
  return v;
}

export async function listClosures() {
  return prisma.businessClosure.findMany({ orderBy: { dateYmd: "asc" } });
}

export async function createClosure(input: {
  dateYmd: string;
  label?: string | null;
  blockAttendance?: boolean;
  blockBoleto?: boolean;
}) {
  const dateYmd = assertYmd(input.dateYmd);
  return prisma.businessClosure.create({
    data: {
      dateYmd,
      label: input.label?.trim() || null,
      blockAttendance: input.blockAttendance !== false,
      blockBoleto: input.blockBoleto !== false,
    },
  });
}

export async function updateClosure(
  id: string,
  input: {
    label?: string | null;
    blockAttendance?: boolean;
    blockBoleto?: boolean;
  }
) {
  const data: {
    label?: string | null;
    blockAttendance?: boolean;
    blockBoleto?: boolean;
  } = {};
  if (input.label !== undefined) data.label = input.label?.trim() || null;
  if (typeof input.blockAttendance === "boolean") data.blockAttendance = input.blockAttendance;
  if (typeof input.blockBoleto === "boolean") data.blockBoleto = input.blockBoleto;
  return prisma.businessClosure.update({ where: { id }, data });
}

export async function deleteClosure(id: string) {
  await prisma.businessClosure.delete({ where: { id } });
  return { ok: true };
}

export async function isAttendanceBlockedYmd(ymd: string): Promise<boolean> {
  const row = await prisma.businessClosure.findUnique({
    where: { dateYmd: ymd },
    select: { blockAttendance: true },
  });
  return Boolean(row?.blockAttendance);
}

export async function isBoletoBlockedYmd(ymd: string): Promise<boolean> {
  const row = await prisma.businessClosure.findUnique({
    where: { dateYmd: ymd },
    select: { blockBoleto: true },
  });
  return Boolean(row?.blockBoleto);
}

export async function isAttendanceBlockedToday(now = saoPauloNow()): Promise<boolean> {
  return isAttendanceBlockedYmd(todayYmd(now));
}

export async function isBoletoBlockedToday(now = saoPauloNow()): Promise<boolean> {
  return isBoletoBlockedYmd(todayYmd(now));
}

/** Dias com blockBoleto no intervalo [fromYmd, toYmd] inclusive. */
export async function boletoBlockedYmdsInRange(fromYmd: string, toYmd: string): Promise<Set<string>> {
  const rows = await prisma.businessClosure.findMany({
    where: {
      dateYmd: { gte: fromYmd, lte: toYmd },
      blockBoleto: true,
    },
    select: { dateYmd: true },
  });
  return new Set(rows.map((r) => r.dateYmd));
}

/**
 * Dia útil de boleto = weekday da automação (padrão seg–sex) e sem feriado blockBoleto.
 * Dom/sáb nunca são úteis para boleto automático.
 */
export function isWeekdayForBoletoAutomation(ymd: string, weekdays: number[] = [1, 2, 3, 4, 5]): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return weekdays.includes(day);
}

export async function isBoletoBusinessDay(
  ymd: string,
  weekdays: number[] = [1, 2, 3, 4, 5]
): Promise<boolean> {
  if (!isWeekdayForBoletoAutomation(ymd, weekdays)) return false;
  return !(await isBoletoBlockedYmd(ymd));
}

/**
 * Vencimentos a disparar hoje: do dia seguinte ao último dia útil de boleto até hoje.
 * Ex.: feriado na segunda → terça retorna sáb, dom, seg, ter.
 */
export async function vencimentosParaDisparoComFeriados(
  now?: Date,
  weekdays: number[] = [1, 2, 3, 4, 5]
): Promise<string[]> {
  const sp = now ?? saoPauloNow();
  const hoje = todayYmd(sp);

  // Não dispara em feriado de boleto
  if (await isBoletoBlockedYmd(hoje)) return [];

  // Acha o último dia útil anterior (exclui hoje)
  let cursor = addDaysYmd(hoje, -1);
  for (let i = 0; i < 60; i++) {
    if (await isBoletoBusinessDay(cursor, weekdays)) {
      break;
    }
    cursor = addDaysYmd(cursor, -1);
  }

  // Inclui do dia seguinte ao último útil até hoje
  const start = addDaysYmd(cursor, 1);
  const out: string[] = [];
  let d = start;
  while (d <= hoje) {
    out.push(d);
    d = addDaysYmd(d, 1);
  }
  return out;
}
