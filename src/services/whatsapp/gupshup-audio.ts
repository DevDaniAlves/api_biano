import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** MIME exato exigido pela Gupshup/WhatsApp para áudio. */
export function normalizeGupshupAudioMime(mimetype?: string, fileName?: string): string {
  const raw = (mimetype || "").trim().toLowerCase();
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (raw.includes("mpeg") || raw.includes("mp3") || ext === "mp3") return "audio/mpeg";
  if (raw.includes("ogg") || ext === "ogg" || ext === "opus") return "audio/ogg; codecs=opus";
  if (raw.includes("mp4") || raw.includes("m4a") || ext === "m4a" || ext === "mp4") return "audio/mp4";
  if (raw.includes("aac")) return "audio/aac";
  if (raw.includes("amr")) return "audio/amr";
  if (raw.includes("webm") || ext === "webm") return "audio/webm";
  return "audio/mpeg";
}

export function isWebmAudio(mimetype?: string, fileName?: string): boolean {
  const raw = (mimetype || "").toLowerCase();
  return raw.includes("webm") || fileName?.toLowerCase().endsWith(".webm") || false;
}

/** MediaRecorder (m4a/webm/ogg) → transcodificar para MP3 (sample Gupshup). */
export function needsAudioTranscode(mimetype?: string, fileName?: string): boolean {
  const raw = (mimetype || "").toLowerCase();
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (raw.includes("mpeg") || raw.includes("mp3") || ext === "mp3") return false;
  return true;
}

/** @deprecated */
export function needsOggConversion(mimetype?: string, fileName?: string): boolean {
  return needsAudioTranscode(mimetype, fileName);
}

function inputExt(mimetype?: string, fileName?: string): string {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && /^[a-z0-9]{2,5}$/.test(ext)) return ext;
  const m = (mimetype || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("aac")) return "aac";
  if (m.includes("amr")) return "amr";
  if (m.includes("ogg")) return "ogg";
  return "bin";
}

async function ffmpegBin(): Promise<string> {
  const mod = await import("ffmpeg-static");
  const bin = (mod.default ?? mod) as unknown;
  if (typeof bin !== "string" || !bin) throw new Error("ffmpeg não encontrado no servidor");
  return bin;
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com código ${code}`))
    );
  });
}

/** Sample Gupshup usa MP3 (gs-upload.gupshup.io/.../sample01.mp3). */
export async function convertAudioToMp3(input: Buffer, srcExt: string): Promise<Buffer> {
  const ffmpegPath = await ffmpegBin();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(os.tmpdir(), `biano-wa-${id}.${srcExt || "bin"}`);
  const outPath = path.join(os.tmpdir(), `biano-wa-${id}.mp3`);
  await fs.writeFile(inPath, input);
  try {
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      outPath,
    ]);
    const out = await fs.readFile(outPath);
    if (out.length < 40) throw new Error("conversão gerou arquivo vazio");
    return out;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

export async function convertWebmToOggOpus(input: Buffer): Promise<Buffer> {
  return convertAudioToMp3(input, "webm");
}

export async function prepareGupshupAudioUpload(opts: {
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
}): Promise<{ buffer: Buffer; mimetype: string; fileName: string }> {
  let { buffer, mimetype, fileName } = opts;
  if (needsAudioTranscode(mimetype, fileName)) {
    buffer = await convertAudioToMp3(buffer, inputExt(mimetype, fileName));
    mimetype = "audio/mpeg";
    fileName = (fileName || "audio").replace(/\.[a-z0-9]+$/i, "") + ".mp3";
  }
  const mime = normalizeGupshupAudioMime(mimetype, fileName);
  const name = fileName || "audio.mp3";
  return { buffer, mimetype: mime, fileName: name };
}
