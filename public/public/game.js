/* =====================================================================
   TOG‘RIVOY MAHALLASI – public/game.js
   PART 1 of 4: Firebase sozlamalari, konstantalar, 3D sahna
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, linkWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, deleteDoc, updateDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* =====================================================================
   1) FIREBASE SOZLAMALARI
   Firebase Console > Project settings > Your apps > Web app (</>) dagi
   firebaseConfig qiymatlarini shu yerga qo‘ying (README.md, 3-bo‘lim, 7-qadam).
   Qo‘shtirnoq ichidagi matnni almashtiring, qo‘shtirnoqlarni o‘chirmang.
   ===================================================================== */
const firebaseConfig = {
  apiKey: "SIZNING_API_KEY",
  authDomain: "SIZNING_LOYIHA_ID.firebaseapp.com",
  projectId: "SIZNING_LOYIHA_ID",
  storageBucket: "SIZNING_LOYIHA_ID.firebasestorage.app",
  messagingSenderId: "SIZNING_SENDER_ID",
  appId: "SIZNING_APP_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- Konstantalar ---------- */
const N = 10;               // 10 x 10 uchastka
const CELL = 8;             // uchastkalar markazi orasidagi masofa (6 birlik uchastka + 2 birlik yo‘l)
const HOUSE_HALF = 2.3;     // uyning to‘qnashuv yarim o‘lchami
const WALK_LIMIT = 70;      // yurish mumkin bo‘lgan chegara (markazdan)
const SPEED = 13;           // avatar tezligi (birlik/sekund)
const AVATAR_RADIUS = 0.5;  // avatarning to‘qnashuv radiusi
const SEND_MIN_MS = 350;    // harakat paytida eng kam yuborish oralig‘i
const HEARTBEAT_MS = 15000; // harakat bo‘lmasa ham holatni yangilash oralig‘i
const STALE_MS = 60000;     // shu vaqtdan keyin ko‘rinmaydigan o‘yinchi
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

/* ---------- Yordamchi funksiyalar ---------- */
const $ = id => document.getElementById(id);
const setStatus = text => { $('status').textContent = text; };
const plotX = g => (g - (N - 1) / 2) * CELL;                 // uchastka indeksi -> dunyo koordinatasi
const houseId = (m, gx, gz) => `${m}_${gx}_${gz}`;
const mat = color => new THREE.MeshLambertMaterial({ color });
const makeLine = text => { const d = document.createElement('div'); d.textContent = text; return d; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- Umumiy holat ---------- */
let user = null;              // Firebase foydalanuvchisi
let isAdmin = false;          // admins/{uid} hujjati bormi
let mahallaId = null;         // tanlangan mahalla ID’si
let sel = null;               // tanlangan uchastka {gx, gz}
let roofType = 'flat';        // 'flat' yoki 'pyr'
const houses = new Map();     // houseId -> ma’lumot
const ratings = new Map();    // ratingId -> ma’lumot
const mahallas = new Map();   // mahallaId -> {name}
const remotes = new Map();    // uid -> boshqa o‘yinchi
let cityUnsubs = [];          // mahalla bo‘yicha listenerlar
let booted = false;

/* =====================================================================
   2) 3D SAHNA
   ===================================================================== */
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa8d8ff);
scene.fog = new THREE.Fog(0xa8d8ff, 160, 460);

const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 900);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3f6b3a, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(40, 90, 30);
scene.add(sun);

// Katta maysazor (dunyo chegarasi)
const grass = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), mat(0x6fb85c));
grass.rotation.x = -Math.PI / 2;
scene.add(grass);

// Yo‘llar foni
const road = new THREE.Mesh(new THREE.PlaneGeometry(N * CELL + 8, N * CELL + 8), mat(0x4a4f57));
road.rotation.x = -Math.PI / 2;
road.position.y = 0.02;
scene.add(road);

const cityGroup = new THREE.Group();   // doimiy shahar obyektlari
const houseGroup = new THREE.Group();  // foydalanuvchi uylari
const playerGroup = new THREE.Group(); // boshqa o‘yinchilar
scene.add(cityGroup, houseGroup, playerGroup);

// To‘qnashuv qutilari: {x0, x1, z0, z1}
const staticBoxes = [];   // daraxtlar, jamoat binolari (doimiy)
let houseBoxes = [];      // foydalanuvchi uylari (har safar qayta quriladi)
const addBox = (list, x0, x1, z0, z1) => list.push({ x0, x1, z0, z1 });

