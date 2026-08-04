import { prisma } from "../../db.js";
import { nowInSaoPaulo } from "./schedule.js";

function startOfDaySP(d: Date): Date {
  const sp = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  sp.setHours(0, 0, 0, 0);
  // converter de volta aproximando pelo offset local vs UTC via ISO parts
  const y = sp.getFullYear();
  const m = sp.getMonth();
  const day = sp.getDate();
  // meia-noite SP ≈ Date.UTC(y,m,day) + 3h (BRT) — usa formatter estável
  const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-03:00`;
  return new Date(iso);
}

function endOfDaySP(d: Date): Date {
  const s = startOfDaySP(d);
  return new Date(s.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function resolveReportRange(opts: {
  preset?: string;
  from?: string;
  to?: string;
  month?: string;
}): { from: Date; to: Date; label: string; preset: string } {
  const now = nowInSaoPaulo();
  const preset = (opts.preset || "").trim() || (opts.month ? "month" : opts.from ? "custom" : "month");

  if (preset === "today") {
    const from = startOfDaySP(now);
    const to = endOfDaySP(now);
    return { from, to, label: "Hoje", preset };
  }

  if (preset === "week") {
    const sp = nowInSaoPaulo();
    const day = sp.getDay(); // 0=dom
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = addDays(startOfDaySP(sp), mondayOffset);
    return {
      from: monday,
      to: endOfDaySP(now),
      label: "Esta semana",
      preset,
    };
  }

  if (preset === "month" || opts.month) {
    const ym = opts.month?.match(/^(\d{4})-(\d{2})$/);
    const y = ym ? Number(ym[1]) : now.getFullYear();
    const m = ym ? Number(ym[2]) - 1 : now.getMonth();
    const from = new Date(`${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00-03:00`);
    const lastDay = new Date(y, m + 1, 0).getDate();
    const to = new Date(
      `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}T23:59:59-03:00`
    );
    const label = from.toLocaleDateString("pt-BR", {
      month: "long",
      year: "numeric",
      timeZone: "America/Sao_Paulo",
    });
    return { from, to, label: label.charAt(0).toUpperCase() + label.slice(1), preset: "month" };
  }

  if (preset === "custom" || opts.from || opts.to) {
    const from = opts.from
      ? new Date(`${opts.from}T00:00:00-03:00`)
      : startOfDaySP(addDays(now, -30));
    const to = opts.to ? new Date(`${opts.to}T23:59:59-03:00`) : endOfDaySP(now);
    return {
      from,
      to,
      label: `${from.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} – ${to.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
      preset: "custom",
    };
  }

  // default: mês atual
  return resolveReportRange({ preset: "month" });
}

