import test from 'node:test';
import assert from 'node:assert/strict';
const extensionId='a'.repeat(32), account='76561198000000000';
let ctx, onAction, onMessage, onRemove;
const bootstrap={account,contexts:[{appid:'730',contextid:'2',name:'CS2',count:2,publisherRate:.1}],wallet:{currency:23,code:'CNY',symbol:'¥',minimum:1,increment:1,steamRate:.05,publisherRate:.1}};
globalThis.chrome={
  runtime:{id:extensionId,getURL:p=>`chrome-extension://${extensionId}/${p}`,onInstalled:{addListener(){}},onMessage:{addListener:f=>{onMessage=f;}}},
  action:{onClicked:{addListener:f=>{onAction=f;}},setBadgeText:async()=>{},setTitle:async()=>{}},
  storage:{session:{get:async key=>key===null?structuredClone(ctx.store):{[key]:structuredClone(ctx.store[key])},set:async values=>{Object.assign(ctx.store,structuredClone(values));},remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete ctx.store[k];},setAccessLevel:async()=>{}}},
  tabs:{onRemoved:{addListener:f=>{onRemove=f;}},get:async id=>{const t=ctx.tabs[id];if(!t)throw new Error('closed');return {...t};},create:async props=>{ctx.tabs[2]={id:2,status:'complete',...props};return {...ctx.tabs[2]};},update:async(id,props)=>{ctx.updates.push({id,...props});Object.assign(ctx.tabs[id],props);return {...ctx.tabs[id]};}},
  scripting:{executeScript:async options=>{
    ctx.scripts.push({name:options.func.name,world:options.world,args:options.args});
    let result;
    if(options.func.name==='inspectInventory')result=structuredClone(bootstrap);
    else if(options.func.name==='inspectAccount')result=ctx.account===account;
    else if(options.func.name==='fetchInventoryPage')result={total:2,more:false,cursor:'',records:[1,2].map(i=>({assetid:String(i),amount:1,hashName:'Case',name:'箱',type:'武器箱',icon:'',marketable:true,commodity:true}))};
    else if(options.func.name==='fetchReference'){if(ctx.rateLimit)throw new Error('429');result='¥ 1.15';}
    else if(options.func.name==='fillNative')result={state:'filled',message:'filled'};
    else throw new Error('unexpected executable');
    return [{frameId:0,result}];
  }}
};
await import('../dist/background.js');
async function start(){
  ctx={store:{},tabs:{1:{id:1,status:'complete',url:'https://steamcommunity.com/my/inventory/'}},scripts:[],updates:[],account,rateLimit:false};
  onAction(ctx.tabs[1]);
  for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,0));if(Object.values(ctx.store)[0]?.uiTabId)break;}
  const s=Object.values(ctx.store)[0];assert.ok(s?.uiTabId);return s.id;
}
function message(id,type,data={},sender={}){
  return new Promise(resolve=>onMessage({id,type,...data},{id:extensionId,url:`chrome-extension://${extensionId}/ui.html#${id}`,tab:{id:2},...sender},resolve));
}
async function ready(){const id=await start();assert.equal((await message(id,'bootstrap')).ok,true);assert.equal((await message(id,'inventory',{appid:'730',contextid:'2',reset:true})).ok,true);return id;}
const selection=[{hashName:'Case',quantity:1,receive:100}];
test('webpage messages, forged sessions and different UI tabs are rejected before scripting',async()=>{
  const id=await start();
  for(const sender of [{url:'https://steamcommunity.com/market/'},{id:'b'.repeat(32)},{tab:{id:99}},{url:`chrome-extension://${extensionId}/ui.html#other`}]) assert.equal((await message(id,'bootstrap',{},sender)).ok,false);
  assert.equal(ctx.scripts.length,0);
});
test('unsupported inventory context and account change fail closed',async()=>{
  const id=await ready();const count=ctx.scripts.filter(s=>s.name==='fetchInventoryPage').length;
  assert.equal((await message(id,'inventory',{appid:'999',contextid:'2',reset:true})).ok,false);
  ctx.account='76561198000000001';assert.equal((await message(id,'reference',{hashName:'Case'})).ok,false);
  assert.equal(ctx.scripts.filter(s=>s.name==='fetchInventoryPage').length,count);
});
test('native handoff requires immutable review and explicit acknowledgements',async()=>{
  const id=await ready();const r=await message(id,'review',{rows:selection});assert.equal(r.ok,true);
  assert.equal((await message(id,'handoff',{reviewId:r.data.id,acknowledged:false,riskAcknowledged:true})).ok,false);
  assert.equal((await message(id,'handoff',{reviewId:r.data.id,acknowledged:true,riskAcknowledged:false})).ok,false);
  assert.equal((await message(id,'handoff',{reviewId:'forged',acknowledged:true,riskAcknowledged:true})).ok,false);
  assert.equal(ctx.updates.length,0);
  assert.equal((await message(id,'handoff',{reviewId:r.data.id,acknowledged:true,riskAcknowledged:true,rows:[{hashName:'Evil',receive:1,quantity:100}]})).ok,true);
  const target=new URL(ctx.updates[0].url);assert.deepEqual(target.searchParams.getAll('items[]'),['Case']);
  assert.equal((await message(id,'native')).ok,true);assert.equal(ctx.store[`session:${id}`].handoff.filled,true);
  assert.equal((await message(id,'native')).ok,false,'completed handoff cannot run twice');
});
test('expired review and changed native URL stop without filling',async()=>{
  const id=await ready();let r=await message(id,'review',{rows:selection});ctx.store[`session:${id}`].review.createdAt-=121000;
  assert.equal((await message(id,'handoff',{reviewId:r.data.id,acknowledged:true,riskAcknowledged:true})).ok,false);
  r=await message(id,'review',{rows:selection});await message(id,'handoff',{reviewId:r.data.id,acknowledged:true,riskAcknowledged:true});
  ctx.tabs[1].url='https://steamcommunity.com/market/';assert.equal((await message(id,'native')).ok,false);
  assert.equal(ctx.scripts.filter(s=>s.name==='fillNative').length,0);
});
test('price rate limit is persisted and never automatically retried',async()=>{
  const id=await ready();ctx.rateLimit=true;assert.equal((await message(id,'reference',{hashName:'Case'})).ok,false);
  ctx.rateLimit=false;assert.equal((await message(id,'reference',{hashName:'Case'})).ok,false);
  assert.equal(ctx.scripts.filter(s=>s.name==='fetchReference').length,1);
  assert.ok(ctx.store[`session:${id}`].nextPriceAt>Date.now()+50000);
});
test('draft edit invalidates review, and source tab closure clears its data',async()=>{
  const id=await ready();await message(id,'review',{rows:selection});await message(id,'draft',{rows:[{...selection[0],receive:200}]});assert.equal(ctx.store[`session:${id}`].review,undefined);
  onRemove(1);await new Promise(r=>setTimeout(r,0));assert.equal(ctx.store[`session:${id}`],undefined);
});
test('repeated toolbar clicks reuse one workbench for the same Steam tab',async()=>{
  const id=await start();onAction(ctx.tabs[1]);await new Promise(r=>setTimeout(r,5));
  assert.equal(Object.keys(ctx.store).length,1);assert.equal(Object.values(ctx.store)[0].id,id);
  assert.deepEqual(ctx.updates.at(-1),{id:2,active:true});
});
test('reference expiration between review and handoff requires a new review',async()=>{
  const id=await ready();await message(id,'reference',{hashName:'Case'});const r=await message(id,'review',{rows:selection});
  ctx.store[`session:${id}`].review.rows[0].reference.fetchedAt-=301000;
  const reply=await message(id,'handoff',{reviewId:r.data.id,acknowledged:true,riskAcknowledged:true});
  assert.equal(reply.ok,false);assert.match(reply.error,/参考价/);assert.equal(ctx.updates.length,0);
});
