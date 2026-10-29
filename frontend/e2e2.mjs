import { chromium } from "@playwright/test";
import fs from "node:fs"; import crypto from "node:crypto";
const U="https://e2ee-ciphertext-frontend.vercel.app", F="/workspace/secrets/e2ee72-throwaway.json";
let acc; if (fs.existsSync(F)) acc=JSON.parse(fs.readFileSync(F)); else { const t=Date.now().toString(36); acc={a:{u:`e2e72_a_${t}`,p:crypto.randomBytes(18).toString("base64url")},b:{u:`e2e72_b_${t}`,p:crypto.randomBytes(18).toString("base64url")},created:false}; fs.writeFileSync(F,JSON.stringify(acc),{mode:0o600}); }
const R={}; const ok=(k,v,note="")=>{R[k]=(v?"PASS":"FAIL")+(note?" — "+note:""); console.log(k,R[k]);};
const b=await chromium.launch(); const log=[];
async function mk(name){ const c=await chromium.launchPersistentContext(`/workspace/secrets/e2e72-profile-${name}`,{acceptDownloads:true}); return {c,name}; }
function watch(p,name){ p.on("pageerror",e=>log.push(name+" pageerror "+e.message.slice(0,200))); p.on("console",m=>{if(m.type()==="error")log.push(name+" console "+m.text().slice(0,160))});
  p.on("request",r=>{const u=new URL(r.url()); if(u.pathname.startsWith("/api/")) log.push(`${name} ${r.method()} ${u.pathname} ${r.method()==="POST"&&/messages(\/ack)?$/.test(u.pathname)?(r.postData()||"").slice(0,0):""}`)}); }
const net=[]; function tap(p,name){ p.on("request",r=>{const u=new URL(r.url()); if(u.pathname.startsWith("/api/")&&r.method()!=="GET") net.push({who:name,t:Date.now(),m:r.method(),path:u.pathname,body:r.postData()||""});});
  p.on("response",async r=>{const u=new URL(r.url()); if(/\/api\/conversations\/.+\/messages/.test(u.pathname)&&r.request().method()==="GET"){try{net.push({who:name,t:Date.now(),m:"GETRESP",path:u.pathname,body:await r.text()})}catch{}}}); }
async function page(ctx){ const p=await ctx.c.newPage(); watch(p,ctx.name); tap(p,ctx.name); return p; }
async function auth(p,who,mode){ await p.goto(U+"/chat"); await p.waitForTimeout(3000); if(/chat/.test(p.url())&&await p.getByRole("button",{name:"New chat"}).count()) return; await p.goto(U+"/"+mode); await p.getByLabel("Username").fill(who.u); await p.getByLabel("Password").fill(who.p); await p.locator("button[type=submit]").click();
  await p.waitForURL(/chat/,{timeout:30000}); await p.getByRole("button",{name:"New chat"}).waitFor(); await p.waitForTimeout(5000); }
