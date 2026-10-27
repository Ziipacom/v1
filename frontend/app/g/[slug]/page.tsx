import type { Metadata } from "next";
import { PublicGalleryView } from "@/components/public-gallery";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Creator gallery — Ziipa",
  description: "Published creations shared by a Ziipa creator.",
};

export default async function GalleryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ post?: string | string[] }>;
}) {
  const { slug } = await params;
  const search = await searchParams;
  return (
    <PublicGalleryView
      key={`${slug}:${typeof search.post === "string" ? search.post : ""}`}
      slug={slug}
      initialItemId={typeof search.post === "string" ? search.post : undefined}
    />
  );
}
