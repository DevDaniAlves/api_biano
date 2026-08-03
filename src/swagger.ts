import path from "node:path";
import { fileURLToPath } from "node:url";
import swaggerJsdoc from "swagger-jsdoc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "BIANO Cobrança API",
      version: "1.0.0",
      description:
        "Scrape Meu Crediário (Extrato parcelas em aberto / Hoje) → banco → disparo WhatsApp",
    },
    servers: [{ url: "http://localhost:3333", description: "Local" }],
    tags: [
      { name: "System" },
      { name: "Scrape" },
      { name: "Boletos" },
      { name: "Dispatch" },
    ],
  },
  apis: [
    path.join(__dirname, "routes.ts"),
    path.join(__dirname, "routes.js"),
  ],
});
