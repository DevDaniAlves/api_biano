import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { ensureFlow, type FlowOption } from "../services/whatsapp/flow.js";

async function main() {
  const passwordHash = await bcrypt.hash("calangus123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@calangus.com" },
    update: {},
    create: {
      name: "Admin Calangus",
      email: "admin@calangus.com",
      passwordHash,
      role: "admin",
    },
  });

  const sellers = [];
  for (let i = 1; i <= 3; i++) {
    const s = await prisma.user.upsert({
      where: { email: `vendedor${i}@calangus.com` },
      update: { name: `Atendente ${i}` },
      create: {
        name: `Atendente ${i}`,
        email: `vendedor${i}@calangus.com`,
        passwordHash,
        role: "seller",
      },
    });
    sellers.push(s);
  }

  // compat: vendedor@calangus.com → Atendente 1
  await prisma.user.upsert({
    where: { email: "vendedor@calangus.com" },
    update: {},
    create: {
      name: "Atendente 1",
      email: "vendedor@calangus.com",
      passwordHash,
      role: "seller",
    },
  });

  const queue = await prisma.whatsAppQueue.upsert({
    where: { id: "seed-vendas" },
    update: { name: "Vendas" },
    create: { id: "seed-vendas", name: "Vendas" },
  });

  for (let i = 0; i < sellers.length; i++) {
    await prisma.whatsAppAgent.upsert({
      where: { userId_queueId: { userId: sellers[i].id, queueId: queue.id } },
      update: { sortOrder: i },
      create: { userId: sellers[i].id, queueId: queue.id, sortOrder: i },
    });
  }

  await ensureFlow();
  const options: FlowOption[] = [
    { key: "1", label: "Atendente 1", action: "agent", userId: sellers[0].id },
    { key: "2", label: "Atendente 2", action: "agent", userId: sellers[1].id },
    { key: "3", label: "Atendente 3", action: "agent", userId: sellers[2].id },
    { key: "4", label: "Não tenho preferência", action: "queue", queueId: queue.id },
  ];
  await prisma.whatsAppFlow.update({
    where: { id: "default" },
    data: {
      welcomeMessage: "Olá! Bem-vindo à Calangus Moda Jovem. Escolha um atendente:",
      closedMessage:
        "Nosso horário de atendimento se encerrou (seg–sex, 08:00–18:00). Atenderemos assim que possível.",
      options: options as object[],
    },
  });

  console.log("Seed OK");
  console.log("  admin@calangus.com / calangus123");
  console.log("  vendedor1@calangus.com / calangus123");
  console.log("  vendedor2@calangus.com / calangus123");
  console.log("  vendedor3@calangus.com / calangus123");
  console.log("  fila Vendas + fluxo 1-4 configurados");
  console.log("  admin:", admin.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
