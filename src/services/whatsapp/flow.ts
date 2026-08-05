import type { Prisma } from "@prisma/client";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { notifyUsersSafe, recipientIdsForOpenQueue } from "../push.js";
import { evolution, EvolutionClient } from "./evolution.js";
import {
  BUSINESS,
  isBusinessHours,
  isOnLeave,
  isUserUnavailable,
  isWithinSchedule,
  assumeMetricStart,
  nowInSaoPaulo,
} from "./schedule.js";

function asOptions(raw: unknown): FlowOption[] {
  return (raw as unknown as FlowOption[]) ?? [];
}

export interface FlowOption {
  key: string;
  label: string;
  action: "agent" | "queue";
  userId?: string | null;
  queueId?: string | null;
}

const DEFAULT_OPTIONS: FlowOption[] = [
  { key: "1", label: "Atendente 1", action: "agent", userId: null },
  { key: "2", label: "Atendente 2", action: "agent", userId: null },
  { key: "3", label: "Atendente 3", action: "agent", userId: null },
  { key: "4", label: "Não tenho preferência", action: "queue", queueId: null },
];

const DEPT_MENU =
  "Olá! Bem-vindo à Calangus.\n\nEscolha o setor:\n\n1 - Atendimento\n2 - Financeiro";

export async function ensureFlow() {
  return prisma.whatsAppFlow.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      options: DEFAULT_OPTIONS as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function getFlow() {
  return ensureFlow();
}

export function buildMenuText(welcome: string, options: FlowOption[]): string {
  const lines = options.map((o) => `${o.key} - ${o.label}`);
  return `${welcome}\n\n${lines.join("\n")}`;
}

async function botSend(phone: string, text: string): Promise<string | null> {
  if (!evolution.enabled) {
    console.warn("[bot] Evolution off, skip send:", text.slice(0, 80));
    return null;
  }
  const r = await evolution.sendText(phone, text);
  return EvolutionClient.extractMessageId(r.data);
}

async function persistBotOut(
  contactId: string,
  text: string,
  extra?: Prisma.WhatsAppContactUpdateInput,
  externalId?: string | null
) {
  const since = new Date(Date.now() - 120_000);

  if (externalId) {
    const byExt = await prisma.whatsAppMessage.findUnique({
      where: { contactId_externalId: { contactId, externalId } },
    });
    if (byExt) {
      await prisma.whatsAppContact.update({
        where: { id: contactId },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: text.slice(0, 120),
          ...extra,
        },
      });
      return;
    }
  }

  const recent = await prisma.whatsAppMessage.findFirst({
    where: {
      contactId,
      direction: "out",
      type: "text",
      body: text,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
  });

  if (recent) {
    if (externalId && !recent.externalId) {
      try {
        await prisma.whatsAppMessage.update({
          where: { id: recent.id },
          data: { externalId },
        });
      } catch {
        /* unique race */
      }
    }
  } else {
    await prisma.whatsAppMessage.create({
      data: {
        contactId,
        direction: "out",
        type: "text",
        body: text,
        externalId: externalId || null,
      },
    });
  }

  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 120),
      ...extra,
    },
  });
}

/** Menu departamento (Financeiro / Atendimento). */
export async function sendDepartmentMenu(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const externalId = await botSend(contact.phone, DEPT_MENU);
  await persistBotOut(
    contactId,
    DEPT_MENU,
    {
      status: "bot",
      botMenuStep: "department",
    },
    externalId
  );
}

/** Menu de vendedores / fila (nível 2). */
export async function sendSellersMenu(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const flow = await getFlow();
  const options = asOptions(flow.options).length ? asOptions(flow.options) : DEFAULT_OPTIONS;
  const text = buildMenuText(flow.welcomeMessage, options);
  const externalId = await botSend(contact.phone, text);
  await persistBotOut(
    contactId,
    text,
    {
      status: "bot",
      botMenuStep: "sellers",
    },
    externalId
  );
}

/** Compat: welcome = departamento. */
export async function sendWelcomeMenu(contactId: string) {
  return sendDepartmentMenu(contactId);
}

