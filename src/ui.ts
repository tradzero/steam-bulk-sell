import type { PublicSession, Group, Review, Selection, Reference, Reply, Wallet } from './types.js';
import { assert, integer, moneyInput, buyerPays, sellerReceives, normalizedPrice, referenceKey, PRICE_TTL, REVIEW_TTL } from './core.js';

const get = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id); if (!node) throw new Error(`缺少界面元素 ${id}`); return node as T;
};
const button = (id: string) => get<HTMLButtonElement>(id);
const input = (id: string) => get<HTMLInputElement>(id);
const select = (id: string) => get<HTMLSelectElement>(id);
const text = (id: string, value: string) => { get(id).textContent = value; };
const show = (id: string, value = true) => { get(id).hidden = !value; };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string) => {
  const n = document.createElement(tag); if (value !== undefined) n.textContent = value; if (className) n.className = className; return n;
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let demoRequest: ((m: Record<string, unknown>) => Promise<unknown>) | undefined;
const isDemo = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);
if (isDemo) { demoRequest = (await import('./demo.js')).demoRequest; show('demo-banner'); }
const sessionId = location.hash.slice(1);
async function request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  const message = {type, id: sessionId, ...data};
  if (demoRequest) return await demoRequest(message) as T;
  assert(location.protocol === 'chrome-extension:', '请通过已安装的 Chrome 扩展打开工作台');
  const reply = await chrome.runtime.sendMessage(message) as Reply;
  if (!reply?.ok) throw new Error(reply?.error ?? '扩展后台没有响应，请重新打开工作台');
  return reply.data as T;
}
type RowState = {selected: boolean; quantity: string; price: string};
let state: PublicSession;
let rows = new Map<string, RowState>();
let page = 0, busy = false, cancelled = false, stage: 'editor' | 'review' | 'handoff' = 'editor';
let review: Review | undefined;
const PAGE_SIZE = 25;
const wallet = (): Wallet => ({...state.bootstrap!.wallet, publisherRate: state.inventory?.context.publisherRate ?? state.bootstrap!.wallet.publisherRate});
function money(n: number): string {
  try { return new Intl.NumberFormat('zh-CN', {style: 'currency', currency: wallet().code, minimumFractionDigits: 2, maximumFractionDigits: 2}).format(n / 100); }
  catch { return `${state?.bootstrap?.wallet.code ?? ''} ${(n / 100).toFixed(2)}`; }
}
function error(e: unknown) { text('error', e instanceof Error ? e.message : String(e)); show('error'); }
function status(message: string) { text('status', message); }
function setBusy(value: boolean) {
  busy = value;
  for (const el of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) {
    if (value) { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; }
    else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; }
  }
}
async function task(fn: () => Promise<void>) {
  if (busy) return;
  show('error', false); setBusy(true);
  try { await fn(); } catch (e) { error(e); status('操作已停止。请处理提示后重试。'); }
  finally { setBusy(false); if (state?.inventory?.complete && stage === 'editor') renderTable(); syncReview(); }
}
function applyState(next: PublicSession, restoreRows = false) {
  state = next;
  if (restoreRows) {
    rows = new Map((state.inventory?.groups ?? []).map(g => [g.hashName, {selected: false, quantity: '1', price: ''}]));
    for (const r of state.draft) if (rows.has(r.hashName)) rows.set(r.hashName, {selected: true, quantity: String(r.quantity), price: r.receive > 0 ? (r.receive / 100).toFixed(2) : ''});
  }
}
function switchStage(next: typeof stage) {
  stage = next;
  show('editor', next === 'editor'); show('review-panel', next === 'review'); show('handoff-panel', next === 'handoff'); show('startup', false);
  ['editor', 'review', 'handoff'].forEach((s, i) => get(`step-${i + 1}`).classList.toggle('current', s === next));
}
function renderContext() {
  const ctx = select('context'), previous = ctx.value; ctx.replaceChildren();
  for (const c of state.bootstrap!.contexts) { const option = node('option', `${c.name} (${c.count.toLocaleString()})`); option.value = `${c.appid}/${c.contextid}`; ctx.append(option); }
  if (state.inventory) ctx.value = `${state.inventory.context.appid}/${state.inventory.context.contextid}`;
  else if ([...ctx.options].some(o => o.value === previous)) ctx.value = previous;
  text('account', `账户 …${state.bootstrap!.account.slice(-6)} · ${state.bootstrap!.wallet.code}`);
  text('currency-info', `钱包货币 ${wallet().code} · 价格步长 ${money(wallet().increment)}`);
  show('inventory-tools', Boolean(state.inventory?.complete));
  if (state.inventory) {
    text('inventory-summary', state.inventory.complete ? `已完整读取 ${state.inventory.total.toLocaleString()} 个资产；${state.inventory.groups.length} 种可出售同质物品。已排除 ${state.inventory.excluded.toLocaleString()} 个非同质或不可上架资产。` : '库存尚未完整加载，暂时不能准备出售。');
    const type = select('type'); type.replaceChildren(node('option', '全部类型')); type.options[0]!.value = '';
    for (const t of [...new Set(state.inventory.groups.map(g => g.type))].sort()) { const option = node('option', t); option.value = t; type.append(option); }
  }
}
function filtered(): Group[] {
  const search = input('search').value.trim().toLocaleLowerCase(), type = select('type').value;
  const result = (state.inventory?.groups ?? []).filter(g => (!search || `${g.name} ${g.hashName}`.toLocaleLowerCase().includes(search)) && (!type || g.type === type) && (!input('only-selected').checked || rows.get(g.hashName)?.selected));
  const sort = select('sort').value;
  return result.sort((a, b) => sort === 'owned' ? b.owned - a.owned : sort === 'reference' ? (state.references[referenceKey(b.hashName)]?.paid ?? 0) - (state.references[referenceKey(a.hashName)]?.paid ?? 0) : a.name.localeCompare(b.name, 'zh-CN'));
}
function visibleGroups(): Group[] {
  const result = filtered(); page = Math.min(page, Math.max(0, Math.ceil(result.length / PAGE_SIZE) - 1)); return result.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}
