import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
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
import { color, styles } from "../theme";
import { StoreMediaPreview } from "./store-media-preview";

type Entry = { path: string; type: string };
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
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  const entries: Entry[] = [
    ...listing.photos.map((path) => ({ path, type: "image" })),
    ...(listing.media || []).map((media) => ({
      path: media.path,
      type: media.content_type,
    })),
  ];
  const current = entries[selected];
  const pages = Math.ceil(entries.length / 3);
  return (
    <View style={{ gap: 10, minWidth: 0 }}>
      <View
        style={{
          width: "100%",
          aspectRatio: 1,
          maxHeight: 360,
          borderRadius: 16,
          overflow: "hidden",
          backgroundColor: color.panel,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {current?.type === "image" ? (
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
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {entries.slice(page * 3, page * 3 + 3).map((entry, index) => {
          const position = page * 3 + index;
          return (
            <Pressable
              key={entry.path}
              accessibilityRole="button"
              accessibilityLabel={`View ${entry.type === "image" ? "photo" : entry.type.startsWith("video/") ? "video" : "audio"} ${position + 1}`}
              accessibilityState={{ selected: selected === position }}
              aria-pressed={selected === position}
              onPress={() => setSelected(position)}
              style={{
                flex: 1,
                maxWidth: "33.333%",
                aspectRatio: 1,
                maxHeight: 90,
                minHeight: 44,
                borderWidth: 2,
                borderColor:
                  selected === position ? color.purple : color.border,
                borderRadius: 10,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: color.panel,
              }}
            >
              {entry.type === "image" ? (
                <Photo path={entry.path} />
              ) : entry.type.startsWith("video/") ? (
                <Play size={24} color={color.text} />
              ) : (
                <Music size={24} color={color.text} />
              )}
            </Pressable>
          );
        })}
      </View>
      {entries.length > 1 && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={styles.small}>
            {selected + 1} / {entries.length}
          </Text>
          {pages > 1 && (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Previous thumbnails"
                disabled={page === 0}
                onPress={() => setPage(page - 1)}
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: page === 0 ? 0.35 : 1,
                }}
              >
                <ChevronLeft size={20} color={color.text} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Next thumbnails"
                disabled={page === pages - 1}
                onPress={() => setPage(page + 1)}
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: page === pages - 1 ? 0.35 : 1,
                }}
              >
                <ChevronRight size={20} color={color.text} />
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
