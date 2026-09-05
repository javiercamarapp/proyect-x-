-- Sólo cambia el texto predeterminado para NUEVAS resoluciones. No reescribe
-- historia ni modifica supresión, retención, SECURITY, search_path o permisos.
-- pg_get_functiondef conserva la definición vigente (incluido el arreglo0275).
do $migracion$
declare
  definicion text;
  anterior constant text := 'Cancelación ejecutada: datos personales anonimizados, incluido el texto libre que el titular escribió por el chat. La documentación fiscal se conserva por el art. 30 del CFF y queda desligada del titular.';
  nuevo constant text := 'Se sustituyeron el nombre y el teléfono del registro operativo y se eliminaron sus conversaciones. Se conservan el identificador del operador, el correo de la cuenta, la referencia del titular en la solicitud y la documentación fiscal. Requieren revisión de privacidad para determinar los pasos pendientes.';
  ocurrencias_anterior integer;
  ocurrencias_nuevo integer;
begin
  select pg_get_functiondef('public.ejecutar_arco_cancelacion(uuid,uuid)'::regprocedure) into definicion;
  ocurrencias_anterior := (length(definicion) - length(replace(definicion, anterior, ''))) / length(anterior);
  ocurrencias_nuevo := (length(definicion) - length(replace(definicion, nuevo, ''))) / length(nuevo);
  if ocurrencias_anterior = 1 and ocurrencias_nuevo = 0 then
    execute replace(definicion, anterior, nuevo);
  elsif ocurrencias_anterior = 0 and ocurrencias_nuevo = 1 then
    null; -- Reaplicación: no redefine ni vuelve a tocar datos.
  else
    raise exception '0340: resolución predeterminada inesperada; revisar la definición vigente antes de migrar';
  end if;
end
$migracion$;

comment on function public.ejecutar_arco_cancelacion(uuid, uuid) is
  'Ejecuta la operación configurada para cancelación ARCO: sustituye nombre y teléfono del registro operativo, retira RFC/licencia y textos de incidencias, y elimina conversaciones/envíos. Conserva el UUID del operador, el correo de app_user, la referencia del titular en solicitud_arco y documentación fiscal, que requieren revisión de privacidad para determinar los pasos pendientes. No acredita anonimización total. 0340 corrige sólo el texto predeterminado de nuevas resoluciones; no modifica datos históricos ni las operaciones de conservación o supresión.';
