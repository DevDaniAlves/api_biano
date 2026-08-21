import { prisma } from "../db.js";

const r = await prisma.whatsAppConnection.upsert({
  where: { id: "default" },
  create: {
    id: "default",
    provider: "meta",
    metaPhoneNumberId: "1236714352864758",
    metaWabaId: "2142001143396659",
  },
  update: {
    provider: "meta",
    metaPhoneNumberId: "1236714352864758",
    metaWabaId: "2142001143396659",
  },
});

console.log({
  provider: r.provider,
  phone: r.metaPhoneNumberId,
  waba: r.metaWabaId,
});

await prisma.$disconnect();
