import { prisma } from "../db.js";

/** Foto enviada pelo vendedor no CRM → fila de aprovação da LP. */
export async function submitSellerPhotoToGallery(opts: {
  imageUrl: string;
  caption?: string | null;
  submittedById: string;
  sourceMessageId?: string | null;
}) {
  const imageUrl = (opts.imageUrl || "").trim();
  if (!imageUrl) return null;

  if (opts.sourceMessageId) {
    const existing = await prisma.galleryImage.findUnique({
      where: { sourceMessageId: opts.sourceMessageId },
    });
    if (existing) return existing;
  }

  try {
    return await prisma.galleryImage.create({
      data: {
        imageUrl,
        caption: opts.caption?.trim() || null,
        status: "pending",
        submittedById: opts.submittedById,
        sourceMessageId: opts.sourceMessageId || null,
      },
    });
  } catch (err) {
    // Único sourceMessageId em race
    if ((err as { code?: string })?.code === "P2002" && opts.sourceMessageId) {
      return prisma.galleryImage.findUnique({
        where: { sourceMessageId: opts.sourceMessageId },
      });
    }
    throw err;
  }
}