function ymdSP(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export async function getWhatsAppReports(opts: {
  preset?: string;
  from?: string;
  to?: string;
  month?: string;
} = {}) {
  const range = resolveReportRange(opts);
  const { from, to } = range;

  const contactsInPeriod = await prisma.whatsAppContact.findMany({
    where: {
      OR: [
        { assignedAt: { gte: from, lte: to } },
        { openedToAllAt: { gte: from, lte: to } },
        { ratingAskedAt: { gte: from, lte: to } },
        { createdAt: { gte: from, lte: to } },
      ],
    },
    include: {
      assignedTo: { select: { id: true, name: true } },
    },
  });

  const byStatusMap: Record<string, number> = {};
  for (const c of contactsInPeriod) {
    byStatusMap[c.status] = (byStatusMap[c.status] ?? 0) + 1;
  }

  const rated = contactsInPeriod
    .filter((c) => c.rating != null)
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));

  const avgRating =
    rated.length > 0
      ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
      : null;

  const ratingDistribution: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
  };
  for (const r of rated) {
    const k = String(r.rating ?? "");
    if (k in ratingDistribution) ratingDistribution[k] += 1;
  }

  const bySellerMap = new Map<
    string,
    { sellerId: string; sellerName: string; count: number; sum: number }
  >();
  for (const r of rated) {
    const id = r.assignedToId ?? "sem-vendedor";
    const name = r.assignedTo?.name ?? "Sem vendedor";
    const cur = bySellerMap.get(id) ?? { sellerId: id, sellerName: name, count: 0, sum: 0 };
    cur.count += 1;
    cur.sum += r.rating ?? 0;
    bySellerMap.set(id, cur);
  }
  const ratingsBySeller = [...bySellerMap.values()]
    .map((s) => ({
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      count: s.count,
      avgRating: s.count ? s.sum / s.count : null,
    }))
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0));

  const assumed = contactsInPeriod.filter(
    (c) => c.assumeWaitSeconds != null && c.assignedToId && c.assignedAt && c.assignedAt >= from && c.assignedAt <= to
  );

  const assumeAll = assumed.map((c) => c.assumeWaitSeconds ?? 0);
  const avgAssumeSeconds = avg(assumeAll);

  const assumeBySellerMap = new Map<
    string,
    { sellerId: string; sellerName: string; count: number; sum: number }
  >();
  for (const c of assumed) {
    const id = c.assignedToId!;
    const name = c.assignedTo?.name ?? "—";
    const cur = assumeBySellerMap.get(id) ?? {
      sellerId: id,
      sellerName: name,
      count: 0,
      sum: 0,
    };
    cur.count += 1;
    cur.sum += c.assumeWaitSeconds ?? 0;
    assumeBySellerMap.set(id, cur);
  }
  const assumeBySeller = [...assumeBySellerMap.values()]
    .map((s) => ({
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      count: s.count,
      avgSeconds: s.count ? Math.round(s.sum / s.count) : null,
    }))
    .sort((a, b) => (a.avgSeconds ?? 0) - (b.avgSeconds ?? 0));

  /** Ofertas que venceram (10 min) no período */
  const expired = contactsInPeriod.filter(
    (c) => c.openedToAllAt && c.openedToAllAt >= from && c.openedToAllAt <= to
  );
  const expiredCount = expired.length;

  /** Pegos de outros: assumidos por quem não era o destinatário original */
  const taken = assumed.filter(
    (c) => c.firstOfferedToId && c.assignedToId && c.firstOfferedToId !== c.assignedToId
  );
  const takenCount = taken.length;

  const expiredBySellerMap = new Map<
    string,
    { sellerId: string; sellerName: string; expired: number; taken: number }
  >();

  const sellers = await prisma.user.findMany({
    where: { role: "seller", active: true },
    select: { id: true, name: true },
  });
  for (const s of sellers) {
    expiredBySellerMap.set(s.id, {
      sellerId: s.id,
      sellerName: s.name,
      expired: 0,
      taken: 0,
    });
  }

  for (const c of expired) {
    const id = c.firstOfferedToId;
    if (!id) continue;
    const name =
      sellers.find((s) => s.id === id)?.name ??
      "Vendedor";
    const cur = expiredBySellerMap.get(id) ?? {
      sellerId: id,
      sellerName: name,
      expired: 0,
      taken: 0,
    };
    cur.expired += 1;
    expiredBySellerMap.set(id, cur);
  }

  for (const c of taken) {
    const id = c.assignedToId!;
    const cur = expiredBySellerMap.get(id) ?? {
      sellerId: id,
      sellerName: c.assignedTo?.name ?? "—",
      expired: 0,
      taken: 0,
    };
    cur.taken += 1;
    expiredBySellerMap.set(id, cur);
  }

  const offerStatsBySeller = [...expiredBySellerMap.values()].sort(
    (a, b) => b.taken + b.expired - (a.taken + a.expired)
  );

  const messagesInPeriod = await prisma.whatsAppMessage.count({
    where: { createdAt: { gte: from, lte: to } },
  });

  // série diária para gráficos
  const dayMap = new Map<
    string,
    { date: string; assumes: number; ratings: number; expired: number; taken: number; ratingSum: number }
  >();
  const cursor = startOfDaySP(from);
  const end = startOfDaySP(to);
  for (let t = cursor.getTime(); t <= end.getTime(); t += 86_400_000) {
    const key = ymdSP(new Date(t));
    dayMap.set(key, {
      date: key,
      assumes: 0,
      ratings: 0,
      expired: 0,
      taken: 0,
      ratingSum: 0,
    });
  }

  for (const c of assumed) {
    if (!c.assignedAt) continue;
    const key = ymdSP(c.assignedAt);
    const row = dayMap.get(key);
    if (row) row.assumes += 1;
  }
  for (const c of rated) {
    const at = c.ratingAskedAt ?? c.updatedAt;
    const key = ymdSP(at);
    const row = dayMap.get(key);
    if (row) {
      row.ratings += 1;
      row.ratingSum += c.rating ?? 0;
    }
  }
  for (const c of expired) {
    const key = ymdSP(c.openedToAllAt!);
    const row = dayMap.get(key);
    if (row) row.expired += 1;
  }
  for (const c of taken) {
    if (!c.assignedAt) continue;
    const key = ymdSP(c.assignedAt);
    const row = dayMap.get(key);
    if (row) row.taken += 1;
  }

  const seriesByDay = [...dayMap.values()].map((d) => ({
    date: d.date,
    assumes: d.assumes,
    ratings: d.ratings,
    avgRating: d.ratings ? Number((d.ratingSum / d.ratings).toFixed(2)) : null,
    expired: d.expired,
    taken: d.taken,
  }));

  return {
    period: {
      from: from.toISOString(),
      to: to.toISOString(),
      label: range.label,
      preset: range.preset,
    },
    byStatus: byStatusMap,
    avgRating,
    ratingsCount: rated.length,
    ratingDistribution,
    ratingsBySeller,
    recentRatings: rated.slice(0, 30).map((r) => ({
      rating: r.rating,
      sellerName: r.assignedTo?.name ?? null,
      contactName: r.name,
      phone: r.phone,
      at: r.updatedAt,
    })),
    avgAssumeSeconds,
    assumeCount: assumed.length,
    assumeBySeller,
    messagesInPeriod,
    messagesToday: messagesInPeriod,
    expiredOffers: expiredCount,
    takenFromOthers: takenCount,
    offerStatsBySeller,
    seriesByDay,
    attendances: assumed.length,
  };
}

