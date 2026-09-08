import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {fillNative, fetchInventoryPage, fetchReference, inspectInventory} from '../dist/steam.js';
import {buyerPays} from '../dist/core.js';
const wallet={currency:23,code:'CNY',symbol:'¥',minimum:1,increment:1,steamRate:.05,publisherRate:.10};
const account='76561198000000000';
function fixture() {
  const dom=new JSDOM('<main><input id="agreement" type="checkbox"><button id="submit">创建上架物品</button>'+[101,102].map(id=>`<div><input class="market_multi_quantity" id="sell_${id}_qty" value="1"><input id="sell_${id}_price_recv"><input id="sell_${id}_price_paid"></div>`).join('')+'</main>',{url:'https://steamcommunity.com/market/multisell?appid=730&contextid=2',runScripts:'outside-only'});
  const w=dom.window; Object.defineProperty(w.document,'readyState',{value:'complete',configurable:true}); let submissions=0;
  w.document.getElementById('submit').addEventListener('click',()=>submissions++);
  w.fetch=()=>{submissions++;throw new Error('forbidden network');};
  w.g_steamID=account; w.g_unAppId=730; w.g_ulContextId='2'; w.g_bSellInProgress=false;
  w.g_rgMarketHashNames=['Case & One','Case Two']; w.g_rgItemNameIds=[101,102];
  w.g_rgWalletInfo={wallet_currency:23,wallet_publisher_fee_percent_default:.1,wallet_fee_percent:.05};
  const inv={BIsFullyLoaded:()=>true,m_rgAssets:{1:{assetid:'1',classid:'11',instanceid:'0',amount:'4'},2:{assetid:'2',classid:'12',instanceid:'0',amount:'2'}},m_rgDescriptions:{11:{market_hash_name:'Case & One',marketable:1,commodity:1},12:{market_hash_name:'Case Two',marketable:1,commodity:1}}};
  w.UserYou={strSteamId:account,getInventory:()=>inv};
  w.GetCurrencyCode=()=> 'CNY'; w.GetCurrencySymbol=()=> '¥'; w.v_currencyformat=n=>`¥ ${(n/100).toFixed(2)}`;
  w.GetTotalWithFees=(n,p,s)=>buyerPays(n,{...wallet,publisherRate:p,steamRate:s});
  w.GetPriceValueAsInt=s=>Math.round(Number(s.replace('¥','').trim())*100);
  w.$J=e=>e;
  w.PriceRecvChanged=e=>{const paid=w.document.getElementById(e.id.replace('_recv','_paid'));paid.value=w.v_currencyformat(w.GetTotalWithFees(w.GetPriceValueAsInt(e.value),.1,.05));};
  w.UpdateOrderTotal=()=>true;
  const review={id:'r',createdAt:Date.now(),account,wallet,context:{appid:'730',contextid:'2',publisherRate:.1,name:'CS2',count:6},rows:[{hashName:'Case & One',name:'Case 1',quantity:3,receive:996,paid:1144},{hashName:'Case Two',name:'Case 2',quantity:2,receive:100,paid:115}],totalQuantity:5,totalReceive:3188,totalPaid:3662};
  const call=()=>w.eval(`(${fillNative.toString()})`)(structuredClone(review));
  return {w,inv,review,call,submissions:()=>submissions,quantities:()=>[101,102].map(id=>w.document.getElementById(`sell_${id}_qty`).value),close:()=>w.close()};
}
test('handoff fills exact amounts with zero sale calls and untouched agreement',()=>{
  const f=fixture(); assert.equal(f.call().state,'filled');assert.deepEqual(f.quantities(),['3','2']);
  assert.equal(f.w.document.getElementById('sell_101_price_paid').value,'¥ 11.44');
  assert.equal(f.w.document.getElementById('agreement').checked,false);assert.equal(f.submissions(),0);
  assert.match(f.w.document.getElementById('steam-bulk-local-handoff').textContent,/尚未提交/);f.close();
});
test('loading native inventory keeps all quantities zero',()=>{const f=fixture();f.inv.BIsFullyLoaded=()=>false;assert.equal(f.call().state,'loading');assert.deepEqual(f.quantities(),['0','0']);f.close();});
for (const [name, mutate] of [
  ['inventory shrank',f=>{f.inv.m_rgAssets[1].amount='1';}],
  ['same-name skin appeared',f=>{f.inv.m_rgDescriptions[11].commodity=0;}],
  ['fees changed',f=>{f.w.g_rgWalletInfo.wallet_fee_percent=.08;}],
  ['currency changed',f=>{f.w.g_rgWalletInfo.wallet_currency=1;}],
  ['native formatting changed mid-fill',f=>{const original=f.w.v_currencyformat;f.w.v_currencyformat=n=>n===115?'¥ 99.99':original(n);} ],
  ['native validation failed',f=>{f.w.UpdateOrderTotal=()=>false;}]
]) test(`safe failure when ${name}`,()=>{const f=fixture();mutate(f);assert.equal(f.call().state,'error');assert.deepEqual(f.quantities(),['0','0']);assert.equal(f.submissions(),0);f.close();});
test('wrong account, expired review, active sale and unknown table all stop',()=>{
  for (const mutate of [f=>{f.w.g_steamID='76561198000000001';},f=>{f.review.createdAt-=121000;},f=>{f.w.g_bSellInProgress=true;},f=>{f.w.document.getElementById('sell_102_qty').remove();}]) {const f=fixture();mutate(f);assert.equal(f.call().state,'error');assert.equal(f.submissions(),0);f.close();}
});
test('self-contained bootstrap extracts only allowlisted wallet data',()=>{
  const f=fixture();f.w.history.replaceState(null,'','/id/test/inventory/');
  f.w.g_rgWalletInfo.wallet_balance=999999;f.w.g_rgWalletInfo.secret='do-not-return';
  f.w.g_rgAppContextData={730:{name:'CS2',rgContexts:{2:{name:'库存',asset_count:6}}}};
  const b=f.w.eval(`(${inspectInventory.toString()})`)();assert.equal(b.account,account);assert.equal(b.wallet.code,'CNY');assert.ok(!JSON.stringify(b).includes('secret'));assert.ok(!JSON.stringify(b).includes('balance'));f.close();
});
test('inventory fetch is same-origin GET, validates descriptors, and never follows redirects',async()=>{
  const f=fixture();f.w.history.replaceState(null,'','/id/test/inventory/'); f.w.AbortSignal=AbortSignal;
  let opts,url;
  f.w.fetch=async(u,o)=>{opts=o;url=String(u);return {ok:true,status:200,json:async()=>({success:1,total_inventory_count:1,assets:[{assetid:'5',appid:730,contextid:'2',classid:'7',instanceid:'0',amount:'1'}],descriptions:[{classid:'7',instanceid:'0',name:'Case',market_hash_name:'Case & +',marketable:1,commodity:1}]})};};
  const result=await f.w.eval(`(${fetchInventoryPage.toString()})`)(account,'730','2','');
  assert.equal(result.records[0].hashName,'Case & +');assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'same-origin');assert.match(url,/^https:\/\/steamcommunity.com\/inventory\//);
  f.w.fetch=async()=>({ok:true,status:200,json:async()=>({success:1,total_inventory_count:1,assets:[{appid:730,contextid:'2',classid:'7',amount:'1'}],descriptions:[]})});
  await assert.rejects(f.w.eval(`(${fetchInventoryPage.toString()})`)(account,'730','2','')); f.close();
});
test('reference fetch encodes names and reports 429 without retry',async()=>{
  const f=fixture();f.w.history.replaceState(null,'','/id/test/inventory/');f.w.AbortSignal=AbortSignal;let calls=0;
  f.w.fetch=async(u,o)=>{calls++;assert.equal(new URL(u).searchParams.get('market_hash_name'),'Case & +');assert.equal(o.method,'GET');return {ok:false,status:429};};
  await assert.rejects(f.w.eval(`(${fetchReference.toString()})`)('730',23,'Case & +'),/429/);assert.equal(calls,1);f.close();
});

