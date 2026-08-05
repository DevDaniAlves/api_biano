import fs from "node:fs";
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
import { failStaleAutomationRun, tickGestorAutomation } from "./services/gestor-automation.js";
import { failStaleRunningJobs } from "./services/jobs.js";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "12mb" }));
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".ogg") || filePath.endsWith(".opus")) {
        res.setHeader("Content-Type", "audio/ogg; codecs=opus");
      } else if (filePath.endsWith(".webm")) {
        res.setHeader("Content-Type", "audio/webm");
      } else if (filePath.endsWith(".m4a") || filePath.endsWith(".mp4")) {
        if (filePath.endsWith(".m4a")) res.setHeader("Content-Type", "audio/mp4");
      }
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/docs.json", (_req, res) => res.json(swaggerSpec));
app.use(router);
app.use("/catalog", catalogRouter);
app.use("/whatsapp", whatsappRouter);

const server = app.listen(env.PORT, () => {
  console.log(`API http://localhost:${env.PORT}`);
  console.log(`Swagger http://localhost:${env.PORT}/docs`);
  console.log(`Uploads ${UPLOADS_DIR}`);
  void failStaleRunningJobs();
  void failStaleAutomationRun();
  setInterval(() => {
    expireStaleOffers().catch((e) => console.error("[fila]", e));
    expireStaleRatings().catch((e) => console.error("[rating]", e));
    tickGestorAutomation().catch((e) => console.error("[gestor-auto]", e));
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
