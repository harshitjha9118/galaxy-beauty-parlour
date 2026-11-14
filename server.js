require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { Pool } = require("pg");
const webpush = require("web-push");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");

if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 ||
    !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error("Setup incomplete: set DATABASE_URL, SESSION_SECRET (32+ chars), ADMIN_USERNAME and ADMIN_PASSWORD (12+ chars).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "30kb" }));

app.use(session({
  name: "galaxy_owner_session",
  store: new pgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true,
    ttl: 8 * 60 * 60
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false });
const bookingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
const mutationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: "draft-7", legacyHeaders: false });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(allowed.includes(file.mimetype) ? null : new Error("Only JPG, PNG or WEBP images are allowed"), allowed.includes(file.mimetype));
  }
});

let ADMIN_HASH;
let vapidReady = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidReady) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:owner@example.com",
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

function cleanText(value, max) { return String(value ?? "").trim().slice(0, max); }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00");
  const today = new Date(); today.setHours(0,0,0,0);
  return !Number.isNaN(d.getTime()) && d >= today &&
    d.getFullYear() === Number(value.slice(0,4)) &&
    d.getMonth()+1 === Number(value.slice(5,7)) && d.getDate() === Number(value.slice(8,10));
}
function requireOwner(req, res, next) {
  if (!req.session.owner) return res.status(401).json({ error: "Please login again." });
  next();
}
function requireCsrf(req, res, next) {
  if (!req.session.csrfToken || req.get("x-csrf-token") !== req.session.csrfToken)
    return res.status(403).json({ error: "Security token invalid. Refresh and try again." });
  next();
}
async function sendOwnerPush(payload) {
  if (!vapidReady) return;
  const { rows } = await pool.query("SELECT id, subscription FROM push_subscriptions");
  await Promise.all(rows.map(async row => {
    try { await webpush.sendNotification(row.subscription, JSON.stringify(payload)); }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410)
        await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [row.id]);
      else console.error("Push notification error:", err.message);
    }
  }));
}

const DEFAULT_SITE_SETTINGS = {
  parlourName: "Galaxy Beauty Parlour",
  tagline: "BEAUTY · CARE · CONFIDENCE",
  heroEyebrow: "A LITTLE LUXURY, JUST FOR YOU",
  heroTitle: "Beauty is your signature.",
  heroText: "आपकी खूबसूरती और आत्मविश्वास के लिए खास देखभाल। Skin care से लेकर bridal makeup तक — अपनी पसंद की सर्विस चुनें।",
  phone: "",
  whatsappNumber: "",
  address: "",
  openingHours: "",
  bookingNotice: "बुकिंग अनुरोध भेजने के बाद पार्लर आपसे दिए गए मोबाइल नंबर पर संपर्क कर सकता है।",
  instagramUrl: ""
};

async function readSiteSettings() {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='site_settings'");
  return { ...DEFAULT_SITE_SETTINGS, ...(rows[0]?.value || {}) };
}

app.get("/api/public/config", async (_req, res, next) => {
  try {
    res.json({ ...(await readSiteSettings()), pushEnabled: vapidReady, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
  } catch (e) { next(e); }
});

app.get("/api/services", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id,category,name,price,description FROM services WHERE active=TRUE ORDER BY category,id");
    res.json(rows);
  } catch (e) { next(e); }
});

app.post("/api/bookings", bookingLimiter, async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 70);
    const phone = cleanText(req.body.phone, 15).replace(/[\s-]/g, "");
    const serviceId = Number(req.body.serviceId);
    const date = cleanText(req.body.date, 10);
    const time = cleanText(req.body.time, 5);
    const note = cleanText(req.body.note, 500);
    if (name.length < 2) return res.status(400).json({ error: "Please enter your name." });
    if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    if (!Number.isInteger(serviceId) || serviceId < 1) return res.status(400).json({ error: "Please select a service." });
    if (!validDate(date)) return res.status(400).json({ error: "Choose today or a future date." });
    if (!/^(09|1\d|2[0-1]):[0-5]\d$/.test(time)) return res.status(400).json({ error: "Choose a time between 09:00 and 21:59." });
    const serviceResult = await pool.query("SELECT id,name FROM services WHERE id=$1 AND active=TRUE", [serviceId]);
    const service = serviceResult.rows[0];
    if (!service) return res.status(400).json({ error: "Selected service is not available." });
    const result = await pool.query(
      `INSERT INTO bookings(customer_name,phone,service_id,service_name,booking_date,booking_time,note)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,customer_name,service_name,booking_date,booking_time,status`,
      [name, phone, service.id, service.name, date, time, note]
    );
    const booking = result.rows[0];
    sendOwnerPush({
      title: "Galaxy Beauty Parlour",
      body: `नई बुकिंग: ${booking.customer_name} — ${booking.service_name}`,
      url: "/admin"
    }).catch(err => console.error("Push dispatch failed:", err.message));
    res.status(201).json({ message: "Booking request received.", booking });
  } catch (e) { next(e); }
});

