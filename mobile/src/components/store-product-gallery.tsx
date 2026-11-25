import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Music,
  Play,
} from "lucide-react-native";
import { useZiipa } from "../provider";
import { useStorePhotoSource } from "../lib/store-photo-source";
import type { Listing } from "../lib/commerce";
import { color } from "../theme";
import { StoreMediaPreview } from "./store-media-preview";

type Entry = { path: string; kind: "photo" | "video" | "audio"; type: string };

const thumbnailsPerPage = 3;
function Photo({ path, contain = false }: { path: string; contain?: boolean }) {
  const { session } = useZiipa();
  const source = useStorePhotoSource(path, session?.access_token);
  return source ? (
    <Image
      source={source}
      resizeMode={contain ? "contain" : "cover"}
      style={{ width: "100%", height: "100%" }}
    />
  ) : (
    <ImageIcon size={24} color={color.muted} />
  );
}
export function StoreProductGallery({ listing }: { listing: Listing }) {
  const [selection, setSelection] = useState(0);
  const entries = new Map<string, Entry>();
  for (const path of listing.photos)
    entries.set(path, { path, kind: "photo", type: "image" });
  for (const media of listing.media || []) {
    if (entries.has(media.path)) continue;
    entries.set(media.path, {
      path: media.path,
      kind: media.content_type.startsWith("video/")
        ? "video"
        : media.content_type.startsWith("audio/")
          ? "audio"
          : "photo",
      type: media.content_type,
    });
  }
  const items = Array.from(entries.values());
  const selected = Math.min(selection, Math.max(0, items.length - 1));
  const current = items[selected];
  const pageStart =
    Math.floor(selected / thumbnailsPerPage) * thumbnailsPerPage;
  const canPage = items.length > thumbnailsPerPage;
  const previousPage = () => setSelection(pageStart - 1);
  const nextPage = () => setSelection(pageStart + thumbnailsPerPage);
  return (
    <View
      testID="product-media-grid"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        minWidth: 0,
      }}
    >
      <View
        testID="product-media-preview"
        style={{
          flex: 1,
          minWidth: 0,
          aspectRatio: 1,
          maxHeight: 360,
          borderRadius: 16,
          overflow: "hidden",
          backgroundColor: color.panel,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {current?.kind === "photo" ? (
          <Photo path={current.path} contain />
        ) : current ? (
          <View style={{ width: "100%" }}>
            <StoreMediaPreview
              key={current.path}
              path={current.path}
              contentType={current.type}
            />
          </View>
        ) : (
          <ImageIcon size={36} color={color.muted} />
        )}
        {canPage && (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              flexDirection: "row",
              gap: 4,
            }}
          >
            <GalleryPageButton
              label="Previous photos and media"
              icon={ChevronLeft}
              disabled={pageStart === 0}
              onPress={previousPage}
            />
            <GalleryPageButton
              label="Next photos and media"
              icon={ChevronRight}
              disabled={pageStart + thumbnailsPerPage >= items.length}
              onPress={nextPage}
            />
          </View>
        )}
      </View>
      {items.length > 1 && (
        <View
          testID="product-media-thumbnails"
          style={{ width: "21%", minWidth: 48, maxWidth: 82, gap: 7 }}
        >
          {items
            .slice(pageStart, pageStart + thumbnailsPerPage)
            .map((entry, index) => {
              const position = pageStart + index;
              const active = selected === position;
              return (
                <Pressable
                  key={entry.path}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${entry.kind} ${position + 1} of ${items.length}`}
                  accessibilityState={{ selected: active }}
                  aria-pressed={active}
                  onPress={() => setSelection(position)}
                  style={{
                    width: "100%",
                    aspectRatio: 1,
                    minHeight: 44,
                    borderWidth: 2,
                    borderColor: active ? color.purple : color.border,
                    borderRadius: 10,
                    overflow: "hidden",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: color.panel,
                  }}
                >
                  {entry.kind === "photo" ? (
                    <Photo path={entry.path} />
                  ) : entry.kind === "video" ? (
                    <Play size={19} color={color.text} />
                  ) : (
                    <Music size={19} color={color.text} />
                  )}
                </Pressable>
              );
            })}
        </View>
      )}
    </View>
  );
}

function GalleryPageButton({
  label,
  icon: Icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: typeof ChevronLeft;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#110D1CB8",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon size={19} color="#FFFFFF" />
    </Pressable>
  );
}
