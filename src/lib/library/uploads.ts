import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";

const receipt = z.object({ id: z.string().uuid(), name: z.string(), createdAt: z.string(), documentId: z.string().uuid().optional() });
const receipts = z.array(receipt).max(200);
const indexKey = (owner: string) => `library-uploads/${z.string().uuid().parse(owner)}.json`;
export async function rememberUpload(owner: string, item: z.infer<typeof receipt>) {
  return mutateStoreText(indexKey(owner), text => {
    const rows = text ? receipts.parse(JSON.parse(text)) : [];
    const previous = rows.find(row => row.id === item.id);
    const next = [previous ? { ...previous, ...item, createdAt: previous.createdAt } : item, ...rows.filter(row => row.id !== item.id)].slice(0, 200);
    return { text: JSON.stringify(next), result: undefined };
  });
}
export async function listUploadReceipts(owner: string) {
  const text = await readStoreText(indexKey(owner));
  return text ? receipts.parse(JSON.parse(text)) : [];
}
export async function listPendingUploads(owner: string) {
  const rows = await listUploadReceipts(owner);
  return (await Promise.all(rows.filter(row => !row.documentId).slice(0, 30).map(async row => {
    const raw = await readStoreText(`dialogue-uploads/${owner}/${row.id}.json`);
    if (!raw) return null;
    const metadata = JSON.parse(raw) as { status?: string; mime?: string };
    return { ...row, status: metadata.status ?? "queued", mime: metadata.mime ?? "application/octet-stream" };
  }))).filter(row => row !== null);
}
