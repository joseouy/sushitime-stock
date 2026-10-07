const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "stadmin00";

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL no está configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype));
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 12 },
  })
);

function auth(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ error: "No autenticado" });
}

function nextPurchaseDay(date = new Date()) {
  const day = date.getDay(); // Sun 0, Mon 1, Tue 2, Wed 3, Thu 4...
  if (day <= 2) return "martes";
  if (day <= 4) return "jueves";
  return "martes";
}

function daysToPurchase(date = new Date()) {
  const day = date.getDay();
  if (day === 0) return 2;
  if (day === 1) return 1;
  if (day === 2) return 2;
  if (day === 3) return 1;
  if (day === 4) return 5; // Thu -> next Tue
  if (day === 5) return 4;
  return 3;
}

function roundUp(qty, pack) {
  const n = Number(qty) || 0;
  const p = Number(pack) || 1;
  if (n <= 0) return 0;
  return Math.ceil(n / p) * p;
}

function recommendation(p) {
  const stock = Number(p.quantity || 0);
  const weekly = Number(p.weekly_consumption || 0);
  const safety = Number(p.safety_stock || 0);
  const pack = Number(p.conversion || 1);
  if (p.control_type === "manual" || weekly <= 0) {
    return { status: "review", recommended: 0, need: 0, projected: stock, reason: "Configuración insuficiente" };
  }

  const days = daysToPurchase();
  const need = weekly * (days / 7);
  const target = Math.max(need, safety);
  const raw = Math.max(0, target - stock);
  const recommended = roundUp(raw, pack);
  const projected = stock + recommended - need;

  let status = "ok";
  if (recommended > 0) status = "buy";
  else if (projected < safety) status = "review";

  let reason = `Necesidad estimada: ${need.toFixed(2)} ${p.unit}. Stock actual: ${stock.toFixed(2)}.`;
  if (recommended > 0) reason += ` Se redondea a ${recommended} ${p.purchase_unit || p.unit}.`;
  if (recommended === 0 && projected < safety) reason += " Queda por debajo del stock de seguridad: revisar.";

  return { status, recommended, need, projected, reason };
}

