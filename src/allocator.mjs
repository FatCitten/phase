import { PHASE_ARCHITECTURE_SEED, seedHash, seedSystemPrompt } from './phase-seeds.mjs';
import { encodeAllocationState } from './phase-features.mjs';

function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function pickJson(raw){const s=String(raw??'').trim();try{return JSON.parse(s);}catch{}const m=s.match(/\{[\s\S]*\}/);if(!m)throw new Error('allocator model returned no JSON object');return JSON.parse(m[0]);}

export function parseAllocatorAssembly(raw){
  const d={tools:[]};let recognized=0;
  for(const rawLine of String(raw??'').split(/\r?\n/)){
    const line=rawLine.replace(/;.*/,'').trim();if(!line)continue;const p=line.split(/\s+/),op=p.shift()?.toUpperCase();
    if(op==='ROUTE'&&p[0]){d.agent=p[0];recognized++;continue;}
    if(op==='GRANT'&&p[0]){d.tools.push(p[0]);recognized++;continue;}
    if(op==='ALLOC'&&p.length>=2){const r=p[0].toUpperCase(),n=Number(p[1]);if(!Number.isFinite(n))continue;const key={CONTEXT_TOKENS:'context_tokens',TOKENS:'tokens',WALL_MS:'wall_ms',TOOL_CALLS:'tool_calls',MONEY_MICROUNITS:'money_microunits',HUMAN_ATTENTION_MICROUNITS:'human_attention_microunits'}[r];if(key){d[key]=n;recognized++;}continue;}
  }
  if(!recognized)throw new Error('allocator model returned no Phase assembly');d.action='allocate';d.asm=String(raw??'').trim();return d;
}

async function modelDecision({config,state,seed}){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),Number(config.timeout_ms??30000));
  try{
    const url=`${String(config.base_url??'http://127.0.0.1:8080/v1').replace(/\/$/,'')}/chat/completions`;
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.PHASE_ALLOCATOR_API_KEY??'no-key'}`},body:JSON.stringify({model:String(config.model??'phase-tpm-allocator'),temperature:0,max_tokens:192,messages:[{role:'system',content:seedSystemPrompt(seed)},{role:'user',content:JSON.stringify(state)}]}),signal:ctl.signal});
    if(!r.ok)throw new Error(`allocator model ${r.status}: ${await r.text()}`);const p=await r.json();const raw=p?.choices?.[0]?.message?.content??'';try{return parseAllocatorAssembly(raw);}catch{return pickJson(raw);}
  }finally{clearTimeout(timer);}
}

export function allocationToAssembly(allocation){
  const lines=[`ROUTE ${allocation.agent}`];const b=allocation.budget??{};for(const [key,name] of [['context_tokens','CONTEXT_TOKENS'],['tokens','TOKENS'],['wall_ms','WALL_MS'],['tool_calls','TOOL_CALLS'],['money_microunits','MONEY_MICROUNITS'],['human_attention_microunits','HUMAN_ATTENTION_MICROUNITS']])if(Number.isFinite(Number(b[key])))lines.push(`ALLOC ${name} ${Math.round(Number(b[key]))}`);for(const t of allocation.tools??[])lines.push(`GRANT ${t}`);return lines.join('\n');
}

export class PhaseAllocator {
  constructor({ seed = PHASE_ARCHITECTURE_SEED, policy = 'heuristic', model = null } = {}) { this.seed=seed;this.seedHash=seedHash(seed);this.policy=policy;this.model=model??{}; }
  heuristic({ workflow, fiber, runtime = {}, availableAgents = [] }) {
    const b=fiber.budget; const failures=Number(runtime.validation_failures??0); const misses=Number(runtime.context_misses??0);
    const growth=clamp(1 + failures*.25 + misses*.15,1,1.8);
    const context=Math.round(Math.min(Number(b.context_tokens), Number(b.context_tokens)*this.seed.priors.initial_context_fraction*growth));
    const agentSpec=fiber.agent;const requested=typeof agentSpec==='string'?agentSpec:String(agentSpec?.id??agentSpec?.adapter??'exec');
    const agent=requested==='auto' ? (availableAgents.find(x=>x.available)?.id ?? 'auto') : requested;
    const allocation={schema:'phase-allocation-v1',fiber_id:fiber.id,agent,agent_spec:typeof agentSpec==='object'?agentSpec:null,tools:[...fiber.tools],budget:{...b,context_tokens:context},reserve:{fraction:this.seed.priors.reserve_fraction,repair_fraction:this.seed.priors.repair_reserve_fraction},stop:{on_validation_pass:true,max_wall_ms:Number(b.wall_ms),max_tool_calls:Number(b.tool_calls)},state_vector:encodeAllocationState({workflow,fiber,runtime}),seed_hash:this.seedHash,policy:'heuristic'};
    allocation.asm=allocationToAssembly(allocation);return allocation;
  }
  async allocate(args) {
    const base=this.heuristic(args);if(this.policy!=='model')return base;
    const {fiber,availableAgents=[]}=args;
    const allowedAgents=new Set([base.agent,...availableAgents.filter(x=>x.available).map(x=>x.id)]);
    try{
      const decision=await modelDecision({config:this.model,seed:this.seed,state:{state_vector:base.state_vector,budget_ceiling:fiber.budget,allowed_agents:[...allowedAgents],allowed_tools:fiber.tools,seed_hash:this.seedHash}});
      const agent=allowedAgents.has(String(decision.agent))?String(decision.agent):base.agent;
      const allowedTools=new Set(fiber.tools);const tools=(Array.isArray(decision.tools)?decision.tools:base.tools).map(String).filter(x=>allowedTools.has(x));
      const b=fiber.budget;const budget={...base.budget,context_tokens:Math.round(clamp(Number(decision.context_tokens??base.budget.context_tokens),1,Number(b.context_tokens))),tokens:Math.round(clamp(Number(decision.tokens??base.budget.tokens),1,Number(b.tokens))),wall_ms:Math.round(clamp(Number(decision.wall_ms??base.budget.wall_ms),1000,Number(b.wall_ms))),tool_calls:Math.round(clamp(Number(decision.tool_calls??base.budget.tool_calls),1,Number(b.tool_calls))),money_microunits:Math.round(clamp(Number(decision.money_microunits??base.budget.money_microunits),0,Number(b.money_microunits))),human_attention_microunits:Math.round(clamp(Number(decision.human_attention_microunits??base.budget.human_attention_microunits),0,Number(b.human_attention_microunits)))};
      const out={...base,agent,tools:tools.length?tools:base.tools,budget,policy:'model',model_decision:{action:String(decision.action??'allocate'),raw:decision}};out.asm=allocationToAssembly(out);return out;
    }catch(error){if(this.model.required)throw error;return{...base,policy:'heuristic-fallback',model_error:String(error)};}
  }
}
