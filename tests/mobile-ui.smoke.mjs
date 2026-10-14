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
const nav = label => page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label});
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
  await nav('AI & Snippets').click();
  await shot('ai');
  await page.getByRole('button',{name:'Snippets',exact:true}).click();
  await shot('snippets');
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
  assert.equal(await page.locator('.nx-bottom-nav').isVisible(),width<768,`nav breakpoint ${width}`);
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
  // Long-press selects a buffer word and reveals safe, explicit actions.
  await page.evaluate(async()=>{
  const {registry}=await import('/src/lib/sessions.ts');
  const live=registry.all().find(x=>x.term.element.getBoundingClientRect().width>0);
  live.term.clear();live.term.write('\r\nhello mobile selection\r\n');
  });
  await page.waitForTimeout(100);
  const screen=await page.locator('.xterm-screen:visible').boundingBox();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:screen.x+20,y:screen.y+10}]});
  await page.waitForTimeout(560);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.getByRole('toolbar',{name:'Terminal selection actions'}).isVisible(),true);
  await page.getByRole('button',{name:'Select All',exact:true}).click();
  assert.ok(await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().some(x=>x.term.getSelection().includes('hello mobile selection'));}));
  await page.getByRole('button',{name:'Close terminal actions'}).click();
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
  await page.getByRole('combobox',{name:'Auto-lock timeout'}).selectOption('5');
  await page.clock.install();
  await nav('Hosts').click();
  await page.getByRole('button',{name:'Actions for prod-api-01'}).click();
  await page.clock.fastForward(300_001);
  await page.getByRole('heading',{name:'Unlock vault',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog',{name:'prod-api-01',exact:true}).count(),0);
  assert.deepEqual(await page.evaluate(async()=>{const {registry}=await import('/src/lib/sessions.ts');return registry.all().map(x=>x.sessionId);}),splitIds);
  assert.deepEqual(errors,[]);
  console.log('PASS: navigation, sheets/swipe dismissal, CTRL/ALT input/focus, session persistence, SFTP, editor, AI/snippets, settings, viewport docking, long-press selection, touch scroll, desktop splits, auto-lock and 320–1280px breakpoints; no runtime errors.');
} catch(e) { await shot('failure'); console.log('BODY:',(await page.locator('body').innerText()).slice(-6000));throw e; }
finally { await browser.close(); }
