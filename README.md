# Sushitime Stock

Sistema web interno para controlar stock y preparar pedidos de compra con supervisión humana.

## Arquitectura
- Node.js + Express
- PostgreSQL
- HTML/CSS/JS sin framework pesado
- Preparado para GitHub + Render
- Responsive para PC y celular

## Deploy en Render
1. Crear un repositorio en GitHub y subir este proyecto.
2. En Render crear una base PostgreSQL y copiar su `Internal Database URL` en `DATABASE_URL` del servicio web.
3. Crear el Web Service conectado al repositorio.
4. Variables:
   - `ADMIN_USER=admin`
   - `ADMIN_PASSWORD=stadmin00` (recomendado cambiarla después del primer acceso)
   - `SESSION_SECRET` (Render puede generarla automáticamente)
5. Deploy.

## Nota
El sistema no descuenta stock automáticamente por ventas. El stock se actualiza mediante movimientos confirmados.
La recomendación de compra es editable y nunca se envía automáticamente.

## MVP incluido
- Login
- Dashboard limpio
- Stock editable y buscable
- Pedido recomendado por martes/jueves
- Prioridades crítico/comprar/revisar
- Edición manual del pedido
- Enlace a WhatsApp con el pedido
- Registro de recomendado vs elegido
- Recepción de mercadería
- Foto de boleta/factura guardada en la compra
- Compras recibidas e historial
- Movimientos
- Configuración de productos
- Alta/baja lógica de productos
- Productos iniciales y stock inicial cargados