function isCatalogKeyword(body: string | null): boolean {
  if (!body) return false;
  const kw = env.CATALOG_WA_KEYWORD.trim().toLowerCase();
  const normalized = body.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === kw || normalized.includes(kw);
}

async function loadUserWindows(userId: string) {
  return prisma.userUnavailability.findMany({ where: { userId } });
}

async function userIsAvailable(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.active) return false;

  const now = new Date();
  const leaves = await prisma.userLeave.findMany({
    where: { userId, startsAt: { lte: now }, endsAt: { gte: now } },
  });
  if (isOnLeave(leaves, now)) return false;

  const slots = await prisma.userScheduleSlot.findMany({ where: { userId } });
  if (!env.SKIP_BUSINESS_HOURS && !isWithinSchedule(slots, nowInSaoPaulo())) return false;

  const windows = await loadUserWindows(userId);
  return !isUserUnavailable(windows);
}

/** Oferece atendimento exclusivo a um vendedor (10 min). */
export async function offerToAgent(opts: {
  contactId: string;
  userId: string;
  queueId?: string | null;
}) {
  const now = new Date();
  const existing = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });

  const updated = await prisma.whatsAppContact.update({
    where: { id: opts.contactId },
    data: {
      status: "waiting",
      queueId: opts.queueId ?? undefined,
      offeredToId: opts.userId,
      offeredAt: now,
      openToAll: false,
      assignedToId: null,
      assignedAt: null,
      assumeWaitSeconds: null,
      firstOfferedAt: existing.firstOfferedAt ?? now,
      firstOfferedToId: existing.firstOfferedToId ?? opts.userId,
    },
  });
  notifyUsersSafe([opts.userId], {
    title: "Nova conversa na fila",
    body: `${updated.name || updated.phone} está aguardando você`,
    contactId: updated.id,
    tag: `wa-offer-${updated.id}`,
  });
  return updated;
}

/** Fila sequencial: próximo agente disponível na ordem. */
export async function offerFromQueue(contactId: string, queueId: string) {
  const queue = await prisma.whatsAppQueue.findUniqueOrThrow({
    where: { id: queueId },
    include: {
      agents: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: { user: true },
      },
    },
  });

  if (queue.agents.length === 0) {
    const now = new Date();
    const updated = await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        status: "waiting",
        queueId,
        openToAll: true,
        offeredToId: null,
        offeredAt: null,
        openedToAllAt: now,
        assignedToId: null,
        assignedAt: null,
        assumeWaitSeconds: null,
      },
    });
    void recipientIdsForOpenQueue(queueId).then((ids) => {
      notifyUsersSafe(ids, {
        title: "Conversa aberta",
        body: `${updated.name || updated.phone} está aguardando atendimento`,
        contactId: updated.id,
        tag: `wa-open-${updated.id}`,
      });
    });
    return updated;
  }

  const n = queue.agents.length;
  let picked: (typeof queue.agents)[0] | null = null;
  let start = queue.nextAgentIndex % n;

  for (let i = 0; i < n; i++) {
    const agent = queue.agents[(start + i) % n];
    if (agent.user.active && (await userIsAvailable(agent.userId))) {
      picked = agent;
      start = (start + i + 1) % n;
      break;
    }
  }

  await prisma.whatsAppQueue.update({
    where: { id: queueId },
    data: { nextAgentIndex: start },
  });

  if (!picked) {
    const now = new Date();
    const updated = await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        status: "waiting",
        queueId,
        openToAll: true,
        offeredToId: null,
        offeredAt: null,
        openedToAllAt: now,
        assignedToId: null,
        assignedAt: null,
        assumeWaitSeconds: null,
      },
    });
    void recipientIdsForOpenQueue(queueId).then((ids) => {
      notifyUsersSafe(ids, {
        title: "Conversa aberta",
        body: `${updated.name || updated.phone} está aguardando atendimento`,
        contactId: updated.id,
        tag: `wa-open-${updated.id}`,
      });
    });
    return updated;
  }

  return offerToAgent({
    contactId,
    userId: picked.userId,
    queueId,
  });
}

