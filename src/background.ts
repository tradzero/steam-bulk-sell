import type { Session, PublicSession, Selection, Context, Wallet } from './types.js';
import { ORIGIN, SESSION_TTL, REVIEW_TTL, PRICE_TTL, assert, integer, isSteamPage, isInventoryPage, validateWallet, mergePage, parseReference, referenceKey, buildReview, multisellURL } from './core.js';
import { inspectInventory, inspectAccount, fetchInventoryPage, fetchReference, fillNative } from './steam.js';

const key = (id: string) => `session:${id}`;
const locks = new Set<string>();
const save = (s: Session) => { s.updatedAt = Date.now(); return chrome.storage.session.set({[key(s.id)]: s}); };
function publicSession(s: Session): PublicSession {
  const inventory = s.inventory ? {...s.inventory} : undefined;
  if (inventory) inventory.seen = [];
  return {id: s.id, bootstrap: s.bootstrap, inventory, references: s.references, draft: s.draft, review: s.review, handoff: s.handoff};
}
async function cleanExpired() {
  const all = await chrome.storage.session.get(null);
  const expired = Object.keys(all).filter(k => k.startsWith('session:') && Date.now() - Number(all[k]?.updatedAt ?? 0) > SESSION_TTL);
  if (expired.length) await chrome.storage.session.remove(expired);
}
chrome.runtime.onInstalled.addListener(() => { void chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}); });
chrome.action.onClicked.addListener(tab => {
  void (async () => {
    if (!tab.id || !isSteamPage(tab.url)) {
      await chrome.action.setBadgeText({text: '!'});
      await chrome.action.setTitle({title: '请先打开 Steam 社区市场或自己的库存，再点击本扩展'});
      return;
    }
    await chrome.action.setBadgeText({text: ''});
    await chrome.action.setTitle({title: '打开 Steam 批量出售工作台'});
    await cleanExpired();
    const existing = Object.values(await chrome.storage.session.get(null)).find((s: Session) => s.sourceTabId === tab.id) as Session | undefined;
    if (existing && !(existing.handoff && isInventoryPage(tab.url!))) {
      if (!existing.handoff && !isInventoryPage(tab.url!)) await chrome.tabs.update(tab.id, {url: `${ORIGIN}/my/inventory/`});
      if (existing.uiTabId !== undefined) {
        const oldUI = await chrome.tabs.get(existing.uiTabId).catch(() => undefined);
        if (oldUI?.url === chrome.runtime.getURL(`ui.html#${existing.id}`)) { await chrome.tabs.update(existing.uiTabId, {active: true}); return; }
      }
      const reopened = await chrome.tabs.create({url: chrome.runtime.getURL(`ui.html#${existing.id}`)});
      existing.uiTabId = reopened.id; await save(existing); return;
    }
    if (existing) await chrome.storage.session.remove(key(existing.id));
    const id = crypto.randomUUID(), now = Date.now();
    const session: Session = {id, sourceTabId: tab.id, createdAt: now, updatedAt: now, references: {}, draft: [], nextPriceAt: 0};
    await save(session);
    if (!isInventoryPage(tab.url!)) await chrome.tabs.update(tab.id, {url: `${ORIGIN}/my/inventory/`});
    const ui = await chrome.tabs.create({url: chrome.runtime.getURL(`ui.html#${id}`)});
    session.uiTabId = ui.id; await save(session);
  })().catch(async () => { await chrome.action.setBadgeText({text: '!'}); await chrome.action.setTitle({title: '启动失败，请在 Steam 库存页重新点击扩展'}); });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('session:') && all[k]?.sourceTabId === tabId);
    if (keys.length) await chrome.storage.session.remove(keys);
  })();
});

