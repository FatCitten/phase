import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkerAdapter } from './adapters.mjs';
import { runCloudWorker } from './cloud-worker.mjs';
import { normalizeWorkflow } from './phase-ir.mjs';

function extractJson(text){
  const s=String(text??'').trim();
  try{return JSON.parse(s);}catch{}
  const fenced=[...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m=>m[1]);
  for(const x of fenced){try{return JSON.parse(x);}catch{}}
  const start=s.indexOf('{'),end=s.lastIndexOf('}');if(start>=0&&end>start){try{return JSON.parse(s.slice(start,end+1));}catch{}}
  throw new Error('workflow compiler did not return valid JSON');
}

export async function compileWorkflowDescription({description,cwd=process.cwd(),worker={adapter:'auto'}}={}){
  description=String(description??'').trim();if(!description)throw new Error('workflow description is required');cwd=resolve(cwd);mkdirSync(cwd,{recursive:true});
  const adapter=resolveWorkerAdapter(worker);
  const prompt=`Compile the following human workflow description into Phase Workflow IR. Do not do the work. Return ONLY JSON, no markdown.\n\nRequired shape:\n{"schema":"phase-workflow-v1","id":"...","objective":"...","cwd":"${cwd.replaceAll('\\','\\\\')}","constraints":[],"decisions":[],"defaults":{"agent":"auto","budget":{"tokens":24000,"context_tokens":12000,"wall_ms":900000,"tool_calls":40}},"fibers":[{"id":"F1","objective":"...","depends_on":[],"agent":"auto","tools":["read","edit","test"],"budget":{},"validation":[]}]}\n\nRules: fibers are independently schedulable units of progress, dependencies must be explicit, validation should be concrete commands only when inferable, subjective unresolved choices remain human decisions rather than invented requirements.\n\nDESCRIPTION\n${description}`;
  const out=await runCloudWorker({cwd,prompt,adapter,isolation:{enabled:false}});if(!out.ok)throw new Error(`workflow compiler failed: ${out.stderr||out.stdout}`);
  return normalizeWorkflow(extractJson(out.stdout),{baseDir:cwd});
}
