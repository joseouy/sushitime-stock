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
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Formato de imagen no permitido"));
    }
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret:
      process.env.SESSION_SECRET ||
      "sushitime-stock-session-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

function auth(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ error: "No autenticado" });
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNum(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nextPurchaseDay(date = new Date()) {
  const day = date.getDay();

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
  if (day === 4) return 5;
  if (day === 5) return 4;

  return 3;
}

function roundUp(quantity, pack) {
  const qty = num(quantity);
  const p = positiveNum(pack, 1);

  if (qty <= 0) return 0;

  return Math.ceil(qty / p) * p;
}

function recommendation(product) {
  const stock = nonNegativeNum(product.quantity);
  const weekly = nonNegativeNum(product.weekly_consumption);
  const safety = nonNegativeNum(product.safety_stock);
  const pack = positiveNum(product.conversion, 1);

  if (product.control_type === "manual" || weekly <= 0) {
    return {
      status: "review",
      recommended: 0,
      need: 0,
      projected: stock,
      reason: "Configuración insuficiente",
    };
  }

  const days = daysToPurchase();
  const need = weekly * (days / 7);

  const target = Math.max(need, safety);
  const raw = Math.max(0, target - stock);

  const recommended = roundUp(raw, pack);
  const projected = stock + recommended - need;

  let status = "ok";

  if (recommended > 0) {
    status = "buy";
  } else if (projected < safety) {
    status = "review";
  }

  let reason =
    `Necesidad estimada: ${need.toFixed(2)} ${product.unit}. ` +
    `Stock actual: ${stock.toFixed(2)}.`;

  if (recommended > 0) {
    reason +=
      ` Se redondea a ${recommended} ${product.purchase_unit || product.unit}.`;
  }

  if (recommended === 0 && projected < safety) {
    reason +=
      " Queda por debajo del stock de seguridad: revisar.";
  }

  return {
    status,
    recommended,
    need,
    projected,
    reason,
  };
}

async function q(text, params = []) {
  return pool.query(text, params);
}
app.get("/health", async (req, res) => {
  try {
    await q("SELECT 1");
    res.json({
      ok: true,
      database: "connected",
      service: "sushitime-stock"
    });
  } catch (error) {
    console.error("Health check DB error:", error.message);
    res.status(500).json({
      ok: false,
      database: "error"
    });
  }
});

app.get("/api/me", (req, res) => {
  res.json({
    loggedIn: !!req.session.user,
    user: req.session.user || null
  });
});

app.post("/api/login", (req, res) => {
  const { user, password } = req.body || {};

  if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.user = {
      username: user
    };

    return res.json({ ok: true });
  }

  return res.status(401).json({
    error: "Usuario o contraseña incorrectos"
  });
});

