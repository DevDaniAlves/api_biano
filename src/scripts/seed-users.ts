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
  for (let i = 1; i <= 2; i++) {
    const s = await prisma.user.upsert({
      where: { email: `vendedor${i}@calangus.com` },
      update: { name: `Atendente ${i}`, active: true },
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
    update: { name: "Atendente 1", active: true },
    create: {
      name: "Atendente 1",
      email: "vendedor@calangus.com",
      passwordHash,
      role: "seller",
    },
  });

  // Desativa 3º vendedor se existir de seed antigo
  const seller3 = await prisma.user.findUnique({
    where: { email: "vendedor3@calangus.com" },
  });
  if (seller3) {
    await prisma.whatsAppAgent.deleteMany({ where: { userId: seller3.id } });
    await prisma.user.update({
      where: { id: seller3.id },
      data: { active: false },
    });
  }

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
    { key: "3", label: "Não tenho preferência", action: "queue", queueId: queue.id },
  ];
  await prisma.whatsAppFlow.update({
    where: { id: "default" },
    data: {
      welcomeMessage: "Olá! Bem-vindo à Calangus Moda Jovem. Escolha um atendente:",
      closedMessage:
        "Nosso horário de atendimento se encerrou. Atenderemos assim que possível.\n\n⏰ Horário de atendimento\n\n🗓️ Segunda a sexta: 08h às 18h30\n🗓️ Sábado: 08h às 16h30",
      options: options as object[],
    },
  });

  await prisma.whatsAppConnection.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", instanceName: "", status: "disconnected" },
  });

  const sampleProducts = [
    {
      name: "Camiseta Oversized Preta",
      description: "Algodão premium, caimento solto.",
      price: 89.9,
      imageUrl: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600",
      sortOrder: 1,
    },
    {
      name: "Calça Cargo Bege",
      description: "Cargo leve para o dia a dia.",
      price: 159.9,
      imageUrl: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=600",
      sortOrder: 2,
    },
    {
      name: "Jaqueta Bomber",
      description: "Camada leve com visual urbano.",
      price: 249.9,
      imageUrl: "https://images.unsplash.com/photo-1551028719-00167b16eac5?w=600",
      sortOrder: 3,
    },
  ];
  const productCount = await prisma.product.count();
  if (productCount === 0) {
    await prisma.product.createMany({ data: sampleProducts });
  }

  console.log("Seed OK (ambiente)");
  console.log("  admin@calangus.com / calangus123");
  console.log("  vendedor1@calangus.com / calangus123");
  console.log("  vendedor2@calangus.com / calangus123");
  console.log("  fila Vendas + fluxo 1-3 (2 atendentes + sem preferência)");
  console.log("  admin:", admin.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