// Uchastkalar va gullar
for (let gx = 0; gx < N; gx++) {
  for (let gz = 0; gz < N; gz++) {
    const x = plotX(gx), z = plotX(gz);
    const lawn = new THREE.Mesh(new THREE.BoxGeometry(6, 0.06, 6), mat(0x7ec850));
    lawn.position.set(x, 0.05, z);
    cityGroup.add(lawn);
    const flowerColors = ['#ff6b9d', '#ffd93d', '#ffffff', '#c77dff'];
    [[-2.5, -2.5], [2.5, 2.5], [-2.5, 2.5], [2.5, -2.5]].forEach(([dx, dz], i) => {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 6),
        mat(flowerColors[(gx * 7 + gz * 3 + i) % 4]));
      f.position.set(x + dx, 0.25, z + dz);
      cityGroup.add(f);
    });
  }
}

// Chiroqlar (chorrahalarda)
for (let gx = 0; gx < N - 1; gx++) {
  for (let gz = 0; gz < N - 1; gz++) {
    const x = (gx + 0.5 - (N - 1) / 2) * CELL;
    const z = (gz + 0.5 - (N - 1) / 2) * CELL;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 4, 6), mat(0x333333));
    pole.position.set(x, 2, z);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff1a8 }));
    bulb.position.set(x, 4.2, z);
    cityGroup.add(pole, bulb);
  }
}

// Daraxtlar – shahar atrofida (ular ham to‘siq)
for (let i = 0; i < 90; i++) {
  const a = (i / 90) * Math.PI * 2;
  const r = 64 + ((i * 37) % 30);
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 2.5, 6), mat(0x6b4a2b));
  trunk.position.set(x, 1.25, z);
  const top = new THREE.Mesh(new THREE.ConeGeometry(2.6, 5, 7), mat(0x2f8a3c));
  top.position.set(x, 5, z);
  cityGroup.add(trunk, top);
  addBox(staticBoxes, x - 0.6, x + 0.6, z - 0.6, z + 0.6);
}

// Yorliq (etiketka) – matnli sprite
function makeLabel(text, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15,23,42,.72)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = color;
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text).slice(0, 18), 128, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
  sprite.scale.set(6, 1.5, 1);
  return sprite;
  
}/* =====================================================================
   PART 2 of 4: jamoat binolari, uy modeli, avatar, to‘qnashuv, real vaqt
   ===================================================================== */

/* ---------- Jamoat binolari (janub tomonda) ---------- */
const PUB_Z = N * CELL / 2 + 16;

function publicBuilding(type, title, x, w, d) {
  const g = new THREE.Group();
  g.position.set(x, 0, PUB_Z);

  const box = (bw, bh, bd, color, px = 0, py = bh / 2, pz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat(color));
    m.position.set(px, py, pz);
    g.add(m);
    return m;
  };

  if (type === 'masjid') {
    box(10, 5, 10, 0xf7f5ef);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(3.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(0x1f9d6b)
    );
    dome.position.y = 5;
    g.add(dome);
    box(1, 12, 1, 0xf7f5ef, 6, 6, 6);     // minora 1
    box(1, 12, 1, 0xf7f5ef, -6, 6, 6);    // minora 2
    box(2.5, 0.2, 2.5, 0xf2c94c, 6, 12.1, 6);
  } else if (type === 'maktab') {
    box(14, 6, 8, 0xf2b880);
    box(2, 5, 0.2, 0x2f7ddb, 0, 2.5, 4.1);     // kirish eshigi
    box(0.15, 4, 0.15, 0x333333, 6, 8, 0);     // bayroq ustuni
    box(1.2, 0.8, 0.1, 0xe63946, 6.5, 9, 0);   // bayroq
  } else if (type === 'dokon') {
    box(12, 4, 8, 0xd9d9d9);
    box(12.6, 0.6, 2, 0xe63946, 0, 3.6, 5);    // tent (soyabon)
    box(5, 2.6, 0.2, 0x8ecae6, 0, 1.3, 4.1);   // vitrina
  } else if (type === 'bogcha') {
    box(10, 4.5, 8, 0xffc8dd);
    box(10.2, 0.8, 8.2, 0xffd6a5, 0, 4.9, 0);  // tom
    box(3, 2, 0.2, 0xbde0fe, 0, 1, 4.1);       // deraza
  } else if (type === 'shifoxona') {
    box(12, 7, 9, 0xffffff);
    box(3, 0.6, 0.3, 0xe63946, 0, 7.3, 4.6);   // qizil xoch
    box(0.6, 2.4, 0.3, 0xe63946, 0, 7.3, 4.6);
  } else if (type === 'bog') {
    const pond = new THREE.Mesh(new THREE.CircleGeometry(4, 20), mat(0x3ba3e0));
    pond.rotation.x = -Math.PI / 2;
    pond.position.y = 0.1;
    g.add(pond);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tree = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4, 7), mat(0x2f8a3c));
      tree.position.set(Math.cos(a) * 7, 2.2, Math.sin(a) * 7);
      g.add(tree);
    }
  } else if (type === 'sport') {
    const field = new THREE.Mesh(new THREE.BoxGeometry(14, 0.1, 9), mat(0x3aa84c));
    field.position.y = 0.06;
    const middle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 9), mat(0xffffff));
    middle.position.y = 0.12;
    g.add(field, middle);
  }

  const lb = makeLabel(title, '#fde68a');
  lb.position.set(0, type === 'masjid' ? 14 : 9, 0);
  g.add(lb);
  cityGroup.add(g);

  // Faqat binolarning o‘zi to‘siq bo‘ladi (bog‘ va maydon yurish mumkin)
  if (w && d) addBox(staticBoxes, x - w / 2, x + w / 2, PUB_Z - d / 2, PUB_Z + d / 2);
}

