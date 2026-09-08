import test from 'node:test';
import assert from 'node:assert/strict';
import {isSteamPage, moneyInput, parseReference, buyerPays, sellerReceives, mergePage, buildReview, multisellURL, referenceKey, normalizedPrice} from '../dist/core.js';
const wallet = {currency:23, code:'CNY', symbol:'¥', minimum:1, increment:1, steamRate:.05, publisherRate:.10};
const context = {appid:'730', contextid:'2', name:'CS2', count:4, publisherRate:.1};
const record = (id, overrides = {}) => ({assetid:String(id), amount:1, hashName:'Dreams & Nightmares Case', name:'梦魇武器箱', type:'武器箱', icon:'', marketable:true, commodity:true, ...overrides});
const complete = () => mergePage(undefined, {records:[record(1),record(2)],total:2,more:false,cursor:''}, context,1000);

test('only HTTPS Steam inventory and market paths are eligible', () => {
  for (const url of ['https://steamcommunity.com/market/','https://steamcommunity.com/id/test/inventory/','https://steamcommunity.com/profiles/76561198000000000/inventory/','https://steamcommunity.com/my/inventory/']) assert.equal(isSteamPage(url),true);
  for (const url of ['http://steamcommunity.com/market/','https://steamcommunity.com.evil.test/market/','https://steamcommunity.com/tradeoffer/new/','https://steamcommunity.com/marketplace','https://user:pass@steamcommunity.com/market/','javascript:alert(1)']) assert.equal(isSteamPage(url),false);
});
test('manual prices reject ambiguous or fractional-cent input', () => {
  assert.equal(moneyInput('9,96'),996); assert.equal(moneyInput('9.96'),996); assert.equal(moneyInput('10'),1000);
  for (const price of ['','0','-1','1.001','1e4','1,000.00','¥ 1.00','1.00 2.00','NaN','Infinity']) assert.throws(()=>moneyInput(price));
});
test('localized reference parser accepts exactly one currency amount', () => {
  assert.equal(parseReference('¥ 1,234.56',wallet),123456);
  assert.equal(parseReference('1.234,56 €',{...wallet,code:'EUR',symbol:'€'}),123456);
  assert.equal(parseReference('1\u202f234,56 руб.',{...wallet,code:'RUB',symbol:'руб.'}),123456);
  assert.equal(parseReference('CHF 1.--',{...wallet,code:'CHF',symbol:'CHF'}),100);
  assert.equal(parseReference('¥ 1,234',wallet),123400);
  for (const raw of ['¥ 0.05 (¥ 0.03)','0,05€ (0,03€)','USD 1.00','¥ -1.00','¥ 12.34.56','¥ 1.2.345','<script>','¥ 1.2345']) assert.throws(()=>parseReference(raw,wallet));
});
test('fees use rounding and minimum fees, not a flat discount', () => {
  assert.equal(buyerPays(996,wallet),1144); assert.equal(buyerPays(1,wallet),3);
  assert.equal(buyerPays(2,wallet),4); assert.equal(sellerReceives(1144,wallet),996);
  assert.equal(buyerPays(100,{...wallet,publisherRate:0}),105);
  const stepped = {...wallet,minimum:100,increment:100};
  assert.equal(normalizedPrice(149,stepped),100); assert.equal(normalizedPrice(150,stepped),200);
  assert.equal(buyerPays(100,stepped),300);
});
test('inventory is complete only after every page and excludes noncommodities', () => {
  const first = mergePage(undefined,{records:[record(1),record(2,{commodity:false})],total:4,more:true,cursor:'2'},context,1000);
  assert.equal(first.complete,false);
  assert.throws(()=>buildReview(first,[{hashName:record(1).hashName,quantity:1,receive:100}],'account',wallet,{},1000,'review'));
  const last = mergePage(first,{records:[record(3,{amount:3}),record(4,{marketable:false})],total:4,more:false,cursor:''},context,2000);
  assert.equal(last.complete,true); assert.equal(last.groups[0].owned,4); assert.equal(last.excluded,2);
  assert.equal(first.seen.length,2,'previous snapshot must remain immutable');
});
test('pagination rejects changing totals, duplicate assets, missing pages and stuck cursors', () => {
  const first = mergePage(undefined,{records:[record(1)],total:3,more:true,cursor:'1'},context,0);
  for (const p of [
    {records:[record(1)],total:3,more:true,cursor:'2'},
    {records:[record(2)],total:4,more:true,cursor:'2'},
    {records:[record(2)],total:3,more:false,cursor:''},
    {records:[record(2)],total:3,more:true,cursor:'1'}
  ]) assert.throws(()=>mergePage(first,p,context,1000));
});
test('review enforces ownership, quantities, exact price steps and batch limits', () => {
  const inv=complete(), name=inv.groups[0].hashName;
  for (const selection of [[],[{hashName:name,quantity:3,receive:100}],[{hashName:name,quantity:1.5,receive:100}],[{hashName:name,quantity:1,receive:0}],[{hashName:'not-owned',quantity:1,receive:100}],[{hashName:name,quantity:1,receive:100},{hashName:name,quantity:1,receive:100}]]) assert.throws(()=>buildReview(inv,selection,'a',wallet,{},1000,'r'));
  assert.throws(()=>buildReview(inv,[{hashName:name,quantity:1,receive:149}],'a',{...wallet,increment:100,minimum:100},{},1000,'r'));
  const many=mergePage(undefined,{records:[record(1,{amount:201})],total:1,more:false,cursor:''},context,1000);
  assert.throws(()=>buildReview(many,[{hashName:name,quantity:201,receive:100}],'a',wallet,{},1000,'r'));
});
test('reference age, missing data and low prices remain visible review warnings', () => {
  const inv=complete(), hashName=inv.groups[0].hashName, choose=[{hashName,quantity:2,receive:100}];
  const missing=buildReview(inv,choose,'a',wallet,{},500000,'r'); assert.match(missing.rows[0].warning,/缺少/);
  const stale=buildReview(inv,choose,'a',wallet,{[referenceKey(hashName)]:{paid:115,fetchedAt:0}},500000,'r'); assert.match(stale.rows[0].warning,/超过/);
  const low=buildReview(inv,choose,'a',wallet,{[referenceKey(hashName)]:{paid:500,fetchedAt:500000}},500000,'r'); assert.match(low.rows[0].warning,/20%/);
  assert.equal(low.totalReceive,200); assert.equal(low.totalPaid,230);
});
test('Steam URL preserves special market names and contains no price or credential', () => {
  const inv=complete(); inv.groups[0].hashName='胶囊 & Case + / ? # [] %';
  const r=buildReview(inv,[{hashName:inv.groups[0].hashName,quantity:1,receive:100}],'account',wallet,{},0,'r');
  const u=new URL(multisellURL(r)); assert.equal(u.searchParams.getAll('items[]')[0],inv.groups[0].hashName);
  assert.deepEqual([...u.searchParams.keys()],['appid','contextid','items[]']); assert.equal(u.origin,'https://steamcommunity.com');
});
