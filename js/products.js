const U = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=700&q=80`;
const CLOTH = ["S", "M", "L", "XL"];

const LIST = [
  { id: 1, name: "فستان كتان طويل", cat: "نسائي", price: 289, sizes: CLOTH, img: U("photo-1515886657613-9f3515b0c78f"), tag: "جديد" },
  { id: 2, name: "بلوزة قطن بأكمام واسعة", cat: "نسائي", price: 149, sizes: CLOTH, img: U("photo-1434389677669-e08b4cac3105") },
  { id: 3, name: "معطف صوف رملي", cat: "نسائي", price: 459, old: 549, sizes: CLOTH, img: U("photo-1539109136881-3be0616acf4b"), tag: "خصم" },
  { id: 4, name: "قميص أكسفورد أبيض", cat: "رجالي", price: 179, sizes: CLOTH, img: U("photo-1596755094514-f87e34085b2c") },
  { id: 5, name: "تيشيرت قطن أساسي", cat: "رجالي", price: 89, sizes: CLOTH, img: U("photo-1521572163474-6864f9cf17ab"), tag: "الأكثر مبيعاً" },
  { id: 6, name: "جاكيت دنيم كلاسيكي", cat: "رجالي", price: 329, old: 399, sizes: CLOTH, img: U("photo-1551028719-00167b16eac5"), tag: "خصم" },
  { id: 7, name: "بنطال جينز مستقيم", cat: "رجالي", price: 219, sizes: ["30", "32", "34", "36"], img: U("photo-1542272604-787c3835535d") },
  { id: 8, name: "هودي قطني زيتي", cat: "رجالي", price: 199, sizes: CLOTH, img: U("photo-1556905055-8f358a7a47b2"), tag: "جديد" },
  { id: 9, name: "طقم أطفال قطني", cat: "أطفال", price: 129, sizes: ["2Y", "4Y", "6Y", "8Y"], img: U("photo-1503944583220-79d8926ad5e2") },
  { id: 10, name: "فستان أطفال منقوش", cat: "أطفال", price: 119, sizes: ["2Y", "4Y", "6Y", "8Y"], img: U("photo-1518831959646-742c3a14ebf7") },
  { id: 11, name: "وشاح صوف ناعم", cat: "إكسسوارات", price: 99, sizes: ["واحد"], img: U("photo-1520903920243-00d872a2d1c9") },
  { id: 12, name: "حقيبة جلد يومية", cat: "إكسسوارات", price: 349, sizes: ["واحد"], img: U("photo-1548036328-c9fa89d128fa"), tag: "جديد" },
];
if (typeof window !== "undefined") window.PRODUCTS = LIST;
else module.exports = LIST;
