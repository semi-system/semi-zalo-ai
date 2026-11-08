import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('critical modules present',()=>{for(const f of ['apps/server/src/gateway.ts','apps/server/src/agent.ts','apps/server/src/main.ts','apps/web/src/App.svelte','db/schema.sql','Dockerfile'])assert.ok(read(f).length>100);});
test('no production secrets or Tor engines',()=>{const config=read('.env.example');assert.ok(!config.includes('vilc7vgy6xx'));assert.ok(!read('apps/server/src/agent.ts').includes('ahmia'));});
test('Zalo image whitelist and database dedup',()=>{assert.match(read('apps/server/src/agent.ts'),/photo-\[a-z0-9-\]/);assert.match(read('db/schema.sql'),/UNIQUE\(thread_id,message_id\)/);});

test('database backed provider configuration and encrypted credentials',()=>{
 const source=read('apps/server/src/connections.ts');
 assert.match(source,/aes-256-gcm/);assert.match(source,/app_connections/);assert.match(source,/api\/tags/);assert.match(source,/SearXNG JSON search/);
 assert.match(read('apps/server/src/main.ts'),/api\/connections\/test/);
 assert.match(read('apps/server/src/agent.ts'),/getConnection\('ollama'\)/);
 assert.match(read('apps/web/src/App.svelte'),/Kiểm tra & Lưu DB/);
 assert.match(read('db/schema.sql'),/CREATE TABLE IF NOT EXISTS app_connections/);
});

test('Zalo module has independent admin controls and does not auto force QR',()=>{
 const main=read('apps/server/src/main.ts');
 const gateway=read('apps/server/src/gateway.ts');
 const web=read('apps/web/src/App.svelte');
 for(const endpoint of ['/api/gateway/enable','/api/gateway/qr/start','/api/gateway/reconnect','/api/gateway/disconnect','/api/gateway/logout'])assert.ok(main.includes(endpoint));
 assert.match(main,/initGateway\(ingest/);
 assert.match(main,/restoreGateway\(\)/);
 assert.match(gateway,/if\(!client&&!allowQR\)/);
 assert.match(gateway,/startQRLogin/);
 assert.match(gateway,/logoutGateway/);
 assert.match(web,/label:'Modules'/);
 assert.match(web,/Quét QR đăng nhập/);
 assert.match(read('apps/server/src/runtime.ts'),/zaloEnabled:z\.boolean\(\)\.default\(false\)/);
});

test('AI Processing module has database settings and live inference test',()=>{
 const web=read('apps/web/src/App.svelte');const main=read('apps/server/src/main.ts');
 assert.match(web,/Module: AI Processing/);assert.match(web,/Test AI Inference/);
 assert.match(web,/bind:value=\{runtimeConfig.aiConcurrency\}/);
 assert.match(web,/bind:checked=\{runtimeConfig.aiEnabled\}/);
 assert.match(main,/api\/ai\/test/);assert.match(read('apps/server/src/agent.ts'),/testAIInference/);
 assert.match(read('apps/server/src/runtime.ts'),/aiEnabled:z\.boolean\(\)\.default\(true\)/);
});


test('standalone repo publishes an image without compose',()=>{
 const workflow=read('.github/workflows/docker.yml');
 assert.match(workflow,/abxst\/action\/strict@v3/);
 assert.match(workflow,/docker\/build-push-action@v6/);
 assert.match(workflow,/ghcr\.io/);
 assert.ok(!requireCompose());
 function requireCompose(){return ['deploy/compose.yaml','docker-compose.yml','compose.yaml'].some(p=>{try {read(p);return true;}catch{return false;}});}
 assert.match(read('.env.example'),/^DATABASE_URL=/m);
});
