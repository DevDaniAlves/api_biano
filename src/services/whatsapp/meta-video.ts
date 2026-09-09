import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Meta Cloud API: vídeo só video/mp4 ou video/3gp. */
export function isMetaAcceptedVideoMime(mimetype?: string, fileName?: string): boolean {
  const raw = (mimetype || "").toLowerCase();
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (raw.includes("3gpp") || raw.includes("3gp") || ext === "3gp") return true;
  if ((raw.includes("mp4") || ext === "mp4" || ext === "m4v") && !raw.includes("webm")) return true;
  return false;
}

export function looksLikeWebm(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

/** webm/mov/avi/quicktime (e mp4 “falso”) → precisa transcodificar. */
export function needsVideoTranscode(mimetype?: string, fileName?: string, buffer?: Buffer): boolean {
  if (buffer && looksLikeWebm(buffer)) return true;
  if (isMetaAcceptedVideoMime(mimetype, fileName) && !(buffer && looksLikeWebm(buffer))) {
    return false;
  }
  return true;
}

function inputExt(mimetype?: string, fileName?: string, buffer?: Buffer): string {
  if (buffer && looksLikeWebm(buffer)) return "webm";
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && /^[a-z0-9]{2,5}$/.test(ext)) return ext;
  const m = (mimetype || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime") || m.includes("mov")) return "mov";
  if (m.includes("3gpp") || m.includes("3gp")) return "3gp";
  if (m.includes("mp4") || m.includes("m4v")) return "mp4";
  if (m.includes("avi")) return "avi";
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

/** Converte para H.264 + AAC em MP4 (compatível com WhatsApp Cloud API). */
export async function convertVideoToMp4(input: Buffer, srcExt: string): Promise<Buffer> {
  const ffmpegPath = await ffmpegBin();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(os.tmpdir(), `biano-wa-v-${id}.${srcExt || "bin"}`);
  const outPath = path.join(os.tmpdir(), `biano-wa-v-${id}.mp4`);
  await fs.writeFile(inPath, input);
  try {
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
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

export async function prepareMetaVideoUpload(opts: {
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
}): Promise<{ buffer: Buffer; mimetype: string; fileName: string }> {
  let { buffer, mimetype, fileName } = opts;
  if (needsVideoTranscode(mimetype, fileName, buffer)) {
    buffer = await convertVideoToMp4(buffer, inputExt(mimetype, fileName, buffer));
    mimetype = "video/mp4";
    fileName = (fileName || "video").replace(/\.[a-z0-9]+$/i, "") + ".mp4";
  } else {
    mimetype = "video/mp4";
    if (fileName && !/\.mp4$/i.test(fileName) && !/\.3gp$/i.test(fileName)) {
      fileName = fileName.replace(/\.[a-z0-9]+$/i, "") + ".mp4";
    }
  }
  return {
    buffer,
    mimetype: mimetype || "video/mp4",
    fileName: fileName || "video.mp4",
  };
}
