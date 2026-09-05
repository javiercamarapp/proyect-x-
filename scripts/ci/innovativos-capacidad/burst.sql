\set tenant random(1,5)
\set operator random(1,800)
begin;
insert into public.comprobante_huerfano(tenant_id,operador_id,ruta_imagen,gasto,motivo)
values(md5('innovativos-cap-tenant-'||:tenant)::uuid,md5('innovativos-cap-op-'||:tenant||'-'||:operator)::uuid,
'synthetic://metadata-only/'||gen_random_uuid()||'.jpg',jsonb_build_object('harness','innovativos-cap-burst','imgHash',gen_random_uuid()::text,'monto',123.45,'synthetic',true),'fallo_ocr');
select id,concepto,monto,fecha,folio,rfc_emisor,cfdi_uuid,estado_sat,ocr_confianza,efos,xml_verificado,imagen_url
from public.gasto where tenant_id=md5('innovativos-cap-tenant-'||:tenant)::uuid order by created_at desc limit 100;
commit;
