// Optional isolated browser integration: mocks Supabase and both video players.
// Example: ZEUS_PLAYWRIGHT_MODULE=/path/to/playwright-core ZEUS_CHROMIUM_PATH=/path/to/chromium node tests/watchparty-browser.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.ZEUS_PLAYWRIGHT_MODULE || 'playwright-core');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let base;
let server;
const publicDir = path.join(__dirname, '..', 'public');
const CODE='1234567890ABCDEF1234';
const users = new Map();
let room = null, messages = [], calls = [], nextMsg=1;
function snapshot(id) {
  return { you:id, server_now:new Date().toISOString(), room: structuredClone(room),
    members:[...users.values()].map(u=>({id:u.id,name:u.name,host:u.id===room.host_id,online:true})), messages:structuredClone(messages) };
}
function rpc(id, name, p) {
  calls.push({id,name,p:structuredClone(p)});
  if(name==='zeus_party_create') {
    room = {code:CODE,host_id:id,provider:p.p_provider,media_type:p.p_media_type,tmdb_id:p.p_tmdb_id,season:p.p_season,episode:p.p_episode,title:p.p_title,playing:false,position_seconds:0,state_updated_at:new Date().toISOString(),revision:0,ended:false};
    users.set(id,{id,name:p.p_name}); return snapshot(id);
  }
  if(name==='zeus_party_join') {
    if(!room || room.ended || p.p_code!==CODE) throw new Error('Party not found or has ended');
    users.set(id,{id,name:p.p_name}); return snapshot(id);
  }
  if(!room || !users.has(id)) { const error = new Error('Party not found or access denied'); error.code = '42501'; throw error; }
  if(name==='zeus_party_snapshot') return snapshot(id);
  if(name==='zeus_party_heartbeat') return null;
  if(name==='zeus_party_playback') {
    if(id!==room.host_id) throw new Error('Only the host can control playback');
    room.position_seconds=p.p_time; room.state_updated_at=new Date().toISOString(); room.revision++;
    if(['play','sync_play'].includes(p.p_action)) room.playing=true;
    if(['pause','sync_pause'].includes(p.p_action)) room.playing=false;
    return null;
  }
  if(name==='zeus_party_set_provider') {
    if(id!==room.host_id) throw new Error('Only the host can change players');
    room.provider=p.p_provider; room.position_seconds=p.p_time; room.playing=false; room.revision++; room.state_updated_at=new Date().toISOString(); return null;
  }
  if(name==='zeus_party_chat') {messages.push({id:nextMsg++,user_id:id,name:users.get(id).name,body:p.p_body,created_at:new Date().toISOString()}); return null;}
  if(name==='zeus_party_leave') { if(id===room.host_id) room.playing=false; users.delete(id); return null; }
  if(name==='zeus_party_end') { if(id!==room.host_id) throw new Error('Only the host can end'); room.ended=true; return null; }
  throw new Error('Unknown method '+name);
}
const fixture = (provider) => `<!doctype html><meta charset="utf-8"><style>body{background:#17191c;color:white;font:14px sans-serif}button{margin:12px;padding:14px}</style><button id="play">Play</button><button id="pause">Pause</button><button id="seek">Seek to 120</button><script>
let time=0,paused=true;window.commands=[];
const provider=${JSON.stringify(provider)};
function emit(event,extra={}) {let data=provider==='vidspark'?{source:'vidspark-player',event,currentTime:time,duration:1000,paused,...extra}:{type:'cinesrc:'+event,currentTime:time,duration:1000,...extra}; parent.postMessage(data,'*')}
function play(){paused=false;emit('play')} function pause(){paused=true;emit('pause')} function seek(t){time=Number(t);emit('seeked')}
document.querySelector('#play').onclick=play;document.querySelector('#pause').onclick=pause;document.querySelector('#seek').onclick=()=>seek(120);
addEventListener('message',e=>{const d=e.data;window.commands.push(d);let action=provider==='vidspark'?d.action:d.command;
if(action==='getStatus') emit('playerstatus'); else if(action==='getCurrentTime') emit('response',{command:action,result:time}); else if(action==='getPaused') emit('response',{command:action,result:paused}); else if(action==='play') play();else if(action==='pause')pause();else if(action==='seek')seek(provider==='vidspark'?d.time:d.args[0]);});
window.getFakeState=()=>({time,paused,commands:window.commands});setInterval(()=>{if(!paused){time+=0.5;emit('timeupdate')}},500); if(provider==='cinesrc')setTimeout(()=>emit('ready'),50);
</script>`;
let browser;
(async()=>{
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/^\/+/, '');
    const file = path.resolve(publicDir, name);
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      const type = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, {'content-type':type}); res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser=await chromium.launch({executablePath:process.env.ZEUS_CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const errors=[];
  async function context(id,viewport={width:1280,height:800},mock=true) {
    const ctx=await browser.newContext({viewport});
    await ctx.addInitScript(({id,mock})=>{
      localStorage.setItem('zeus_intro_seen_v1','1');
      if (!mock) return;
      window.__channels=[];
      window.__channelConfigs=[];
      window.supabase={createClient:(_url,_key,options)=>{window.__authUsesSession = options.auth.storage === sessionStorage; return ({
        auth:{getSession:async()=>({data:{session:{access_token:'mock'}}}),signInAnonymously:async()=>({data:{session:{access_token:'mock'}}})},
        realtime:{setAuth:async()=>{}},
        rpc:async(name,params)=>{const r=await fetch('/__test_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name,params})});return r.json()},
        channel:(topic,config)=>{window.__channelConfigs.push({topic,config});const c={on(_type,_filter,fn){this.broadcast=fn;return this},subscribe(fn){this.status=fn;window.__channels.push(this);setTimeout(()=>fn('SUBSCRIBED'),10);return this}};return c},
        removeChannel:async()=>{}
      })}};
    },{id,mock});
    await ctx.route('**/*',async route=>{
      const req=route.request(), url=req.url();
      if(url.startsWith(base+'/__test_rpc')) {
        let input=JSON.parse(req.postData());
        try { await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:rpc(input.id,input.name,input.params),error:null})}); }
        catch(e){await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:null,error:{message:e.message,code:e.code}})});}
      } else if(url.startsWith('https://vidspark.to/')) await route.fulfill({status:200,contentType:'text/html',body:fixture('vidspark')});
      else if(url.startsWith('https://cinesrc.st/')) await route.fulfill({status:200,contentType:'text/html',body:fixture('cinesrc')});
      else if(url.startsWith('https://vidora.ac/')) await route.fulfill({status:200,contentType:'text/html',body:'<body>Mock Vidora</body>'});
      else if(url.startsWith(base)) await route.continue();
      else await route.abort();
    });
    const page=await ctx.newPage();page.on('pageerror',e=>errors.push(`${id}: ${e}`));
    return {ctx,page};
  }
  const host=await context('host'), guest=await context('guest');
  await Promise.all([host.page.goto(base+'/watch.html?id=533533&type=movie'),guest.page.goto(base+'/watch.html?id=533533&type=movie')]);
  await host.page.waitForSelector('#watch-party-btn');
  await host.page.locator('#watch-party-btn').click();
  await host.page.locator('#wp-name').fill('Host');
  assert.equal(await host.page.locator('#wp-create-provider').inputValue(),'vidspark');
  await host.page.locator('.wp-create').click();
  await host.page.waitForSelector('.wp-room:not([hidden])');
  await host.page.waitForFunction(()=>document.querySelector('#player-frame').src.startsWith('https://vidspark.to/'));
  assert.equal(await host.page.locator('.wp-role').textContent(),'YOU ARE THE HOST');
  // The first play can happen before the initial two-second status poll.
  await host.page.frameLocator('#player-frame').locator('#play').click();
  await host.page.waitForTimeout(300);
  assert.equal(room.playing,true,'the first host play reached the room');
  await host.page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedInvite = text; } } }));
  await host.page.locator('.wp-copy').click();
  const invite = new URL(await host.page.evaluate(() => window.__copiedInvite));
  assert.equal(invite.searchParams.get('id'), '533533');
  assert.equal(new URLSearchParams(invite.hash.slice(1)).get('party'), CODE);
  assert.equal(invite.searchParams.has('token'), false, 'invite does not include the host session');
  await guest.page.locator('#watch-party-btn').click();
  await guest.page.locator('#wp-name').fill('<b>Guest</b>');
  await guest.page.locator('#wp-code-input').fill(invite.href);
  await guest.page.locator('.wp-join').click();
  await guest.page.waitForSelector('.wp-room:not([hidden])');
  assert.equal(await guest.page.locator('.wp-role').textContent(),'YOU ARE A GUEST');
  assert.equal(await guest.page.locator('#wp-provider').isDisabled(),true);
  const channelConfig = await guest.page.evaluate(()=>window.__channelConfigs[0]);
  assert.equal(channelConfig.topic, 'zeus-party:' + CODE);
  assert.equal(channelConfig.config.config.private, true, 'private Realtime channel requested');
  assert.equal(await guest.page.evaluate(()=>window.__authUsesSession), true, 'authentication is isolated per tab');
  const forcedGuestAction = await guest.page.evaluate(async (code) => {
    const response = await fetch('/__test_rpc', {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:'guest',name:'zeus_party_playback',params:{p_code:code,p_action:'play',p_time:900}})});
    return response.json();
  }, CODE);
  assert.match(forcedGuestAction.error.message, /Only the host/);
  assert.match(await guest.page.locator('.wp-members').textContent(),/<b>Guest<\/b>/);
  assert.equal(await guest.page.locator('.wp-members b').count(),0);
  async function wake(page){await page.evaluate(()=>window.__channels.at(-1)?.broadcast?.({payload:{}}));}
  async function playerState(page){return page.frameLocator('#player-frame').locator('body').evaluate(()=>window.getFakeState())}
  await host.page.evaluate(()=>window.postMessage({source:'vidspark-player',event:'pause',currentTime:999},'*'));
  await host.page.waitForTimeout(150);
  assert.equal(calls.some(c=>c.id==='host' && c.name==='zeus_party_playback' && c.p.p_time===999),false,'forged window message ignored');
  await wake(guest.page);
  await guest.page.waitForTimeout(3700);
  assert.equal((await playerState(guest.page)).paused,false,'guest received play');
  await host.page.frameLocator('#player-frame').locator('#pause').click();
  await host.page.waitForTimeout(300); assert.equal(room.playing,false);
  await wake(guest.page); await guest.page.waitForTimeout(3200);
  assert.equal((await playerState(guest.page)).paused,true,'guest received pause');
  await guest.page.frameLocator('#player-frame').locator('#play').click();
  await guest.page.waitForTimeout(3500); assert.equal(room.playing,false,'guest cannot change shared state');
  assert.equal((await playerState(guest.page)).paused,true,'guest local play corrected');
  await host.page.frameLocator('#player-frame').locator('#seek').click();
  await host.page.waitForTimeout(500); assert.ok(room.position_seconds>=120 && room.position_seconds<122,'host seek reached room');
  await wake(guest.page); await guest.page.waitForTimeout(3200);
  assert.ok((await playerState(guest.page)).time>=119,'guest received seek');
  await guest.page.locator('.wp-chat-tab').click();
  await guest.page.locator('#wp-chat-input').fill('<img src=x onerror=alert(1)>');
  await guest.page.locator('.wp-send').click(); await guest.page.waitForTimeout(250); await wake(host.page);
  await host.page.locator('.wp-chat-tab').click(); await host.page.waitForTimeout(500);
  assert.match(await host.page.locator('.wp-messages').textContent(),/<img src=x onerror=alert\(1\)>/);
  assert.equal(await host.page.locator('.wp-messages img').count(),0);
  const other=await context('other');
  await other.page.goto(base+'/watch.html?id=42&type=movie');
  await other.page.locator('#watch-party-btn').click();
  await other.page.locator('#wp-name').fill('Other');
  await other.page.locator('#wp-code-input').fill(CODE);
  await other.page.locator('.wp-join').click();
  await other.page.waitForURL(url=>url.searchParams.get('id')==='533533');
  await other.page.waitForSelector('.wp-room:not([hidden])');
  assert.equal(await other.page.locator('.wp-role').textContent(), 'YOU ARE A GUEST', 'pasted code follows the correct title');
  await other.page.locator('.wp-leave').click();
  await other.page.waitForSelector('.wp-welcome:not([hidden])');
  assert.equal(users.has('other'),false,'guest can leave without ending the room');
  await guest.page.evaluate(()=>window.__channels.at(-1).status('CHANNEL_ERROR'));
  await guest.page.waitForFunction(()=>window.__channels.length>=2,{timeout:6000});
  assert.match(await guest.page.locator('.wp-connection').textContent(),/Live updates|Checking periodically/);
  users.delete('guest'); // simulate a long-offline member being pruned
  await wake(guest.page); await guest.page.waitForTimeout(600);
  assert.equal(users.has('guest'),true,'long-offline guest automatically rejoins with the same identity');
  await host.page.locator('.wp-party-tab').click();
  await host.page.locator('.wp-leave').click();
  await host.page.waitForSelector('.wp-welcome:not([hidden])');
  await wake(guest.page);
  await guest.page.waitForFunction(()=>document.querySelector('.wp-player-notice').textContent.includes('host is away'));
  await host.page.locator('#wp-code-input').fill(CODE);
  await host.page.locator('.wp-join').click();
  await host.page.waitForSelector('.wp-room:not([hidden])');
  assert.equal(await host.page.locator('.wp-role').textContent(),'YOU ARE THE HOST','departed host can rejoin without promoting a guest');
  await wake(guest.page);
  await host.page.reload(); await host.page.waitForSelector('.wp-room:not([hidden])');
  assert.equal(await host.page.locator('.wp-role').textContent(),'YOU ARE THE HOST','host identity survives same-tab reload');
  await host.page.locator('#wp-provider').selectOption('cinesrc');
  await host.page.waitForFunction(()=>document.querySelector('#player-frame').src.startsWith('https://cinesrc.st/'));
  await wake(guest.page); await guest.page.waitForFunction(()=>document.querySelector('#player-frame').src.startsWith('https://cinesrc.st/'));
  await host.page.waitForTimeout(2500);
  await host.page.frameLocator('#player-frame').locator('#play').click(); await host.page.waitForTimeout(500);
  assert.equal(room.playing,true,'CineSrc host play reached room'); await wake(guest.page); await guest.page.waitForTimeout(3300);
  assert.equal((await playerState(guest.page)).paused,false,'CineSrc guest received play');
  await host.page.frameLocator('#player-frame').locator('#pause').click(); await host.page.waitForTimeout(400);
  assert.equal(room.playing,false,'CineSrc host pause reached room'); await wake(guest.page); await guest.page.waitForTimeout(3200);
  assert.equal((await playerState(guest.page)).paused,true,'CineSrc guest received pause');
  await host.page.frameLocator('#player-frame').locator('#seek').click(); await host.page.waitForTimeout(400);
  assert.ok(room.position_seconds >= 119,'CineSrc host seek reached room'); await wake(guest.page); await guest.page.waitForTimeout(3200);
  assert.ok((await playerState(guest.page)).time >= 119,'CineSrc guest received seek');
  await guest.page.frameLocator('#player-frame').locator('body').evaluate(() => parent.postMessage({type:'cinesrc:nextepisode',season:2,episode:1,internalNavigation:true}, '*'));
  await guest.page.waitForFunction(()=>document.querySelector('.wp-resync').textContent==='Reload party player');
  await guest.page.locator('.wp-party-tab').click();
  await guest.page.locator('.wp-resync').click();
  await guest.page.waitForFunction(()=>document.querySelector('.wp-resync').textContent==='Resync my player');
  host.page.once('dialog',dialog=>dialog.accept()); await host.page.locator('.wp-end').click();
  await wake(guest.page); await guest.page.waitForSelector('.wp-welcome:not([hidden])');
  await host.page.waitForFunction(()=>document.querySelector('#player-frame').src.startsWith('https://vidora.ac/'));
  assert.equal(room.ended,true);
  const mobile=await context('mobile',{width:375,height:812});
  await mobile.page.goto(base+'/watch.html?id=533533&type=movie'); await mobile.page.locator('#watch-party-btn').click();
  const box=await mobile.page.locator('#wp-panel').boundingBox(); assert.ok(box.width<=375 && box.height>=350,'mobile panel fits');
  const offline=await context('offline', {width:1280,height:800}, false);
  await offline.page.goto(base+'/watch.html?id=533533&type=movie');
  await offline.page.locator('#watch-party-btn').click();
  await offline.page.locator('#wp-name').fill('Viewer');
  await offline.page.locator('.wp-create').click();
  await offline.page.waitForSelector('.wp-error:not([hidden])');
  assert.match(await offline.page.locator('.wp-error').textContent(), /reach the party service|guest sign-in/i, 'real SDK reports offline rather than pretending a room exists');
  assert.equal(await offline.page.locator('.wp-room').isVisible(), false);
  assert.equal(await offline.page.evaluate(()=>typeof window.supabase.createClient), 'function', 'self-hosted official SDK loads');

  assert.deepEqual(errors,[]);
  console.log('PASS: isolated mocked sessions; VidSpark/CineSrc play, pause, seek, private channel, forged messages, permissions, XSS, rejoin, episode navigation, provider switch, end, Vidora restore and mobile layout.');
  console.log('Mocks only: no real Supabase or third-party video playback. RPC calls:',calls.length);
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
})().catch(async e=>{console.error(e);if(browser) await browser.close();if(server) await new Promise((resolve) => server.close(resolve));process.exitCode=1});
