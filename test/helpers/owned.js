import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processAlive, groupAlive } from "../../src/processes.js";
export function fixture(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deps-owned-")),
    cliPath = path.join(directory, "synthetic-codex"),
    record = path.join(directory, "target.json");
  const source = String.raw`
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const mode=MODE,record=RECORD,args=process.argv.slice(2),workspace=args[args.indexOf('--cd')+1];
fs.writeFileSync(record,JSON.stringify({pid:process.pid,args,env_keys:Object.keys(process.env)}));
process.on('SIGTERM',()=>{if(!['ignore','grandchild','detached-grandchild','late','upgrade-hold'].includes(mode))process.exit(143);});
process.stdin.resume();process.stdin.on('end',()=>{
 const send=event=>console.log(JSON.stringify(event));
 send({type:'thread.started',thread_id:'synthetic-thread',extra:{original:true}});send({type:'turn.started'});
 if(['upgrade','failed-after-edit','upgrade-hold'].includes(mode)){
   const target=path.join(workspace,'src/quote.js');fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace('subtotalCents >= 5000','discountedCents >= 5000'));
   send({type:'item.completed',item:{id:'files',type:'file_change',status:'completed',changes:[{path:'src/quote.js',kind:'update'}]}});
   fs.writeFileSync(record,JSON.stringify({pid:process.pid,args,stage:'upgraded'}));
 }
 if(mode==='failed-after-edit'){send({type:'turn.failed',error:{message:'Original CLI failed after edits'},usage:{input_tokens:7,output_tokens:0}});return;}
 if(['grandchild','detached-grandchild'].includes(mode)){
   const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:mode==='detached-grandchild',stdio:'ignore'});
   fs.writeFileSync(record,JSON.stringify({pid:process.pid,grandchild:child.pid,args}));
 }
 if(['ignore','grandchild','detached-grandchild','late','upgrade-hold'].includes(mode)){
   if(mode==='late')setTimeout(()=>send({type:'item.completed',item:{id:'late',type:'agent_message',text:'Too late'}}),1500);
   setInterval(()=>{},1000);return;
 }
 if(mode==='stderr-overflow'){process.stderr.write('x'.repeat(100000));setInterval(()=>{},1000);return;}
 if(mode==='stdout-overflow'){process.stdout.write('x'.repeat(1100000));setInterval(()=>{},1000);return;}
 if(mode==='bad-json'){console.log('{bad');return;}
 if(mode==='bad-utf8'){process.stdout.write(Buffer.from([255]));return;}
 send({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Controlled final answer'}});
 if(mode==='missing-terminal')return;
 if(mode==='missing-usage'){send({type:'turn.completed'});return;}
 const usage=mode==='zero'?{input_tokens:0,output_tokens:0,cache_write_input_tokens:0}:mode==='invalid'?{input_tokens:-1,output_tokens:'bad'}:{input_tokens:20,cached_input_tokens:2,output_tokens:5,reasoning_output_tokens:1,total_tokens:99};
 send({type:'turn.completed',usage,unknown:{preserved:true}});
});
`
    .replace("MODE", JSON.stringify(mode))
    .replace("RECORD", JSON.stringify(record));
  fs.writeFileSync(cliPath, `#!${process.execPath}\n` + source, {
    mode: 0o700,
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, cliPath, record };
}
export const options = (f) => ({
  apiKey: "synthetic-not-a-paid-key",
  cliPath: f.cliPath,
});
export function cleanup(t, report) {
  for (const directory of [report.workspace, report.verification?.checkDir])
    if (directory)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
}
export function exited(f, observation) {
  const target = JSON.parse(fs.readFileSync(f.record));
  assert.equal(processAlive(target.pid), false);
  if (target.grandchild) assert.equal(processAlive(target.grandchild), false);
  assert.equal(observation.cli.lifecycle.relay_exit_confirmed, true);
  assert.equal(observation.cli.lifecycle.group_exit_confirmed, true);
  assert.equal(observation.sdk_operations_drained, true);
  assert.equal(observation.runtime_home_removed, true);
}