test('native errors return serializable details instead of a thrown injection exception',()=>{
 const f=fixture();f.w.GetTotalWithFees=()=>{throw new Error('fee engine unavailable');};
 const result=JSON.parse(JSON.stringify(f.call()));assert.equal(result.state,'error');assert.match(result.message,/校验价格与库存.*fee engine unavailable/);assert.deepEqual(f.quantities(),['0','0']);f.close();
});
test('native fill does not require the unrelated asset lookup in PriceRecvChanged',()=>{
 const f=fixture();f.w.PriceRecvChanged=()=>{throw new Error('missing native row asset metadata');};delete f.w.$J;
 assert.equal(f.call().state,'filled');assert.equal(f.w.document.getElementById('sell_101_price_paid').value,'¥ 11.44');assert.equal(f.submissions(),0);f.close();
});
test('native initialization and owned-count callback are awaited before filling',()=>{
 const f=fixture();Object.defineProperty(f.w.document,'readyState',{value:'loading',configurable:true});assert.equal(f.call().state,'loading');
 Object.defineProperty(f.w.document,'readyState',{value:'complete',configurable:true});
 const owned=f.w.document.createElement('span');owned.id='sell_101_qty_owned';f.w.document.body.append(owned);
 assert.equal(f.call().state,'loading');assert.deepEqual(f.quantities(),['0','0']);owned.textContent='4';assert.equal(f.call().state,'filled');f.close();
});
test('cleanup preserves the original error even if native totals also throw',()=>{
 const f=fixture();f.w.GetTotalWithFees=()=>{throw new Error('original failure');};f.w.UpdateOrderTotal=()=>{throw new Error('cleanup failure');};
 const result=f.call();assert.equal(result.state,'error');assert.match(result.message,/original failure/);assert.deepEqual(f.quantities(),['0','0']);f.close();
});

test('Prototype Object.values and inherited Array methods are not inventory assets',()=>{
 const f=fixture();
 // Reproduce Steam's associative Array and Prototype 1.7's inherited enumeration.
 f.w.eval(`Object.values = function(object) { var results = []; for(var property in object) results.push(object[property]); return results; }; Array.prototype.steamEnumerableMethod = function() {};`);
 const assets=new f.w.Array();Object.assign(assets,f.inv.m_rgAssets);f.inv.m_rgAssets=assets;
 assert.equal(f.w.Object.values(assets).length,3);
 assert.equal(f.call().state,'filled');assert.deepEqual(f.quantities(),['3','2']);assert.equal(f.submissions(),0);f.close();
});
test('an actual asset with missing description still blocks native handoff',()=>{
 const f=fixture();delete f.inv.m_rgDescriptions[11];const result=f.call();
 assert.equal(result.state,'error');assert.match(result.message,/库存描述缺失/);assert.deepEqual(f.quantities(),['0','0']);assert.equal(f.submissions(),0);f.close();
});
