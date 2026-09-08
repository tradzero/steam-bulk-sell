import type { Inventory, InventoryPage, Context, Wallet, Selection, Reference, Review } from './types.js';

export const ORIGIN = 'https://steamcommunity.com';
export const PRICE_TTL = 5 * 60_000;
export const REVIEW_TTL = 2 * 60_000;
export const SESSION_TTL = 2 * 60 * 60_000;
export const MAX_KINDS = 25;
export const MAX_UNITS = 200;
export const referenceKey = (hashName: string): string => `item:${hashName}`;
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function isSteamPage(raw?: string): boolean {
  try {
    const u = new URL(raw ?? '');
    return u.origin === ORIGIN && !u.username && !u.password &&
      (/^\/market(?:\/|$)/.test(u.pathname) || /^\/(?:my|id\/[^/]+|profiles\/\d+)\/inventory\/?$/.test(u.pathname));
  } catch { return false; }
}
export function isInventoryPage(raw: string): boolean {
  return isSteamPage(raw) && /\/inventory\/?$/.test(new URL(raw).pathname);
}
export function integer(n: unknown, min: number, max: number, name: string): number {
  assert(typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max, `${name}无效`);
  return n;
}
export function validateWallet(w: Wallet): void {
  integer(w.currency, 1, 1000, '钱包货币');
  assert(/^[A-Z]{3}$/.test(w.code) && typeof w.symbol === 'string' && w.symbol.length < 20, '无法识别钱包货币');
  integer(w.minimum, 1, 1_000_000, '最小价格');
  integer(w.increment, 1, 1_000_000, '价格步长');
  for (const n of [w.steamRate, w.publisherRate]) assert(Number.isFinite(n) && n >= 0 && n <= 1, '无法识别费用配置');
}
export function normalizedPrice(n: number, w: Wallet): number {
  if (n <= w.minimum) return w.minimum;
  if (n <= w.increment) return w.increment;
  return w.increment > 1 ? Math.round(n / w.increment) * w.increment : n;
}
export function buyerPays(receive: number, w: Wallet): number {
  const fee = (rate: number) => rate > 0 ? normalizedPrice(Math.floor(receive * rate), w) : 0;
  return normalizedPrice(receive, w) + fee(w.publisherRate) + fee(w.steamRate);
}
// Mirrors Steam's current total-to-base search. Native handoff checks both amounts again.
export function sellerReceives(total: number, w: Wallet): number {
  let base = normalizedPrice(Math.min(Math.floor(total / (1 + w.publisherRate + w.steamRate)), total - 2 * w.minimum), w);
  for (let i = 0; i < 3; i++) {
    const actual = buyerPays(base, w);
    if (actual === total) return base;
    if (actual < total) base += w.increment;
    else { base -= w.increment; break; }
  }
  return Math.max(w.minimum, base);
}
export function moneyInput(value: string): number {
  const s = value.trim();
  assert(/^\d+(?:[.,]\d{1,2})?$/.test(s), '金额只接受数字和最多两位小数，请勿输入货币符号或千位分隔符');
  const [whole = '', fraction = ''] = s.replace(',', '.').split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 1, 1_000_000_000, '价格');
}
// One price only. Never concatenate the buyer/seller numbers from Market Beta DOM text.
export function parseReference(raw: string, w: Wallet): number {
  assert(typeof raw === 'string' && raw.length < 100, 'Steam 未返回有效参考价');
  let s = raw.replace(/[\s\u00a0\u202f]/g, '');
  for (const symbol of [w.symbol.replace(/\s/g, ''), w.code]) {
    if (symbol && s.startsWith(symbol)) s = s.slice(symbol.length);
    if (symbol && s.endsWith(symbol)) s = s.slice(0, -symbol.length);
  }
  s = s.replace(/\.--$/, '.00');
  assert(/^\d[\d.,]*$/.test(s), '参考价格式无法安全识别，请手动定价');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  const last = Math.max(lastDot, lastComma);
  if (last < 0) return integer(Number(s) * 100, 1, 1_000_000_000, '参考价');
  const tail = s.slice(last + 1);
  if (tail.length === 3 && !(lastDot >= 0 && lastComma >= 0)) {
    assert(/^\d{1,3}([.,]\d{3})+$/.test(s), '参考价千位分组异常');
    return integer(Number(s.replace(/[.,]/g, '')) * 100, 1, 1_000_000_000, '参考价');
  }
  assert(tail.length === 1 || tail.length === 2, '参考价小数位异常');
  const head = s.slice(0, last), sep = s[last] === '.' ? ',' : '.';
  assert(!head.includes(s[last]!) && (head.includes(sep) ? /^\d{1,3}([.,]\d{3})+$/.test(head) : /^\d+$/.test(head)), '参考价含有多个金额或异常分隔符');
  return integer(Number(head.replace(/[.,]/g, '')) * 100 + Number(tail.padEnd(2, '0')), 1, 1_000_000_000, '参考价');
}
export function mergePage(previous: Inventory | undefined, page: InventoryPage, context: Context, now: number): Inventory {
  integer(page.total, 0, 20_000, '库存总量');
  if (previous) {
    assert(!previous.complete && previous.context.appid === context.appid && previous.context.contextid === context.contextid, '库存加载状态不一致');
    assert(previous.total === page.total, '库存数量在加载期间发生变化，请重新加载');
  }
  const inv: Inventory = previous ? structuredClone(previous) : {context, groups: [], seen: [], excluded: 0, total: page.total, cursor: '', complete: false, loadedAt: 0};
  const seen = new Set(inv.seen), groups = new Map(inv.groups.map(g => [g.hashName, g]));
  for (const r of page.records) {
    assert(/^\d+$/.test(r.assetid) && !seen.has(r.assetid), '库存分页出现重复或无效资产，请重新加载');
    integer(r.amount, 1, 1_000_000_000, '物品数量');
    seen.add(r.assetid);
    if (!r.marketable || !r.commodity) { inv.excluded++; continue; }
    assert(r.hashName.length > 0 && r.hashName.length <= 512, '缺少可靠的市场名称');
    const g = groups.get(r.hashName) ?? {hashName: r.hashName, name: r.name, type: r.type, icon: r.icon, owned: 0};
    g.owned += r.amount; groups.set(r.hashName, g);
  }
  assert(seen.size <= 20_000, '首版最多读取 20,000 个库存资产');
  if (page.more) assert(/^\d+$/.test(page.cursor) && page.cursor !== previous?.cursor && page.records.length > 0, '库存分页游标异常');
  else assert(seen.size === page.total, '库存未完整返回，请重新加载后再准备出售');
  inv.seen = [...seen]; inv.groups = [...groups.values()]; inv.cursor = page.cursor;
  inv.complete = !page.more; inv.loadedAt = now;
  return inv;
}
export function buildReview(inv: Inventory, selection: Selection[], account: string, wallet: Wallet, references: Record<string, Reference>, now: number, id: string): Review {
  assert(inv.complete, '库存尚未完整加载'); validateWallet(wallet);
  assert(Array.isArray(selection) && selection.length > 0 && selection.length <= MAX_KINDS, `每批请选择 1–${MAX_KINDS} 种物品`);
  const groups = new Map(inv.groups.map(g => [g.hashName, g])), names = new Set<string>();
  const rows = selection.map(s => {
    assert(s && typeof s.hashName === 'string' && !names.has(s.hashName), '清单包含重复或无效物品'); names.add(s.hashName);
    const g = groups.get(s.hashName); assert(g, '所选物品不在本次可出售库存中');
    integer(s.quantity, 1, g.owned, '出售数量'); integer(s.receive, 1, 1_000_000_000, '到手单价');
    assert(normalizedPrice(s.receive, wallet) === s.receive, '价格不符合 Steam 当前最小金额或步长');
    const paid = buyerPays(s.receive, wallet), reference = references[referenceKey(s.hashName)];
    const warnings: string[] = [];
    if (!reference) warnings.push('缺少参考价：请自行核对市场');
    else if (now - reference.fetchedAt > PRICE_TTL) warnings.push('参考价超过 5 分钟：请重新获取或自行核对');
    else if (paid < reference.paid * 0.8) warnings.push('买方支付低于参考价 20% 以上');
    return {...s, name: g.name, owned: g.owned, paid, reference, warning: warnings.join('；')};
  });
  const totalQuantity = rows.reduce((n, r) => n + r.quantity, 0);
  assert(totalQuantity <= MAX_UNITS, `首版每批最多 ${MAX_UNITS} 件，请拆分清单`);
  return {id, createdAt: now, account, wallet, context: inv.context, rows, totalQuantity,
    totalReceive: rows.reduce((n, r) => n + r.receive * r.quantity, 0), totalPaid: rows.reduce((n, r) => n + r.paid * r.quantity, 0)};
}
export function multisellURL(review: Review): string {
  assert(/^\d+$/.test(review.context.appid) && /^\d+$/.test(review.context.contextid), '库存上下文无效');
  const url = new URL('/market/multisell', ORIGIN);
  url.searchParams.set('appid', review.context.appid); url.searchParams.set('contextid', review.context.contextid);
  for (const row of review.rows) url.searchParams.append('items[]', row.hashName);
  assert(url.href.length <= 7000, '物品名称过长，请减少每批种类');
  return url.href;
}
