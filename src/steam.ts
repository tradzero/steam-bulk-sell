import type { Bootstrap, InventoryPage, Review } from './types.js';

// Dynamic Steam globals are read only at this boundary. Returned data is an explicit allowlist.
// Functions sent to chrome.scripting are self-contained; they never read authentication secrets.
type SteamPage = Window & Record<string, any>;

export function inspectInventory(): Bootstrap {
  const w = window as SteamPage;
  if (location.origin !== 'https://steamcommunity.com' || !/\/(?:my|id\/[^/]+|profiles\/\d+)\/inventory\/?$/.test(location.pathname)) throw new Error('请在自己的 Steam 库存页启动');
  const account = String(w.g_steamID ?? ''), owner = String(w.UserYou?.strSteamId ?? '');
  if (!/^765\d{14}$/.test(account) || account !== owner) throw new Error('未登录、正在查看其他人的库存，或 Steam 页面结构已变化');
  const raw = w.g_rgWalletInfo;
  if (!raw || typeof w.GetCurrencyCode !== 'function' || typeof w.GetCurrencySymbol !== 'function') throw new Error('钱包货币信息尚未就绪，请等待 Steam 库存加载后重试');
  const code = String(w.GetCurrencyCode(raw.wallet_currency));
  const publisherRate = Number(raw.wallet_publisher_fee_percent_default ?? 0.10);
  const contexts = Object.entries(w.g_rgAppContextData ?? {}).flatMap(([appid, value]) => {
    const app = value as Record<string, any>;
    if (!/^\d+$/.test(appid)) return [];
    return Object.entries(app.rgContexts ?? {}).flatMap(([contextid, c]) => {
      const context = c as Record<string, any>;
      if (!/^\d+$/.test(contextid) || contextid === '0' || (appid === '753' && contextid === '4')) return [];
      return [{appid, contextid, name: `${String(app.name ?? appid).slice(0, 150)} · ${String(context.name ?? contextid).slice(0, 100)}`,
        count: Number(context.asset_count ?? 0), publisherRate: Number(app.market_pubfee_rate ?? publisherRate)}];
    });
  });
  if (!contexts.length) throw new Error('未找到可读取的库存上下文');
  return {account, contexts, wallet: {currency: Number(raw.wallet_currency), code, symbol: String(w.GetCurrencySymbol(code)),
    minimum: Number(raw.wallet_market_minimum ?? 1), increment: Number(raw.wallet_currency_increment ?? 1),
    steamRate: Number(raw.wallet_fee_percent ?? 0.05), publisherRate}};
}

export function inspectAccount(expected: string): boolean {
  const w = window as SteamPage;
  return location.origin === 'https://steamcommunity.com' && String(w.g_steamID ?? '') === expected && String(w.UserYou?.strSteamId ?? '') === expected;
}

