const nodemailer = require("nodemailer");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function configured() {
  return process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ORDER_NOTIFY_EMAIL;
}

function buildHtml(o) {
  const rows = o.items
    .map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.size)}</td><td>${i.qty}</td><td>${i.price * i.qty} ر.س</td></tr>`)
    .join("");
  return `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif">
    <h2>طلب جديد ${esc(o.orderNo)}</h2>
    <p><b>الاسم:</b> ${esc(o.name)}<br><b>الجوال:</b> ${esc(o.phone)}<br><b>العنوان:</b> ${esc(o.city)}</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
      <tr><th>المنتج</th><th>المقاس</th><th>الكمية</th><th>السعر</th></tr>${rows}
    </table>
    <p>المجموع: ${o.subtotal} ر.س<br>الشحن: ${o.shipping ? o.shipping + " ر.س" : "مجاني"}<br><b>الإجمالي: ${o.total} ر.س</b> (الدفع عند الاستلام)</p>
  </div>`;
}

async function sendOrderEmail(o) {
  if (!configured()) throw new Error("email not configured");
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({
    from: `"ستنر ليلى" <${process.env.SMTP_USER}>`,
    to: process.env.ORDER_NOTIFY_EMAIL,
    replyTo: undefined,
    subject: `طلب جديد ${o.orderNo} - ${o.total} ر.س`,
    html: buildHtml(o),
  });
}

module.exports = { sendOrderEmail };