[
  ['masjid', 'Jome masjidi', -44, 10, 10],
  ['maktab', 'Maktab', -30, 14, 8],
  ['dokon', 'Do‘konlar', -17, 12, 8],
  ['bogcha', 'Bog‘cha', -4, 10, 8],
  ['shifoxona', 'Shifoxona', 9, 12, 9],
  ['bog', 'Istirohat bog‘i', 25, 0, 0],
  ['sport', 'Sport maydoni', 42, 0, 0]
].forEach(args => publicBuilding(...args));

/* ---------- Foydalanuvchi uylari ---------- */
function makeHouse(h, id) {
  const g = new THREE.Group();
  g.position.set(plotX(h.gx), 0, plotX(h.gz));
  g.userData.id = id;

  const H = h.floors * 3;
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, H, 4.6), mat(h.color));
  body.position.y = H / 2;
  g.add(body);

  // Derazalar: har qavatda old va orqa tomonda 2 tadan
  for (let f = 0; f < h.floors; f++) {
    for (const side of [1, -1]) {
      for (const k of [-1.2, 1.2]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.12), mat(h.win));
        w.position.set(k, f * 3 + 1.8, side * 2.33);
        g.add(w);
      }
    }
  }

  const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1.9, 0.14), mat(h.door));
  door.position.set(0, 0.95, 2.34);
  g.add(door);

  if (h.roofType === 'pyr') {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.4, 4), mat(h.roof));
    roof.rotation.y = Math.PI / 4;
    roof.position.y = H + 1.2;
    g.add(roof);
  } else {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 5), mat(h.roof));
    roof.position.y = H + 0.25;
    g.add(roof);
  }

  if (h.name) {
    const lb = makeLabel(h.name);
    lb.position.y = H + 3.4;
    g.add(lb);
  }
  return g;
}

function rebuildHouses() {
  houseGroup.clear();
  houseBoxes = [];
  houses.forEach((h, id) => {
    houseGroup.add(makeHouse(h, id));
    const x = plotX(h.gx), z = plotX(h.gz);
    addBox(houseBoxes, x - HOUSE_HALF, x + HOUSE_HALF, z - HOUSE_HALF, z + HOUSE_HALF);
  });
}

/* ---------- Tanlangan uchastka markeri ---------- */
const marker = new THREE.Mesh(
  new THREE.RingGeometry(3.4, 3.9, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd93d, side: THREE.DoubleSide })
);
marker.rotation.x = -Math.PI / 2;
marker.visible = false;
scene.add(marker);

/* ---------- Kamera va avatar holati ---------- */
let yaw = 0.6, pitch = 0.9, dist = 90;      // kamera burchagi va masofasi
const avatarPos = new THREE.Vector3(0, 0, 0); // o‘yinchi joyi (yo‘llar kesishmasi – bo‘sh joy)
let avatarRy = 0;                             // o‘yinchi qaragan yo‘nalish
let stepT = 0;                                // qadam animatsiyasi vaqti
const dirs = { fwd: false, back: false, left: false, right: false };

// To‘qnashuv tekshiruvi: avatar (radius) doiraviy qutilardan o‘ta olmaydi
function blocked(x, z) {
  if (Math.abs(x) > WALK_LIMIT || Math.abs(z) > WALK_LIMIT) return true;
  const hits = list => list.some(b =>
    x + AVATAR_RADIUS > b.x0 && x - AVATAR_RADIUS < b.x1 &&
    z + AVATAR_RADIUS > b.z0 && z - AVATAR_RADIUS < b.z1
  );
  return hits(staticBoxes) || hits(houseBoxes);
}

// Harakat: har o‘qni alohida tekshiramiz, shunda devor bo‘ylab sirpanib yurish mumkin
function moveAvatar(dt) {
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const mv = new THREE.Vector3();
  if (dirs.fwd) mv.add(fwd);
  if (dirs.back) mv.sub(fwd);
  if (dirs.left) mv.sub(right);
  if (dirs.right) mv.add(right);
  if (mv.lengthSq() === 0) return false;

  mv.normalize().multiplyScalar(SPEED * dt);
  if (!blocked(avatarPos.x + mv.x, avatarPos.z)) avatarPos.x += mv.x;
  if (!blocked(avatarPos.x, avatarPos.z + mv.z)) avatarPos.z += mv.z;
  avatarRy = Math.atan2(mv.x, mv.z);
  return true;
}

