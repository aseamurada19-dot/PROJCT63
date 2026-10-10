const U = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=700&q=80`;
const CLOTH = ["S", "M", "L", "XL"];
const ABAYA = ["52", "54", "56", "58"];

const LIST = [
  { id: 1, name: "عباية سوداء بتطريز ذهبي", cat: "عبايات", price: 389, sizes: ABAYA, img: U("photo-1539109136881-3be0616acf4b"), tag: "جديد" },
  { id: 2, name: "عباية كريب مفتوحة", cat: "عبايات", price: 329, old: 399, sizes: ABAYA, img: U("photo-1509631179647-0177331693ae"), tag: "خصم" },
  { id: 3, name: "فستان كتان طويل", cat: "فساتين", price: 289, sizes: CLOTH, img: U("photo-1515886657613-9f3515b0c78f") },
  { id: 4, name: "فستان ميدي منقوش", cat: "فساتين", price: 249, sizes: CLOTH, img: U("photo-1496747611176-843222e1e57c"), tag: "الأكثر مبيعاً" },
  { id: 5, name: "بلوزة قطن بأكمام واسعة", cat: "بلايز", price: 149, sizes: CLOTH, img: U("photo-1434389677669-e08b4cac3105") },
  { id: 6, name: "بلوزة ساتان بيج", cat: "بلايز", price: 169, sizes: CLOTH, img: U("photo-1485968579580-b6d095142e6e"), tag: "جديد" },
  { id: 7, name: "بالطو صوف رملي", cat: "بلاطي", price: 459, old: 549, sizes: CLOTH, img: U("photo-1539109136881-3be0616acf4b"), tag: "خصم" },
  { id: 8, name: "بالطو طويل بحزام", cat: "بلاطي", price: 429, sizes: CLOTH, img: U("photo-1544441893-675973e31985") },
  { id: 9, name: "قميص نوم ساتان", cat: "قمصان نوم", price: 159, sizes: CLOTH, img: U("photo-1520903920243-00d872a2d1c9"), tag: "جديد" },
  { id: 10, name: "قميص نوم دانتيل", cat: "قمصان نوم", price: 139, sizes: CLOTH, img: U("photo-1503342217505-b0a15ec3261c") },
  { id: 11, name: "فستان سواريه مخملي", cat: "فساتين سواريه", price: 599, sizes: CLOTH, img: U("photo-1566174053879-31528523f8ae"), tag: "جديد" },
  { id: 12, name: "فستان سواريه بذيل طويل", cat: "فساتين سواريه", price: 699, old: 799, sizes: CLOTH, img: U("photo-1595777457583-95e059d581b8"), tag: "خصم" },
  { id: 13, name: "طقم صبايا بنطال وبلوزة", cat: "أطقم صبايا", price: 219, sizes: CLOTH, img: U("photo-1503944583220-79d8926ad5e2") },
  { id: 14, name: "طقم صبايا جاكيت وتنورة", cat: "أطقم صبايا", price: 269, sizes: CLOTH, img: U("photo-1518831959646-742c3a14ebf7"), tag: "الأكثر مبيعاً" },
];
if (typeof window !== "undefined") window.PRODUCTS = LIST;
else module.exports = LIST;
