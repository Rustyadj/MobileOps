// Hand a downloaded file to the user: a normal browser download on web, the system share sheet on native.
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(blob);
  });

export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return;
  }
  const directory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!directory) throw new Error("A writable folder is not available on this device.");
  const path = `${directory}${filename.replace(/[^\w.\-]+/g, "_")}`;
  await FileSystem.writeAsStringAsync(path, await blobToBase64(blob), { encoding: FileSystem.EncodingType.Base64 });
  if (!(await Sharing.isAvailableAsync())) throw new Error("File sharing is not available on this device.");
  await Sharing.shareAsync(path, { mimeType: blob.type || undefined, dialogTitle: filename });
}
