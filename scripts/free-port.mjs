import { execSync } from "node:child_process";

const port = process.env.PORT || "3333";

try {
  if (process.platform === "win32") {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[predev] liberou PID ${pid} na porta ${port}`);
      } catch {
        /* já morto */
      }
    }
  } else {
    try {
      execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
} catch {
  /* nada escutando */
}
