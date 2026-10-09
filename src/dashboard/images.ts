export async function compressChatImage(file: File): Promise<{ name: string; dataUrl: string }> {
  if (!file.type.startsWith("image/")) throw new Error("Só é possível anexar imagens.");
  if (file.size > 12_000_000) throw new Error("Imagem demasiado grande (máx. 12 MB).");
  const bitmap = await createImageBitmap(file);
  try {
    const max = 1280;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Não foi possível processar a imagem.");
    ctx.drawImage(bitmap, 0, 0, w, h);
    let dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    if (dataUrl.length > 900_000) dataUrl = canvas.toDataURL("image/jpeg", 0.68);
    if (dataUrl.length > 1_200_000) throw new Error("Imagem demasiado grande depois da compressão.");
    const base = file.name.replace(/\.[^.]+$/, "").slice(0, 48) || "imagem";
    return { name: `${base}.jpg`, dataUrl };
  } finally {
    bitmap.close();
  }
}
