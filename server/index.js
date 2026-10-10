const express = require("express");
const path = require("node:path");
const PRODUCTS = require("../js/products.js");
const { createOrder, markEmailSent } = require("./db");
const { sendOrderEmail } = require("./mail");

const FREE_FROM = 300, SHIPPING = 25;
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "20kb" }));

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 8;
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

app.post("/api/orders", async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "محاولات كثيرة، حاول بعد دقيقة." });
  const name = clean(req.body.name, 80), phone = clean(req.body.phone, 20), city = clean(req.body.city, 160);
  if (name.length < 2 || city.length < 3 || !/^[+\d][\d\s-]{7,17}$/.test(phone)) {
    return res.status(400).json({ error: "تأكد من الاسم ورقم الجوال والعنوان." });
  }
  const raw = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
  const items = [];
  for (const r of raw) {
    const p = PRODUCTS.find((x) => x.id === Number(r.id));
    const qty = Math.floor(Number(r.qty));
    if (!p || !p.sizes.includes(r.size) || !(qty >= 1 && qty <= 20)) {
      return res.status(400).json({ error: "بعض المنتجات في السلة غير صالحة." });
    }
    items.push({ id: p.id, name: p.name, size: r.size, qty, price: p.price });
  }
  if (!items.length) return res.status(400).json({ error: "السلة فارغة." });

  const subtotal = items.reduce((n, i) => n + i.price * i.qty, 0);
  const shipping = subtotal >= FREE_FROM ? 0 : SHIPPING;
  const order = { name, phone, city, items, subtotal, shipping, total: subtotal + shipping };
  try {
    const { id, orderNo } = createOrder(order);
    res.status(201).json({ orderNo, total: order.total });
    sendOrderEmail({ ...order, orderNo })
      .then(() => markEmailSent(id))
      .catch((e) => console.error(`[order ${orderNo}] email failed:`, e.message));
  } catch (e) {
    console.error("order failed:", e);
    res.status(500).json({ error: "تعذر حفظ الطلب، حاول مرة أخرى." });
  }
});

const root = path.join(__dirname, "..");
app.use("/css", express.static(path.join(root, "css")));
app.use("/js", express.static(path.join(root, "js")));
app.get("/", (_req, res) => res.sendFile(path.join(root, "index.html")));

const argPort = process.argv.indexOf("--port");
const port = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.PORT) || 5173;
app.listen(port, "0.0.0.0", () => console.log(`store on ${port}`));
