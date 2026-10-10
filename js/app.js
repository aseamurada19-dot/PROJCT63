const $ = (s) => document.querySelector(s);
const state = { cat: "الكل", sort: "new", sizes: {} };
const CATS = ["الكل", "نسائي", "رجالي", "أطفال", "إكسسوارات"];

function card(p) {
  const size = state.sizes[p.id] || p.sizes[0];
  const sizes = p.sizes.map((s) => `<button class="size ${s === size ? "on" : ""}" data-id="${p.id}" data-size="${s}">${s}</button>`).join("");
  return `<article class="card">
    <div class="card__img">
      <img src="${p.img}" alt="${p.name}" loading="lazy" width="700" height="880">
      ${p.tag ? `<span class="card__tag">${p.tag}</span>` : ""}
    </div>
    <div class="card__body">
      <h3>${p.name}</h3>
      <p class="price">${p.price} ر.س ${p.old ? `<s>${p.old}</s>` : ""}</p>
      <div class="sizes">${sizes}</div>
      <button class="btn btn--primary add" data-id="${p.id}">أضف للسلة</button>
    </div>
  </article>`;
}

function renderGrid() {
  let list = PRODUCTS.filter((p) => state.cat === "الكل" || p.cat === state.cat);
  if (state.sort === "low") list.sort((a, b) => a.price - b.price);
  if (state.sort === "high") list.sort((a, b) => b.price - a.price);
  $("#grid").innerHTML = list.map(card).join("");
}

function renderChips() {
  $("#chips").innerHTML = CATS.map((c) => `<button class="chip ${c === state.cat ? "on" : ""}" data-cat="${c}">${c}</button>`).join("");
}

function setCat(c) { state.cat = c; renderChips(); renderGrid(); }

$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]");
  if (b) setCat(b.dataset.cat);
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
document.querySelectorAll(".cat").forEach((a) => a.addEventListener("click", () => setCat(a.dataset.cat)));

$("#grid").addEventListener("click", (e) => {
  const sz = e.target.closest(".size");
  if (sz) {
    state.sizes[sz.dataset.id] = sz.dataset.size;
    sz.parentElement.querySelectorAll(".size").forEach((x) => x.classList.toggle("on", x === sz));
    return;
  }
  const add = e.target.closest(".add");
  if (add) {
    const p = PRODUCTS.find((x) => x.id == add.dataset.id);
    Cart.add(p, state.sizes[p.id] || p.sizes[0]);
  }
});

$("#menuBtn").addEventListener("click", () => $("#nav").classList.toggle("open"));
$("#nav").addEventListener("click", () => $("#nav").classList.remove("open"));

$("#newsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  e.target.hidden = true;
  $("#newsOk").hidden = false;
});

renderChips();
renderGrid();
