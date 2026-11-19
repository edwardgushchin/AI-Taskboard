import localization from "../src/desktop/localization.cjs";
(globalThis as any).taskboardLocalization = localization;
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexLimitWindows, codexLimitState, codexLimitSnapshot, confirmedQuota, providerLimitSource, type ProviderLimits } from '../src/desktop/provider-limits.ts';
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
test('window labels use readable durations in Russian and English without plan assumptions',()=>{
 const label=(globalThis as any).providerLimitWindowLabel;
 assert.equal(label(10080,'ru-RU'),'Неделя');
 assert.equal(label(10080,'en-US'),'Week');
 assert.match(label(300,'ru-RU'),/5 часов/);
 assert.match(label(90,'ru-RU'),/90 минут/);
 assert.match(label(2880,'ru-RU'),/2 дня/);
 assert.equal(label(undefined,'ru-RU'),'Лимит');
 assert.equal(codexLimitWindows({rateLimits:{primary:{usedPercent:53,windowDurationMins:10080}}})[0].durationMins,10080);
});

test('dispatch requires fresh confirmed quota and waits for all exhausted windows', () => {
  const now = 10_000;
  const base: ProviderLimits = {
    provider: 'Codex',
    state: 'ready',
    observedAt: now,
    windows: [
      { name: 'Primary', remaining: 0, resetsAt: 20_000 },
      { name: 'Secondary', remaining: 0, resetsAt: 30_000 },
    ],
  };
  assert.deepEqual(confirmedQuota(base, now), { resetsAt: 30_000 });
  assert.deepEqual(confirmedQuota({ ...base, windows: [{ name: 'Primary', remaining: 0 }] }, now), {});
  assert.equal(confirmedQuota({ ...base, observedAt: now - 60_000, windows: [{ name: 'Old', remaining: 0 }] }, now), undefined);
  assert.deepEqual(confirmedQuota(base, 20_001), { resetsAt: 30_000 });
  assert.equal(confirmedQuota(base, 30_000), undefined);
  for (const state of ['unknown', 'error', 'stale', 'auth', 'unsupported', 'no_windows'] as const) {
    assert.equal(confirmedQuota({ ...base, state }, now), undefined);
  }
  assert.equal(confirmedQuota({ ...base, windows: [{ name: 'Primary', remaining: 0.5 }] }, now), 'available');
});

test('only a complete fresh positive snapshot confirms recovery', () => {
  const now = 10_000;
  const primary = { usedPercent: 40, resetsAt: 20 };
  for (const usedPercent of ['25', '5e1', '0x32', '25x', null, undefined, NaN, -1, 101]) {
    const secondary = { usedPercent, resetsAt: 30 };
    const snapshot = codexLimitSnapshot({ rateLimits: { primary, secondary } }, now);
    assert.equal(snapshot.incomplete, true);
    assert.equal(confirmedQuota(snapshot, now), undefined);
    assert.equal(summary([snapshot], now).providers[0].state, 'unknown');
  }

  const expired = { usedPercent: 100, resetsAt: 9 };
  const mixed = codexLimitSnapshot({ rateLimits: { primary: { usedPercent: 100, resetsAt: 20 }, secondary: expired } }, now);
  assert.deepEqual(confirmedQuota(mixed, now), { resetsAt: 20_000 });
  assert.equal(summary([mixed], now).lowest.remaining, 0);
  const partialZero = codexLimitSnapshot({ rateLimits: { primary: { usedPercent: 100 }, secondary: { usedPercent: '50' } } }, now);
  assert.deepEqual(confirmedQuota(partialZero, now), {});
  assert.equal(confirmedQuota(codexLimitSnapshot({ rateLimits: { primary, secondary: expired } }, now), now), undefined);

  const corrected = codexLimitSnapshot({ rateLimits: { primary, secondary: { usedPercent: 50, resetsAt: 30 } } }, now);
  assert.equal(confirmedQuota(corrected, now), 'available');
  assert.equal(summary([corrected], now).lowest.remaining, 50);
  assert.equal(confirmedQuota(codexLimitSnapshot({ rateLimits: { primary, secondary: null } }, now), now), 'available');
});
