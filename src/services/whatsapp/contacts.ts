import { prisma } from "../../db.js";
import { userCanSeeAllMessages } from "../auth.js";

type ContactNameFields = {
  phone: string;
  name?: string | null;
  pushName?: string | null;
  savedName?: string | null;
};

export function contactDisplayName(c: ContactNameFields): string {
  const saved = c.savedName?.trim();
  if (saved) return saved;
  const push = c.pushName?.trim();
  if (push) return push;
  const legacy = c.name?.trim();
  if (legacy && legacy !== c.phone) return legacy;
  return c.phone;
}

export function contactPushName(c: ContactNameFields): string | null {
  const push = c.pushName?.trim();
  if (push) return push;
  const legacy = c.name?.trim();
  if (legacy && legacy !== c.phone) return legacy;
  return null;
}

export function hasSavedContact(c: { savedName?: string | null }): boolean {
  return Boolean(c.savedName?.trim());
}

export function serializeContact<T extends ContactNameFields>(c: T) {
  return {
    ...c,
    name: contactDisplayName(c),
    pushName: contactPushName(c),
    savedName: c.savedName?.trim() || null,
    hasSavedContact: hasSavedContact(c),
  };
}

function sellerCanAccessContact(
  contact: { assignedToId: string | null; status: string; offeredToId: string | null; openToAll: boolean },
  userId: string
) {
  if (contact.assignedToId === userId) return true;
  if (contact.status === "waiting") {
    if (contact.openToAll) return true;
    if (contact.offeredToId === userId) return true;
    if (!contact.offeredToId && !contact.openToAll) return true;
  }
  return false;
}

export async function saveContactSavedName(opts: {
  contactId: string;
  name: string;
  userId: string;
  role: "admin" | "seller";
}) {
  const savedName = opts.name.trim();
  if (!savedName) throw new Error("Informe o nome do contato");

  const contact = await prisma.whatsAppContact.findUnique({
    where: { id: opts.contactId },
  });
  if (!contact) throw new Error("Contato não encontrado");

  if (opts.role === "seller" && !(await userCanSeeAllMessages(opts.userId, opts.role))) {
    if (!sellerCanAccessContact(contact, opts.userId)) {
      throw new Error("Contato não encontrado");
    }
  }

  const updated = await prisma.whatsAppContact.update({
    where: { id: opts.contactId },
    data: { savedName },
    include: {
      assignedTo: { select: { id: true, name: true } },
      offeredTo: { select: { id: true, name: true } },
      queue: { select: { id: true, name: true } },
    },
  });

  return serializeContact(updated);
}
