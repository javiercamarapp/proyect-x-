\set tenant random(1,5)
\set doc random(1,26250)
begin;
select id,concepto,monto,fecha,folio,rfc_emisor,cfdi_uuid,estado_sat,ocr_confianza,efos,xml_verificado,imagen_url
from public.gasto where tenant_id=md5('innovativos-cap-tenant-'||:tenant)::uuid order by created_at desc limit 100;
select viaje_id,monto from public.gasto where tenant_id=md5('innovativos-cap-tenant-'||:tenant)::uuid and img_hash=md5('innovativos-cap-img-'||:tenant||'-'||:doc) limit 1;
commit;
