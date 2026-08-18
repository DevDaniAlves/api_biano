import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** MIME exato exigido pela Gupshup/WhatsApp para áudio. */
export function normalizeGupshupAudioMime(mimetype?: string, fileName?: string): string {
  const raw = (mimetype || "").trim().toLowerCase();
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (raw.includes("ogg") || ext === "ogg") return "audio/ogg; codecs=opus";
  if (raw.includes("mp4") || raw.includes("m4a") || ext === "m4a" || ext === "mp4") return "audio/mp4";
  if (raw.includes("mpeg") || raw.includes("mp3") || ext === "mp3") return "audio/mpeg";
  if (raw.includes("aac")) return "audio/aac";
  if (raw.includes("amr")) return "audio/amr";
  if (raw.includes("webm") || ext === "webm") return "audio/webm";
  return "audio/ogg; codecs=opus";
}

export function isWebmAudio(mimetype?: string, fileName?: string): boolean {
  const raw = (mimetype || "").toLowerCase();
  return raw.includes("webm") || fileName?.toLowerCase().endsWith(".webm") || false;
}

async function ffmpegBin(): Promise<string> {
  const mod = await import("ffmpeg-static");
  const bin = (mod.default ?? mod) as unknown;
  if (typeof bin !== "string" || !bin) throw new Error("ffmpeg não encontrado no servidor");
  return bin;
}

/** Chrome grava WebM; WhatsApp só aceita ogg/mp4/mpeg/aac/amr. */
export async function convertWebmToOggOpus(input: Buffer): Promise<Buffer> {
  const ffmpegPath = await ffmpegBin();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(os.tmpdir(), `biano-wa-${id}.webm`);
  const outPath = path.join(os.tmpdir(), `biano-wa-${id}.ogg`);
  await fs.writeFile(inPath, input);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        ffmpegPath,
        ["-y", "-i", inPath, "-c:a", "libopus", "-b:a", "32k", outPath],
        { stdio: "ignore" }
      );
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com código ${code}`))
      );
    });
    const out = await fs.readFile(outPath);
    if (out.length < 40) throw new Error("conversão gerou arquivo vazio");
    return out;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

export async function prepareGupshupAudioUpload(opts: {
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
}): Promise<{ buffer: Buffer; mimetype: string; fileName: string }> {
  let { buffer, mimetype, fileName } = opts;
  if (isWebmAudio(mimetype, fileName)) {
    buffer = await convertWebmToOggOpus(buffer);
    mimetype = "audio/ogg; codecs=opus";
    fileName = (fileName || "audio.webm").replace(/\.webm$/i, ".ogg");
  }
  const mime = normalizeGupshupAudioMime(mimetype, fileName);
  const name = fileName || (mime.includes("ogg") ? "audio.ogg" : "audio.mp4");
  return { buffer, mimetype: mime, fileName: name };
}
