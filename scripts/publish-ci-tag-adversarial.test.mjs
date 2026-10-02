import assert from 'node:assert/strict';
import test from 'node:test';
import {publishCiTag} from './publish-ci-tag.mjs';
const sha='a'.repeat(40), tag=`refs/tags/ci-${sha}`;
const env={GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_REPOSITORY:'neverhuman/jankurai-audit',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'2'};
function probe(name,option={}) {
 let writes=0,reads=0,calls=0;
 const request=(endpoint,body)=>{
  calls++;
  if(body){writes++;return option.created??{ref:tag,object:{type:'commit',sha}};}
  if(endpoint.endsWith('/actions/runs/1'))return {head_sha:sha,head_branch:'main',event:'push',path:'.github/workflows/ci.yml',run_attempt:2};
  if(endpoint.includes('/attempts/2/jobs?')) {
   if(option.malformedJobs)return {jobs:null};
   if(option.unbounded)return {jobs:Array.from({length:100},()=>({name:'other'}))};
   return {jobs:[{name:'jankurai/required',head_sha:sha,status:option.status??'completed',conclusion:'success'}]};
  }
  if(endpoint.includes('/compare/'))return option.comparison??{status:'identical',merge_base_commit:{sha}};
  if(endpoint.includes('/git/ref/')) {
   reads++;
   if(option.existing)return option.existing;
   if(writes){if(option.readError)throw Object.assign(new Error('read unavailable'),{status:500});return {ref:tag,object:{type:'commit',sha}};}
   throw Object.assign(new Error('not found'),{status:404});
  }
  throw new Error('unexpected endpoint');
 };
 let value,error;try{value=publishCiTag(env,request);}catch(e){error=e.message;}
 return {name,accepted:!!value,writes,reads,calls,error};
}
const cases = [
 ['identical current main source succeeds', {}, true, 1, undefined],
 ['unfinished aggregate with success conclusion refuses', {status:'in_progress'}, false, 0, /aggregate/],
 ['behind comparison refuses', {comparison:{status:'behind',merge_base_commit:{sha}}}, false, 0, /not on main/],
 ['malformed job inventory refuses', {malformedJobs:true}, false, 0, /invalid CI job inventory/],
 ['bounded job pagination refuses unending pages', {unbounded:true}, false, 0, /supported bound/],
 ['same SHA with wrong existing ref refuses', {existing:{ref:'refs/tags/unrelated',object:{type:'commit',sha}}}, false, 0, /immutable/],
 ['wrong created ref reports uncertainty with one creation', {created:{ref:'refs/tags/unrelated',object:{type:'commit',sha}}}, false, 1, /created CI tag identity/],
 ['readback API error retains created ref', {readError:true}, false, 1, /read unavailable/],
];
for (const [name, options, accepted, writes, error] of cases) test(name, () => {
 const result=probe(name,options);
 assert.equal(result.accepted,accepted);
 assert.equal(result.writes,writes);
 if(error)assert.match(result.error,error);else assert.equal(result.error,undefined);
 if(options.unbounded)assert.equal(result.calls,101);
});