app.post("/api/logout", auth, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/products", auth, async (req, res) => {
  try {
    const {
      category,
      search = "",
      active = "all"
    } = req.query;

    const params = [];
    const where = [];

    if (category) {
      params.push(category);
      where.push(`p.category=$${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`p.name ILIKE $${params.length}`);
    }

    if (active !== "all") {
      params.push(active === "true");
      where.push(`p.active=$${params.length}`);
    }

    const sql = `
      SELECT
        p.*,
        COALESCE(s.quantity,0) AS quantity
      FROM products p
      LEFT JOIN stock s
        ON s.product_id=p.id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.category,p.name
    `;

    const rows = (await q(sql, params)).rows;

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudieron cargar los productos"
    });
  }
});

app.get("/api/categories", auth, async (req, res) => {
  try {
    const rows = (
      await q(
        "SELECT DISTINCT category FROM products ORDER BY category"
      )
    ).rows;

    res.json(rows.map(row => row.category));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudieron cargar las categorías"
    });
  }
});

app.patch("/api/stock/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const quantity = Number(req.body?.quantity);
  const note = String(
    req.body?.note || "Corrección de stock"
  );

  if (
    !Number.isInteger(id) ||
    !Number.isFinite(quantity) ||
    quantity < 0
  ) {
    return res.status(400).json({
      error: "Cantidad inválida"
    });
  }

  const connection = await pool.connect();

  try {
    await connection.query("BEGIN");

    const old = await connection.query(
      `SELECT quantity
       FROM stock
       WHERE product_id=$1
       FOR UPDATE`,
      [id]
    );

    const previous = Number(
      old.rows[0]?.quantity || 0
    );

    await connection.query(
      `INSERT INTO stock(product_id,quantity)
       VALUES($1,$2)
       ON CONFLICT(product_id)
       DO UPDATE SET
         quantity=EXCLUDED.quantity,
         updated_at=NOW()`,
      [id, quantity]
    );

    await connection.query(
      `INSERT INTO movements(
        product_id,
        type,
        previous_quantity,
        quantity,
        new_quantity,
        note
      )
      VALUES($1,'correction',$2,$3,$4,$5)`,
      [
        id,
        previous,
        quantity,
        quantity,
        note
      ]
    );

    await connection.query("COMMIT");

    res.json({
      ok: true,
      previous,
      quantity
    });
  } catch (error) {
    await connection.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      error: "No se pudo actualizar el stock"
    });
  } finally {
    connection.release();
  }
});

app.get("/api/movements", auth, async (req, res) => {
  try {
    const rows = (
      await q(`
        SELECT
          m.*,
          p.name
        FROM movements m
        LEFT JOIN products p
          ON p.id=m.product_id
        ORDER BY m.created_at DESC
        LIMIT 200
      `)
    ).rows;

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudieron cargar los movimientos"
    });
  }
});

app.get("/api/recommendations", auth, async (req, res) => {
  try {
    const rows = (
      await q(`
        SELECT
          p.*,
          COALESCE(s.quantity,0) AS quantity
        FROM products p
        LEFT JOIN stock s
          ON s.product_id=p.id
        WHERE p.active=true
        ORDER BY p.category,p.name
      `)
    ).rows;

    const items = rows.map(product => ({
      ...product,
      ...recommendation(product)
    }));

    res.json({
      purchaseDay: nextPurchaseDay(),
      daysToPurchase: daysToPurchase(),
      items
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudieron calcular las recomendaciones"
    });
  }
});

app.post("/api/orders", auth, async (req, res) => {
  try {
    const recommended = Array.isArray(
      req.body?.recommended
    )
      ? req.body.recommended
      : [];

    const chosen = Array.isArray(req.body?.chosen)
      ? req.body.chosen
      : recommended;

    const result = await q(
      `INSERT INTO purchase_orders(
        status,
        purchase_day,
        recommended,
        chosen
      )
      VALUES(
        'draft',
        $1,
        $2,
        $3
      )
      RETURNING id`,
      [
        nextPurchaseDay(),
        JSON.stringify(recommended),
        JSON.stringify(chosen)
      ]
    );

    res.json({
      id: result.rows[0].id
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudo guardar el pedido"
    });
  }
});

app.post("/api/orders/:id/sent", auth, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      error: "Pedido inválido"
    });
  }

  try {
    await q(
      `UPDATE purchase_orders
       SET
         status='sent',
         sent_at=NOW()
       WHERE id=$1`,
      [id]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudo marcar el pedido como enviado"
    });
  }
});

app.get("/api/purchases", auth, async (req, res) => {
  try {
    const rows = (
      await q(`
        SELECT
          id,
          supplier,
          purchase_date,
          total,
          receipt_mime,
          created_at
        FROM purchases
        ORDER BY purchase_date DESC,id DESC
        LIMIT 100
      `)
    ).rows;

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudieron cargar las compras"
    });
  }
});

app.get(
  "/api/purchases/:id/receipt",
  auth,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).end();
    }

    try {
      const result = await q(
        `SELECT
          receipt_image,
          receipt_mime
         FROM purchases
         WHERE id=$1`,
        [id]
      );

      if (
        !result.rowCount ||
        !result.rows[0].receipt_image
      ) {
        return res.status(404).end();
      }

      res.setHeader(
        "Content-Type",
        result.rows[0].receipt_mime ||
          "image/jpeg"
      );

      res.send(result.rows[0].receipt_image);
    } catch (error) {
      console.error(error);
      res.status(500).end();
    }
  }
);

app.post(
  "/api/purchases",
  auth,
  upload.single("receipt"),
  async (req, res) => {
    let items;

    try {
      items = JSON.parse(req.body.items || "[]");
    } catch (error) {
      return res.status(400).json({
        error: "El formato de productos recibido no es válido"
      });
    }

    const supplier = String(
      req.body.supplier || ""
    );

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({
        error: "Agregá al menos un producto"
      });
    }

    const connection = await pool.connect();

    try {
      await connection.query("BEGIN");

      let total = 0;

      for (const item of items) {
        const quantity = Number(item.quantity);
        const price = Number(item.unit_price);

        if (
          Number.isFinite(quantity) &&
          quantity > 0 &&
          Number.isFinite(price) &&
          price >= 0
        ) {
          total += quantity * price;
        }
      }

      const purchase = await connection.query(
        `INSERT INTO purchases(
          supplier,
          total,
          receipt_image,
          receipt_mime
        )
        VALUES($1,$2,$3,$4)
        RETURNING id`,
        [
          supplier,
          total,
          req.file?.buffer || null,
          req.file?.mimetype || null
        ]
      );

      const purchaseId =
        purchase.rows[0].id;

      for (const item of items) {
        const productId = Number(
          item.product_id
        );

        const quantity = Number(
          item.quantity
        );

        const price = Number(
          item.unit_price
        ) || 0;

        if (
          !Number.isInteger(productId) ||
          !Number.isFinite(quantity) ||
          quantity < 0
        ) {
          continue;
        }

        await connection.query(
          `INSERT INTO purchase_items(
            purchase_id,
            product_id,
            quantity,
            unit_price
          )
          VALUES($1,$2,$3,$4)`,
          [
            purchaseId,
            productId,
            quantity,
            price
          ]
        );

        const old = await connection.query(
          `SELECT quantity
           FROM stock
           WHERE product_id=$1
           FOR UPDATE`,
          [productId]
        );

        const previous = Number(
          old.rows[0]?.quantity || 0
        );

        const next =
          previous + quantity;

        await connection.query(
          `INSERT INTO stock(
            product_id,
            quantity
          )
          VALUES($1,$2)
          ON CONFLICT(product_id)
          DO UPDATE SET
            quantity=EXCLUDED.quantity,
            updated_at=NOW()`,
          [
            productId,
            next
          ]
        );

        await connection.query(
          `INSERT INTO movements(
            product_id,
            type,
            previous_quantity,
            quantity,
            new_quantity,
            note
          )
          VALUES(
            $1,
            'purchase',
            $2,
            $3,
            $4,
            $5
          )`,
          [
            productId,
            previous,
            quantity,
            next,
            `Compra recibida #${purchaseId}`
          ]
        );

        await connection.query(
          `UPDATE products
           SET
             last_price=$1,
             updated_at=NOW()
           WHERE id=$2`,
          [
            price,
            productId
          ]
        );
      }

      await connection.query("COMMIT");

      res.json({
        ok: true,
        id: purchaseId,
        total
      });
    } catch (error) {
      await connection.query("ROLLBACK");

      console.error(error);

      res.status(500).json({
        error: "No se pudo registrar la compra"
      });
    } finally {
      connection.release();
    }
  }
);
app.post("/api/products", auth, async (req, res) => {
  const b = req.body || {};

  if (!b.name || !b.category) {
    return res.status(400).json({
      error: "Nombre y categoría son obligatorios"
    });
  }

  const conversion = positiveNum(b.conversion, 1);
  const safetyStock = nonNegativeNum(b.safety_stock);
  const weeklyConsumption = nonNegativeNum(
    b.weekly_consumption
  );
  const lastPrice = nonNegativeNum(b.last_price);

  const controlType = [
    "automatic",
    "minimum",
    "manual"
  ].includes(b.control_type)
    ? b.control_type
    : "manual";

  try {
    const result = await q(
      `INSERT INTO products(
        name,
        category,
        unit,
        purchase_unit,
        conversion,
        control_type,
        safety_stock,
        weekly_consumption,
        purchase_frequency,
        supplier,
        last_price,
        active
      )
      VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      )
      RETURNING *`,
      [
        String(b.name).trim(),
        String(b.category).trim(),
        b.unit || "unidad",
        b.purchase_unit ||
          b.unit ||
          "unidad",
        conversion,
        controlType,
        safetyStock,
        weeklyConsumption,
        b.purchase_frequency ||
          "martes_jueves",
        b.supplier || null,
        lastPrice,
        b.active !== false
      ]
    );

    const product = result.rows[0];

    await q(
      `INSERT INTO stock(
        product_id,
        quantity
      )
      VALUES($1,$2)`,
      [
        product.id,
        nonNegativeNum(b.quantity)
      ]
    );

    res.json(product);
  } catch (error) {
    console.error(error);

    res.status(400).json({
      error:
        error.code === "23505"
          ? "El producto ya existe"
          : error.message
    });
  }
});