export async function handleDepartmentChoice(contactId: string, raw: string) {
  const key = raw.trim().replace(/[^\d]/g, "").slice(0, 1);
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });

  if (key === "1") {
    // Atendimento → menu vendedores
    await sendSellersMenu(contactId);
    return;
  }

  if (key === "2") {
    // Financeiro → fila (sem escolha de vendedor)
    const queue = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
    if (!queue) {
      await botSend(contact.phone, "No momento não há fila configurada. Aguarde um momento.");
      return;
    }
    await offerFromQueue(contactId, queue.id);
    const msg =
      "Certo! Encaminhamos você para o setor Financeiro. Em breve um atendente irá te responder.";
    const externalId = await botSend(contact.phone, msg);
    await persistBotOut(contactId, msg, undefined, externalId);
    return;
  }

  await botSend(contact.phone, "Opção inválida.\n\n" + DEPT_MENU);
}

async function resolveAgentUserId(choice: FlowOption): Promise<string | null> {
  if (choice.userId) {
    const user = await prisma.user.findFirst({
      where: { id: choice.userId, active: true },
      select: { id: true },
    });
    if (user) return user.id;
  }

  const sellers = await prisma.user.findMany({
    where: { active: true, role: { in: ["seller", "admin"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const byName = sellers.find(
    (s) => s.name.trim().toLowerCase() === choice.label.trim().toLowerCase()
  );
  if (byName) return byName.id;

  const idx = Number(choice.key) - 1;
  if (Number.isInteger(idx) && idx >= 0 && sellers[idx]) return sellers[idx].id;
  return null;
}

export async function handleMenuChoice(contactId: string, raw: string) {
  const flow = await getFlow();
  const options = asOptions(flow.options).length ? asOptions(flow.options) : DEFAULT_OPTIONS;
  const key = raw.trim().replace(/[^\d]/g, "").slice(0, 2);
  const choice = options.find((o) => o.key === key);
  if (!choice) {
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    await botSend(
      contact.phone,
      "Opção inválida. Digite o número da opção:\n\n" +
        buildMenuText(flow.welcomeMessage, options)
    );
    return;
  }

  if (choice.action === "agent") {
    const userId = await resolveAgentUserId(choice);
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    if (!userId) {
      await botSend(
        contact.phone,
        "Este atendente ainda não está configurado. Digite 4 para fila sem preferência, ou fale com o administrador."
      );
      return;
    }
    await offerToAgent({ contactId, userId });
    const msg =
      "Perfeito! Encaminhamos você para o atendente escolhido. Em breve ele irá te responder.";
    const externalId = await botSend(contact.phone, msg);
    await persistBotOut(contactId, msg, undefined, externalId);
    return;
  }

  let queueId = choice.queueId;
  if (!queueId) {
    const first = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
    queueId = first?.id ?? null;
  }
  if (!queueId) {
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    await botSend(contact.phone, "No momento não há fila configurada. Aguarde um momento.");
    return;
  }

  await offerFromQueue(contactId, queueId);
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const msg = "Certo! Você entrou na fila de atendimento. Em breve um vendedor irá te atender.";
  const externalId = await botSend(contact.phone, msg);
  await persistBotOut(contactId, msg, undefined, externalId);
}

/** Fora do horário: avisa e deixa na fila aberta para depois. */
export async function handleOutsideHours(contactId: string) {
  const flow = await getFlow();
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const externalId = await botSend(contact.phone, flow.closedMessage);
  await persistBotOut(contactId, flow.closedMessage, undefined, externalId);
  const queue = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
  const now = new Date();
  const updated = await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "waiting",
      queueId: queue?.id ?? null,
      openToAll: true,
      openedToAllAt: contact.openedToAllAt ?? now,
      offeredToId: null,
      offeredAt: null,
      lastMessageAt: now,
      lastMessagePreview: flow.closedMessage.slice(0, 120),
    },
  });
  void recipientIdsForOpenQueue(updated.queueId).then((ids) => {
    notifyUsersSafe(ids, {
      title: "Nova conversa na fila",
      body: `${updated.name || updated.phone} está aguardando atendimento`,
      contactId: updated.id,
      tag: `wa-open-${updated.id}`,
    });
  });
}

export async function processInboundBot(contactId: string, body: string | null, isNew: boolean) {
  if (!isBusinessHours()) {
    const existing = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    if (existing.status === "waiting" && existing.openToAll) {
      return;
    }
    await handleOutsideHours(contactId);
    return;
  }

  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });

  // Catálogo: keyword pula departamento → menu vendedores
  if ((isNew || contact.status === "closed" || contact.status === "bot") && isCatalogKeyword(body)) {
    await sendSellersMenu(contactId);
    return;
  }

  if (isNew || contact.status === "closed") {
    await sendDepartmentMenu(contactId);
    return;
  }

  if (contact.status === "bot") {
    if (body && /^\s*\d+/.test(body)) {
      if (contact.botMenuStep === "department") {
        await handleDepartmentChoice(contactId, body);
        return;
      }
      await handleMenuChoice(contactId, body);
      return;
    }
    if (contact.botMenuStep === "sellers") {
      await sendSellersMenu(contactId);
    } else {
      await sendDepartmentMenu(contactId);
    }
  }
}

