const Cart = (() => {
  const KEY = "naseej-cart";
  const FREE_FROM = 300, SHIPPING = 25;
  let items = JSON.parse(localStorage.getItem(KEY) || "[]");
  let done = false;
  const $c = (s) => document.querySelector(s);

  const save = () => localStorage.setItem(KEY, JSON.stringify(items));
  const subtotal = () => items.reduce((n, i) => n + i.price * i.qty, 0);
  const count = () => items.reduce((n, i) => n + i.qty, 0);

  function toast(msg) {
    const t = $c("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("show"), 2000);
  }

  function open(v) {
    $c("#drawer").classList.toggle("open", v);
    $c("#drawer").setAttribute("aria-hidden", !v);
    $c("#overlay").classList.toggle("show", v);
    if (v) { done = false; render(); }
  }

  function add(p, size) {
    const row = items.find((i) => i.id === p.id && i.size === size);
    if (row) row.qty++;
    else items.push({ id: p.id, name: p.name, price: p.price, img: p.img, size, qty: 1 });
    save(); render();
    toast(`تمت إضافة «${p.name}» إلى السلة`);
  }

  function change(idx, d) {
    items[idx].qty += d;
    if (items[idx].qty < 1) items.splice(idx, 1);
    save(); render();
  }

  function line(i, idx) {
    return `<div class="line">
      <img src="${i.img}" alt="${i.name}">
      <div><h4>${i.name}</h4><small>المقاس: ${i.size} · ${i.price} ر.س</small>
        <div class="qty"><button data-d="1" data-i="${idx}" aria-label="زيادة">+</button><span>${i.qty}</span><button data-d="-1" data-i="${idx}" aria-label="إنقاص">−</button></div></div>
      <button class="rm" data-d="-999" data-i="${idx}">حذف</button>
    </div>`;
  }

  function foot() {
    const sub = subtotal(), ship = sub >= FREE_FROM ? 0 : SHIPPING;
    const hint = ship ? `أضف ${FREE_FROM - sub} ر.س للحصول على شحن مجاني` : "تهانينا! الشحن مجاني";
    return `<p class="free">${hint}</p>
      <div class="sum"><span>المجموع</span><span>${sub} ر.س</span></div>
      <div class="sum"><span>الشحن</span><span>${ship ? ship + " ر.س" : "مجاني"}</span></div>
      <div class="sum sum--total"><span>الإجمالي</span><span>${sub + ship} ر.س</span></div>
      <form class="co" id="checkout">
        <input name="name" required placeholder="الاسم الكامل" autocomplete="name">
        <input name="phone" required type="tel" placeholder="رقم الجوال" dir="rtl" autocomplete="tel">
        <input name="city" required placeholder="المدينة والعنوان" autocomplete="address-level2">
        <button class="btn btn--primary">إتمام الطلب (الدفع عند الاستلام)</button>
      </form>`;
  }

  function render() {
    $c("#cartCount").textContent = count();
    const body = $c("#cartItems"), f = $c("#cartFoot");
    if (done) {
      body.innerHTML = `<div class="done"><h3>شكراً لك!</h3><p>تم استلام طلبك بنجاح.</p><p class="order-no">رقم الطلب: <b dir="ltr">${done.orderNo}</b></p><p>الإجمالي: ${done.total} ر.س (الدفع عند الاستلام)</p><p>سنتواصل معك قريباً لتأكيد الشحن.</p></div>`;
      f.innerHTML = "";
    } else if (!items.length) {
      body.innerHTML = `<p class="empty">سلتك فارغة حالياً.<br>ابدأ بإضافة قطعك المفضلة.</p>`;
      f.innerHTML = "";
    } else {
      body.innerHTML = items.map(line).join("");
      f.innerHTML = foot();
    }
    f.hidden = !f.innerHTML;
  }

  $c("#cartBtn").addEventListener("click", () => open(true));
  $c("#closeCart").addEventListener("click", () => open(false));
  $c("#overlay").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && open(false));
  $c("#cartItems").addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (b) change(+b.dataset.i, +b.dataset.d);
  });
  $c("#cartFoot").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target, btn = form.querySelector("button");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "جارٍ إرسال الطلب...";
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(new FormData(form)),
          items: items.map(({ id, size, qty }) => ({ id, size, qty })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "تعذر إرسال الطلب، حاول مرة أخرى.");
      items = []; save(); done = data; render();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  render();
  return { add };
})();