/** Remove contatos demo (telefone começa com 5599DEMO) e recria cenário. */
export async function seedDemoReports(count = 90) {
  await prisma.whatsAppMessage.deleteMany({
    where: { contact: { phone: { startsWith: "5599DEMO" } } },
  });
  await prisma.whatsAppContact.deleteMany({
    where: { phone: { startsWith: "5599DEMO" } },
  });

  let sellers = await prisma.user.findMany({
    where: { role: "seller", active: true },
    orderBy: { name: "asc" },
    take: 3,
  });
  if (sellers.length < 2) {
    throw new Error("Precisa de ao menos 2 vendedores ativos (rode o seed de usuários)");
  }

  const names = [
    "Ana Silva",
    "Bruno Costa",
    "Carla Souza",
    "Diego Lima",
    "Elena Rocha",
    "Fábio Nunes",
    "Gina Alves",
    "Hugo Martins",
    "Iris Campos",
    "João Pedro",
  ];

  const now = Date.now();
  const created = [];

  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(Math.random() * 55);
    const hour = 8 + Math.floor(Math.random() * 10);
    const minute = Math.floor(Math.random() * 60);
    const base = new Date(now - daysAgo * 86_400_000);
    base.setHours(hour, minute, 0, 0);

    const offeredTo = sellers[i % sellers.length];
    const scenario = Math.random();
    // 45% assume próprio, 30% vence e outro pega, 15% vence sem assume (waiting), 10% ainda human recente
    let status: "human" | "closed" | "waiting" | "awaiting_rating" = "closed";
    let assignedToId: string | null = offeredTo.id;
    let firstOfferedToId = offeredTo.id;
    let firstOfferedAt = base;
    let offeredAt: Date | null = base;
    let openedToAllAt: Date | null = null;
    let assignedAt: Date | null = null;
    let assumeWaitSeconds: number | null = null;
    let rating: number | null = null;
    let ratingAskedAt: Date | null = null;
    let openToAll = false;

    if (scenario < 0.45) {
      // próprio vendedor assume rápido
      assumeWaitSeconds = 30 + Math.floor(Math.random() * 400);
      assignedAt = new Date(base.getTime() + assumeWaitSeconds * 1000);
      assignedToId = offeredTo.id;
      status = Math.random() < 0.85 ? "closed" : "human";
      if (status === "closed") {
        rating = 1 + Math.floor(Math.random() * 5);
        if (rating < 3 && Math.random() < 0.5) rating = 3 + Math.floor(Math.random() * 3);
        ratingAskedAt = new Date(assignedAt.getTime() + 20 * 60_000);
      }
    } else if (scenario < 0.75) {
      // venceu e outro pegou
      openedToAllAt = new Date(base.getTime() + 10 * 60_000);
      openToAll = false;
      const other = sellers.find((s) => s.id !== offeredTo.id) ?? sellers[0];
      assumeWaitSeconds = 60 + Math.floor(Math.random() * 500);
      assignedAt = new Date(openedToAllAt.getTime() + assumeWaitSeconds * 1000);
      assignedToId = other.id;
      status = "closed";
      rating = 2 + Math.floor(Math.random() * 4);
      ratingAskedAt = new Date(assignedAt.getTime() + 15 * 60_000);
    } else if (scenario < 0.9) {
      // venceu, ainda na fila
      openedToAllAt = new Date(base.getTime() + 10 * 60_000);
      openToAll = true;
      assignedToId = null;
      assignedAt = null;
      assumeWaitSeconds = null;
      status = "waiting";
      offeredAt = null;
    } else {
      // em atendimento
      assumeWaitSeconds = 40 + Math.floor(Math.random() * 200);
      assignedAt = new Date(base.getTime() + assumeWaitSeconds * 1000);
      status = "human";
    }

    const phone = `5599DEMO${String(i).padStart(6, "0")}`;
    const contact = await prisma.whatsAppContact.create({
      data: {
        phone,
        name: names[i % names.length],
        status,
        assignedToId,
        assignedAt,
        firstOfferedAt,
        firstOfferedToId,
        offeredToId: status === "waiting" && !openToAll ? offeredTo.id : null,
        offeredAt: status === "waiting" && !openToAll ? offeredAt : null,
        openedToAllAt,
        openToAll,
        assumeWaitSeconds,
        rating,
        ratingAskedAt,
        lastMessageAt: assignedAt ?? openedToAllAt ?? base,
        lastMessagePreview: status === "waiting" ? "Aguardando atendimento" : "Atendimento demo",
        lastClientMessageAt: base,
        unreadCount: status === "waiting" ? 1 : 0,
        createdAt: base,
      },
    });

    await prisma.whatsAppMessage.createMany({
      data: [
        {
          contactId: contact.id,
          direction: "in",
          type: "text",
          body: "Olá, preciso de atendimento (demo)",
          createdAt: base,
        },
        ...(assignedToId
          ? [
              {
                contactId: contact.id,
                direction: "out" as const,
                type: "text",
                body: "*Atendente:*\nOlá! Em que posso ajudar? (demo)",
                sentById: assignedToId,
                createdAt: assignedAt ?? new Date(base.getTime() + 60_000),
              },
            ]
          : []),
      ],
    });

    created.push(contact.id);
  }

  return { created: created.length };
}
