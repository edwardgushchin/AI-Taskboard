import test from 'node:test';
import assert from 'node:assert/strict';
import { codexLimitWindows, codexLimitState, providerLimitSource } from '../src/desktop/provider-limits.ts';
import '../src/desktop/provider-limits.js';
const summary = (globalThis as any).providerLimitSummary;
test('available windows only; used becomes remaining, multi-bucket supersedes legacy', () => {
 const bucket={limitId:'codex',primary:{usedPercent:77,windowDurationMins:300,resetsAt:2000000000},secondary:{usedPercent:100,windowDurationMins:10080}};
 assert.deepEqual(codexLimitWindows({rateLimits:bucket}).map(w=>w.remaining),[23,0]);
 assert.equal(codexLimitWindows({rateLimits:bucket})[0].resetsAt,2000000000000);
 assert.equal(codexLimitWindows({rateLimits:bucket,rateLimitsByLimitId:{a:bucket,b:{primary:{usedPercent:0}}}}).length,3);
 for(const usedPercent of [null,undefined,'25',NaN,-1,101]) assert.equal(codexLimitWindows({rateLimits:{primary:{usedPercent}}}).length,0);
 assert.equal(codexLimitWindows({}).length,0);
 assert.equal(codexLimitWindows({rateLimits:{primary:{usedPercent:0}}})[0].remaining,100);
});
test('independent providers: minimum, missing, expired reset and stale values',()=>{
 const ready=(provider:string,remaining:number)=>({provider,state:'ready',observedAt:1000,windows:[{name:'a',remaining}]});
 for(const count of [1,2,3]) {
  const data=[ready('Codex',23),ready('Second',7),{provider:'Third',state:'unknown',windows:[]}].slice(0,count);
  const r=summary(data,1001);assert.equal(r.lowest.remaining,count===1?23:7);assert.equal(r.unavailable,count===3?1:0);
 }
 assert.equal(summary([ready('Codex',23)],181001).lowest,undefined);
 assert.equal(summary([{...ready('Codex',23),windows:[{remaining:23,resetsAt:999}]}],1000).providers[0].state,'stale');
 for(const state of ['unknown','no_windows','unsupported','auth','error','stale']) assert.equal(summary([{...ready('Codex',0),state}],1001).lowest,undefined);
});
test('main-process source shares concurrent reads, TTL and replaces account data',async()=>{
 let calls=0,now=0;
 const get=providerLimitSource(async()=>({provider:'Codex',state:'ready',windows:[{name:'account '+ ++calls,remaining:calls}]}),()=>now);
 await Promise.all([get(),get(),get()]);assert.equal(calls,1);
 now=59999;await get();assert.equal(calls,1);
 now=60000;assert.equal((await get())[0].windows[0].name,'account 2');
 get.invalidate();await get();assert.equal(calls,3);
});
test('reconnection during a pending read discards old account; failed reads allow retry',async()=>{
 let release!: (value:any)=>void;let calls=0;
 const get=providerLimitSource(()=>++calls===1?new Promise(r=>{release=r;}):Promise.resolve({provider:'Codex',state:'ready',windows:[{name:'new account',remaining:80}]}));
 const first=get();get.invalidate();release({provider:'Codex',state:'ready',windows:[{name:'old account',remaining:1}]});
 assert.equal((await first)[0].windows[0].name,'new account');assert.equal(calls,2);
 let fail=true;const retry=providerLimitSource(async()=>{if(fail)throw new Error('failed');return undefined;});
 await assert.rejects(retry());fail=false;assert.deepEqual(await retry(),[]);
});
test('explicit absence of windows differs from missing or malformed data',()=>{
 assert.equal(codexLimitState({rateLimits:{primary:null,secondary:null}}),'no_windows');
 assert.equal(codexLimitState({}),'unknown');
 assert.equal(codexLimitState({rateLimits:{primary:{usedPercent:null},secondary:null}}),'unknown');
});
