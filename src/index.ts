import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import swaggerUi from "swagger-ui-express";
import { env } from "./config.js";
import { router } from "./routes.js";
import { catalogRouter } from "./routes/catalog.js";
import { whatsappRouter } from "./routes/whatsapp.js";
import { swaggerSpec } from "./swagger.js";
import { expireStaleOffers } from "./services/whatsapp/flow.js";
import { expireStaleRatings, UPLOADS_DIR } from "./services/whatsapp/service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "12mb" }));
app.use("/uploads", express.static(UPLOADS_DIR));

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/docs.json", (_req, res) => res.json(swaggerSpec));
app.use(router);
app.use("/catalog", catalogRouter);
app.use("/whatsapp", whatsappRouter);

const server = app.listen(env.PORT, () => {
  console.log(`API http://localhost:${env.PORT}`);
  console.log(`Swagger http://localhost:${env.PORT}/docs`);
  setInterval(() => {
    expireStaleOffers().catch((e) => console.error("[fila]", e));
    expireStaleRatings().catch((e) => console.error("[rating]", e));
  }, 30_000);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Porta ${env.PORT} em uso. Mate o processo antigo e suba de novo:\n` +
        `  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${env.PORT} -State Listen).OwningProcess -Force`
    );
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
