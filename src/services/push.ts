import webpush from "web-push";
import { env } from "../config.js";
import { prisma } from "../db.js";

export type PushPayload = {
  title: string;
  body: string;
  contactId: string;
  tag?: string;
};

let vapidReady = false;

function ensureVapid() {
  if (vapidReady) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

export function getVapidPublicKey() {
  return env.VAPID_PUBLIC_KEY ?? null;
}

/** Badge do ícone: filas novas + mensagens não lidas em andamento. */
export async function pendingBadgeCount(userId: string, role: "admin" | "seller") {
  if (role === "admin") {
    const waiting = await prisma.whatsAppContact.count({ where: { status: "waiting" } });
    const unread = await prisma.whatsAppContact.aggregate({
      where: { status: "human", unreadCount: { gt: 0 } },
      _sum: { unreadCount: true },
    });
    return waiting + (unread._sum.unreadCount ?? 0);
  }

  const waitingExclusive = await prisma.whatsAppContact.count({
    where: { status: "waiting", offeredToId: userId, openToAll: false },
  });
  const waitingOpen = await prisma.whatsAppContact.count({
    where: { status: "waiting", openToAll: true },
  });
  const unread = await prisma.whatsAppContact.aggregate({
    where: { status: "human", assignedToId: userId, unreadCount: { gt: 0 } },
    _sum: { unreadCount: true },
  });
  return waitingExclusive + waitingOpen + (unread._sum.unreadCount ?? 0);
}

export async function savePushSubscription(opts: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}) {
  return prisma.pushSubscription.upsert({
    where: { endpoint: opts.endpoint },
    create: {
      userId: opts.userId,
      endpoint: opts.endpoint,
      p256dh: opts.p256dh,
      auth: opts.auth,
      userAgent: opts.userAgent ?? null,
    },
    update: {
      userId: opts.userId,
      p256dh: opts.p256dh,
      auth: opts.auth,
      userAgent: opts.userAgent ?? null,
    },
  });
}

export async function deletePushSubscription(endpoint: string, userId?: string) {
  if (userId) {
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
    return;
  }
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
}

export async function recipientIdsForOpenQueue(queueId: string | null): Promise<string[]> {
  if (queueId) {
    const agents = await prisma.whatsAppAgent.findMany({
      where: { queueId, user: { active: true } },
      select: { userId: true },
    });
    return [...new Set(agents.map((a) => a.userId))];
  }
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

function urlForUser(role: string, contactId: string) {
  return role === "admin"
    ? `/admin/whatsapp/conversas?contact=${contactId}`
    : `/atendimento?contact=${contactId}`;
}

export async function notifyUsers(userIds: string[], payload: PushPayload) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  if (!ensureVapid()) {
    console.warn("[push] VAPID não configurado — notificação ignorada:", payload.title);
    return;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: ids }, active: true },
    select: { id: true, role: true },
  });
  if (users.length === 0) return;

  const subs = await prisma.pushSubscription.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
  });
  if (subs.length === 0) return;

  const roleByUser = new Map(users.map((u) => [u.id, u.role]));
  const badgeByUser = new Map<string, number>();
  await Promise.all(
    users.map(async (u) => {
      badgeByUser.set(u.id, await pendingBadgeCount(u.id, u.role));
    })
  );

  await Promise.all(
    subs.map(async (sub) => {
      const role = roleByUser.get(sub.userId) ?? "seller";
      const body = JSON.stringify({
        title: payload.title,
        body: payload.body,
        tag: payload.tag ?? `wa-${payload.contactId}`,
        contactId: payload.contactId,
        url: urlForUser(role, payload.contactId),
        badge: badgeByUser.get(sub.userId) ?? 1,
      });
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          return;
        }
        console.error("[push]", status ?? "", err instanceof Error ? err.message : err);
      }
    })
  );
}

export function notifyUsersSafe(userIds: string[], payload: PushPayload) {
  void notifyUsers(userIds, payload).catch((err) => {
    console.error("[push]", err instanceof Error ? err.message : err);
  });
}
