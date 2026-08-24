import type { Prisma } from "@prisma/client";
import { env } from "../../config.js";
import { prisma } from "../../db.js";
import { notifyUsersSafe, recipientIdsForOpenQueue } from "../push.js";
import { activeProvider, messagingEnabled, sendOutbound } from "./gateway.js";
import { gupshup } from "./gupshup.js";
import {
  BUSINESS,
  isBusinessHours,
  isOnLeave,
  isUserUnavailable,
  isWithinSchedule,
  assumeMetricStart,
  nowInSaoPaulo,
} from "./schedule.js";
import { contactDisplayName } from "./contacts.js";
import { userCanSeeAllMessages } from "../auth.js";

/** Menus/auto-respostas do CRM. Desligar em Conectar WhatsApp para testes manuais. */
export async function isCrmBotEnabled() {
  const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
  return row?.botEnabled !== false;
}

export async function setCrmBotEnabled(enabled: boolean) {
  return prisma.whatsAppConnection.upsert({
    where: { id: "default" },
    create: { id: "default", botEnabled: enabled },
    update: { botEnabled: enabled },
  });
}

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

const DEPT_BODY = "Olá! Bem-vindo à Calangus.\n\nEscolha o setor:";

const BACK_HINT = "0 - Voltar";

export type BotFlowKind = "atendimento" | "financeiro";

function flowUserFilter(flow: BotFlowKind) {
  return flow === "financeiro" ? { flowFinanceiro: true } : { flowAtendimento: true };
}

async function recipientIdsForFlow(flow: BotFlowKind): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { active: true, role: "seller", ...flowUserFilter(flow) },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function contactBotFlow(contactId: string): Promise<BotFlowKind> {
  const c = await prisma.whatsAppContact.findUnique({
    where: { id: contactId },
    select: { botFlow: true },
  });
  return c?.botFlow === "financeiro" ? "financeiro" : "atendimento";
}

async function canUseOfficialButtons() {
  const p = await activeProvider();
  if (p === "meta") return true;
  if (p === "gupshup") return await gupshup.isConfigured();
  return false;
}

function isBackCommand(body: string | null): boolean {
  if (!body) return false;
  const t = body.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "voltar" || t === "0") return true;
  if (/^0\s*[-–.]?\s*voltar$/.test(t)) return true;
  return false;
}

function financeSelfServiceMessage() {
  const link = (env.CREDIARIO_CLIENTE_LINK || "").trim();
  return (
    "Para mais detalhes sobre suas *faturas em aberto*, acesse o link abaixo e digite o *CPF* e a *data de nascimento*:\n\n" +
    `${link}\n\n` +
    "Calangus Moda Jovem"
  );
}

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

