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

export function formatFirstName(full: string): string {
  const part = full.trim().split(/\s+/).find(Boolean) ?? full.trim();
  if (!part) return full.trim();
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

function phoneLookupVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const variants = new Set<string>();
  if (digits) variants.add(digits);
  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") {
    variants.add(`${digits.slice(0, 4)}${digits.slice(5)}`);
  }
  if (digits.startsWith("55") && digits.length === 12) {
    variants.add(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  }
  return [...variants];
}

/** Nome para saudação: cadastro CRM (savedName) ou cliente no crediário (boleto). */
export async function resolveRegisteredGreetingName(
  contact: ContactNameFields
): Promise<string | null> {
  const saved = contact.savedName?.trim();
  if (saved) return formatFirstName(saved);

  const variants = phoneLookupVariants(contact.phone);
  if (!variants.length) return null;

  const boleto = await prisma.boleto.findFirst({
    where: { clienteTelefone: { in: variants } },
    orderBy: { collectedAt: "desc" },
    select: { clienteNome: true },
  });
  const crediario = boleto?.clienteNome?.trim();
  if (crediario) return formatFirstName(crediario);

  return null;
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
