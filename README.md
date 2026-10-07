# Sushitime Stock v2

MVP web/PWA para stock y compras.

## Variables de Render
- `DATABASE_URL`
- `ADMIN_USER`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`

## Arranque
`npm install`
`npm start`

## Importante
- Las tablas se crean automáticamente.
- El catálogo inicial se inserta solo cuando el producto no existe; no pisa la configuración posterior.
- El stock inicial se inserta solo si todavía no existe stock para ese producto.
- Las boletas se guardan en PostgreSQL como imagen, no en el disco local de Render.
- El fallback de frontend usa `app.use()` para evitar el error de wildcard de Express/path-to-regexp.