/** Menu ao vivo: vendedores na lista de atendentes (sem Ver todas), filtrados por fluxo. */
async function resolveMenuOptions(flow: BotFlowKind = "atendimento"): Promise<FlowOption[]> {
  const storedFlow = await getFlow();
  const stored = asOptions(storedFlow.options);
  const queueFromFlow = stored.find((o) => o.action === "queue");

  const sellers = await prisma.user.findMany({
    where: {
      active: true,
      role: "seller",
      showInAttendantList: true,
      seeAllMessages: false,
      ...flowUserFilter(flow),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  const options: FlowOption[] = sellers.map((s, i) => ({
    key: String(i + 1),
    label: s.name.trim() || `Atendente ${i + 1}`,
    action: "agent",
    userId: s.id,
  }));

  options.push({
    key: String(options.length + 1),
    label: queueFromFlow?.label?.trim() || "Não tenho preferência",
    action: "queue",
    queueId: queueFromFlow?.queueId ?? null,
  });

  return options;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function botDelayMs() {
  const base = Math.max(0, env.BOT_TYPING_DELAY_MS);
  // Jitter leve (±150ms) só para não parecer robô; sem o antigo 2–7s.
  const jitter = base > 0 ? Math.floor(Math.random() * 151) : 0;
  return base + jitter;
}

/** Fila serial por contato — evita 2 webhooks processarem menu ao mesmo tempo. */
const contactLocks = new Map<string, Promise<unknown>>();

export async function withContactLock<T>(contactId: string, fn: () => Promise<T>): Promise<T> {
  const prev = contactLocks.get(contactId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  contactLocks.set(
    contactId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/**
 * Após 1 (departamento) → menu vendedores, o usuário costuma reenviar o mesmo
 * dígito porque a resposta atrasou. Ignora esse eco por alguns segundos.
 */
const echoDigitUntil = new Map<string, { digit: string; until: number }>();

function markMenuEchoGuard(contactId: string, digit: string, ms = 8000) {
  echoDigitUntil.set(contactId, { digit, until: Date.now() + ms });
}

function shouldIgnoreEchoDigit(contactId: string, raw: string | null): boolean {
  if (!raw) return false;
  const digit = raw.trim().replace(/[^\d]/g, "").slice(0, 2);
  if (!digit) return false;
  const g = echoDigitUntil.get(contactId);
  if (!g) return false;
  if (Date.now() > g.until) {
    echoDigitUntil.delete(contactId);
    return false;
  }
  if (g.digit === digit) {
    echoDigitUntil.delete(contactId);
    console.log("[bot] ignore eco dígito", digit, contactId);
    return true;
  }
  return false;
}

function isTransientEvolutionError(status: number, text: string) {
  const t = (text || "").toLowerCase();
  return (
    status === 502 ||
    status === 503 ||
    t.includes("connection closed") ||
    t.includes("\"1006\"") ||
    t.includes("timed out") ||
    t.includes("econnreset")
  );
}

async function botSend(
  contact: { id?: string; phone: string; remoteJid?: string | null; webhookPaused?: boolean },
  text: string
): Promise<string | null> {
  if (contact.webhookPaused) {
    console.warn("[bot] webhook pausado, skip send:", contact.phone);
    return null;
  }
  if (!(await messagingEnabled())) {
    console.warn("[bot] WhatsApp off, skip send:", text.slice(0, 80));
    return null;
  }

  const wait = botDelayMs();
  console.log("[bot] delay", wait, "ms", contact.phone);
  await sleep(wait);

  if (contact.id) {
    const fresh = await prisma.whatsAppContact.findUnique({ where: { id: contact.id } });
    if (fresh?.webhookPaused) {
      console.warn("[bot] pausado durante delay, skip:", contact.phone);
      return null;
    }
  }

  let r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "bot",
    contactId: contact.id ?? null,
    kind: "text",
    text,
    category: "service",
  });
  if (!r.ok && r.provider === "evolution" && isTransientEvolutionError(0, r.error || "")) {
    await sleep(1500);
    r = await sendOutbound({
      to: contact.remoteJid || contact.phone,
      source: "bot",
      contactId: contact.id ?? null,
      kind: "text",
      text,
      category: "service",
    });
  }
  if (!r.ok) {
    console.error("[bot] falha ao enviar WhatsApp", r.error);
    return null;
  }
  console.log("[bot] enviado:", text.replace(/\s+/g, " ").slice(0, 80));
  return r.externalId;
}

async function botSendInteractive(
  contact: { id?: string; phone: string; remoteJid?: string | null; webhookPaused?: boolean },
  preview: string,
  interactive: Record<string, unknown>
): Promise<string | null> {
  if (contact.webhookPaused) {
    console.warn("[bot] webhook pausado, skip send:", contact.phone);
    return null;
  }
  if (!(await messagingEnabled()) || !(await canUseOfficialButtons())) {
    return botSend(contact, preview);
  }

  const wait = botDelayMs();
  console.log("[bot] delay", wait, "ms", contact.phone);
  await sleep(wait);

  if (contact.id) {
    const fresh = await prisma.whatsAppContact.findUnique({ where: { id: contact.id } });
    if (fresh?.webhookPaused) {
      console.warn("[bot] pausado durante delay, skip:", contact.phone);
      return null;
    }
  }

  const r = await sendOutbound({
    to: contact.remoteJid || contact.phone,
    source: "bot",
    contactId: contact.id ?? null,
    kind: "interactive",
    text: preview,
    bodyPreview: preview,
    category: "service",
    interactive,
  });
  if (!r.ok) {
    console.error("[bot] falha interactive, fallback texto", r.error);
    return botSend(contact, preview);
  }
  console.log("[bot] enviado interactive:", preview.replace(/\s+/g, " ").slice(0, 80));
  return r.externalId;
}

async function persistIfSent(
  contactId: string,
  text: string,
  extra: Prisma.WhatsAppContactUpdateInput | undefined,
  externalId: string | null
) {
  if (!externalId && (await messagingEnabled())) return;
  await persistBotOut(contactId, text, extra, externalId);
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
    const lastIn = await prisma.whatsAppMessage.findFirst({
      where: { contactId, direction: "in" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const createdAt = lastIn
      ? new Date(Math.max(Date.now(), lastIn.createdAt.getTime()) + 50)
      : new Date();
    await prisma.whatsAppMessage.create({
      data: {
        contactId,
        direction: "out",
        type: "text",
        body: text,
        externalId: externalId || null,
        createdAt,
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

/** Admin: tira/coloca o cliente no atendimento manual (sem bot). */
export async function setWebhookPaused(contactId: string, paused: boolean) {
  const current = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      webhookPaused: paused,
      ...(paused
        ? {
            // Reabre conversa encerrada para atendimento manual pelo CRM.
            ...(["closed", "awaiting_rating"].includes(current.status)
              ? {
                  status: "human" as const,
                  rating: null,
                  ratingAskedAt: null,
                  assignedAt: current.assignedAt ?? new Date(),
                }
              : {}),
            offeredToId: null,
            offeredAt: null,
            openToAll: false,
            openedToAllAt: null,
          }
        : {}),
    },
  });
  return prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
    include: {
      assignedTo: { select: { id: true, name: true } },
      offeredTo: { select: { id: true, name: true } },
      queue: { select: { id: true, name: true } },
    },
  });
}

/** Admin: devolve o cliente ao menu do bot. */
export async function restartToBot(contactId: string) {
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "bot",
      botMenuStep: "department",
      botFlow: null,
      webhookPaused: false,
      assignedToId: null,
      assignedAt: null,
      assumeWaitSeconds: null,
      offeredToId: null,
      offeredAt: null,
      firstOfferedAt: null,
      firstOfferedToId: null,
      openedToAllAt: null,
      openToAll: false,
      queueId: null,
      inactivityWarnedAt: null,
      ratingAskedAt: null,
      unreadCount: 0,
    },
  });
  await sendDepartmentMenu(contactId);
  return prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
    include: {
      assignedTo: { select: { id: true, name: true } },
      offeredTo: { select: { id: true, name: true } },
      queue: { select: { id: true, name: true } },
    },
  });
}

/** Menu departamento (Financeiro / Atendimento). */
export async function sendDepartmentMenu(contactId: string, bodyText = DEPT_BODY) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const preview = `${bodyText}\n\n1 - Atendimento\n2 - Financeiro`;
  const recentMenu = await prisma.whatsAppMessage.findFirst({
    where: {
      contactId,
      direction: "out",
      body: preview,
      createdAt: { gte: new Date(Date.now() - 45_000) },
    },
    select: { id: true },
  });
  if (recentMenu) {
    console.log("[bot] menu departamento já enviado, skip", contact.phone);
    return;
  }
  const interactive = {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: [
        { type: "reply", reply: { id: "1", title: "Atendimento" } },
        { type: "reply", reply: { id: "2", title: "Financeiro" } },
      ],
    },
  };
  const externalId = await botSendInteractive(contact, preview, interactive);
  await persistIfSent(
    contactId,
    preview,
    {
      status: "bot",
      botMenuStep: "department",
    },
    externalId
  );
}