async function q(text, params = []) {
  return pool.query(text, params);
}

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unidad',
      purchase_unit TEXT NOT NULL DEFAULT 'unidad',
      conversion NUMERIC NOT NULL DEFAULT 1 CHECK (conversion > 0),
      control_type TEXT NOT NULL DEFAULT 'automatic' CHECK (control_type IN ('automatic','minimum','manual')),
      safety_stock NUMERIC NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
      weekly_consumption NUMERIC NOT NULL DEFAULT 0 CHECK (weekly_consumption >= 0),
      purchase_frequency TEXT NOT NULL DEFAULT 'martes_jueves',
      supplier TEXT,
      last_price NUMERIC NOT NULL DEFAULT 0 CHECK (last_price >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      previous_quantity NUMERIC,
      quantity NUMERIC NOT NULL DEFAULT 0,
      new_quantity NUMERIC,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'recommended',
      purchase_day TEXT,
      recommended JSONB NOT NULL DEFAULT '[]'::jsonb,
      chosen JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      supplier TEXT,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      total NUMERIC NOT NULL DEFAULT 0,
      receipt_image BYTEA,
      receipt_mime TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      quantity NUMERIC NOT NULL CHECK (quantity >= 0),
      unit_price NUMERIC NOT NULL DEFAULT 0 CHECK (unit_price >= 0)
    );
  `);

  const seedProducts = [
    ["Arroz","Insumos varios","kg","funda",25,"automatic",30,54],
    ["Azúcar","Insumos varios","kg","kg",1,"automatic",10,29],
    ["Vinagre","Insumos varios","L","L",1,"automatic",5,20],
    ["Algas Nori","Insumos varios","paquete","paquete",1,"manual",0,0],
    ["Salsa de soja","Insumos varios","kg","bidón",10,"automatic",10,0],
    ["Wasabi","Insumos varios","kg","kg",1,"manual",1,0],
    ["Jengibre","Insumos varios","kg","kg",1,"manual",0.5,0],
    ["Panko","Insumos varios","kg","kg",1,"automatic",5,0],
    ["Pan rallado","Insumos varios","bolsa","bolsa",1,"manual",0,0],
    ["Harina","Insumos varios","kg","kg",1,"manual",0,0],
    ["Sésamo","Insumos varios","kg","kg",1,"manual",0.5,0],
    ["Castañas de cajú","Insumos varios","kg","kg",1,"manual",0.25,0],
    ["Tabasco","Insumos varios","unidad","unidad",1,"manual",1,0],
    ["Mayonesa","Insumos varios","kg","kg",1,"manual",0,0],
    ["Barbacoa","Insumos varios","kg","bolsa",6.5,"manual",1,0],
    ["Sal","Insumos varios","kg","kg",1,"manual",0,0],
    ["Aceite girasol","Insumos varios","L","L",1,"manual",0,0],
    ["Aceite fritador","Insumos varios","L","bidón",5,"manual",5,0],
    ["Tomates secos","Insumos varios","unidad","paquete",1,"manual",0,0],
    ["Queso crema","Insumos varios","kg","unidad",2,"manual",4,0],
    ["Cheddar","Insumos varios","paquete","paquete",1,"manual",0,0],
    ["Arrolladitos","Insumos varios","kg","paquete",1,"manual",0,0],
    ["Miel","Insumos varios","kg","frasco",1,"manual",0.5,0],
    ["Papel film","Insumos varios","m","rollo",1000,"manual",0,0],
    ["Separadores","Insumos varios","paquete","paquete",1,"manual",0,0],
    ["Palitos brochette","Insumos varios","paquete","paquete",1,"manual",0,0],
    ["Papel higiénico","Limpieza","rollo","rollo",1,"manual",4,0],
    ["Papel absorbente","Limpieza","rollo","rollo",1,"manual",2,0],
    ["Detergente","Limpieza","L","bidón",10,"manual",2,0],
    ["Hipoclorito","Limpieza","L","bidón",10,"manual",2,0],
    ["Limpiador piso","Limpieza","L","bidón",10,"manual",2,0],
    ["Limpiador vidrio","Limpieza","L","L",1,"manual",1,0],
    ["Esponjas","Limpieza","unidad","unidad",1,"manual",3,0],
    ["Esponjas aluminio","Limpieza","unidad","unidad",1,"manual",2,0],
    ["Bolsas residuos","Limpieza","paquete","paquete",1,"manual",1,0],
    ["Desengrasante","Limpieza","ml","botella",450,"manual",450,0],
    ["Repasadores","Limpieza","unidad","unidad",1,"manual",3,0],
    ["Trapos piso","Limpieza","unidad","unidad",1,"manual",1,0],
    ["Palta","Frutas y verduras","caja","caja",1,"manual",1,0],
    ["Rúcula","Frutas y verduras","paquete","paquete",1,"manual",5,0],
    ["Ciboulette","Frutas y verduras","paquete","paquete",1,"manual",4,0],
    ["Cilantro","Frutas y verduras","paquete","paquete",1,"manual",2,0],
    ["Cebolla","Frutas y verduras","kg","kg",1,"manual",1,0],
    ["Pepino","Frutas y verduras","kg","kg",1,"manual",1,0],
    ["Lima","Frutas y verduras","kg","kg",1,"manual",1,0],
    ["Mango","Frutas y verduras","unidad","unidad",1,"manual",5,0],
    ["Maracuyá","Frutas y verduras","kg","kg",1,"manual",0.5,0],
    ["Huevos","Frutas y verduras","maple","maple",1,"manual",2,0],
    ["Salmón fresco","Pescados y mariscos","kg","caja",1,"manual",5,0],
    ["Salmón ahumado","Pescados y mariscos","bolsa","bolsa",1,"manual",2,0],
    ["Pescado blanco","Pescados y mariscos","filete","filete",1,"manual",2,0],
    ["Camarón cocido nigiri","Pescados y mariscos","caja","caja",1,"manual",1,0],
    ["Atún rojo","Pescados y mariscos","kg","kg",1,"manual",2,0],
    ["Camarón","Pescados y mariscos","kg","kg",1,"manual",2,0],
    ["Rabas","Pescados y mariscos","kg","kg",1,"manual",1.5,0],
  ];

  for (const p of seedProducts) {
    await q(
      `INSERT INTO products
       (name,category,unit,purchase_unit,conversion,control_type,safety_stock,weekly_consumption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO NOTHING`,
      p
    );
  }

  const initialStock = {
    "Arroz":30,"Azúcar":21,"Vinagre":7,"Algas Nori":3,"Salsa de soja":20,
    "Wasabi":3,"Jengibre":1,"Panko":15,"Harina":0,"Sésamo":1.5,"Castañas de cajú":1.25,
    "Tabasco":1,"Mayonesa":0,"Barbacoa":3.25,"Aceite girasol":0,"Aceite fritador":20,
    "Queso crema":24,"Miel":0.5,"Papel higiénico":11,"Papel absorbente":2.5,
    "Detergente":5,"Hipoclorito":3.5,"Limpiador piso":5,"Limpiador vidrio":0,
    "Esponjas":5,"Esponjas aluminio":0,"Bolsas residuos":1,"Desengrasante":450,
    "Repasadores":7,"Trapos piso":3,"Palta":1.5,"Rúcula":15,"Ciboulette":10,
    "Cilantro":2,"Cebolla":3,"Pepino":0,"Lima":3,"Mango":17,"Maracuyá":0.5,
    "Huevos":7,"Salmón fresco":19.13,"Salmón ahumado":8.5,"Pescado blanco":8,
    "Camarón cocido nigiri":1,"Atún rojo":6.5,"Camarón":17.5,"Rabas":1.5
  };

  for (const [name, qty] of Object.entries(initialStock)) {
    const r = await q("SELECT id FROM products WHERE name=$1", [name]);
    if (r.rowCount) {
      await q(
        `INSERT INTO stock(product_id,quantity) VALUES($1,$2)
         ON CONFLICT(product_id) DO NOTHING`,
        [r.rows[0].id, qty]
      );
    }
  }
}

app.get("/api/me", (req,res) => res.json({ loggedIn: !!req.session.user, user: req.session.user || null }));

app.post("/api/login", (req,res) => {
  const { user, password } = req.body || {};
  if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.user = { username: user };
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
});

app.post("/api/logout", auth, (req,res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/products", auth, async (req,res) => {
  try {
    const { category, search = "", active = "all" } = req.query;
    const params = [];
    const where = [];
    if (category) { params.push(category); where.push(`p.category=$${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`p.name ILIKE $${params.length}`); }
    if (active !== "all") { params.push(active === "true"); where.push(`p.active=$${params.length}`); }
    const sql = `
      SELECT p.*, COALESCE(s.quantity,0) AS quantity
      FROM products p LEFT JOIN stock s ON s.product_id=p.id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.category,p.name`;
    const rows = (await q(sql, params)).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/categories", auth, async (_,res) => {
  const rows = (await q("SELECT DISTINCT category FROM products ORDER BY category")).rows;
  res.json(rows.map(x => x.category));
});

