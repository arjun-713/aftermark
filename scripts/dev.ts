import { spawn } from 'node:child_process';
const commands=[['npm',['run','dev:api']],['npm',['run','dev:web']],['npm',['run','dev:worker']]] as const;
const children=commands.map(([command,args])=>spawn(command,[...args],{stdio:'inherit',env:process.env}));
let closing=false;
const close=(code:number)=>{if(closing)return;closing=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),500).unref();};
for(const child of children){child.on('error',()=>close(1));child.on('exit',code=>{if(!closing)close(code??1);});}
process.once('SIGINT',()=>close(0));process.once('SIGTERM',()=>close(0));