/** Menu de vendedores / fila (Atendimento). */
export async function sendSellersMenu(contactId: string, flow: BotFlowKind = "atendimento") {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const storedFlow = await getFlow();
  const options = await resolveMenuOptions(flow);
  const text = `${buildMenuText(storedFlow.welcomeMessage, options)}\n${BACK_HINT}`;
  const externalId = await botSend(contact, text);
  await persistIfSent(
    contactId,
    text,
    {
      status: "bot",
      botMenuStep: "sellers",
      botFlow: flow,
    },
    externalId
  );
}

/** Financeiro: info crediário + menu de atendentes do fluxo financeiro. */
export async function sendFinanceMenu(contactId: string) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const options = await resolveMenuOptions("financeiro");
  const sellerLines = options.map((o) => `${o.key} - ${o.label}`);
  const text = `${financeSelfServiceMessage()}\n\n${sellerLines.join("\n")}\n${BACK_HINT}`;
  const externalId = await botSend(contact, text);
  await persistIfSent(
    contactId,
    text,
    {
      status: "bot",
      botMenuStep: "finance_sellers",
      botFlow: "financeiro",
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

/** Folga/férias: só bloqueia nova conexão exclusiva — não desativa o usuário. */
async function userIsOnLeave(userId: string): Promise<boolean> {
  const now = new Date();
  const leaves = await prisma.userLeave.findMany({
    where: { userId, startsAt: { lte: now }, endsAt: { gte: now } },
  });
  return isOnLeave(leaves, now);
}

/** Escala / ativo / janelas — sem folga (folga não desabilita o vendedor). */
async function userIsAvailable(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.active) return false;

  const slots = await prisma.userScheduleSlot.findMany({ where: { userId } });
  if (!env.SKIP_BUSINESS_HOURS && !isWithinSchedule(slots, nowInSaoPaulo())) return false;

  const windows = await loadUserWindows(userId);
  return !isUserUnavailable(windows);
}

/** Pode receber oferta exclusiva (conexão) de um cliente. Folga = não. */
async function canReceiveExclusiveOffer(userId: string): Promise<boolean> {
  if (!(await userIsAvailable(userId))) return false;
  if (await userIsOnLeave(userId)) return false;
  return true;
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
    body: `${contactDisplayName(updated)} está aguardando você`,
    contactId: updated.id,
    tag: `wa-offer-${updated.id}`,
  });
  return updated;
}