/** Expira ofertas > 10 min → openToAll */
export async function expireStaleOffers() {
  const cutoff = new Date(Date.now() - BUSINESS.offerMinutes * 60_000);
  const stale = await prisma.whatsAppContact.findMany({
    where: {
      status: "waiting",
      openToAll: false,
      offeredToId: { not: null },
      offeredAt: { lt: cutoff },
    },
  });
  const now = new Date();
  for (const c of stale) {
    await prisma.whatsAppContact.update({
      where: { id: c.id },
      data: {
        openToAll: true,
        offeredToId: null,
        offeredAt: null,
        openedToAllAt: c.openedToAllAt ?? now,
      },
    });
    console.log(`[fila] oferta expirada → aberta a todos: ${c.phone}`);
    void recipientIdsForOpenQueue(c.queueId).then((ids) => {
      notifyUsersSafe(ids, {
        title: "Conversa aberta",
        body: `${c.name || c.phone} ficou disponível para a equipe`,
        contactId: c.id,
        tag: `wa-open-${c.id}`,
      });
    });
  }
  return stale.length;
}

/** Fecha avaliações sem resposta após RATING_TIMEOUT_MINUTES. */
export async function expireStaleRatings() {
  const cutoff = new Date(Date.now() - env.RATING_TIMEOUT_MINUTES * 60_000);
  const stale = await prisma.whatsAppContact.findMany({
    where: {
      status: "awaiting_rating",
      ratingAskedAt: { lt: cutoff },
      rating: null,
    },
  });
  for (const c of stale) {
    await prisma.whatsAppContact.update({
      where: { id: c.id },
      data: {
        status: "closed",
        offeredToId: null,
        openToAll: false,
      },
    });
    console.log(`[rating] timeout → closed: ${c.phone}`);
    if (c.assignedToId) {
      notifyUsersSafe([c.assignedToId], {
        title: "Avaliação expirada",
        body: `${c.name || c.phone} — conversa encerrada sem nota`,
        contactId: c.id,
        tag: `wa-rating-${c.id}`,
      });
    }
  }
  return stale.length;
}

/** Clicar na conversa = assumir (se waiting e ofertado a ele ou openToAll). */
export async function assumeOnOpen(
  contactId: string,
  userId: string,
  role: "admin" | "seller" = "seller"
) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });

  // Histórico finalizado / aguardando avaliação: só leitura
  if (contact.status === "closed" || contact.status === "awaiting_rating") {
    await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: { unreadCount: 0 },
    });
    return contact;
  }

  if (contact.status === "human" && contact.assignedToId === userId) {
    await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: { unreadCount: 0 },
    });
    return contact;
  }

  if (
    contact.status === "human" &&
    contact.assignedToId &&
    contact.assignedToId !== userId &&
    role !== "admin"
  ) {
    throw new Error("Conversa já assumida por outro atendente");
  }

  if (contact.status === "waiting" || (contact.status === "human" && role === "admin")) {
    const canTake =
      role === "admin" ||
      contact.openToAll ||
      contact.offeredToId === userId ||
      (!contact.offeredToId && !contact.openToAll);
    if (!canTake) {
      throw new Error("Esta conversa está oferecida a outro vendedor");
    }
    const now = new Date();
    const start = assumeMetricStart(contact, userId);
    const assumeWaitSeconds = Math.max(0, Math.round((now.getTime() - start.getTime()) / 1000));
    return prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        status: "human",
        assignedToId: userId,
        assignedAt: contact.assignedAt ?? now,
        assumeWaitSeconds: contact.assumeWaitSeconds ?? assumeWaitSeconds,
        offeredToId: null,
        offeredAt: null,
        openToAll: false,
        unreadCount: 0,
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        queue: { select: { id: true, name: true } },
      },
    });
  }

  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: { unreadCount: 0 },
  });
  return contact;
}

