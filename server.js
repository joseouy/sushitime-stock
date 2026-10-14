const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
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
  max: 5
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype));
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || "change-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: "No autenticado" });
}

function q(sql, params = []) {
  return pool.query(sql, params);
}

function nextPurchaseDay(date = new Date()) {
  // Compras martes y jueves. Si hoy es martes/jueves, se considera que
  // el pedido actual ya cerró y se apunta al siguiente día de compra.
  const d = date.getDay();
  if (d === 0 || d === 1 || d >= 4) return "martes";
  return "jueves";
}

function daysToPurchase(date = new Date()) {
  const d = date.getDay();
  if (d === 0) return 2; // domingo -> martes
  if (d === 1) return 1; // lunes -> martes
  if (d === 2) return 2; // martes -> jueves
  if (d === 3) return 1; // miércoles -> jueves
  if (d === 4) return 5; // jueves -> martes
  if (d === 5) return 4; // viernes -> martes
  return 3; // sábado -> martes
}

function daysCoveredByNextOrder(date = new Date()) {
  // La compra próxima debe cubrir hasta la siguiente oportunidad de compra.
  // Después de recibir martes, la próxima compra es jueves (2 días);
  // después de recibir jueves, la próxima es martes (5 días).
  const upcomingDay = nextPurchaseDay(date);
  const cycleAfterDelivery = upcomingDay === "martes" ? 2 : 5;
  return daysToPurchase(date) + cycleAfterDelivery;
}

function normalizeProductName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedNameSql(column) {
  // Normaliza acentos comunes en PostgreSQL sin necesitar la extensión unaccent.
  return `lower(translate(${column}, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'))`;
}

function pluralPurchaseUnit(unit, quantity) {
  if (quantity === 1) return unit;
  const pluralForms = {
    "bidón": "bidones", "funda": "fundas", "caja": "cajas",
    "bolsa": "bolsas", "botella": "botellas", "frasco": "frascos",
    "rollo": "rollos", "unidad": "unidades", "paquete": "paquetes",
    "maple": "maples"
  };
  return pluralForms[unit] || `${unit}s`;
}

function recommendation(p, date = new Date()) {
  const stock = Math.max(0, Number(p.quantity) || 0);

  // No se calcula una compra automática cuando hay productos duplicados con
  // nombres equivalentes: sus cantidades requieren conciliación manual primero.
  if (Number(p.duplicateCount) > 1) {
    return {
      status: "review",
      recommended: 0,
      need: 0,
      projected: stock,
      reason: `Hay ${p.duplicateCount} registros con nombres iguales salvo tildes/espacios. Revisá el stock de ambos antes de calcular la compra.`
    };
  }
  const weekly = Math.max(0, Number(p.weekly_consumption) || 0);
  const safety = Math.max(0, Number(p.safety_stock) || 0);
  // conversion es el contenido de una presentación, en la unidad de stock.
  const pack = Math.max(Number(p.conversion) || 1, 0.000001);
  const control = p.control_type || "manual";

  if (control === "manual") {
    return {
      status: "review", recommended: 0, need: 0, projected: stock,
      reason: "Control manual: revisar la cantidad a comprar."
    };
  }

  if (control !== "minimum" && control !== "automatic") {
    return {
      status: "review", recommended: 0, need: 0, projected: stock,
      reason: "Tipo de control desconocido; revisar configuración."
    };
  }

  if (control === "automatic" && weekly <= 0) {
    return {
      status: "review", recommended: 0, need: 0, projected: stock,
      reason: "Falta configurar el consumo semanal."
    };
  }

  const days = control === "automatic" ? daysCoveredByNextOrder(date) : 0;
  const need = weekly * days / 7;
  // Cubre el consumo del período y procura conservar el stock de seguridad.
  const rawUnits = Math.max(0, safety + need - stock);
  const recommended = rawUnits > 0 ? Math.ceil(rawUnits / pack) : 0;
  // recommended se expresa en presentaciones (fundas/bidones), no en kg/L.
  const projected = stock + recommended * pack - need;

  let status = "ok";
  if (recommended > 0) status = "buy";
  else if (projected < safety) status = "review";

  const purchaseUnit = p.purchase_unit || p.unit || "unidad";
  const reason =
    `Necesidad estimada para ${days} días: ${need.toFixed(2)} ${p.unit}. ` +
    `Stock actual: ${stock.toFixed(2)} ${p.unit}.` +
    (recommended > 0
      ? ` Se recomiendan ${recommended} ${pluralPurchaseUnit(purchaseUnit, recommended)} ` +
        `(${(recommended * pack).toFixed(2)} ${p.unit}).`
      : ` Stock proyectado: ${projected.toFixed(2)} ${p.unit}.`);

  return { status, recommended, need, projected, coverageDays: days, reason };
}

