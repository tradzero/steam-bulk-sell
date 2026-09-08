import type { Session, AssetRecord, PublicSession } from './types.js';
import { mergePage, buildReview, referenceKey } from './core.js';

const context = {appid: '730', contextid: '2', name: 'Counter-Strike 2 · 库存', count: 70, publisherRate: 0.10};
let session: Session = {id: 'demo', sourceTabId: 0, createdAt: Date.now(), updatedAt: Date.now(), references: {}, draft: [], nextPriceAt: 0,
  bootstrap: {account: '76561198000000000', contexts: [context], wallet: {currency: 23, code: 'CNY', symbol: '¥', minimum: 1, increment: 1, steamRate: .05, publisherRate: .10}}};
const items = [
  {name: '梦魇武器箱', hash: 'Dreams & Nightmares Case', type: '武器箱', owned: 20, paid: 1144},
  {name: '变革武器箱', hash: 'Revolution Case', type: '武器箱', owned: 12, paid: 211},
  {name: '热潮武器箱', hash: 'Fever Case', type: '武器箱', owned: 8, paid: 606},
  {name: '幻彩 3 号武器箱', hash: 'Chroma 3 Case', type: '武器箱', owned: 4, paid: 3323},
  {name: '纪念胶囊（演示）', hash: 'Demo Capsule', type: '胶囊', owned: 9, paid: 230},
  {name: '纪念贴纸（演示）', hash: 'Demo Sticker', type: '贴纸', owned: 14, paid: 115}
];
function snapshot(): PublicSession { return structuredClone(session); }
export async function demoRequest(m: Record<string, unknown>): Promise<unknown> {
  await new Promise(resolve => setTimeout(resolve, 100));
  switch (m.type) {
    case 'state': case 'bootstrap': return snapshot();
    case 'inventory': {
      let id = 1; const records: AssetRecord[] = [];
      for (const item of items) for (let n = 0; n < item.owned; n++) records.push({assetid: String(id++), amount: 1, hashName: item.hash, name: item.name, type: item.type, icon: '', commodity: true, marketable: true});
      for (let n = 0; n < 3; n++) records.push({assetid: String(id++), amount: 1, hashName: `Excluded ${n}`, name: '非同质皮肤', type: '皮肤', icon: '', commodity: false, marketable: true});
      session.inventory = mergePage(undefined, {records, total: records.length, cursor: '', more: false}, context, Date.now()); session.references = {}; session.draft = []; session.review = undefined;
      return snapshot();
    }
    case 'reference': {
      const item = items.find(i => i.hash === m.hashName); if (!item) throw new Error('演示物品不存在');
      const ref = {paid: item.paid, fetchedAt: Date.now()}; session.references[referenceKey(item.hash)] = ref; return ref;
    }
    case 'draft': session.draft = m.rows as Session['draft']; return true;
    case 'review': session.review = buildReview(session.inventory!, m.rows as Session['draft'], session.bootstrap!.account, session.bootstrap!.wallet, session.references, Date.now(), 'demo-review'); return structuredClone(session.review);
    case 'handoff': session.handoff = {url: '', filled: false, reviewId: 'demo-review'}; return session.handoff;
    case 'native': session.handoff!.filled = true; return {state: 'filled', message: '演示交接结束；没有打开 Steam 或填写真实表单。'};
    case 'focus': return true;
    case 'clear': session = {...session, inventory: undefined, draft: [], references: {}, handoff: undefined, review: undefined}; return true;
    default: throw new Error('不支持的演示操作');
  }
}
