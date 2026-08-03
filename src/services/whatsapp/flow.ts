import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { evolution } from "./evolution.js";
import {
  BUSINESS,
  isBusinessHours,
  isUserUnavailable,
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

async function botSend(phone: string, text: string) {
  if (!evolution.enabled) {
    console.warn("[bot] Evolution off, skip send:", text.slice(0, 80));
    return;
  }
  await evolution.sendText(phone, text);
}

export async function sendWelcomeMenu(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const flow = await getFlow();
  const options = asOptions(flow.options).length ? asOptions(flow.options) : DEFAULT_OPTIONS;
  const text = buildMenuText(flow.welcomeMessage, options);
  await botSend(contact.phone, text);
  await prisma.whatsAppMessage.create({
    data: {
      contactId,
      direction: "out",
      type: "text",
      body: text,
    },
  });
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "bot",
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 120),
    },
  });
}

async function loadUserWindows(userId: string) {
  return prisma.userUnavailability.findMany({ where: { userId } });
}

async function userIsAvailable(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.active) return false;
  const windows = await loadUserWindows(userId);
  return !isUserUnavailable(windows);
}

/** Oferece atendimento a um vendedor específico (10 min) ou abre para todos. */
export async function offerToAgent(opts: {
  contactId: string;
  userId: string;
  queueId?: string | null;
}) {
  const available = await userIsAvailable(opts.userId);
  const now = new Date();
  return prisma.whatsAppContact.update({
    where: { id: opts.contactId },
    data: {
      status: "waiting",
      queueId: opts.queueId ?? undefined,
      offeredToId: available ? opts.userId : null,
      offeredAt: available ? now : null,
      openToAll: !available,
      assignedToId: null,
    },
  });
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
    return prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        status: "waiting",
        queueId,
        openToAll: true,
        offeredToId: null,
        offeredAt: null,
        assignedToId: null,
      },
    });
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
    return prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        status: "waiting",
        queueId,
        openToAll: true,
        offeredToId: null,
        offeredAt: null,
        assignedToId: null,
      },
    });
  }

  return offerToAgent({
    contactId,
    userId: picked.userId,
    queueId,
  });
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

  if (choice.action === "agent" && choice.userId) {
    await offerToAgent({ contactId, userId: choice.userId });
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    await botSend(
      contact.phone,
      "Perfeito! Encaminhamos você para o atendente escolhido. Em breve ele irá te responder."
    );
    return;
  }

  // fila / sem preferência
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
  await botSend(
    contact.phone,
    "Certo! Você entrou na fila de atendimento. Em breve um vendedor irá te atender."
  );
}

/** Fora do horário: avisa e deixa na fila aberta para depois. */
export async function handleOutsideHours(contactId: string) {
  const flow = await getFlow();
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  await botSend(contact.phone, flow.closedMessage);
  await prisma.whatsAppMessage.create({
    data: {
      contactId,
      direction: "out",
      type: "text",
      body: flow.closedMessage,
    },
  });
  const queue = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "waiting",
      queueId: queue?.id ?? null,
      openToAll: true,
      offeredToId: null,
      offeredAt: null,
      lastMessageAt: new Date(),
      lastMessagePreview: flow.closedMessage.slice(0, 120),
    },
  });
}

export async function processInboundBot(contactId: string, body: string | null, isNew: boolean) {
  // Fora do horário comercial: avisa e coloca na fila para atender depois
  if (!isBusinessHours()) {
    const existing = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    // Evita reenviar o aviso a cada mensagem se já está aguardando
    if (existing.status === "waiting" && existing.openToAll) {
      return;
    }
    await handleOutsideHours(contactId);
    return;
  }

  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });

  if (isNew || contact.status === "bot" || contact.status === "closed") {
    // se acabou de criar e ainda não enviou menu, ou está em bot esperando opção
    if (isNew || contact.status === "closed") {
      await sendWelcomeMenu(contactId);
      return;
    }
    // status bot: interpreta escolha
    if (body && /^\s*\d+/.test(body)) {
      await handleMenuChoice(contactId, body);
      return;
    }
    await sendWelcomeMenu(contactId);
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
  for (const c of stale) {
    await prisma.whatsAppContact.update({
      where: { id: c.id },
      data: { openToAll: true, offeredToId: null, offeredAt: null },
    });
    console.log(`[fila] oferta expirada → aberta a todos: ${c.phone}`);
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
    return prisma.whatsAppContact.update({
      where: { id: contactId },
      data: {
        status: "human",
        assignedToId: userId,
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

/** Lista só o que o vendedor pode ver. */
export async function listContactsForUser(opts: {
  userId: string;
  role: "admin" | "seller";
  status?: string;
  search?: string;
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

  if (opts.role === "admin") {
    return prisma.whatsAppContact.findMany({
      where: {
        ...(opts.status ? { status: opts.status as "bot" | "waiting" | "human" | "closed" } : {}),
        ...baseSearch,
      },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      include: {
        assignedTo: { select: { id: true, name: true } },
        offeredTo: { select: { id: true, name: true } },
        queue: { select: { id: true, name: true } },
      },
    });
  }

  // seller: human atribuídas a ele + waiting oferecidas a ele + waiting openToAll
  return prisma.whatsAppContact.findMany({
    where: {
      AND: [
        baseSearch,
        opts.status ? { status: opts.status as "bot" | "waiting" | "human" | "closed" } : {},
        {
          OR: [
            { status: "human", assignedToId: opts.userId },
            { status: "waiting", offeredToId: opts.userId, openToAll: false },
            { status: "waiting", openToAll: true },
          ],
        },
      ],
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    include: {
      assignedTo: { select: { id: true, name: true } },
      offeredTo: { select: { id: true, name: true } },
      queue: { select: { id: true, name: true } },
    },
  });
}