function groupRecommendationProducts(rows) {
  // Evita dos líneas de pedido separadas para "Azúcar" y "Azucar".
  // No suma ni modifica existencias: un grupo duplicado pasa a revisión manual.
  const groups = new Map();
  for (const p of rows) {
    const key = `${normalizeProductName(p.name)}::${normalizeProductName(p.category)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const result = [];
  for (const items of groups.values()) {
    const priority = { automatic: 0, minimum: 1, manual: 2 };
    const ranked = [...items].sort((a, b) => {
      const difference = (priority[a.control_type] ?? 3) - (priority[b.control_type] ?? 3);
      if (difference !== 0) return difference;
      // Si un registro tiene cantidad cargada y el otro no, mostramos primero
      // el que contiene más stock, pero igual se fuerza revisión por duplicado.
      const quantityDifference = (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
      if (quantityDifference !== 0) return quantityDifference;
      const accentA = /[áéíóúüñ]/i.test(a.name) ? 0 : 1;
      const accentB = /[áéíóúüñ]/i.test(b.name) ? 0 : 1;
      return accentA - accentB || Number(a.id) - Number(b.id);
    });
    const primary = ranked[0];
    result.push({
      ...primary,
      // Si hay duplicados, se conserva la cantidad del registro principal en
      // esta vista y se bloquea el cálculo automático para evitar sumar stock
      // que tal vez representa la misma existencia física dos veces.
      duplicateCount: items.length,
      duplicateIds: items.map(item => Number(item.id))
    });
  }
  return result;
}

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unidad',
      purchase_unit TEXT NOT NULL DEFAULT 'unidad',
      conversion NUMERIC NOT NULL DEFAULT 1,
      control_type TEXT NOT NULL DEFAULT 'manual',
      safety_stock NUMERIC NOT NULL DEFAULT 0,
      weekly_consumption NUMERIC NOT NULL DEFAULT 0,
      purchase_frequency TEXT NOT NULL DEFAULT 'martes_jueves',
      supplier TEXT,
      last_price NUMERIC NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL DEFAULT 0,
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
      status TEXT NOT NULL DEFAULT 'draft',
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
      quantity NUMERIC NOT NULL DEFAULT 0,
      unit_price NUMERIC NOT NULL DEFAULT 0
    );
  `);

  const products = [
    ["Arroz","Insumos varios","kg","funda",25,"automatic",30,54],
    ["Azucar","Insumos varios","kg","kg",1,"automatic",10,29],
    ["Vinagre","Insumos varios","L","L",1,"automatic",5,20],
    ["Algas Nori","Insumos varios","paquete","paquete",1,"manual",0,0],
    ["Salsa de soja","Insumos varios","kg","bidón",10,"manual",10,0],
    ["Wasabi","Insumos varios","kg","kg",1,"manual",1,0],
    ["Jengibre","Insumos varios","kg","kg",1,"manual",0.5,0],
    ["Panko","Insumos varios","kg","kg",1,"manual",5,0],
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
    ["Rabas","Pescados y mariscos","kg","kg",1,"manual",1.5,0]
  ];

  for (const p of products) {
    const exists = await q(
      `SELECT id FROM products
       WHERE ${normalizedNameSql("name")} = ${normalizedNameSql("$1")}
       ORDER BY CASE WHEN name=$1 THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [p[0]]
    );
    if (!exists.rowCount) {
      await q(`
        INSERT INTO products
        (name,category,unit,purchase_unit,conversion,control_type,
         safety_stock,weekly_consumption)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      `,p);
    }
  }

  const stock = {
    "Arroz":30,"Azucar":21,"Vinagre":7,"Algas Nori":3,
    "Salsa de soja":20,"Wasabi":3,"Jengibre":1,"Panko":15,
    "Harina":0,"Sésamo":1.5,"Castañas de cajú":1.25,"Tabasco":1,
    "Mayonesa":0,"Barbacoa":3.25,"Aceite girasol":0,"Aceite fritador":20,
    "Queso crema":24,"Miel":0.5,"Papel higiénico":11,
    "Papel absorbente":2.5,"Detergente":5,"Hipoclorito":3.5,
    "Limpiador piso":5,"Limpiador vidrio":0,"Esponjas":5,
    "Esponjas aluminio":0,"Bolsas residuos":1,"Desengrasante":450,
    "Repasadores":7,"Trapos piso":3,"Palta":1.5,"Rúcula":15,
    "Ciboulette":10,"Cilantro":2,"Cebolla":3,"Pepino":0,"Lima":3,
    "Mango":17,"Maracuyá":0.5,"Huevos":7,"Salmón fresco":19.13,
    "Salmón ahumado":8.5,"Pescado blanco":8,
    "Camarón cocido nigiri":1,"Atún rojo":6.5,"Camarón":17.5,
    "Rabas":1.5
  };

  for (const [name,qty] of Object.entries(stock)) {
    const p = await q(
      `SELECT id FROM products
       WHERE ${normalizedNameSql("name")} = ${normalizedNameSql("$1")}
       ORDER BY CASE WHEN name=$1 THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [name]
    );
    if (!p.rowCount) continue;

    const s = await q(
      "SELECT product_id FROM stock WHERE product_id=$1",
      [p.rows[0].id]
    );

    if (!s.rowCount) {
      await q(
        "INSERT INTO stock(product_id,quantity) VALUES($1,$2)",
        [p.rows[0].id,qty]
      );
    }
  }

  
  // === SUSHITIME: carga completa de stock 07/10/2026 ===
  await pool.query(`CREATE TABLE IF NOT EXISTS app_migrations (
    key TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const mig = await pool.query(
    "SELECT 1 FROM app_migrations WHERE key=$1",
    ["stock_snapshot_2026_10_07"]
  );

    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_state TEXT NOT NULL DEFAULT 'raw'");
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS notes TEXT");
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS expiry_date DATE");

if (!mig.rowCount && process.env.ALLOW_LEGACY_STOCK_SNAPSHOT === "true") {
    const stock = {
      "Azucar":21,
      "Vinagre":7,
      "Algas Nori":3,
      "Salsa de soja":20,
      "Wasabi":3,
      "Jengibre":1,
      "Panko":15,
      "Pan rallado":0,
      "Harina":0,
      "Sésamo":1.5,
      "Castañas de cajú":1.25,
      "Tabasco":1,
      "Mayonesa":0,
      "Barbacoa":3.25,
      "Sal":0,
      "Aceite girasol":0,
      "Aceite fritador":20,
      "Tomates secos":0,
      "Queso crema":24,
      "Cheddar":5,
      "Arrolladitos":2.5,
      "Miel":0.5,
      "Papel film":1250,
      "Separadores":3.75,
      "Palitos brochette":1,
      "Papel higiénico":11,
      "Papel absorbente":2.5,
      "Detergente":5,
      "Hipoclorito":3.5,
      "Limpiador piso":5,
      "Limpiador vidrio":0,
      "Esponjas":5,
      "Esponjas aluminio":0,
      "Bolsas residuos":1,
      "Desengrasante":450,
      "Repasadores":7,
      "Trapos piso":3,
      "Palta":1.5,
      "Rúcula":15,
      "Ciboulette":10,
      "Cilantro":2,
      "Cebolla":3,
      "Pepino":0,
      "Lima":3,
      "Mango":17,
      "Maracuyá":0.5,
      "Huevos":7,
      "Salmón fresco":19.13,
      "Salmón ahumado":8.5,
      "Pescado blanco":8,
      "Camarón cocido nigiri":1,
      "Atún rojo":6.5,
      "Camarón":17.5,
      "Rabas":1.5
    };

    const notes = {
      "Arroz":"1 funda de 25 kg + 5 kg abiertos",
      "Vinagre":"7 L físicos. Hay además 5 L elaborados, separados",
      "Algas Nori":"2 cerradas + 1 abierta",
      "Panko":"10 kg cerrados + 5 kg abiertos",
      "Sésamo":"1,5 kg crudos + 0,5 kg cocidos separados",
      "Castañas de cajú":"1 kg + 250 g; preparación caramelizada separada",
      "Barbacoa":"Bolsa de 6,5 kg, aproximadamente media bolsa disponible",
      "Queso crema":"12 x 2 kg = 24 kg",
      "Cheddar":"5 piezas, aproximadamente media presentación",
      "Arrolladitos":"2 x 1 kg + menos de medio paquete adicional",
      "Papel film":"1 rollo cerrado de 1000 m + menos de medio rollo grande",
      "Separadores":"1 cerrado + 1 casi cerrado + 1 medio + 1 casi vacío",
      "Salmón fresco":"19,13 kg netos; 13 piezas. Vencimiento 06/10/2026",
      "Salmón ahumado":"8 bolsas + 0,5 bolsa descongelada",
      "Atún rojo":"13 x 0,5 kg + 1 abierto",
      "Camarón":"14 x 1 kg + 2 kg + 1,5 kg hervidos; mantener separados",
      "Rabas":"1,5 kg para preparar"
    };

    for (const [name, qty] of Object.entries(stock)) {
      const q = await pool.query(
        "SELECT id FROM products WHERE lower(name)=lower($1) LIMIT 1",
        [name]
      );
      if (q.rowCount) {
        const id = q.rows[0].id;
        await pool.query(
          "INSERT INTO stock(product_id,quantity) VALUES($1,$2) ON CONFLICT(product_id) DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=NOW()",
          [id, qty]
        );
        if (notes[name]) {
          await pool.query("UPDATE products SET notes=$2 WHERE id=$1",[id,notes[name]]);
        }
      }
    }

    // Productos elaborados y trabajos en proceso: NO entran en el cálculo de compras.
    const extra = [
      ["Vinagre elaborado","Elaborados","L",5,"finished","5 L elaborados; separado del vinagre crudo"],
      ["Sú","Elaborados","L",9,"finished","9 L elaborados"],
      ["Salsa de maracuyá","Elaborados","L",7,"finished","7 L elaborados"],
      ["Teriyaki","Elaborados","L",2,"finished","2 L elaborados"],
      ["Mini salmón","En elaboración","caja",4,"wip","4 cajas en proceso"],
      ["Camarón cocido nigiri WIP","En elaboración","caja",1,"wip","1 caja en proceso"],
      ["Camarón empanado","En elaboración","caja",1,"wip","1 caja"],
      ["Pescado blanco empanado","En elaboración","caja",0.333333,"wip","1/3 de caja"],
      ["Rabas empanadas","En elaboración","caja",1,"wip","1 caja"],
      ["Diablas","En elaboración","caja",5.5,"wip","Mezcla suficiente para 5–6 cajas; todavía no son cajas terminadas"],
      ["Cebolla caramelizada","En elaboración","caja",0,"wip","Debe elaborarse mañana; todavía no está terminada"]
    ];

    for (const [name,category,unit,qty,state,note] of extra) {
      let q = await pool.query("SELECT id FROM products WHERE lower(name)=lower($1) LIMIT 1",[name]);
      let id;
      if (q.rowCount) {
        id=q.rows[0].id;
        await pool.query(
          "UPDATE products SET category=$2,unit=$3,stock_state=$4,notes=$5,control_type='manual',weekly_consumption=0 WHERE id=$1",
          [id,category,unit,state,note]
        );
      } else {
        const r = await pool.query(
          "INSERT INTO products(name,category,unit,purchase_unit,conversion,control_type,safety_stock,weekly_consumption,stock_state,notes) VALUES($1,$2,$3,$3,1,'manual',0,0,$4,$5) RETURNING id",
          [name,category,unit,state,note]
        );
        id=r.rows[0].id;
      }
      await pool.query(
        "INSERT INTO stock(product_id,quantity) VALUES($1,$2) ON CONFLICT(product_id) DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=NOW()",
        [id,qty]
      );
    }

    // Únicos productos con cálculo automático confirmado por ahora.
    await pool.query("UPDATE products SET control_type='automatic',safety_stock=30,weekly_consumption=54,purchase_unit='funda',conversion=25 WHERE lower(name)='arroz'");
    await pool.query("UPDATE products SET control_type='automatic',safety_stock=10,weekly_consumption=29,purchase_unit='kg',conversion=1 WHERE lower(name)='azucar'");
    await pool.query("UPDATE products SET control_type='automatic',safety_stock=5,weekly_consumption=20,purchase_unit='bidón',conversion=5 WHERE lower(name)='vinagre'");

    await pool.query(
      "UPDATE products SET expiry_date='2026-10-06' WHERE lower(name)='salmón fresco'"
    );

    await pool.query(
      "INSERT INTO app_migrations(key) VALUES($1)",
      ["stock_snapshot_2026_10_07"]
    );

    console.log("SUSHITIME: stock completo inicial cargado.");
  }
  // === FIN CARGA COMPLETA ===
  // === MIGRACIÓN: configuración operativa de compras ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const configMigration = await pool.query(
    "SELECT 1 FROM app_migrations WHERE key=$1",
    ["purchase_config_2026_10_14"]
  );

  if (!configMigration.rowCount) {
    await pool.query(`
      UPDATE products
      SET control_type='automatic',
          safety_stock=25,
          weekly_consumption=45,
          purchase_unit='funda',
          conversion=25
      WHERE lower(name)='arroz'
    `);

    await pool.query(`
      UPDATE products
      SET control_type='automatic',
          safety_stock=10,
          weekly_consumption=35,
          purchase_unit='funda',
          conversion=10
      WHERE lower(name)='azucar'
    `);

    await pool.query(`
      UPDATE products
      SET control_type='automatic',
          safety_stock=15,
          weekly_consumption=15,
          purchase_unit='bidón',
          conversion=5
      WHERE lower(name)='vinagre'
    `);

    await pool.query(
      "INSERT INTO app_migrations(key) VALUES($1)",
      ["purchase_config_2026_10_14"]
    );

    console.log("SUSHITIME: configuración de compras aplicada.");
  }
  // === MIGRACIÓN SEGURA V2: configuración por nombre sin importar tildes ===
  // Solo cambia las reglas de compra; no toca stock.quantity ni borra productos.
  const configMigrationV2 = await pool.query(
    "SELECT 1 FROM app_migrations WHERE key=$1",
    ["purchase_config_accent_units_2026_10_14_v2"]
  );

  if (!configMigrationV2.rowCount) {
    await pool.query(`
      UPDATE products
      SET control_type='automatic', safety_stock=25,
          weekly_consumption=45, purchase_unit='funda', conversion=25
      WHERE ${normalizedNameSql("name")}='arroz'
    `);
    await pool.query(`
      UPDATE products
      SET control_type='automatic', safety_stock=10,
          weekly_consumption=35, purchase_unit='funda', conversion=10
      WHERE ${normalizedNameSql("name")}='azucar'
    `);
    await pool.query(`
      UPDATE products
      SET control_type='automatic', safety_stock=15,
          weekly_consumption=15, purchase_unit='bidón', conversion=5
      WHERE ${normalizedNameSql("name")}='vinagre'
    `);
    await pool.query(
      "INSERT INTO app_migrations(key) VALUES($1)",
      ["purchase_config_accent_units_2026_10_14_v2"]
    );
    console.log("SUSHITIME: configuración de compras v2 aplicada (sin modificar stock).");
  }

  console.log("Base de datos inicializada correctamente.");
}

app.get("/health",(req,res)=>{
  res.json({ok:true});
});

app.get("/api/me",(req,res)=>{
  res.json({
    loggedIn:!!req.session.user,
    user:req.session.user || null
  });
});

app.post("/api/login",(req,res)=>{
  const {user,password}=req.body || {};

  if(user===ADMIN_USER && password===ADMIN_PASSWORD){
    req.session.user={username:user};
    return res.json({ok:true});
  }

  res.status(401).json({error:"Usuario o contraseña incorrectos"});
});

app.post("/api/logout",auth,(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

app.get("/api/categories",auth,async(req,res)=>{
  try{
    const r=await q(
      "SELECT DISTINCT category FROM products ORDER BY category"
    );
    res.json(r.rows.map(x=>x.category));
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.get("/api/products",auth,async(req,res)=>{
  try{
    const {category,search="",active="all"}=req.query;
    const params=[];
    const where=[];

    if(category){
      params.push(category);
      where.push(`p.category=$${params.length}`);
    }

    if(search){
      params.push(`%${search}%`);
      where.push(`p.name ILIKE $${params.length}`);
    }

    if(active!=="all"){
      params.push(active==="true");
      where.push(`p.active=$${params.length}`);
    }

    const sql=`
      SELECT p.*,COALESCE(s.quantity,0) AS quantity
      FROM products p
      LEFT JOIN stock s ON s.product_id=p.id
      ${where.length?"WHERE "+where.join(" AND "):""}
      ORDER BY p.category,p.name
    `;

    const r=await q(sql,params);
    res.json(r.rows);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.patch("/api/stock/:id",auth,async(req,res)=>{
  const id=Number(req.params.id);
  const qty=Number(req.body?.quantity);
  const note=String(req.body?.note || "Corrección de stock");

  if(!Number.isFinite(qty) || qty<0){
    return res.status(400).json({error:"Cantidad inválida"});
  }

  const c=await pool.connect();

  try{
    await c.query("BEGIN");

    const old=await c.query(
      "SELECT quantity FROM stock WHERE product_id=$1 FOR UPDATE",
      [id]
    );

    const previous=Number(old.rows[0]?.quantity || 0);

    if(old.rowCount){
      await c.query(
        "UPDATE stock SET quantity=$1,updated_at=NOW() WHERE product_id=$2",
        [qty,id]
      );
    }else{
      await c.query(
        "INSERT INTO stock(product_id,quantity) VALUES($1,$2)",
        [id,qty]
      );
    }

    await c.query(`
      INSERT INTO movements
      (product_id,type,previous_quantity,quantity,new_quantity,note)
      VALUES($1,'correction',$2,$3,$4,$5)
    `,[id,previous,qty,qty,note]);

    await c.query("COMMIT");

    res.json({ok:true,previous,quantity:qty});
  }catch(e){
    await c.query("ROLLBACK");
    res.status(500).json({error:e.message});
  }finally{
    c.release();
  }
});

app.get("/api/movements",auth,async(req,res)=>{
  try{
    const r=await q(`
      SELECT m.*,p.name
      FROM movements m
      LEFT JOIN products p ON p.id=m.product_id
      ORDER BY m.created_at DESC
      LIMIT 200
    `);

    res.json(r.rows);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.get("/api/recommendations",auth,async(req,res)=>{
  try{
    const r=await q(`
      SELECT p.*,COALESCE(s.quantity,0) AS quantity
      FROM products p
      LEFT JOIN stock s ON s.product_id=p.id
      WHERE p.active=true
  AND COALESCE(p.stock_state,'raw')='raw'
      ORDER BY p.category,p.name
    `);

    const now = new Date();
    const grouped = groupRecommendationProducts(r.rows);
    const coverageDays = daysCoveredByNextOrder(now);

    res.json({
      purchaseDay:nextPurchaseDay(now),
      // La interfaz existente muestra este valor como "cobertura estimada".
      daysToPurchase:coverageDays,
      daysUntilPurchase:daysToPurchase(now),
      items:grouped.map(p=>({...p,...recommendation(p, now)}))
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/orders",auth,async(req,res)=>{
  try{
    const recommended=Array.isArray(req.body?.recommended)
      ? req.body.recommended : [];

    const chosen=Array.isArray(req.body?.chosen)
      ? req.body.chosen : recommended;

    const r=await q(`
      INSERT INTO purchase_orders
      (status,purchase_day,recommended,chosen)
      VALUES('draft',$1,$2,$3)
      RETURNING id
    `,[
      nextPurchaseDay(),
      JSON.stringify(recommended),
      JSON.stringify(chosen)
    ]);

    res.json({id:r.rows[0].id});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/orders/:id/sent",auth,async(req,res)=>{
  try{
    await q(
      "UPDATE purchase_orders SET status='sent',sent_at=NOW() WHERE id=$1",
      [Number(req.params.id)]
    );

    res.json({ok:true});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.get("/api/purchases",auth,async(req,res)=>{
  try{
    const r=await q(`
      SELECT id,supplier,purchase_date,total,receipt_mime,created_at
      FROM purchases
      ORDER BY purchase_date DESC,id DESC
      LIMIT 100
    `);

    res.json(r.rows);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.get("/api/purchases/:id/receipt",auth,async(req,res)=>{
  try{
    const r=await q(
      "SELECT receipt_image,receipt_mime FROM purchases WHERE id=$1",
      [Number(req.params.id)]
    );

    if(!r.rowCount || !r.rows[0].receipt_image){
      return res.status(404).end();
    }

    res.setHeader(
      "Content-Type",
      r.rows[0].receipt_mime || "image/jpeg"
    );

    res.send(r.rows[0].receipt_image);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post("/api/purchases",auth,upload.single("receipt"),async(req,res)=>{
  let items=[];

  try{
    items=JSON.parse(req.body.items || "[]");
  }catch(e){
    return res.status(400).json({error:"JSON de productos inválido"});
  }

  if(!Array.isArray(items) || !items.length){
    return res.status(400).json({
      error:"Agregá al menos un producto"
    });
  }

  const supplier=String(req.body.supplier || "");
  const c=await pool.connect();

  try{
    await c.query("BEGIN");

    let total=0;

    for(const i of items){
      total +=
        Math.max(0,Number(i.quantity)||0) *
        Math.max(0,Number(i.unit_price)||0);
    }

    const purchase=await c.query(`
      INSERT INTO purchases
      (supplier,total,receipt_image,receipt_mime)
      VALUES($1,$2,$3,$4)
      RETURNING id
    `,[
      supplier,
      total,
      req.file?.buffer || null,
      req.file?.mimetype || null
    ]);

    const purchaseId=purchase.rows[0].id;

    for(const i of items){
      const productId=Number(i.product_id);
      const qty=Number(i.quantity);
      const price=Number(i.unit_price)||0;

      if(
        !Number.isFinite(productId) ||
        !Number.isFinite(qty) ||
        qty<0
      ) continue;

      await c.query(`
        INSERT INTO purchase_items
        (purchase_id,product_id,quantity,unit_price)
        VALUES($1,$2,$3,$4)
      `,[purchaseId,productId,qty,price]);

      const old=await c.query(
        "SELECT quantity FROM stock WHERE product_id=$1 FOR UPDATE",
        [productId]
      );

      const previous=Number(old.rows[0]?.quantity || 0);
      const next=previous+qty;

      if(old.rowCount){
        await c.query(
          "UPDATE stock SET quantity=$1,updated_at=NOW() WHERE product_id=$2",
          [next,productId]
        );
      }else{
        await c.query(
          "INSERT INTO stock(product_id,quantity) VALUES($1,$2)",
          [productId,next]
        );
      }

      await c.query(`
        INSERT INTO movements
        (product_id,type,previous_quantity,quantity,new_quantity,note)
        VALUES($1,'purchase',$2,$3,$4,$5)
      `,[
        productId,
        previous,
        qty,
        next,
        `Compra recibida #${purchaseId}`
      ]);

      await c.query(
        "UPDATE products SET last_price=$1,updated_at=NOW() WHERE id=$2",
        [price,productId]
      );
    }

    await c.query("COMMIT");

    res.json({
      ok:true,
      id:purchaseId,
      total
    });
  }catch(e){
    await c.query("ROLLBACK");
    res.status(500).json({error:e.message});
  }finally{
    c.release();
  }
});