type ContactStatusFilter =
  | "bot"
  | "waiting"
  | "human"
  | "awaiting_rating"
  | "closed";

function sellerScope(sellerId: string, opts?: { includeOpenQueue?: boolean }) {
  return {
    OR: [
      { assignedToId: sellerId },
      { status: "waiting" as const, offeredToId: sellerId, openToAll: false },
      ...(opts?.includeOpenQueue === false
        ? []
        : [{ status: "waiting" as const, openToAll: true }]),
    ],
  };
}

/** Lista o que o usuário pode ver. Seller: só as dele. Admin: todas ou por vendedor. */
export async function listContactsForUser(opts: {
  userId: string;
  role: "admin" | "seller";
  status?: string;
  search?: string;
  sellerId?: string;
}) {
  await expireStaleOffers();

  const baseSearch = opts.search
    ? {
        OR: [
          { name: { contains: opts.search, mode: "insensitive" as const } },
          { phone: { contains: opts.search.replace(/\D/g, "") } },
        ],
      }
    : {};

  const statusFilter =
    opts.status === "active"
      ? { status: { in: ["waiting", "human"] as ContactStatusFilter[] } }
      : opts.status
        ? { status: opts.status as ContactStatusFilter }
        : {};

  const include = {
    assignedTo: { select: { id: true, name: true } },
    offeredTo: { select: { id: true, name: true } },
    queue: { select: { id: true, name: true } },
  } as const;

  if (opts.role === "admin") {
    const sellerFilter = opts.sellerId ? sellerScope(opts.sellerId, { includeOpenQueue: false }) : {};
    return prisma.whatsAppContact.findMany({
      where: {
        AND: [baseSearch, statusFilter, sellerFilter],
      },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      include,
    });
  }

  return prisma.whatsAppContact.findMany({
    where: {
      AND: [baseSearch, statusFilter, sellerScope(opts.userId, { includeOpenQueue: true })],
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    include,
  });
}

/** Lead do formulário do catálogo → fila. */
export async function createCatalogLead(opts: {
  name: string;
  phone: string;
  message?: string;
}) {
  const phone = opts.phone.replace(/\D/g, "");
  if (!phone) throw new Error("Telefone inválido");

  const queue = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
  const preview = (opts.message || `Lead catálogo: ${opts.name}`).slice(0, 120);
  const now = new Date();

  const contact = await prisma.whatsAppContact.upsert({
    where: { phone },
    create: {
      phone,
      name: opts.name,
      status: "waiting",
      lastMessageAt: now,
      lastMessagePreview: preview,
      lastClientMessageAt: now,
      openToAll: true,
      openedToAllAt: now,
      queueId: queue?.id ?? null,
    },
    update: {
      name: opts.name,
      status: "waiting",
      lastMessageAt: now,
      lastMessagePreview: preview,
      lastClientMessageAt: now,
      assignedToId: null,
      assignedAt: null,
      assumeWaitSeconds: null,
      offeredToId: null,
      openToAll: true,
      openedToAllAt: now,
      queueId: queue?.id ?? null,
      rating: null,
      ratingAskedAt: null,
    },
  });

  const body = opts.message
    ? `[Catálogo] ${opts.name}: ${opts.message}`
    : `[Catálogo] ${opts.name} solicitou contato`;

  await prisma.whatsAppMessage.create({
    data: {
      contactId: contact.id,
      direction: "in",
      type: "text",
      body,
    },
  });

  if (queue) {
    await offerFromQueue(contact.id, queue.id);
  }

  return prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contact.id },
    include: {
      assignedTo: { select: { id: true, name: true } },
      queue: { select: { id: true, name: true } },
    },
  });
}