/* ---------- Avatar modeli ---------- */
function makeAvatarMesh(color, name) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 2, 8), mat(color));
  body.position.y = 1.6;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 10), mat(0xf1c27d));
  head.position.y = 3;
  const lb = makeLabel(name, '#ffffff');
  lb.scale.set(4, 1, 1);
  lb.position.y = 4.2;
  g.add(body, head, lb);
  return g;
}

const myAvatar = makeAvatarMesh('#2563eb', 'Siz');
scene.add(myAvatar);

// Har bir foydalanuvchi uchun doimiy rang (uid bo‘yicha)
function colorFromUid(uid) {
  let h = 0;
  for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function myName() {
  if (user && user.displayName) return user.displayName.slice(0, 30);
  return 'Mehmon-' + (user ? user.uid : '').slice(0, 4);
}

/* ---------- Boshqa o‘yinchilar (real vaqt) ---------- */
function upsertPlayer(uid, d) {
  if (user && uid === user.uid) return;
  const ts = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : Date.now();
  let p = remotes.get(uid);
  if (!p) {
    const g = makeAvatarMesh(d.color || '#3b82f6', String(d.name || 'Mehmon').slice(0, 30));
    g.position.set(d.x, 0, d.z);
    playerGroup.add(g);
    p = { g, tx: d.x, tz: d.z, ry: d.ry || 0, updated: ts };
    remotes.set(uid, p);
  }
  p.tx = d.x;
  p.tz = d.z;
  p.ry = d.ry || 0;
  p.updated = ts;
}

function removePlayer(uid) {
  const p = remotes.get(uid);
  if (p) {
    playerGroup.remove(p.g);
    remotes.delete(uid);
  }
}

function clearPlayers() {
  [...remotes.keys()].forEach(removePlayer);
}

// O‘z holatini Firestore’ga yuborish (harakat bo‘lganda va har 15 soniyada)
let lastSendTime = 0;
let lastSent = null;
function sendPresence(now) {
  if (!user || !mahallaId) return;
  const x = +avatarPos.x.toFixed(2);
  const z = +avatarPos.z.toFixed(2);
  const ry = +avatarRy.toFixed(2);
  const changed = !lastSent || lastSent.m !== mahallaId ||
    Math.abs(lastSent.x - x) > 0.15 || Math.abs(lastSent.z - z) > 0.15;
  const elapsed = now - lastSendTime;
  if (!((changed && elapsed > SEND_MIN_MS) || elapsed > HEARTBEAT_MS)) return;

  lastSendTime = now;
  lastSent = { x, z, m: mahallaId };
  setDoc(doc(db, 'players', user.uid), {
    mahalla: mahallaId,
    x, z, ry,
    name: myName(),
    color: colorFromUid(user.uid),
    updatedAt: serverTimestamp()
  }).catch(() => { /* tarmoq uzilsa keyingi yuborishda qayta uriniladi */ });
}
/* =====================================================================
   PART 3 of 4: kamera, boshqaruv (sichqoncha, sensor, klaviatura, tugmalar),
   uy formasi, uchastka tanlash, ma’lumot paneli
   ===================================================================== */

/* ---------- Kamera: sudrash va chimdash ---------- */
const canvas = $('scene');
const pointers = new Map();   // pointerId -> {x, y}
let dragMoved = 0;            // harakat masofasi (bosish yoki sudrashni ajratish uchun)
let pinchDist = 0;

canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) dragMoved = 0;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});

canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;

  // Ikki barmoq: yaqinlashtirish / uzoqlashtirish
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0 && d > 0) dist = clamp(dist * (pinchDist / d), 14, 160);
    pinchDist = d;
    return;
  }

  // Bir barmoq / sichqoncha: aylantirish
  dragMoved += Math.abs(dx) + Math.abs(dy);
  yaw -= dx * 0.008;
  pitch = clamp(pitch + dy * 0.006, 0.2, 1.45);
});

canvas.addEventListener('pointerup', e => {
  const wasTap = pointers.size === 1 && dragMoved < 6;
  pointers.delete(e.pointerId);
  if (wasTap) pick(e.clientX, e.clientY);
});
canvas.addEventListener('pointercancel', e => pointers.delete(e.pointerId));

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  dist = clamp(dist * (1 + e.deltaY * 0.001), 14, 160);
}, { passive: false });