app.post("/api/products",auth,async(req,res)=>{
  const b=req.body || {};

  if(!b.name || !b.category){
    return res.status(400).json({
      error:"Nombre y categoría son obligatorios"
    });
  }

  try{
    const exists=await q(
      `SELECT id FROM products
       WHERE ${normalizedNameSql("name")} = ${normalizedNameSql("$1")}
       LIMIT 1`,
      [b.name]
    );

    if(exists.rowCount){
      return res.status(400).json({
        error:"El producto ya existe"
      });
    }

    const control=["automatic","minimum","manual"].includes(
      b.control_type
    ) ? b.control_type : "manual";

    const r=await q(`
      INSERT INTO products
      (name,category,unit,purchase_unit,conversion,control_type,
       safety_stock,weekly_consumption,purchase_frequency,
       supplier,last_price,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `,[
      b.name,
      b.category,
      b.unit || "unidad",
      b.purchase_unit || b.unit || "unidad",
      Number(b.conversion)||1,
      control,
      Number(b.safety_stock)||0,
      Number(b.weekly_consumption)||0,
      b.purchase_frequency || "martes_jueves",
      b.supplier || null,
      Number(b.last_price)||0,
      b.active!==false
    ]);

    await q(
      "INSERT INTO stock(product_id,quantity) VALUES($1,$2)",
      [r.rows[0].id,Number(b.quantity)||0]
    );

    res.json(r.rows[0]);
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

app.patch("/api/products/:id",auth,async(req,res)=>{
  const id=Number(req.params.id);
  const b=req.body || {};

  const fields=[
    "name","category","unit","purchase_unit","conversion",
    "control_type","safety_stock","weekly_consumption",
    "purchase_frequency","supplier","last_price","active"
  ];

  const numeric=[
    "conversion",
    "safety_stock",
    "weekly_consumption",
    "last_price"
  ];

  const set=[];
  const params=[];

  if(typeof b.name === "string" && b.name.trim()) {
    try {
      const requestedName = b.name.trim();
      const current = await q("SELECT name FROM products WHERE id=$1 LIMIT 1", [id]);
      if(!current.rowCount) {
        return res.status(404).json({error:"Producto no encontrado"});
      }
      // Permite editar la configuración de registros duplicados existentes si
      // conservan su nombre; solo bloquea crear una nueva variante duplicada.
      if(current.rows[0].name !== requestedName) {
        const duplicate = await q(
          `SELECT id FROM products
           WHERE ${normalizedNameSql("name")} = ${normalizedNameSql("$1")}
             AND id <> $2
           LIMIT 1`,
          [requestedName, id]
        );
        if(duplicate.rowCount) {
          return res.status(400).json({
            error:"Ya existe un producto con ese nombre (sin distinguir tildes)."
          });
        }
      }
    } catch(e) {
      return res.status(400).json({error:e.message});
    }
  }

  for(const f of fields){
    if(Object.prototype.hasOwnProperty.call(b,f)){
      let value=b[f];

      if(numeric.includes(f)){
        value=Number(value);

        if(!Number.isFinite(value)){
          return res.status(400).json({
            error:`Valor inválido para ${f}`
          });
        }
      }

      if(f==="control_type" &&
        !["automatic","minimum","manual"].includes(value)){
        return res.status(400).json({
          error:"Tipo de control inválido"
        });
      }

      params.push(value);
      set.push(`${f}=$${params.length}`);
    }
  }

  if(!set.length){
    return res.json({ok:true});
  }

  params.push(id);

  try{
    const r=await q(`
      UPDATE products
      SET ${set.join(",")},updated_at=NOW()
      WHERE id=$${params.length}
      RETURNING *
    `,params);

    if(!r.rowCount){
      return res.status(404).json({
        error:"Producto no encontrado"
      });
    }

    res.json(r.rows[0]);
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

app.use((req,res,next)=>{
  if(req.method==="GET" && !req.path.startsWith("/api/")){
    return res.sendFile(
      path.join(__dirname,"public","index.html")
    );
  }

  next();
});

init()
  .then(()=>{
    app.listen(PORT,"0.0.0.0",()=>{
      console.log(
        `Sushitime Stock activo en puerto ${PORT}`
      );
    });
  })
  .catch(e=>{
    console.error("ERROR AL INICIAR:",e);
    process.exit(1);
  });
