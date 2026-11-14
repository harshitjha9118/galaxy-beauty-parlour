const $ = (id) => document.getElementById(id);
const grid = $("servicesGrid"), select = $("serviceSelect"), form = $("bookingForm"), msg = $("bookingMessage");
const dateInput = $("dateInput");
dateInput.min = new Date().toISOString().slice(0,10);
$("menuBtn").addEventListener("click", () => $("nav").classList.toggle("open"));
$("nav").querySelectorAll("a").forEach(a => a.addEventListener("click", () => $("nav").classList.remove("open")));

async function loadServices() {
  try {
    const res = await fetch("/api/services");
    const services = await res.json();
    grid.replaceChildren();
    select.innerHTML = '<option value="">सर्विस चुनें</option>';
    if (!services.length) grid.textContent = "अभी कोई सर्विस उपलब्ध नहीं है।";
    services.forEach(s => {
      const card = document.createElement("article"); card.className = "service-card";
      const cat = document.createElement("small"); cat.textContent = s.category.toUpperCase();
      const title = document.createElement("h3"); title.textContent = s.name;
      const desc = document.createElement("p"); desc.textContent = s.description || "आपकी पसंद की ब्यूटी सर्विस";
      const price = document.createElement("div"); price.className = "price"; price.textContent = "₹" + s.price;
      card.append(cat,title,desc,price); grid.append(card);
      const option = document.createElement("option"); option.value = s.id; option.textContent = `${s.name} — ₹${s.price}`; select.append(option);
    });
  } catch { grid.textContent = "Services लोड नहीं हो पाईं। सर्वर चालू है या नहीं, जाँचें।"; }
}
form.addEventListener("submit", async e => {
  e.preventDefault(); msg.textContent = "बुकिंग भेजी जा रही है…";
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await fetch("/api/bookings", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Booking failed");
    msg.textContent = `धन्यवाद! आपकी बुकिंग रिक्वेस्ट #${result.booking.id} सेव हो गई है।`;
    form.reset(); dateInput.min = new Date().toISOString().slice(0,10);
  } catch(err) { msg.textContent = err.message; }
});
loadServices();