/** Abre a conversa para vendedores do fluxo (sem oferta exclusiva). */
export async function openContactToAllSellers(opts: {
  contactId: string;
  queueId?: string | null;
  flow?: BotFlowKind;
}) {
  const existing = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: opts.contactId },
  });
  const flow = opts.flow ?? (existing.botFlow === "financeiro" ? "financeiro" : "atendimento");
  const now = new Date();
  const updated = await prisma.whatsAppContact.update({
    where: { id: opts.contactId },
    data: {
      status: "waiting",
      queueId: opts.queueId ?? undefined,
      botFlow: flow,
      openToAll: true,
      offeredToId: null,
      offeredAt: null,
      openedToAllAt: now,
      assignedToId: null,
      assignedAt: null,
      assumeWaitSeconds: null,
    },
  });
  const ids = await recipientIdsForFlow(flow);
  notifyUsersSafe(ids, {
    title: flow === "financeiro" ? "Financeiro — conversa aberta" : "Conversa aberta",
    body: `${contactDisplayName(updated)} — quem responder primeiro assume`,
    contactId: updated.id,
    tag: `wa-open-${updated.id}`,
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
        body: `${contactDisplayName(updated)} está aguardando atendimento`,
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
    if (agent.user.active && (await canReceiveExclusiveOffer(agent.userId))) {
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
        body: `${contactDisplayName(updated)} está aguardando atendimento`,
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
  if (isBackCommand(raw)) {
    await sendDepartmentMenu(contactId);
    return;
  }

  const key = raw.trim().replace(/[^\d]/g, "").slice(0, 1);

  if (key !== "1" && key !== "2") {
    await sendDepartmentMenu(contactId, "Opção inválida. Escolha o setor:");
    return;
  }

  // Claim atômico do passo departamento (evita 2 webhooks processarem o mesmo "1"/"2").
  const claimed = await prisma.whatsAppContact.updateMany({
    where: { id: contactId, status: "bot", botMenuStep: "department" },
    data: {
      botMenuStep: key === "1" ? "sellers" : "finance_sellers",
      botFlow: key === "1" ? "atendimento" : "financeiro",
    },
  });
  if (claimed.count === 0) {
    console.log("[bot] departamento já consumido, skip", contactId, key);
    return;
  }

  markMenuEchoGuard(contactId, key);

  if (key === "1") {
    await sendSellersMenu(contactId, "atendimento");
    return;
  }

  await sendFinanceMenu(contactId);
}

async function resolveAgentUserId(
  choice: FlowOption,
  flow: BotFlowKind = "atendimento"
): Promise<string | null> {
  if (choice.userId) {
    const user = await prisma.user.findFirst({
      where: {
        id: choice.userId,
        active: true,
        role: "seller",
        showInAttendantList: true,
        seeAllMessages: false,
        ...flowUserFilter(flow),
      },
      select: { id: true },
    });
    if (user) return user.id;
  }

  const sellers = await prisma.user.findMany({
    where: {
      active: true,
      role: "seller",
      showInAttendantList: true,
      seeAllMessages: false,
      ...flowUserFilter(flow),
    },
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

async function resendSellerMenu(contactId: string) {
  const flow = await contactBotFlow(contactId);
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
    select: { botMenuStep: true },
  });
  if (contact.botMenuStep === "finance_sellers") {
    await sendFinanceMenu(contactId);
  } else {
    await sendSellersMenu(contactId, flow);
  }
}

export async function handleMenuChoice(contactId: string, raw: string) {
  if (isBackCommand(raw)) {
    await sendDepartmentMenu(contactId);
    return;
  }

  const contactBefore = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const flow: BotFlowKind =
    contactBefore.botFlow === "financeiro" ? "financeiro" : "atendimento";
  const menuStep =
    contactBefore.botMenuStep === "finance_sellers" ? "finance_sellers" : "sellers";

  const options = await resolveMenuOptions(flow);
  const key = raw.trim().replace(/[^\d]/g, "").slice(0, 2);
  const choice = options.find((o) => o.key === key);
  if (!choice) {
    await resendSellerMenu(contactId);
    return;
  }

  // Evita processar a mesma escolha duas vezes (webhook duplicado).
  const claimed = await prisma.whatsAppContact.updateMany({
    where: { id: contactId, status: "bot", botMenuStep: menuStep },
    data: { status: "waiting", botFlow: flow },
  });
  if (claimed.count === 0) {
    const existing = await prisma.whatsAppContact.findUnique({ where: { id: contactId } });
    if (existing?.status === "waiting" || existing?.status === "human") return;
    await resendSellerMenu(contactId);
    return;
  }

  markMenuEchoGuard(contactId, key);

  if (choice.action === "agent") {
    const userId = await resolveAgentUserId(choice, flow);
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    if (!userId) {
      await botSend(
        contact,
        "Este atendente ainda não está configurado. Escolha outra opção ou fale com o administrador."
      );
      await prisma.whatsAppContact.update({
        where: { id: contactId },
        data: { status: "bot", botMenuStep: menuStep, botFlow: flow },
      });
      return;
    }
    // Folga: não faz conexão exclusiva — abre para a equipe do fluxo.
    if (await userIsOnLeave(userId)) {
      let queueId: string | null = null;
      const first = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
      queueId = first?.id ?? null;
      await openContactToAllSellers({ contactId, queueId, flow });
      const teamLabel = flow === "financeiro" ? "equipe financeira" : "equipe";
      const msg = `O atendente escolhido está em folga no momento. Sua conversa ficou *disponível para a ${teamLabel}* — quem responder primeiro irá te atender.`;
      const externalId = await botSend(contact, msg);
      await persistIfSent(contactId, msg, undefined, externalId);
      return;
    }
    await offerToAgent({ contactId, userId });
    const msg =
      "Perfeito! Encaminhamos você para o atendente escolhido. Em breve ele irá te responder.";
    const externalId = await botSend(contact, msg);
    await persistIfSent(contactId, msg, undefined, externalId);
    return;
  }

  let queueId = choice.queueId;
  if (!queueId) {
    const first = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
    queueId = first?.id ?? null;
  }

  await openContactToAllSellers({ contactId, queueId, flow });
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const teamLabel = flow === "financeiro" ? "equipe financeira" : "equipe";
  const msg = `Certo! Sua conversa está disponível para nossa ${teamLabel}. *Quem responder primeiro* irá te atender.`;
  const externalId = await botSend(contact, msg);
  await persistIfSent(contactId, msg, undefined, externalId);
}

/** Fora do horário: avisa, sugere o catálogo e deixa na fila aberta. */
export function buildOutsideHoursMessage(closedMessage: string) {
  const url = (env.CATALOG_PUBLIC_URL || "").replace(/\/+$/, "").trim();
  const base = closedMessage.trim();
  if (!url) return base;
  if (base.includes(url)) return base;
  return (
    `${base}\n\n` +
    `Enquanto isso, dê uma olhada no nosso *catálogo* e conheça as novidades da Calangus:\n${url}`
  );
}

/** Fora do horário: avisa e deixa na fila aberta para depois. */
export async function handleOutsideHours(contactId: string) {
  const flow = await getFlow();
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });
  const msg = buildOutsideHoursMessage(flow.closedMessage);
  const externalId = await botSend(contact, msg);
  await persistIfSent(contactId, msg, undefined, externalId);
  const queue = await prisma.whatsAppQueue.findFirst({ orderBy: { createdAt: "asc" } });
  const now = new Date();
  const botFlow = contact.botFlow === "financeiro" ? "financeiro" : "atendimento";
  const updated = await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: {
      status: "waiting",
      queueId: queue?.id ?? null,
      botFlow,
      openToAll: true,
      openedToAllAt: contact.openedToAllAt ?? now,
      offeredToId: null,
      offeredAt: null,
      lastMessageAt: now,
      lastMessagePreview: msg.slice(0, 120),
    },
  });
  void recipientIdsForFlow(botFlow).then((ids) => {
    notifyUsersSafe(ids, {
      title: botFlow === "financeiro" ? "Financeiro — fora do horário" : "Nova conversa na fila",
      body: `${contactDisplayName(updated)} está aguardando atendimento`,
      contactId: updated.id,
      tag: `wa-open-${updated.id}`,
    });
  });
}