app.patch("/api/stock/:id", auth, async (req,res) => {
  const id = Number(req.params.id);
  const qty = Number(req.body?.quantity);
  const note = String(req.body?.note || "Corrección de stock");
  if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({error:"Cantidad inválida"});
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const old = await c.query("SELECT quantity FROM stock WHERE product_id=$1 FOR UPDATE", [id]);
    const previous = Number(old.rows[0]?.quantity || 0);
    await c.query(
      `INSERT INTO stock(product_id,quantity) VALUES($1,$2)
       ON CONFLICT(product_id) DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=NOW()`,
      [id,qty]
    );
    await c.query(
      `INSERT INTO movements(product_id,type,previous_quantity,quantity,new_quantity,note)
       VALUES($1,'correction',$2,$3,$4,$5)`,
      [id,previous,qty,qty,note]
    );
    await c.query("COMMIT");
    res.json({ok:true,previous,quantity:qty});
  } catch(e) { await c.query("ROLLBACK"); res.status(500).json({error:e.message}); }
  finally { c.release(); }
});

app.get("/api/movements", auth, async (_,res) => {
  const rows = (await q(`
    SELECT m.*,p.name
    FROM movements m LEFT JOIN products p ON p.id=m.product_id
    ORDER BY m.created_at DESC LIMIT 200`)).rows;
  res.json(rows);
});

app.get("/api/recommendations", auth, async (_,res) => {
  const rows = (await q(`
    SELECT p.*,COALESCE(s.quantity,0) quantity
    FROM products p LEFT JOIN stock s ON s.product_id=p.id
    WHERE p.active=true ORDER BY p.category,p.name`)).rows;
  const out = rows.map(p => ({...p, ...recommendation(p)}));
  res.json({purchaseDay: nextPurchaseDay(), daysToPurchase: daysToPurchase(), items: out});
});

app.post("/api/orders", auth, async (req,res) => {
  const recommended = Array.isArray(req.body?.recommended) ? req.body.recommended : [];
  const chosen = Array.isArray(req.body?.chosen) ? req.body.chosen : recommended;
  const result = await q(
    `INSERT INTO purchase_orders(status,purchase_day,recommended,chosen)
     VALUES('draft',$1,$2,$3) RETURNING id`,
    [nextPurchaseDay(),JSON.stringify(recommended),JSON.stringify(chosen)]
  );
  res.json({id:result.rows[0].id});
});

app.post("/api/orders/:id/sent", auth, async (req,res) => {
  await q("UPDATE purchase_orders SET status='sent',sent_at=NOW() WHERE id=$1", [Number(req.params.id)]);
  res.json({ok:true});
});

app.get("/api/purchases", auth, async (_,res) => {
  const rows = (await q(`
    SELECT id,supplier,purchase_date,total,receipt_mime,created_at
    FROM purchases ORDER BY purchase_date DESC, id DESC LIMIT 100`)).rows;
  res.json(rows);
});

