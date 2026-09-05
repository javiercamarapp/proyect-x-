\set tenant random(1,5)
\set doc random(1,26250)
begin;
update public.gasto set imagen_url='synthetic://metadata-only/refreshed/'||id||'.jpg'
where tenant_id=md5('innovativos-cap-tenant-'||:tenant)::uuid and id=md5('innovativos-cap-doc-'||:tenant||'-'||:doc)::uuid;
commit;