function selectedNames(): string[] { return [...rows].filter(([, r]) => r.selected).map(([name]) => name); }
function selection(allowEmptyPrice = false): Selection[] {
  return selectedNames().map(hashName => {
    const row = rows.get(hashName)!, group = state.inventory!.groups.find(g => g.hashName === hashName)!;
    const quantity = integer(Number(row.quantity), 1, group.owned, `${group.name}的出售数量`);
    let receive = 0;
    if (row.price.trim()) receive = moneyInput(row.price);
    else assert(allowEmptyPrice, `${group.name}尚未填写到手单价`);
    if (receive) assert(normalizedPrice(receive, wallet()) === receive, `${group.name}的价格不符合最小金额或货币步长`);
    return {hashName, quantity, receive};
  });
}
function renderSummary() {
  const names = selectedNames(); let total = 0, count = 0, invalid = 0;
  for (const name of names) {
    const row = rows.get(name)!;
    try { const group = state.inventory!.groups.find(g => g.hashName === name)!; const q = integer(Number(row.quantity), 1, group.owned, '数量'); count += q;
      const p = moneyInput(row.price); assert(normalizedPrice(p, wallet()) === p, '步长'); total += p * q;
    } catch { invalid++; }
  }
  text('selection-summary', `已选 ${names.length} 种 · ${count} 件${invalid ? ` · ${invalid} 行待填写或修正` : ''}`);
  text('total', names.length ? `${money(total)}${invalid ? '（部分）' : ''}` : '—');
  button('review').disabled = busy || !names.length || invalid > 0 || names.length > 25 || count > 200;
  if (names.length > 25 || count > 200) text('total-caption', '本批超出 25 种 / 200 件，请减少选择或数量。');
  else text('total-caption', '全部成交后的预计到手金额');
  const filteredNames = new Set(filtered().map(g => g.hashName)); const hidden = names.filter(n => !filteredNames.has(n)).length;
  text('hidden-selection', hidden ? `筛选外仍有 ${hidden} 种已选，核对单会包含它们` : '');
}
function renderTable() {
  if (!state.inventory?.complete) return;
  const body = get('items'); body.replaceChildren(); const visible = visibleGroups();
  for (const g of visible) {
    const r = rows.get(g.hashName)!; const tr = node('tr'); tr.classList.toggle('selected', r.selected);
    const checkCell = node('td'), check = node('input'); check.type = 'checkbox'; check.checked = r.selected; check.disabled = busy; check.setAttribute('aria-label', `选择${g.name}`);
    check.addEventListener('change', () => { r.selected = check.checked; renderTable(); }); checkCell.append(check); tr.append(checkCell);
    const itemCell = node('td'), item = node('div', undefined, 'item');
    if (g.icon) { const img = node('img'); img.src = `https://community.fastly.steamstatic.com/economy/image/${g.icon}/96fx96f`; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; item.append(img); }
    else item.append(node('span', '物', 'item-placeholder'));
    const details = node('div'), link = node('a', g.name); link.href = `https://steamcommunity.com/market/listings/${state.inventory.context.appid}/${encodeURIComponent(g.hashName)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link, node('div', g.type, 'type')); item.append(details); itemCell.append(item); tr.append(itemCell);
    const qtyCell = node('td'), qty = node('input'); qty.type = 'number'; qty.min = '1'; qty.max = String(g.owned); qty.step = '1'; qty.value = r.quantity; qty.className = 'quantity'; qty.disabled = busy || !r.selected; qty.setAttribute('aria-label', `${g.name}出售数量`); qtyCell.append(node('div', `持有 ${g.owned}`, 'owned'), qty); tr.append(qtyCell);
    const refCell = node('td'), ref = state.references[referenceKey(g.hashName)];
    refCell.append(node('div', ref ? money(ref.paid) : '未获取', 'numeric'));
    if (ref) { const age = Math.max(0, Date.now() - ref.fetchedAt); refCell.append(node('div', age > PRICE_TTL ? '已过期' : `${Math.floor(age / 60_000)} 分钟前`, `reference-time${age > PRICE_TTL ? ' stale' : ''}`)); }
    tr.append(refCell);
    const recvCell = node('td'), price = node('input'); price.type = 'text'; price.inputMode = 'decimal'; price.value = r.price; price.placeholder = '输入到手价'; price.className = 'price'; price.disabled = busy || !r.selected; price.setAttribute('aria-label', `${g.name}每件到手价`); recvCell.append(price); tr.append(recvCell);
    const paidCell = node('td', '—', 'numeric'), subtotal = node('td', '—', 'numeric'); tr.append(paidCell, subtotal);
    function update() {
      r.quantity = qty.value; r.price = price.value;
      qty.removeAttribute('aria-invalid'); price.removeAttribute('aria-invalid');
      let q = 0, p = 0;
      try { q = integer(Number(r.quantity), 1, g.owned, '数量'); } catch { if (r.selected) qty.setAttribute('aria-invalid', 'true'); }
      try { p = moneyInput(r.price); assert(normalizedPrice(p, wallet()) === p, '步长'); }
      catch { if (r.price && r.selected) price.setAttribute('aria-invalid', 'true'); p = 0; }
      paidCell.textContent = p ? money(buyerPays(p, wallet())) : '—'; subtotal.textContent = r.selected && p && q ? money(p * q) : '—'; renderSummary();
    }
    qty.addEventListener('input', update); price.addEventListener('input', update); update(); body.append(tr);
  }
  const total = filtered().length; show('empty', total === 0); text('page-info', `第 ${total ? page + 1 : 0} / ${Math.ceil(total / PAGE_SIZE)} 页 · ${total} 种`);
  button('previous').disabled = busy || page === 0; button('next').disabled = busy || (page + 1) * PAGE_SIZE >= total;
  renderSummary();
}

async function boot() {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      let next = await request<PublicSession>('state');
      if (!next.bootstrap) next = await request<PublicSession>('bootstrap');
      applyState(next, true); renderContext(); show('startup', false);
      if (next.handoff) {
        review = next.review; switchStage('handoff');
        if (next.handoff.filled) nativeDone(); else { status('本批已进入原生交接流程。'); show('check-native'); }
      } else { switchStage('editor'); renderTable(); status('已连接。选择库存并加载；不会预选任何新物品。'); }
      return;
    } catch (e) { last = e; if (attempt < 5) { status('等待 Steam 页面就绪…'); await delay(800); } }
  }
  show('startup'); throw last;
}
function renderReview(r: Review) {
  review = r; switchStage('review'); input('ack').checked = false; input('risk').checked = false;
  text('review-context', `${r.context.name} · 账户 …${r.account.slice(-6)} · ${r.wallet.code}`);
  const body = get('review-items'); body.replaceChildren();
  for (const row of r.rows) { const tr = node('tr');
    [row.name, String(row.quantity), money(row.receive), money(row.paid), money(row.receive * row.quantity), row.warning || '参考价有效'].forEach((value, i) => tr.append(node('td', value, i === 5 && row.warning ? 'warning' : undefined))); body.append(tr); }
  text('review-total', `${r.rows.length} 种 / ${r.totalQuantity} 件 · 预计到手 ${money(r.totalReceive)} · 买方合计支付 ${money(r.totalPaid)}`);
  show('risk-label', r.rows.some(row => row.warning)); syncReview(); status('请核对全部清单。当前没有创建任何上架。');
}
function syncReview() {
  if (stage !== 'review' || !review) return;
  const left = Math.max(0, Math.ceil((review.createdAt + REVIEW_TTL - Date.now()) / 1000));
  text('review-expiry', left ? `这份核对单 ${left} 秒后过期` : '核对单已过期，请返回调整并重新核对');
  button('handoff').disabled = busy || !left || !input('ack').checked || (review.rows.some(r => r.warning) && !input('risk').checked);
}
function nativeDone() {
  if (isDemo) { text('handoff-title', '演示交接已完成'); text('handoff-message', '多选、数量、价格和核对流程已演示完毕；没有填写任何真实 Steam 表单。'); show('check-native', false); status('演示完成，没有创建任何上架。'); return; }
  text('handoff-title', '清单已交接'); text('handoff-message', '数量和价格已填入 Steam 原生页面。交接完成时尚未提交；后续请在 Steam 核对和操作。'); show('check-native', false); status('原生页面已就绪。工作台不会自动提交，也不会替你进行手机确认。');
}
async function pollNative() {
  for (let attempt = 0; attempt < 45; attempt++) {
    const result = await request<{state: string; message: string}>('native'); text('handoff-message', result.message);
    if (result.state === 'filled') { nativeDone(); return; }
    await delay(1000);
  }
  status('Steam 库存仍未就绪，可以在核对单有效期内继续检查。'); show('check-native');
}

button('retry').addEventListener('click', () => void task(boot));
button('load').addEventListener('click', () => void task(async () => {
  if (selectedNames().length && !confirm('重新加载会清除本次选择和价格，是否继续？')) return;
  const [appid, contextid] = select('context').value.split('/'); assert(appid && contextid, '请选择库存');
  cancelled = false; show('cancel-load'); button('cancel-load').disabled = false; show('inventory-tools', false); rows.clear();
  try {
    let reset = true;
    do {
      const next = await request<PublicSession>('inventory', {appid, contextid, reset}); applyState(next); reset = false;
      status(`正在读取库存：${next.inventory!.complete ? next.inventory!.total : '分页加载中'} / ${next.inventory!.total} 个资产`);
      if (cancelled) { status('已停止读取。部分库存不能用于出售，请重新加载。'); break; }
      if (!next.inventory!.complete) await delay(1000);
    } while (!state.inventory!.complete);
    applyState(state, true); renderContext(); page = 0;
    if (state.inventory!.complete && !cancelled) { renderTable(); status('库存已完整加载。请先选择物品，再获取参考价或手动定价。'); }
    else show('inventory-tools', false);
  } finally { show('cancel-load', false); }
}));
button('cancel-load').addEventListener('click', () => { cancelled = true; status('将在当前读取请求结束后停止…'); });
select('context').addEventListener('change', () => {
  const same = state.inventory && select('context').value === `${state.inventory.context.appid}/${state.inventory.context.contextid}`;
  show('inventory-tools', Boolean(same && state.inventory?.complete));
  if (!same) text('inventory-summary', '库存选择已变化，请点击“加载库存”；原清单暂时隐藏。');
});
for (const id of ['search', 'type', 'sort', 'only-selected']) get(id).addEventListener(id === 'search' ? 'input' : 'change', () => { page = 0; renderTable(); });
button('previous').addEventListener('click', () => { page--; renderTable(); }); button('next').addEventListener('click', () => { page++; renderTable(); });
button('select-page').addEventListener('click', () => { visibleGroups().forEach(g => { rows.get(g.hashName)!.selected = true; }); renderTable(); });
button('select-all').addEventListener('click', () => { filtered().forEach(g => { rows.get(g.hashName)!.selected = true; }); renderTable(); });
button('deselect').addEventListener('click', () => { rows.forEach(r => { r.selected = false; }); renderTable(); });
button('keep-apply').addEventListener('click', () => {
  try { const keep = integer(Number(input('keep').value), 0, 1_000_000, '保留数量');
    for (const g of filtered()) { const r = rows.get(g.hashName)!; r.selected = g.owned > keep; r.quantity = String(Math.max(1, g.owned - keep)); }
    renderTable();
  } catch (e) { error(e); }
});
button('get-prices').addEventListener('click', () => void task(async () => {
  const names = selectedNames(); assert(names.length > 0 && names.length <= 25, '请先选择最多 25 种物品');
  let done = 0;
  for (const hashName of names) {
    text('price-progress', `正在获取 ${done + 1} / ${names.length}`);
    const ref = await request<Reference>('reference', {hashName}); state.references[referenceKey(hashName)] = ref; done++;
    if (done < names.length) await delay(1700);
  }
  text('price-progress', `已获取 ${done} 种参考价`); status('参考价已获取，尚未更改你的单价。可选择定价策略后应用。');
}));
select('strategy').addEventListener('change', () => show('offset-label', select('strategy').value === 'percent'));
button('apply-prices').addEventListener('click', () => {
  show('error', false);
  try {
    const names = selectedNames(); assert(names.length > 0, '请先选择物品'); const strategy = select('strategy').value;
    const offset = strategy === 'percent' ? integer(Number(input('offset').value), -50, 100, '调整百分比') : 0;
    const updates: [string, number][] = names.map(name => {
      const ref = state.references[referenceKey(name)]; assert(ref && Date.now() - ref.fetchedAt <= PRICE_TTL, '部分物品缺少有效参考价，请先获取参考价');
      const paid = strategy === 'undercut' ? ref.paid - wallet().increment : strategy === 'percent' ? Math.round(ref.paid * (100 + offset) / 100) : ref.paid;
      assert(paid >= buyerPays(wallet().minimum, wallet()), '调整后的价格低于 Steam 最小金额');
      return [name, sellerReceives(paid, wallet())];
    });
    updates.forEach(([name, value]) => { rows.get(name)!.price = (value / 100).toFixed(2); }); renderTable(); status('已应用到手价。受费用取整影响，买方支付可能与目标参考价略有差异，请逐行核对。');
  } catch (e) { error(e); }
});
button('save').addEventListener('click', () => void task(async () => { await request('draft', {rows: selection(true)}); status('草稿已保存在本次浏览器会话中；关闭浏览器或两小时未使用后失效。'); }));
button('review').addEventListener('click', () => void task(async () => { renderReview(await request<Review>('review', {rows: selection()})); }));
button('back').addEventListener('click', () => { review = undefined; switchStage('editor'); renderTable(); status('可以继续调整清单。'); });
input('ack').addEventListener('change', syncReview); input('risk').addEventListener('change', syncReview);
button('handoff').addEventListener('click', () => void task(async () => {
  assert(review, '缺少核对单');
  await request('handoff', {reviewId: review.id, acknowledged: input('ack').checked, riskAcknowledged: input('risk').checked});
  switchStage('handoff'); await pollNative();
}));
button('check-native').addEventListener('click', () => void task(pollNative));
for (const id of ['focus', 'native-focus']) button(id).addEventListener('click', () => void task(async () => { await request('focus'); }));
button('clear').addEventListener('click', () => void task(async () => {
  if (!confirm('清除本次工作台草稿和缓存？已经交接到 Steam 页面上的值不会被撤回。')) return;
  await request('clear'); show('editor', false); show('review-panel', false); show('handoff-panel', false); show('startup', false);
  status('本次草稿和缓存已清除。请在 Steam 库存页点击扩展开始新的会话。');
}));
setInterval(syncReview, 1000);
void task(boot);
