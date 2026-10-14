import assert from 'node:assert/strict';
import { chromium as playwright } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

// Browser is supplied by the caller; this test never downloads binaries.
if (!process.env.CHROMIUM_PATH) throw new Error('Set CHROMIUM_PATH to your Chromium executable; see docs/mobile-ui.md.');
const artifactDir = 'node_modules/.cache/mobile-ui';
await mkdir(artifactDir, { recursive: true });
const browser = await playwright.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
  headless: true,
});
const context = await browser.newContext({ viewport: {width:390,height:844}, isMobile:true, hasTouch:true });
const page = await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=> { if(m.type()==='error' && m.text().includes('passive')) errors.push(m.text()); });
page.setDefaultTimeout(10000);
// The terminal screen hides the bottom navigation (Termius-style); its back button leads to Hosts first.
const nav = label => ({ async click(){
  const back=page.getByRole('button',{name:'Back to hosts',exact:true});
  if(await back.isVisible().catch(()=>false)) await back.click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label}).click();
} });
const shot= name=>page.screenshot({path:`${artifactDir}/${name}.png`});
try {
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByPlaceholder('Master password',{exact:true}).fill('mobile-test-vault-42');
  await page.getByPlaceholder('Confirm master password').fill('mobile-test-vault-42');
  await page.getByRole('button',{name:'Create vault',exact:true}).click();
  await page.getByRole('button',{name:'I have saved my recovery key'}).click();
  await nav('Hosts').click();
  await shot('hosts');
  assert.equal(await page.locator('.nx-bottom-nav').isVisible(),true);
  await page.getByRole('button',{name:'Add host',exact:true}).click();
  assert.equal(await page.getByRole('dialog',{name:'Host profile'}).isVisible(),true);
  const hb=await page.locator('.nx-sheet').boundingBox();
  assert.ok(hb.x<1 && Math.abs(hb.width-390)<1);
  await shot('host-sheet');
  await page.getByRole('button',{name:'Dismiss sheet',exact:true}).click();
  await nav('Terminals').click();
  await page.getByRole('button',{name:'Open Local Terminal',exact:true}).click();
  await page.waitForTimeout(800);
  await page.evaluate(async()=>{
  const {bridge}=await import('/src/lib/bridge.ts');window.__sent=[];
  const write=bridge.writeLocalPty;
  bridge.writeLocalPty=async(s,d)=>{ window.__sent.push(d); return write(s,d); };
  });
  await page.getByRole('button',{name:'Show terminal keyboard'}).click();
  await page.getByRole('button',{name:'CTRL',exact:true}).tap();
  assert.equal(await page.getByRole('button',{name:'CTRL',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('xterm-helper-textarea')),true);
  await page.keyboard.insertText('c');
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(()=>window.__sent),['\x03']);
  assert.equal(await page.getByRole('button',{name:'CTRL',exact:true}).getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'ALT',exact:true}).tap();
  await page.keyboard.insertText('x');
  assert.deepEqual(await page.evaluate(()=>window.__sent),['\x03','\x1bx']);
  await page.getByRole('button',{name:'Tab',exact:true}).tap();
  assert.deepEqual(await page.evaluate(()=>window.__sent),['\x03','\x1bx','\t']);
  await shot('terminal');
  // AI / Snippets drawers over the terminal: AI opens full height, drags (here: arrow keys) to half, Escape closes.
  const drawerBox=async()=>page.evaluate(()=>{const d=document.querySelector('.nx-drawer:not(.hidden)');if(!d)return null;const r=d.getBoundingClientRect();const w=d.parentElement.getBoundingClientRect();return {label:d.getAttribute('aria-label'),ratio:Math.round(r.height/w.height*100)/100};});
  await page.getByRole('button',{name:'AI Assistant',exact:true}).tap();
  await page.waitForTimeout(500);
  assert.deepEqual(await drawerBox(),{label:'AI Assistant drawer',ratio:1});
  assert.equal(await page.getByTitle('Close AI Panel').isVisible(),true);
  await page.locator('.nx-drawer-grip').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  assert.deepEqual(await drawerBox(),{label:'AI Assistant drawer',ratio:0.5});
  assert.equal(await page.locator('.nx-session-bar').isVisible(),false,'session bar yields to the half drawer');
  assert.ok((await page.locator('.xterm-screen').boundingBox()).height<844*0.5,'terminal refits above the half drawer');
  await shot('ai-drawer-half');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert.equal(await drawerBox(),null);
  assert.equal(await page.locator('.nx-session-bar').isVisible(),true);
  await page.getByRole('button',{name:'Snippets',exact:true}).tap();
  await page.waitForTimeout(500);
  assert.deepEqual(await drawerBox(),{label:'Snippets drawer',ratio:0.5});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert.equal(await drawerBox(),null);
  // Extended keypad drawer: keys travel the accessory pipeline and the terminal keeps focus.
  await page.getByRole('button',{name:'Open extended keys palette'}).tap();
  await page.waitForTimeout(500);
  assert.deepEqual(await drawerBox(),{label:'Extended keypad',ratio:0.5});
  await page.getByRole('button',{name:'F1',exact:true}).tap();
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(()=>window.__sent),['\x03','\x1bx','\t','\x1bOP']);
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('xterm-helper-textarea')),true,'keypad keeps the terminal focused');
  await shot('keypad-drawer');
  await page.getByRole('button',{name:'Close extended keypad'}).tap();
  await page.waitForTimeout(500);
  assert.equal(await drawerBox(),null);
  // Command history drawer.
  await page.getByRole('button',{name:'Command history',exact:true}).tap();
  await page.waitForTimeout(600);
  assert.deepEqual(await drawerBox(),{label:'Command history',ratio:0.5});
  assert.equal(await page.getByRole('button',{name:'Close command history'}).isVisible(),true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert.equal(await drawerBox(),null);
  // Find in terminal docks under the terminal and takes focus; the rows refit above it.
  await page.getByRole('button',{name:'Search terminal'}).tap();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.nx-terminal-search-docked').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Find in terminal');
  const searchTop=(await page.locator('.nx-terminal-search-docked').boundingBox()).y;
  assert.ok((await page.locator('.xterm-screen').boundingBox()).height<=searchTop,'terminal sits above the search bar');
  await shot('search-docked');
  await page.getByRole('button',{name:'Close search'}).tap();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.nx-terminal-search-docked').count(),0);
  const before=await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().map(x=>x.sessionId);});
  await nav('Hosts').click();
  await nav('Terminals').click();
  const after=await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().map(x=>x.sessionId);});
  assert.deepEqual(after,before);
  await page.getByRole('button',{name:/^Sessions/}).click();
  assert.equal(await page.getByRole('dialog',{name:'Terminal sessions'}).isVisible(),true);
  await shot('sessions');
  await page.getByRole('button',{name:'Close sheet',exact:true}).click();
  await nav('SFTP').click();
  await page.getByRole('button',{name:'Local',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Remote files'}).isVisible(),false);
  assert.equal(await page.getByRole('region',{name:'Local files'}).isVisible(),true);
  await page.getByText('config.json',{exact:true}).click();
  await shot('file-sheet');
  await page.getByRole('button',{name:'Permissions',exact:true}).click();
  assert.ok((await page.getByRole('dialog',{name:'File permissions'}).innerText()).includes('644'));
  await page.getByRole('button',{name:'Close sheet',exact:true}).click();
  await page.getByText('config.json',{exact:true}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('textbox',{name:'Edit config.json'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Edit config.json'}).getAttribute('wrap'),'soft');
  await shot('editor');
  await page.getByTitle('Close editor (Esc)').click();
  await nav('AI').click();
  await shot('ai');
  // The AI page is the assistant alone: no AI/Snippets tab row above it.
  assert.equal(await page.getByRole('button',{name:'Snippets',exact:true}).count(),0);
  assert.equal(await page.getByRole('complementary',{name:'AI Assistant',exact:true}).isVisible(),true);
  await nav('Settings').click();
  await shot('settings');
  await page.getByRole('button',{name:'LAN device pairing'}).click();
  await shot('pairing');
  await page.getByRole('button',{name:'Dismiss sheet',exact:true}).click();
  await nav('Terminals').click();
  await page.getByRole('button',{name:'Show terminal keyboard'}).click();
  // Simulate a visual viewport that is shortened by a virtual keyboard.
  await page.evaluate(()=>{
  Object.defineProperty(window.visualViewport,'height',{configurable:true,value:480});
  window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.nx-bottom-nav').isVisible(),false);
  const bar=await page.locator('.nx-terminal-accessory').boundingBox();
  assert.ok(Math.abs(bar.y+bar.height-480)<2,JSON.stringify(bar));
  await shot('keyboard');
  await page.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));});
  for(const width of [320,640,767,768,1280]){
  await page.setViewportSize({width,height:844});
  await page.waitForTimeout(150);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(overflow,false,`horizontal page overflow at ${width}`);
  // On the terminal screen the phone layout shows the session bar instead of the bottom navigation.
  assert.equal(await page.locator('.nx-session-bar').isVisible(),width<768,`session bar breakpoint ${width}`);
  assert.equal(await page.locator('.nx-bottom-nav').isVisible(),false,`nav hidden on terminal screen ${width}`);
  if(width===1280){
  assert.equal(await page.locator('.nx-terminal-accessory').count(),0);
  await shot('desktop');
  }
  }
  // Desktop splits turn into one visible mobile pane without losing sessions.
  await page.getByTitle('Split vertical (⌘⇧D)').click();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.xterm:visible').count(),2);
  const splitIds=await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().map(x=>x.sessionId);});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.xterm:visible').count(),1);
  await page.getByRole('button',{name:/^Sessions/}).click();
  await page.getByRole('dialog',{name:'Terminal sessions'}).getByRole('button',{name:/Local Terminal.*connected/}).first().click();
  assert.equal(await page.locator('.xterm:visible').count(),1);
  assert.deepEqual(await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().map(x=>x.sessionId);}),splitIds);
  // Long-press selects the word under the finger; drag handles extend it and a floating bubble offers the actions.
  await page.evaluate(async()=>{
  const {registry}=await import('/src/lib/sessions.ts');
  const live=registry.all().find(x=>x.term.element.getBoundingClientRect().width>0);
  live.term.clear();live.term.write('\r\nhello mobile selection\r\n');
  });
  await page.waitForTimeout(100);
  const screen=await page.locator('.xterm-screen:visible').boundingBox();
  const cell=await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');const t=registry.all().find(x=>x.term.element.getBoundingClientRect().width>0).term;const r=t.element.querySelector('.xterm-screen').getBoundingClientRect();return {w:r.width/t.cols,h:r.height/t.rows};});
  const liveSelection=()=>page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().find(x=>x.term.element.getBoundingClientRect().width>0).term.getSelection();});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:screen.x+8*cell.w,y:screen.y+1.5*cell.h}]});
  await page.waitForTimeout(560);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(150);
  assert.equal(await liveSelection(),'mobile');
  assert.equal(await page.locator('.nx-sel-handle').count(),2);
  assert.equal(await page.getByRole('toolbar',{name:'Selection actions'}).isVisible(),true);
  const endHandle=await page.locator('.nx-sel-handle-end').boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:endHandle.x+10,y:endHandle.y+14}]});
  for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:endHandle.x+10+9*cell.w*i/6,y:endHandle.y+14}]});await page.waitForTimeout(20);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(150);
  assert.equal(await liveSelection(),'mobile selection');
  await page.getByRole('button',{name:'Select all',exact:true}).click();
  assert.ok((await liveSelection()).includes('hello mobile selection'));
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  await page.waitForTimeout(100);
  assert.equal(await liveSelection(),'');
  assert.equal(await page.locator('.nx-sel-handle').count(),0);
  // Long-press on blank space offers Paste without selecting anything.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:screen.x+200,y:screen.y+10*cell.h}]});
  await page.waitForTimeout(560);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('button',{name:'Paste',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'Copy',exact:true}).count(),0);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:screen.x+100,y:screen.y+12*cell.h}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('toolbar',{name:'Selection actions'}).count(),0);
  // Touch scrolling moves through the scrollback with no duplicate native movement.
  await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');const live=registry.all().find(x=>x.term.element.getBoundingClientRect().width>0);live.term.write(Array.from({length:150},(_,i)=>`line ${i}\r\n`).join(''));});
  await page.waitForTimeout(100);
  const previousY=await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().find(x=>x.term.element.getBoundingClientRect().width>0).term.buffer.active.viewportY;});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:screen.x+100,y:screen.y+80}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:screen.x+100,y:screen.y+160}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(200);
  const newY=await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().find(x=>x.term.element.getBoundingClientRect().width>0).term.buffer.active.viewportY;});
  assert.ok(newY<previousY,`${newY} < ${previousY}`);
  // Pinch-to-zoom: a two-finger spread previews with a transform (no reflow mid-gesture), shows the
  // size readout, then commits a bigger whole-pixel font on release and persists it; pinching back restores.
  const fontState=()=>page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');const t=registry.all().find(x=>x.term.element.getBoundingClientRect().width>0).term;return {font:t.options.fontSize,cols:t.cols,transform:t.element.parentElement.style.transform,hud:document.querySelector('.nx-zoom-hud')?.textContent??null,stored:Number(localStorage.getItem('nx.font'))};});
  const baseFont=(await fontState()).font;
  const pinch=async(from,to)=>{const cx=screen.x+screen.width/2,cy=screen.y+screen.height/2;const pts=d=>[{x:cx-d/2,y:cy,id:0},{x:cx+d/2,y:cy,id:1}];
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:pts(from)});
    const steps=8;for(let i=1;i<=steps;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:pts(from+(to-from)*i/steps)});await page.waitForTimeout(16);}
    const mid=await fontState();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForTimeout(800);
    return mid;};
  const midOut=await pinch(60,90);
  assert.equal(midOut.font,baseFont);
  assert.match(midOut.transform,/^scale\(1\.[3-6]/);
  assert.match(midOut.hud??'',/px$/);
  const zoomed=await fontState();
  assert.ok(zoomed.font>baseFont&&zoomed.cols<midOut.cols,`${zoomed.font} > ${baseFont}`);
  assert.deepEqual([zoomed.transform,zoomed.hud,zoomed.stored],['',null,zoomed.font]);
  await pinch(90,60);
  const restored=await fontState();
  assert.ok(restored.font<zoomed.font&&restored.transform==='',`${restored.font} < ${zoomed.font}`);
  // The drag handle dismisses a sheet; content scroll is not a dismiss gesture.
  await page.getByRole('button',{name:/^Sessions/}).click();
  const handle=await page.getByRole('button',{name:'Dismiss sheet',exact:true}).boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:handle.x+100,y:handle.y+10}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:handle.x+100,y:handle.y+85}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.getByRole('dialog',{name:'Terminal sessions'}).count(),0);
  await page.setViewportSize({width:320,height:700});
  await nav('SFTP').click();
  await page.getByRole('button',{name:'Local',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Remote files'}).isVisible(),false);
  assert.equal(await page.getByRole('region',{name:'Local files'}).isVisible(),true);
  await page.getByRole('button',{name:'Filter',exact:true}).click();
  await shot('sftp320');
  await nav('Hosts').click();
  await page.getByRole('button',{name:'Actions for prod-api-01'}).click();
  await shot('host-actions320');
  await page.getByRole('button',{name:'Edit host',exact:true}).click();
  await shot('host320');
  await page.getByRole('button',{name:'Dismiss sheet',exact:true}).click();
  await nav('Terminals').click();
  await page.setViewportSize({width:1280,height:844});
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.xterm:visible').count(),2);

  // Auto-lock must hide portaled host actions as well as the inert workspace.
  await page.setViewportSize({width:390,height:844});
  await nav('Settings').click();
  await page.getByRole('button',{name:/^Auto-lock:/}).click();
  await page.getByRole('radiogroup',{name:'Auto-lock timeout'}).getByRole('radio',{name:'5 minutes',exact:true}).click();
  assert.equal(await page.getByRole('dialog',{name:'Auto-lock'}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Auto-lock: 5 minutes'}).count(),1);
  // Theme picker is a themed sheet with live preview; the slider and font stepper are themed controls.
  await page.getByRole('button',{name:/^Theme:/}).click();
  await page.getByRole('radiogroup',{name:'Terminal theme'}).getByRole('radio',{name:'Ember'}).click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('nx.theme')),'ember');
  await shot('theme-picker');
  await page.getByRole('button',{name:'Close sheet'}).click();
  const fontBefore=Number(await page.evaluate(()=>localStorage.getItem('nx.font')));
  await page.getByRole('button',{name:'Larger font'}).click();
  assert.equal(Number(await page.evaluate(()=>localStorage.getItem('nx.font'))),fontBefore+1);
  await page.getByRole('button',{name:'Smaller font'}).click();
  await page.getByRole('slider',{name:'Terminal line height'}).fill('1.2');
  await shot('settings-themed');
  await page.clock.install();
  await nav('Hosts').click();
  await page.getByRole('button',{name:'Actions for prod-api-01'}).click();
  await page.clock.fastForward(300_001);
  await page.getByRole('heading',{name:'Unlock vault',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog',{name:'prod-api-01',exact:true}).count(),0);
  assert.deepEqual(await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().map(x=>x.sessionId);}),splitIds);
  assert.deepEqual(errors,[]);
  console.log('PASS: navigation, sheets/swipe dismissal, CTRL/ALT input/focus, AI/snippets/keypad/history terminal drawers, docked search, session persistence, SFTP, editor, AI/snippets, settings, viewport docking, long-press selection with drag handles and action bubble, touch scroll, pinch-to-zoom font size, desktop splits, auto-lock and 320–1280px breakpoints; no runtime errors.');
} catch(e) { await shot('failure'); console.log('BODY:',(await page.locator('body').innerText()).slice(-6000));throw e; }
finally { await browser.close(); }
