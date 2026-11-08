<script lang="ts">
 import { onMount } from 'svelte';
 import { LayoutDashboard, Users, MessagesSquare, Settings, Radio, ScrollText, LogOut, RefreshCcw, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-svelte';
 type Row=Record<string,any>;
 let username=$state('');let password=$state('');let needsSetup=$state(false);let loggedIn=$state(false);let loading=$state(true);let error=$state('');let page=$state('dashboard');
 let dashboard=$state<Row>({});let gateway=$state<Row>({});let qr=$state<string|null>(null);let gatewayNotice=$state('');let gatewayBusy=$state(false);
 let users=$state<Row[]>([]);let messages=$state<Row[]>([]);let audit=$state<Row[]>([]);let prompt=$state('');
 let runtimeConfig=$state<Row>({});let runtimeNotice=$state('');let aiTestNotice=$state('');let aiTesting=$state(false);let connections=$state<Row[]>([]);let connectionNotice=$state<Record<string,string>>({});let busyProvider=$state('');let selectedThread=$state('');let history=$state<Row[]>([]);
 const nav=[{id:'dashboard',label:'Tổng quan',icon:LayoutDashboard},{id:'modules',label:'Modules',icon:Radio},{id:'users',label:'Người dùng',icon:Users},{id:'messages',label:'Tin nhắn',icon:MessagesSquare},{id:'settings',label:'AI Agent & Prompt',icon:Settings},{id:'audit',label:'Nhật ký',icon:ScrollText}];
 async function api(url:string,options:RequestInit={}) {const r=await fetch('/api'+url,{credentials:'same-origin',headers:{'content-type':'application/json'},...options});if(!r.ok){const j=await r.json().catch(()=>({}));throw Error(j.error||'HTTP '+r.status)}return r.json();}
 async function refresh(){if(!loggedIn)return;error='';try{
  if(page==='dashboard')dashboard=await api('/dashboard');
  if(page==='modules'){runtimeConfig=(await api('/runtime')).settings;gateway=await api('/gateway');qr=(await api('/gateway/qr')).image;const existing=(await api('/connections')).items;connections=existing.map((x:Row)=>({...x,apiKey:'',username:'',password:'',clearCredentials:false}));}
  if(page==='users')users=(await api('/users')).items;
  if(page==='messages')messages=(await api('/messages'+(selectedThread?'?threadId='+encodeURIComponent(selectedThread):''))).items;
  if(page==='settings'){runtimeConfig=(await api('/runtime')).settings;prompt=(await api('/settings')).systemPrompt;}
  if(page==='audit')audit=(await api('/audit')).items;
 }catch(e){error=String(e);}}
 async function gatewayAction(action:'enable'|'disable'|'qr/start'|'reconnect'|'disconnect'|'logout'){
  if(action==='logout'&&!confirm('Xóa session Zalo trên máy chủ? Lần sau sẽ phải quét QR lại.'))return;
  gatewayNotice='';gatewayBusy=true;
  try{
   const target=action==='enable'||action==='disable'?'/gateway/enable':'/gateway/'+action;
   const response=await api(target,{method:'POST',body:JSON.stringify(action==='enable'?{enabled:true}:action==='disable'?{enabled:false}:{})});
   gateway=response.gateway;qr=(await api('/gateway/qr')).image;
   gatewayNotice=action==='qr/start'?'Đang tạo QR, giao diện sẽ tự làm mới.':action==='reconnect'?'Đang kết nối lại bằng session đã lưu.':action==='logout'?'Đã xóa session cục bộ.':'Đã cập nhật module Zalo.';
  }catch(e){gatewayNotice=String(e);}finally{gatewayBusy=false;}
 }
 async function setup(){error='';try{await api('/setup',{method:'POST',body:JSON.stringify({username,password})});needsSetup=false;await login();}catch(e){error=String(e);}}
 async function login(){error='';try{const r=await api('/auth/login',{method:'POST',body:JSON.stringify({username,password})});loggedIn=true;username=r.username;password='';await refresh();}catch(e){error=String(e);}}
 async function logout(){await api('/auth/logout',{method:'POST'}).catch(()=>{});loggedIn=false;}
 async function action(id:string,action:string){if(!confirm(`Thực hiện ${action} cho tài khoản ${id}?`))return;try{await api('/users/'+id,{method:'PATCH',body:JSON.stringify({action})});await refresh();}catch(e){error=String(e)}}
 async function saveRuntime(){runtimeNotice='';try{const result=await api('/runtime',{method:'PUT',body:JSON.stringify(runtimeConfig)});runtimeConfig=result.settings;runtimeNotice='Đã lưu cấu hình vận hành vào PostgreSQL.';}catch(e){runtimeNotice=String(e)}}
 async function testAI(){aiTesting=true;aiTestNotice='Đang gọi Ollama với model đã lưu. Quá trình suy luận có thể mất vài giây.';try{const result=await api('/ai/test',{method:'POST',body:'{}'});aiTestNotice=`Kết nối và suy luận thành công • Model: ${result.model} • ${result.durationMs} ms • Phản hồi: ${result.answer}`;}catch(e){aiTestNotice='Kiểm tra thất bại: '+String(e);}finally{aiTesting=false;}}
 async function savePrompt(){try{await api('/settings',{method:'PUT',body:JSON.stringify({systemPrompt:prompt})});alert('Đã lưu System Prompt');}catch(e){error=String(e)}}
 async function connectionAction(c:Row,save:boolean){
  error='';busyProvider=c.provider;connectionNotice[c.provider]='Đang kiểm tra kết nối...';
  try{
   const request={provider:c.provider,url:c.url,authType:c.authType,apiKey:c.apiKey||undefined,username:c.username||undefined,password:c.password||undefined,clearCredentials:!!c.clearCredentials,model:c.model||undefined,visionModel:c.visionModel||undefined,results:Number(c.results||5)};
   const result=await api(save?'/connections':'/connections/test',{method:save?'PUT':'POST',body:JSON.stringify(request)});
   const check=save?result.test:result;
   connectionNotice[c.provider]=(save?'Đã lưu và kiểm tra thành công. ':'Kết nối thành công. ')+check.detail+(check.models?' — models: '+check.models.join(', '):'');
   if(save){c.apiKey='';c.password='';c.clearCredentials=false;c.hasCredentials=c.authType!=='none';}
  }catch(e){connectionNotice[c.provider]='Lỗi: '+String(e);}
  finally{busyProvider='';}
 }
 async function showHistory(id:string){selectedThread=id;try{history=(await api('/conversations/'+id+'/history')).items;}catch(e){error=String(e)}}
 onMount(()=>{const refreshGateway=()=>{if(loggedIn&&page==='modules')void Promise.all([api('/gateway'),api('/gateway/qr')]).then(([s,q])=>{gateway=s;qr=q.image;}).catch(()=>{});};const timer=setInterval(refreshGateway,2000);api('/setup/status').then(r=>needsSetup=r.needsSetup).catch(()=>{});api('/auth/me').then(async r=>{loggedIn=true;username=r.username;await refresh();}).catch(()=>{}).finally(()=>loading=false);return ()=>clearInterval(timer);});
</script>
<svelte:head><title>Semi Zalo AI — Dashboard</title></svelte:head>
{#if loading}<main class="center">Đang tải...</main>
{:else if !loggedIn}
 <main class="login-wrap"><form class="login card" onsubmit={(e)=>{e.preventDefault();void (needsSetup?setup():login())}}><div class="brand-mark">S</div><h1>Semi Zalo AI</h1><p>{needsSetup?'Thiết lập tài khoản quản trị lần đầu':'Đăng nhập bảng điều khiển'}</p><label>Tài khoản<input autocomplete="username" bind:value={username} required></label><label>Mật khẩu<input type="password" autocomplete={needsSetup?"new-password":"current-password"} bind:value={password} required></label><button type="submit">{needsSetup?"Tạo quản trị viên":"Đăng nhập"}</button>{#if error}<div class="error">{error}</div>{/if}</form></main>
{:else}
 <div class="shell"><aside><div class="brand"><div class="brand-mark">S</div><div><b>Semi Zalo AI</b><small>Control Center</small></div></div><nav>{#each nav as n}<button class:active={page===n.id} onclick={()=>{page=n.id;selectedThread='';history=[];void refresh()}}><n.icon size={18}/>{n.label}</button>{/each}</nav><div class="aside-bottom"><span>{username}</span><button onclick={logout}><LogOut size={17}/> Đăng xuất</button></div></aside>
 <div class="main"><header><div><span class="eyebrow">BẢNG ĐIỀU KHIỂN</span><h1>{nav.find(x=>x.id===page)?.label}</h1></div><button class="outline" onclick={refresh}><RefreshCcw size={16}/> Làm mới</button></header>
 {#if error}<div class="error">{error}</div>{/if}
 {#if page==='dashboard'}
  <div class="stats"><div class="card metric"><small>Tài khoản</small><strong>{dashboard.users??'—'}</strong><span>Đã ghi nhận</span></div><div class="card metric"><small>Được duyệt</small><strong>{dashboard.approved??'—'}</strong><span>Đang bật AI</span></div><div class="card metric"><small>Tin nhắn</small><strong>{dashboard.messages??'—'}</strong><span>Đã nhận</span></div><div class="card metric"><small>Phản hồi</small><strong>{dashboard.replied??'—'}</strong><span>Hoàn tất</span></div></div><section class="card"><h2>Trạng thái dịch vụ</h2><div class="status-row"><Radio size={20}/><span>Zalo Gateway</span><span class:good={dashboard.gateway?.status==='ready'} class="status">{dashboard.gateway?.status??'unknown'}</span></div><div class="status-row"><AlertTriangle size={20}/><span>Tin nhắn lỗi</span><span>{dashboard.errors??0}</span></div></section>
 {:else if page==='modules'}
  <section class="card"><div class="flex"><div><h2>Module: Zalo Gateway</h2><p>Module độc lập: không bắt buộc khi tạo Admin hay cấu hình AI. Có thể bật và đăng nhập sau.</p></div><span class:good={gateway.status==='ready'} class="status">{gateway.status??'unknown'}</span></div>
   <div class="status-row"><Radio size={19}/><span>Module</span><strong>{gateway.enabled?'Đang bật':'Đã tắt'}</strong></div>
   <div class="status-row"><ShieldCheck size={19}/><span>Session đã lưu</span><strong>{gateway.hasSession?'Có':'Chưa có'}</strong></div>
   {#if gateway.error}<div class="error">{gateway.error}</div>{/if}
   <div class="actions gateway-controls">
    {#if !gateway.enabled}<button disabled={gatewayBusy} onclick={()=>gatewayAction('enable')}>Bật module</button>
    {:else}<button class="outline" disabled={gatewayBusy} onclick={()=>gatewayAction('disable')}>Tắt module</button>{/if}
    <button disabled={gatewayBusy||!gateway.enabled||gateway.status==='ready'||gateway.status==='waiting_qr'} onclick={()=>gatewayAction('qr/start')}>Quét QR đăng nhập</button>
    <button class="outline" disabled={gatewayBusy||!gateway.enabled} onclick={()=>gatewayAction('reconnect')}>Kết nối lại</button>
    <button class="outline" disabled={gatewayBusy||!gateway.enabled||gateway.status==='disabled'} onclick={()=>gatewayAction('disconnect')}>Ngắt kết nối</button>
    <button class="danger" disabled={gatewayBusy||!gateway.hasSession} onclick={()=>gatewayAction('logout')}>Đăng xuất / Xóa session</button>
   </div>
   {#if gatewayNotice}<p class="connection-notice">{gatewayNotice}</p>{/if}
   {#if qr && gateway.enabled && gateway.status==='waiting_qr'}<div class="qr"><img src={qr} alt="Zalo QR Login"><p>Mở Zalo trên điện thoại và quét mã. Mã tự làm mới khi Gateway tạo QR mới.</p></div>
   {:else if gateway.status==='waiting_qr'}<p>Đang tạo mã QR... Trang này tự cập nhật mỗi 2 giây.</p>
   {:else if gateway.status==='ready'}<p>Zalo đã kết nối. Không cần quét QR lại khi session còn hiệu lực.</p>
   {:else}<p>Module chưa kết nối. Bật module rồi chọn “Quét QR đăng nhập” để bắt đầu.</p>{/if}
  </section>
  <section class="card"><h2>Module: Ollama & SearXNG</h2><p>Mỗi module có kết nối lưu trong PostgreSQL. Kiểm tra kết nối thành công trước khi lưu. Credential được mã hóa và không hiển thị lại.</p>
  {#each connections as c (c.provider)}
   <div class="provider">
    <h3>{c.provider==='ollama'?'Ollama':'SearXNG'}</h3>
    <div class="field-grid"><label>Server URL<input type="url" bind:value={c.url} placeholder={c.provider==='ollama'?'http://ollama:11434':'http://searxng:8080'} required></label>
    <label>Xác thực<select bind:value={c.authType}><option value="none">Không cần</option><option value="bearer">Bearer API key</option><option value="basic">Basic Auth</option></select></label>
    {#if c.provider==='ollama'}<label>Chat model<input bind:value={c.model} placeholder="gemma4:31b"></label><label>Vision model<input bind:value={c.visionModel} placeholder="gemma4:31b"></label>
    {:else}<label>Số kết quả tìm kiếm<input type="number" min="1" max="10" bind:value={c.results}></label>{/if}
    {#if c.authType==='bearer'}<label>API key {c.hasCredentials?'(đã lưu — để trống để giữ nguyên)':''}<input type="password" autocomplete="off" bind:value={c.apiKey} placeholder="Nhập API key mới nếu muốn đổi"></label>{/if}
    {#if c.authType==='basic'}<label>Username<input autocomplete="off" bind:value={c.username} placeholder="Username mới (để trống để giữ)"></label><label>Password {c.hasCredentials?'(đã lưu — để trống để giữ)':''}<input type="password" autocomplete="off" bind:value={c.password} placeholder="Password mới"></label>{/if}
    </div>
    {#if c.hasCredentials && c.authType!=='none'}<label class="checkbox"><input type="checkbox" bind:checked={c.clearCredentials}> Xóa credential đã lưu (cần nhập credential mới)</label>{/if}
    <div class="actions"><button class="outline" disabled={busyProvider!==''} onclick={()=>connectionAction(c,false)}>Kiểm tra kết nối</button><button disabled={busyProvider!==''} onclick={()=>connectionAction(c,true)}>Kiểm tra & Lưu DB</button></div>
    {#if connectionNotice[c.provider]}<p class="connection-notice">{connectionNotice[c.provider]}</p>{/if}
   </div>
  {/each}
  </section>
  <section class="card ai-processing-card">
   <div class="flex"><div><h2>Module: AI Processing</h2><p>Điều khiển cách AI nhận tin, sử dụng bộ nhớ hội thoại, gọi công cụ tìm kiếm và xử lý ảnh. Tất cả giá trị được lưu trong PostgreSQL.</p></div><span class:good={runtimeConfig.aiEnabled} class="status">{runtimeConfig.aiEnabled?'Đang bật':'Đang tắt'}</span></div>
   <label class="checkbox ai-toggle"><input type="checkbox" bind:checked={runtimeConfig.aiEnabled}> Bật xử lý tin nhắn bằng AI <small>(tắt sẽ ngừng nhận thêm tác vụ AI; tác vụ đang chạy vẫn hoàn tất)</small></label>
   <div class="field-grid">
    <label>AI concurrency <small>Số tin nhắn xử lý đồng thời</small><input type="number" min="1" max="10" bind:value={runtimeConfig.aiConcurrency}></label>
    <label>Context messages <small>Số cặp hội thoại gần nhất đưa vào model</small><input type="number" min="1" max="30" bind:value={runtimeConfig.maxContextMessages}></label>
    <label>Tool call rounds <small>Số vòng tối đa cho SearXNG và các tools</small><input type="number" min="1" max="5" bind:value={runtimeConfig.aiMaxToolRounds}></label>
    <label>AI timeout (ms) <small>Giới hạn thời gian mỗi lần gọi Ollama</small><input type="number" min="10000" max="600000" bind:value={runtimeConfig.aiTimeoutMs}></label>
    <label>Vision max image (bytes) <small>Giới hạn ảnh Zalo gửi đến Ollama Vision</small><input type="number" min="1024" max="16777216" bind:value={runtimeConfig.maxImageBytes}></label>
    <label>Send delay (ms) <small>Khoảng nghỉ trước khi gửi phản hồi Zalo</small><input type="number" min="1000" max="60000" bind:value={runtimeConfig.zaloSendDelayMs}></label>
   </div>
   <div class="actions module-actions">
    <button onclick={saveRuntime}>Lưu cấu hình xử lý AI</button>
    <button class="outline" disabled={aiTesting} onclick={testAI}>{aiTesting?'Đang kiểm tra...':'Test AI Inference'}</button>
    <button class="outline" onclick={()=>{page='settings';void refresh()}}>Chỉnh System Prompt</button>
   </div>
   {#if runtimeNotice}<p class="connection-notice">{runtimeNotice}</p>{/if}
   {#if aiTestNotice}<p class="connection-notice">{aiTestNotice}</p>{/if}
   <p class="muted-note">Chat Model / Vision Model và SearXNG được cấu hình ở hai module phía trên. Test AI Inference sẽ dùng model đã lưu, không gửi tin nhắn Zalo và không ghi lịch sử hội thoại.</p>
  </section>
 {:else if page==='users'}
  <section class="card"><h2>Danh sách tài khoản ({users.length})</h2><div class="scroll"><table><thead><tr><th>Zalo ID</th><th>Trạng thái</th><th>Truy cập gần nhất</th><th>Thao tác</th></tr></thead><tbody>{#each users as u}<tr><td class="mono">{u.thread_id}</td><td><span class:good={u.enabled} class="status">{u.role} {u.enabled?'• AI bật':''}</span></td><td>{new Date(u.last_seen_at).toLocaleString('vi-VN')}</td><td class="actions"><button onclick={()=>action(u.thread_id,'approve')}>Duyệt</button><button onclick={()=>action(u.thread_id,'disable')}>Tắt</button><button class="danger" onclick={()=>action(u.thread_id,'block')}>Chặn</button><button onclick={()=>action(u.thread_id,'unblock')}>Mở chặn</button></td></tr>{/each}</tbody></table></div></section>
 {:else if page==='messages'}
  <section class="card"><div class="flex"><h2>Tin nhắn gần đây</h2><div class="flex"><input placeholder="Lọc theo Zalo ID" bind:value={selectedThread}><button onclick={refresh}>Lọc</button></div></div><div class="scroll"><table><thead><tr><th>Thời gian</th><th>Zalo ID</th><th>Loại</th><th>Tin nhắn</th><th>Trạng thái</th><th></th></tr></thead><tbody>{#each messages as m}<tr><td>{new Date(m.created_at).toLocaleString('vi-VN')}</td><td class="mono">{m.thread_id}</td><td>{m.attachment_type}</td><td title={m.message_text}>{String(m.message_text).slice(0,100)}</td><td><span class:good={m.status==='replied'} class="status">{m.status}</span></td><td><button onclick={()=>showHistory(m.thread_id)}>Lịch sử</button></td></tr>{/each}</tbody></table></div></section>{#if history.length}<section class="card"><h2>Hội thoại {selectedThread}</h2><div class="chat">{#each history as h}<div class:user={h.role==='user'} class="bubble"><small>{h.role}</small><p>{h.content}</p></div>{/each}</div></section>{/if}
 {:else if page==='settings'}
  <section class="card"><h2>System Prompt</h2><p>Prompt thay đổi tại đây được áp dụng từ tin nhắn tiếp theo, không cần khởi động lại backend.</p><textarea bind:value={prompt} rows="18" spellcheck="false"></textarea><div class="right"><button onclick={savePrompt}>Lưu System Prompt</button></div></section><section class="card"><h2>Cấu hình xử lý AI</h2><p>Concurrency, context, giới hạn Vision, tool rounds và timeout được quản lý trong Modules → AI Processing.</p><button class="outline" onclick={()=>{page='modules';void refresh()}}>Mở AI Processing</button></section>
 {:else if page==='audit'}
  <section class="card"><h2>Nhật ký quản trị</h2><div class="scroll"><table><thead><tr><th>Thời gian</th><th>Người thực hiện</th><th>Thao tác</th><th>Đối tượng</th></tr></thead><tbody>{#each audit as row}<tr><td>{new Date(row.created_at).toLocaleString('vi-VN')}</td><td>{row.actor}</td><td>{row.action}</td><td>{row.target}</td></tr>{/each}</tbody></table></div></section>
 {/if}
 </div></div>
{/if}