app.patch("/api/products/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      error: "Producto inválido"
    });
  }

  const fields = [
    "name",
    "category",
    "unit",
    "purchase_unit",
    "conversion",
    "control_type",
    "safety_stock",
    "weekly_consumption",
    "purchase_frequency",
    "supplier",
    "last_price",
    "active"
  ];

  const numericFields = [
    "conversion",
    "safety_stock",
    "weekly_consumption",
    "last_price"
  ];

  const allowedControls = [
    "automatic",
    "minimum",
    "manual"
  ];

  const set = [];
  const params = [];

  for (const field of fields) {
    if (
      !Object.prototype.hasOwnProperty.call(
        b,
        field
      )
    ) {
      continue;
    }

    let value = b[field];

    if (numericFields.includes(field)) {
      if (field === "conversion") {
        value = positiveNum(value, 1);
      } else {
        value = nonNegativeNum(value);
      }
    }

    if (
      field === "control_type" &&
      !allowedControls.includes(value)
    ) {
      value = "manual";
    }

    params.push(value);
    set.push(
      `${field}=$${params.length}`
    );
  }

  if (!set.length) {
    return res.json({ ok: true });
  }

  params.push(id);

  try {
    const result = await q(
      `UPDATE products
       SET
         ${set.join(",")},
         updated_at=NOW()
       WHERE id=$${params.length}
       RETURNING *`,
      params
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Producto no encontrado"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(400).json({
      error:
        error.code === "23505"
          ? "El producto ya existe"
          : error.message
    });
  }
});

app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    !req.path.startsWith("/api/")
  ) {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }

  return next();
});

init()
  .then(() => {
    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Sushitime Stock activo en puerto ${PORT}`
        );
      }
    );
  })
  .catch(error => {
    console.error(
      "ERROR INICIANDO SUSHITIME STOCK:"
    );
    console.error(error);
    process.exit(1);
  });
