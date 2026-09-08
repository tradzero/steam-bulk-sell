import test from 'node:test';
import assert from 'node:assert/strict';
import {enteredPrice, buyerPays} from '../dist/core.js';
const wallet = {currency:23,code:'CNY',symbol:'¥',minimum:1,increment:1,steamRate:.05,publisherRate:.1};
test('price modes preserve proceeds and fees across repeated conversions', () => {
  for (const w of [wallet,{...wallet,publisherRate:0},{...wallet,minimum:100,increment:100}]) {
    for(let n=w.minimum;n<=10000;n+=w.increment){
      const original=enteredPrice((n/100).toFixed(2),'receive',w);
      const converted=enteredPrice((original.paid/100).toFixed(2),'paid',w);
      assert.equal(converted.receive,n);
      assert.equal(converted.fee,original.paid-n);
    }
  }
});
test('buyer input exposes rounding and rejects prices below fees or invalid steps', () => {
  assert.deepEqual(enteredPrice('11.44','paid',wallet),{receive:996,paid:1144,fee:148,target:1144});
  assert.deepEqual(enteredPrice('0.22','paid',wallet),{receive:19,paid:21,fee:2,target:22});
  for(const raw of ['0.01','0.02','0','-1','1e2','1.001']) assert.throws(()=>enteredPrice(raw,'paid',wallet));
  assert.throws(()=>enteredPrice('3.01','paid',{...wallet,minimum:100,increment:100}));
  assert.equal(enteredPrice('0.03','paid',wallet).paid,buyerPays(1,wallet));
});
