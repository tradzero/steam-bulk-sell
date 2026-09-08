export interface Wallet {
  currency: number; code: string; symbol: string; minimum: number; increment: number;
  steamRate: number; publisherRate: number;
}
export interface Context { appid: string; contextid: string; name: string; count: number; publisherRate: number }
export interface Bootstrap { account: string; contexts: Context[]; wallet: Wallet }
export interface AssetRecord {
  assetid: string; amount: number; hashName: string; name: string; type: string;
  icon: string; marketable: boolean; commodity: boolean;
}
export interface InventoryPage { records: AssetRecord[]; more: boolean; cursor: string; total: number }
export interface Group {
  hashName: string; name: string; type: string; icon: string; owned: number;
}
export interface Inventory {
  context: Context; groups: Group[]; seen: string[]; excluded: number;
  total: number; cursor: string; complete: boolean; loadedAt: number;
}
export interface Reference { paid: number; fetchedAt: number }
export interface Selection { hashName: string; quantity: number; receive: number }
export interface ReviewRow extends Selection {
  name: string; owned: number; paid: number; reference?: Reference; warning: string;
}
export interface Review {
  id: string; createdAt: number; account: string; wallet: Wallet; context: Context;
  rows: ReviewRow[]; totalQuantity: number; totalReceive: number; totalPaid: number;
}
export interface Session {
  id: string; sourceTabId: number; uiTabId?: number; createdAt: number; updatedAt: number;
  bootstrap?: Bootstrap; inventory?: Inventory; references: Record<string, Reference>;
  draft: Selection[]; review?: Review; handoff?: {url: string; reviewId: string; filled: boolean};
  nextPriceAt: number;
}
export interface PublicSession {
  id: string; bootstrap?: Bootstrap;
  inventory?: Omit<Inventory, 'seen'>; references: Record<string, Reference>;
  draft: Selection[]; review?: Review; handoff?: Session['handoff'];
}
export interface Reply { ok: boolean; data?: unknown; error?: string }
