import { seedDemoReports } from "../services/whatsapp/reports.js";
import { prisma } from "../db.js";

async function main() {
  const result = await seedDemoReports(90);
  console.log(`Demo OK: ${result.created} conversas (telefone 5599DEMO…)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
