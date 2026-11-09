import { Alert, Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

type PickedAsset = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
};
type Result = { canceled: boolean; assets: PickedAsset[] };
export const maxCreationPhotos = 10;

/** Web keeps its direct user gesture; phones offer Photos separately from Files. */
export async function pickCreatorMedia(
  types: string[],
  library: "images" | "media" | false = "media",
  isCurrent: () => boolean = () => true,
  photoSeries = false,
): Promise<Result> {
  const canceled = (): Result => ({ canceled: true, assets: [] });
  if (!isCurrent()) return canceled();
  if (Platform.OS === "web" || library === false)
    return DocumentPicker.getDocumentAsync({
      type: types,
      copyToCacheDirectory: true,
      multiple: photoSeries,
    }).then((result) =>
      !isCurrent()
        ? canceled()
        : {
            canceled: result.canceled,
            assets: result.assets || [],
          },
    );

  const source = await new Promise<"photos" | "files" | null>((resolve) => {
    Alert.alert(
      "Choose media",
      "",
      [
        {
          text: library === "images" ? "Photo library" : "Photos & videos",
          onPress: () => resolve("photos"),
        },
        { text: "Files", onPress: () => resolve("files") },
        { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
  if (!source || !isCurrent()) return canceled();
  if (source === "files") {
    const result = await DocumentPicker.getDocumentAsync({
      type: types,
      copyToCacheDirectory: true,
      multiple: photoSeries,
    });
    return !isCurrent()
      ? canceled()
      : { canceled: result.canceled, assets: result.assets || [] };
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: library === "images" ? ["images"] : ["images", "videos"],
    allowsEditing: false,
    allowsMultipleSelection: photoSeries,
    ...(photoSeries && { selectionLimit: maxCreationPhotos, orderedSelection: true }),
    quality: 1,
    exif: false,
    base64: false,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    // A compatible exported copy avoids the iOS original-video/Passthrough
    // permission requirement; the user selects only the item to share.
    videoExportPreset: ImagePicker.VideoExportPreset.HighestQuality,
  });
  if (!isCurrent() || result.canceled || !result.assets.length)
    return canceled();
  return {
    canceled: false,
    assets: result.assets.map((asset) => ({
      uri: asset.uri,
      name:
        asset.fileName ||
        asset.uri.split("/").pop()?.split("?")[0] ||
        (asset.type === "video" ? "ziipa-video.mp4" : "ziipa-photo.jpg"),
      mimeType: asset.mimeType,
      size: asset.fileSize,
    })),
  };
}
