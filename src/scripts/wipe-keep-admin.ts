import { prisma } from "../db.js";

async function main() {
  const admins = await prisma.user.findMany({
    where: { role: "admin" },
    select: { id: true, email: true, name: true, active: true },
  });

  if (admins.length === 0) {
    throw new Error("Nenhum usuário admin encontrado. Abortando para não deixar o banco sem login.");
  }

  console.log("Admins que serão mantidos:");
  for (const a of admins) {
    console.log(`  ${a.email} (${a.name}) active=${a.active} id=${a.id}`);
  }

  const countsBefore = {
    users: await prisma.user.count(),
    sellers: await prisma.user.count({ where: { role: "seller" } }),
    boletos: await prisma.boleto.count(),
    jobs: await prisma.scrapeJob.count(),
    contacts: await prisma.whatsAppContact.count(),
    messages: await prisma.whatsAppMessage.count(),
    products: await prisma.product.count(),
    queues: await prisma.whatsAppQueue.count(),
    agents: await prisma.whatsAppAgent.count(),
    push: await prisma.pushSubscription.count(),
  };
  console.log("Antes:", countsBefore);

  const savedInstanceName =
    (
      await prisma.whatsAppConnection.findUnique({
        where: { id: "default" },
        select: { instanceName: true },
      })
    )?.instanceName?.trim() || "";

  await prisma.$transaction(
    async (tx) => {
      await tx.whatsAppMessage.deleteMany();
      await tx.whatsAppContact.deleteMany();
      await tx.whatsAppAgent.deleteMany();
      await tx.whatsAppQueue.deleteMany();
      await tx.boleto.deleteMany();
      await tx.scrapeJob.deleteMany();
      await tx.product.deleteMany();
      await tx.pushSubscription.deleteMany();
      await tx.userScheduleSlot.deleteMany();
      await tx.userLeave.deleteMany();
      await tx.userUnavailability.deleteMany();
      await tx.whatsAppFlow.deleteMany();
      await tx.whatsAppConnection.deleteMany();
      await tx.gestorAutomation.deleteMany();
      await tx.user.deleteMany({ where: { role: { not: "admin" } } });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  await prisma.whatsAppFlow.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      welcomeMessage: "Olá! Bem-vindo à Calangus. Escolha um atendente:",
      closedMessage:
        "Nosso horário de atendimento se encerrou (seg–sex, 08:00–18:00). Atenderemos assim que possível.\n\nEnquanto isso, dê uma olhada no nosso catálogo e conheça as novidades da Calangus.",
      menuEnabled: true,
      options: [],
    },
    update: {
      welcomeMessage: "Olá! Bem-vindo à Calangus. Escolha um atendente:",
      closedMessage:
        "Nosso horário de atendimento se encerrou (seg–sex, 08:00–18:00). Atenderemos assim que possível.\n\nEnquanto isso, dê uma olhada no nosso catálogo e conheça as novidades da Calangus.",
      menuEnabled: true,
      options: [],
    },
  });

  await prisma.whatsAppConnection.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      instanceName: savedInstanceName,
      status: "disconnected",
      lastQr: null,
    },
    update: {
      instanceName: savedInstanceName,
      status: "disconnected",
      lastQr: null,
    },
  });

  await prisma.gestorAutomation.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      enabled: false,
      runTimeHHMM: "08:00",
      weekdays: [1, 2, 3, 4, 5],
      dispatchAfterScrape: true,
    },
    update: {
      enabled: false,
      runTimeHHMM: "08:00",
      weekdays: [1, 2, 3, 4, 5],
      dispatchAfterScrape: true,
      lastRunAt: null,
      lastRunYmd: null,
      lastRunStatus: null,
      lastRunMessage: null,
    },
  });

  const remaining = await prisma.user.findMany({
    select: { email: true, name: true, role: true },
  });
  console.log("Usuários restantes:", remaining);
  console.log("Wipe OK — somente admin(s) + configs vazias.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
