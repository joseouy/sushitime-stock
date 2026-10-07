const $=id=>document.getElementById(id);
let recs=[], products=[];

async function api(url,opts={}){
  const r=await fetch(url,{headers:{"Content-Type":"application/json",...(opts.headers||{})},...opts});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||`Error ${r.status}`);
  return data;
}
async function boot(){
  try{
    const me=await api("/api/me");
    if(me.loggedIn) showApp(); else $("login").classList.remove("hidden");
  }catch(e){$("loginMsg").textContent=e.message}
}
async function login(){
  $("loginMsg").textContent="";
  try{await api("/api/login",{method:"POST",body:JSON.stringify({user:$("loginUser").value,password:$("loginPass").value})});showApp()}
  catch(e){$("loginMsg").textContent=e.message}
}
async function logout(){await api("/api/logout",{method:"POST"});location.reload()}
function showApp(){
  $("login").classList.add("hidden");$("app").classList.remove("hidden");
  $("today").textContent=new Date().toLocaleDateString("es-UY",{weekday:"short",day:"2-digit",month:"2-digit"});
  show("dashboard");loadDashboard();
}
function show(id){
  document.querySelectorAll(".view").forEach(x=>x.classList.add("hidden"));
  $(id).classList.remove("hidden");
  if(id==="dashboard")loadDashboard();
  if(id==="stock")loadStock();
  if(id==="purchases")loadPurchases();
  if(id==="movements")loadMovements();
  if(id==="config")loadConfig();
  if(id==="order")loadRecommendations();
}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}