export async function processInboundBot(contactId: string, body: string | null, isNew: boolean) {
  return withContactLock(contactId, async () => {
    if (!(await isCrmBotEnabled())) {
      console.log("[bot] desativado — ignorando menus para", contactId);
      return;
    }
    const existing = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    if (existing.webhookPaused) return;

    if (!isBusinessHours()) {
      if (existing.status === "waiting" && existing.openToAll) {
        return;
      }
      await handleOutsideHours(contactId);
      return;
    }

    const contact = existing;

    if (shouldIgnoreEchoDigit(contactId, body)) return;

    // Catálogo: keyword pula departamento → menu vendedores (Atendimento)
    if ((isNew || contact.status === "closed" || contact.status === "bot") && isCatalogKeyword(body)) {
      await prisma.whatsAppContact.update({
        where: { id: contactId },
        data: { botFlow: "atendimento", botMenuStep: "sellers" },
      });
      await sendSellersMenu(contactId, "atendimento");
      return;
    }

    if (isNew || contact.status === "closed") {
      await sendDepartmentMenu(contactId);
      return;
    }

    if (contact.status === "bot") {
      if (isBackCommand(body)) {
        await sendDepartmentMenu(contactId);
        return;
      }
      if (body && /^\s*\d+/.test(body)) {
        if (contact.botMenuStep === "department") {
          await handleDepartmentChoice(contactId, body);
          return;
        }
        if (contact.botMenuStep === "sellers" || contact.botMenuStep === "finance_sellers") {
          await handleMenuChoice(contactId, body);
          return;
        }
      }
      if (contact.botMenuStep === "sellers" || contact.botMenuStep === "finance_sellers") {
        await resendSellerMenu(contactId);
      } else {
        await sendDepartmentMenu(contactId);
      }
    }
  });
}