app.get("/api/admin/csrf", (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrfToken, loggedIn: Boolean(req.session.owner) });
});

app.post("/api/admin/login", loginLimiter, async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 60);
    const password = String(req.body.password || "");
    const validUser = username === process.env.ADMIN_USERNAME;
    const validPass = await bcrypt.compare(password, ADMIN_HASH);
    if (!validUser || !validPass) return res.status(401).json({ error: "Username or password is incorrect." });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not start secure session." });
      req.session.owner = true;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: "Could not save session." });
        res.json({ message: "Login successful.", csrfToken: req.session.csrfToken });
      });
    });
  } catch (e) { next(e); }
});

app.post("/api/admin/logout", requireOwner, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("galaxy_owner_session", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ message: "Logged out." });
  });
});

app.get("/api/admin/summary", requireOwner, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='New')::int AS pending,
      COUNT(*) FILTER (WHERE status='Confirmed')::int AS confirmed,
      COUNT(*) FILTER (WHERE status='Completed')::int AS completed FROM bookings`);
    res.json({ counts: rows[0] });
  } catch (e) { next(e); }
});

app.get("/api/admin/bookings", requireOwner, async (req, res, next) => {
  try {
    const status = cleanText(req.query.status, 20);
    const valid = ["New","Confirmed","Completed","Cancelled"].includes(status);
    const result = valid
      ? await pool.query("SELECT * FROM bookings WHERE status=$1 ORDER BY booking_date DESC,booking_time DESC,id DESC", [status])
      : await pool.query("SELECT * FROM bookings ORDER BY booking_date DESC,booking_time DESC,id DESC");
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.patch("/api/admin/bookings/:id", requireOwner, requireCsrf, mutationLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id), status = cleanText(req.body.status, 20);
    if (!Number.isInteger(id) || id < 1 || !["New","Confirmed","Completed","Cancelled"].includes(status))
      return res.status(400).json({ error: "Invalid booking update." });
    const result = await pool.query("UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id", [status,id]);
    if (!result.rowCount) return res.status(404).json({ error: "Booking not found." });
    res.json({ message: "Booking updated." });
  } catch (e) { next(e); }
});

app.get("/api/admin/services", requireOwner, async (_req, res, next) => {
  try { const { rows } = await pool.query("SELECT * FROM services ORDER BY category,id"); res.json(rows); }
  catch (e) { next(e); }
});

app.post("/api/admin/services", requireOwner, requireCsrf, mutationLimiter, async (req, res, next) => {
  try {
    const category = cleanText(req.body.category, 50), name = cleanText(req.body.name, 80);
    const price = cleanText(req.body.price, 30), description = cleanText(req.body.description, 200);
    if (!category || !name || !price) return res.status(400).json({ error: "Category, service name and price are required." });
    await pool.query("INSERT INTO services(category,name,price,description) VALUES($1,$2,$3,$4)", [category,name,price,description]);
    res.status(201).json({ message: "Service added." });
  } catch (e) { next(e); }
});

app.patch("/api/admin/services/:id", requireOwner, requireCsrf, mutationLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id), category = cleanText(req.body.category, 50);
    const name = cleanText(req.body.name, 80), price = cleanText(req.body.price, 30);
    const description = cleanText(req.body.description, 200), active = Boolean(req.body.active);
    if (!Number.isInteger(id) || id < 1 || !category || !name || !price) return res.status(400).json({ error: "Invalid service details." });
    const result = await pool.query("UPDATE services SET category=$1,name=$2,price=$3,description=$4,active=$5 WHERE id=$6 RETURNING id",
      [category,name,price,description,active,id]);
    if (!result.rowCount) return res.status(404).json({ error: "Service not found." });
    res.json({ message: "Service saved." });
  } catch (e) { next(e); }
});

app.get("/api/admin/settings", requireOwner, async (_req, res, next) => {
  try { res.json(await readSiteSettings()); } catch (e) { next(e); }
});

app.put("/api/admin/settings", requireOwner, requireCsrf, mutationLimiter, async (req, res, next) => {
  try {
    const allowed = Object.keys(DEFAULT_SITE_SETTINGS);
    const settings = {};
    for (const key of allowed) settings[key] = cleanText(req.body[key], key === "heroText" || key === "bookingNotice" ? 600 : 180);
    if (!settings.parlourName) return res.status(400).json({ error: "Parlour name is required." });
    for (const key of ["instagramUrl"]) {
      if (settings[key] && !/^https:\/\//i.test(settings[key])) return res.status(400).json({ error: "Social link must start with https://" });
    }
    await pool.query("INSERT INTO app_settings(key,value) VALUES('site_settings',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [JSON.stringify(settings)]);
    res.json({ message: "Website settings saved.", settings });
  } catch (e) { next(e); }
});

app.delete("/api/admin/services/:id", requireOwner, requireCsrf, mutationLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid service." });
    const result = await pool.query("DELETE FROM services WHERE id=$1 RETURNING id", [id]);
    if (!result.rowCount) return res.status(404).json({ error: "Service not found." });
    res.json({ message: "Service deleted." });
  } catch (e) { next(e); }
});

app.get("/api/admin/push/status", requireOwner, (_req, res) => {
  res.json({ configured: vapidReady, message: vapidReady ? "Push notifications ready." : "Notification setup needed." });
});

// Owner-triggered one-time setup: generate and store VAPID keys in PostgreSQL.
app.post("/api/admin/push/setup", requireOwner, requireCsrf, mutationLimiter, async (_req, res, next) => {
  try {
    const saved = await pool.query("SELECT value FROM app_settings WHERE key='vapid_keys'");
    let keys = saved.rows[0]?.value;
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await pool.query("INSERT INTO app_settings(key,value) VALUES('vapid_keys',$1::jsonb) ON CONFLICT(key) DO NOTHING", [JSON.stringify(keys)]);
      const again = await pool.query("SELECT value FROM app_settings WHERE key='vapid_keys'");
      keys = again.rows[0].value;
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:owner@example.com", keys.publicKey, keys.privateKey);
    vapidReady = true;
    res.json({ configured: true, publicKey: keys.publicKey });
  } catch (e) { next(e); }
});

app.post("/api/admin/push/subscribe", requireOwner, requireCsrf, async (req, res, next) => {
  try {
    if (!vapidReady) return res.status(503).json({ error: "Push notifications are not configured on the server yet." });
    const sub = req.body;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
      return res.status(400).json({ error: "Invalid push subscription." });
    await pool.query(`INSERT INTO push_subscriptions(endpoint,subscription)
      VALUES($1,$2::jsonb) ON CONFLICT(endpoint) DO UPDATE SET subscription=EXCLUDED.subscription`,
      [sub.endpoint, JSON.stringify(sub)]);
    res.status(201).json({ message: "This device will receive new booking alerts." });
  } catch (e) { next(e); }
});

app.post("/api/admin/gallery", requireOwner, requireCsrf, mutationLimiter, upload.single("image"), (_req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an image first." });
  // Render's free filesystem is temporary. This starter returns a data URL so the image remains in the browser response,
  // but persistent gallery storage should be connected to object storage before using this feature in production.
  const mime = req.file.mimetype;
  const url = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  res.status(201).json({ message: "Image received. Connect permanent object storage for a persistent public gallery.", url });
});

app.use(express.static(path.join(ROOT, "public")));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: "Server error. Please try again." });
});

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      price TEXT NOT NULL,
      description TEXT DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      service_id BIGINT REFERENCES services(id) ON DELETE SET NULL,
      service_name TEXT NOT NULL,
      booking_date DATE NOT NULL,
      booking_time TEXT NOT NULL,
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'New' CHECK(status IN ('New','Confirmed','Completed','Cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM services");
  if (count.rows[0].count === 0) {
    const seed = [
      ["Facial & Skin Care","Normal Facial","399"],["Facial & Skin Care","Fruit Facial","499"],
      ["Facial & Skin Care","Gold Facial","699"],["Facial & Skin Care","Diamond Facial","899"],
      ["Facial & Skin Care","Cleanup","299"],["Facial & Skin Care","De-Tan","399"],
      ["Threading & Waxing","Eyebrow","30"],["Threading & Waxing","Upper Lip","20"],
      ["Threading & Waxing","Full Face Threading","100"],["Threading & Waxing","Full Arms Wax","199"],
      ["Threading & Waxing","Full Legs Wax","299"],["Threading & Waxing","Underarms Wax","99"],
      ["Threading & Waxing","Full Body Wax","999"],["Makeup","Normal Makeup","799"],
      ["Makeup","Party Makeup","1499"],["Makeup","Engagement Makeup","2499"],
      ["Makeup","Bridal Makeup","5999"],["Makeup","HD Bridal Makeup","8999"],
      ["Hair Care","Hair Cut","149"],["Hair Care","Hair Wash","99"],["Hair Care","Hair Spa","499"],
      ["Hair Care","Hair Smoothening","1,999 से"],["Hair Care","Hair Straightening","2,499 से"],
      ["Hair Care","Hair Colour","499 से"],["Mehndi","Simple Mehndi","199"],
      ["Mehndi","Arabic Mehndi","299"],["Mehndi","Bridal Mehndi","1,499 से"],["Mehndi","Full Hand Mehndi","499"]
    ];
    for (const s of seed) await pool.query("INSERT INTO services(category,name,price) VALUES($1,$2,$3)", s);
  }
  ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  app.listen(PORT, "0.0.0.0", () => console.log(`Galaxy Beauty Parlour running on port ${PORT}`));
}

initialize().catch(err => { console.error("Startup failed:", err); process.exit(1); });
