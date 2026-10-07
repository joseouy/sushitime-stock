const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-only-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 } }));
app.use(express.static(path.join(__dirname, 'public')));

const adminUser = process.env.ADMIN_USER || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'stadmin00';

async function q(text, params=[]) { return pool.query(text, params); }
async function init(){
  await q(`CREATE TABLE IF NOT EXISTS products(
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'unidad',
    purchase_unit TEXT NOT NULL DEFAULT 'unidad', conversion NUMERIC NOT NULL DEFAULT 1,
    control_type TEXT NOT NULL DEFAULT 'manual', safety_stock NUMERIC NOT NULL DEFAULT 0,
    weekly_consumption NUMERIC, purchase_frequency TEXT NOT NULL DEFAULT 'martes_jueves', supplier TEXT,
    last_price NUMERIC, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS stock(id SERIAL PRIMARY KEY, product_id INTEGER UNIQUE REFERENCES products(id) ON DELETE CASCADE,
    quantity NUMERIC NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS movements(id SERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id), type TEXT NOT NULL,
    quantity NUMERIC NOT NULL, previous_qty NUMERIC NOT NULL, new_qty NUMERIC NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS orders(id SERIAL PRIMARY KEY, purchase_day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    recommended JSONB NOT NULL, chosen JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS purchases(id SERIAL PRIMARY KEY, supplier TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    items JSONB NOT NULL, receipt_name TEXT, receipt_mime TEXT, receipt_data BYTEA);
  CREATE INDEX IF NOT EXISTS movements_product_idx ON movements(product_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS purchases_date_idx ON purchases(received_at DESC);`);
  const count = await q('SELECT COUNT(*)::int AS n FROM products');
  if(count.rows[0].n===0) await seed();
}

const seedProducts = [
  ['Arroz','Insumos','kg','funda',25,'automatico',25,'martes_jueves'],
  ['Azúcar','Insumos','kg','kg',1,'automatico',5, 'martes_jueves',29],
  ['Vinagre','Insumos','L','L',1,'automatico',5,'martes_jueves',20],
  ['Algas Nori','Insumos','paquete','paquete',1,'manual',0,'martes_jueves'],
  ['Salsa de soja','Insumos','kg','bidón',10,'manual',0,'martes_jueves'],
  ['Wasabi','Insumos','kg','paquete',1,'manual',0,'martes_jueves'],
  ['Jengibre','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Panko','Insumos','kg','bolsa',10,'manual',0,'martes_jueves'],
  ['Pan rallado','Insumos','kg','bolsa',1,'manual',0,'martes_jueves'],
  ['Harina','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Sésamo','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Castañas de cajú','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Tabasco','Insumos','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Mayonesa','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Barbacoa','Insumos','kg','bolsa',6.5,'manual',0,'martes_jueves'],
  ['Sal','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Aceite girasol','Insumos','L','L',1,'manual',0,'martes_jueves'],
  ['Aceite fritador','Insumos','L','bidón',5,'manual',0,'martes_jueves'],
  ['Tomates secos','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Queso crema','Insumos','kg','unidad',2,'manual',0,'martes_jueves'],
  ['Queso cheddar','Insumos','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Arrolladitos','Insumos','kg','paquete',1,'manual',0,'martes_jueves'],
  ['Miel','Insumos','kg','kg',1,'manual',0,'martes_jueves'],
  ['Papel film','Insumos','m','rollo',1000,'manual',0,'martes_jueves'],
  ['Separadores','Insumos','unidad','paquete',1,'manual',0,'martes_jueves'],
  ['Esterillas','Insumos','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Palitos brochette','Insumos','unidad','paquete',1,'manual',0,'martes_jueves'],
  ['Papel higiénico','Limpieza','unidad','rollo',1,'manual',0,'martes_jueves'],
  ['Papel absorbente','Limpieza','unidad','rollo',1,'manual',0,'martes_jueves'],
  ['Detergente','Limpieza','L','bidón',10,'manual',0,'martes_jueves'],
  ['Hipoclorito','Limpieza','L','bidón',10,'manual',0,'martes_jueves'],
  ['Limpiador piso','Limpieza','L','bidón',10,'manual',0,'martes_jueves'],
  ['Limpiador vidrio','Limpieza','L','L',1,'manual',0,'martes_jueves'],
  ['Esponjas','Limpieza','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Esponjas aluminio','Limpieza','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Bolsas residuos','Limpieza','unidad','paquete',1,'manual',0,'martes_jueves'],
  ['Desengrasante','Limpieza','ml','unidad',450,'manual',0,'martes_jueves'],
  ['Repasadores','Limpieza','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Trapos piso','Limpieza','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Palta','Frutas y verduras','caja','caja',1,'manual',0,'martes_jueves'],
  ['Rúcula','Frutas y verduras','paquete','paquete',1,'manual',0,'martes_jueves'],
  ['Ciboulette','Frutas y verduras','paquete','paquete',1,'manual',0,'martes_jueves'],
  ['Cilantro','Frutas y verduras','paquete','paquete',1,'manual',0,'martes_jueves'],
  ['Cebolla','Frutas y verduras','kg','kg',1,'manual',0,'martes_jueves'],
  ['Pepino','Frutas y verduras','kg','kg',1,'manual',0,'martes_jueves'],
  ['Lima','Frutas y verduras','kg','kg',1,'manual',0,'martes_jueves'],
  ['Mango','Frutas y verduras','unidad','unidad',1,'manual',0,'martes_jueves'],
  ['Maracuyá','Frutas y verduras','kg','kg',1,'manual',0,'martes_jueves'],
  ['Huevos','Frutas y verduras','maple','maple',1,'manual',0,'martes_jueves'],
  ['Salmón fresco','Pescados y mariscos','kg','caja',19.13,'manual',25,'martes_jueves'],
  ['Salmón ahumado','Pescados y mariscos','kg','bolsa',1,'manual',0,'martes_jueves'],
  ['Pescado blanco','Pescados y mariscos','filete','filete',1,'manual',0,'martes_jueves'],
  ['Langostino nigiri cocido','Pescados y mariscos','caja','caja',1,'manual',0,'martes_jueves'],
  ['Atún rojo','kg','kg','pack',0.5,'manual',0,'martes_jueves'],
  ['Langostinos','kg','bolsa',1,'manual',0,'martes_jueves'],
  ['Rabas','kg','kg',1,'manual',0,'martes_jueves']
];

