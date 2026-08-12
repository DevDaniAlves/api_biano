import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const before = {
    contacts: await prisma.whatsAppContact.count(),
    messages: await prisma.whatsAppMessage.count(),
    paused: await prisma.whatsAppContact.count({ where: { webhookPaused: true } }),
    notBot: await prisma.whatsAppContact.count({ where: { NOT: { status: "bot" } } }),
  };
  console.log("Antes:", before);

  const deletedMessages = await prisma.whatsAppMessage.deleteMany({});
  // Apaga contatos: próxima mensagem = isNew → menu do fluxo do zero.
  // Não mexe em User, Queue, Flow, Connection, Boletos, etc.
  const deletedContacts = await prisma.whatsAppContact.deleteMany({});

  console.log("Removido:", {
    messages: deletedMessages.count,
    contacts: deletedContacts.count,
  });

  const after = {
    contacts: await prisma.whatsAppContact.count(),
    messages: await prisma.whatsAppMessage.count(),
  };
  console.log("Depois:", after);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
