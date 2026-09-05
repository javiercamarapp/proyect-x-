#!/usr/bin/env bash
# Dos publicadores reales compiten por la misma firma. Sólo uno cambia el puntero.
# Exclusivo PostgreSQL desechable; UUIDs y objetos sintéticos propios.
set -euo pipefail
host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
tenant='34600000-0000-4000-8000-000000000101'
viaje='34600000-0000-4000-8000-000000000105'
psql_cmd=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
work="$(mktemp -d)"
pid_a=''; pid_b=''
limpiar() {
  for pid in "$pid_a" "$pid_b"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  "${psql_cmd[@]}" -c "delete from storage.objects where bucket_id='liquidaciones' and name like '$tenant/%'; delete from public.tenant where id='$tenant';" >/dev/null
  rm -rf "$work"
}
[[ "$("${psql_cmd[@]}" -c "select count(*) from public.tenant where id='$tenant';")" = 0 ]] || { echo 'Fixture346 ya existe; no tocar datos ajenos.'; exit 1; }
trap limpiar EXIT
"${psql_cmd[@]}" <<SQL
insert into public.tenant(id,nombre) values('$tenant','PDF346 carrera sintética');
insert into public.app_user(id,tenant_id,email,rol) values('34600000-0000-4000-8000-000000000103','$tenant','pdf346race@example.invalid','flota_admin');
insert into public.operador(id,tenant_id,nombre,telefono) values('34600000-0000-4000-8000-000000000104','$tenant','PDF race','529999903462');
insert into public.viaje(id,tenant_id,operador_id,folio,anticipo) values('$viaje','$tenant','34600000-0000-4000-8000-000000000104','PDF346-R',5000);
insert into public.gasto(id,tenant_id,viaje_id,concepto,monto) values('34600000-0000-4000-8000-000000000106','$tenant','$viaje','diesel',800);
select public.guardar_liquidacion_tx('$tenant','$viaje',800,5000,4200,'revisar','[]',0,0,0,null,0);
select public.revisar_liquidacion('$tenant',(select id from public.liquidacion where viaje_id='$viaje'),'ajustar','prueba', '[{"gastoId":"34600000-0000-4000-8000-000000000106","montoNuevo":8000}]','34600000-0000-4000-8000-000000000103',null,'{"totalComprobado":8000,"diferencia":-3000,"estatus":"con_diferencias","diferencias":[],"iepsAcreditable":0,"litrosDieselAcreditables":0,"ivaAcreditable":0,"peajeAcreditable":0}');
insert into storage.buckets(id,name,public) values('liquidaciones','liquidaciones',false) on conflict(id) do nothing;
insert into storage.objects(bucket_id,name) select 'liquidaciones','$tenant/$viaje-version-34600000-0000-4000-8000-00000000010'||n||suffix from generate_series(7,8) n cross join unnest(array['.pdf','-operador.pdf']) suffix;
SQL
cifras='{"totalComprobado":8000,"totalAnticipo":5000,"diferencia":-3000,"estatus":"con_diferencias","diferencias":[],"iepsAcreditable":0,"litrosDieselAcreditables":0,"ivaAcreditable":0,"peajeAcreditable":0}'
publicar="select public.publicar_pdf_liquidacion('$tenant',id,'$viaje','ajustada',revisada_en,null,"
"${psql_cmd[@]}" -c "set application_name='pdf346-a'; begin; $publicar '$tenant/$viaje-version-34600000-0000-4000-8000-000000000107.pdf','$cifras') from public.liquidacion where viaje_id='$viaje'; select pg_sleep(2); commit;" >"$work/a" &
pid_a=$!
for _ in {1..30}; do
  [[ "$("${psql_cmd[@]}" -c "select count(*) from pg_stat_activity where application_name='pdf346-a' and wait_event='PgSleep';")" = 1 ]] && break
  sleep 0.05
done
"${psql_cmd[@]}" -c "set application_name='pdf346-b'; $publicar '$tenant/$viaje-version-34600000-0000-4000-8000-000000000108.pdf','$cifras') from public.liquidacion where viaje_id='$viaje';" >"$work/b" &
pid_b=$!
locked=0
for _ in {1..20}; do
  if [[ "$("${psql_cmd[@]}" -c "select count(*) from pg_stat_activity where application_name='pdf346-b' and wait_event_type='Lock';")" = 1 ]]; then locked=1; break; fi
  sleep 0.05
done
wait "$pid_a"; pid_a=''; wait "$pid_b"; pid_b=''
[[ "$locked" = 1 ]]
[[ "$(tr -d '\n' < "$work/a")" = t ]]
[[ "$(tr -d '\n' < "$work/b")" = f ]]
[[ "$("${psql_cmd[@]}" -c "select count(*) from public.liquidacion where viaje_id='$viaje' and pdf_url='$tenant/$viaje-version-34600000-0000-4000-8000-000000000107.pdf' and revision='ajustada' and revisada_por='34600000-0000-4000-8000-000000000103' and total_comprobado=8000;")" = 1 ]]
echo '0346_pdf_publicacion_concurrencia PASS: B esperó lock; A=t B=f; firma y dinero intactos.'