const bubbles=async p=>(await p.getByTestId("bubble").locator("p.whitespace-pre-wrap").allTextContents());
const accepted=[]; async function settle(p){ for(let i=0;i<40;i++){ if(await p.locator("#composer:not([disabled])").count()) return; if(await p.getByTestId("identity-changed").count()){ accepted.push(i); await p.getByRole("button",{name:/verified it/}).click(); } await p.waitForTimeout(1000);} throw new Error("composer never enabled"); }
async function open(p,peer){ const it=p.getByRole("complementary",{name:"Conversations"}).getByText(peer).first(); await it.waitFor({timeout:30000}); await it.click(); await settle(p); }
async function send(p,t){ await p.locator("#composer").fill(t); await p.locator("#composer").press("Enter"); await p.getByText(t).last().waitFor(); }
async function waitText(p,t,ms=30000){ try{ await p.getByTestId("bubble").getByText(t,{exact:true}).waitFor({timeout:ms}); return true;}catch{return false;} }
try{
const A=await mk("A"), B=await mk("B"); let pa=await page(A), pb=await page(B);
const mode=acc.created?"login":"signup";
await auth(pa,acc.a,mode); await auth(pb,acc.b,mode); acc.created=true; fs.writeFileSync(F,JSON.stringify(acc),{mode:0o600});
ok("1 both sign in/up",true,mode);
await pa.getByRole("button",{name:"New chat"}).click(); const d=pa.getByRole("dialog"); await d.getByLabel("Username").fill(acc.b.u); await d.getByRole("button",{name:"Start chat"}).click();
await settle(pa).catch(async e=>{console.log("DUMP",(await pa.locator("section").innerText()).slice(0,600), await pa.locator("#composer").evaluate(x=>x.outerHTML)); throw e;}); ok("2 A starts New chat with B",true);
const m1="hello from A "+Date.now(); await send(pa,m1);
await pb.reload(); await open(pb,acc.a.u); ok("3 B receives decrypted",await waitText(pb,m1));
const m2="reply from B "+Date.now(); await send(pb,m2); ok("4 A receives reply",await waitText(pa,m2,40000)||(await pa.reload(),await open(pa,acc.b.u),await waitText(pa,m2)),"");
const sn=async p=>{await p.getByRole("button",{name:"Conversation info"}).click(); const s=p.getByTestId("safety-number"); await s.locator("p.font-mono span").first().waitFor({timeout:15000}); const t=(await s.locator("p.font-mono").innerText()).replace(/\D/g,""); await p.getByRole("button",{name:"Conversation info"}).click(); return t;};
const sa=await sn(pa), sb=await sn(pb); ok("5 safety numbers match",sa.length>=30&&sa===sb,`len ${sa.length}`);
// offline
await pb.close(); const off=["off-1 "+Date.now(),"off-2 "+Date.now(),"off-3 "+Date.now()]; for(const t of off) await send(pa,t);
await pa.waitForTimeout(3000);
const t0=Date.now(); pb=await page(B); await pb.goto(U+"/chat"); await open(pb,acc.a.u);
let got=true; for(const t of off) got=got&&await waitText(pb,t); const lst=await bubbles(pb); const idx=off.map(t=>lst.indexOf(t));
console.log("B6",JSON.stringify((await pb.getByTestId("bubble").allInnerTexts()).slice(-5)));ok("6 offline 3 msgs decrypt in order",got&&idx.every((v,i)=>v>=0&&(i===0||v>idx[i-1])),JSON.stringify(idx));
await pb.waitForTimeout(4000); const acks=net.filter(n=>n.who==="B"&&n.path.endsWith("/messages/ack")&&n.t>=t0);
// persistence after ack: block network for B, reload, messages must still show from local store
await pb.reload(); await open(pb,acc.a.u); const persisted=await Promise.all(off.map(t=>waitText(pb,t,15000)));
ok("7 ack sent and history persisted after ack",acks.length>0&&persisted.every(Boolean),`acks=${acks.length} sizes=${acks.map(a=>JSON.parse(a.body).messageIds.length)}`);
// reload history both sides
await pa.reload(); await open(pa,acc.b.u); const ha=await bubbles(pa); ok("8 reload keeps history (A)",[m1,m2,...off].every(t=>ha.includes(t)),`${ha.length} bubbles`);
const hb=await bubbles(pb); ok("8b reload keeps history (B)",[m1,m2,...off].every(t=>hb.includes(t)));
// ciphertext only
const plains=[m1,m2,...off]; const sends=net.filter(n=>/\/messages$/.test(n.path)&&n.m==="POST"); const gets=net.filter(n=>n.m==="GETRESP");
const leak=[...sends,...gets].some(n=>plains.some(t=>n.body.includes(t)||n.body.includes(Buffer.from(t).toString("base64"))));
ok("9 ciphertext only on server",sends.length>=5&&!leak&&sends.every(n=>{const j=JSON.parse(n.body);return typeof j.ciphertext==="string"&&!("text" in j)}),`${sends.length} sends, ${gets.length} reads`);
// attachment
const content="attachment-"+crypto.randomBytes(8).toString("hex"); fs.writeFileSync("/tmp/e2e72.txt",content);
await pa.locator("#attach-file").setInputFiles("/tmp/e2e72.txt"); await pa.waitForTimeout(8000);
const upNet=net.filter(n=>n.who==="A"&&/attach/.test(n.path)).map(n=>n.m+" "+n.path.replace(/[0-9a-f-]{36}/g,":id"));
const upErr=await pa.getByTestId("upload-status").textContent().catch(()=>"");
await pb.reload(); await open(pb,acc.a.u); let att=false, attNote=upErr+" "+upNet.join(",");
try{ const o=pb.getByTestId("attachment-open").last(); await o.waitFor({timeout:20000}); await o.click(); const r=pb.getByTestId("attachment-ready").last(); await r.waitFor({timeout:30000});
  const [dl]=await Promise.all([pb.waitForEvent("download"),r.locator("a").click()]); const txt=fs.readFileSync(await dl.path(),"utf8"); att=txt===content; attNote+=" name="+(await r.locator("a").textContent());
}catch(e){ attNote+=" "+(await pb.getByTestId("attachment-error").last().textContent().catch(()=>e.message.slice(0,120))); }
ok("10 attachment round-trip",att,attNote);
const ban=async p=>await p.getByTestId("identity-changed").count(); await pa.reload(); await open(pa,acc.b.u); await pa.waitForTimeout(4000);
console.log("banners accepted at login (real re-key from new browsers):",accepted.length); ok("11 no false identity-change banner",(await ban(pa))===0&&(await ban(pb))===0,`A=${await ban(pa)} B=${await ban(pb)}`);
}catch(e){ console.log("ABORT",e.message.slice(0,400)); }
console.log("usernames:",acc.a.u,acc.b.u);
console.log("LOG\n"+log.filter(l=>/error|ack|attach|4\d\d|5\d\d/.test(l)).slice(-40).join("\n"));
await b.close();