// Runs in ISOLATED world: page scripts cannot replace this fetch implementation.
export async function fetchInventoryPage(account: string, appid: string, contextid: string, cursor: string): Promise<InventoryPage> {
  if (location.origin !== 'https://steamcommunity.com' || !/\/inventory\/?$/.test(location.pathname) || !/^765\d{14}$/.test(account) || !/^\d+$/.test(appid) || !/^\d+$/.test(contextid) || (cursor && !/^\d+$/.test(cursor))) throw new Error('库存请求参数无效');
  const url = new URL(`/inventory/${account}/${appid}/${contextid}`, location.origin);
  url.searchParams.set('l', 'schinese'); url.searchParams.set('count', '2000');
  if (cursor) url.searchParams.set('start_assetid', cursor);
  const response = await fetch(url, {method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000)});
  if (response.status === 429) throw new Error('Steam 限流（429），请稍后手动重试；不会自动反复请求');
  if (!response.ok) throw new Error(`读取库存失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (data.success !== 1 && data.success !== true) throw new Error('Steam 未成功返回库存');
  if (!Number.isSafeInteger(data.total_inventory_count) || data.total_inventory_count < 0) throw new Error('库存响应缺少可靠的总量');
  if (data.total_inventory_count === 0 && !data.assets?.length) return {records: [], total: 0, more: false, cursor: ''};
  if (!Array.isArray(data.assets) || !Array.isArray(data.descriptions)) throw new Error('库存响应结构已变化');
  const descriptions = new Map<string, Record<string, any>>();
  for (const d of data.descriptions) descriptions.set(`${d.classid}_${d.instanceid ?? '0'}`, d);
  const records = data.assets.map((a: Record<string, any>) => {
    if (String(a.appid) !== appid || String(a.contextid) !== contextid) throw new Error('库存返回了不同游戏或上下文的资产');
    const d = descriptions.get(`${a.classid}_${a.instanceid ?? '0'}`);
    if (!d) throw new Error('库存物品描述不完整，请重新加载');
    const hashName = typeof d.market_hash_name === 'string' ? d.market_hash_name : '';
    return {assetid: String(a.assetid), amount: Number(a.amount), hashName,
      name: String(d.name ?? hashName).slice(0, 512), type: String(d.type ?? '其他').slice(0, 200),
      icon: typeof d.icon_url === 'string' && /^[\w/-]+$/.test(d.icon_url) ? d.icon_url.slice(0, 2048) : '',
      commodity: Number(d.commodity) === 1, marketable: Number(d.marketable) === 1};
  });
  if (![undefined, 0, 1, false, true].includes(data.more_items)) throw new Error('无法识别库存分页状态');
  return {records, more: Boolean(data.more_items), cursor: data.more_items ? String(data.last_assetid ?? '') : '', total: data.total_inventory_count};
}

export async function fetchReference(appid: string, currency: number, hashName: string): Promise<string> {
  if (location.origin !== 'https://steamcommunity.com' || !/\/inventory\/?$/.test(location.pathname) || !/^\d+$/.test(appid) || !Number.isSafeInteger(currency) || currency <= 0 || typeof hashName !== 'string' || !hashName || hashName.length > 512) throw new Error('参考价请求参数无效');
  const url = new URL('/market/priceoverview/', location.origin);
  url.searchParams.set('appid', appid); url.searchParams.set('currency', String(currency)); url.searchParams.set('market_hash_name', hashName);
  const response = await fetch(url, {method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000)});
  if (response.status === 429) throw new Error('Steam 参考价请求限流（429），请稍后再试');
  if (!response.ok) throw new Error(`获取参考价失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (!data.success || typeof data.lowest_price !== 'string') throw new Error('Steam 暂无最低在售价，可手动输入到手价并核对');
  return data.lowest_price;
}