app.get("/api/purchases/:id/receipt", auth, async (req,res) => {
  const r = await q("SELECT receipt_image,receipt_mime FROM purchases WHERE id=$1",[Number(req.params.id)]);
  if (!r.rowCount || !r.rows[0].receipt_image) return res.status(404).end();
  res.setHeader("Content-Type",r.rows[0].receipt_mime || "image/jpeg");
  res.send(r.rows[0].receipt_image);
});

app.post("/api/purchases", auth, upload.single("receipt"), async (req,res) => {
  const items = JSON.parse(req.body.items || "[]");
  const supplier = String(req.body.supplier || "");
  if (!Array.isArray(items) || !items.length) return res.status(400).json({error:"Agregá al menos un producto"});
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    let total = 0;
    for (const i of items) total += Math.max(0,Number(i.quantity)||0) * Math.max(0,Number(i.unit_price)||0);
    const p = await c.query(
      `INSERT INTO purchases(supplier,total,receipt_image,receipt_mime)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [supplier,total,req.file?.buffer || null,req.file?.mimetype || null]
    );
    const purchaseId = p.rows[0].id;
    for (const i of items) {
      const productId = Number(i.product_id);
      const qty = Number(i.quantity);
      const price = Number(i.unit_price)||0;
      if (!Number.isFinite(productId)||!Number.isFinite(qty)||qty<0) continue;
      await c.query(
        `INSERT INTO purchase_items(purchase_id,product_id,quantity,unit_price)
         VALUES($1,$2,$3,$4)`,[purchaseId,productId,qty,price]
      );
      const old = await c.query("SELECT quantity FROM stock WHERE product_id=$1 FOR UPDATE",[productId]);
      const previous = Number(old.rows[0]?.quantity || 0);
      const next = previous + qty;
      await c.query(
        `INSERT INTO stock(product_id,quantity) VALUES($1,$2)
         ON CONFLICT(product_id) DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=NOW()`,
        [productId,next]
      );
      await c.query(
        `INSERT INTO movements(product_id,type,previous_quantity,quantity,new_quantity,note)
         VALUES($1,'purchase',$2,$3,$4,$5)`,
        [productId,previous,qty,next,`Compra recibida #${purchaseId}`]
      );
      await c.query("UPDATE products SET last_price=$1,updated_at=NOW() WHERE id=$2",[price,productId]);
    }
    await c.query("COMMIT");
    res.json({ok:true,id:purchaseId,total});
  } catch(e) {
    await c.query("ROLLBACK");
    res.status(500).json({error:e.message});
  } finally { c.release(); }
});

app.post("/api/products", auth, async (req,res) => {
  const b=req.body||{};
  if(!b.name||!b.category) return res.status(400).json({error:"Nombre y categoría son obligatorios"});
  try {
    const r=await q(
      `INSERT INTO products(name,category,unit,purchase_unit,conversion,control_type,safety_stock,weekly_consumption,purchase_frequency,supplier,last_price,active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.name,b.category,b.unit||"unidad",b.purchase_unit||b.unit||"unidad",
       Number(b.conversion)||1,["automatic","minimum","manual"].includes(b.control_type)?b.control_type:"manual",
       Number(b.safety_stock)||0,Number(b.weekly_consumption)||0,b.purchase_frequency||"martes_jueves",
       b.supplier||null,Number(b.last_price)||0,b.active!==false]
    );
    await q("INSERT INTO stock(product_id,quantity) VALUES($1,$2)",[r.rows[0].id,Number(b.quantity)||0]);
    res.json(r.rows[0]);
  } catch(e) { res.status(400).json({error:e.code==="23505"?"El producto ya existe":e.message}); }
});

app.patch("/api/products/:id", auth, async (req,res) => {
  const id=Number(req.params.id), b=req.body||{};
  const fields = ["name","category","unit","purchase_unit","conversion","control_type","safety_stock","weekly_consumption","purchase_frequency","supplier","last_price","active"];
  const set=[], params=[];
  for(const f of fields) {
    if(Object.prototype.hasOwnProperty.call(b,f)) {
      params.push(["conversion","safety_stock","weekly_consumption","last_price"].includes(f)?Number(b[f]):b[f]);
      set.push(`${f}=$${params.length}`);
    }
  }
  if(!set.length) return res.json({ok:true});
  params.push(id);
  try { const r=await q(`UPDATE products SET ${set.join(",")},updated_at=NOW() WHERE id=$${params.length} RETURNING *`,params); res.json(r.rows[0]); }
  catch(e){res.status(400).json({error:e.message});}
});

app.use((req,res,next)=>{
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    return res.sendFile(path.join(__dirname,"public","index.html"));
  }
  return next();
});

init()
  .then(()=>app.listen(PORT,()=>console.log(`Sushitime Stock activo en puerto ${PORT}`)))
  .catch(e=>{console.error(e);process.exit(1);});
