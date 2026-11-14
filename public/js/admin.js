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
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}
async function enableBookingNotifications() {
  const button = $("enablePushBtn"), message = $("pushMessage");
  button.disabled = true; message.textContent = "Notification setup हो रहा है…";
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      throw new Error("इस browser में Push Notification supported नहीं है। Chrome में वेबसाइट खोलें।");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Browser notification permission Allow करें।");
    const setup = await api("/api/admin/push/setup", {method:"POST", body:JSON.stringify({})});
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:urlBase64ToUint8Array(setup.publicKey)});
    await api("/api/admin/push/subscribe", {method:"POST", body:JSON.stringify(subscription)});
    message.textContent = "✅ इस मोबाइल पर नई Booking की notification चालू हो गई है।";
  } catch (err) {
    message.textContent = "❌ " + err.message;
    button.disabled = false;
  }
}

async function init() {
  const d = await api("/api/admin/csrf");
  csrfToken = d.csrfToken;
  if (d.loggedIn) showDashboard();
}
function showLogin() { loginSection.hidden=false; dashboard.hidden=true; }
function showDashboard() { loginSection.hidden=true; dashboard.hidden=false; $("enablePushBtn").disabled=false; refreshAll(); }
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("loginMessage").textContent="Logging in…";
  const body=Object.fromEntries(new FormData(e.currentTarget).entries());
  try { const d=await api("/api/admin/login",{method:"POST",body:JSON.stringify(body)}); csrfToken=d.csrfToken; showDashboard(); }
  catch(err){$("loginMessage").textContent=err.message;}
});
$("enablePushBtn").addEventListener("click", enableBookingNotifications);
$("logoutBtn").addEventListener("click", async()=>{try{await api("/api/admin/logout",{method:"POST"});csrfToken="";showLogin();}catch(e){$("adminMessage").textContent=e.message;}});
async function refreshAll(){await Promise.all([loadSummary(),loadBookings(),loadServices()]);}
async function loadSummary(){const d=await api("/api/admin/summary");$("totalCount").textContent=d.counts.total||0;$("pendingCount").textContent=d.counts.pending||0;$("confirmedCount").textContent=d.counts.confirmed||0;$("completedCount").textContent=d.counts.completed||0;}
function cell(text){const td=document.createElement("td");td.textContent=text??"";return td;}
async function loadBookings(){
  const status=$("statusFilter").value;const rows=await api("/api/admin/bookings"+(status?"?status="+encodeURIComponent(status):""));
  const wrap=$("bookingList");wrap.replaceChildren();
  if(!rows.length){wrap.textContent="अभी कोई booking नहीं है।";return;}
  const table=document.createElement("table"),thead=document.createElement("thead"),tr=document.createElement("tr");
  ["Customer","Phone","Service","Date & Time","Note","Status","Update"].forEach(t=>{const th=document.createElement("th");th.textContent=t;tr.append(th)});thead.append(tr);table.append(thead);
  const tbody=document.createElement("tbody");
  rows.forEach(b=>{
    const row=document.createElement("tr");row.append(cell(b.customer_name),cell(b.phone),cell(b.service_name),cell(b.booking_date+" "+b.booking_time),cell(b.note));
    const statusTd=cell("");const status=document.createElement("select");status.className="status-select";
    ["New","Confirmed","Completed","Cancelled"].forEach(s=>{const o=document.createElement("option");o.value=s;o.textContent=s;o.selected=b.status===s;status.append(o)});statusTd.append(status);row.append(statusTd);
    const actionTd=cell("");const btn=document.createElement("button");btn.className="small-btn";btn.textContent="Save";btn.addEventListener("click",async()=>{try{await api(`/api/admin/bookings/${b.id}`,{method:"PATCH",body:JSON.stringify({status:status.value})});await refreshAll();}catch(e){$("adminMessage").textContent=e.message;}});actionTd.append(btn);row.append(actionTd);tbody.append(row);
  });table.append(tbody);wrap.append(table);
}
$("statusFilter").addEventListener("change",loadBookings);
async function loadServices(){
  const services=await api("/api/admin/services"),wrap=$("serviceAdminList");wrap.replaceChildren();
  services.forEach(s=>{
    const row=document.createElement("div");row.className="service-admin-row";
    const category=document.createElement("input");category.value=s.category;
    const name=document.createElement("input");name.value=s.name;
    const price=document.createElement("input");price.value=s.price;
    const active=document.createElement("input");active.type="checkbox";active.checked=!!s.active;
    const activeLabel=document.createElement("label");activeLabel.append(active,document.createTextNode(" Active"));
    const save=document.createElement("button");save.textContent="Save";save.addEventListener("click",async()=>{try{await api(`/api/admin/services/${s.id}`,{method:"PATCH",body:JSON.stringify({category:category.value,name:name.value,price:price.value,description:s.description||"",active:active.checked})});$("adminMessage").textContent="Service saved."; }catch(e){$("adminMessage").textContent=e.message;}});
    row.append(category,name,price,activeLabel,save);wrap.append(row);
  });
}
$("addServiceForm").addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget).entries());try{await api("/api/admin/services",{method:"POST",body:JSON.stringify(d)});e.currentTarget.reset();await loadServices();$("adminMessage").textContent="New service added.";}catch(err){$("adminMessage").textContent=err.message;}});
document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b===btn));["bookings","services","gallery"].forEach(name=>$(name+"Tab").hidden=btn.dataset.tab!==name);}));
$("galleryForm").addEventListener("submit",async e=>{e.preventDefault();const data=new FormData(e.currentTarget);try{const result=await api("/api/admin/gallery",{method:"POST",body:data});$("galleryMessage").textContent="Uploaded: "+result.url;e.currentTarget.reset();}catch(err){$("galleryMessage").textContent=err.message;}});
init().catch(()=>showLogin());
