import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const productInclude = {
  images: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
} satisfies Prisma.ProductInclude;

export type ProductWithImages = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export function serializeProduct(p: ProductWithImages, opts?: { admin?: boolean }) {
  const images = p.images.map((i) => i.imageUrl);
  const cover = images[0] ?? p.imageUrl ?? null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: cover,
    images,
    ...(opts?.admin
      ? {
          productImages: p.images.map((i) => ({
            id: i.id,
            imageUrl: i.imageUrl,
            sortOrder: i.sortOrder,
          })),
        }
      : {}),
    active: p.active,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function ensureCatalogSettings() {
  return prisma.catalogSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
}

export async function syncProductCover(productId: string) {
  const first = await prisma.productImage.findFirst({
    where: { productId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  await prisma.product.update({
    where: { id: productId },
    data: { imageUrl: first?.imageUrl ?? null },
  });
}
