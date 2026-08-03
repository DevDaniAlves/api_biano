/** Horário comercial padrão e utilidades de agenda (America/Sao_Paulo). */

export const BUSINESS = {
  timezone: "America/Sao_Paulo",
  weekdays: [1, 2, 3, 4, 5], // seg–sex
  startMin: 8 * 60,
  endMin: 18 * 60,
  offerMinutes: 10,
};

export function nowInSaoPaulo(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: BUSINESS.timezone }));
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function isBusinessHours(d = nowInSaoPaulo()): boolean {
  if (!BUSINESS.weekdays.includes(d.getDay())) return false;
  const m = minutesOfDay(d);
  return m >= BUSINESS.startMin && m < BUSINESS.endMin;
}

export interface UnavailabilityWindow {
  dayOfWeek: number;
  startMin: number;
  endMin: number;
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

export function offerExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + BUSINESS.offerMinutes * 60_000);
}
