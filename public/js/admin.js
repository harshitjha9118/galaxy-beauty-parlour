const $ = id => document.getElementById(id);
let csrfToken = "";
const loginSection = $("loginSection"), dashboard = $("dashboard");
async function api(url, options={}) {
  const headers = {...(options.headers||{})};
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(url,{...options,headers});
  const data = res.status === 204 ? {} : await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const raw = atob((base64String + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}
async function enableBookingNotifications() {
  const button = $("enablePushBtn"), message = $("pushMessage"); button.disabled = true; message.textContent = "Notification setup हो रहा है…";
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) throw new Error("Chrome में वेबसाइट खोलकर कोशिश करें।");
    if (Notification.permission !== "granted") { const permission = await Notification.requestPermission(); if (permission !== "granted") throw new Error("Browser notification permission Allow करें।"); }
    const setup = await api("/api/admin/push/setup", {method:"POST", body:JSON.stringify({})});
    const registration = await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
    let sub = await registration.pushManager.getSubscription();
    if (!sub) sub = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:urlBase64ToUint8Array(setup.publicKey)});
    await api("/api/admin/push/subscribe", {method:"POST", body:JSON.stringify(sub)});
    message.textContent = "✅ इस मोबाइल पर नई Booking Alerts चालू हो गई हैं।";
  } catch (e) { message.textContent = "❌ " + e.message; button.disabled = false; }
}
async function init() { const d=await api("/api/admin/csrf"); csrfToken=d.csrfToken; if(d.loggedIn) showDashboard(); }
function showLogin(){loginSection.hidden=false;dashboard.hidden=true;}
function showDashboard(){loginSection.hidden=true;dashboard.hidden=false;$("enablePushBtn").disabled=false;refreshAll().catch(e=>$("adminMessage").textContent=e.message);}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginMessage").textContent="Logging in…";const body=Object.fromEntries(new FormData(e.currentTarget).entries());try{const d=await api("/api/admin/login",{method:"POST",body:JSON.stringify(body)});csrfToken=d.csrfToken;showDashboard();}catch(err){$("loginMessage").textContent=err.message;}});
$("enablePushBtn").addEventListener("click",enableBookingNotifications);
$("logoutBtn").addEventListener("click",async()=>{try{await api("/api/admin/logout",{method:"POST"});csrfToken="";showLogin();}catch(e){$("adminMessage").textContent=e.message;}});
async function refreshAll(){await Promise.all([loadSummary(),loadBookings(),loadServices(),loadSettings()]);}
async function loadSummary(){const d=await api("/api/admin/summary");$("totalCount").textContent=d.counts.total||0;$("pendingCount").textContent=d.counts.pending||0;$("confirmedCount").textContent=d.counts.confirmed||0;$("completedCount").textContent=d.counts.completed||0;}
function cell(text){const td=document.createElement("td");td.textContent=text??"";return td;}
let allBookings=[];
async function loadBookings(){const status=$("statusFilter").value;allBookings=await api("/api/admin/bookings"+(status?"?status="+encodeURIComponent(status):""));renderBookings();}
function renderBookings(){const q=($("bookingSearch").value||"").toLowerCase(), rows=allBookings.filter(b=>[b.customer_name,b.phone,b.service_name].some(v=>String(v||"").toLowerCase().includes(q)));const wrap=$("bookingList");wrap.replaceChildren();if(!rows.length){wrap.textContent="कोई Booking नहीं मिली।";return;}const table=document.createElement("table"),thead=document.createElement("thead"),tr=document.createElement("tr");["Customer","Phone","Service","Date & Time","Note","Status","Update"].forEach(t=>{const th=document.createElement("th");th.textContent=t;tr.append(th)});thead.append(tr);table.append(thead);const tbody=document.createElement("tbody");rows.forEach(b=>{const row=document.createElement("tr");row.append(cell(b.customer_name),cell(b.phone),cell(b.service_name),cell(String(b.booking_date).slice(0,10)+" "+b.booking_time),cell(b.note));const st=cell("");const select=document.createElement("select");select.className="status-select";["New","Confirmed","Completed","Cancelled"].forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;o.selected=b.status===v;select.append(o)});st.append(select);row.append(st);const act=cell("");const btn=document.createElement("button");btn.className="small-btn";btn.textContent="Save";btn.addEventListener("click",async()=>{try{await api(`/api/admin/bookings/${b.id}`,{method:"PATCH",body:JSON.stringify({status:select.value})});$("adminMessage").textContent="Booking status updated.";await refreshAll();}catch(e){$("adminMessage").textContent=e.message;}});act.append(btn);row.append(act);tbody.append(row);});table.append(tbody);wrap.append(table);}
$("statusFilter").addEventListener("change",loadBookings);$("bookingSearch").addEventListener("input",renderBookings);
async function loadServices(){const services=await api("/api/admin/services"),wrap=$("serviceAdminList");wrap.replaceChildren();services.forEach(s=>{const row=document.createElement("div");row.className="service-admin-row";const category=document.createElement("input");category.value=s.category;category.setAttribute("aria-label","Category");const name=document.createElement("input");name.value=s.name;name.setAttribute("aria-label","Service name");const price=document.createElement("input");price.value=s.price;price.setAttribute("aria-label","Price");const desc=document.createElement("input");desc.value=s.description||"";desc.placeholder="Description";const active=document.createElement("input");active.type="checkbox";active.checked=!!s.active;const activeLabel=document.createElement("label");activeLabel.append(active,document.createTextNode(" Active"));const save=document.createElement("button");save.className="small-btn";save.textContent="Save";save.addEventListener("click",async()=>{try{await api(`/api/admin/services/${s.id}`,{method:"PATCH",body:JSON.stringify({category:category.value,name:name.value,price:price.value,description:desc.value,active:active.checked})});$("adminMessage").textContent="Service saved.";await loadServices();}catch(e){$("adminMessage").textContent=e.message;}});const del=document.createElement("button");del.className="small-btn danger";del.textContent="Delete";del.addEventListener("click",async()=>{if(!confirm(`Delete ${s.name}?`))return;try{await api(`/api/admin/services/${s.id}`,{method:"DELETE"});await loadServices();$("adminMessage").textContent="Service deleted.";}catch(e){$("adminMessage").textContent=e.message;}});row.append(category,name,price,desc,activeLabel,save,del);wrap.append(row);});}
$("addServiceForm").addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget).entries());try{await api("/api/admin/services",{method:"POST",body:JSON.stringify(d)});e.currentTarget.reset();await loadServices();$("adminMessage").textContent="New service added.";}catch(err){$("adminMessage").textContent=err.message;}});
async function loadSettings(){const d=await api("/api/admin/settings"),form=$("settingsForm");Object.keys(d).forEach(k=>{if(form.elements[k])form.elements[k].value=d[k]||"";});}
$("settingsForm").addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget).entries());$("settingsMessage").textContent="Saving…";try{await api("/api/admin/settings",{method:"PUT",body:JSON.stringify(d)});$("settingsMessage").textContent="✅ Website changes saved. Main website refresh करें।";}catch(err){$("settingsMessage").textContent="❌ "+err.message;}});
document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b===btn));["bookings","services","website","gallery"].forEach(n=>$(n+"Tab").hidden=btn.dataset.tab!==n);}));
$("galleryForm").addEventListener("submit",async e=>{e.preventDefault();const data=new FormData(e.currentTarget);try{const result=await api("/api/admin/gallery",{method:"POST",body:data});$("galleryMessage").textContent="Image received: "+result.url;e.currentTarget.reset();}catch(err){$("galleryMessage").textContent=err.message;}});
init().catch(()=>showLogin());