/** Expira ofertas > 10 min → openToAll */
export async function expireStaleOffers() {
  const cutoff = new Date(Date.now() - BUSINESS.offerMinutes * 60_000);
  const stale = await prisma.whatsAppContact.findMany({
    where: {
      status: "waiting",
      webhookPaused: false,
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
    const flow = c.botFlow === "financeiro" ? "financeiro" : "atendimento";
    void recipientIdsForFlow(flow).then((ids) => {
      notifyUsersSafe(ids, {
        title: flow === "financeiro" ? "Financeiro — conversa aberta" : "Conversa aberta",
        body: `${contactDisplayName(c)} ficou disponível para a equipe`,
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
      webhookPaused: false,
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
        body: `${contactDisplayName(c)} — conversa encerrada sem nota`,
        contactId: c.id,
        tag: `wa-rating-${c.id}`,
      });
    }
  }
  return stale.length;
}

/**
 * Após IDLE_CLOSE_HOURS sem mensagem: fecha sem enviar texto e
 * devolve o número ao início do fluxo (próximo inbound = menu).
 */
export async function expireIdleConversations() {
  const hours = Math.max(1, env.IDLE_CLOSE_HOURS);
  const cutoff = new Date(Date.now() - hours * 60 * 60_000);
  const stale = await prisma.whatsAppContact.findMany({
    where: {
      webhookPaused: false,
      status: { in: ["bot", "waiting", "human", "awaiting_rating"] },
      OR: [
        { lastMessageAt: { lt: cutoff } },
        { lastMessageAt: null, updatedAt: { lt: cutoff } },
      ],
    },
    take: 200,
  });

  for (const c of stale) {
    await prisma.whatsAppContact.update({
      where: { id: c.id },
      data: {
        status: "closed",
        botMenuStep: "department",
        assignedToId: null,
        assignedAt: null,
        assumeWaitSeconds: null,
        offeredToId: null,
        offeredAt: null,
        firstOfferedAt: null,
        firstOfferedToId: null,
        openedToAllAt: null,
        openToAll: false,
        queueId: null,
        inactivityWarnedAt: null,
        ratingAskedAt: null,
        unreadCount: 0,
      },
    });
    console.log(`[idle] ${hours}h sem interação → closed (fluxo reset): ${c.phone}`);
  }
  return stale.length;
}

/** Abrir conversa: vendedor assume oferta exclusiva; fila aberta (openToAll) só assume ao responder. Admin não assume. */
export async function assumeOnOpen(
  contactId: string,
  userId: string,
  role: "admin" | "seller" = "seller"
) {
  const contact = await prisma.whatsAppContact.findUniqueOrThrow({
    where: { id: contactId },
  });

  if (role === "admin") return contact;

  const seeAll = await userCanSeeAllMessages(userId, role);

  if (contact.webhookPaused) {
    await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: { unreadCount: 0 },
    });
    return contact;
  }

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
    contact.assignedToId !== userId
  ) {
    if (seeAll) {
      await prisma.whatsAppContact.update({
        where: { id: contactId },
        data: { unreadCount: 0 },
      });
      return contact;
    }
    throw new Error("Conversa já assumida por outro atendente");
  }

  if (contact.status === "waiting" && contact.openToAll) {
    await prisma.whatsAppContact.update({
      where: { id: contactId },
      data: { unreadCount: 0 },
    });
    return contact;
  }

  if (contact.status === "waiting") {
    const canTake =
      seeAll ||
      contact.openToAll ||
      contact.offeredToId === userId ||
      (!contact.offeredToId && !contact.openToAll);
    if (!canTake) {
      throw new Error("Esta conversa está oferecida a outro vendedor");
    }
    const now = new Date();
    const start = assumeMetricStart(contact, userId);
    const assumeWaitSeconds = Math.max(0, Math.round((now.getTime() - start.getTime()) / 1000));

    const waitingWhere = contact.openToAll
      ? { id: contactId, status: "waiting" as const, openToAll: true }
      : contact.offeredToId === userId
        ? {
            id: contactId,
            status: "waiting" as const,
            offeredToId: userId,
            openToAll: false,
          }
        : {
            id: contactId,
            status: "waiting" as const,
            offeredToId: null,
            openToAll: false,
          };

    const claimed = await prisma.whatsAppContact.updateMany({
      where: waitingWhere,
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
    });

    if (claimed.count === 0) {
      const fresh = await prisma.whatsAppContact.findUniqueOrThrow({
        where: { id: contactId },
      });
      if (fresh.status === "human" && fresh.assignedToId === userId) {
        return prisma.whatsAppContact.findUniqueOrThrow({
          where: { id: contactId },
          include: {
            assignedTo: { select: { id: true, name: true } },
            queue: { select: { id: true, name: true } },
          },
        });
      }
      if (fresh.status === "human" && fresh.assignedToId && fresh.assignedToId !== userId) {
        if (seeAll) {
          await prisma.whatsAppContact.update({
            where: { id: contactId },
            data: { unreadCount: 0 },
          });
          return fresh;
        }
        throw new Error("Conversa já assumida por outro atendente");
      }
      throw new Error("Outro atendente acabou de assumir esta conversa");
    }

    return prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
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

async function openQueueVisibilityForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { flowAtendimento: true, flowFinanceiro: true },
  });
  const or: Array<{ botFlow: "atendimento" | "financeiro" | null }> = [];
  if (user?.flowAtendimento !== false) {
    or.push({ botFlow: "atendimento" }, { botFlow: null });
  }
  if (user?.flowFinanceiro) {
    or.push({ botFlow: "financeiro" });
  }
  if (or.length === 0) {
    return { id: "__no_match__" };
  }
  return { OR: or };
}