document.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- Bosish: uy yoki uchastkani tanlash ---------- */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function pick(clientX, clientY) {
  ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, cam);

  // Avval uy ustiga bosilganmi, tekshiramiz
  const hits = ray.intersectObjects(houseGroup.children, true);
  if (hits.length) {
    let o = hits[0].object;
    while (o && !o.userData.id) o = o.parent;
    if (o) {
      const h = houses.get(o.userData.id);
      if (h) return selectPlot(h.gx, h.gz);
    }
  }

  // Aks holda yer (maysazor) ustiga bosilganmi, tekshiramiz
  const p = new THREE.Vector3();
  if (!ray.ray.intersectPlane(groundPlane, p)) return;
  const gx = Math.round(p.x / CELL + (N - 1) / 2);
  const gz = Math.round(p.z / CELL + (N - 1) / 2);
  if (gx >= 0 && gz >= 0 && gx < N && gz < N) selectPlot(gx, gz);
}

/* ---------- Klaviatura ---------- */
const KEYMAP = {
  ArrowUp: 'fwd', w: 'fwd', W: 'fwd',
  ArrowDown: 'back', s: 'back', S: 'back',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right'
};

addEventListener('keydown', e => {
  // Forma maydonlarida yozayotganda avatar harakatlanmasin
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const dir = KEYMAP[e.key];
  if (dir) {
    dirs[dir] = true;
    e.preventDefault();
  }
});

addEventListener('keyup', e => {
  const dir = KEYMAP[e.key];
  if (dir) dirs[dir] = false;
});

// Oyna fokusni yo‘qotsa, tugmalar “yopishib qolmasin”
addEventListener('blur', () => {
  Object.keys(dirs).forEach(k => { dirs[k] = false; });
});

/* ---------- Ekrandagi tugmalar (telefon uchun) ---------- */
const PAD_MAP = { up: 'fwd', down: 'back', left: 'left', right: 'right' };
document.querySelectorAll('#pad button').forEach(btn => {
  const dir = PAD_MAP[btn.dataset.k];
  const press = on => e => {
    e.preventDefault();
    dirs[dir] = on;
    btn.classList.toggle('on', on);
  };
  btn.addEventListener('pointerdown', press(true));
  btn.addEventListener('pointerup', press(false));
  btn.addEventListener('pointercancel', press(false));
  btn.addEventListener('pointerleave', press(false));
});

/* ---------- Panel ochish/yopish ---------- */
$('toggle').onclick = () => $('panel').classList.toggle('closed');
if (innerWidth > 700) $('panel').classList.remove('closed');

/* ---------- Uy formasi ---------- */
const FORM_FIELDS = ['floors', 'cBody', 'cRoof', 'cWin', 'cDoor', 'hName', 'hInsta'];

function resetForm() {
  $('floors').value = 2;
  $('flv').textContent = 2;
  $('cBody').value = '#f5deb3';
  $('cRoof').value = '#b45309';
  $('cWin').value = '#7dd3fc';
  $('cDoor').value = '#7c2d12';
  $('hName').value = '';
  $('hInsta').value = '';
  roofType = 'flat';
  updateChips();
}

function fillForm(h) {
  $('floors').value = h.floors;
  $('flv').textContent = h.floors;
  $('cBody').value = h.color;
  $('cRoof').value = h.roof;
  $('cWin').value = h.win;
  $('cDoor').value = h.door;
  $('hName').value = h.name || '';
  $('hInsta').value = h.insta || '';
  roofType = h.roofType === 'pyr' ? 'pyr' : 'flat';
  updateChips();
}

function updateChips() {
  document.querySelectorAll('#roofChips .chip').forEach(chip => {
    chip.classList.toggle('on', chip.dataset.v === roofType);
  });
}

// editable: forma tahrirlanadi; canDelete: “O‘chirish” tugmasi faol
function setFormEnabled(editable, canDelete) {
  FORM_FIELDS.forEach(id => { $(id).disabled = !editable; });
  $('save').disabled = !editable;
  $('del').disabled = !canDelete;
  $('roofChips').style.opacity = editable ? '1' : '.5';
}

document.querySelectorAll('#roofChips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if ($('save').disabled) return;
    roofType = chip.dataset.v;
    updateChips();
  });
});

$('floors').oninput = e => { $('flv').textContent = e.target.value; };

/* ---------- Uchastka tanlash ---------- */
function selectPlot(gx, gz) {
  sel = { gx, gz };
  marker.position.set(plotX(gx), 0.12, plotX(gz));
  marker.visible = true;

  const h = houses.get(houseId(mahallaId, gx, gz));
  const mine = !!(user && h && h.ownerId === user.uid);

  if (mine) fillForm(h);
  else if (!h) resetForm();
  else resetForm(); // boshqa birovning uyi: forma bo‘sh, lekin ma’lumot pastda ko‘rinadi

  const canEdit = !!user && !!mahallaId && (!h || mine);
  setFormEnabled(canEdit, mine);
  renderInfo();
  renderRating();
  if (innerWidth <= 700) $('panel').classList.remove('closed');
}