async function execute<T, A extends unknown[]>(tabId: number, func: (...args: A) => T | Promise<T>, args: A, world: 'MAIN' | 'ISOLATED' = 'MAIN'): Promise<T> {
  const results = await chrome.scripting.executeScript({target: {tabId}, world, func, args});
  const result = results.find(r => r.frameId === 0);
  assert(result && result.result !== undefined && result.result !== null, '无法读取 Steam 页面，请切回库存页重新点击扩展授权');
  return result.result as T;
}
async function source(s: Session, inventoryOnly = true) {
  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(s.sourceTabId); } catch { throw new Error('原 Steam 标签页已关闭，请重新启动工作台'); }
  assert(tab.url && isSteamPage(tab.url), 'Steam 标签页已离开支持的页面，请在库存页重新点击扩展');
  if (inventoryOnly) assert(isInventoryPage(tab.url), '原标签页已进入出售页面；请打开自己的库存并重新点击扩展开始下一批');
  return tab;
}
async function account(s: Session) {
  await source(s);
  assert(s.bootstrap, '请先读取库存上下文');
  assert(await execute(s.sourceTabId, inspectAccount, [s.bootstrap.account]), 'Steam 账户已变化，请重新启动工作台');
}
function contextWallet(s: Session): Wallet {
  assert(s.bootstrap && s.inventory, '请先加载库存');
  const w = {...s.bootstrap.wallet, publisherRate: s.inventory.context.publisherRate}; validateWallet(w); return w;
}
async function dispatch(s: Session, message: Record<string, unknown>): Promise<unknown> {
  switch (message.type) {
    case 'state': return publicSession(s);
    case 'bootstrap': {
      const tab = await source(s); assert(tab.status === 'complete', 'Steam 库存页仍在加载，请稍候重试');
      const b = await execute(s.sourceTabId, inspectInventory, []);
      validateWallet(b.wallet);
      assert(b.contexts.length <= 2000 && b.contexts.every(c => /^\d+$/.test(c.appid) && /^\d+$/.test(c.contextid) && Number.isSafeInteger(c.count) && c.count >= 0 && Number.isFinite(c.publisherRate) && c.publisherRate >= 0 && c.publisherRate <= 1), '库存上下文数据异常');
      if (s.bootstrap && s.bootstrap.account !== b.account) { s.inventory = undefined; s.references = {}; s.draft = []; s.review = undefined; }
      s.bootstrap = b; await save(s); return publicSession(s);
    }
    case 'inventory': {
      await account(s); assert(!s.handoff, '本批已进入原生交接流程，请重新启动下一批');
      const appid = String(message.appid), contextid = String(message.contextid);
      const context: Context | undefined = s.bootstrap!.contexts.find(c => c.appid === appid && c.contextid === contextid);
      assert(context, '所选库存不属于当前账户上下文');
      if (message.reset === true) { s.inventory = undefined; s.references = {}; s.draft = []; s.review = undefined; await save(s); }
      const previous = s.inventory;
      if (previous) assert(!previous.complete && previous.context.appid === appid && previous.context.contextid === contextid, '请重新加载所选库存');
      const page = await execute(s.sourceTabId, fetchInventoryPage, [s.bootstrap!.account, appid, contextid, previous?.cursor ?? ''], 'ISOLATED');
      s.inventory = mergePage(previous, page, context, Date.now()); await save(s); return publicSession(s);
    }
    case 'reference': {
      await account(s); assert(s.inventory?.complete && !s.handoff, '请先完整加载库存');
      const name = String(message.hashName);
      assert(s.inventory.groups.some(g => g.hashName === name), '物品不在当前同质库存中');
      const now = Date.now(); assert(now >= s.nextPriceAt, `请求间隔保护：请等待 ${Math.ceil((s.nextPriceAt - now) / 1000)} 秒`);
      s.nextPriceAt = now + 1600; await save(s);
      try {
        const raw = await execute(s.sourceTabId, fetchReference, [s.inventory.context.appid, s.bootstrap!.wallet.currency, name], 'ISOLATED');
        const ref = {paid: parseReference(raw, contextWallet(s)), fetchedAt: Date.now()};
        s.references[referenceKey(name)] = ref; s.review = undefined; await save(s); return ref;
      } catch (error) {
        if (String(error).includes('429')) { s.nextPriceAt = Date.now() + 60_000; await save(s); }
        throw error;
      }
    }
    case 'draft': {
      assert(!s.handoff && s.inventory?.complete, '当前无法保存草稿');
      const rows = message.rows as Selection[];
      assert(Array.isArray(rows) && rows.length <= 20_000, '草稿过大');
      const groups = new Map(s.inventory.groups.map(g => [g.hashName, g]));
      const seen = new Set<string>();
      for (const r of rows) {
        assert(r && typeof r.hashName === 'string' && groups.has(r.hashName) && !seen.has(r.hashName), '草稿物品不匹配'); seen.add(r.hashName);
        integer(r.quantity, 1, groups.get(r.hashName)!.owned, '草稿数量'); integer(r.receive, 0, 1_000_000_000, '草稿价格');
      }
      s.draft = rows; s.review = undefined; await save(s); return true;
    }
    case 'review': {
      await account(s); assert(s.inventory && !s.handoff, '请先加载库存');
      const fresh = await execute(s.sourceTabId, inspectInventory, []);
      assert(fresh.account === s.bootstrap!.account && JSON.stringify(fresh.wallet) === JSON.stringify(s.bootstrap!.wallet), '账户货币或费用信息发生变化，请重新启动工作台');
      const c = fresh.contexts.find(c => c.appid === s.inventory!.context.appid && c.contextid === s.inventory!.context.contextid);
      assert(c && c.publisherRate === s.inventory.context.publisherRate, '游戏费用发生变化，请重新加载');
      s.review = buildReview(s.inventory, message.rows as Selection[], s.bootstrap!.account, contextWallet(s), s.references, Date.now(), crypto.randomUUID());
      multisellURL(s.review); s.draft = s.review.rows.map(({hashName, quantity, receive}) => ({hashName, quantity, receive})); await save(s); return s.review;
    }
    case 'handoff': {
      await account(s); const r = s.review;
      assert(r && r.id === message.reviewId && Date.now() - r.createdAt <= REVIEW_TTL, '核对单已过期，请返回调整并重新核对');
      assert(!r.rows.some(row => row.reference && !row.warning && Date.now() - row.reference.fetchedAt > PRICE_TTL), '参考价在核对期间已过期，请返回调整并重新核对');
      assert(message.acknowledged === true && (!r.rows.some(row => row.warning) || message.riskAcknowledged === true), '请核对清单和价格提示后再交接');
      assert(!s.handoff, '这份清单已交接，不能重复填充');
      const url = multisellURL(r);
      s.handoff = {url, reviewId: r.id, filled: false}; await save(s);
      try { await chrome.tabs.update(s.sourceTabId, {url}); }
      catch (error) { s.handoff = undefined; await save(s); throw error; }
      return s.handoff;
    }
    case 'native': {
      assert(s.review && s.handoff && !s.handoff.filled, '无待填充的原生清单');
      const tab = await source(s, false);
      if (tab.status !== 'complete') return {state: 'loading', message: '正在打开 Steam 原生页面…'};
      assert(tab.url && new URL(tab.url).href === s.handoff.url, '原标签页地址已变化，已停止交接');
      const result = await execute(s.sourceTabId, fillNative, [s.review]);
      assert(result && ['loading', 'filled', 'error'].includes(result.state) && typeof result.message === 'string', 'Steam 原生填表没有返回有效状态，请回到库存重新核对');
      assert(result.state !== 'error', result.message);
      if (result.state === 'filled') { s.handoff.filled = true; await save(s); await chrome.tabs.update(s.sourceTabId, {active: true}); }
      return result;
    }
    case 'focus': { await source(s, false); await chrome.tabs.update(s.sourceTabId, {active: true}); return true; }
    case 'clear': { await chrome.storage.session.remove(key(s.id)); return true; }
    default: throw new Error('不支持的工作台操作');
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    assert(sender.id === chrome.runtime.id && sender.url, '拒绝非扩展消息');
    const from = new URL(sender.url);
    assert(from.protocol === 'chrome-extension:' && from.hostname === chrome.runtime.id && from.pathname === '/ui.html', '只有本地工作台可以操作');
    assert(message && typeof message === 'object', '消息无效');
    const m = message as Record<string, unknown>, id = String(m.id ?? '');
    assert(/^[0-9a-f-]{36}$/.test(id) && (!from.hash || from.hash === `#${id}`), '工作台会话不匹配');
    assert(!locks.has(id), '另一个操作仍在进行，请等待完成'); locks.add(id);
    try {
      const s = (await chrome.storage.session.get(key(id)))[key(id)] as Session | undefined;
      assert(s && Date.now() - s.updatedAt <= SESSION_TTL, '工作台会话已结束或过期，请在 Steam 库存页重新点击扩展');
      assert(s.uiTabId !== undefined, '工作台仍在初始化，请稍候重试');
      if (sender.tab?.id !== undefined && s.uiTabId !== undefined) assert(sender.tab.id === s.uiTabId, '请使用本次打开的工作台标签页');
      return await dispatch(s, m);
    } finally { locks.delete(id); }
  })().then(data => sendResponse({ok: true, data})).catch(error => sendResponse({ok: false, error: error instanceof Error ? error.message : '操作失败，请重新加载后重试'}));
  return true;
});
