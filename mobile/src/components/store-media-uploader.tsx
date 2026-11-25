import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  Camera,
  Film,
  Images,
  Music,
  Pencil,
  Plus,
  Upload,
} from "lucide-react-native";
import { useZiipa } from "../provider";
import { useStorePhotoSource } from "../lib/store-photo-source";
import { color, styles } from "../theme";
import { Action } from "./ui";
import { Sheet } from "./floating";
import { StoreMediaPreview } from "./store-media-preview";

function Thumbnail({ path }: { path: string }) {
  const { session } = useZiipa();
  const source = useStorePhotoSource(path, session?.access_token);
  return source ? (
    <Image
      source={source}
      resizeMode="cover"
      style={{ width: "100%", height: "100%" }}
    />
  ) : (
    <Images size={20} color={color.muted} />
  );
}
export function StoreMediaUploader({
  photos,
  media,
  busy,
  path,
  mediaInfo,
  upload,
  camera,
  library,
  remove,
  cover,
}: {
  photos: string[];
  media: string[];
  busy: boolean;
  path: (id: string) => string;
  mediaInfo: (id: string) => { path: string; contentType: string };
  upload: () => void;
  camera?: () => void;
  library: () => void;
  remove: (id: string) => void;
  cover: (id: string) => void;
}) {
  const [source, setSource] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const ids = [...photos, ...media];
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {Array.from({ length: 10 }, (_, index) => {
          const id = ids[index];
          const isPhoto = !!id && photos.includes(id);
          const type = id && !isPhoto ? mediaInfo(id).contentType : "";
          return (
            <Pressable
              key={id || `add-${index}`}
              accessibilityRole="button"
              accessibilityLabel={
                id
                  ? `Manage product media ${index + 1}`
                  : `Add product media ${index + 1}`
              }
              disabled={busy}
              onPress={() => (id ? setSelected(id) : setSource(true))}
              style={{
                width: "17.8%",
                maxWidth: 84,
                minWidth: 44,
                aspectRatio: 1,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: color.border,
                backgroundColor: color.panel,
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              {id ? (
                isPhoto ? (
                  <Thumbnail path={path(id)} />
                ) : type.startsWith("audio/") ? (
                  <Music size={22} color={color.text} />
                ) : (
                  <Film size={22} color={color.text} />
                )
              ) : (
                <Plus size={21} color={color.muted} />
              )}
              {id && (
                <Pencil
                  size={11}
                  color="#FFFFFF"
                  style={{ position: "absolute", right: 5, top: 5 }}
                />
              )}
              {index === 0 && isPhoto && (
                <Text
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    textAlign: "center",
                    fontSize: 9,
                    color: "white",
                    backgroundColor: "rgba(17,13,28,0.6)",
                  }}
                >
                  Cover
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.small, { fontSize: 11 }]}>
        {ids.length}/10 media · tap + to add
      </Text>
      {source && (
        <Sheet title="Add product media" onClose={() => setSource(false)}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action
              secondary
              title="Upload"
              icon={Upload}
              disabled={busy}
              onPress={() => {
                setSource(false);
                upload();
              }}
            />
            {camera && (
              <Action
                secondary
                title="Camera"
                icon={Camera}
                disabled={busy}
                onPress={() => {
                  setSource(false);
                  camera();
                }}
              />
            )}
            <Action
              secondary
              title="Library"
              icon={Images}
              disabled={busy}
              onPress={() => {
                setSource(false);
                library();
              }}
            />
          </View>
        </Sheet>
      )}
      {selected && (
        <Sheet title="Product media" onClose={() => setSelected(null)}>
          {photos.includes(selected) ? (
            <View
              style={{
                width: "100%",
                aspectRatio: 1,
                maxHeight: 300,
                overflow: "hidden",
                borderRadius: 12,
              }}
            >
              <Thumbnail path={path(selected)} />
            </View>
          ) : (
            <StoreMediaPreview {...mediaInfo(selected)} />
          )}
          {photos.includes(selected) && photos[0] !== selected && (
            <Action
              secondary
              title="Make cover photo"
              disabled={busy}
              onPress={() => {
                cover(selected);
                setSelected(null);
              }}
            />
          )}
          <Action
            secondary
            title="Remove from listing"
            disabled={busy}
            onPress={() => {
              remove(selected);
              setSelected(null);
            }}
          />
          <Text style={styles.small}>
            Removing a preview here keeps the original file in your Ziipa
            account.
          </Text>
        </Sheet>
      )}
    </View>
  );
}
