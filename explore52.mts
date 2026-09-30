import { searchOptimalHC } from './src/utils/hc-search';
const BIZ_CAL: any = { workingDays:[1,2,3,4,5], dailyOpenHour:8, dailyOpenMinute:0, dailyCloseHour:20, dailyCloseMinute:0, holidays:[] };
const LABOR: any = { dailyProductiveHours:8, adherencePct:1.0, workingDaysPerWeek:5, offDaysPerWeek:2, contractualHoursSource:'derived', shifts:[], shiftPlacementEnabled:true, shiftSlapMinutes:30 };
const mk = (cats: any[], vols: Record<string,(h:number)=>number>) => {
  const out:any[]=[];
  for (let day=0;day<5;day++) for (let h=8;h<20;h++) for (let m=0;m<60;m+=30) for (const c of cats)
    out.push({intervalIndex: out.length, start:new Date(2026,2,2+day,h,m), end:new Date(2026,2,2+day,h,m+30), volume: vols[c.name](h), category:c.name});
  return out;
};
const sla = (pct:number,w:number):any => ({primaryPct:pct,primaryWindow:w,primaryUnit:'hours',boAsaEnabled:false,boAsaTarget:60,boAsaUnit:'minutes',asaClockBasis:'business_window',clockBasis:'business_time',clockStartPolicy:'next_open',occupancyCapEnabled:false,occupancyCapPct:100,confidenceLevelPct:90});
const scen: Record<string, any> = {
 s1: () => { const cats=[{id:'A',name:'A',ahtMinutes:20,shrinkagePct:0.1,priority:1,primaryPct:95},{id:'B',name:'B',ahtMinutes:25,shrinkagePct:0.1,priority:2}];
   return {cats, iv: mk(cats,{A:h=>h===8?60:4,B:h=>h>=12&&h<16?10:2}), sla: sla(85,4)}; },
 s2: () => { const cats=[{id:'A',name:'A',ahtMinutes:20,shrinkagePct:0.1,priority:1,primaryPct:97},{id:'B',name:'B',ahtMinutes:25,shrinkagePct:0.1,priority:2},{id:'C',name:'C',ahtMinutes:25,shrinkagePct:0.1,priority:2}];
   return {cats, iv: mk(cats,{A:h=>h===8?40:3,B:h=>h>=12&&h<16?12:2,C:h=>h>=13&&h<17?12:2}), sla: sla(85,3)}; },
 s3: () => { const cats=[{id:'A',name:'A',ahtMinutes:20,shrinkagePct:0.1,priority:1},{id:'B',name:'B',ahtMinutes:25,shrinkagePct:0.1,priority:2}];
   return {cats, iv: mk(cats,{A:h=>h===8?60:4,B:h=>h>=12&&h<16?10:2}), sla: sla(95,4)}; },
};
for (const name of Object.keys(scen)) {
  const s = scen[name]();
  const r:any = searchOptimalHC({intervals:s.iv, openingWIP:[], categories:s.cats, calendar:BIZ_CAL, labor:LABOR, sla:s.sla, seed:42, userMaxHC:60, replications:6, queueArchitecture:'siloed'});
  const rp = r.rosterPolish;
  console.log(name, 'HC', r.recommendedHC, rp?.status, rp?.movesApplied+'/'+rp?.movesTotal, rp?.reason?.slice(0,80));
  for (const [k,v] of Object.entries<any>(rp?.byCategory ?? {})) console.log('  ',k,v.current.minOnShift,'->',v.polished?.minOnShift);
}