function sellerScopeSync(sellerId: string) {
  return {
    OR: [
      { assignedToId: sellerId },
      { status: "waiting" as const, offeredToId: sellerId, openToAll: false },
    ],
  };
}

async function sellerScope(sellerId: string, opts?: { includeOpenQueue?: boolean }) {
  const base = sellerScopeSync(sellerId);
  if (opts?.includeOpenQueue === false) return base;
  const flowFilter = await openQueueVisibilityForUser(sellerId);
  return {
    OR: [
      ...base.OR,
      {
        status: "waiting" as const,
        openToAll: true,
        AND: [flowFilter],
      },
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
          { savedName: { contains: opts.search, mode: "insensitive" as const } },
          { pushName: { contains: opts.search, mode: "insensitive" as const } },
          { name: { contains: opts.search, mode: "insensitive" as const } },
          { phone: { contains: opts.search.replace(/\D/g, "") } },
        ],
      }
    : {};

  const statusFilter =
    opts.status === "manual"
      ? { webhookPaused: true }
      : opts.status === "active"
        ? {
            webhookPaused: false,
            status: {
              in: ((await userCanSeeAllMessages(opts.userId, opts.role))
                ? ["bot", "waiting", "human"]
                : ["waiting", "human"]) as ContactStatusFilter[],
            },
          }
        : opts.status
          ? { webhookPaused: false, status: opts.status as ContactStatusFilter }
          : {};

  const include = {
    assignedTo: { select: { id: true, name: true } },
    offeredTo: { select: { id: true, name: true } },
    queue: { select: { id: true, name: true } },
  } as const;

  const seeAll = await userCanSeeAllMessages(opts.userId, opts.role);

  if (seeAll) {
    const sellerFilter = opts.sellerId
      ? sellerScopeSync(opts.sellerId)
      : {};
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
      AND: [baseSearch, statusFilter, await sellerScope(opts.userId, { includeOpenQueue: true })],
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
      savedName: opts.name,
      pushName: opts.name,
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
      savedName: opts.name,
      pushName: opts.name,
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
