const ANSI={hide:'\x1b[?25l',show:'\x1b[?25h',clear:'\x1b[2K',up:(n)=>`\x1b[${n}A`,dim:'\x1b[2m',reset:'\x1b[0m',green:'\x1b[32m',red:'\x1b[31m',cyan:'\x1b[36m',yellow:'\x1b[33m'};
const GLYPHS=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function bar(p,w=24){const n=Math.round(Math.max(0,Math.min(1,p))*w);return `${'█'.repeat(n)}${'░'.repeat(w-n)}`;}
function stageProgress(s){return({queued:0,allocated:.08,context:.18,running:.55,validating:.86,done:1,failed:1,blocked:1})[s]??0;}
export class FiberRenderer{
  constructor({stream=process.stderr,enabled=stream.isTTY}={}){this.stream=stream;this.enabled=Boolean(enabled);this.rows=new Map();this.drawn=0;this.tick=0;if(this.enabled)this.stream.write(ANSI.hide);}
  update(id,patch){const prev=this.rows.get(id)??{id,status:'queued',label:id,detail:''};this.rows.set(id,{...prev,...patch});this.render();}
  render(){if(!this.enabled)return;this.tick++;if(this.drawn)this.stream.write(ANSI.up(this.drawn));const lines=[];for(const x of this.rows.values()){const p=x.progress??stageProgress(x.status);const glyph=x.status==='done'?`${ANSI.green}✓${ANSI.reset}`:x.status==='failed'?`${ANSI.red}✗${ANSI.reset}`:x.status==='blocked'?`${ANSI.yellow}!${ANSI.reset}`:`${ANSI.cyan}${GLYPHS[this.tick%GLYPHS.length]}${ANSI.reset}`;lines.push(`${ANSI.clear}${glyph} ${String(x.id).padEnd(8)} ${bar(p)} ${String(Math.round(p*100)).padStart(3)}%  ${x.label} ${ANSI.dim}${x.detail??''}${ANSI.reset}`);}
    this.stream.write(lines.join('\n')+'\n');this.drawn=lines.length;}
  close(){if(this.enabled){this.render();this.stream.write(ANSI.show);}}
}
