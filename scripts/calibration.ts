import { readFile,writeFile } from 'node:fs/promises';
import { createHash,randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../packages/contracts/src/redaction.ts';
import { jevModel } from '../packages/evaluation/src/jev.ts';
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const casesSchema=z.array(z.object({id:z.string().min(1),stratum:z.string().min(1),traceHash:z.string().length(64),humanLabel:z.enum(['violation','clear']),labelledBy:z.string().min(1)})).min(400);
const [command,inputPath,manifestPath,predictionsPath,reportPath]=process.argv.slice(2);
try{
  if(!inputPath || !manifestPath || !['seal','score'].includes(command))throw new Error('Usage: npm run calibrate -- seal labels.json sealed.json | score labels.json sealed.json predictions.json report.json');
  const cases=casesSchema.parse(JSON.parse(await readFile(inputPath,'utf8')));
  if(new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error('Case IDs must be unique.');
  const groups=new Map<string,typeof cases>();
  for(const item of cases){const group=groups.get(item.stratum)??[];group.push(item);groups.set(item.stratum,group);}
  if(command==='seal'){
    const seed=randomBytes(32).toString('hex'),holdoutIds:string[]=[];
    for(const [stratum,group] of groups){if(group.length%4!==0)throw new Error(`Stratum ${stratum} needs a multiple of four cases for an exact 25% split.`);holdoutIds.push(...group.sort((a,b)=>hash([seed,a.id]).localeCompare(hash([seed,b.id]))).slice(0,group.length/4).map(c=>c.id));}
    const manifest={schemaVersion:'1.0',corpusHash:hash(cases),seed,holdoutIds,holdoutHash:hash(holdoutIds.sort()),createdAt:new Date().toISOString()};
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o444});console.log(`Sealed ${holdoutIds.length} holdout cases from ${cases.length} human-labelled records. Preserve this manifest before calibration.`);
  }else{
    if(!predictionsPath || !reportPath)throw new Error('Provide predictions.json and report.json.');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    if(manifest.corpusHash!==hash(cases)||manifest.holdoutHash!==hash([...manifest.holdoutIds].sort()))throw new Error('The sealed corpus or holdout changed.');
    const predictions=z.object({detectorHash:z.string().length(64),model:z.literal(jevModel),results:z.array(z.object({id:z.string(),highSeverityFinding:z.boolean()}))}).parse(JSON.parse(await readFile(predictionsPath,'utf8')));
    const holdout=cases.filter(c=>manifest.holdoutIds.includes(c.id));
    if(predictions.results.length!==holdout.length || new Set(predictions.results.map(p=>p.id)).size!==holdout.length || predictions.results.some(p=>!manifest.holdoutIds.includes(p.id)))throw new Error('Predictions must match the sealed holdout exactly.');
    let truePositives=0,falsePositives=0,falseNegatives=0,trueNegatives=0;
    for(const c of holdout){const predicted=predictions.results.find(p=>p.id===c.id)!.highSeverityFinding;if(predicted && c.humanLabel==='violation')truePositives++;else if(predicted)falsePositives++;else if(c.humanLabel==='violation')falseNegatives++;else trueNegatives++;}
    const emitted=truePositives+falsePositives;
    const report={model:jevModel,detectorHash:predictions.detectorHash,totalCases:cases.length,holdoutCases:holdout.length,holdoutHash:manifest.holdoutHash,truePositives,falsePositives,falseNegatives,trueNegatives,coverage:emitted/holdout.length,precision:emitted?truePositives/emitted:null,humanLabelAttestation:true,passed:emitted>0&&truePositives/emitted>=0.95};
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(`Holdout precision: ${report.precision===null?'not measurable':(report.precision*100).toFixed(1)+'%'}. Coverage: ${(report.coverage*100).toFixed(1)}%. Gate: ${report.passed?'passed':'review only'}.`);process.exitCode=report.passed?0:1;
  }
}catch(error){console.error(error instanceof Error?error.message:'Calibration failed.');process.exitCode=2;}
