\set tenant random(1,5)
\set operator random(1,800)
begin;
insert into public.comprobante_huerfano(tenant_id,operador_id,ruta_imagen,gasto,motivo)
values(md5('innovativos-cap-tenant-'||:tenant)::uuid,md5('innovativos-cap-op-'||:tenant||'-'||:operator)::uuid,
'synthetic://metadata-only/'||gen_random_uuid()||'.jpg',jsonb_build_object('harness','innovativos-cap-soak','imgHash',gen_random_uuid()::text,'monto',123.45,'synthetic',true),'fallo_ocr');
commit;