async function loadDashboard(){
  const r=await api("/api/recommendations");recs=r.items;
  const buy=recs.filter(x=>x.status==="buy").length, review=recs.filter(x=>x.status==="review").length;
  $("dashCards").innerHTML=`<div class="metric"><span>Comprar</span><b>${buy}</b></div><div class="metric"><span>Revisar</span><b>${review}</b></div><div class="metric"><span>Próxima compra</span><b>${r.purchaseDay}</b></div>`;
}
async function loadRecommendations(){
  const r=await api("/api/recommendations");recs=r.items;
  $("purchaseInfo").textContent=`Próxima compra: ${r.purchaseDay} · cobertura estimada: ${r.daysToPurchase} días`;
  const groups={};
  recs.filter(x=>x.status!=="ok").forEach(x=>(groups[x.category]??=[]).push(x));
  $("recommendations").innerHTML=Object.keys(groups).length?Object.entries(groups).map(([cat,items])=>`
    <h3 class="group-title">${esc(cat)}</h3>${items.map((x,i)=>`
    <div class="product ${x.status}">
      <div class="row"><div><b>${esc(x.name)}</b><div class="sub">Stock: ${x.quantity} ${esc(x.unit)} · Necesidad: ${Number(x.need).toFixed(2)} · ${esc(x.reason)}</div></div>
      <input class="qty orderQty" data-id="${x.id}" data-name="${esc(x.name)}" data-unit="${esc(x.purchase_unit||x.unit)}" type="number" min="0" step="0.01" value="${x.recommended}">
      </div>
    </div>`).join("")}`).join(""):`<div class="card"><b>No hay productos para comprar.</b><p>Podés abrir Stock completo para agregar un producto manualmente.</p></div>`;
}
function chosenFromUI(){
  return [...document.querySelectorAll(".orderQty")].map(el=>({product_id:Number(el.dataset.id),name:el.dataset.name,quantity:Number(el.value)||0,unit:el.dataset.unit})).filter(x=>x.quantity>0);
}
async function saveOrder(){
  const chosen=chosenFromUI();
  const r=await api("/api/orders",{method:"POST",body:JSON.stringify({recommended:recs.filter(x=>x.recommended>0).map(x=>({product_id:x.id,name:x.name,quantity:x.recommended})),chosen})});
  alert(`Pedido guardado #${r.id}`);
}
function sendWhatsApp(){
  const chosen=chosenFromUI(); if(!chosen.length)return alert("No hay cantidades.");
  const text=["PEDIDO SUSHITIME","",...chosen.map(x=>`• ${x.name}: ${x.quantity} ${x.unit}`)].join("\n");
  window.open("https://wa.me/?text="+encodeURIComponent(text),"_blank");
}
async function loadStock(){
  products=await api("/api/products?active=true&search="+encodeURIComponent($("stockSearch")?.value||""));
  $("stockList").innerHTML=products.map(x=>`<div class="product ${Number(x.quantity)<=0?"critical":""}">
    <div class="row"><div><b>${esc(x.name)}</b><div class="sub">${esc(x.category)} · ${Number(x.quantity)} ${esc(x.unit)}</div></div>
    <button class="secondary" onclick="editStock(${x.id},${Number(x.quantity)})">Editar</button></div></div>`).join("");
}
async function editStock(id,old){
  $("modalBody").innerHTML=`<h3>Editar stock</h3><p>Anterior: <b>${old}</b></p><div class="form"><input id="newQty" type="number" min="0" step="0.01" value="${old}"><select id="reason"><option>Conteo/corrección</option><option>Consumo no registrado</option><option>Merma/desperdicio</option><option>Error de conteo anterior</option><option>Otro</option></select><button onclick="saveStock(${id})">Guardar</button></div>`;
  $("modal").classList.remove("hidden");
}
async function saveStock(id){
  await api("/api/stock/"+id,{method:"PATCH",body:JSON.stringify({quantity:Number($("newQty").value),note:$("reason").value})});
  closeModal();loadStock();
}
async function loadMovements(){
  const rows=await api("/api/movements");
  $("movementList").innerHTML=rows.map(x=>`<div class="movement"><b>${esc(x.name||"Producto")}</b> · ${esc(x.type)}<div class="sub">${x.previous_quantity??"-"} → ${x.new_quantity??"-"} · ${new Date(x.created_at).toLocaleString("es-UY")} · ${esc(x.note||"")}</div></div>`).join("");
}
async function loadPurchases(){
  const rows=await api("/api/purchases");
  $("purchaseList").innerHTML=rows.map(x=>`<div class="purchase"><div class="row"><div><b>Compra #${x.id}</b><div class="sub">${esc(x.supplier||"Sin proveedor")} · ${new Date(x.purchase_date).toLocaleDateString("es-UY")} · $${Number(x.total).toFixed(2)}</div></div>${x.receipt_mime?`<a target="_blank" href="/api/purchases/${x.id}/receipt">Boleta</a>`:""}</div></div>`).join("")||"<p>No hay compras recibidas.</p>";
}
async function openPurchaseForm(){
  products=await api("/api/products?active=true");
  $("modalBody").innerHTML=`<h3>Registrar compra recibida</h3><div class="form"><input id="supplier" placeholder="Proveedor"><input id="receipt" type="file" accept="image/jpeg,image/png,image/webp"><div id="purchaseRows">${products.slice(0,12).map(x=>`<div class="grid"><span>${esc(x.name)}</span><input class="recv" data-id="${x.id}" placeholder="cantidad recibida" type="number" min="0" step="0.01"><input class="price" data-id="${x.id}" placeholder="precio" type="number" min="0" step="0.01"></div>`).join("")}</div><button onclick="savePurchase()">Confirmar recepción</button></div>`;
  $("modal").classList.remove("hidden");
}
async function savePurchase(){
  const items=[...document.querySelectorAll(".recv")].map((el,i)=>({product_id:Number(el.dataset.id),quantity:Number(el.value)||0,unit_price:Number(document.querySelectorAll(".price")[i].value)||0})).filter(x=>x.quantity>0);
  if(!items.length)return alert("Ingresá al menos una cantidad recibida.");
  const fd=new FormData();fd.append("supplier",$("supplier").value);fd.append("items",JSON.stringify(items));if($("receipt").files[0])fd.append("receipt",$("receipt").files[0]);
  const r=await fetch("/api/purchases",{method:"POST",body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||"Error");
  closeModal();loadPurchases();alert(`Compra #${d.id} recibida. El stock se actualizó con lo efectivamente recibido.`);
}
async function loadConfig(){
  const all=await api("/api/products?active=all");
  $("configList").innerHTML=all.map(x=>`<div class="product"><div class="row"><div><b>${esc(x.name)}</b><div class="sub">${esc(x.category)} · ${esc(x.control_type)} · presentación ${x.conversion} ${esc(x.purchase_unit)}</div></div><button class="secondary" onclick="editProduct(${x.id})">Editar</button></div></div>`).join("");
}
async function editProduct(id){
  const x=products.find(p=>p.id===id)|| (await api("/api/products?active=all")).find(p=>p.id===id);
  $("modalBody").innerHTML=`<h3>Configurar ${esc(x.name)}</h3><div class="form">
  <label>Nombre<input id="pn" value="${esc(x.name)}"></label><label>Categoría<input id="pc" value="${esc(x.category)}"></label>
  <div class="grid"><label>Unidad<input id="pu" value="${esc(x.unit)}"></label><label>Unidad compra<input id="ppu" value="${esc(x.purchase_unit)}"></label></div>
  <div class="grid"><label>Conversión/presentación<input id="pconv" type="number" step="0.01" value="${x.conversion}"></label><label>Stock seguridad<input id="psafe" type="number" step="0.01" value="${x.safety_stock}"></label></div>
  <div class="grid"><label>Consumo semanal<input id="pweek" type="number" step="0.01" value="${x.weekly_consumption}"></label><label>Control<select id="pcontrol"><option value="automatic">Automático</option><option value="minimum">Mínimo</option><option value="manual">Manual</option></select></label></div>
  <label>Proveedor<input id="psupplier" value="${esc(x.supplier||"")}"></label><button onclick="saveProduct(${id})">Guardar</button></div>`;
  $("pcontrol").value=x.control_type;$("modal").classList.remove("hidden");
}
async function saveProduct(id){
  await api("/api/products/"+id,{method:"PATCH",body:JSON.stringify({name:$("pn").value,category:$("pc").value,unit:$("pu").value,purchase_unit:$("ppu").value,conversion:Number($("pconv").value),safety_stock:Number($("psafe").value),weekly_consumption:Number($("pweek").value),control_type:$("pcontrol").value,supplier:$("psupplier").value})});
  closeModal();loadConfig();
}
function openNewProduct(){
 $("modalBody").innerHTML=`<h3>Nuevo producto</h3><div class="form">
 <input id="nn" placeholder="Nombre"><input id="nc" placeholder="Categoría">
 <div class="grid"><input id="nu" placeholder="Unidad" value="unidad"><input id="npu" placeholder="Unidad compra" value="unidad"></div>
 <div class="grid"><input id="nconv" type="number" value="1" min="0.01" step="0.01"><input id="nqty" type="number" value="0" min="0" step="0.01"></div>
 <button onclick="createProduct()">Crear</button></div>`;$("modal").classList.remove("hidden");
}
async function createProduct(){
 await api("/api/products",{method:"POST",body:JSON.stringify({name:$("nn").value,category:$("nc").value,unit:$("nu").value,purchase_unit:$("npu").value,conversion:Number($("nconv").value),quantity:Number($("nqty").value),control_type:"manual"})});
 closeModal();loadConfig();
}
function closeModal(){$("modal").classList.add("hidden")}
boot();
