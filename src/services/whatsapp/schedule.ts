import { env } from "../../config.js";

/** Horário comercial padrão e utilidades de agenda (America/Sao_Paulo). */

export const BUSINESS = {
  timezone: "America/Sao_Paulo",
  /** JS day 0=dom … 6=sáb → [início, fim] em minutos do dia; null = fechado */
  hours: {
    0: null,
    1: [8 * 60, 18 * 60 + 30],
    2: [8 * 60, 18 * 60 + 30],
    3: [8 * 60, 18 * 60 + 30],
    4: [8 * 60, 18 * 60 + 30],
    5: [8 * 60, 18 * 60 + 30],
    6: [8 * 60, 16 * 60 + 30],
  } as Record<number, [number, number] | null>,
  offerMinutes: 10,
};

export function businessHoursLabel(): string {
  return "seg–sex 08:00–18:30, sáb 08:00–16:30";
}

export function businessHoursBlock(): string {
  return (
    "⏰ Horário de atendimento\n\n" +
    "🗓️ Segunda a sexta: 08h às 18h30\n" +
    "🗓️ Sábado: 08h às 16h30"
  );
}

export function nowInSaoPaulo(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: BUSINESS.timezone }));
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function isBusinessHours(d = nowInSaoPaulo()): boolean {
  if (env.SKIP_BUSINESS_HOURS) return true;
  const slot = BUSINESS.hours[d.getDay()];
  if (!slot) return false;
  const m = minutesOfDay(d);
  return m >= slot[0] && m < slot[1];
}

export interface UnavailabilityWindow {
  dayOfWeek: number;
  startMin: number;
  endMin: number;
}

export interface ScheduleSlot {
  dayOfWeek: number;
  startMin: number;
  endMin: number;
}

export interface LeavePeriod {
  startsAt: Date;
  endsAt: Date;
}

/** true se o vendedor está marcado como inativo neste momento */
export function isUserUnavailable(
  windows: UnavailabilityWindow[],
  d = nowInSaoPaulo()
): boolean {
  const day = d.getDay();
  const m = minutesOfDay(d);
  return windows.some(
    (w) => w.dayOfWeek === day && m >= w.startMin && m < w.endMin
  );
}

/** true se está em folga/férias (intervalo de datas real). */
export function isOnLeave(leaves: LeavePeriod[], now = new Date()): boolean {
  return leaves.some((l) => now >= l.startsAt && now <= l.endsAt);
}

/**
 * Se há escala cadastrada: precisa estar dentro de algum intervalo do dia.
 * Sem escala: disponível (sujeito a leave/unavailability).
 */
export function isWithinSchedule(
  slots: ScheduleSlot[],
  d = nowInSaoPaulo()
): boolean {
  if (slots.length === 0) return true;
  const day = d.getDay();
  const m = minutesOfDay(d);
  return slots.some(
    (s) => s.dayOfWeek === day && m >= s.startMin && m < s.endMin
  );
}

export function parseHHMMToMin(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function minToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function offerExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + BUSINESS.offerMinutes * 60_000);
}

/** Início da contagem do tempo até assumir. */
export function assumeMetricStart(
  contact: {
    openToAll: boolean;
    firstOfferedAt: Date | null;
    firstOfferedToId: string | null;
    openedToAllAt: Date | null;
    offeredAt: Date | null;
    createdAt: Date;
  },
  assumingUserId: string
): Date {
  // 2º vendedor (após 10 min / openToAll): conta da disponibilização
  if (
    contact.openedToAllAt &&
    contact.firstOfferedToId &&
    contact.firstOfferedToId !== assumingUserId
  ) {
    return contact.openedToAllAt;
  }
  // Destinado a um vendedor (ou o próprio assumiu): conta do disparo
  if (contact.firstOfferedAt) return contact.firstOfferedAt;
  if (contact.openedToAllAt) return contact.openedToAllAt;
  if (contact.offeredAt) return contact.offeredAt;
  return contact.createdAt;
}