export type NativeResult = {state: 'loading' | 'filled'; message: string};
export function fillNative(review: Review): NativeResult {
  const w = window as SteamPage;
  const must = (v: unknown, message: string) => { if (!v) throw new Error(message); };
  must(location.origin === 'https://steamcommunity.com' && /^\/market\/multisell\/?$/.test(location.pathname), '交接目标不是 Steam 原生批量出售页');
  must(String(w.g_steamID ?? '') === review.account && String(w.UserYou?.strSteamId ?? '') === review.account, 'Steam 账户已变化，已停止填充');
  must(!w.g_bSellInProgress, 'Steam 已开始处理上架，本插件不会修改正在执行的清单');
  must(Date.now() - review.createdAt <= 120_000, '核对单已过期，请返回工作台重新核对');
  const zero = () => { document.querySelectorAll<HTMLInputElement>('input.market_multi_quantity').forEach(e => { e.value = '0'; }); };
  const names: unknown = w.g_rgMarketHashNames, ids: unknown = w.g_rgItemNameIds;
  must(String(w.g_unAppId) === review.context.appid && String(w.g_ulContextId) === review.context.contextid, 'Steam 游戏或库存上下文不匹配');
  must(Array.isArray(names) && Array.isArray(ids) && names.length === review.rows.length && ids.length === names.length, 'Steam 原生表格结构已变化，已停止填充');
  const hashNames = names as string[], nameIds = ids as (number | string)[];
  must(new Set(hashNames).size === hashNames.length && review.rows.every(r => hashNames.includes(r.hashName)), 'Steam 原生物品名称与核对单不一致');
  const controls = review.rows.map(r => {
    const id = String(nameIds[hashNames.indexOf(r.hashName)]);
    must(/^\d+$/.test(id), 'Steam 原生物品编号异常');
    const qty = document.getElementById(`sell_${id}_qty`), recv = document.getElementById(`sell_${id}_price_recv`), paid = document.getElementById(`sell_${id}_price_paid`);
    must(qty instanceof HTMLInputElement && recv instanceof HTMLInputElement && paid instanceof HTMLInputElement, 'Steam 价格或数量输入框无法识别');
    return {r, qty: qty as HTMLInputElement, recv: recv as HTMLInputElement, paid: paid as HTMLInputElement};
  });
  // Zero all target rows first. Failed checks must never leave a partly filled sale plan.
  controls.forEach(c => { c.qty.value = '0'; }); zero();
  try {
    const inv = w.UserYou?.getInventory?.(review.context.appid, review.context.contextid);
    must(inv && typeof inv.BIsFullyLoaded === 'function', 'Steam 原生库存结构已变化');
    if (!inv.BIsFullyLoaded()) return {state: 'loading', message: '等待 Steam 原生页面完整加载库存…'};
    const wallet = w.g_rgWalletInfo;
    must(wallet && Number(wallet.wallet_currency) === review.wallet.currency, '钱包货币已变化');
    for (const fn of ['GetTotalWithFees', 'GetPriceValueAsInt', 'GetCurrencyCode', 'v_currencyformat', 'PriceRecvChanged', 'UpdateOrderTotal', '$J']) must(typeof w[fn] === 'function', 'Steam 费用或表单函数已变化');
    must(String(w.GetCurrencyCode(wallet.wallet_currency)) === review.wallet.code, '钱包货币代码不匹配');
    const totals = new Map<string, number>();
    for (const asset of Object.values(inv.m_rgAssets ?? {}) as Record<string, any>[]) {
      const key = String(asset.classid) + (asset.instanceid && String(asset.instanceid) !== '0' ? `_${asset.instanceid}` : '');
      const d = inv.m_rgDescriptions?.[key] ?? asset.description;
      must(d, 'Steam 原生库存描述缺失');
      if (!hashNames.includes(d.market_hash_name) || !Number(d.marketable)) continue;
      must(Number(d.commodity) === 1, '库存中存在具有独立属性的同名物品，首版拒绝交接');
      const amount = Number(asset.amount); must(Number.isSafeInteger(amount) && amount >= 0, '库存数量异常');
      totals.set(d.market_hash_name, (totals.get(d.market_hash_name) ?? 0) + amount);
    }
    for (const c of controls) {
      must(Number.isSafeInteger(c.r.quantity) && c.r.quantity > 0 && c.r.quantity <= (totals.get(c.r.hashName) ?? 0), '库存数量已变化，请返回工作台重新加载');
      must(Number.isSafeInteger(c.r.receive) && c.r.receive > 0, '核对单价格无效');
      const nativePaid = w.GetTotalWithFees(c.r.receive, Number(wallet.wallet_publisher_fee_percent_default ?? 0.10), Number(wallet.wallet_fee_percent ?? 0.05), wallet);
      must(nativePaid === c.r.paid, 'Steam 原生费用与核对单不同，已停止交接，请在 Steam 手动核对');
    }
    for (const c of controls) {
      c.recv.value = String(w.v_currencyformat(c.r.receive, review.wallet.code));
      w.PriceRecvChanged(w.$J(c.recv));
      must(w.GetPriceValueAsInt(c.recv.value) === c.r.receive && w.GetPriceValueAsInt(c.paid.value) === c.r.paid, 'Steam 价格取整发生变化，已停止交接');
    }
    controls.forEach(c => { c.qty.value = String(c.r.quantity); });
    must(w.UpdateOrderTotal() === true, 'Steam 原生表单未通过校验');
    let banner = document.getElementById('steam-bulk-local-handoff');
    if (!banner) { banner = document.createElement('div'); banner.id = 'steam-bulk-local-handoff'; (document.querySelector('main') ?? document.body).prepend(banner); }
    banner.textContent = `本地工作台已填入 ${review.rows.length} 种 / ${review.totalQuantity} 件。尚未提交。请再次核对下方数量、单价与总额，再自行点击 Steam 的“创建上架物品”。刷新本页会失去这份填充值。`;
    banner.setAttribute('role', 'status');
    Object.assign(banner.style, {padding: '18px', margin: '12px 0', background: '#183c50', color: '#e5f5ff', border: '1px solid #66c0f4', borderRadius: '4px'});
    return {state: 'filled', message: '已填入 Steam 原生页面，尚未提交。'};
  } catch (error) {
    controls.forEach(c => { c.qty.value = '0'; }); zero();
    if (typeof w.UpdateOrderTotal === 'function') w.UpdateOrderTotal();
    throw error;
  }
}
