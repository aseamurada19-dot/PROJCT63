const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const dir = path.join(__dirname, "..", "data");
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, "orders.db"));

db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  shipping INTEGER NOT NULL,
  total INTEGER NOT NULL,
  email_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

function createOrder(o) {
  const r = db
    .prepare("INSERT INTO orders (name, phone, city, items, subtotal, shipping, total) VALUES (?,?,?,?,?,?,?)")
    .run(o.name, o.phone, o.city, JSON.stringify(o.items), o.subtotal, o.shipping, o.total);
  const id = Number(r.lastInsertRowid);
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const orderNo = `NS-${d}-${String(id).padStart(4, "0")}`;
  db.prepare("UPDATE orders SET order_no = ? WHERE id = ?").run(orderNo, id);
  return { id, orderNo };
}

const markEmailSent = (id) => db.prepare("UPDATE orders SET email_sent = 1 WHERE id = ?").run(id);

module.exports = { createOrder, markEmailSent };
