-- 0352 — FIS-M3 (auditoría 28): `factura_emitida` no podía representar la
-- retención del 4% de IVA (frecuente cuando el cliente es una persona moral
-- que retiene al transportista persona física). `factura_total_cuadra`
-- exigía `total = subtotal + iva` exacto, sin espacio para descontar una
-- retención. `retencion_iva numeric not null default 0` es compatible con
-- todas las filas existentes (retención implícita de $0, total sin cambio).
begin;

alter table public.factura_emitida
  add column retencion_iva numeric not null default 0;

alter table public.factura_emitida drop constraint factura_total_cuadra;
alter table public.factura_emitida
  add constraint factura_total_cuadra
  check (abs(total - (subtotal + iva - retencion_iva)) <= 0.01);

alter table public.factura_emitida drop constraint factura_importes_positivos;
alter table public.factura_emitida
  add constraint factura_importes_positivos
  check (subtotal >= 0 and iva >= 0 and total >= 0 and retencion_iva >= 0);

comment on column public.factura_emitida.retencion_iva is
  '0352 (FIS-M3): retención de IVA (comúnmente 4%, LISR/LIVA retención por servicios). $0 por defecto — sin cambio de comportamiento para facturas existentes. facturacion_escritura.ts la captura como opcional; ningún formulario la teclea todavía.';

commit;