/* ---------- Ma’lumot paneli ---------- */
function renderInfo() {
  const box = $('info');
  box.innerHTML = '';
  if (!sel) {
    box.textContent = 'Uyni bosing yoki bo‘sh uchastkani tanlang.';
    return;
  }
  const h = houses.get(houseId(mahallaId, sel.gx, sel.gz));
  if (!h) {
    box.append(makeLine(`Uchastka ${sel.gx + 1}-${sel.gz + 1} – bo‘sh`));
    box.append(makeLine(user ? 'Pastdagi formani to‘ldirib uy qurishingiz mumkin.' : 'Yuklanmoqda…'));
    return;
  }

  const title = makeLine(`🏠 ${h.name || 'Nomsiz uy'} · ${h.floors} qavat`);
  title.style.fontWeight = '700';
  box.append(title);
  box.append(makeLine(user && h.ownerId === user.uid ? 'Bu sizning uyingiz' : 'Uy egasi: mehmon'));

  // Instagram: faqat xavfsiz belgilar, havola yangi oynada ochiladi
  const handle = (h.insta || '').replace(/[^A-Za-z0-9._]/g, '');
  if (handle) {
    const a = document.createElement('a');
    a.href = `https://www.instagram.com/${encodeURIComponent(handle)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `📸 @${handle}`;
    a.style.color = '#db2777';
    box.append(a);
  }
}

/* ---------- Reyting ---------- */
function renderRating() {
  const box = $('ratingBox');
  box.innerHTML = '';
  if (!sel) return;

  const id = houseId(mahallaId, sel.gx, sel.gz);
  const h = houses.get(id);
  if (!h) return;

  let sum = 0, count = 0, mine = 0;
  ratings.forEach(r => {
    if (r.houseId === id) {
      sum += r.value;
      count++;
      if (user && r.raterId === user.uid) mine = r.value;
    }
  });

  const avg = count ? (sum / count).toFixed(1) : '—';
  const title = makeLine(`⭐ Reyting: ${avg} (${count} ta baho)`);
  title.style.fontWeight = '600';
  box.append(title);

  if (!user) return;
  if (h.ownerId === user.uid) {
    box.append(makeLine('O‘z uyingizga baho berib bo‘lmaydi.'));
    return;
  }

  const row = document.createElement('div');
  row.className = 'stars';
  for (let v = 1; v <= 5; v++) {
    const b = document.createElement('button');
    b.className = 'star' + (v <= mine ? ' on' : '');
    b.textContent = '★';
    b.setAttribute('aria-label', `${v} yulduz`);
    b.onclick = () => rate(id, v);
    row.append(b);
  }
  box.append(row);
}
/* =====================================================================
   PART 4 of 4: baza amallari, mahalla va real vaqt listenerlari,
   kirish (anonim + Google), admin, asosiy sikl
   ===================================================================== */

/* ---------- Uyni saqlash (qurish yoki tahrirlash) ---------- */
async function saveHouse() {
  if (!sel) return setStatus('Avval uchastka tanlang.');
  if (!user) return setStatus('Yuklanmoqda… birozdan keyin urinib ko‘ring.');
  if (!mahallaId) return setStatus('Mahalla tanlanmagan.');

  const id = houseId(mahallaId, sel.gx, sel.gz);
  const old = houses.get(id);
  if (old && old.ownerId !== user.uid) return setStatus('Bu uy boshqa odamniki.');

  const data = {
    ownerId: user.uid,
    mahalla: mahallaId,
    gx: sel.gx,
    gz: sel.gz,
    floors: parseInt($('floors').value, 10),
    color: $('cBody').value,
    roof: $('cRoof').value,
    win: $('cWin').value,
    door: $('cDoor').value,
    roofType,
    name: $('hName').value.trim().slice(0, 40),
    insta: $('hInsta').value.trim().slice(0, 40),
    createdAt: old && old.createdAt ? old.createdAt : serverTimestamp()
  };

  try {
    await setDoc(doc(db, 'houses', id), data);
    setStatus('Uy saqlandi ✔ Hamma uchun ko‘rinadi.');
  } catch (e) {
    setStatus('Saqlanmadi: ' + e.message);
  }
}

/* ---------- Uyni o‘chirish (faqat egasi) ---------- */
async function deleteHouse() {
  if (!sel || !user) return;
  const id = houseId(mahallaId, sel.gx, sel.gz);
  const h = houses.get(id);
  if (!h || h.ownerId !== user.uid) return setStatus('Faqat uy egasi o‘chira oladi.');
  if (!confirm('Uyni o‘chirishni tasdiqlaysizmi?')) return;

  try {
    await deleteDoc(doc(db, 'houses', id));
    setStatus('Uy o‘chirildi.');
  } catch (e) {
    setStatus('O‘chirilmadi: ' + e.message);
  }
}

/* ---------- Baho berish ---------- */
async function rate(id, value) {
  if (!user) return setStatus('Yuklanmoqda…');
  const h = houses.get(id);
  if (!h || h.ownerId === user.uid) return;

  try {
    await setDoc(doc(db, 'ratings', `${id}__${user.uid}`), {
      houseId: id,
      mahalla: mahallaId,
      value,
      raterId: user.uid
    });
    setStatus(`Baho berildi: ${value} ★`);
  } catch (e) {
    setStatus('Baho berilmadi: ' + e.message);
  }
}

/* ---------- Mahalla bo‘yicha real vaqt listenerlari ---------- */
function startCityListeners() {
  cityUnsubs.forEach(unsub => unsub());
  cityUnsubs = [];
  houses.clear();
  ratings.clear();
  clearPlayers();
  rebuildHouses();
  renderInfo();
  renderRating();

  if (!mahallaId) return;
  const m = mahallaId;

  // Uylar (hamma uchun umumiy)
  cityUnsubs.push(onSnapshot(
    query(collection(db, 'houses'), where('mahalla', '==', m)),
    snap => {
      houses.clear();
      snap.forEach(d => houses.set(d.id, d.data()));
      rebuildHouses();
      renderInfo();
      renderRating();
    },
    err => setStatus('Uylarni o‘qishda xatolik: ' + err.message)
  ));

  // Baholar
  cityUnsubs.push(onSnapshot(
    query(collection(db, 'ratings'), where('mahalla', '==', m)),
    snap => {
      ratings.clear();
      snap.forEach(d => ratings.set(d.id, d.data()));
      renderRating();
    },
    err => console.warn('Baholarni o‘qishda xatolik:', err.message)
  ));

  // Jonli o‘yinchilar
  cityUnsubs.push(onSnapshot(
    query(collection(db, 'players'), where('mahalla', '==', m)),
    snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') removePlayer(ch.doc.id);
        else upsertPlayer(ch.doc.id, ch.doc.data());
      });
    },
    err => console.warn('O‘yinchilarni o‘qishda xatolik:', err.message)
  ));
}

/* ---------- Mahalla ro‘yxati ---------- */
function fillMahallas() {
  const select = $('mah');
  const previous = mahallaId;
  select.innerHTML = '';

  if (!mahallas.size) {
    select.add(new Option('Mahalla yo‘q', ''));
    mahallaId = null;
  } else {
    mahallas.forEach((m, id) => select.add(new Option(m.name, id)));
    if (!mahallaId || !mahallas.has(mahallaId)) {
      mahallaId = mahallas.keys().next().value;
    }
    select.value = mahallaId;
  }

  if (previous !== mahallaId) {
    sel = null;
    marker.visible = false;
    setFormEnabled(false, false);
    startCityListeners();
  }
}

function startMahallaListener() {
  onSnapshot(collection(db, 'mahallas'), snap => {
    mahallas.clear();
    snap.forEach(d => mahallas.set(d.id, d.data()));
    $('loader').classList.add('hide');
    fillMahallas();
  }, err => {
    $('loader').classList.add('hide');
    setStatus('Mahallalarni o‘qishda xatolik: ' + err.message);
  });
}

$('mah').onchange = e => {
  mahallaId = e.target.value || null;
  sel = null;
  marker.visible = false;
  setFormEnabled(false, false);
  startCityListeners();
};

$('save').onclick = saveHouse;
$('del').onclick = deleteHouse;

/* ---------- Admin tekshiruvi ---------- */
async function checkAdmin(uid) {
  try {
    const snap = await getDoc(doc(db, 'admins', uid));
    return snap.exists();
  } catch (e) {
    return false;
  }
}

/* ---------- Kirish tugmasi holati ---------- */
function updateAuthButton() {
  if (!user) {
    $('authBtn').textContent = '…';
    return;
  }
  if (user.isAnonymous) {
    $('authBtn').textContent = '👤 Kirish';
    $('authBtn').title = 'Google bilan kiring, uylaringiz boshqa qurilmada ham saqlansin';
  } else {
    $('authBtn').textContent = '✅ Kirgan';
    $('authBtn').title = 'Google hisobi ulangan';
  }
}

/* ---------- Google bilan kirish (anonim hisobni ulash) ---------- */
$('authBtn').onclick = async () => {
  if (!user) return setStatus('Yuklanmoqda…');
  if (!user.isAnonymous) return setStatus('Siz Google hisobi bilan kirgansiz ✔');

  const provider = new GoogleAuthProvider();
  try {
    // Anonim hisobni Google’ga ulaymiz: UID o‘zgarmaydi, uylar saqlanib qoladi
    await linkWithPopup(user, provider);
    user = auth.currentUser;
    updateAuthButton();
    setStatus('Google hisobingiz ulandi ✔ Uylaringiz endi saqlanib qoladi.');
  } catch (e) {
    if (e.code === 'auth/credential-already-in-use' || e.code === 'auth/email-already-in-use') {
      // Bu Google hisobi oldin boshqa joyda ishlatilgan: unga kiramiz
      try {
        await signInWithPopup(auth, provider);
        setStatus('Mavjud Google hisobiga kirdingiz. Bu qurilmadagi mehmon uylari boshqa hisobda qoladi.');
      } catch (e2) {
        if (e2.code !== 'auth/popup-closed-by-user') setStatus('Kirish bekor qilindi: ' + e2.message);
      }
    } else if (e.code !== 'auth/popup-closed-by-user') {
      setStatus('Kirish xatoligi: ' + e.message);
    }
  }
};

/* ---------- Admin: mahalla yaratish va nomini o‘zgartirish ---------- */
$('addMah').onclick = async () => {
  if (!isAdmin) return;
  const name = $('newMah').value.trim().slice(0, 40);
  if (!name) return setStatus('Mahalla nomini kiriting.');
  try {
    await setDoc(doc(collection(db, 'mahallas')), { name, createdBy: user.uid });
    $('newMah').value = '';
    setStatus(`“${name}” mahallasi yaratildi ✔`);
  } catch (e) {
    setStatus('Yaratilmadi: ' + e.message);
  }
};

$('renMah').onclick = async () => {
  if (!isAdmin || !mahallaId) return;
  const current = mahallas.get(mahallaId);
  const name = prompt('Yangi mahalla nomi:', current ? current.name : '');
  if (!name || !name.trim()) return;
  try {
    await updateDoc(doc(db, 'mahallas', mahallaId), { name: name.trim().slice(0, 40) });
    setStatus('Mahalla nomi o‘zgartirildi ✔');
  } catch (e) {
    setStatus('O‘zgartirilmadi: ' + e.message);
  }
};

/* ---------- Kirish holati (anonim avtomatik) ---------- */
onAuthStateChanged(auth, async u => {
  if (!u) {
    try {
      await signInAnonymously(auth);
    } catch (e) {
      setStatus('Kirish xatoligi: ' + e.message + ' (Anonymous kirish yoqilganini tekshiring)');
    }
    return;
  }

  user = u;
  isAdmin = await checkAdmin(u.uid);
  document.body.classList.toggle('admin', isAdmin);
  updateAuthButton();

  if (sel) selectPlot(sel.gx, sel.gz);
  renderInfo();
  renderRating();

  if (!booted) {
    booted = true;
    setStatus('Xush kelibsiz! Uchastka tanlang va uy quring.');
  }
});

// Brauzer yopilganda o‘yinchi belgisini tozalash (ishonchli bo‘lmasligi mumkin;
// shuning uchun 60 soniyadan keyin eskirgan o‘yinchilar baribir yo‘qoladi)
addEventListener('pagehide', () => {
  if (user && mahallaId) deleteDoc(doc(db, 'players', user.uid)).catch(() => {});
});

/* ---------- O‘lchamni moslash ---------- */
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  cam.aspect = innerWidth / innerHeight;
  cam.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ---------- Asosiy sikl ---------- */
let lastTime = performance.now();
let lastStaleCheck = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  // O‘z avatarimiz
  const moving = moveAvatar(dt);
  if (moving) stepT += dt * 9;
  myAvatar.position.set(avatarPos.x, moving ? Math.abs(Math.sin(stepT)) * 0.12 : 0, avatarPos.z);
  let dr = avatarRy - myAvatar.rotation.y;
  dr = Math.atan2(Math.sin(dr), Math.cos(dr));
  myAvatar.rotation.y += dr * Math.min(1, dt * 12);

  // Kamera avatar orqasida, sudrash bilan aylanadi
  const off = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch)
  ).multiplyScalar(dist);
  cam.position.set(avatarPos.x + off.x, 3 + off.y, avatarPos.z + off.z);
  cam.lookAt(avatarPos.x, 3, avatarPos.z);

  // Boshqa o‘yinchilar silliq harakatlanadi
  const k = Math.min(1, dt * 8);
  remotes.forEach(p => {
    p.g.position.x += (p.tx - p.g.position.x) * k;
    p.g.position.z += (p.tz - p.g.position.z) * k;
    let drr = p.ry - p.g.rotation.y;
    drr = Math.atan2(Math.sin(drr), Math.cos(drr));
    p.g.rotation.y += drr * k;
  });

  // 5 soniyada bir marta eskirgan o‘yinchilarni olib tashlash
  if (now - lastStaleCheck > 5000) {
    lastStaleCheck = now;
    const t = Date.now();
    [...remotes.entries()].forEach(([uid, p]) => {
      if (t - p.updated > STALE_MS) removePlayer(uid);
    });
  }

  sendPresence(now);
  renderer.render(scene, cam);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Yuklash ekrani xavfsizlik uchun 6 soniyadan keyin baribir yopiladi
setTimeout(() => $('loader').classList.add('hide'), 6000);

// Mahallalarni o‘qishni boshlaymiz (qoidalar hamma uchun o‘qishga ruxsat beradi)
startMahallaListener();