async function seed(){
  const client=await pool.connect();
  try{await client.query('BEGIN');
    for(const p of seedProducts){
      let [name,cat,unit,punit,conv,control,safety,freq,weekly] = p;
      if(name==='Atún rojo'){cat='Pescados y mariscos';}
      if(name==='Langostinos'){cat='Pescados y mariscos';}
      if(name==='Rabas'){cat='Pescados y mariscos';}
      const r=await client.query(`INSERT INTO products(name,category,unit,purchase_unit,conversion,control_type,safety_stock,purchase_frequency,weekly_consumption) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[name,cat,unit,punit,conv,control,safety,freq,weekly||null]);
      await client.query('INSERT INTO stock(product_id,quantity) VALUES($1,0)',[r.rows[0].id]);
    }
    const stocks={
      'Arroz':30,'Azúcar':21,'Vinagre':7,'Algas Nori':3,'Salsa de soja':20,'Wasabi':3,'Jengibre':1,'Panko':15,'Pan rallado':1,'Harina':0,'Sésamo':1.5,'Castañas de cajú':1.25,'Tabasco':1,'Mayonesa':0,'Barbacoa':3.25,'Aceite girasol':0,'Aceite fritador':20,'Tomates secos':0.2,'Queso crema':24,'Queso cheddar':2.5,'Arrolladitos':2.4,'Miel':0.5,'Papel film':1200,'Papel higiénico':11,'Papel absorbente':2.5,'Detergente':5,'Hipoclorito':3.5,'Limpiador piso':5,'Limpiador vidrio':0,'Esponjas':5,'Esponjas aluminio':0,'Bolsas residuos':1,'Desengrasante':450,'Repasadores':7,'Trapos piso':3,'Palta':1.5,'Rúcula':15,'Ciboulette':10,'Cilantro':2,'Cebolla':3,'Pepino':0,'Lima':3,'Mango':17,'Maracuyá':0.5,'Huevos':7,'Salmón fresco':19.13,'Salmón ahumado':8.5,'Pescado blanco':8,'Langostino nigiri cocido':1,'Atún rojo':7,'Langostinos':17.5,'Rabas':1.5
    };
    for(const [name,qty] of Object.entries(stocks)) await client.query('UPDATE stock SET quantity=$1,updated_at=NOW() WHERE product_id=(SELECT id FROM products WHERE name=$2)',[qty,name]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK'); throw e;} finally{client.release();}
}

function auth(req,res,next){if(req.session.user) return next(); return res.status(401).json({error:'No autenticado'});}
function purchaseDay(){ const d=new Date().getDay(); return d<=2?'martes':'jueves'; }

app.get('/api/me',(req,res)=>res.json({loggedIn:!!req.session.user,user:req.session.user||null}));
app.post('/api/login',(req,res)=>{const {user,password}=req.body||{}; if(user===adminUser&&password===adminPassword){req.session.user={user,role:'admin'}; return res.json({ok:true});} res.status(401).json({error:'Usuario o contraseña incorrectos'});});
app.post('/api/logout',auth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/products',auth,async(req,res)=>{const {category,search,active='all'}=req.query; let sql=`SELECT p.*,s.quantity,s.updated_at stock_updated_at FROM products p JOIN stock s ON s.product_id=p.id WHERE 1=1`; const params=[]; if(category){params.push(category);sql+=` AND p.category=$${params.length}`;} if(search){params.push('%'+search+'%');sql+=` AND p.name ILIKE $${params.length}`;} if(active!=='all'){params.push(active==='true');sql+=` AND p.active=$${params.length}`;} sql+=' ORDER BY p.category,p.name'; res.json((await q(sql,params)).rows);});
app.get('/api/categories',auth,async(req,res)=>res.json((await q('SELECT DISTINCT category FROM products ORDER BY category')).rows.map(x=>x.category)));
app.patch('/api/products/:id',auth,async(req,res)=>{const id=Number(req.params.id), b=req.body; const allowed=['name','category','unit','purchase_unit','conversion','control_type','safety_stock','weekly_consumption','purchase_frequency','supplier','last_price','active']; const fields=[],vals=[]; for(const k of allowed) if(b[k]!==undefined){fields.push(`${k}=$${vals.length+1}`);vals.push(b[k]);} if(!fields.length)return res.json({ok:true}); vals.push(id); await q(`UPDATE products SET ${fields.join(',')} WHERE id=$${vals.length}`,vals); res.json({ok:true});});
app.post('/api/products',auth,async(req,res)=>{const b=req.body;if(!b.name||!b.category)return res.status(400).json({error:'Nombre y categoría son obligatorios'});const r=await q(`INSERT INTO products(name,category,unit,purchase_unit,conversion,control_type,safety_stock,weekly_consumption,purchase_frequency,supplier,last_price,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) RETURNING id`,[b.name,b.category,b.unit||'unidad',b.purchase_unit||'unidad',b.conversion||1,b.control_type||'manual',b.safety_stock||0,b.weekly_consumption||null,b.purchase_frequency||'martes_jueves',b.supplier||null,b.last_price||null]);await q('INSERT INTO stock(product_id,quantity) VALUES($1,0)',[r.rows[0].id]);res.json(r.rows[0]);});

app.patch('/api/stock/:id',auth,async(req,res)=>{const id=Number(req.params.id), qty=Number(req.body.quantity); if(!Number.isFinite(qty)||qty<0)return res.status(400).json({error:'Cantidad inválida'});const s=await q('SELECT quantity FROM stock WHERE product_id=$1',[id]);if(!s.rows[0])return res.status(404).json({error:'Producto no encontrado'});const old=Number(s.rows[0].quantity);const reason=req.body.reason||'Corrección manual';await q('UPDATE stock SET quantity=$1,updated_at=NOW() WHERE product_id=$2',[qty,id]);await q('INSERT INTO movements(product_id,type,quantity,previous_qty,new_qty,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,'correccion',qty-old,old,qty,reason]);res.json({ok:true,old,new:qty});});

app.get('/api/movements',auth,async(req,res)=>res.json((await q(`SELECT m.*,p.name FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC LIMIT 100`)).rows));

function recommendation(p,qty){
  if(p.control_type==='manual') return null;
  const weekly=Number(p.weekly_consumption||0); if(!weekly) return null;
  const day=purchase_frequency==='martes_jueves' ? purchaseDay() : purchaseDay();
  const days=day==='martes'?2:4;
  const need=weekly*(days/7); const target=Math.max(0,Number(p.safety_stock||0)); const raw=Math.max(0,need+target-qty); const conv=Math.max(Number(p.conversion||1),0.0001); const buy=Math.ceil(raw/conv)*conv; const after=qty+buy; let priority='revisar'; if(buy>0){priority=qty<need?'critico':'comprar';} else if(qty<target) priority='revisar'; else return null;
  return {id:p.id,name:p.name,category:p.category,stock:qty,need,target,raw,buy,after,conversion:conv,purchase_unit:p.purchase_unit,priority,reason:`Stock ${qty} + necesidad estimada ${need.toFixed(2)} + seguridad ${target} → comprar ${buy.toFixed(2)} ${p.unit}.`};
}
app.get('/api/recommendations',auth,async(req,res)=>{const rows=(await q(`SELECT p.*,s.quantity FROM products p JOIN stock s ON s.product_id=p.id WHERE p.active=true ORDER BY p.category,p.name`)).rows;res.json(rows.map(r=>recommendation(r,Number(r.quantity))).filter(Boolean));});
app.post('/api/orders',auth,async(req,res)=>{const b=req.body;const rec=b.recommended||[];const chosen=b.chosen||[];const r=await q('INSERT INTO orders(purchase_day,status,recommended,chosen) VALUES($1,$2,$3,$4) RETURNING id',[purchaseDay(),'realizado',JSON.stringify(rec),JSON.stringify(chosen)]);res.json({id:r.rows[0].id});});
app.get('/api/purchases',auth,async(req,res)=>res.json((await q('SELECT id,supplier,received_at,items,receipt_name,receipt_mime FROM purchases ORDER BY received_at DESC LIMIT 50')).rows));
app.get('/api/purchases/:id/receipt',auth,async(req,res)=>{const r=await q('SELECT receipt_mime,receipt_data FROM purchases WHERE id=$1',[req.params.id]);if(!r.rows[0]||!r.rows[0].receipt_data)return res.status(404).end();res.set('Content-Type',r.rows[0].receipt_mime||'application/octet-stream');res.send(r.rows[0].receipt_data);});
app.post('/api/purchases',auth,upload.single('receipt'),async(req,res)=>{let items=[];try{items=JSON.parse(req.body.items||'[]')}catch{};const client=await pool.connect();try{await client.query('BEGIN');const r=await client.query('INSERT INTO purchases(supplier,items,receipt_name,receipt_mime,receipt_data) VALUES($1,$2,$3,$4,$5) RETURNING id',[req.body.supplier||null,JSON.stringify(items),req.file?.originalname||null,req.file?.mimetype||null,req.file?.buffer||null]);for(const it of items){const pid=Number(it.product_id),qty=Number(it.received||0);if(!pid||qty<=0)continue;const s=await client.query('SELECT quantity FROM stock WHERE product_id=$1 FOR UPDATE',[pid]);const old=Number(s.rows[0]?.quantity||0),nw=old+qty;await client.query('UPDATE stock SET quantity=$1,updated_at=NOW() WHERE product_id=$2',[nw,pid]);await client.query('INSERT INTO movements(product_id,type,quantity,previous_qty,new_qty,reason) VALUES($1,$2,$3,$4,$5,$6)',[pid,'compra',qty,old,nw,'Mercadería recibida']);}await client.query('COMMIT');res.json({ok:true,id:r.rows[0].id});}catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}finally{client.release();}});

app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));init().then(()=>app.listen(process.env.PORT||10000)).catch(e=>{console.error(e);process.exit(1)});
