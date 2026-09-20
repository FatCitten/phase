import { PHASE_ARCHITECTURE_SEED, seedHash, seedSystemPrompt } from './phase-seeds.mjs';
import { encodeAllocationState } from './phase-features.mjs';

function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function pickJson(raw){const s=String(raw??'').trim();try{return JSON.parse(s);}catch{}const m=s.match(/\{[\s\S]*\}/);if(!m)throw new Error('allocator model returned no JSON object');return JSON.parse(m[0]);}
async function modelDecision({config,state,seed}){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),Number(config.timeout_ms??30000));
  try{
    const url=`${String(config.base_url??'http://127.0.0.1:8080/v1').replace(/\/$/,'')}/chat/completions`;
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.PHASE_ALLOCATOR_API_KEY??'no-key'}`},body:JSON.stringify({model:String(config.model??'phase-tpm-allocator'),temperature:0,max_tokens:256,messages:[{role:'system',content:seedSystemPrompt(seed)},{role:'user',content:JSON.stringify(state)}]}),signal:ctl.signal});
    if(!r.ok)throw new Error(`allocator model ${r.status}: ${await r.text()}`);const p=await r.json();return pickJson(p?.choices?.[0]?.message?.content);
  }finally{clearTimeout(timer);}
}

export class PhaseAllocator {
  constructor({ seed = PHASE_ARCHITECTURE_SEED, policy = 'heuristic', model = null } = {}) { this.seed=seed;this.seedHash=seedHash(seed);this.policy=policy;this.model=model??{}; }
  heuristic({ workflow, fiber, runtime = {}, availableAgents = [] }) {
    const b=fiber.budget; const failures=Number(runtime.validation_failures??0); const misses=Number(runtime.context_misses??0);
    const growth=clamp(1 + failures*.25 + misses*.15,1,1.8);
    const context=Math.round(Math.min(Number(b.context_tokens), Number(b.context_tokens)*this.seed.priors.initial_context_fraction*growth));
    const agentSpec=fiber.agent;const requested=typeof agentSpec==='string'?agentSpec:String(agentSpec?.id??agentSpec?.adapter??'exec');
    const agent=requested==='auto' ? (availableAgents.find(x=>x.available)?.id ?? 'auto') : requested;
    return {schema:'phase-allocation-v1',fiber_id:fiber.id,agent,agent_spec:typeof agentSpec==='object'?agentSpec:null,tools:[...fiber.tools],budget:{...b,context_tokens:context},reserve:{fraction:this.seed.priors.reserve_fraction,repair_fraction:this.seed.priors.repair_reserve_fraction},stop:{on_validation_pass:true,max_wall_ms:Number(b.wall_ms),max_tool_calls:Number(b.tool_calls)},state_vector:encodeAllocationState({workflow,fiber,runtime}),seed_hash:this.seedHash,policy:'heuristic'};
  }
  async allocate(args) {
    const base=this.heuristic(args);if(this.policy!=='model')return base;
    const {fiber,availableAgents=[]}=args;
    const allowedAgents=new Set([base.agent,...availableAgents.filter(x=>x.available).map(x=>x.id)]);
    try{
      const decision=await modelDecision({config:this.model,seed:this.seed,state:{state_vector:base.state_vector,budget_ceiling:fiber.budget,allowed_agents:[...allowedAgents],allowed_tools:fiber.tools,seed_hash:this.seedHash}});
      const agent=allowedAgents.has(String(decision.agent))?String(decision.agent):base.agent;
      const allowedTools=new Set(fiber.tools);const tools=(Array.isArray(decision.tools)?decision.tools:base.tools).map(String).filter(x=>allowedTools.has(x));
      const b=fiber.budget;const budget={...base.budget,context_tokens:Math.round(clamp(Number(decision.context_tokens??base.budget.context_tokens),1,Number(b.context_tokens))),wall_ms:Math.round(clamp(Number(decision.wall_ms??base.budget.wall_ms),1000,Number(b.wall_ms))),tool_calls:Math.round(clamp(Number(decision.tool_calls??base.budget.tool_calls),1,Number(b.tool_calls)))};
      return {...base,agent,tools:tools.length?tools:base.tools,budget,policy:'model',model_decision:{action:String(decision.action??'allocate'),raw:decision}};
    }catch(error){if(this.model.required)throw error;return{...base,policy:'heuristic-fallback',model_error:String(error)};}
  }
}
