-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICACIONES DE CONCURRENCIA — lo que solo la base puede demostrar.
--
-- Estas garantías no viven en TypeScript: viven en índices únicos, en cláusulas
-- WHERE de un UPDATE y en un ON CONFLICT. Un test con Supabase mockeado no las
-- prueba, prueba el mock.
--
-- Cada bloque termina lanzando una excepción A PROPÓSITO: el DO corre en su
-- propia transacción, así que la excepción revierte todo y no queda un solo
-- registro de prueba. El resultado se lee en el mensaje de error.
--
-- CÓMO CORRERLO: pegar un bloque en el SQL editor de Supabase. Es seguro contra
-- producción — no deja nada — pero conviene correrlo de uno en uno.
--
-- Última corrida: **31-jul-2026**, contra el proyecto Likida. Los bloques 13 a 17
-- se escribieron ese día y se corrieron en cuanto se aplicaron la 0031, la 0032 y
-- la 0033. Salida REAL, copiada tal cual:
--
--   13  ve-el-que-falta=t  calla-el-que-existe=t  vacio-no-es-null=t
--   14  nunca-negativo=0  viaje-inexistente=0  huerfano-cuenta=1
--       sondeo-lo-olvida=0  sella-al-incrementar=t  reciente-sobrevive=1
--   16  rls-en-wa_mensaje=t  anon-intake=f  anon-lock=f  anon-unlock=f
--       service-role-intake=t
--   17  gana-1a=t  2do-camino-rebota=f  reenvio-por-version=t
--       CONSTANCIA-INTACTA=t  version-intacta=v1  reserva-suelta=t
--       solto=t  solto-2a-vez=f  reserva-expira=t
--
-- Y el BARRIDO DE PRODUCCIÓN del 31-jul, bloque 18 contra la base real:
--
--   18  tablas-sin-rls=—  politicas-que-dicen-true=—  rpc-abiertas-a-anon=—
--   19  entra-antes=t  rebota-despues=f  sqlstate=CU001  liquidado-sin-liq=t
--
-- Además se atacó la API REST como anónimo con la llave publicable: 14 tablas
-- leídas → 0 filas, y CINCO escrituras rechazadas (envenenar la idempotencia,
-- inventar un gasto, soltar el mutex de un viaje ajeno, mover el contador de la
-- barrera, marcar una constancia de aviso falsa). Todas con 42501.
--
-- Y el bloque 8 (0027) el mismo día, en cuanto se aplicó su migración:
--
--    8  repetido-entre-viajes-rebotado=t  sin-hash-que-entraron=2
--       msg=duplicate key value violates unique constraint "uq_gasto_img_hash"
--
-- Los cinco dieron exactamente lo esperado. El 17 es el que importa: la
-- constancia del art. 16 de un aviso v1 SOBREVIVE al reenvío fallido de un v2 —
-- que es justo lo que la implementación vieja destruía. Y el 14 confirma contra
-- Postgres, no contra un mock, que el contador huérfano se olvida en el SONDEO.
--
-- Comprobado además que los bloques no dejan basura: después de correrlos había
-- 0 tenants `ZZZ VERIF%`, 0 contadores vivos, 0 reservas de aviso abiertas, y la
-- única constancia real —la del 28-jul— intacta.
--
-- Los cuatro primeros pasaron el 28-jul. Los bloques 5 a 11 son de la auditoría 5
-- y comprueban las migraciones 0022 y 0024–0029.
--
-- ESTADO DE LAS MIGRACIONES QUE COMPRUEBAN (31-jul-2026): **TODAS APLICADAS.**
-- Por primera vez desde que existe este archivo no hay ninguna esperando.
--   · 0022, 0024, 0025, 0026, 0028 y 0029 → APLICADAS. Sus bloques (5, 6, 7,
--     9, 10, 11) tienen que dar los valores esperados; si alguno reporta `f`,
--     la base se ha ido del repo y hay que leerlo como una alarma, no como
--     "todavía no toca".
--   · 0027 (una foto = un gasto por flota) → APLICADA el 31-jul, con Javier
--     decidiendo sobre la lista del bloque 12, que daba UN grupo:
--
--       tenant 11111111-… · hash 250a4e5b34ec… · 2 gastos en 2 viajes · $398.00
--         823be0 (viaje 0000ff, $199.00, 28-Jul 21:41)   ← conserva el hash
--         e00860 (viaje 0000fe, $199.00, 28-Jul 22:48)   ← degradado
--
--     Mismo importe, misma flota demo, 67 minutos de diferencia, el día en que se
--     cerró el flujo de punta a punta por primera vez: un ENSAYO, las mismas
--     fotos mandadas dos veces. Esa lectura es de quien mira la lista, no de la
--     base, y por eso esperó tres días a que alguien la mirara.
--
--     REVERSIBLE, y comprobado después de aplicar: el SHA-256 completo del
--     degradado quedó en `ocr_extra.imgHashDuplicado`
--     (250a4e5b34ecba43d043bf63b771c384296c5a62917bf326ab2826d1e9349d98) junto
--     con `imgHashDegradadoPor`. Devolverlo es un UPDATE.
--
--     Bloque 8, corrido en cuanto se aplicó:
--       repetido-entre-viajes-rebotado=t  sin-hash-que-entraron=2
--       msg=duplicate key value violates unique constraint "uq_gasto_img_hash"
--     El mensaje NOMBRA el índice, que es de lo que depende `processor.ts` para
--     saber si un 23505 es benigno.
--   · 0030 (`indices_faltantes`) → APLICADA. El bloque 13 se escribió DESPUÉS,
--     el 31-jul: la única migración que existe para que un chequeo dejara de
--     mentir era, ella misma, la única sin comprobar.
--   · 0031 (TTL del contador de la barrera), 0032 (`politica_gasto` muerta),
--     0033 (la constancia del aviso separada de su reserva), 0034 (contacto del
--     art. 29), 0035 (`search_path` fijo) y 0036 (nada entra tras liquidar) →
--     APLICADAS el 31-jul. Sus bloques (14, 17, 18 y 19) pasaron; la salida está
--     copiada arriba.
-- Contra una base sin las migraciones, los bloques 6 a 11 reportan `f` — que es
-- justamente la lectura útil: dicen qué garantía falta.
--
-- QUÉ MIGRACIONES NO TIENEN BLOQUE, Y POR QUÉ: `migraciones_verificadas.test.ts`
-- lo mantiene honesto. Cada migración está o comprobada aquí, o exenta con una
-- razón escrita. Sin esa lista, la respuesta a "¿está cubierta la 00XX?" se
-- vuelve "creo que sí" — que fue exactamente lo que pasó con la 0030.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Mutex del viaje (mig. 0005) ──────────────────────────────────────────
-- Dos "listo" del mismo viaje no pueden correr el agente a la vez: sería el
-- doble de costo de LLM y dos cierres.
do $$
declare v_t uuid; v_o uuid; v_v uuid; l1 boolean; l2 boolean; l3 boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF MUTEX') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','+520000009001') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  l1 := try_lock_viaje(v_v, 60000);   -- primero: toma el lease
  l2 := try_lock_viaje(v_v, 60000);   -- concurrente: rebota
  perform unlock_viaje(v_v);
  l3 := try_lock_viaje(v_v, 60000);   -- liberado: se puede volver a tomar

  raise exception E'MUTEX  1er=%  concurrente=%  tras-unlock=%   (esperado t / f / t)', l1, l2, l3;
end $$;

-- ── 264. Retención DB: una tanda, sin encoger producto y sin perder la purga geográfica (mig. 0332) ──
-- La carrera SKIP LOCKED, que necesita dos sesiones, vive en
-- supabase/tests/0332_db_retencion_concurrencia.sh. Este bloque fija las
-- garantías observables de una sesión y revierte sus datos con el RAISE final.
do $$
declare
  t uuid := '33200000-0000-4000-8000-000000000090';
  i uuid := '33200000-0000-4000-8000-000000000091';
  r jsonb; m jsonb;
  producto_ok boolean; deadline_ok boolean; geo_ok boolean; llaves_ok boolean;
begin
  insert into public.tenant(id,nombre) values(t,'__verif_0332__');
  -- El entorno persistente pudo ejecutar mantenimiento antes. Esta mutación
  -- vive dentro del bloque que termina en RAISE/rollback y fuerza el estado
  -- de transición cuya garantía verificamos: sin watermark no se puede
  -- ocultar detalle antiguo aún no consolidado.
  update public.producto_evento_estado set detalle_desde=null where singleton;
  insert into public.producto_evento(tenant_id,pantalla,accion,created_at)
    values(t,'viajes','pageview',now()-interval '120 days');
  select coalesce(sum(eventos),0)=1 into producto_ok
    from public.uso_producto_mensual() where tenant_id=t;

  insert into public.wa_conversacion(tenant_id,telefono,updated_at)
    values(t,'529993320090',now()-interval '181 days');
  r := public.purgar_wa_conversacion(180,now(),clock_timestamp()-interval '1 second');
  deadline_ok := (r->>'borradas')::bigint=0 and (r->>'parcial')::boolean
    and not (r->>'agotado')::boolean
    and exists(select 1 from public.wa_conversacion where tenant_id=t);

  insert into public.incidencia(id,tenant_id,tipo,estado,resuelta_en,lat,lng)
    values(i,t,'desvio','resuelta',now()-interval '100 days',20.9,-89.6);
  m := public.mantenimiento_de_datos(30,now());
  select lat is null and lng is null into geo_ok from public.incidencia where id=i;
  llaves_ok := m ? 'incidenciaGeoPurgada' and m ? 'incidenciaEventoGeoPurgado'
    and m ? 'conversacionesParcial' and m ? 'codigosParcial' and m ? 'otrasPurgasParcial';

  raise exception E'DB_RETENCION_0332 producto=% deadline=% geo=% llaves=%   (esperado t / t / t / t)',
    producto_ok, deadline_ok, geo_ok, llaves_ok;
end $$;

-- ── 266. Arranque puramente catalogal, exacto y server-only (mig. 0326) ──
-- Esperado: STARTUP_CATALOGO_0326 completo=t estable=t sin-escrituras=t permisos=t
do $$
declare
  faltantes text[];
  antes jsonb;
  despues jsonb;
  completo boolean := false;
  estable boolean := false;
  sin_escrituras boolean := false;
  permisos boolean := false;
begin
  select jsonb_build_object(
    'tenant', (select count(*) from public.tenant),
    'operador', (select count(*) from public.operador),
    'viaje', (select count(*) from public.viaje),
    'gasto', (select count(*) from public.gasto),
    'liquidacion', (select count(*) from public.liquidacion)
  ) into antes;

  faltantes := public.garantias_arranque_faltantes();

  select jsonb_build_object(
    'tenant', (select count(*) from public.tenant),
    'operador', (select count(*) from public.operador),
    'viaje', (select count(*) from public.viaje),
    'gasto', (select count(*) from public.gasto),
    'liquidacion', (select count(*) from public.liquidacion)
  ) into despues;

  completo := coalesce(cardinality(faltantes), 0) = 0;
  sin_escrituras := antes = despues;

  select p.provolatile = 's'
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
    into estable
    from pg_catalog.pg_proc p
   where p.oid = 'public.garantias_arranque_faltantes()'::regprocedure;

  permisos := not has_function_privilege(
      'anon', 'public.garantias_arranque_faltantes()', 'EXECUTE'
    ) and not has_function_privilege(
      'authenticated', 'public.garantias_arranque_faltantes()', 'EXECUTE'
    ) and has_function_privilege(
      'service_role', 'public.garantias_arranque_faltantes()', 'EXECUTE'
    );

  raise exception E'STARTUP_CATALOGO_0326 completo=% estable=% sin-escrituras=% permisos=%   (esperado t / t / t / t)',
    completo, estable, sin_escrituras, permisos;
end $$;

-- ── 261. Jornada versionada: GPS tardío amplía sin pisar declaración (mig. 0319) ──
-- Esperado: JORNADA_VERSION_0319 reabre=t actualiza=t historial=t manual=t
do $$
declare
  ta uuid := gen_random_uuid(); op uuid := gen_random_uuid(); opm uuid := gen_random_uuid();
  u uuid := gen_random_uuid(); vi uuid := gen_random_uuid(); jd uuid := gen_random_uuid();
  jdm uuid := gen_random_uuid(); c1 uuid; c2 uuid; ver1 text; ver2 text;
  r1 text; r2 text; rm1 text; rm2 text;
  reabre boolean; actualiza boolean; historial boolean; manual boolean;
begin
  insert into public.tenant(id,nombre) values(ta,'ZZZ JORNADA VERSION 0319');
  insert into public.operador(id,tenant_id,nombre,telefono) values
    (op,ta,'Operador derivado 0319','529993703191'),
    (opm,ta,'Operador manual 0319','529993703192');
  insert into public.unidad(id,tenant_id,numero_economico) values(u,ta,'VER-0319');
  insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en)
    values(vi,ta,op,u,'2026-09-02 07:59-06','2026-09-02 08:00-06');
  insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor) values
    (ta,u,20,-89,'2026-09-02 07:00-06','verif-0319'),
    (ta,u,20,-89,'2026-09-02 16:00-06','verif-0319');
  insert into public.jornada_dia(id,tenant_id,operador_id,dia) values
    (jd,ta,op,'2026-09-02'),(jdm,ta,opm,'2026-09-02');

  perform public.sincronizar_jornadas_por_derivar('2026-09-02 23:59:59-06',1);
  -- El claim es global: apartar sólo las filas ajenas a esta fixture;
  -- el RAISE final restaura sus deadlines y todos los cambios del sync.
  update public.jornada_derivacion_trabajo set siguiente_intento_en='infinity' where tenant_id<>ta;
  select claim_token,input_version into c1,ver1
    from public.reclamar_jornadas_por_derivar(
      1,'verif-0319-a',30
    ) where operador_id=op;
  r1 := public.asentar_extremo_jornada_derivado(
    jd,ta,'fin_jornada','2026-09-02 16:00-06','gps','gps:0319:16',vi,u,'{}'
  );
  perform public.finalizar_jornada_derivacion(c1,'verif-0319-a',true,null,3600);

  insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
    values(ta,u,20,-89,'2026-09-02 23:00-06','verif-0319');
  perform public.sincronizar_jornadas_por_derivar('2026-09-02 23:59:59-06',1);
  -- El claim es global: apartar sólo las filas ajenas a esta fixture;
  -- el RAISE final restaura sus deadlines y todos los cambios del sync.
  update public.jornada_derivacion_trabajo set siguiente_intento_en='infinity' where tenant_id<>ta;
  select claim_token,input_version into c2,ver2
    from public.reclamar_jornadas_por_derivar(
      1,'verif-0319-b',30
    ) where operador_id=op;
  reabre := c2 is not null and ver2 is distinct from ver1;
  r2 := public.asentar_extremo_jornada_derivado(
    jd,ta,'fin_jornada','2026-09-02 23:00-06','gps','gps:0319:23',vi,u,'{}'
  );
  actualiza := r1='asentado' and r2='actualizado' and exists(
    select 1 from public.jornada_asiento
     where jornada_id=jd and tipo='fin_jornada' and momento='2026-09-02 23:00-06'
       and anulado_en is null
  );
  historial := exists(
    select 1 from public.jornada_asiento nuevo
    join public.jornada_asiento viejo on viejo.id=nuevo.corrige_a
    where nuevo.jornada_id=jd and nuevo.momento='2026-09-02 23:00-06'
      and viejo.momento='2026-09-02 16:00-06' and viejo.anulado_en is not null
  );

  insert into public.jornada_asiento(
    tenant_id,jornada_id,tipo,momento,procedencia,wa_message_id
  ) values
    (ta,jdm,'inicio_jornada','2026-09-02 08:00-06','declarado_operador','wamid.verif.0319.i'),
    (ta,jdm,'fin_jornada','2026-09-02 18:00-06','declarado_operador','wamid.verif.0319.f');
  rm1 := public.asentar_extremo_jornada_derivado(
    jdm,ta,'inicio_jornada','2026-09-02 06:00-06','gps','gps:0319:manual:i',null,u,'{}'
  );
  rm2 := public.asentar_extremo_jornada_derivado(
    jdm,ta,'fin_jornada','2026-09-02 23:00-06','gps','gps:0319:manual:f',null,u,'{}'
  );
  manual := rm1='ya_estaba' and rm2='ya_estaba' and (
    select count(*)=2 from public.jornada_asiento
     where jornada_id=jdm and procedencia='declarado_operador' and anulado_en is null
  );

  raise exception E'JORNADA_VERSION_0319 reabre=% actualiza=% historial=% manual=%   (esperado t / t / t / t)',
    reabre, actualiza, historial, manual;
end $$;

-- ── 262. Fairness 5 tenants/5,000 trabajos y fence WA vencido (mig. 0319) ──
-- Esperado: CAPACIDAD_0319 cinco-mil=5000 min=80 max=80 primeros-min=2
-- primeros-max=2 solapes=0 stale-wa=f permisos=t
do $$
declare
  i int; stale_id uuid; stale_ok boolean; permisos boolean;
  cinco_mil int; minimo int; maximo int; primeros_min int; primeros_max int; solapes int;
begin
  create temporary table verif_0319_tenant(id uuid primary key,n int) on commit drop;
  insert into verif_0319_tenant
    select gen_random_uuid(),g from generate_series(1,5) g;
  insert into public.tenant(id,nombre)
    select id,'ZZZ FAIR 0319-'||n from verif_0319_tenant;

  create temporary table verif_0319_op(id uuid primary key,tenant_id uuid,tn int,n int) on commit drop;
  insert into verif_0319_op
    select gen_random_uuid(),t.id,t.n,g
      from verif_0319_tenant t cross join generate_series(1,1000) g;
  insert into public.operador(id,tenant_id,nombre,telefono)
    select id,tenant_id,'OP-'||n,'58'||tn||lpad(n::text,9,'0') from verif_0319_op;
  insert into public.viaje(id,tenant_id,operador_id,estatus,avisado_en,aceptado_en)
    select gen_random_uuid(),tenant_id,id,'abierto','2026-09-02 07:59-06','2026-09-02 08:00-06'
      from verif_0319_op;

  perform public.sincronizar_jornadas_por_derivar('2026-09-02 23:59:59-06',1);
  -- Evitar que una sexta flota preexistente altere la prueba de fairness.
  -- Sólo se pospone dentro de esta transacción, que siempre revierte.
  update public.jornada_derivacion_trabajo set siguiente_intento_en='infinity'
    where tenant_id not in(select id from verif_0319_tenant);
  create temporary table verif_0319_a on commit drop as
    select r.tenant_id,r.operador_id,r.dia,r.ordinality as orden from public.reclamar_jornadas_por_derivar(
      400,'fair-0319-a',300
    ) with ordinality as r;
  create temporary table verif_0319_b on commit drop as
    select r.tenant_id,r.operador_id,r.dia,r.ordinality as orden from public.reclamar_jornadas_por_derivar(
      400,'fair-0319-b',300
    ) with ordinality as r;
  select min(n),max(n),min(p),max(p) into minimo,maximo,primeros_min,primeros_max
    from (
      select tenant_id,count(*) n,count(*) filter(where orden<=10) p
        from verif_0319_a group by tenant_id
    ) x;
  select count(*) into solapes from verif_0319_a a
    join verif_0319_b b using(tenant_id,operador_id,dia);
  select count(*) into cinco_mil from public.jornada_derivacion_trabajo
    where tenant_id in(select id from verif_0319_tenant);

  update public.wa_drenado_cadena set cadena_id=null,lease_expires_at=null where singleton;
  stale_id := public.iniciar_cadena_wa(30);
  update public.wa_drenado_cadena set lease_expires_at=clock_timestamp()-interval '1 second' where singleton;
  stale_ok := public.renovar_cadena_wa(stale_id,30);
  permisos := not has_function_privilege(
      'anon','public.asentar_extremo_jornada_derivado(uuid,uuid,text,timestamptz,text,text,uuid,uuid,jsonb)','EXECUTE'
    ) and not has_function_privilege(
      'authenticated','public.asentar_extremo_jornada_derivado(uuid,uuid,text,timestamptz,text,text,uuid,uuid,jsonb)','EXECUTE'
    ) and has_function_privilege(
      'service_role','public.asentar_extremo_jornada_derivado(uuid,uuid,text,timestamptz,text,text,uuid,uuid,jsonb)','EXECUTE'
    );

  raise exception E'CAPACIDAD_0319 cinco-mil=% min=% max=% primeros-min=% primeros-max=% solapes=% stale-wa=% permisos=%   (esperado 5000 / 80 / 80 / 2 / 2 / 0 / f / t)',
    cinco_mil,minimo,maximo,primeros_min,primeros_max,solapes,stale_ok,permisos;
end $$;

-- ── 2. Doble cierre (mig. 0013 + liquidacion_viaje_uidx) ────────────────────
-- Aunque el mutex se abra (fail-open ante RPC ausente), la base tiene que
-- impedir dos liquidaciones del mismo viaje. Y un re-cierre que todavía no
-- generó el PDF no puede borrar el que ya había.
do $$
declare v_t uuid; v_o uuid; v_v uuid; id1 uuid; id2 uuid; n int; est text; pdf text;
begin
  insert into tenant (nombre) values ('ZZZ VERIF CIERRE') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','+520000009002') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  id1 := guardar_liquidacion_tx(v_t, v_v, 4600, 5100, 500, 'cuadrada', '[]'::jsonb, 0,0,0, 'https://storage/liq.pdf');
  id2 := guardar_liquidacion_tx(v_t, v_v, 4600, 5100, 500, 'cuadrada', '[]'::jsonb, 0,0,0, null);

  select count(*) into n from liquidacion where viaje_id = v_v;
  select pdf_url into pdf from liquidacion where viaje_id = v_v;
  select estatus into est from viaje where id = v_v;

  raise exception E'CIERRE  liquidaciones=%  mismo-id=%  pdf-sobrevive=%  viaje=%   (esperado 1 / t / la url / liquidado)',
    n, (id1 = id2), pdf, est;
end $$;

-- ── 3. Claim del acercamiento (mig. 0017) ───────────────────────────────────
-- El segundo acercamiento no pisa el folio del primero — ese folio es el que la
-- oficina teclea en el portal — y el merge conserva lo que otra foto ya había
-- puesto en ocr_extra (esto último era el lost update de B13).
do $$
declare v_t uuid; v_o uuid; v_v uuid; v_g uuid; r1 boolean; r2 boolean; extra jsonb; uu text;
begin
  insert into tenant (nombre) values ('ZZZ VERIF CLAIM') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','+520000009003') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;
  insert into gasto (tenant_id, viaje_id, concepto, monto, ocr_extra)
    values (v_t, v_v, 'diesel', 487.50, '{"montoDiscrepante":true}'::jsonb) returning id into v_g;

  r1 := enriquecer_gasto_codigo(v_g, v_t, '{"folioPortal":"PRIMERO"}'::jsonb, 'uuid-a');
  r2 := enriquecer_gasto_codigo(v_g, v_t, '{"folioPortal":"SEGUNDO"}'::jsonb, 'uuid-b');
  select ocr_extra, cfdi_uuid into extra, uu from gasto where id = v_g;

  raise exception E'CLAIM  primero=%  segundo=%  folio=%  montoDiscrepante-sobrevive=%  uuid=%   (esperado t / f / PRIMERO / t / uuid-a)',
    r1, r2, extra->>'folioPortal', extra->>'montoDiscrepante', uu;
end $$;


-- ── 4. Un CFDI, un gasto (mig. 0019) ────────────────────────────────────────
-- El mismo UUID no entra dos veces, pero los tickets SIN timbrar (cfdi_uuid
-- NULL) tienen que poder entrar todos: son la mayoría.
--
-- El fixture va en MINÚSCULAS desde la 0158 (DAT-26): `cfdi_uuid` tiene ahora
-- CHECK de minúsculas en las cuatro tablas donde vive, porque el SAT lo
-- imprime en mayúsculas y el OCR lo lee en minúsculas — y este índice único
-- dejaba entrar el mismo comprobante dos veces por esa sola diferencia.
do $$
declare v_t uuid; v_o uuid; v_v uuid; choco boolean := false; msg text := ''; sin_uuid int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF UUID') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','+520000009004') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  insert into gasto (tenant_id, viaje_id, concepto, monto, cfdi_uuid) values (v_t, v_v, 'diesel', 100, 'uuid-repetido');
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, cfdi_uuid) values (v_t, v_v, 'diesel', 100, 'uuid-repetido');
  exception when unique_violation then choco := true; msg := SQLERRM;
  end;

  insert into gasto (tenant_id, viaje_id, concepto, monto, cfdi_uuid)
    values (v_t,v_v,'caseta',50,null),(v_t,v_v,'caseta',50,null),(v_t,v_v,'diesel',80,null);
  select count(*) into sin_uuid from gasto where tenant_id = v_t and cfdi_uuid is null;

  -- El mensaje TIENE que nombrar uq_gasto_cfdi_uuid: el processor discrimina por
  -- ese nombre para saber si el 23505 es benigno (src/lib/likida/pg_errores.ts).
  raise exception E'UUID  repetido-rebotado=%  sin-uuid-que-entraron=%  msg=%   (esperado t / 3 / nombra uq_gasto_cfdi_uuid)',
    choco, sin_uuid, msg;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- AUDITORÍA 5 — los bloques que faltaban.
--
-- El auditor de modelo de datos anotó dos huecos de cobertura en este archivo:
-- no había ningún bloque para la garantía de la 0022 (que la RPC de cierre sea
-- única), que era justo la que no estaba en el repo, ni ninguno de aislamiento
-- entre tenants. Estos siete los cubren, más las cuatro restricciones nuevas.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 5. Una sola firma de guardar_liquidacion_tx (mig. 0022) ─────────────────
-- 0013 la creó con 11 parámetros y 0021 la recreó con 12: `create or replace`
-- NO reemplaza una firma distinta, crea una SOBRECARGA. Con las dos vivas, toda
-- llamada de 11 argumentos falla con "function guardar_liquidacion_tx(...) is
-- not unique" y NINGUNA liquidación cierra. Este bloque es de solo lectura.
do $$
declare n int; nargs text;
begin
  select count(*), coalesce(string_agg(p.pronargs::text, ' / ' order by p.pronargs), '—')
    into n, nargs
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'guardar_liquidacion_tx';

  -- 15 desde la 0321: a los 13 de la 0158 se sumaron hash+versión con default
  -- NULL, y la firma de 13 se DROPEÓ en la misma migración — que es lo que
  -- este bloque vigila desde la 0022.
  raise exception E'RPC ÚNICA  firmas=%  con-n-argumentos=%   (esperado 1 / 15)', n, nargs;
end $$;


-- ── 6. Un teléfono, un operador (mig. 0024) ─────────────────────────────────
-- El mismo número mexicano circula como '52…', '521…' y '+52…', y hasta la 0024
-- las tres formas eran tres operadores distintos para la base. Con dos filas
-- activas, `resolveOperador` (.in(variantes).limit(1)) devuelve una arbitraria y
-- el gasto se escribe en la flota que salga primero.
--
-- Lo que NO puede romper: un operador dado de baja en una flota tiene que poder
-- aparecer en otra. Eso es rotación, no ambigüedad.
do $$
declare
  t_a uuid; t_b uuid;
  misma_flota boolean := false; otra_flota boolean := false; rotacion boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF TEL A') returning id into t_a;
  insert into tenant (nombre) values ('ZZZ VERIF TEL B') returning id into t_b;

  insert into operador (tenant_id, nombre, telefono) values (t_a, 'P', '529990009005');

  -- La misma flota, el mismo número CON el "1" que agrega Meta al entregar.
  begin
    insert into operador (tenant_id, nombre, telefono) values (t_a, 'P', '5219990009005');
  exception when unique_violation then misma_flota := true;
  end;

  -- Otra flota, el mismo número con espacios y "+". Este es el que corrompe el
  -- tenant del gasto, y por eso la unicidad de activos es GLOBAL.
  begin
    insert into operador (tenant_id, nombre, telefono) values (t_b, 'P', '+52 999 000 9005');
  exception when unique_violation then otra_flota := true;
  end;

  -- Dado de baja en la otra flota: tiene que PASAR.
  begin
    insert into operador (tenant_id, nombre, telefono, activo)
      values (t_b, 'P', '5219990009005', false);
    rotacion := true;
  exception when unique_violation then rotacion := false;
  end;

  raise exception E'TELÉFONO  misma-flota-rebota=%  otra-flota-rebota=%  baja-en-otra-flota-pasa=%   (esperado t / t / t)',
    misma_flota, otra_flota, rotacion;
end $$;


-- ── 7. tenant.config no puede apagar un tope de dinero (mig. 0026) ──────────
-- Las tres formas que el auditor midió contra el motor real: `{"politica":[]}`
-- se lleva el tope de la flota, `viaticosTopeFiscalDiarioMxn: null` se lleva el
-- de $750/día de LISR 28-V —las dos sin un log y sin un error—, y
-- `{"politica":"si"}` revienta el cuadre con "pol.filter is not a function".
-- Un override legítimo tiene que seguir pasando.
do $$
declare
  v_t uuid;
  vacia text := 'PASÓ'; nulo text := 'PASÓ'; texto text := 'PASÓ'; typo text := 'PASÓ';
  legitimo boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF CONFIG') returning id into v_t;

  begin update tenant set config = '{"politica": []}'::jsonb where id = v_t;
  exception when others then vacia := 'REBOTÓ'; end;

  begin update tenant set config = '{"estimulos":{"viaticosTopeFiscalDiarioMxn": null}}'::jsonb where id = v_t;
  exception when others then nulo := 'REBOTÓ'; end;

  begin update tenant set config = '{"politica": "si"}'::jsonb where id = v_t;
  exception when others then texto := 'REBOTÓ'; end;

  -- La "s" de más: hoy se guarda tan campante y la flota corre con DEMO_CONFIG.
  begin update tenant set config = '{"politicas": [{"concepto":"diesel","topeMonto":4000}]}'::jsonb where id = v_t;
  exception when others then typo := 'REBOTÓ'; end;

  begin
    update tenant set config = '{"estimulos":{"viaticosTopeFiscalDiarioMxn": 900}}'::jsonb where id = v_t;
    legitimo := true;
  exception when others then legitimo := false; end;

  raise exception E'CONFIG  politica-vacía=%  tope-en-null=%  politica-texto=%  llave-mal-escrita=%  override-legítimo-pasa=%   (esperado REBOTÓ / REBOTÓ / REBOTÓ / REBOTÓ / t)',
    vacia, nulo, texto, typo, legitimo;
end $$;


-- ── 8. La misma foto no se comprueba en dos viajes (mig. 0027) ──────────────
-- Un SHA-256 igual es el mismo archivo. Hasta la 0027 el índice llevaba el
-- viaje en medio, así que el mismo ticket entraba una vez por viaje y se
-- comprobaba contra dos anticipos. Y los tickets SIN hash tienen que seguir
-- entrando todos.
--
-- El segundo viaje se crea ya 'liquidado' a propósito: desde la 0029 un
-- operador no puede tener dos abiertos a la vez.
--
-- El mensaje TIENE que nombrar `uq_gasto_img_hash`: `processor.ts:356`
-- discrimina por ese nombre para saber si el 23505 es benigno.
do $$
declare
  v_t uuid; v_o uuid; v_a uuid; v_b uuid;
  choco boolean := false; msg text := ''; sin_hash int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF HASH') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009006') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_a;
  insert into viaje (tenant_id, operador_id, estatus) values (v_t, v_o, 'liquidado') returning id into v_b;

  insert into gasto (tenant_id, viaje_id, concepto, monto, img_hash)
    values (v_t, v_a, 'alimentacion', 199, 'HASH-REPETIDO');
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, img_hash)
      values (v_t, v_b, 'alimentacion', 199, 'HASH-REPETIDO');
  exception when unique_violation then choco := true; msg := SQLERRM;
  end;

  insert into gasto (tenant_id, viaje_id, concepto, monto, img_hash)
    values (v_t,v_a,'caseta',50,null),(v_t,v_b,'caseta',50,null);
  select count(*) into sin_hash from gasto where tenant_id = v_t and img_hash is null;

  raise exception E'HASH  repetido-entre-viajes-rebotado=%  sin-hash-que-entraron=%  msg=%   (esperado t / 2 / nombra uq_gasto_img_hash)',
    choco, sin_hash, msg;
end $$;


-- ── 9. Aislamiento entre flotas en la clave, no en la app (mig. 0028) ───────
-- Hasta la 0028 ninguna FK llevaba el tenant: un autenticado de la flota A podía
-- colgar un gasto SUYO del viaje de la flota B. El WITH CHECK de la policy pasa
-- (el tenant_id es el suyo) y la FK pasa (el viaje existe). La fila queda
-- invisible para B y contada en el 15% de combustible de A.
do $$
declare
  t_a uuid; t_b uuid; o_a uuid; o_b uuid; vi_b uuid;
  choco boolean := false; msg text := ''; propio boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF AISLA A') returning id into t_a;
  insert into tenant (nombre) values ('ZZZ VERIF AISLA B') returning id into t_b;
  insert into operador (tenant_id, nombre, telefono) values (t_a,'PA','520000009007') returning id into o_a;
  insert into operador (tenant_id, nombre, telefono) values (t_b,'PB','520000009008') returning id into o_b;
  insert into viaje (tenant_id, operador_id) values (t_b, o_b) returning id into vi_b;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (t_a, vi_b, 'diesel', 50000);
  exception when foreign_key_violation then choco := true; msg := SQLERRM;
  end;

  -- Y el camino normal —gasto en el viaje de tu propia flota— tiene que pasar.
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (t_b, vi_b, 'diesel', 4200);
    propio := true;
  exception when foreign_key_violation then propio := false;
  end;

  raise exception E'AISLAMIENTO  gasto-de-A-en-viaje-de-B-rebotado=%  gasto-propio-pasa=%  msg=%   (esperado t / t / nombra gasto_viaje_tenant_fkey)',
    choco, propio, msg;
end $$;


-- ── 10. Un operador, un viaje abierto (mig. 0029) ───────────────────────────
-- Con dos abiertos, todas las fotos se cuelgan del más nuevo y el viejo cierra
-- con el anticipo entero en contra del operador. Cerrar el primero tiene que
-- liberar el hueco: si no, el operador no podría empezar nunca otro viaje.
do $$
declare
  v_t uuid; v_o uuid; v1 uuid;
  segundo boolean := false; tras_cierre boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF ABIERTO') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009009') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v1;

  begin
    insert into viaje (tenant_id, operador_id) values (v_t, v_o);
  exception when unique_violation then segundo := true;
  end;

  update viaje set estatus = 'liquidado' where id = v1;

  begin
    insert into viaje (tenant_id, operador_id) values (v_t, v_o);
    tras_cierre := true;
  exception when unique_violation then tras_cierre := false;
  end;

  raise exception E'VIAJE ABIERTO  segundo-rebota=%  tras-cerrar-el-primero-pasa=%   (esperado t / t)',
    segundo, tras_cierre;
end $$;


-- ── 11. Dominios: lo que el motor no sabe manejar ya no entra (mig. 0025) ───
-- 'combustible' en vez de 'diesel' se salta el tope de política, la regla de
-- combustible en efectivo y el contador del 15%, y suma a totalComprobado como
-- si fuera deducible. Un `estatus = 'activo'` deja al operador sin viaje para
-- siempre. Un `forma_pago = 'efectivo'` apaga LISR 27-III.
do $$
declare
  v_t uuid; v_o uuid; v_v uuid;
  concepto boolean := false; estatus boolean := false; pago boolean := false; rol boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF DOMINIO') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009010') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, forma_pago)
      values (v_t, v_v, 'combustible', 9000, '01');
  exception when check_violation then concepto := true;
  end;

  begin
    update viaje set estatus = 'activo' where id = v_v;
  exception when check_violation then estatus := true;
  end;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, forma_pago)
      values (v_t, v_v, 'diesel', 9000, 'efectivo');
  exception when check_violation then pago := true;
  end;

  -- De este depende is_superadmin(), o sea la RLS de las 7 tablas de negocio.
  begin
    insert into app_user (id, tenant_id, email, rol)
      values (gen_random_uuid(), v_t, 'zzz-verif@likida.test', 'super_admin');
  exception when check_violation then rol := true;
  end;

  raise exception E'DOMINIOS  concepto-inventado=%  estatus-inventado=%  forma_pago-texto=%  rol-mal-escrito=%   (esperado t / t / t / t)',
    concepto, estatus, pago, rol;
end $$;


-- ── 12. Qué va a tocar la 0027 antes de aplicarla ───────────────────────────
-- SOLO LECTURA: no inserta, no actualiza, no borra. Es el paso previo a
-- `supabase db push` de la 0027, que degrada a NULL el `img_hash` del duplicado
-- más nuevo de cada grupo (conservando el valor en `ocr_extra.imgHashDuplicado`).
--
-- Correrlo ANTES importa porque la base no puede distinguir un ENSAYO del demo
-- —las mismas 17 fotos mandadas dos veces— de un fraude —el mismo ticket cobrado
-- contra dos anticipos—. Son el mismo archivo en dos viajes. Esa distinción es
-- de quien mira la lista, y esta es la lista.
--
-- Medido el 28-jul-2026: 1 grupo, el hash 250a4e5b… en los gastos
-- 26fd8543-… (viaje …00ff) y 19299f03-… (viaje …00fe), $199.00 los dos.
do $$
declare r record; msg text := ''; n int := 0;
begin
  for r in
    select g.tenant_id,
           g.img_hash,
           count(*) as veces,
           count(distinct g.viaje_id) as viajes,
           sum(g.monto) as monto_sumado,
           string_agg(g.id::text || ' (viaje ' || right(g.viaje_id::text, 6) ||
                      ', $' || g.monto::text || ')', E'\n      ' order by g.created_at) as filas
    from gasto g
    where g.img_hash is not null
    group by g.tenant_id, g.img_hash
    having count(*) > 1
  loop
    n := n + 1;
    msg := msg || format(E'\n  · tenant %s · hash %s… · %s gastos en %s viajes · suma $%s\n      %s',
                         r.tenant_id, left(r.img_hash, 12), r.veces, r.viajes, r.monto_sumado, r.filas);
  end loop;

  if n = 0 then
    raise exception 'FOTOS REPETIDAS  grupos=0 → la 0027 se puede aplicar tal cual, no degrada ningún hash.';
  end if;

  raise exception E'FOTOS REPETIDAS  grupos=%  → la 0027 degradará a NULL el img_hash del MÁS NUEVO de cada grupo (el valor se guarda en ocr_extra.imgHashDuplicado):%\n\nRevísalos uno por uno: la base no sabe si es un ensayo del demo o el mismo ticket cobrado dos veces.', n, msg;
end $$;


-- ── 13. La sonda de índices dice la verdad (mig. 0030) ──────────────────────
-- La 0030 existe porque el arranque AFIRMABA verificar el unique de
-- `gasto.cfdi_uuid` y no podía: sondeaba `select cfdi_uuid from gasto limit 1`,
-- y esa columna es de `0001_init.sql` — responde igual de bien en una base donde
-- la 0019 nunca se aplicó. Se cambió por `indices_faltantes`, que mira
-- `pg_indexes`, y ese cambio se quedó SIN bloque aquí: la única migración que
-- existe para que un chequeo deje de mentir era la única sin comprobar.
--
-- Un falso negativo aquí no rompe nada visible: deja que el arranque diga `ok`
-- sobre una base que liquida el mismo CFDI dos veces y acredita su IVA doble.
do $$
declare
  inventado text[]; real_falta text[]; ninguno text[];
begin
  -- Un índice que NO existe tiene que salir en la lista.
  inventado := indices_faltantes(array['uq_no_existe_jamas_zzz']);
  -- Uno que SÍ existe no puede salir. Si `uq_gasto_cfdi_uuid` aparece aquí, la
  -- 0019 no está aplicada y es una alarma de dinero, no de esta prueba.
  real_falta := indices_faltantes(array['uq_gasto_cfdi_uuid']);
  -- La lista vacía devuelve vacío, no null: el TS hace `faltantes.length`.
  ninguno := indices_faltantes(array[]::text[]);

  raise exception E'INDICES_FALTANTES  ve-el-que-falta=%  calla-el-que-existe=%  vacio-no-es-null=%   (esperado t / t / t)',
    inventado = array['uq_no_existe_jamas_zzz'],
    real_falta = '{}'::text[],
    ninguno is not null and cardinality(ninguno) = 0;
end $$;


-- ── 14. El contador de la barrera (mig. 0011 + 0031) ───────────────────────
-- La 0011 tampoco tenía bloque, y salió a la luz al escribir la lista de
-- `migraciones_verificadas.test.ts` — la cuarta que aparece por escribirla.
-- El `-1` del OCR vive en un `finally` (processor.ts) y un `finally` no corre si
-- el proceso no vuelve. Con `maxDuration = 120` en el webhook, una función que
-- Vercel mata por tope, por memoria o por un despliegue a media ráfaga deja el
-- `+1` escrito para siempre.
--
-- Desde ese momento ese viaje queda averiado de forma permanente: cada "listo"
-- espera los 20s completos de la barrera y le avisa al operador que se cuadró
-- con gastos parciales sobre una liquidación que estaba entera.
--
-- El olvido tiene que ocurrir también en el SONDEO (`p_delta = 0`), que es como
-- lo llama `esperarIntake`: si solo ocurriera al incrementar, la barrera no se
-- abriría hasta que llegara una foto nueva — y después de una caída puede que no
-- llegue ninguna.
do $$
declare
  v_t uuid; v_o uuid; v_v uuid;
  huerfano int; tras_sondeo int; vivo int; sellado boolean;
  nunca_negativo int; inexistente int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF BARRERA') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009013') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  -- ── La garantía propia de la 0011 ────────────────────────────────────────
  -- El contador NO puede bajar de 0. Un `-1` de más —un reintento de Meta que
  -- reprocesa un intake ya contado— dejaría el contador en negativo, y entonces
  -- las fotos siguientes tendrían que subirlo desde ahí: la barrera se abriría
  -- con OCR todavía en vuelo, que es exactamente lo que la 0011 vino a impedir.
  nunca_negativo := intake_delta(v_v, -3);
  -- Y un viaje que no existe devuelve 0, no null: `intakeDelta` distingue null
  -- ("no pude preguntar", fail-closed) de 0 ("no hay nada en vuelo").
  inexistente := intake_delta('00000000-0000-0000-0000-000000000000'::uuid, 0);

  -- ── El TTL, que es lo que agrega la 0031 ─────────────────────────────────
  -- Una foto entra y su proceso muere: queda el +1 sin su -1.
  huerfano := intake_delta(v_v, 1);
  -- Se envejece el sello a mano para no esperar diez minutos reales.
  update viaje set intake_pendientes_en = now() - interval '11 minutes' where id = v_v;

  -- El sondeo de `esperarIntake`. Tiene que ver 0 y abrir la barrera.
  tras_sondeo := intake_delta(v_v, 0);

  -- Y un contador RECIÉN sellado no se puede tirar: eso reabriría la barrera
  -- sobre fotos que sí están en vuelo, que es el bug que la 0011 vino a cerrar.
  vivo := intake_delta(v_v, 1);
  select intake_pendientes_en > now() - interval '1 minute' into sellado
    from viaje where id = v_v;
  vivo := intake_delta(v_v, 0);

  raise exception E'BARRERA  nunca-negativo=%  viaje-inexistente=%  huerfano-cuenta=%  sondeo-lo-olvida=%  sella-al-incrementar=%  reciente-sobrevive=%   (esperado 0 / 0 / 1 / 0 / t / 1)',
    nunca_negativo, inexistente, huerfano, tras_sondeo, sellado, vivo;
end $$;


-- ── 15. Un mensaje de Meta se procesa una vez (mig. 0002) ───────────────────
-- Meta reintenta el webhook. El `insert ... on conflict` sobre la llave primaria
-- de `wa_mensaje_procesado` ES el claim atómico: sin el unique, dos entregas del
-- mismo mensaje en paralelo pasan las dos y el gasto se duplica.
--
-- No tenía bloque. Se descubrió al escribir la lista de
-- `migraciones_verificadas.test.ts`, que es justo para lo que sirve la lista.
do $$
declare
  segundo_rebota boolean := false;
  claim_ok boolean;
begin
  insert into wa_mensaje_procesado (wa_message_id) values ('ZZZ_VERIF_IDEMP_0002');

  begin
    insert into wa_mensaje_procesado (wa_message_id) values ('ZZZ_VERIF_IDEMP_0002');
  exception when unique_violation then segundo_rebota := true;
  end;

  -- Y la forma que usa el código: `on conflict do nothing` no inserta y no truena.
  with i as (
    insert into wa_mensaje_procesado (wa_message_id) values ('ZZZ_VERIF_IDEMP_0002')
    on conflict do nothing returning 1
  ) select count(*) = 0 into claim_ok from i;

  raise exception E'IDEMPOTENCIA  segundo-rebota=%  on-conflict-no-inserta=%   (esperado t / t)',
    segundo_rebota, claim_ok;
end $$;


-- ── 16. Lo interno no es ejecutable por un anónimo (mig. 0012) ──────────────
-- Este NO inserta nada: se lee el catálogo, porque un `do $$` corre como el
-- dueño y bypasea RLS — comprobarlo insertando probaría el privilegio de quien
-- corre la prueba, no la garantía.
--
-- Lo que protege: sin RLS en `wa_mensaje_procesado`, un anónimo puede INSERTAR
-- ids falsos por PostgREST y hacer que mensajes reales se descarten como
-- duplicados. Los gastos de ese operador desaparecen sin un solo error. Y sin
-- revocar las RPC, un anónimo suelta el mutex de un viaje ajeno o le mueve el
-- contador de la barrera.
--
-- `revoke ... from anon` NO basta y por eso se revoca de PUBLIC: las funciones
-- se otorgan a PUBLIC por defecto, y `anon` hereda de ahí.
do $$
declare
  rls_on boolean; anon_intake boolean; anon_lock boolean; anon_unlock boolean;
  svc_intake boolean;
begin
  select relrowsecurity into rls_on
    from pg_class where oid = 'public.wa_mensaje_procesado'::regclass;

  anon_intake := has_function_privilege('anon', 'public.intake_delta(uuid,integer)', 'execute');
  -- AUDITORÍA 24 · BE-11 (mig. 0280): las dos funciones del mutex cambiaron de
  -- firma para llevar el token del dueño. Se actualizan aquí porque el bloque
  -- dejaría de compilar contra la firma vieja —`has_function_privilege` lanza
  -- si la función no existe— y lo que este bloque asevera (que un anónimo no
  -- puede soltar el mutex de un viaje ajeno) es exactamente lo mismo.
  anon_lock   := has_function_privilege('anon', 'public.try_lock_viaje(uuid,integer,uuid)', 'execute');
  anon_unlock := has_function_privilege('anon', 'public.unlock_viaje(uuid,uuid)', 'execute');
  -- Y el pipeline SÍ tiene que poder: una revocación de más rompe la barrera
  -- entera, que es un fallo tan caro como el hueco que cierra.
  svc_intake  := has_function_privilege('service_role', 'public.intake_delta(uuid,integer)', 'execute');

  raise exception E'PERMISOS  rls-en-wa_mensaje=%  anon-intake=%  anon-lock=%  anon-unlock=%  service-role-intake=%   (esperado t / f / f / f / t)',
    rls_on, anon_intake, anon_lock, anon_unlock, svc_intake;
end $$;


-- ── 17. La constancia del aviso sobrevive a un envío fallido (mig. 0033) ────
-- La 0018 puso la RESERVA y la CONSTANCIA en la misma fila:
-- `marcar_aviso_privacidad` escribía `aviso_privacidad_en = now()` antes de
-- mandar el mensaje. Correcto contra el envío duplicado — y por eso se hizo así.
--
-- Pero esa fila es la prueba del art. 16 de la LFPDPPP, así que deshacer la
-- reserva borraba la constancia. Con un aviso que cambia de versión el camino
-- completo es:
--
--   v1 entregado hace tres meses → la flota corrige la liga de su aviso integral
--   → el texto cambia → v2 → llega un mensaje → la reserva gana porque la
--   versión es distinta y PISA la constancia de v1 → Meta rechaza el envío
--   (pasó el 28-jul) → liberar ponía las dos columnas en NULL.
--
-- La base terminaba diciendo que ese operador nunca recibió ningún aviso. Y sí
-- lo recibió. Ante la autoridad la carga de probar el art. 16 es del
-- responsable: "no consta" es el peor estado posible, y se llegaba a él
-- destruyendo una prueba verdadera.
--
-- Esto es lo único que puede demostrarlo: el TS prueba que se llama a la RPC
-- correcta, no lo que la RPC hace con la fila.
do $$
declare
  v_t uuid; v_o uuid;
  gano_v1 boolean; gano_repetido boolean; gano_v2 boolean;
  constancia_v1 timestamptz; constancia_tras_fallo timestamptz;
  version_tras_fallo text; reserva_tras_fallo timestamptz;
  solto boolean; solto_de_nuevo boolean; gano_tras_ttl boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF AVISO') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009017') returning id into v_o;

  -- 1. Primer aviso: se reserva, sale, y se hace constar.
  gano_v1 := marcar_aviso_privacidad(v_o, v_t, 'v1');
  gano_repetido := marcar_aviso_privacidad(v_o, v_t, 'v1');  -- otro camino, misma ráfaga
  perform confirmar_aviso_privacidad(v_o, v_t, 'v1');
  select aviso_privacidad_en into constancia_v1 from operador where id = v_o;

  -- 2. Cambia el texto de la flota. Se reserva el reenvío…
  gano_v2 := marcar_aviso_privacidad(v_o, v_t, 'v2');
  -- …y el envío FALLA, así que se suelta la reserva.
  solto := liberar_aviso_privacidad(v_o, v_t);
  solto_de_nuevo := liberar_aviso_privacidad(v_o, v_t);  -- ya no hay nada que soltar

  select aviso_privacidad_en, aviso_privacidad_version, aviso_privacidad_claim_en
    into constancia_tras_fallo, version_tras_fallo, reserva_tras_fallo
    from operador where id = v_o;

  -- 3. La reserva expira sola: un proceso que muera entre reservar y confirmar
  --    no puede dejar a un operador sin su aviso para siempre.
  perform marcar_aviso_privacidad(v_o, v_t, 'v2');
  update operador set aviso_privacidad_claim_en = now() - interval '6 minutes' where id = v_o;
  gano_tras_ttl := marcar_aviso_privacidad(v_o, v_t, 'v2');

  raise exception E'AVISO  gana-1a=%   2do-camino-rebota=%  reenvio-por-version=%  CONSTANCIA-INTACTA=%  version-intacta=%  reserva-suelta=%  solto=%  solto-2a-vez=%  reserva-expira=%   (esperado t / f / t / t / v1 / t / t / f / t)',
    gano_v1,
    gano_repetido,
    gano_v2,
    constancia_tras_fallo = constancia_v1,   -- ← EL HALLAZGO: no se borró
    version_tras_fallo,
    reserva_tras_fallo is null,
    solto, solto_de_nuevo, gano_tras_ttl;
end $$;


-- ── 18. El aislamiento entre flotas, mirado en el catálogo (barrido 31-jul) ──
-- SOLO LECTURA. Nace del barrido de producción del 31-jul, en el que se atacó la
-- API REST como anónimo con la llave publicable: 14 tablas leídas → 0 filas, y
-- cinco escrituras rechazadas (envenenar la idempotencia, inventar un gasto,
-- soltar el mutex de un viaje ajeno, mover el contador de la barrera, marcar una
-- constancia de aviso falsa).
--
-- Aquello fue una foto de ese momento. Esto es lo que se puede volver a correr, y
-- comprueba las tres formas de perder el aislamiento SIN que nada falle:
--
--   1. una tabla nueva SIN RLS — el default de Postgres es permitir,
--   2. una política que diga `true` — se ve igual de segura en la lista y no
--      filtra nada,
--   3. una función interna ejecutable por `anon`.
--
-- LO QUE NO ES UN HALLAZGO, para que nadie lo "arregle": `codigo_pendiente`,
-- `viaje_lock` y `wa_mensaje_procesado` tienen RLS y CERO políticas. Eso es
-- denegación total a anon/authenticated y es exactamente lo que la 0012 buscaba;
-- solo el service-role escribe ahí. Y `get_user_tenant_ids()`/`is_superadmin()`
-- son SECURITY DEFINER ejecutables por anon a propósito: las usan las once
-- políticas, y resuelven contra `auth.uid()`, que para un anónimo es NULL —
-- devuelven vacío y false. Revocarlas rompe el aislamiento en vez de cerrarlo.
do $$
declare
  sin_rls text; con_true text; rpc_abierta text;
begin
  select coalesce(string_agg(c.relname, ', ' order by c.relname), '—') into sin_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  -- Una política permisiva cuya expresión sea literalmente `true` deja pasar
  -- todo con RLS encendido: el peor estado, porque el tablero dice "protegida".
  select coalesce(string_agg(tablename || '.' || policyname, ', '), '—') into con_true
    from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE'
     and btrim(coalesce(qual, with_check, '')) in ('true', '(true)');

  -- Las RPC internas del pipeline. Ninguna puede ser ejecutable por `anon`.
  select coalesce(string_agg(p.proname, ', ' order by p.proname), '—') into rpc_abierta
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('try_lock_viaje','unlock_viaje','intake_delta','enriquecer_gasto_codigo',
                       'guardar_liquidacion_tx','marcar_aviso_privacidad','confirmar_aviso_privacidad',
                       'liberar_aviso_privacidad','indices_faltantes')
     and has_function_privilege('anon', p.oid, 'execute');

  raise exception E'AISLAMIENTO  tablas-sin-rls=%  politicas-que-dicen-true=%  rpc-abiertas-a-anon=%   (esperado — / — / —)',
    sin_rls, con_true, rpc_abierta;
end $$;


-- ── 19. Un gasto no entra después de emitida la liquidación (mig. 0036) ─────
-- Cierra el ÚLTIMO crítico de código de las siete rondas de auditoría.
--
-- `guardar_liquidacion` genera los dos PDF en T1; segundos después
-- `guardiaCifras` VUELVE A CALCULAR para armar el texto de WhatsApp (T2). Entre
-- los dos, la tabla `gasto` seguía abierta: las fotos corren en su propio
-- `processInbound`, no toman el mutex del viaje, y `addGasto` no miraba nada.
--
--   T1  5 gastos, $4,850 → PDF: "Sobró $150.00 (a favor de la empresa)"
--   T2  6 gastos, $5,650 → WhatsApp: "Pusiste $650.00 de tu bolsa"
--
-- Las dos cosas seguidas, con $800 de diferencia y de SIGNO CONTRARIO, y el
-- sexto gasto huérfano de por vida.
--
-- El `for update` del trigger es lo que lo cierra de verdad: sin él, en READ
-- COMMITTED el trigger no vería la liquidación aún sin confirmar y dejaría pasar
-- el gasto — el mismo bug, movido de sitio.
--
-- Corrido el 31-jul, salida real:  t / f / CU001 / t
do $$
declare
  v_t uuid; v_o uuid; v_v uuid; v_o2 uuid; v_x uuid;
  antes boolean := false; tarde boolean := false; msg text := ''; sin_liq boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF TARDE') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009019') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'diesel', 850);
    antes := true;
  exception when others then antes := false;
  end;

  perform guardar_liquidacion_tx(v_t, v_v, 4850, 5000, 150, 'cuadrada', '[]'::jsonb, 0,0,0, 'https://x/liq.pdf', 0);

  -- La foto que llegó tarde. ESTE es el bug.
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'diesel', 800);
    tarde := true;
  exception when others then tarde := false; msg := SQLSTATE;
  end;

  -- Un viaje marcado `liquidado` SIN liquidación emitida sigue aceptando gastos:
  -- es lo que hace el bloque 8, que con la 0029 no puede tener dos abiertos del
  -- mismo operador. La regla se ancla a la liquidación, no al estatus.
  begin
    insert into operador (tenant_id, nombre, telefono) values (v_t,'Q','520000009020') returning id into v_o2;
    insert into viaje (tenant_id, operador_id, estatus) values (v_t, v_o2, 'liquidado') returning id into v_x;
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_x, 'caseta', 50);
    sin_liq := true;
  exception when others then sin_liq := false;
  end;

  raise exception E'TARDE  entra-antes=%  rebota-despues=%  sqlstate=%  liquidado-sin-liquidacion-sigue=%   (esperado t / f / CU001 / t)',
    antes, tarde, msg, sin_liq;
end $$;

-- ── 20. Un UPDATE tampoco puede reescribir el dinero tras liquidar (mig. 0037) ──
-- AUDITORÍA 8, ALTO (modelo de datos). La 0036 (bloque 19) blindaba el INSERT;
-- `updateGastoCfdiXml` (repo.ts:198) es un UPDATE que pega un XML a un gasto ya
-- existente y puede reescribir `monto`, `sub_total`, `iva_traslado` e
-- `ieps_traslado` — las cifras que ya se imprimieron si el viaje se liquidó
-- entre medias. Nada lo veía.
--
-- El `when` del trigger solo mira los campos financieros/UUID: un UPDATE que no
-- toque ninguno de esos (p. ej. solo `clave_prod_serv`) sigue pasando, y eso
-- también se comprueba aquí para no bloquear de más.
do $$
declare
  v_t uuid; v_o uuid; v_v uuid; v_g uuid;
  monto_bloqueado boolean := false; msg text := ''; no_financiero_pasa boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF UPDATE TARDE') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009020') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'diesel', 850) returning id into v_g;

  perform guardar_liquidacion_tx(v_t, v_v, 850, 1000, 150, 'cuadrada', '[]'::jsonb, 0,0,0, 'https://x/liq.pdf', 0);

  -- El XML que llega tarde intentando corregir el monto. ESTE es el bug.
  begin
    update gasto set monto = 800, cfdi_uuid = gen_random_uuid()::text where id = v_g;
    monto_bloqueado := false;
  exception when others then monto_bloqueado := true; msg := SQLSTATE;
  end;

  -- Control: un campo REALMENTE cosmético sigue pudiendo corregirse después
  -- de liquidar — el trigger no bloquea de más. Era `clave_prod_serv` hasta
  -- la 0158 (DAT-07): esa clave decide si un litro es diésel acreditable, o
  -- sea que NO era un campo no financiero — reeditarla tras liquidar movía el
  -- estímulo del LIF 20-A sin tocar el papel ya emitido. La ruta de la imagen
  -- en el Storage sí es cosmética: no entra a ningún cálculo.
  begin
    update gasto set imagen_url = 'liquidaciones/re-subida.jpg' where id = v_g;
    no_financiero_pasa := true;
  exception when others then no_financiero_pasa := false;
  end;

  raise exception E'UPDATE TARDE  bloqueado=%  sqlstate=%  no-financiero-sigue-pasando=%   (esperado t / CU001 / t)',
    monto_bloqueado, msg, no_financiero_pasa;
end $$;

-- ── 21. (retirado) ──────────────────────────────────────────────────────────
-- Verificaba `foto_pendiente` (mig. 0038): unicidad por viaje y reclamo
-- atómico. AUDITORÍA 9, CRÍTICO — el mecanismo que esa tabla sostenía fusionaba
-- comprobantes DISTINTOS cuando llegaban fuera de orden (dos auditores
-- independientes, agéntico y backend); se revirtió (mig. 0041, `drop table`)
-- y este bloque ya no tiene qué comprobar. Los números 5-20 y 22+ no se
-- renumeran para no invalidar referencias existentes a ellos.

-- ── 22. La foto del ticket no es pública (mig. 0039) ────────────────────────
-- Un ticket no es un dato inocuo: trae RFC y domicilio del establecimiento, a
-- veces el nombre del titular de la tarjeta, y —en una farmacia— el nombre del
-- medicamento, que es dato SENSIBLE del art. 2 fr. VI de la LFPDPPP.
--
-- Un bucket público no falla ruidosamente: sirve. La liquidación se ve bien, el
-- panel enseña las fotos, y el expediente de gastos de toda la flota queda
-- accesible para quien adivine el nombre de un archivo, sin que nada avise. Es
-- exactamente la clase de garantía que solo la base puede demostrar y que una
-- prueba en TS con Supabase mockeado probaría contra el mock.
--
-- Se comprueba `buckets_publicos = 0` y no solo el de comprobantes: el modo de
-- falla real es que alguien cree el siguiente bucket con el default equivocado,
-- y ese día esto tiene que ponerse rojo aunque la 0039 siga bien.
--
-- Corrido el 1-ago, salida real:  1 / f / 0 / t / 0
select
  (select count(*) from storage.buckets where id='comprobantes')                    as existe,
  (select bool_or(public) from storage.buckets where id='comprobantes')             as publico,
  (select count(*) from storage.buckets where public)                               as buckets_publicos,
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='storage' and c.relname='objects')                              as rls_objects,
  (select count(*) from pg_policies
    where schemaname='storage' and tablename='objects'
      and (qual like '%comprobantes%' or with_check like '%comprobantes%'))         as policies_comprobantes;
-- existe=1 · publico=f · buckets_publicos=0 · rls_objects=t · policies=0
-- (sin policy sobre storage.objects, RLS deniega a anon/authenticated; solo el
--  service-role escribe y firma. Mismo criterio que la 0008 y la 0038.)

-- ── 23. La sala de espera no es legible por un anónimo (mig. 0040) ──────────
-- `comprobante_huerfano` guarda la EXTRACCIÓN COMPLETA de tickets que todavía
-- no tienen viaje: montos, folios, RFC del establecimiento, fechas. Es un
-- expediente de gastos de operadores de todas las flotas en una sola tabla.
--
-- Y los grants de tabla NO la protegen: `anon` y `authenticated` tienen
-- SELECT/INSERT/UPDATE/DELETE sobre ella (8 grants), porque es el default del
-- esquema `public` en Supabase. Lo ÚNICO que la cierra es el RLS sin policy.
-- O sea: la línea `alter table ... enable row level security` de la 0040 no es
-- defensa en profundidad, es la defensa.
--
-- Por eso no vale con mirar `relrowsecurity`: se comprueba LEYENDO como anon
-- con una fila sembrada. Un `enable` mal aplicado, o un `force` que falte el
-- día que la tabla cambie de dueño, se ve aquí y no en el catálogo.
--
-- Corrido el 1-ago, salida real:  anon=0 filas · service_role=1 fila
--
-- REESCRITO el 15-ago-2026 para ser autocontenido: la versión anterior sembraba
-- en una `create temp table _res` DECLARADA FUERA del `do $$`, y leía su
-- resultado con un `select * from _res` que también vivía fuera — pensado para
-- pegarse entero en el SQL editor, no para correr el bloque aislado. La
-- primera corrida automática de este archivo en CI (15-ago-2026) lo confirmó:
-- en su propia sesión, el `do $$` nunca vio la tabla temporal de la sesión
-- anterior ("relation _res does not exist"). Aquí se siembra la fila real que
-- el bloque original solo describía en el comentario, y el resultado se lee
-- del propio `raise exception`, como el resto del archivo.
do $$
declare
  v_t uuid; v_o uuid;
  n_anon int; nota_anon text; n_svc int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF HUERFANO') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P', '520000009023') returning id into v_o;
  insert into comprobante_huerfano (tenant_id, operador_id, gasto, motivo)
    values (v_t, v_o, '{"monto": 199}'::jsonb, 'sin_viaje');

  begin
    set local role anon;
    select count(*) into n_anon from comprobante_huerfano where tenant_id = v_t;
    reset role;
    nota_anon := case when n_anon = 0 then 'RLS lo deja a ciegas' else 'FUGA: anon LEE' end;
  exception when insufficient_privilege then
    reset role;
    n_anon := -1; nota_anon := 'denegado por privilegios de tabla';
  end;

  select count(*) into n_svc from comprobante_huerfano where tenant_id = v_t;

  delete from tenant where id = v_t;   -- cascade limpia operador y comprobante_huerfano

  raise exception E'COMPROBANTE_HUERFANO  anon=%  nota=%  service_role=%   (esperado 0 / RLS lo deja a ciegas / 1)',
    n_anon, nota_anon, n_svc;
end $$;
--
-- Si `anon` devuelve >0, el expediente de gastos de todas las flotas es público
-- para cualquiera con la anon key, que va en el navegador.

-- ── 24. Un UPDATE de solo `fecha` tampoco puede reescribirse tras liquidar (mig. 0042) ──
-- AUDITORÍA 9, ALTO (backend, seguridad y modelo de datos, tres auditores
-- independientes). El `when` de la 0037 (bloque 20) no incluía `fecha`;
-- `corregirFechaGasto` (repo.ts, ronda 9) hacía `UPDATE gasto SET fecha = …`
-- sin que el trigger lo viera. La fecha decide ejercicio fiscal, plazo de
-- facturación y la agrupación del tope diario de LISR 28-V — no es cosmética.
do $$
declare
  v_t uuid; v_o uuid; v_v uuid; v_g uuid;
  fecha_bloqueada boolean := false; msg text := ''; no_financiero_pasa boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF FECHA TARDE') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','520000009024') returning id into v_o;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha) values (v_t, v_v, 'diesel', 850, '2026-01-08') returning id into v_g;

  perform guardar_liquidacion_tx(v_t, v_v, 850, 1000, 150, 'cuadrada', '[]'::jsonb, 0,0,0, 'https://x/liq.pdf', 0);

  -- El re-fechado que llega tarde: ESTE es el bug.
  begin
    update gasto set fecha = '2026-08-01' where id = v_g;
    fecha_bloqueada := false;
  exception when others then fecha_bloqueada := true; msg := SQLSTATE;
  end;

  -- Control: una columna que nunca debe bloquearse sigue pasando. Era
  -- `clave_prod_serv` hasta la 0158 (DAT-07), que la metió al `when` por ser
  -- la que decide si el litro es diésel acreditable; la ruta de la imagen sí
  -- es cosmética.
  begin
    update gasto set imagen_url = 'liquidaciones/re-subida.jpg' where id = v_g;
    no_financiero_pasa := true;
  exception when others then no_financiero_pasa := false;
  end;

  raise exception E'FECHA TARDE  bloqueada=%  sqlstate=%  no-financiero-sigue-pasando=%   (esperado t / CU001 / t)',
    fecha_bloqueada, msg, no_financiero_pasa;
end $$;

-- ── 25. La sonda de triggers dice la verdad (mig. 0043) ─────────────────────
-- AUDITORÍA 9, CRÍTICO (operabilidad) — mismo motivo exacto que el bloque 13
-- (`indices_faltantes`, mig. 0030): el arranque no podía sondear 0036/0037
-- porque PostgREST no expone `pg_trigger`. `triggers_faltantes` lo resuelve
-- mirando el catálogo; este bloque prueba que la SONDA misma dice la verdad,
-- no que los triggers existan (eso ya lo comprueban los bloques 19/20/24).
do $$
declare
  inventado text[]; real_falta text[]; ninguno text[];
begin
  inventado := triggers_faltantes(array['trigger_no_existe_jamas_zzz']);
  -- Si `trg_gasto_no_tras_liquidar` aparece aquí, la 0036 no está aplicada y
  -- es una alarma de dinero, no de esta prueba.
  real_falta := triggers_faltantes(array['trg_gasto_no_tras_liquidar']);
  ninguno := triggers_faltantes(array[]::text[]);

  raise exception E'TRIGGERS_FALTANTES  ve-el-que-falta=%  calla-el-que-existe=%  vacio-no-es-null=%   (esperado t / t / t)',
    inventado = array['trigger_no_existe_jamas_zzz'],
    real_falta = '{}'::text[],
    ninguno is not null and cardinality(ninguno) = 0;
end $$;

-- ── [RETIRADO] 26 — probaba "el chofer solo ve sus propios viajes" (mig.
-- 0045) impersonando un app_user con rol `operador`. Esa sesión ya no puede
-- existir: la 0086 (7-ago-2026) retiró `operador` del dominio de
-- `app_user.rol` — el chofer solo usa WhatsApp, sin login ni RLS de sesión.
-- El bloque quedó viejo sin que nadie lo notara porque nadie lo corría: el
-- `insert into app_user (..., rol, ...) values (..., 'operador', ...)` que lo
-- armaba rebota contra `app_user_rol_dominio` antes de llegar a nada que
-- probar. Lo confirmó la primera corrida automática de este archivo en CI
-- (15-ago-2026) — exactamente el tipo de deriva que esa corrida existe para
-- atrapar.
--
-- La garantía que reemplaza a esta es más fuerte: no "no ve lo ajeno", sino
-- "no puede tener sesión". La prueba el bloque 62 (0086). Ver EXENTAS en
-- migraciones_verificadas.test.ts para 0045 (mismo criterio que 0078/0079/0081).
-- ── [antes aquí vivía el bloque 26] ─────────────────────────────────────────

-- ── 27. Cada quien solo escribe SU PROPIO avatar (mig. 0046) ─────────────────
-- El bucket `avatares` es público a propósito (foto de perfil, no un
-- comprobante fiscal — bloque 22 es el caso contrario) — lo que sí tiene
-- que aislarse es la ESCRITURA: bucket público + storage.objects sin RLS
-- de escritura = cualquier autenticado pisa el avatar de cualquiera. Se
-- impersonan dos usuarios (mismo mecanismo del bloque 26): cada uno
-- intenta escribir en SU propia carpeta (debe pasar) y en la del otro
-- (debe fallar), directo contra `storage.objects` — así se prueba la
-- policy real, no un mock.
--
-- Corrido el 3-ago, salida real:  escribe-en-su-carpeta=t  escribe-en-carpeta-ajena=f
do $$
declare
  v_u1 uuid := gen_random_uuid();
  v_u2 uuid := gen_random_uuid();
  ok_propio boolean;
  ok_ajeno boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1)::text, true);

  begin
    insert into storage.objects (bucket_id, name, owner) values ('avatares', v_u1::text || '/avatar.jpg', v_u1);
    ok_propio := true;
  exception when others then
    ok_propio := false;
  end;

  begin
    insert into storage.objects (bucket_id, name, owner) values ('avatares', v_u2::text || '/avatar.jpg', v_u1);
    ok_ajeno := true;
  exception when others then
    ok_ajeno := false;
  end;

  reset role;
  -- `storage.objects` tiene un trigger (`protect_delete`) que bloquea el
  -- DELETE directo por SQL — hay que pedirlo explícito, o el cleanup de
  -- este mismo bloque revienta.
  set local storage.allow_delete_query = 'true';
  delete from storage.objects where bucket_id = 'avatares' and name in (v_u1::text || '/avatar.jpg', v_u2::text || '/avatar.jpg');

  raise exception E'AVATARES_RLS  escribe-en-su-carpeta=%  escribe-en-carpeta-ajena=%   (esperado true / false — ajeno=true sería la fuga)',
    ok_propio, ok_ajeno;
end $$;

-- ── [RETIRADO] 28 — probaba "las tablas de operación no se le abren al
-- chofer" (mig. 0047) impersonando un app_user con rol `operador`. Mismo caso
-- que el 26: la 0086 retiró ese rol del dominio, el INSERT que armaba la
-- sesión rebota contra `app_user_rol_dominio` antes de llegar a nada que
-- probar, y nadie lo notó porque nadie corría este archivo. Confirmado por la
-- primera corrida automática en CI (15-ago-2026).
--
-- Reemplaza el bloque 62 (0086): "no puede tener sesión" cubre, por
-- construcción, que tampoco pueda leer `unidad`/`mantenimiento`/`incidencia`
-- ni el `pod` ajeno. Ver EXENTAS en migraciones_verificadas.test.ts para 0047.
-- ── [antes aquí vivía el bloque 28] ─────────────────────────────────────────

-- ── 29. El encargado NO ve dinero (mig. 0048 + 0049 + 0051) ─────────────────
-- Las tres migraciones comerciales meten seis tablas de dinero de golpe:
-- cliente, tarifa, factura_emitida, pago_recibido, factura_viaje, cotizacion.
-- El riesgo es el de la 0047 pero un escalón más arriba: ahí bastaba excluir
-- al chofer con `not is_operador()`, aquí no. El ENCARGADO (0044) es de
-- oficina —pasa ese filtro— y sin embargo no debe ver finanzas: la matriz de
-- `lib/auth/visibilidad.ts` le da 'operacion' y nada más.
--
-- Esa matriz vivía SOLO en TypeScript. Mientras el panel consulte con la
-- service role alcanza, pero cualquier usuario autenticado tiene la anon key y
-- puede pegarle a PostgREST directo: ahí la única frontera es RLS. Por eso la
-- 0048 crea `ve_finanzas()`, y esto comprueba que de verdad cierra.
--
-- Se impersona a un ENCARGADO (no a un chofer) y se cuenta. Esperado: 0 en las
-- seis. Cualquier otra cosa es una fuga de precios y saldos al jefe de tráfico.
do $$
declare
  v_t uuid; v_c uuid; v_f uuid; v_u1 uuid := gen_random_uuid();
  n_cli int; n_tar int; n_fac int; n_pag int; n_cot int; n_fv int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF FINANZAS RLS') returning id into v_t;
  insert into cliente (tenant_id, nombre, rfc) values (v_t, 'Cliente Uno', 'XAXX010101000') returning id into v_c;
  insert into tarifa (tenant_id, cliente_id, modo, precio) values (v_t, v_c, 'por_viaje', 18500.00);
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (v_t, v_c, 10000.00, 1600.00, 11600.00, 'emitida') returning id into v_f;
  insert into pago_recibido (tenant_id, factura_id, monto) values (v_t, v_f, 5000.00);
  insert into cotizacion (tenant_id, cliente_id, origen, destino, precio)
    values (v_t, v_c, 'Silao', 'Nuevo Laredo', 21000.00);

  -- Un ENCARGADO de esa misma flota: pasa `not is_operador()` y aun así no
  -- debe ver nada de esto.
  insert into app_user (id, tenant_id, email, rol)
    values (v_u1, v_t, 'zzz-verif-encargado@likida.test', 'encargado');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1)::text, true);

  select count(*) into n_cli from cliente         where tenant_id = v_t;
  select count(*) into n_tar from tarifa          where tenant_id = v_t;
  select count(*) into n_fac from factura_emitida where tenant_id = v_t;
  select count(*) into n_pag from pago_recibido   where tenant_id = v_t;
  select count(*) into n_cot from cotizacion      where tenant_id = v_t;
  select count(*) into n_fv  from factura_viaje;

  reset role;

  raise exception E'FINANZAS_RLS  clientes=%  tarifas=%  facturas=%  pagos=%  cotizaciones=%  factura_viaje=%   (esperado 0 / 0 / 0 / 0 / 0 / 0 — cualquier otra cosa le abre precios y saldos al encargado)',
    n_cli, n_tar, n_fac, n_pag, n_cot, n_fv;
end $$;

-- ── 30. El contador NO ve las credenciales de rastreo (mig. 0050) ───────────
-- Dos garantías distintas nacieron en la misma migración; hasta el 14-ago
-- este bloque probaba las dos, la segunda impersonando un chofer (rol
-- `operador`). La 0086 (7-ago-2026) retiró ese rol del dominio de
-- `app_user.rol` — el chofer ya no puede tener sesión — así que "`posicion`
-- y `geocerca` son de oficina, el chofer queda fuera" quedó cubierta por
-- construcción (bloque 62: "no puede tener sesión" es más fuerte que "no ve
-- lo ajeno"), y la mitad de este bloque que lo probaba se retiró con el
-- mismo criterio que los bloques 26 y 28 — confirmado por la primera corrida
-- automática de este archivo en CI (15-ago-2026).
--
-- Lo que SIGUE vivo, y sigue haciendo falta probarlo con datos reales:
--
--   · `rastreo_credencial` es MÁS estricta que todo lo demás del esquema:
--     solo flota_admin y superadmin. Un token de rastreo permite ver y a veces
--     MANDAR órdenes a la flota entera, así que no cabe en `ve_finanzas()` —
--     no es dinero, es control. El CONTADOR sí ve dinero (bloque 29 es al
--     revés: el encargado NO) y aun así no debe ver esto, y esa distinción es
--     justo la que un `ve_finanzas()` de más borraría sin que nadie lo note.
--
-- Esperado: contador 0 credenciales.
do $$
declare
  v_t uuid; v_conta uuid := gen_random_uuid();
  n_cred int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF RASTREO RLS') returning id into v_t;
  insert into rastreo_credencial (tenant_id, proveedor, token_ultimos4)
    values (v_t, 'wialon', '4417');

  insert into app_user (id, tenant_id, email, rol)
    values (v_conta, v_t, 'zzz-verif-gps-conta@likida.test', 'contador');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_conta)::text, true);
  select count(*) into n_cred from rastreo_credencial where tenant_id = v_t;
  reset role;

  raise exception E'RASTREO_RLS  contador-credenciales=%   (esperado 0 — la que separa "ve dinero" de "manda en la flota")',
    n_cred;
end $$;

-- ── 31. Ni la suscripción ni la invitación se duplican (mig. 0052 + 0053) ────
-- Dos unicidades parciales que solo la base puede garantizar, y las dos
-- cuestan dinero o permisos si fallan:
--
--   · dos suscripciones VIVAS para la misma flota cobran dos veces, y ninguna
--     de las dos parece equivocada mirándola sola.
--   · dos invitaciones VIVAS para el mismo correo dan dos roles distintos
--     según cuál se abra primero — un `encargado` y un `flota_admin` en la
--     misma bandeja.
--
-- Son índices PARCIALES a propósito: una suscripción cancelada y una
-- invitación revocada SÍ pueden convivir con la nueva, porque son historia.
-- Esta prueba comprueba las dos mitades: que el duplicado vivo truena y que
-- el histórico no.
do $$
declare
  v_t uuid; v_dup boolean := false; v_hist boolean := true;
begin
  insert into tenant (nombre) values ('ZZZ VERIF UNICIDAD') returning id into v_t;

  insert into suscripcion (tenant_id, plan_clave, estado) values (v_t, 'demo', 'activa');
  begin
    insert into suscripcion (tenant_id, plan_clave, estado) values (v_t, 'flota', 'activa');
    v_dup := true;   -- si llega aquí, el índice NO protege
  exception when unique_violation then
    v_dup := false;
  end;

  -- Una cancelada convive: es historia, no cobro.
  begin
    insert into suscripcion (tenant_id, plan_clave, estado, cancelada_en)
      values (v_t, 'empresa', 'cancelada', now());
  exception when unique_violation then
    v_hist := false;
  end;

  insert into invitacion (tenant_id, email, rol, token_hash, expira_en)
    values (v_t, 'Alguien@Flota.mx', 'encargado', 'hash-uno', now() + interval '7 days');
  begin
    -- MAYÚSCULAS distintas: el índice es sobre lower(email), así que esto es
    -- el MISMO correo. Sin el lower(), "Alguien@" y "alguien@" serían dos.
    insert into invitacion (tenant_id, email, rol, token_hash, expira_en)
      values (v_t, 'ALGUIEN@flota.mx', 'flota_admin', 'hash-dos', now() + interval '7 days');
    raise exception 'UNICIDAD  suscripcion-duplicada=%  historico-convive=%  invitacion-duplicada=SI   (la invitacion duplicada NO deberia entrar)', v_dup, v_hist;
  exception when unique_violation then
    raise exception E'UNICIDAD  suscripcion-duplicada=%  historico-convive=%  invitacion-duplicada=NO   (esperado false / true / NO)', v_dup, v_hist;
  end;
end $$;

-- ── 32. La bitácora no se corrige ni se borra, y no se planta (mig. 0053 + 0195) ──
-- Un registro de auditoría que su propio dueño puede editar no sirve como
-- evidencia ante nadie: ni ante el INAI, ni ante un cliente que pregunta quién
-- tocó su dato. La 0053 le da a `bitacora_auditoria` policies de SELECT e
-- INSERT y NINGUNA de UPDATE ni de DELETE — sin policy, RLS los niega, que es
-- append-only sin necesidad de un trigger.
--
-- Es fácil de romper sin querer: basta que alguien añada un `for all` "para
-- que se pueda limpiar" y la tabla deja de ser prueba de nada, en silencio.
--
-- AUDITORÍA 19 (SEGURIDAD, mig. 0195): la política de INSERT de la 0086 solo
-- exigía `tenant_id` propio, SIN filtro de rol — cualquier `app_user` de
-- CUALQUIER rol (no solo `flota_admin`) podía plantar una entrada falsa vía
-- PostgREST directo. La 0195 revoca `insert` de `authenticated`/`anon` y
-- quita la política — el único escritor real (`bitacora_escritura.ts`) usa
-- `service_role`, que bypassa RLS y estos grants por completo.
--
-- Esperado: 0 filas modificadas, 0 borradas por un flota_admin, y un
-- INSERT directo de un `encargado` (rol SIN privilegios de administración)
-- rebota por falta de privilegio — ni siquiera llega a evaluar la policy.
do $$
declare
  v_t uuid; v_admin uuid := gen_random_uuid(); v_encargado uuid := gen_random_uuid();
  n_lee int; n_upd int; n_del int; planto_encargado boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF BITACORA') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol)
    values (v_admin, v_t, 'zzz-verif-bitacora@likida.test', 'flota_admin');
  insert into app_user (id, tenant_id, email, rol)
    values (v_encargado, v_t, 'zzz-verif-bitacora-2@likida.test', 'encargado');
  insert into bitacora_auditoria (tenant_id, actor_id, accion, entidad)
    values (v_t, v_admin, 'liquidacion.emitida', 'liquidacion');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);

  select count(*) into n_lee from bitacora_auditoria where tenant_id = v_t;

  with u as (update bitacora_auditoria set accion = 'BORRADO POR EL AUDITADO'
              where tenant_id = v_t returning 1)
  select count(*) into n_upd from u;

  with d as (delete from bitacora_auditoria where tenant_id = v_t returning 1)
  select count(*) into n_del from d;

  -- El plante: un `encargado` (SIN administra_flota()) intenta insertar una
  -- entrada falsa atribuida a otra persona, en su propio tenant.
  perform set_config('request.jwt.claims', json_build_object('sub', v_encargado)::text, true);
  begin
    insert into bitacora_auditoria (tenant_id, actor_id, accion, entidad)
      values (v_t, v_admin, 'liquidacion.aprobada.FALSIFICADO', 'liquidacion');
    planto_encargado := true;
  exception when insufficient_privilege then
    planto_encargado := false;
  end;

  reset role;

  raise exception E'BITACORA  lee=%  modifica=%  borra=%  planto_encargado=%   (esperado 1 / 0 / 0 / f — si modifica, borra o planto_encargado pasan de su esperado, la bitacora ya no prueba nada)',
    n_lee, n_upd, n_del, planto_encargado;
end $$;

-- ── 33. La vista de saldos respeta el RLS de quien pregunta (mig. 0054) ──────
-- LA FUGA ENTRE INQUILINOS MÁS CARA QUE PUEDE TENER ESTE PRODUCTO, y estuvo
-- abierta entre la 0049 y la 0054.
--
-- Una vista en Postgres corre por default con los permisos de QUIEN LA CREÓ.
-- Como `factura_saldo` la creó el rol de servicio, devolvía las facturas de
-- TODAS las flotas a cualquier usuario autenticado que le pegara por PostgREST
-- —aunque `factura_emitida` tuviera su RLS perfectamente puesto—. La política
-- de la tabla NO se hereda a la vista.
--
-- No lo habría encontrado ninguna prueba de TypeScript: el código estaba bien,
-- el que estaba mal era el objeto de la base. Por eso vive aquí.
--
-- Corrido antes del arreglo:  via-tabla=1  via-vista=2   ← la 2ª era de otra flota
-- Corrido después:            via-tabla=1  via-vista=1
--
-- Se comprueba de paso que `anon` ya no puede ejecutar `ve_finanzas()`: el
-- `revoke ... from anon` de la 0048 no revocaba nada, porque el permiso venía
-- de PUBLIC y anon solo lo heredaba.
do $$
declare
  tA uuid; tB uuid; cA uuid; cB uuid; uA uuid := gen_random_uuid();
  n_tabla int; n_vista int; anon_puede boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF VISTA A') returning id into tA;
  insert into tenant (nombre) values ('ZZZ VERIF VISTA B') returning id into tB;
  insert into cliente (tenant_id, nombre) values (tA, 'Cliente A') returning id into cA;
  insert into cliente (tenant_id, nombre) values (tB, 'Cliente B') returning id into cB;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (tA, cA, 1000, 160, 1160, 'emitida');
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (tB, cB, 9999, 1599.84, 11598.84, 'emitida');
  insert into app_user (id, tenant_id, email, rol)
    values (uA, tA, 'zzz-verif-vista@likida.test', 'flota_admin');

  anon_puede := has_function_privilege('anon', 'public.ve_finanzas()', 'EXECUTE');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', uA)::text, true);
  select count(*) into n_tabla from factura_emitida;
  select count(*) into n_vista from factura_saldo;
  reset role;

  raise exception E'VISTA_SALDO  via-tabla=%  via-vista=%  anon-ejecuta-ve_finanzas=%   (esperado 1 / 1 / false — un 2 en la vista es la factura de OTRA flota)',
    n_tabla, n_vista, anon_puede;
end $$;

-- ── 34. El payload de Stripe no se le enseña a un usuario del panel (mig. 0055) ──
--
-- 0055 — el payload de Stripe no se le enseña a un usuario del panel.
--
-- `evento_stripe` guarda el evento crudo: ids de cliente, montos, correo de
-- facturación de OTRAS flotas. Es de Likida, no del cliente. La tabla tiene RLS
-- activo y UNA sola policy (superadmin), así que un flota_admin autenticado
-- tiene que ver CERO filas — no por no tener el link, sino porque la base se lo
-- niega aunque pegue directo a PostgREST.
--
-- Se comprueba de paso que el índice único del price existe: dos planes con el
-- mismo price de Stripe cobrarían lo mismo diciendo cosas distintas.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  tA uuid; uA uuid := gen_random_uuid();
  n_eventos int; hay_indice boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF STRIPE') returning id into tA;
  insert into app_user (id, tenant_id, email, rol)
    values (uA, tA, 'zzz-verif-stripe@likida.test', 'flota_admin');
  insert into evento_stripe (id, tipo, payload)
    values ('evt_zzz_verif', 'invoice.paid', '{"secreto":"de otra flota"}'::jsonb);

  select exists(
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'plan_stripe_price_unico'
  ) into hay_indice;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', uA)::text, true);
  select count(*) into n_eventos from evento_stripe;
  reset role;

  raise exception E'EVENTO_STRIPE  filas-que-ve-flota_admin=%  indice-price-unico=%   (esperado 0 / true)',
    n_eventos, hay_indice;
end $$;

-- ── 35. Los datos fiscales del CFDI son catálogo del SAT, no texto libre (mig. 0056) ──
--
-- El CFDI 4.0 exige del receptor RFC, razón social, régimen, código postal y
-- uso. Los dos últimos son CLAVES de catálogo del SAT: una clave inventada la
-- rechaza el PAC al timbrar —cuando ya cobraste— o peor, la acepta y emite un
-- comprobante que el contador del cliente no puede usar.
--
-- Se comprueba que los CHECK rechacen de verdad, y que `factura_saas` no pueda
-- quedar "timbrada" a medias: un UUID sin fecha, o al revés, haría ver como
-- facturado un cobro que no lo está.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; regimen_malo boolean := false; cp_malo boolean := false; timbre_malo boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF FISCAL') returning id into t;

  begin
    update tenant set regimen_fiscal = '999' where id = t;
  exception when check_violation then regimen_malo := true;
  end;

  begin
    update tenant set codigo_postal_fiscal = 'CP970' where id = t;
  exception when check_violation then cp_malo := true;
  end;

  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, estado, cfdi_uuid)
      values (t, current_date, current_date, 100, 'pagada', 'uuid-sin-fecha');
  exception when check_violation then timbre_malo := true;
  end;

  raise exception E'DATOS_FISCALES  regimen-invalido-rechazado=%  cp-invalido-rechazado=%  timbre-incoherente-rechazado=%   (esperado true / true / true)',
    regimen_malo, cp_malo, timbre_malo;
end $$;

-- ── 36. No se cobra dos veces el mismo mes, ni se marca pagada sin firma (mig. 0057) ──
--
-- Cobrar por transferencia no tiene webhook: alguien marca la factura a mano. Y
-- eso abre dos formas de perder dinero o credibilidad que solo la base puede
-- cerrar:
--
--   1. Apretar "emitir" dos veces le cobra el mismo mes DOS VECES a la misma
--      flota, y las dos facturas se ven legítimas. Lo impide el índice único
--      (tenant_id, periodo_inicio, periodo_fin).
--   2. Una factura "pagada" sin saber QUIÉN la marcó es la palabra de alguien
--      sin nada detrás. Lo impide el check de conciliación coherente.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; dup boolean := false; sin_firma boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF COBRO') returning id into t;

  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, estado, metodo_cobro, referencia)
    values (t, '2026-08-01', '2026-08-31', 2400, 'pendiente', 'transferencia', 'LKZZZ202608');

  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, estado, metodo_cobro, referencia)
      values (t, '2026-08-01', '2026-08-31', 2400, 'pendiente', 'transferencia', 'LKZZZ202608B');
  exception when unique_violation then dup := true;
  end;

  begin
    update factura_saas set conciliada_en = now() where tenant_id = t;   -- sin conciliada_por
  exception when check_violation then sin_firma := true;
  end;

  raise exception E'COBRO_TRANSFERENCIA  segundo-cobro-del-mes-rechazado=%  pagada-sin-firma-rechazada=%   (esperado true / true)',
    dup, sin_firma;
end $$;

-- ── 37. Un viaje no se puede aceptar sin haberse avisado (mig. 0058) ──
--
-- `avisado_en` no es un dato informativo: es lo ÚNICO que hace visible un viaje
-- para la escalación de las 5 h (`viajesSinAceptar` filtra por "avisado_en no es
-- null"). Un viaje con `aceptado_en` puesto y `avisado_en` vacío significa que
-- alguien marcó la aceptación a mano, y a partir de ahí el reloj no tiene origen:
-- ni escala ni se puede auditar cuánto tardó el chofer en contestar.
--
-- Se comprueba también que el índice parcial exista. Sin él la escalación hace
-- un recorrido completo de `viaje` en cada corrida del cron — invisible con
-- ocho viajes de prueba, caro con el histórico de una flota de 700 unidades.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; o uuid; v uuid; rechazado boolean := false; hay_indice boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF AVISO') returning id into t;
  -- `viaje.operador_id` es NOT NULL: un viaje sin chofer no existe en este
  -- modelo. Se descubrió corriendo este mismo bloque, que fue para lo que se
  -- escribió.
  insert into operador (tenant_id, nombre, telefono)
    values (t, 'ZZZ Verif', '5215559999999') returning id into o;
  insert into viaje (tenant_id, operador_id, estatus) values (t, o, 'abierto') returning id into v;

  begin
    update viaje set aceptado_en = now() where id = v;   -- sin avisado_en
  exception when check_violation then rechazado := true;
  end;

  select exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'viaje' and indexname = 'viaje_sin_aceptar_idx'
  ) into hay_indice;

  delete from tenant where id = t;

  raise exception E'CONFIRMACION_VIAJE  aceptar-sin-aviso-rechazado=%  indice-parcial=%   (esperado true / true)',
    rechazado, hay_indice;
end $$;

-- ── 38. El teléfono de una cuenta es único GLOBAL, no por flota (mig. 0059) ──
--
-- Es la llave con la que se enruta un mensaje entrante: WhatsApp trae solo el
-- número, y es ese número el que determina de qué flota se está hablando. Si dos
-- tenants pudieran registrar el mismo teléfono, el agente tendría que adivinar —
-- y adivinar aquí escribe la operación de una flota en la de otra, en silencio.
--
-- Ojo con la asimetría deliberada frente a `operador`, que sí es único POR flota:
-- ahí el desempate existe (`resolveOperador` se niega ante dos filas y lanza
-- OperadorAmbiguo). Para las cuentas de oficina se prefirió que la base lo haga
-- imposible en vez de detectarlo tarde.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t1 uuid; t2 uuid; u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  rechazado boolean := false; dos_nulos boolean := true;
begin
  insert into tenant (nombre) values ('ZZZ VERIF TEL A') returning id into t1;
  insert into tenant (nombre) values ('ZZZ VERIF TEL B') returning id into t2;

  insert into app_user (id, tenant_id, email, rol, telefono)
    values (u1, t1, 'zzz-verif-a@likida.test', 'flota_admin', '5215550000001');

  begin
    -- mismo número, OTRA flota: tiene que reventar
    insert into app_user (id, tenant_id, email, rol, telefono)
      values (u2, t2, 'zzz-verif-b@likida.test', 'flota_admin', '5215550000001');
  exception when unique_violation then rechazado := true;
  end;

  -- ...pero el índice es PARCIAL: dos cuentas sin teléfono conviven sin problema,
  -- que es el caso normal (se entra por correo, el teléfono es opcional).
  begin
    insert into app_user (id, tenant_id, email, rol) values (gen_random_uuid(), t1, 'zzz-verif-c@likida.test', 'contador');
    insert into app_user (id, tenant_id, email, rol) values (gen_random_uuid(), t2, 'zzz-verif-d@likida.test', 'contador');
  exception when unique_violation then dos_nulos := false;
  end;

  delete from tenant where id in (t1, t2);

  raise exception E'TELEFONO_CUENTA  duplicado-entre-flotas-rechazado=%  dos-sin-telefono-permitido=%   (esperado true / true)',
    rechazado, dos_nulos;
end $$;

-- ── 39. La cola de facturación NO recorre la tabla entera (mig. 0060) ──
--
-- El cron de facturación busca `cfdi_uuid is null`. El único índice que tocaba
-- esa columna era PARCIAL sobre lo contrario (`where cfdi_uuid is not null`),
-- así que Postgres no lo podía usar para los nulos: cada corrida recorría la
-- tabla completa y la ordenaba por fecha para quedarse con ocho filas.
--
-- ESTE BLOQUE NO COMPRUEBA QUE EL ÍNDICE EXISTA — comprueba que el PLANEADOR LO
-- ELIJA, que es lo único que importa. Un índice que está y no se usa se ve igual
-- de bien en `pg_indexes` y cuesta lo mismo de mantener.
--
-- Por eso se cargan 3,000 filas y se hace ANALYZE antes del EXPLAIN: sobre una
-- tabla vacía el planeador siempre prefiere el recorrido completo —es más
-- barato de verdad— y la verificación pasaría en verde sin probar nada. Es el
-- mismo modo de falla que el falso verde del `curl` que miraba el código HTTP y
-- no el cuerpo. Todo se revierte con el `raise`.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; o uuid; v uuid; r record; plan text := ''; usa_indice boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF INDICE') returning id into t;
  insert into operador (tenant_id, nombre, telefono)
    values (t, 'ZZZ Indice', '5215558888888') returning id into o;
  insert into viaje (tenant_id, operador_id, estatus) values (t, o, 'abierto') returning id into v;

  -- 3,000 pendientes y 3,000 ya facturados: la mezcla importa, porque el indice
  -- es parcial y su ventaja esta justo en no cargar con los facturados.
  insert into gasto (tenant_id, viaje_id, concepto, monto, created_at, cfdi_uuid, ocr_extra)
  select t, v, 'diesel', 100,
         now() - (g || ' minutes')::interval,
         case when g % 2 = 0 then null else gen_random_uuid()::text end,
         '{}'::jsonb
  from generate_series(1, 6000) g;

  analyze gasto;

  -- EXPLAIN devuelve VARIAS filas: hay que recorrerlas. Un `execute ... into`
  -- se queda con la primera, que suele ser el `Limit` y no dice que scan hubo.
  for r in execute 'explain select id, tenant_id from gasto
                    where cfdi_uuid is null and ocr_extra is not null
                    order by created_at asc limit 9'
  loop
    plan := plan || r."QUERY PLAN" || ' | ';
  end loop;

  usa_indice := plan ilike '%gasto_por_facturar_idx%';

  delete from tenant where id = t;

  -- PRU-1 (auditoría 24): este bloque decía «(esperado true)» y salía SIN
  -- CALIFICAR (verde) con `usa-el-indice=f`. Medido el 1-sep-2026 en Postgres
  -- 17 con las 257 migraciones: el planeador prefiere `gasto_created_at_idx`
  -- con filtro (cost 2.58 para 9 filas) porque con la mezcla 50/50 del
  -- fixture el índice parcial no ahorra nada; con `random_page_cost=1.1` da lo
  -- mismo. Lo que este bloque mide depende del volumen y de la versión del
  -- planeador, así que se declara REPORTE (sin `(esperado …)`): el runner lo
  -- lista aparte y nunca lo cuenta como pase. Para volverlo aserción hay que
  -- sembrar la mezcla de producción (≥95 % ya facturados) y volver a medir.
  raise exception E'INDICE_FACTURACION  [reporte: depende del volumen y del planeador — ver nota]  el-planeador-usa-el-indice=%  plan=%',
    usa_indice, plan;
end $$;

-- ── 40. Los índices de paginación se USAN, no solo existen (mig. 0061) ──
--
-- `traerTodo()` (src/lib/likida/pg.ts) pagina SIEMPRE con `.order('id')`, en 50
-- llamadas del repo. No existía un solo índice `(tenant_id, id)`: los que había
-- sirven para filtrar por tenant, no para entregar ordenado por id dentro de él
-- (`gasto_id_tenant_key` es `(id, tenant_id)`, con las columnas al revés). El
-- planeador filtraba y luego ORDENABA todas las filas del tenant para devolver
-- una página de mil — repetido en cada una de las 100 páginas.
--
-- Igual que el bloque 39, ESTE BLOQUE NO COMPRUEBA QUE LOS ÍNDICES EXISTAN.
-- Comprueba que el planeador los ELIJA. Un índice que está y no se usa se ve
-- idéntico en `pg_indexes` y cuesta lo mismo de mantener en cada insert.
--
-- Se piden DOS condiciones por caso, no una: que el plan nombre el índice Y que
-- no quede ningún `Sort Key`. Solo la primera no basta — el planeador puede
-- tomar el índice únicamente para filtrar y dejar el sort en pie, que es
-- exactamente el defecto que la 0061 vino a quitar.
--
-- DOS TRAMPAS QUE ESTE BLOQUE ESQUIVA A PROPÓSITO:
--
--  1. Volumen. Sobre tabla vacía el recorrido completo es de verdad más barato
--     y el planeador lo prefiere: la verificación pasaría en verde sin probar
--     nada. Por eso se cargan ~75 mil filas y se hace ANALYZE antes del EXPLAIN.
--
--  2. Tenant único. Si un solo tenant tiene el 100% de las filas, el filtro por
--     tenant_id no descarta nada y el planeador se conforma con recorrer la PK
--     filtrando — sin `Sort`, en verde, y sin usar el índice nuevo. Se midió:
--     con un tenant el plan sale limpio solo. Por eso se siembran DIEZ tenants
--     y se consulta el primero, que es la forma real de la base multi-tenant.
--
-- Falsificado: corriendo este mismo bloque con los 9 índices tirados dentro de
-- la transacción da 0/9. Con ellos, 9/9. Todo se revierte con el `raise`.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; o uuid; v uuid; objetivo uuid; i int;
  r record; chk record;
  plan text; usados int := 0; total int := 0; fallos text := '';
begin
  for i in 1..10 loop
    insert into tenant (nombre) values ('ZZZ VERIF PAG '||i) returning id into t;
    if i = 1 then objetivo := t; end if;
    insert into operador (tenant_id, nombre, telefono)
      values (t, 'ZZZ Pag '||i, '52155577700'||lpad(i::text,2,'0')) returning id into o;

    insert into viaje (tenant_id, operador_id, estatus, created_at)
      select t, o, 'liquidado', now() - (g||' minutes')::interval from generate_series(1,800) g;

    -- Un viaje se queda SIN liquidación a propósito: es el que hospeda los
    -- gastos, porque `trg_gasto_no_tras_liquidar` (mig. 0036) rechaza cualquier
    -- gasto sobre un viaje ya liquidado.
    select id into v from viaje where tenant_id = t limit 1;
    insert into liquidacion (tenant_id, viaje_id)
      select tenant_id, id from viaje where tenant_id = t and id <> v;
    insert into pod (tenant_id, viaje_id, estado)
      select tenant_id, id, 'pendiente' from viaje where tenant_id = t and id <> v;

    insert into gasto (tenant_id, viaje_id, concepto, monto, created_at, ocr_extra)
      select t, v, 'diesel', 100, now() - (g||' minutes')::interval, '{}'::jsonb
      from generate_series(1,2000) g;
    insert into llm_costo (tenant_id, fase, modelo, tokens_in, tokens_out, costo_usd)
      select t, 'ocr', 'haiku', 100, 50, 0.001 from generate_series(1,2500) g;
    insert into comprobante_huerfano (tenant_id, operador_id, gasto, motivo)
      select t, o, '{}'::jsonb, 'sin_viaje' from generate_series(1,300) g;
    insert into incidencia (tenant_id, tipo, prioridad, estado)
      select t, 'retraso', 'media', 'abierta' from generate_series(1,300) g;
  end loop;

  analyze gasto; analyze viaje; analyze liquidacion; analyze llm_costo;
  analyze pod; analyze incidencia; analyze comprobante_huerfano;

  for chk in
    select * from (values
      ('gasto/id',       'gasto_paginacion_idx',
       format('select id from gasto where tenant_id=%L order by id limit 1000 offset 1000', objetivo)),
      ('viaje/id',       'viaje_paginacion_idx',
       format('select id from viaje where tenant_id=%L order by id limit 1000 offset 500', objetivo)),
      ('liquidacion/id', 'liquidacion_paginacion_idx',
       format('select id from liquidacion where tenant_id=%L order by id limit 1000 offset 500', objetivo)),
      ('llm_costo/id',   'llm_costo_paginacion_idx',
       format('select fase from llm_costo where tenant_id=%L order by id limit 1000 offset 1000', objetivo)),
      ('huerfano/id',    'comprobante_huerfano_paginacion_idx',
       format('select resuelto_en from comprobante_huerfano where tenant_id=%L order by id limit 1000 offset 0', objetivo)),
      ('pod/id',         'pod_paginacion_idx',
       format('select estado from pod where tenant_id=%L order by id limit 1000 offset 500', objetivo)),
      ('incidencia/id',  'incidencia_paginacion_idx',
       format('select estado from incidencia where tenant_id=%L order by id limit 1000 offset 0', objetivo)),
      -- Las dos bandejas que NO paginan: ordenan por fecha para enseñar 100.
      ('gasto/created',  'gasto_reciente_idx',
       format('select id, concepto, monto from gasto where tenant_id=%L order by created_at desc limit 100', objetivo)),
      ('viaje/created',  'viaje_reciente_idx',
       format('select id, folio, estatus from viaje where tenant_id=%L order by created_at desc limit 100', objetivo))
    ) as v(caso, indice, consulta)
  loop
    total := total + 1;
    plan := '';
    -- EXPLAIN devuelve VARIAS filas: hay que recorrerlas. Un `execute ... into`
    -- se queda con la primera, que suele ser el `Limit` y no dice qué scan hubo.
    for r in execute 'explain ' || chk.consulta loop
      plan := plan || r."QUERY PLAN" || ' | ';
    end loop;

    -- `position()` y no `like`: el nombre del índice lleva guiones bajos, que en
    -- LIKE son comodín de un carácter y harían pasar un índice parecido.
    if position(chk.indice in plan) > 0 and position('Sort Key' in plan) = 0 then
      usados := usados + 1;
    else
      fallos := fallos || E'\n  · ' || chk.caso || ' NO usa ' || chk.indice || ' -> ' || plan;
    end if;
  end loop;

  delete from tenant where nombre like 'ZZZ VERIF PAG %';

  -- PRU-1 (auditoría 24): `usados=2/9` contra «esperado 9/9» partía por la
  -- barra y el bloque quedaba SIN CALIFICAR (verde) con siete índices sin usar.
  -- Medido el 1-sep-2026 en Postgres 17 con las 257 migraciones: 2/9 — el
  -- planeador toma el índice de tenant + Sort de ~2,000 filas (cost ~573) en
  -- vez de `(tenant_id, id)`; con `random_page_cost=1.1` igual. Depende del
  -- volumen del fixture y de la versión del planeador, así que se declara
  -- REPORTE (sin `(esperado …)`): el runner lo lista aparte y nunca lo cuenta
  -- como pase. Para volverlo aserción: sembrar ≥20,000 filas por tenant y
  -- volver a medir; el `fallos=` trae el plan de cada índice que no se usó.
  raise exception E'INDICES_PAGINACION  [reporte: depende del volumen y del planeador — ver nota]  usados=%  total=%  fallos=%',
    usados, total, coalesce(nullif(fallos, ''), '—');
end $$;

-- ── 41. El resumen de costo de IA suma lo MISMO que sumaba JavaScript (mig. 0062) ──
--
-- La 0062 movió a SQL la agregación de `llm_costo` que `getResumenNegocio` hacía
-- trayendo la tabla entera a memoria. Mover una suma de dinero de un lenguaje a
-- otro es exactamente el cambio que puede salir mal SIN QUE NADA FALLE: la
-- consola sigue pintando una cifra, solo que otra. Y es la cifra con la que se
-- pone el precio del producto.
--
-- ESTE BLOQUE NO COMPRUEBA QUE LA FUNCIÓN EXISTA. Comprueba que sus seis partes
-- cuadran, y por TRES caminos independientes:
--
--   1. la función (un `Seq Scan` + `MixedAggregate` con `grouping sets`),
--   2. seis `group by` sueltos —otro plan, otro algoritmo— con el mismo filtro,
--   3. la identidad aritmética `Σ(1..N)·0.000001 = N(N+1)/2 · 0.000001`, que no
--      depende de Postgres ni de JavaScript y por eso es la única capaz de
--      atrapar un error que los DOS caminos de SQL cometieran igual.
--
-- Se siembran 124,000 filas A PROPÓSITO: 120,000 pasan el techo de `traerTodo`
-- (100,000 filas, `src/lib/likida/pg.ts`), o sea que este bloque agrega en SQL
-- justo la lectura que el camino viejo ya no puede completar. Con mil filas la
-- verificación pasaría en verde sin tocar el motivo de la migración.
--
-- Los valores son conocidos, no aleatorios: `costo_usd = g × 0.000001` para
-- g = 1..120,000. Así el total tiene forma cerrada (7,200.060000) y un error de
-- una millonésima se ve.
--
-- DE REGALO, LA MEDIDA DE LO QUE SE GANÓ: se reporta `deriva-float`, la
-- diferencia entre sumar esas mismas filas en `float8` —lo que hacía el
-- JavaScript, `costoIaUsd += Number(f.costo_usd)`— y el total exacto. No es una
-- aserción (el tamaño del error depende del orden en que el planeador sume), es
-- la evidencia de por qué la suma se quedó en `numeric` de punta a punta.
--
-- LA TRAMPA DE `viaje.operador_id` NO APLICA AQUÍ: la única FK NOT NULL de
-- `llm_costo` es `tenant_id` (mig. 0003); `viaje_id` y `liquidacion_id` son
-- nullables. Con crear los dos tenants basta — no hace falta operador ni viaje.
--
-- Los permisos se leen del CATÁLOGO y no atacando la API, por lo mismo que el
-- bloque 16: un `do $$` corre como el dueño y probar con un INSERT probaría el
-- privilegio de quien corre la prueba, no la garantía.
--
-- Todo se revierte con el `raise`. Deja ~124 mil tuplas muertas que autovacuum
-- recoge; es el mismo precio que ya paga el bloque 40.
--
-- ── CORRIDO EL 5-AGO-2026 CONTRA EL PROYECTO LIKIDA. SALIDA REAL: ───────────
--
--   41  total-cerrado=t  tokens=t  fase=t  modelo=t  fase+modelo=t  dia=t
--       tenant=t  sin-ventana=t  ventana-vacia=t  borde-semiabierto=t
--       hay-filas-en-el-borde=28000
--       es-definer=f  anon=f  authenticated=f  service_role=t
--       esperado-cerrado=7202.0600000000000000   deriva-float8=0.0000000004100000
--
-- `deriva-float8` es la evidencia, no una aserción: sumar esas 124,000 filas en
-- punto flotante se aleja 4.1 × 10⁻¹⁰ del total exacto. Con 790 mil filas al año
-- ese error crece y siempre en la misma dirección; por eso la suma se quedó en
-- `numeric` hasta el final.
--
-- ── FALSIFICADO, que es lo que separa esto de un verde de adorno ────────────
-- Se corrió el mismo bloque con la función ROTA a propósito, dentro de la misma
-- transacción que lo revierte todo (`create or replace function` es
-- transaccional, así que la rotura se deshace con el `raise`):
--
--   · función que suma solo un SUBCONJUNTO de la tabla (el recorte silencioso)
--       → total-cerrado=f   devolvió 1542.882858 donde esperaba 1800.030000
--   · `porFase` sin el guardia `g_modelo = 1`, así que las filas del corte
--     (fase, modelo) se cuelan y cada fase se cuenta dos veces
--       → fase=f   `porFase` con 6 entradas donde debía haber 2
--   · corte de fecha CERRADO (`<=` en vez de `<`)
--       → borde-semiabierto=f   devolvió n=12000 donde esperaba n=8000
--
-- Y una rotura que este bloque NO atrapa, dicha en voz alta para que nadie la
-- crea cubierta: sumar en `float8` con 60,000 filas devuelve exactamente
-- 1800.03 —el `::numeric` redondea la deriva— y el bloque pasa en verde. La
-- suma en punto flotante no falla en pequeño: falla en grande, que es donde
-- este bloque siembra 124,000 filas y donde `deriva-float8` deja de ser cero.
--
-- ── Y COMPROBADO CONTRA EL CAMINO VIEJO, CON DATOS REALES ──────────────────
-- Aparte del bloque, se trajeron las 131 filas reales de `llm_costo` y se
-- sumaron en JavaScript con el código EXACTO que la 0062 sustituye (`costoIaUsd
-- += Number(f.costo_usd)`, los cuatro `Map`, el mismo `round2`). Las nueve
-- partes salieron idénticas —total, tokens, porFase, porModelo, porFaseModelo,
-- porDia y porTenant— con el mismo total, 1.832202000000. Es la prueba que un
-- bloque de SQL no puede darse solo: que el lenguaje al que se mudó la suma
-- devuelve lo mismo que el que la hacía.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  ta uuid; tb uuid;
  filas_a int := 120000;   -- > 100,000: el techo donde `traerTodo` ya lanza
  filas_b int := 4000;
  d0 timestamptz := timestamptz '2099-01-01 00:00:00+00';  -- lejos de los datos reales
  ventana_fin timestamptz;
  j jsonb; j_todo jsonb; j_vacia jsonb; j_borde jsonb;
  cerrado numeric; deriva numeric;
  ok_cerrado boolean; ok_fase boolean; ok_modelo boolean; ok_fasemodelo boolean;
  ok_dia boolean; ok_tenant boolean; ok_tokens boolean;
  ok_todo boolean; ok_vacia boolean; ok_borde boolean;
  hay_borde bigint;
  anon_ok boolean; auth_ok boolean; svc_ok boolean; definer boolean;
begin
  ventana_fin := d0 + interval '30 days';

  insert into tenant (nombre) values ('ZZZ VERIF AGG A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF AGG B') returning id into tb;

  -- Valores CONOCIDOS: costo = g millonésimas, cinco días, dos fases, dos modelos.
  insert into llm_costo (tenant_id, fase, modelo, tokens_in, tokens_out, costo_usd, created_at)
  select ta,
         case when g % 2 = 0 then 'ocr' else 'cuadre' end,
         case when g % 3 = 0 then 'zzz-caro' else 'zzz-barato' end,
         g % 7, g % 11,
         (g * 0.000001)::numeric(10,6),
         d0 + ((g % 5) || ' days')::interval
  from generate_series(1, filas_a) g;

  -- Segunda flota, para que `porTenant` tenga contra qué separar.
  insert into llm_costo (tenant_id, fase, modelo, tokens_in, tokens_out, costo_usd, created_at)
  select tb, 'router', 'zzz-barato', 1, 1, 0.000500, d0 + interval '2 days'
  from generate_series(1, filas_b) g;

  analyze llm_costo;

  j := resumen_costo_ia(d0, ventana_fin);

  -- ── CAMINO 3: la aritmética, que no sabe de motores ───────────────────────
  cerrado := 0.000001::numeric * filas_a::numeric * (filas_a + 1)::numeric / 2
             + filas_b::numeric * 0.000500::numeric;
  ok_cerrado := (j -> 'totales' ->> 'costoUsd')::numeric = cerrado
                and (j -> 'totales' ->> 'n')::bigint = (filas_a + filas_b)::bigint;

  -- Lo que el JavaScript hacía: acumular en punto flotante. Se reporta, no se afirma.
  deriva := (select sum(costo_usd::float8) from llm_costo
              where created_at >= d0 and created_at < ventana_fin)::numeric - cerrado;

  ok_tokens := (j -> 'totales' ->> 'tokensIn')::bigint
                 = (select sum(tokens_in) from llm_costo where created_at >= d0 and created_at < ventana_fin)
             and (j -> 'totales' ->> 'tokensOut')::bigint
                 = (select sum(tokens_out) from llm_costo where created_at >= d0 and created_at < ventana_fin);

  -- ── CAMINO 2: seis `group by` sueltos, mismo filtro, otro plan ────────────
  ok_fase := (j -> 'porFase') = coalesce((
    select jsonb_agg(jsonb_build_object('fase', s.fase, 'n', s.cuantas, 'costoUsd', s.costo)
                     order by s.costo desc, s.fase)
      from (select fase, count(*) cuantas, sum(costo_usd) costo from llm_costo
             where created_at >= d0 and created_at < ventana_fin group by fase) s), '[]'::jsonb);

  ok_modelo := (j -> 'porModelo') = coalesce((
    select jsonb_agg(jsonb_build_object('modelo', s.modelo, 'n', s.cuantas, 'costoUsd', s.costo)
                     order by s.costo desc, s.modelo)
      from (select modelo, count(*) cuantas, sum(costo_usd) costo from llm_costo
             where created_at >= d0 and created_at < ventana_fin group by modelo) s), '[]'::jsonb);

  ok_fasemodelo := (j -> 'porFaseModelo') = coalesce((
    select jsonb_agg(jsonb_build_object('fase', s.fase, 'modelo', s.modelo, 'n', s.cuantas, 'costoUsd', s.costo)
                     order by s.costo desc, s.fase, s.modelo)
      from (select fase, modelo, count(*) cuantas, sum(costo_usd) costo from llm_costo
             where created_at >= d0 and created_at < ventana_fin group by fase, modelo) s), '[]'::jsonb);

  ok_dia := (j -> 'porDia') = coalesce((
    select jsonb_agg(jsonb_build_object('dia', to_char(s.d, 'YYYY-MM-DD'),
                                        'costoUsd', s.costo, 'tokens', s.t_in + s.t_out)
                     order by s.d)
      from (select (created_at at time zone 'UTC')::date d, sum(costo_usd) costo,
                   sum(tokens_in) t_in, sum(tokens_out) t_out
              from llm_costo where created_at >= d0 and created_at < ventana_fin
             group by 1) s), '[]'::jsonb);

  ok_tenant := (j -> 'porTenant') = coalesce((
    select jsonb_agg(jsonb_build_object('tenantId', s.tid, 'costoUsd', s.costo) order by s.costo desc)
      from (select tenant_id tid, sum(costo_usd) costo from llm_costo
             where created_at >= d0 and created_at < ventana_fin group by tenant_id) s), '[]'::jsonb);

  -- ── Sin ventana: tiene que cuadrar contra la tabla ENTERA, datos reales incluidos ──
  j_todo := resumen_costo_ia(null, null);
  ok_todo := (j_todo -> 'totales' ->> 'costoUsd')::numeric = (select sum(costo_usd) from llm_costo)
         and (j_todo -> 'totales' ->> 'n')::bigint = (select count(*) from llm_costo);

  -- ── Una ventana sin filas da CEROS MEDIDOS y arreglos vacíos, no null ──────
  -- Es el estado "Likida recién arrancando": el panel tiene que pintar $0, no
  -- reventar ni enseñar un hueco.
  j_vacia := resumen_costo_ia(d0 + interval '100 years', d0 + interval '101 years');
  ok_vacia := (j_vacia -> 'totales' ->> 'n')::bigint = 0
          and (j_vacia -> 'totales' ->> 'costoUsd')::numeric = 0
          and j_vacia -> 'porFase' = '[]'::jsonb
          and j_vacia -> 'porDia' = '[]'::jsonb
          and j_vacia -> 'porTenant' = '[]'::jsonb;

  -- ── El corte es SEMIABIERTO: la fila del borde no se cuenta dos veces ──────
  -- Sin filas exactamente en el borde esto pasaría por vacío, así que primero se
  -- comprueba que las hay (`hay-filas-en-el-borde`).
  hay_borde := (select count(*) from llm_costo where created_at = d0 + interval '2 days');
  j_borde := resumen_costo_ia(d0, d0 + interval '2 days');
  ok_borde := (j_borde -> 'totales' ->> 'n')::bigint =
              (select count(*) from llm_costo where created_at >= d0 and created_at < d0 + interval '2 days');

  -- ── Permisos, leídos del catálogo ─────────────────────────────────────────
  select p.prosecdef,
         has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
    into definer, anon_ok, auth_ok, svc_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resumen_costo_ia';

  delete from tenant where nombre like 'ZZZ VERIF AGG %';

  raise exception E'RESUMEN_COSTO_IA  total-cerrado=%  tokens=%  fase=%  modelo=%  fase+modelo=%  dia=%  tenant=%  sin-ventana=%  ventana-vacia=%  borde-semiabierto=%  hay-filas-en-el-borde=%\n                  es-definer=%  anon=%  authenticated=%  service_role=%\n                  esperado-cerrado=%   deriva-float8=%\n                  (esperado t / t / t / t / t / t / t / t / t / t / >0 / f / f / f / t / cifra de referencia / <0.01)',
    ok_cerrado, ok_tokens, ok_fase, ok_modelo, ok_fasemodelo, ok_dia, ok_tenant,
    ok_todo, ok_vacia, ok_borde, hay_borde,
    definer, anon_ok, auth_ok, svc_ok,
    cerrado, deriva;
end $$;

-- ── 42. Lo que faltaba para operar de verdad (mig. 0063) ──
--
-- Tres huecos de tres auditorías distintas. Ninguno se nota con 8 viajes de
-- prueba; los tres muerden el primer día con una flota real.
--
-- 1. LA COLA DE FACTURACIÓN SE BLOQUEABA A SÍ MISMA. El cron elegía los 8 más
--    viejos sin CFDI, y `facturarAlVuelo` no marcaba nada cuando la decisión
--    era "no procede". Esos 8 se re-elegían para siempre: a 660 comprobantes
--    diarios, la facturación automática dejaba de alcanzar comprobantes NUEVOS
--    en la primera hora. Se marca el INTENTO, no el resultado — un ticket que
--    no procede hoy puede proceder mañana, así que la marca ordena la cola en
--    vez de sacarlo de ella. Se comprueba que el planeador USE el índice nuevo.
--
-- 2. Retenciones: `gasto` solo guardaba impuestos trasladados, así que el 4%
--    de IVA del autotransporte no se podía mostrar sin inventarlo.
--
-- 3. `portal_credencial` guarda USUARIO y REFERENCIA al secreto, jamás el
--    secreto. El check no es criptografía, es un pasamanos contra el error
--    honesto: el día que alguien pegue la contraseña real en `secreto_ref`, la
--    base lo rechaza. Y la tabla queda con RLS y SIN políticas a propósito —
--    solo la toca el proceso de facturación con service-role; ni el contador
--    ni el dueño tienen por qué ver con qué usuario entra el robot.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; o uuid; v uuid; r record; plan text := '';
  rechaza_secreto boolean := false; sin_politicas boolean; rls_on boolean; usa_indice boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0063') returning id into t;
  insert into operador (tenant_id, nombre, telefono) values (t,'ZZZ','5215557777777') returning id into o;
  insert into viaje (tenant_id, operador_id, estatus) values (t,o,'abierto') returning id into v;

  begin
    insert into portal_credencial (tenant_id, comercio, usuario, secreto_ref)
      values (t, 'oxxo_gas', 'flota@x.mx', 'MiC0ntra$ena!');
  exception when check_violation then rechaza_secreto := true;
  end;
  insert into portal_credencial (tenant_id, comercio, usuario, secreto_ref)
    values (t, 'oxxo_gas', 'flota@x.mx', 'PORTAL_OXXOGAS_PASS');

  select relrowsecurity into rls_on from pg_class where oid='public.portal_credencial'::regclass;
  select count(*)=0 into sin_politicas from pg_policies where tablename='portal_credencial';

  insert into gasto (tenant_id, viaje_id, concepto, monto, created_at, cfdi_uuid, autofactura_intentada_en)
  select t, v, 'diesel', 100, now()-(g||' minutes')::interval,
         case when g%3=0 then gen_random_uuid()::text else null end,
         case when g%5=0 then now()-(g||' hours')::interval else null end
  from generate_series(1,9000) g;
  analyze gasto;

  for r in execute 'explain select id from gasto where cfdi_uuid is null
                    order by autofactura_intentada_en nulls first, created_at limit 8'
  loop plan := plan || r."QUERY PLAN" || ' | '; end loop;
  usa_indice := plan ilike '%gasto_por_facturar_idx%';

  delete from tenant where id = t;
  raise exception E'FALTA_PARA_OPERAR  rechaza-contrasena=%  rls=%  sin-politicas=%  cola-usa-indice=%   (esperado t / t / t / t)',
    rechaza_secreto, rls_on, sin_politicas, usa_indice;
end $$;

-- ── 43. Las agregaciones del panel del CLIENTE cuadran y NO cruzan flotas (mig. 0064) ──
--
-- La 0064 movió a SQL dos lecturas que se traían la tabla entera de una flota.
-- Una de ellas —`getResumenCosto`— no esperaba a crecer: iba SIN paginar, así
-- que PostgREST la recortaba a `max_rows` (1,000) en silencio y el resultado
-- salía con `estado: 'medido'`. Una cifra incompleta con la etiqueta de medida.
--
-- Este bloque comprueba TRES cosas, y la primera es la que no tenía la 0062:
--
--  1. **AISLAMIENTO.** Estas funciones las llama `service_role`, que salta RLS.
--     El `where tenant_id = p_tenant` es lo ÚNICO que separa a una flota de
--     otra. Se siembran DOS flotas con números distintos y se exige que las
--     cifras de la primera no contengan ni un centavo ni una fase de la
--     segunda. Con una sola flota esta comprobación pasaría siempre sin probar
--     nada — es la misma trampa del tenant único que ya esquiva el bloque 40.
--
--  2. **QUE CUADRAN**, por tres caminos como el bloque 41: la función, unos
--     `group by` sueltos, y la identidad aritmética `Σ(1..N)·10⁻⁶`.
--
--  3. **QUE EL RECORTE ESTABA AHÍ.** Se reproduce el bug: se suma lo que
--     devolvía la consulta vieja (las primeras 1,000 filas) y se comprueba que
--     NO es el total. `recorte-daba-menos=t` es la prueba de que esto no era
--     una mejora de rendimiento sino un número equivocado en pantalla.
--
-- TRAMPAS DE SIEMBRA: `viaje.operador_id` es NOT NULL, así que para poner
-- gastos hace falta tenant → operador → viaje. El viaje se deja ABIERTO porque
-- `trg_gasto_no_tras_liquidar` (mig. 0036) rechaza gastos sobre uno liquidado.
-- `llm_costo.fase` tiene dominio (mig. 0025): solo ocr | cuadre | escalacion |
-- chat | router | whatsapp. `gasto.concepto` también.
--
-- Los permisos se leen del CATÁLOGO, por lo mismo que el bloque 16.
-- Todo se revierte con el `raise`.
--
-- ── CORRIDO EL 5-AGO-2026 CONTRA EL PROYECTO LIKIDA. SALIDA REAL: ───────────
--
--   RESUMEN_POR_TENANT
--     costo: cerrado=t  fase=t  viajes=t  tokens=t  AISLADO=t  sin-fase-ajena=t
--     docs:  procesados=t  porMes=t  AISLADO=t  solo-ocr=t
--     ventana-vacia=t  borde-semiabierto=t  hay-filas-en-el-borde=1250
--     EL-RECORTE-DABA-MENOS=t   (1000 filas: 0.500500  ·  total real: 12.5025)
--     permisos costo: definer=f anon=f auth=f svc=t
--     permisos docs:  definer=f anon=f auth=f svc=t
--
-- **0.500500 de 12.502500 — el 4%.** Ese es el tamaño del bug que había: con
-- 5,000 llamadas al modelo, el panel del cliente enseñaba el 4% de su costo de
-- IA, con `estado: 'medido'`. No hacía falta esperar a nada; solo pasar de mil.
--
-- ── FALSIFICADO ────────────────────────────────────────────────────────────
-- Se corrió el mismo bloque con las DOS funciones rotas a propósito, dentro de
-- la transacción que lo revierte todo (`create or replace function` es
-- transaccional, así que la rotura se deshace con el `raise`):
--
--   · se cae el `where tenant_id = p_tenant` de la función de costo
--       → AISLADO=f          devolvió $3.501000 (A+B) donde A sola vale $2.001000
--       → sin-fase-ajena=f   la fase 'router', que solo existe en la flota B,
--                            apareció en el desglose de la flota A
--   · `count(viaje_id)` en vez de `count(distinct viaje_id)`
--       → viajes=f           devolvió 1333 donde debía decir 2
--   · se cae el `ocr_confianza is not null` de la de documentos
--       → procesados=f       devolvió 900 donde debía decir 600
--       → solo-ocr=f         los 300 capturados a mano contados como trabajo del
--                            Agente OCR
--
-- Las dos primeras son la razón por la que este bloque siembra DOS flotas: con
-- una sola, quitar el filtro por tenant no cambia ni un número y la
-- verificación pasa en verde sobre una función que ya no aísla nada.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; v1 uuid; v2 uuid; v3 uuid; vb uuid;
  filas_a int := 5000;    -- > 1,000: pasa el recorte silencioso de PostgREST
  filas_b int := 4000;
  gastos_a int := 3000;
  j_a jsonb; j_b jsonb; d_a jsonb; d_b jsonb; j_vacia jsonb; j_borde jsonb;
  cerrado numeric; recortado numeric;
  ok_cerrado boolean; ok_fase boolean; ok_viajes boolean; ok_tokens boolean;
  ok_aislado boolean; ok_sin_fase_ajena boolean;
  ok_docs boolean; ok_mes boolean; ok_docs_aislado boolean; ok_solo_ocr boolean;
  ok_vacia boolean; ok_borde boolean; recorte_daba_menos boolean;
  hay_borde bigint;
  def_a boolean; def_d boolean;
  anon_a boolean; auth_a boolean; svc_a boolean;
  anon_d boolean; auth_d boolean; svc_d boolean;
  d0 timestamptz := timestamptz '2099-01-01 00:00:00+00';
begin
  -- ── FLOTA A: la que se mide ───────────────────────────────────────────────
  insert into tenant (nombre) values ('ZZZ VERIF T63 A') returning id into ta;
  insert into operador (tenant_id, nombre, telefono)
    values (ta, 'ZZZ T63 A', '5215559990001') returning id into oa;
  insert into viaje (tenant_id, operador_id, estatus) values (ta, oa, 'abierto') returning id into v1;
  insert into viaje (tenant_id, operador_id, estatus) values (ta, oa, 'liquidado') returning id into v2;
  insert into viaje (tenant_id, operador_id, estatus) values (ta, oa, 'liquidado') returning id into v3;

  -- costo = g millonésimas → total con forma cerrada. Dos fases. Y el viaje se
  -- reparte entre v1, v2 y NULL: `count(distinct viaje_id)` tiene que dar 2,
  -- porque una fila sin viaje no es una liquidación a la que atribuirle costo.
  insert into llm_costo (tenant_id, viaje_id, fase, modelo, tokens_in, tokens_out, costo_usd, created_at)
  select ta,
         case g % 3 when 0 then v1 when 1 then v2 else null end,
         case when g % 2 = 0 then 'ocr' else 'cuadre' end,
         'zzz-modelo', g % 7, g % 11,
         (g * 0.000001)::numeric(10,6),
         d0 + ((g % 4) || ' days')::interval
  from generate_series(1, filas_a) g;

  -- 2 de cada 3 comprobantes pasaron por OCR; el tercio restante entró a mano y
  -- NO se cuenta. Repartidos en tres meses.
  insert into gasto (tenant_id, viaje_id, concepto, monto, created_at, ocr_confianza, ocr_extra)
  select ta, v1, 'diesel', 100,
         d0 + ((g % 3) || ' months')::interval,
         case when g % 3 = 0 then null else 0.90 end,
         '{}'::jsonb
  from generate_series(1, gastos_a) g;

  -- ── FLOTA B: el ruido que NO puede aparecer en las cifras de A ────────────
  insert into tenant (nombre) values ('ZZZ VERIF T63 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono)
    values (tb, 'ZZZ T63 B', '5215559990002') returning id into ob;
  insert into viaje (tenant_id, operador_id, estatus) values (tb, ob, 'abierto') returning id into vb;
  insert into llm_costo (tenant_id, viaje_id, fase, modelo, tokens_in, tokens_out, costo_usd, created_at)
    select tb, vb, 'router', 'zzz-ajeno', 1, 1, 0.001000, d0
    from generate_series(1, filas_b) g;
  insert into gasto (tenant_id, viaje_id, concepto, monto, created_at, ocr_confianza, ocr_extra)
    select tb, vb, 'caseta', 50, d0, 0.99, '{}'::jsonb
    from generate_series(1, 1000) g;

  analyze llm_costo; analyze gasto;

  j_a := resumen_costo_ia_tenant(ta);
  j_b := resumen_costo_ia_tenant(tb);
  d_a := resumen_documentos_tenant(ta);
  d_b := resumen_documentos_tenant(tb);

  -- ── CAMINO 3: la aritmética ───────────────────────────────────────────────
  cerrado := 0.000001::numeric * filas_a::numeric * (filas_a + 1)::numeric / 2;
  ok_cerrado := (j_a -> 'totales' ->> 'costoUsd')::numeric = cerrado
                and (j_a -> 'totales' ->> 'n')::bigint = filas_a::bigint;

  -- ── 1. AISLAMIENTO: lo de A es SOLO de A ─────────────────────────────────
  -- Si el filtro por tenant faltara, esto traería A+B y ninguna de las dos
  -- igualdades se cumpliría.
  ok_aislado := (j_a -> 'totales' ->> 'costoUsd')::numeric
                  = (select sum(costo_usd) from llm_costo where tenant_id = ta)
            and (j_b -> 'totales' ->> 'costoUsd')::numeric
                  = (select sum(costo_usd) from llm_costo where tenant_id = tb)
            and (j_a -> 'totales' ->> 'costoUsd')::numeric
                 <> (select sum(costo_usd) from llm_costo where tenant_id in (ta, tb));
  -- Y la fase que solo existe en B no puede asomar en el desglose de A.
  ok_sin_fase_ajena := not exists (
    select 1 from jsonb_array_elements(j_a -> 'porFase') f where f ->> 'fase' = 'router');

  ok_docs_aislado := (d_a ->> 'procesados')::bigint
                       = (select count(*) from gasto where tenant_id = ta and ocr_confianza is not null)
                 and (d_b ->> 'procesados')::bigint
                       = (select count(*) from gasto where tenant_id = tb and ocr_confianza is not null);

  -- ── 2. CAMINO 2: `group by` sueltos, mismo filtro, otro plan ─────────────
  ok_fase := (j_a -> 'porFase') = coalesce((
    select jsonb_agg(jsonb_build_object('fase', s.fase, 'n', s.cuantas, 'costoUsd', s.costo)
                     order by s.costo desc, s.fase)
      from (select fase, count(*) cuantas, sum(costo_usd) costo from llm_costo
             where tenant_id = ta group by fase) s), '[]'::jsonb);

  ok_viajes := (j_a -> 'totales' ->> 'viajes')::bigint =
               (select count(distinct viaje_id) from llm_costo where tenant_id = ta);

  ok_tokens := (j_a -> 'totales' ->> 'tokensIn')::bigint
                 = (select sum(tokens_in) from llm_costo where tenant_id = ta)
             and (j_a -> 'totales' ->> 'tokensOut')::bigint
                 = (select sum(tokens_out) from llm_costo where tenant_id = ta);

  ok_docs := (d_a ->> 'procesados')::bigint = (gastos_a - gastos_a / 3)::bigint;

  ok_mes := (d_a -> 'porMes') = coalesce((
    select jsonb_agg(jsonb_build_object('mes', s.mes, 'n', s.cuantas) order by s.mes)
      from (select to_char(created_at at time zone 'UTC', 'YYYY-MM') mes, count(*) cuantas
              from gasto where tenant_id = ta and ocr_confianza is not null
             group by 1) s), '[]'::jsonb);

  -- Los comprobantes SIN `ocr_confianza` no se cuentan: son captura manual, no
  -- trabajo del Agente OCR. Si el filtro se cayera, `procesados` sería 3,000.
  ok_solo_ocr := (d_a ->> 'procesados')::bigint
                 < (select count(*) from gasto where tenant_id = ta);

  -- ── 3. EL RECORTE QUE HABÍA: las primeras 1,000 filas no son el total ─────
  recortado := (select sum(costo_usd) from (
                 select costo_usd from llm_costo where tenant_id = ta limit 1000) x);
  recorte_daba_menos := recortado < cerrado;

  -- ── Ventana vacía: ceros MEDIDOS, no null ────────────────────────────────
  j_vacia := resumen_costo_ia_tenant(ta, d0 + interval '100 years', d0 + interval '101 years');
  ok_vacia := (j_vacia -> 'totales' ->> 'n')::bigint = 0
          and (j_vacia -> 'totales' ->> 'costoUsd')::numeric = 0
          and (j_vacia -> 'totales' ->> 'viajes')::bigint = 0
          and j_vacia -> 'porFase' = '[]'::jsonb;

  -- ── El corte de fecha es SEMIABIERTO ─────────────────────────────────────
  hay_borde := (select count(*) from llm_costo where tenant_id = ta and created_at = d0 + interval '2 days');
  j_borde := resumen_costo_ia_tenant(ta, d0, d0 + interval '2 days');
  ok_borde := (j_borde -> 'totales' ->> 'n')::bigint =
              (select count(*) from llm_costo
                where tenant_id = ta and created_at >= d0 and created_at < d0 + interval '2 days');

  -- ── Permisos, del catálogo ───────────────────────────────────────────────
  select p.prosecdef, has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
    into def_a, anon_a, auth_a, svc_a
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resumen_costo_ia_tenant';

  select p.prosecdef, has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
    into def_d, anon_d, auth_d, svc_d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resumen_documentos_tenant';

  delete from tenant where nombre like 'ZZZ VERIF T63 %';

  -- PRU-1 (auditoría 24): sin rótulos sueltos («docs:», «permisos costo:») ni
  -- paréntesis entre claves — el runner los pegaba al valor anterior («t docs:»)
  -- y el bloque quedaba SIN CALIFICAR con su AISLADO= adentro. Las dos cifras
  -- del recorte son informativas: la aserción es `recorte_daba_menos`.
  raise exception E'RESUMEN_POR_TENANT  costo_cerrado=%  costo_fase=%  costo_viajes=%  costo_tokens=%  costo_AISLADO=%  costo_sin_fase_ajena=%  docs_procesados=%  docs_porMes=%  docs_AISLADO=%  docs_solo_ocr=%  ventana_vacia=%  borde_semiabierto=%  hay_filas_en_el_borde=%  recorte_daba_menos=%  suma_1000_filas=%  total_real=%  costo_definer=%  costo_anon=%  costo_auth=%  costo_svc=%  docs_definer=%  docs_anon=%  docs_auth=%  docs_svc=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t / >0 / t / lo que suman 1000 filas / el total real / f / f / f / t / f / f / f / t)',
    ok_cerrado, ok_fase, ok_viajes, ok_tokens, ok_aislado, ok_sin_fase_ajena,
    ok_docs, ok_mes, ok_docs_aislado, ok_solo_ocr,
    ok_vacia, ok_borde, hay_borde,
    recorte_daba_menos, recortado, cerrado,
    def_a, anon_a, auth_a, svc_a, def_d, anon_d, auth_d, svc_d;
end $$;


-- ── 44. Un CFDI ampara VARIAS casetas, y lo bloqueado sale de la cola (mig. 0065) ──
--
-- Las dos garantías de la 0065, y la de la 0019 que NO se pudo perder al
-- tocarla.
--
-- CAPUFE emite UNA factura con N códigos, así que N gastos comparten
-- `cfdi_uuid`. El índice de la 0019 —`unique (tenant_id, cfdi_uuid)`— lo
-- impedía: la segunda caseta reventaba con 23505 y las otras siete se quedaban
-- sin folio, volvían a la cola y la hora siguiente se emitía un SEGUNDO CFDI
-- por el mismo cruce. Fuera de plazo, eso ya no se cancela.
--
-- El índice NO se borró: se le agregó `cfdi_orden` como tercera columna. La
-- garantía que queda es "a lo sumo un gasto por (flota, CFDI) puede ser el
-- orden 1", y como TODO camino que inserta un gasto con folio usa el default
-- 1, el caso de la 0019 —el mismo XML entrando dos veces— sigue rebotando. Este
-- bloque lo comprueba en las dos direcciones, y comprueba también que el
-- mensaje siga nombrando `uq_gasto_cfdi_uuid`: `processor.ts` discrimina por
-- ese nombre para saber si el 23505 es benigno, así que renombrarlo tumbaría el
-- procesamiento de la foto en vez de ignorarla.
--
-- Y la cola: los bloqueados —CAPTCHA, emisión sin confirmar— no se reintentan.
-- El índice parcial lleva el MISMO predicado que la consulta del cron, o se
-- estarían leyendo cada hora los que ya se sabe que no se pueden.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; o uuid; v uuid; r record; plan text := '';
  choco_orden boolean := false; choco_ingesta boolean := false; msg text := '';
  n_lote int; sin_motivo boolean := false; usa_indice boolean; en_cola int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0065') returning id into t;
  insert into operador (tenant_id, nombre, telefono) values (t,'ZZZ','5215557770065') returning id into o;
  insert into viaje (tenant_id, operador_id, estatus) values (t,o,'abierto') returning id into v;

  -- 1. UNA factura de 8 casetas: 8 gastos, un uuid, orden 1..8.
  insert into gasto (tenant_id, viaje_id, concepto, monto) select t, v, 'caseta', 50 from generate_series(1,8);
  update gasto g set cfdi_uuid = 'uuid-capufe-lote', cfdi_orden = x.n
    from (select id, row_number() over (order by id) n from gasto where tenant_id = t) x
   where g.id = x.id;
  select count(*) into n_lote from gasto where tenant_id = t and cfdi_uuid = 'uuid-capufe-lote';

  -- 2. El mismo (uuid, orden) NO entra dos veces.
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, cfdi_uuid, cfdi_orden)
      values (t, v, 'caseta', 50, 'uuid-capufe-lote', 3);
  exception when unique_violation then choco_orden := true;
  end;

  -- 3. LA GARANTÍA DE LA 0019: el XML del mismo CFDI llegando por ingesta —que
  --    siempre escribe el default 1— sigue rebotando, y con el NOMBRE que
  --    `processor.ts` discrimina.
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, cfdi_uuid)
      values (t, v, 'caseta', 400, 'uuid-capufe-lote');
  exception when unique_violation then choco_ingesta := true; msg := SQLERRM;
  end;

  -- 4. Una marca de bloqueo sin motivo no se guarda: mandaría a una persona a
  --    facturar algo sin decirle por qué falló solo.
  begin
    update gasto set autofactura_bloqueada_en = now() where tenant_id = t and cfdi_orden = 2;
  exception when check_violation then sin_motivo := true;
  end;

  -- 5. La cola del cron: usa el índice y NO devuelve los bloqueados.
  insert into gasto (tenant_id, viaje_id, concepto, monto, created_at, autofactura_bloqueada_en, autofactura_bloqueo)
  select t, v, 'diesel', 100, now()-(g||' minutes')::interval,
         case when g%4=0 then now() else null end,
         case when g%4=0 then 'el portal pidió CAPTCHA' else null end
  from generate_series(1,9000) g;
  analyze gasto;

  select count(*) into en_cola from gasto
    where tenant_id = t and cfdi_uuid is null and autofactura_bloqueada_en is null;

  for r in execute 'explain select id from gasto where cfdi_uuid is null and autofactura_bloqueada_en is null
                    order by autofactura_intentada_en nulls first, created_at limit 8'
  loop plan := plan || r."QUERY PLAN" || ' | '; end loop;
  usa_indice := plan ilike '%gasto_por_facturar_idx%';

  delete from tenant where id = t;
  raise exception E'CFDI_LOTE  gastos-con-el-mismo-uuid=%  mismo-orden-rebota=%  ingesta-repetida-rebota=%  bloqueo-sin-motivo-rebota=%  cola-usa-indice=%  en-cola=%  msg=%   (esperado 8 / t / t / t / t / 6750 / nombra uq_gasto_cfdi_uuid)',
    n_lote, choco_orden, choco_ingesta, sin_motivo, usa_indice, en_cola, msg;
end $$;

-- ── 45. Ni un peso negativo en el camino del dinero (mig. 0070) ──────────────
--
-- El único check que tenían `gasto.monto` y `viaje.anticipo` era contra `NaN`.
-- Comprobado ANTES de la 0070: `monto = -99999` ENTRABA. Un comprobante negativo
-- no suma de menos, RESTA del comprobado, así que infla la diferencia al doble y
-- el PDF le dice al chofer que debe dinero que no debe.
--
-- ESTE BLOQUE SE FALSIFICA A SÍ MISMO. Después de comprobar en verde, TIRA los
-- dos checks dentro de la misma transacción y vuelve a intentar el -99999. Si el
-- bloque no puede enseñar el defecto con los checks caídos, es que no estaba
-- comprobando los checks. Todo se revierte con la excepción final.
--
-- OJO con la trampa que este bloque esquiva: hay que usar un OPERADOR DISTINTO
-- por cada `insert into viaje`, porque `uq_viaje_abierto_por_operador` (0029)
-- rebota el segundo viaje vivo del mismo chofer — y ese rechazo se leería como
-- "el check de anticipo funcionó" cuando en realidad el check ni se evaluó.
--
-- Corrida REAL contra la base, salida copiada tal cual:
--
--   45  rechaza-monto-negativo=t  acepta-monto-cero=t  rechaza-anticipo-negativo=t
--       acepta-anticipo-cero=t
--       FALSIFICADO (checks caidos): entra-monto-negativo=t  entra-anticipo-negativo=t
--
-- `acepta-monto-cero` y `acepta-anticipo-cero` son `t` A PROPÓSITO: el piso es
-- `>= 0`, no `> 0`. En `anticipo` el cero es el DEFAULT del esquema —un viaje sin
-- adelanto es el caso normal— así que un `> 0` habría roto la inserción de la
-- mitad de los viajes. Ver la 0070 para el argumento de `monto`.

do $$
declare
  t uuid; o uuid; v uuid; o2 uuid; o3 uuid; o4 uuid;
  rechaza_neg bool; acepta_cero bool; rechaza_ant_neg bool; acepta_ant_cero bool;
  sin_check_entra_neg bool; sin_check_entra_ant bool; msg text;
begin
  insert into tenant(nombre) values ('ZZZ VERIF B45 '||gen_random_uuid()) returning id into t;
  insert into operador(tenant_id,nombre,telefono) values (t,'Op1','5215500000001') returning id into o;
  insert into operador(tenant_id,nombre,telefono) values (t,'Op2','5215500000002') returning id into o2;
  insert into operador(tenant_id,nombre,telefono) values (t,'Op3','5215500000003') returning id into o3;
  insert into operador(tenant_id,nombre,telefono) values (t,'Op4','5215500000004') returning id into o4;
  insert into viaje(tenant_id,operador_id,estatus) values (t,o,'en_cuadre') returning id into v;

  begin
    insert into gasto(tenant_id,viaje_id,concepto,monto) values (t,v,'diesel',-99999);
    rechaza_neg := false;
  exception when check_violation then rechaza_neg := true; msg := sqlerrm;
  end;
  begin
    insert into gasto(tenant_id,viaje_id,concepto,monto) values (t,v,'diesel',0);
    acepta_cero := true;
  exception when others then acepta_cero := false;
  end;
  begin   -- operador NUEVO: aislar de uq_viaje_abierto_por_operador (0029)
    insert into viaje(tenant_id,operador_id,estatus,anticipo) values (t,o2,'en_cuadre',-1);
    rechaza_ant_neg := false;
  exception when check_violation then rechaza_ant_neg := true;
  end;
  begin
    insert into viaje(tenant_id,operador_id,estatus,anticipo) values (t,o3,'en_cuadre',0);
    acepta_ant_cero := true;
  exception when others then acepta_ant_cero := false;
  end;

  -- ═══ FALSIFICACIÓN ═══
  alter table gasto drop constraint gasto_monto_no_negativo;
  alter table viaje drop constraint viaje_anticipo_no_negativo;
  begin
    insert into gasto(tenant_id,viaje_id,concepto,monto) values (t,v,'diesel',-99999);
    sin_check_entra_neg := true;
  exception when others then sin_check_entra_neg := false;
  end;
  begin
    insert into viaje(tenant_id,operador_id,estatus,anticipo) values (t,o4,'en_cuadre',-99999);
    sin_check_entra_ant := true;
  exception when others then sin_check_entra_ant := false;
  end;

  raise exception E'45  rechaza-monto-negativo=%  acepta-monto-cero=%  rechaza-anticipo-negativo=%  acepta-anticipo-cero=%\n    FALSIFICADO (checks caidos): entra-monto-negativo=%  entra-anticipo-negativo=%  msg=%\n    (esperado t / t / t / t)',
    rechaza_neg, acepta_cero, rechaza_ant_neg, acepta_ant_cero,
    sin_check_entra_neg, sin_check_entra_ant, msg;
end $$;


-- ── 46. Borrar una flota dejó de ser O(n²) (mig. 0071) ───────────────────────
--
-- Postgres NO indexa el lado que REFERENCIA de una FK. Al borrar una fila padre
-- el trigger busca a sus hijos, y sin índice eso es un `Seq Scan` de la tabla
-- hija COMPLETA — una vez POR CADA FILA PADRE. Es `filas_padre × tamaño_hijo`:
-- cuadrático, invisible con la base vacía, y devastador con datos.
--
-- Igual que los bloques 39 y 40, ESTE BLOQUE NO COMPRUEBA QUE LOS ÍNDICES
-- EXISTAN. Comprueba tres cosas que sí importan:
--   1. que el PLANEADOR los use (un índice que existe y no se usa es peso muerto),
--   2. que NO QUEDE ni una FK contra un padre numeroso sin índice utilizable —
--      leído del catálogo, no de una lista escrita a mano que se desactualiza,
--   3. que los TRES que se descartaron a propósito sigan descartados.
--
-- El punto 2 es el que de verdad cierra el defecto: la auditoría nombró 9
-- índices, pero el sondeo del catálogo encontró 43 FK sin índice utilizable, y
-- con solo esos 9 el borrado SEGUÍA siendo cuadrático porque quedaban 10 FK
-- contra `viaje` sin cubrir.
--
-- El criterio del descarte: el costo de un borrado es `(filas del PADRE) ×
-- (tamaño del HIJO)`. Las FK contra `tenant` tienen UNA fila padre, así que su
-- trigger corre UNA vez por borrado — un solo `Seq Scan` de una tabla acotada es
-- correcto, y un índice de más se paga en cada insert para siempre.
--
-- Corrida REAL, salida copiada tal cual:
--
--   46  plan-con-indice=llm_costo_liquidacion_id_idx   FK-de-padre-numeroso-sin-indice=—
--       descartados-siguen-sin-indice(a proposito)=campania, terminal, codigo_pendiente
--       FALSIFICADO: plan-sin-indice=Seq Scan
--       200 sondeos (75k filas):  con=3.9 ms   sin=1902.6 ms   factor=491.8x
--
-- Y la medición de punta a punta, con una flota sembrada de 2,000 viajes y
-- ~34,000 filas hijas:  `delete from tenant` = 4,696.5 ms → 900.5 ms  (5.2×).

do $$
declare
  t uuid; j jsonb; nodo_con text; nodo_sin text; faltan text; descartados text; d timestamptz;
  ms_con numeric; ms_sin numeric; i int; x int; liq uuid[];
begin
  insert into tenant(nombre) values ('ZZZ VERIF B46 '||gen_random_uuid()) returning id into t;
  insert into llm_costo(tenant_id,liquidacion_id,fase,modelo)
    select t,null,'ocr','haiku' from generate_series(1,75000);
  analyze llm_costo;
  liq := array(select gen_random_uuid() from generate_series(1,200));

  -- 1. EL PLANEADOR LO USA (no solo "existe")
  execute 'explain (format json) select 1 from only llm_costo where liquidacion_id = $1'
    using liq[1] into j;
  nodo_con := coalesce(j->0->'Plan'->>'Index Name', j->0->'Plan'->'Plans'->0->>'Index Name', j->0->'Plan'->>'Node Type');
  d := clock_timestamp();
  for i in 1..200 loop select count(*) into x from llm_costo where liquidacion_id = liq[i]; end loop;
  ms_con := extract(epoch from clock_timestamp()-d)*1000;

  -- 2. NINGUNA FK de padre numeroso se quedó sin índice utilizable.
  -- Se lee del CATÁLOGO: `indkey` es 0-based, y una FK compuesta cuya PRIMERA
  -- columna ya está indexada sola tampoco cuenta (el planner entra por ahí).
  select coalesce(string_agg(tabla||'('||cols||')', ', '), '—') into faltan from (
    select c.conrelid::regclass::text tabla,
           (select string_agg(a.attname,',' order by x2.ord)
              from unnest(c.conkey) with ordinality x2(att,ord)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=x2.att) cols
      from pg_constraint c
     where c.connamespace='public'::regnamespace and c.contype='f'
       and c.confrelid::regclass::text in ('viaje','gasto','liquidacion','operador','unidad','cliente','terminal')
       and not exists (
         select 1 from pg_index i where i.indrelid=c.conrelid and i.indpred is null
            and i.indnatts >= array_length(c.conkey,1)
            and (select array_agg(i.indkey[k] order by i.indkey[k]) from generate_series(0,array_length(c.conkey,1)-1) k)
              = (select array_agg(a2 order by a2) from unnest(c.conkey) a2))
       and not exists (
         select 1 from pg_index i where i.indrelid=c.conrelid and i.indpred is null
            and i.indkey[0] = c.conkey[1])
  ) s;

  -- 3. Los tres DESCARTADOS a propósito siguen sin índice
  select coalesce(string_agg(t2,', '),'—') into descartados from (
    select unnest(array['campania','terminal','codigo_pendiente']) t2) z
   where not exists (select 1 from pg_index i where i.indrelid=z.t2::regclass
                       and i.indnatts=1 and i.indkey[0]=(select attnum from pg_attribute
                         where attrelid=z.t2::regclass and attname='tenant_id'));

  -- ═══ FALSIFICACIÓN: sin el índice, el plan cae a Seq Scan ═══
  drop index llm_costo_liquidacion_id_idx;
  analyze llm_costo;
  execute 'explain (format json) select 1 from only llm_costo where liquidacion_id = $1'
    using liq[1] into j;
  nodo_sin := j->0->'Plan'->>'Node Type';
  d := clock_timestamp();
  for i in 1..200 loop select count(*) into x from llm_costo where liquidacion_id = liq[i]; end loop;
  ms_sin := extract(epoch from clock_timestamp()-d)*1000;

  raise exception E'46  plan-con-indice=%   FK-de-padre-numeroso-sin-indice=%\n    descartados-siguen-sin-indice(a proposito)=%\n    FALSIFICADO: plan-sin-indice=%\n    200 sondeos (75k filas):  con=% ms   sin=% ms   factor=%x',
    nodo_con, faltan, descartados, nodo_sin,
    round(ms_con,1), round(ms_sin,1), round(ms_sin/greatest(ms_con,0.001),1);
end $$;


-- ── 47. Se purga lo efímero y NO se purga la historia de negocio (mig. 0072) ──
--
-- Hasta la 0072 no se purgaba NADA. Este bloque comprueba las dos mitades de la
-- decisión, y la segunda importa más que la primera:
--
--   · `wa_mensaje_procesado` SÍ se purga a los 30 días. Es idempotencia pura:
--     no tiene `tenant_id`, no se puede atribuir a una flota, no responde
--     ninguna pregunta de negocio.
--   · `llm_costo` NO se purga. `resumen_costo_ia_tenant()` (0062/0064) suma sus
--     filas CRUDAS, así que borrarlas haría que esa función contestara —sin
--     avisar— una cifra MENOR para cualquier periodo purgado. El panel enseñaría
--     un número distinto del mismo mes según cuándo se mire, que es justo lo que
--     "nunca inventar una cifra" prohíbe. Se CONSOLIDA a mensual en su lugar.
--
-- El bloque comprueba que `llm_costo` sigue INTACTA después de la corrida. Esa
-- afirmación en negativo es la que hay que sostener: es la que se rompería sola
-- el día que alguien "complete" la purga sin mirar quién lee la tabla.
--
-- Comprueba además que el mes EN CURSO no se consolida (un consolidado parcial
-- es la cifra engañosa que se quiere evitar), que la consolidación es
-- IDEMPOTENTE, y que un plazo demasiado corto falla CERRADO con SQLSTATE PU001.
--
-- Corrida REAL, salida copiada tal cual:
--
--   47  wa: viejos-antes=100  purgados=100  quedan=10
--       llm_costo INTACTA=87  consolidado=2.000000 == crudo-de-meses-cerrados=2.000000
--       mes-en-curso-NO-consolidado=t  idempotente=t
--       plazo-minimo-falla-cerrado=t sqlstate=PU001
--       json={"diasWa":30,"waPurgados":100,"iaConsolidados":2,"llmCostoPurgado":false}
--
-- SOBRE `idx_wa_msg_created`: la auditoría lo dio por muerto. Su forma es
-- exactamente la de un `delete where created_at < …` — era el índice de ESTA
-- purga, que no estaba escrita. Medido aparte, en estado ESTACIONARIO (1,000
-- filas vencidas de 31,000, que es lo que el cron ve cada día) el delete entra
-- por `idx_wa_msg_created`; en la PRIMERA corrida, que barre casi todo, cae a
-- `Seq Scan` — y ahí el Seq Scan es lo correcto. Borrarlo habría sido el error.

do $$
declare
  t uuid; ahora timestamptz := '2026-08-04 12:00:00+00'; j jsonb; j2 jsonb;
  quedan_wa int; viejos_antes int; guarda_minimo bool; sqlst text;
  llm_intactas int; consol_suma numeric; cruda_suma numeric; mes_curso int; idempotente bool;
begin
  insert into tenant(nombre) values ('ZZZ VERIF B47 '||gen_random_uuid()) returning id into t;

  insert into wa_mensaje_procesado(wa_message_id, created_at)
    select 'v'||gen_random_uuid(), ahora - interval '60 days' from generate_series(1,100);
  insert into wa_mensaje_procesado(wa_message_id, created_at)
    select 'r'||gen_random_uuid(), ahora - interval '2 days' from generate_series(1,10);
  select count(*) into viejos_antes from wa_mensaje_procesado where created_at < ahora - interval '30 days';

  -- Dos meses CERRADOS y el mes EN CURSO
  insert into llm_costo(tenant_id,fase,modelo,tokens_in,tokens_out,costo_usd,created_at)
    select t,'ocr','haiku',10,5,0.01, '2026-06-15 00:00:00+00' from generate_series(1,50);
  insert into llm_costo(tenant_id,fase,modelo,tokens_in,tokens_out,costo_usd,created_at)
    select t,'cuadre','sonnet',20,10,0.05,'2026-07-15 00:00:00+00' from generate_series(1,30);
  insert into llm_costo(tenant_id,fase,modelo,tokens_in,tokens_out,costo_usd,created_at)
    select t,'ocr','haiku',10,5,0.01,'2026-08-02 00:00:00+00' from generate_series(1,7);

  j := mantenimiento_de_datos(30, ahora);

  select count(*) into quedan_wa from wa_mensaje_procesado;
  select count(*) into llm_intactas from llm_costo where tenant_id=t;   -- NADA se borró
  select coalesce(sum(costo_usd),0) into consol_suma from llm_costo_mensual where tenant_id=t;
  select coalesce(sum(costo_usd),0) into cruda_suma  from llm_costo
   where tenant_id=t and created_at < date_trunc('month', ahora at time zone 'UTC');
  select count(*) into mes_curso from llm_costo_mensual where tenant_id=t and mes='2026-08-01';

  j2 := mantenimiento_de_datos(30, ahora);      -- idempotencia
  idempotente := (j2->>'iaConsolidados')::int = (j->>'iaConsolidados')::int
                 and (select count(*) from llm_costo_mensual where tenant_id=t)
                     = (select count(distinct (date_trunc('month',created_at at time zone 'UTC'), fase, modelo))
                          from llm_costo where tenant_id=t and created_at < date_trunc('month', ahora at time zone 'UTC'));

  begin
    perform purgar_wa_mensaje_procesado(3, ahora);
    guarda_minimo := false;
  exception when others then guarda_minimo := true; sqlst := sqlstate;
  end;

  raise exception E'47  wa: viejos-antes=%  purgados=%  quedan=%  (esperado 100 / 100 / 10)\n    llm_costo INTACTA=%  (87, no se purga)   consolidado=% == crudo-de-meses-cerrados=%\n    mes-en-curso-NO-consolidado=%  idempotente=%\n    plazo-minimo-falla-cerrado=% sqlstate=%\n    json=%',
    viejos_antes, (j->>'waPurgados'), quedan_wa,
    llm_intactas, consol_suma, cruda_suma, (mes_curso=0), idempotente,
    guarda_minimo, sqlst, j::text;
end $$;


-- ── 48. Un comprobante huérfano no cruza de flota, ni inventa estado (mig. 0073) ──
--
-- La 0028 documentó como CRÍTICA la clase de defecto: con una FK simple contra
-- `operador(id)`, nada impide que una fila lleve el `tenant_id` de la flota A y
-- el `operador_id` de la flota B. `comprobante_huerfano` nació en la 0040 —
-- DESPUÉS de la 0028 — y se saltó el patrón. Comprobado antes de arreglarlo: la
-- fila cruzada ENTRABA.
--
-- Y `motivo`/`resolucion` eran las DOS únicas columnas de estado del esquema sin
-- su check, aunque la 0040 las documenta y el código ramifica sobre ellas.
--
-- LOS VALORES SE TOMARON DEL CÓDIGO DE HOY, NO DE LA 0040. `repo.ts:257` declara
-- TRES motivos, no los dos que la migración vieja documenta:
--     export type MotivoHuerfano = 'sin_viaje' | 'tras_liquidar' | 'fallo_ocr';
-- `fallo_ocr` es reciente —separa "se cayó NUESTRO OCR" de "no aterrizó en
-- ninguna liquidación", que antes se guardaban los dos como `sin_viaje`— y
-- cerrar el dominio contra la migración habría roto el camino que lo escribe.
-- Por eso el bloque prueba los TRES uno por uno: si mañana el código agrega un
-- cuarto y no toca el check, este bloque se pone rojo antes que producción.
--
-- Corrida REAL, salida copiada tal cual:
--
--   48  cruza-flotas-rebota=t  los-3-motivos-entran=t  motivo-inventado-rebota=t
--       resolucion-inventada-rebota=t  cierre-a-medias-rebota=t
--       FALSIFICADO (FK compuesta caida): cruza-flotas-ENTRA=t

do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid;
  cruza_rebota bool; sin_fk_cruza_entra bool;
  motivos_validos bool := true; motivo_malo_rebota bool; resol_mala_rebota bool;
  cierre_a_medias_rebota bool; m text;
begin
  insert into tenant(nombre) values ('ZZZ VERIF B48 A '||gen_random_uuid()) returning id into ta;
  insert into tenant(nombre) values ('ZZZ VERIF B48 B '||gen_random_uuid()) returning id into tb;
  insert into operador(tenant_id,nombre,telefono) values (ta,'A','5215500001001') returning id into oa;
  insert into operador(tenant_id,nombre,telefono) values (tb,'B','5215500001002') returning id into ob;

  -- tenant_id de A con operador_id de B
  begin
    insert into comprobante_huerfano(tenant_id,operador_id,gasto,motivo)
      values (ta, ob, '{}'::jsonb, 'sin_viaje');
    cruza_rebota := false;
  exception when foreign_key_violation then cruza_rebota := true;
  end;

  -- Los TRES motivos del código de HOY (incluido fallo_ocr)
  foreach m in array array['sin_viaje','tras_liquidar','fallo_ocr'] loop
    begin
      insert into comprobante_huerfano(tenant_id,operador_id,gasto,motivo)
        values (ta, oa, '{}'::jsonb, m);
    exception when others then motivos_validos := false;
    end;
  end loop;

  begin
    insert into comprobante_huerfano(tenant_id,operador_id,gasto,motivo)
      values (ta, oa, '{}'::jsonb, 'inventado');
    motivo_malo_rebota := false;
  exception when check_violation then motivo_malo_rebota := true;
  end;
  begin
    insert into comprobante_huerfano(tenant_id,operador_id,gasto,motivo,resuelto_en,resolucion)
      values (ta, oa, '{}'::jsonb, 'sin_viaje', now(), 'inventada');
    resol_mala_rebota := false;
  exception when check_violation then resol_mala_rebota := true;
  end;
  begin  -- resuelto_en sin resolucion = fila a medias
    insert into comprobante_huerfano(tenant_id,operador_id,gasto,motivo,resuelto_en)
      values (ta, oa, '{}'::jsonb, 'sin_viaje', now());
    cierre_a_medias_rebota := false;
  exception when check_violation then cierre_a_medias_rebota := true;
  end;

  -- ═══ FALSIFICACIÓN ═══
  alter table comprobante_huerfano drop constraint comprobante_huerfano_operador_tenant_fkey;
  begin
    insert into comprobante_huerfano(tenant_id,operador_id,gasto,motivo)
      values (ta, ob, '{}'::jsonb, 'sin_viaje');
    sin_fk_cruza_entra := true;
  exception when others then sin_fk_cruza_entra := false;
  end;

  raise exception E'48  cruza-flotas-rebota=%  los-3-motivos-entran=%  motivo-inventado-rebota=%\n    resolucion-inventada-rebota=%  cierre-a-medias-rebota=%\n    FALSIFICADO (FK compuesta caida): cruza-flotas-ENTRA=%\n    (esperado t / t / t / t / t)',
    cruza_rebota, motivos_validos, motivo_malo_rebota, resol_mala_rebota,
    cierre_a_medias_rebota, sin_fk_cruza_entra;
end $$;


-- ── 49. Las funciones que resuelven TODO el RLS tienen pg_temp (mig. 0074) ───
--
-- `is_superadmin`, `get_user_tenant_ids`, `is_operador` y `get_user_operador_id`
-- son `SECURITY DEFINER` y son las que TODA política RLS del esquema llama para
-- decidir qué flota ve cada quien. Tenían `search_path=public` a secas.
--
-- Cuando `pg_temp` no está NOMBRADO, Postgres lo antepone igual de forma
-- implícita: cualquier rol puede crear un objeto temporal en su sesión y ganarle
-- la resolución de nombre a `public`. En una función que corre con los permisos
-- de su dueño, eso es un camino a suplantar la respuesta de "¿de qué flotas es
-- este usuario?". Nombrarlo AL FINAL lo fija en último lugar.
--
-- Que `ve_finanzas` y `administra_flota` (0048) SÍ lo tuvieran es la prueba de
-- que era olvido y no decisión.
--
-- CORRECCIÓN A LA AUDITORÍA: `gasto_no_tras_liquidar` NO es `SECURITY DEFINER`
-- —`prosecdef = false` en el catálogo—, así que corre con los permisos de quien
-- dispara el INSERT y el riesgo es mucho menor. Pero no tenía NINGÚN
-- `search_path` (`proconfig` vacío), que es un hueco distinto y más ancho del
-- que la auditoría describió. Se le fija igual: es el trigger que la 0036 llama
-- "el peor bug histórico del camino del dinero".
--
-- Corrida REAL, salida copiada tal cual:
--
--   49  CON pg_temp: administra_flota, gasto_no_tras_liquidar, get_user_operador_id,
--       get_user_tenant_ids, is_operador, is_superadmin, ve_finanzas
--       SIN pg_temp: —
--       FALSIFICADO (se le quita a is_superadmin): sin-pg_temp = is_superadmin

do $$
declare con_pg_temp text; sin_pg_temp text; tras_falsificar text;
begin
  select coalesce(string_agg(proname,', ' order by proname),'—') into con_pg_temp
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('is_superadmin','get_user_tenant_ids','is_operador','get_user_operador_id',
                       've_finanzas','administra_flota','gasto_no_tras_liquidar')
     and array_to_string(p.proconfig,',') like '%pg_temp%';

  select coalesce(string_agg(proname,', ' order by proname),'—') into sin_pg_temp
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('is_superadmin','get_user_tenant_ids','is_operador','get_user_operador_id',
                       've_finanzas','administra_flota','gasto_no_tras_liquidar')
     and coalesce(array_to_string(p.proconfig,','),'') not like '%pg_temp%';

  -- ═══ FALSIFICACIÓN: se le quita a una y el bloque tiene que verla ═══
  alter function public.is_superadmin() set search_path = public;
  select coalesce(string_agg(proname,', ' order by proname),'—') into tras_falsificar
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('is_superadmin','get_user_tenant_ids','is_operador','get_user_operador_id',
                       've_finanzas','administra_flota','gasto_no_tras_liquidar')
     and coalesce(array_to_string(p.proconfig,','),'') not like '%pg_temp%';

  raise exception E'49  con-pg_temp=%\n    sin-pg_temp=%\n    FALSIFICADO (se le quita a is_superadmin): sin-pg_temp = %\n    (esperado las que ya lo tienen / —)',
    con_pg_temp, sin_pg_temp, tras_falsificar;
end $$;


-- ── 50. El candado se va con su viaje, y las NOT VALID quedaron validadas (mig. 0075) ──
--
-- `viaje_lock` es el mutex de un viaje y no tenía FK contra `viaje`: un proceso
-- que muere entre tomar el candado y soltarlo dejaba una fila permanente, y la
-- tabla del mutex acumulaba basura que nada limpiaba. Con `ON DELETE CASCADE` el
-- candado se va con su viaje — que es la única semántica que tiene sentido: un
-- candado sobre algo que ya no existe no protege nada.
--
-- OJO: esto NO arregla el candado colgado de un viaje que SÍ existe. De eso se
-- encarga `locked_until`, que es el TTL. Arregla la fila huérfana, que es otra
-- cosa, y decirlo importa para que nadie lea este bloque como más de lo que es.
--
-- Y las dos restricciones que llevaban meses en `NOT VALID` —`convalidated =
-- false` en el catálogo— se validaron: con la base vacía, `VALIDATE` no lee ni
-- una fila y no puede fallar. Con 240 mil viajes al año, dentro de unos meses ya
-- no habría sido gratis.
--
-- Corrida REAL, salida copiada tal cual:
--
--   50  candado-borrado-con-el-viaje=0  viaje_ingreso_no_negativo=t  viaje_km_sanos=t
--       FALSIFICADO sin FK: candado-huerfano-que-queda-para-siempre=1
--       FALSIFICADO not-valid: viaje_km_sanos.convalidated=f
--
-- PRU-ALTO1 (auditoría 25): el `raise` original metía las tres mediciones
-- reales Y las dos de FALSIFICACIÓN en un solo `%` de texto (`validadas`,
-- concatenado a mano) con CUATRO grupos `(esperado …)` intercalados —el único
-- bloque de los 226 con más de uno—. El calificador solo lee el PRIMER
-- `(esperado`: el resto del mensaje, con espacios adentro, se leía como un
-- comodín de prosa y pasaba «✓ ok» con las cuatro mediciones mal (medido
-- contra Postgres real). Reescrito a la forma que usan los otros 17 bloques
-- con FALSIFICACIÓN (45, 48, 49, 52, …): cada valor real en su propio `%`,
-- un solo `(esperado …)` al final, y la sección `FALSIFICADO` narrativa
-- ANTES de él (el calificador la recorta a propósito — no es una aserción,
-- es la prueba de que la detección funciona).

do $$
declare
  t uuid; o uuid; v uuid; quedan int; quedan_sin_fk int;
  ing_no_negativo bool; km_sanos bool; tras_falsificar bool;
begin
  insert into tenant(nombre) values ('ZZZ VERIF B50 '||gen_random_uuid()) returning id into t;
  insert into operador(tenant_id,nombre,telefono) values (t,'Op','5215500002001') returning id into o;
  insert into viaje(tenant_id,operador_id,estatus) values (t,o,'en_cuadre') returning id into v;

  insert into viaje_lock(viaje_id, locked_until) values (v, now() + interval '5 min');
  delete from viaje where id = v;
  select count(*) into quedan from viaje_lock where viaje_id = v;

  select convalidated into ing_no_negativo from pg_constraint
   where conrelid='viaje'::regclass and conname='viaje_ingreso_no_negativo';
  select convalidated into km_sanos from pg_constraint
   where conrelid='viaje'::regclass and conname='viaje_km_sanos';

  -- ═══ FALSIFICACIÓN 1: sin la FK, el candado sobrevive al viaje ═══
  alter table viaje_lock drop constraint viaje_lock_viaje_id_fkey;
  insert into viaje(tenant_id,operador_id,estatus) values (t,o,'en_cuadre') returning id into v;
  insert into viaje_lock(viaje_id, locked_until) values (v, now() + interval '5 min');
  delete from viaje where id = v;
  select count(*) into quedan_sin_fk from viaje_lock where viaje_id = v;

  -- ═══ FALSIFICACIÓN 2: re-agregada como NOT VALID, el catálogo lo delata ═══
  alter table viaje drop constraint viaje_km_sanos;
  alter table viaje add constraint viaje_km_sanos
    check (km_recorridos is null or (km_recorridos > 0 and km_recorridos < 20000)) not valid;
  select convalidated into tras_falsificar from pg_constraint
   where conrelid='viaje'::regclass and conname='viaje_km_sanos';

  raise exception E'50  candado-borrado-con-el-viaje=%  viaje_ingreso_no_negativo=%  viaje_km_sanos=%\n    FALSIFICADO sin FK: candado-huerfano-que-queda-para-siempre=%\n    FALSIFICADO not-valid: viaje_km_sanos.convalidated=%\n    (esperado 0 / t / t)',
    quedan, ing_no_negativo, km_sanos, quedan_sin_fk, tras_falsificar;
end $$;

-- ── 51. El desglose de la mensualidad no se puede desincronizar (mig. 0066) ──
--
-- `factura_saas.subtotal` y `.iva` se guardan al emitir, no se recalculan al
-- timbrar (entre emitir y timbrar el precio del plan puede cambiar, y lo que
-- se timbra tiene que ser lo que se cobró). El CHECK `factura_saas_
-- desglose_cuadra` es lo único que impide que las tres columnas de dinero
-- —monto, subtotal, iva— se desincronicen sin que nada avise; los otros dos
-- (`_coherente`, `_no_negativo`) cierran los bordes: medio desglose guardado,
-- o un negativo colado.
--
-- ESTE BLOQUE EXISTE POR UNA COLISIÓN, no solo por la migración. El archivo
-- que la trae se llamó primero `0065_iva_de_la_mensualidad.sql`, con el mismo
-- prefijo que `0065_cfdi_de_varias_casetas.sql` (otro agente, mismo día,
-- ambos sin commitear). `migraciones_verificadas.test.ts` indexa las
-- migraciones por los 4 primeros caracteres del nombre de archivo, así que
-- ambos archivos compartían la misma llave — y el bloque 44 de aquí abajo
-- (título "...mig. 0065", que SÍ prueba la de CFDI) le prestaba cobertura
-- FALSA a ésta: el test pasaba en verde sin que ninguna de las tres CHECK de
-- abajo se hubiera probado nunca. Renumerada a 0066 (auditoría 10, rubro
-- datos, 4-ago-2026) y este bloque es la cobertura real que faltaba.
--
-- Corrida REAL contra el proyecto Likida, 4-ago-2026 (`factura_saas` sin
-- filas antes y después — la excepción revirtió todo, 0 tenants ZZZ que
-- quedaron):
--
--   51  desglose-a-medias-rechazado=t  negativo-rechazado=t
--       descuadrado-rechazado=t  borde-de-tolerancia-acepta=t  exacto-acepta=t
--       (esperado t/t/t/t/t)
do $$
declare
  t uuid;
  incoherente boolean := false;
  negativo boolean := false;
  descuadrado boolean := false;
  ok_borde_tolerancia boolean := false;
  ok_exacto boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF B51 '||gen_random_uuid()) returning id into t;

  -- 1. Medio desglose (subtotal sin iva) no se guarda.
  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, subtotal, iva)
      values (t, '2026-09-01', '2026-09-30', 10000, 8620.69, null);
  exception when check_violation then incoherente := true;
  end;

  -- 2. Un negativo no se guarda, aunque el resto del desglose cuadre.
  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, subtotal, iva)
      values (t, '2026-09-01', '2026-09-30', 8000, 9000, -1000);
  exception when check_violation then negativo := true;
  end;

  -- 3. subtotal+iva lejos de monto (mucho más que el centavo del redondeo):
  --    no se guarda. Suma 9000, faltan 1000 contra el monto de 10000.
  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, subtotal, iva)
      values (t, '2026-09-01', '2026-09-30', 10000, 8000, 1000);
  exception when check_violation then descuadrado := true;
  end;

  -- 4. EN EL BORDE de la tolerancia (diff = 0.01, el límite `<=`): SÍ se
  --    guarda. 8620.69 + 1379.30 = 9999.99, un centavo menos que 10000 — el
  --    resto exacto de dividir 10000/1.16 y redondear el subtotal a centavos.
  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, subtotal, iva)
    values (t, '2026-09-01', '2026-09-30', 10000, 8620.69, 1379.30);
  ok_borde_tolerancia := true;

  -- 5. Exacto, sin redondeo de por medio: también se guarda.
  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, subtotal, iva)
    values (t, '2026-10-01', '2026-10-31', 5000, 4310.34, 689.66);
  ok_exacto := true;

  raise exception E'51  desglose-a-medias-rechazado=%  negativo-rechazado=%  descuadrado-rechazado=%  borde-de-tolerancia-acepta=%  exacto-acepta=%   (esperado t/t/t/t/t)',
    incoherente, negativo, descuadrado, ok_borde_tolerancia, ok_exacto;
end $$;

-- ── 52. La cola del CFDI consolidado: única por línea, y cerrada a un anónimo (mig. 0076) ──
--
-- Dos garantías nuevas de `cfdi_consolidado_linea`, la tabla donde vive el JOIN
-- de auditoría 10 (diésel por monedero y peaje por TAG, ~54% del gasto real de
-- una flota, INEGI EAT 2024 — ver `docs/auditoria-10/fiscal.md`).
--
--   1. `unique (cfdi_xml_id, indice)`. WhatsApp/Meta SÍ reintenta el webhook, y
--      un reenvío del mismo XML no puede duplicar una línea: dos filas por el
--      mismo movimiento inflarían el conteo de "conciliadas" que ve el
--      contador en el panel, y le mentiría dos veces sobre el mismo peso.
--      `intake/consolidado.ts` además depende de esto para su idempotencia:
--      `guardarYConciliarConsolidado` usa `upsert(..., onConflict:
--      'cfdi_xml_id,indice')`, así que sin el índice el upsert haría un
--      INSERT liso y duplicaría en silencio.
--   2. RLS sin policy para `anon` — misma clase de fuga que la 0040
--      (`comprobante_huerfano`, bloque 23): esta tabla guarda folios de
--      operación, montos y el RFC de estaciones de servicio REALES (no el del
--      monedero) de TODAS las flotas.
--
-- Corrida REAL contra el proyecto Likida, 5-ago-2026 (0 tenants ZZZ y 0 filas
-- de sobra después — la excepción final revirtió todo):
--
--   52  mismo-indice-rebota=t  anon=0  service_role=1
--       FALSIFICADO (sin indice): duplicado-entra=t   (esperado t / 0 / 1 / t)
do $$
declare
  t uuid; x uuid;
  choco_indice boolean := false;
  sin_indice_entra boolean := false;
  n_anon int; n_service int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF B52 '||gen_random_uuid()) returning id into t;
  insert into cfdi_xml (tenant_id, cfdi_uuid, xml, tiene_multiples_conceptos, total_conceptos)
    values (t, 'uuid-verif-0076', '<cfdi/>', true, 2) returning id into x;

  insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, estatus)
    values (t, x, 1, 'ecc12', 100, 'conciliada');

  -- 1. La MISMA línea (cfdi_xml_id, indice) no entra dos veces.
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, estatus)
      values (t, x, 1, 'ecc12', 999, 'por_conciliar');
  exception when unique_violation then choco_indice := true;
  end;

  -- 2. Cerrada a un anónimo.
  begin
    set local role anon;
    select count(*) into n_anon from cfdi_consolidado_linea where tenant_id = t;
    reset role;
  exception when insufficient_privilege then
    reset role;
    n_anon := -1;
  end;
  select count(*) into n_service from cfdi_consolidado_linea where tenant_id = t;

  -- ═══ FALSIFICACIÓN: sin el índice único, el duplicado SÍ entraría ═══
  alter table cfdi_consolidado_linea drop constraint cfdi_consolidado_linea_cfdi_xml_id_indice_key;
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, estatus)
      values (t, x, 1, 'ecc12', 999, 'por_conciliar');
    sin_indice_entra := true;
  exception when others then sin_indice_entra := false;
  end;

  delete from tenant where id = t;
  raise exception E'52  mismo-indice-rebota=%  anon=%  service_role=%  FALSIFICADO (sin indice): duplicado-entra=%   (esperado t / <=0 / 1)',
    choco_indice, n_anon, n_service, sin_indice_entra;
end $$;

-- ── 53. cfdi_consolidado_linea admite 'sin_match', y solo eso — nada más (mig. 0077) ──
--
-- La 0077 amplía el check constraint de `estatus` para admitir un tercer
-- valor: 'sin_match' (un humano ya revisó la línea, vía `resolverLineaAMano`
-- en `intake/consolidado.ts`, y ningún gasto capturado le corresponde). La
-- garantía que solo la base puede demostrar es doble: que el valor NUEVO
-- entra, y que el constraint sigue siendo una LISTA CERRADA — que al
-- reescribirlo no se abrió por accidente a cualquier texto.
--
-- Corrida REAL contra el proyecto Likida, 5-ago-2026 (0 tenants ZZZ de sobra
-- después — la excepción final revirtió todo):
--
--   53  sin_match-entra=t  basura-rebota=t  (esperado t / t)
do $$
declare
  t uuid; x uuid;
  sin_match_entra boolean := false;
  basura_rebota boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF B53 '||gen_random_uuid()) returning id into t;
  insert into cfdi_xml (tenant_id, cfdi_uuid, xml, tiene_multiples_conceptos, total_conceptos)
    values (t, 'uuid-verif-0077', '<cfdi/>', true, 1) returning id into x;

  -- 1. 'sin_match' SÍ entra — la garantía que trae esta migración.
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, estatus)
      values (t, x, 1, 'ecc12', 100, 'sin_match');
    sin_match_entra := true;
  exception when others then sin_match_entra := false;
  end;

  -- 2. Un valor cualquiera SIGUE rebotando — el constraint es una lista
  --    cerrada, no se abrió al reescribirlo.
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, estatus)
      values (t, x, 2, 'ecc12', 100, 'basura');
  exception when check_violation then basura_rebota := true;
  end;

  delete from tenant where id = t;
  raise exception '53  sin_match-entra=%  basura-rebota=%  (esperado t / t)', sin_match_entra, basura_rebota;
end $$;

-- ── [RETIRADO] 54/55/56 — probaban RLS de una sesión de chofer que ya no
-- puede existir (0086 retira `operador` del dominio de rol: /chofer y
-- /mis-viajes salieron, el chofer solo usa WhatsApp). Los tres empezaban con
-- `insert into app_user (..., rol, ...) values (..., 'operador', ...)`, que
-- ahora rebota con la violación del constraint — no hay nada que impersonar.
-- La garantía que reemplaza a las tres es más fuerte: no "no ve lo ajeno",
-- sino "no puede tener sesión". Eso lo comprueba el bloque 62 (0086). Ver
-- EXENTAS en migraciones_verificadas.test.ts para 0078/0079/0081.
-- ── [antes aquí vivían los bloques 54, 55 y 56] ──────────────────────────
-- ── 61. config_tenant_valida NO crashea al actualizar un tenant con la ─────
-- facilidad del 15% declarada (mig. 0085).
-- La 0083 metió `r := o->'regimenElegible'` con `r` tipo `record`: asignar
-- jsonb a record es "input of anonymous composite types is not implemented".
-- Con la facilidad en config, el CHECK del tenant tronaba en CADA update
-- (nombre, RFC, suscripción). Aquí se reproduce el escenario exacto.
do $$
declare v_t uuid; v_n text;
begin
  insert into tenant (nombre, config) values
    ('ZZZ VERIF 0085', '{"facilidadCombustibleEfectivo":{"dedicacionExclusivaCarga":true,"regimenElegible":true}}'::jsonb)
  returning id into v_t;

  -- El CHECK valida de nuevo en el UPDATE: si la 0085 no está, esto truena.
  update tenant set nombre = 'ZZZ VERIF 0085 UPDATED' where id = v_t;

  select nombre into v_n from tenant where id = v_t;
  raise exception E'FACILIDAD_UPDATE  actualiza-con-facilidad=%  (esperado actualiza-con-facilidad=actualiza)', v_n;
end $$;

-- ── 62. `operador` no puede tener sesión — reemplaza a 54/55/56 (mig. 0086) ─
-- Retirado el rol del dominio, ya no hace falta impersonar a un chofer para
-- probar que no ve lo ajeno: se prueba que NO PUEDE EXISTIR. Se intenta el
-- INSERT que antes creaba la sesión de chofer (54/55/56 lo hacían tal cual)
-- y se espera el rechazo del CHECK. De paso, regresión de que un rol real
-- (flota_admin) sigue aislado por tenant en dos patrones de policy: el
-- simple (`viaje`, tenant_id propio) y el de join (`ticket_mensaje`, que
-- filtra vía `ticket_soporte` porque no tiene tenant_id propio) — para
-- confirmar que quitar `and not is_operador()` de 20 policies no aflojó el
-- aislamiento real que sí importa.
--
-- Corrida real (7-ago-2026, contra el proyecto Likida, recién aplicada 0086):
--   operador-rebota=t  viaje-propio=1  viaje-ajeno=0  ticket-mensaje-propio=1
--   (esperado t / 1 / 0 / 1 — los cuatro exactos)
do $$
declare
  v_a uuid; v_b uuid; v_op_a uuid; v_op_b uuid; v_via_a uuid; v_via_b uuid; v_tk uuid; v_u_a uuid := gen_random_uuid();
  operador_rebota boolean := false;
  n_viaje_propio int; n_viaje_ajeno int; n_ticket_propio int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0086 A') returning id into v_a;
  insert into tenant (nombre) values ('ZZZ VERIF 0086 B') returning id into v_b;

  -- El INSERT que antes creaba la sesión del chofer (54/55/56) ahora rebota.
  begin
    insert into app_user (id, tenant_id, email, rol) values (gen_random_uuid(), v_a, 'zzz-verif-operador@likida.test', 'operador');
  exception when check_violation then operador_rebota := true;
  end;

  insert into operador (tenant_id, nombre, telefono) values (v_a, 'Chofer ZZZ A', '520000009090') returning id into v_op_a;
  insert into operador (tenant_id, nombre, telefono) values (v_b, 'Chofer ZZZ B', '520000009091') returning id into v_op_b;
  insert into viaje (tenant_id, operador_id) values (v_a, v_op_a) returning id into v_via_a;
  insert into viaje (tenant_id, operador_id) values (v_b, v_op_b) returning id into v_via_b;
  insert into ticket_soporte (tenant_id, asunto) values (v_a, 'ZZZ ticket') returning id into v_tk;
  insert into ticket_mensaje (ticket_id, cuerpo) values (v_tk, 'hola');

  insert into app_user (id, tenant_id, email, rol) values (v_u_a, v_a, 'zzz-verif-flota-a@likida.test', 'flota_admin');

  -- ── El flota_admin de la A, impersonado ─────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u_a)::text, true);

  select count(*) into n_viaje_propio from viaje where tenant_id = v_a;
  select count(*) into n_viaje_ajeno from viaje where tenant_id = v_b;
  select count(*) into n_ticket_propio from ticket_mensaje where ticket_id = v_tk;

  reset role;

  delete from tenant where id in (v_a, v_b);   -- cascade limpia el resto
  raise exception E'RLS_0086  operador-rebota=%  viaje-propio=%  viaje-ajeno=%  ticket-mensaje-propio=%   (esperado t / 1 / 0 / 1)',
    operador_rebota, n_viaje_propio, n_viaje_ajeno, n_ticket_propio;
end $$;

-- ── 63. Historial del chat: rol acotado, deny-all y cascade (mig. 0088) ─────
-- Tres garantías que solo la base demuestra: (a) el CHECK de `rol` rebota un
-- rol fuera del dominio usuario/asistente; (b) RLS activo SIN políticas =
-- deny-all — hasta el DUEÑO autenticado ve cero filas, el único camino es el
-- service role del servidor (que ancla tenant+usuario en conversaciones.ts);
-- (c) borrar la conversación se lleva sus mensajes (cascade), no deja
-- huérfanos ilegibles.
--
-- Corrida real (13-ago-2026, contra el proyecto Likida, recién aplicada 0088):
--   rol-rebota=t  rls-conv=0  rls-msj=0  msjs-tras-borrar=0
--   (esperado t / 0 / 0 / 0 — los cuatro exactos)
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid(); v_c uuid;
  rol_rebota boolean := false;
  n_msjs_tras_borrar int; n_conv_rls int; n_msj_rls int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0088') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-verif-chat@likida.test', 'flota_admin');

  insert into chat_conversacion (tenant_id, user_id, titulo) values (v_t, v_u, 'ZZZ conversación') returning id into v_c;
  insert into chat_mensaje (conversacion_id, rol, texto) values (v_c, 'usuario', 'hola'), (v_c, 'asistente', 'listo');

  -- El CHECK del rol: 'sistema' no existe en el dominio.
  begin
    insert into chat_mensaje (conversacion_id, rol, texto) values (v_c, 'sistema', 'colado');
  exception when check_violation then rol_rebota := true;
  end;

  -- Deny-all: hasta el DUEÑO autenticado ve cero — el único camino es el
  -- service role del servidor, que ancla tenant+usuario en código.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u)::text, true);
  select count(*) into n_conv_rls from chat_conversacion where id = v_c;
  select count(*) into n_msj_rls from chat_mensaje where conversacion_id = v_c;
  reset role;

  -- Cascade: borrar la conversación se lleva sus mensajes.
  delete from chat_conversacion where id = v_c;
  select count(*) into n_msjs_tras_borrar from chat_mensaje where conversacion_id = v_c;

  delete from tenant where id = v_t;
  raise exception E'CHAT_0088  rol-rebota=%  rls-conv=%  rls-msj=%  msjs-tras-borrar=%   (esperado t / 0 / 0 / 0)',
    rol_rebota, n_conv_rls, n_msj_rls, n_msjs_tras_borrar;
end $$;

-- ── 64. Agente de Cobranza: claim único, ventana válida, deny-all, cascade (mig. 0089) ─
-- (a) unique(viaje, tier) rebota el doble claim — ES el candado anti-doble-
-- envío del agente; (b) el CHECK de ventana rechaza fin<=inicio; (c) RLS sin
-- políticas = deny-all; (d) borrar el viaje se lleva su bitácora.
--
-- Corrida real (13-ago-2026, contra el proyecto Likida, recién aplicada 0089):
--   doble-rebota=t  ventana-rebota=t  rls=0  tras-borrar=0
--   (esperado t / t / 0 / 0 — los cuatro exactos)
do $$
declare
  v_t uuid; v_op uuid; v_v uuid;
  doble_rebota boolean := false;
  ventana_rebota boolean := false;
  n_rls int; n_tras_borrar int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0089') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'Chofer ZZZ', '520000009092') returning id into v_op;
  insert into viaje (tenant_id, operador_id) values (v_t, v_op) returning id into v_v;

  insert into cobranza_contacto (tenant_id, viaje_id, tier) values (v_t, v_v, 3);
  begin
    insert into cobranza_contacto (tenant_id, viaje_id, tier) values (v_t, v_v, 3);
  exception when unique_violation then doble_rebota := true;
  end;

  begin
    insert into agente_cobranza_config (tenant_id, hora_inicio, hora_fin) values (v_t, 18, 9);
  exception when check_violation then ventana_rebota := true;
  end;

  set local role authenticated;
  select count(*) into n_rls from cobranza_contacto where tenant_id = v_t;
  reset role;

  delete from viaje where id = v_v;
  select count(*) into n_tras_borrar from cobranza_contacto where viaje_id = v_v;

  delete from tenant where id = v_t;
  raise exception E'COBRANZA_0089  doble-rebota=%  ventana-rebota=%  rls=%  tras-borrar=%   (esperado t / t / 0 / 0)',
    doble_rebota, ventana_rebota, n_rls, n_tras_borrar;
end $$;

-- ── 65. Los hitos del chofer: columnas de sello (mig. 0090) ─────────────────
--
-- Las tres columnas existen con el tipo correcto y nadie amaneció sellado
-- (corrida real 14-ago-2026: columnas_creadas=3, ya_sellados=0). La
-- atomicidad del sello es el UPDATE condicional (WHERE <col> IS NULL) de
-- Postgres — mismo criterio que la exención del 0087; la lógica de frases y
-- el acuse se prueban en TS (hitos_viaje.test.ts, processor_hitos.test.ts).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'viaje'
      and column_name in ('llegada_en', 'descarga_en', 'regreso_en')
      and data_type = 'timestamp with time zone') as columnas_creadas,
  (select count(*) from public.viaje
    where llegada_en is not null or descarga_en is not null or regreso_en is not null) as ya_sellados;

-- ── 66. Facturas de proveedor: dedup, dominio de estado y deny-all (mig. 0091) ──
--
-- Corrida real (14-ago-2026): doble-rebota=t (unique tenant+uuid), estado-
-- rebota=t (check del dominio pendiente|aprobada|rechazada), rls=0 (deny-all
-- para authenticated; solo el service role entra). El RAISE final revierte
-- los datos de prueba.
do $$
declare
  v_t uuid;
  doble_rebota boolean := false;
  estado_rebota boolean := false;
  n_rls int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0091') returning id into v_t;

  insert into factura_proveedor (tenant_id, cfdi_uuid, total, xml_crudo)
    values (v_t, 'uuid-verif-1', 100, '<x/>');
  begin
    insert into factura_proveedor (tenant_id, cfdi_uuid, total, xml_crudo)
      values (v_t, 'uuid-verif-1', 200, '<y/>');
  exception when unique_violation then doble_rebota := true;
  end;

  begin
    update factura_proveedor set estado = 'exportada' where tenant_id = v_t;
  exception when check_violation then estado_rebota := true;
  end;

  set local role authenticated;
  select count(*) into n_rls from factura_proveedor where tenant_id = v_t;
  reset role;

  delete from tenant where id = v_t;
  raise exception E'PROVEEDOR_0091  doble-rebota=%  estado-rebota=%  rls=%   (esperado t / t / 0)',
    doble_rebota, estado_rebota, n_rls;
end $$;

-- ── 67. viaje_folio_unico: el dedup del import ES de la base (mig. 0092) ──
--
-- Corrida real (14-ago-2026): doble-rebota=t (unique tenant+folio — el
-- segundo submit concurrente del mismo archivo choca aquí), otra-flota=t
-- (dos flotas SÍ pueden repetir folio: el unique es por tenant), nulos=2
-- (dos viajes de despacho WA con folio NULL conviven — NULLS DISTINCT).
-- TODOS los viajes de prueba van 'liquidado' para quedar FUERA del índice
-- parcial uq_viaje_abierto_por_operador (0029, abierto|en_cuadre): así el
-- único unique que puede rebotar aquí es viaje_folio_unico, no el de 0029.
-- El RAISE final revierte los datos de prueba.
do $$
declare
  v_t1 uuid; v_t2 uuid; v_op1 uuid; v_op2 uuid;
  doble_rebota boolean := false;
  otra_flota boolean := false;
  n_nulos int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0092 A') returning id into v_t1;
  insert into tenant (nombre) values ('ZZZ VERIF 0092 B') returning id into v_t2;
  -- Teléfonos distintos: uq_operador_telefono_activo es GLOBAL (no por tenant).
  insert into operador (tenant_id, nombre, telefono) values (v_t1, 'Verif', '+5210000000921') returning id into v_op1;
  insert into operador (tenant_id, nombre, telefono) values (v_t2, 'Verif', '+5210000000922') returning id into v_op2;

  insert into viaje (tenant_id, operador_id, folio, estatus) values (v_t1, v_op1, 'V-VERIF-1', 'liquidado');
  begin
    insert into viaje (tenant_id, operador_id, folio, estatus) values (v_t1, v_op1, 'V-VERIF-1', 'liquidado');
  exception when unique_violation then doble_rebota := true;
  end;

  begin
    insert into viaje (tenant_id, operador_id, folio, estatus) values (v_t2, v_op2, 'V-VERIF-1', 'liquidado');
    otra_flota := true;
  exception when unique_violation then otra_flota := false;
  end;

  insert into viaje (tenant_id, operador_id, folio, estatus) values (v_t1, v_op1, null, 'liquidado');
  insert into viaje (tenant_id, operador_id, folio, estatus) values (v_t1, v_op1, null, 'liquidado');
  select count(*) into n_nulos from viaje where tenant_id = v_t1 and folio is null;

  delete from tenant where id in (v_t1, v_t2);
  raise exception E'VIAJE_FOLIO_0092  doble-rebota=%  otra-flota=%  nulos=%   (esperado t / t / 2)',
    doble_rebota, otra_flota, n_nulos;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ── 68. Llaves de API por flota: la llave EN CLARO no cabe (mig. 0093) ──────
--
-- Lo que se comprueba, y por qué cada uno importa:
--   1. Una llave EN CLARO no cabe en la columna `hash`. Es el candado que
--      impide que un volcado de esta tabla —o un `select` de alguien con
--      service role— sea acceso directo a la API de todas las flotas.
--   2. Un hash de largo equivocado tampoco entra.
--   3. El mismo hash no se puede repetir: dos flotas no comparten llave.
--   4. Un `area` inventada rebota: fail closed, igual que un rol desconocido.
--   5. Un nombre vacío rebota: una lista de hashes sin nombre es
--      indistinguible y nadie se atreve a revocar ninguna.
--   6. RLS encendida.
--   7. Borrar la flota se lleva sus llaves: una flota dada de baja no puede
--      dejar credenciales vivas apuntando a ella.
--
-- CORRIDA REAL (14-ago-2026, proyecto gngoqsvrxdguxvsizpbw):
--   TENANT_API_KEY_0093  claro=t  corto=t  dup=t  area=t  nombre=t  rls=t
--                        huerfanas=0   (esperado t/t/t/t/t/t/0)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid;
  h1 text := repeat('a', 64);
  h2 text := repeat('b', 64);
  claro_rebota boolean := false;
  hash_corto_rebota boolean := false;
  dup_rebota boolean := false;
  area_mala_rebota boolean := false;
  nombre_vacio_rebota boolean := false;
  quedan int;
  rls boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0093') returning id into t;

  begin
    insert into tenant_api_key (tenant_id, nombre, prefijo, hash)
      values (t, 'en claro', 'lk_live_x', 'lk_live_secreto_en_claro');
  exception when check_violation then claro_rebota := true;
  end;

  begin
    insert into tenant_api_key (tenant_id, nombre, prefijo, hash)
      values (t, 'corto', 'lk_live_x', 'abc123');
  exception when check_violation then hash_corto_rebota := true;
  end;

  insert into tenant_api_key (tenant_id, nombre, prefijo, hash, area)
    values (t, 'TMS propio', 'lk_live_abc123', h1, 'operacion');

  begin
    insert into tenant_api_key (tenant_id, nombre, prefijo, hash)
      values (t, 'duplicada', 'lk_live_abc123', h1);
  exception when unique_violation then dup_rebota := true;
  end;

  begin
    insert into tenant_api_key (tenant_id, nombre, prefijo, hash, area)
      values (t, 'area mala', 'lk_live_zzz', h2, 'todo');
  exception when check_violation then area_mala_rebota := true;
  end;

  begin
    insert into tenant_api_key (tenant_id, nombre, prefijo, hash)
      values (t, '   ', 'lk_live_yyy', h2);
  exception when check_violation then nombre_vacio_rebota := true;
  end;

  select relrowsecurity into rls from pg_class where relname = 'tenant_api_key';

  delete from tenant where id = t;
  select count(*) into quedan from tenant_api_key where tenant_id = t;

  raise exception E'TENANT_API_KEY_0093  claro=%  corto=%  dup=%  area=%  nombre=%  rls=%  huerfanas=%   (esperado t/t/t/t/t/t/0)',
    claro_rebota, hash_corto_rebota, dup_rebota, area_mala_rebota, nombre_vacio_rebota, rls, quedan;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ── 69. Credenciales de conector: un JSON en claro NO cabe (mig. 0094) ──────
--
-- La tabla existe porque `rastreo_credencial` (0050) solo acepta proveedores de
-- GPS, así que 14 de los 19 conectores no tenían dónde guardar sus accesos.
--
-- Lo que se comprueba:
--   1. Un JSON EN CLARO rebota. Es el candado que impide que la contraseña de
--      un SAP se guarde sin cifrar por un descuido del llamador: un objeto
--      serializado empieza con `{` y un cifrado nunca.
--   2. Un `conector_id` vacío rebota.
--   3. DOS juegos de accesos al mismo conector en la misma flota rebotan: es
--      una ambigüedad que nadie sabría resolver al conectar.
--   4. Pero OTRA flota SÍ puede tener su propio SAP — el unique es por
--      (tenant, conector), no global.
--   5. RLS encendida con su política.
--   6. Borrar la flota se lleva sus credenciales: una flota dada de baja no
--      puede dejar accesos vivos a los sistemas de su cliente.
--
-- CORRIDA REAL (14-ago-2026, proyecto gngoqsvrxdguxvsizpbw):
--   CONECTOR_CREDENCIAL_0094  en_claro=t  id_vacio=t  dup=t  otra_flota=t
--                             rls=t  politicas=1  huerfanas=0
--                             (esperado t/t/t/t/t/1/0)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; t2 uuid;
  en_claro_rebota boolean := false;
  id_vacio_rebota boolean := false;
  dup_rebota boolean := false;
  otra_flota_ok boolean := false;
  quedan int;
  rls boolean;
  pol int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0094 A') returning id into t;
  insert into tenant (nombre) values ('ZZZ VERIF 0094 B') returning id into t2;

  begin
    insert into conector_credencial (tenant_id, conector_id, valores_cifrados)
      values (t, 'sap_b1', '{"password":"secreto"}');
  exception when check_violation then en_claro_rebota := true;
  end;

  begin
    insert into conector_credencial (tenant_id, conector_id, valores_cifrados)
      values (t, '   ', 'AAAAcifradoAAAA');
  exception when check_violation then id_vacio_rebota := true;
  end;

  insert into conector_credencial (tenant_id, conector_id, valores_cifrados, pistas)
    values (t, 'sap_b1', 'AAAAcifradoAAAA', '{"host":"sap.cliente.mx","usuario":"likida","password":"…4f2a"}');

  begin
    insert into conector_credencial (tenant_id, conector_id, valores_cifrados)
      values (t, 'sap_b1', 'BBBBotroBBBB');
  exception when unique_violation then dup_rebota := true;
  end;

  begin
    insert into conector_credencial (tenant_id, conector_id, valores_cifrados)
      values (t2, 'sap_b1', 'CCCCterceroCCCC');
    otra_flota_ok := true;
  exception when unique_violation then otra_flota_ok := false;
  end;

  select relrowsecurity into rls from pg_class where relname='conector_credencial';
  select count(*) into pol from pg_policies where tablename='conector_credencial';

  delete from tenant where id in (t, t2);
  select count(*) into quedan from conector_credencial where tenant_id in (t, t2);

  raise exception E'CONECTOR_CREDENCIAL_0094  en_claro=%  id_vacio=%  dup=%  otra_flota=%  rls=%  politicas=%  huerfanas=%   (esperado t/t/t/t/t/1/0)',
    en_claro_rebota, id_vacio_rebota, dup_rebota, otra_flota_ok, rls, pol, quedan;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ── 70. Buzón de intake: el token NO se deriva del tenant (mig. 0095) ───────
--
-- La dirección `f-<token>@mail.likida.ai` es por donde entran las facturas de
-- talleres y diésel. El token es ALEATORIO y no el `tenant_id`, porque un id
-- aparece en URLs, logs y exports: quien lo tuviera podría inyectar facturas
-- falsas en la contabilidad de esa flota. Un id identifica, no autoriza.
--
-- Lo que se comprueba:
--   1. Un token CORTO rebota — sería adivinable.
--   2. Caracteres AMBIGUOS (0/O, 1/l) rebotan: la dirección se dicta por
--      teléfono y se transcribe mal.
--   3. El bueno entra.
--   4. DOS flotas no pueden compartir buzón: la una recibiría las facturas de
--      la otra.
--   5. Pero muchas flotas SÍ pueden tener NULL a la vez — el índice único es
--      parcial, porque una flota sin buzón simplemente no lo tiene encendido.
--
-- CORRIDA REAL (14-ago-2026, proyecto gngoqsvrxdguxvsizpbw):
--   BUZON_INTAKE_0095  corto=t  ambiguo=t  bueno=t  dup=t  nulos_conviven=t
--                      (esperado t/t/t/t/t)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid; t2 uuid;
  corto_rebota boolean := false;
  ambiguo_rebota boolean := false;
  dup_rebota boolean := false;
  nulos_conviven boolean := false;
  bueno_entra boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0095 A') returning id into t;
  insert into tenant (nombre) values ('ZZZ VERIF 0095 B') returning id into t2;

  begin
    update tenant set buzon_token = 'abc' where id = t;
  exception when check_violation then corto_rebota := true;
  end;

  begin
    update tenant set buzon_token = 'abcdefgh0ijklmnop1qrstuv' where id = t;
  exception when check_violation then ambiguo_rebota := true;
  end;

  update tenant set buzon_token = 'abcdefghjkmnpqrstvwxyz23' where id = t;
  select true into bueno_entra;

  begin
    update tenant set buzon_token = 'abcdefghjkmnpqrstvwxyz23' where id = t2;
  exception when unique_violation then dup_rebota := true;
  end;

  select count(*) = 0 into nulos_conviven
    from tenant where buzon_token is null and id = t2;
  nulos_conviven := not nulos_conviven;

  delete from tenant where id in (t, t2);

  raise exception E'BUZON_INTAKE_0095  corto=%  ambiguo=%  bueno=%  dup=%  nulos_conviven=%   (esperado t/t/t/t/t)',
    corto_rebota, ambiguo_rebota, bueno_entra, dup_rebota, nulos_conviven;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ── 71. Idempotencia del correo entrante (mig. 0096) ───────────────────────
--
-- Resend REINTENTA cualquier webhook que no conteste 2xx. Sin esta tabla, un
-- timeout nuestro a mitad de proceso produce una segunda entrega del MISMO
-- correo y una segunda factura en la contabilidad del cliente.
--
-- El dedup de `factura_proveedor` (unique tenant+uuid) NO alcanza: atrapa el
-- mismo CFDI, pero no el correo con varios adjuntos donde el segundo falló —
-- al reintentar, el primero se re-procesa. Por eso la llave es el CORREO.
--
-- El insert ES la comprobación (llave primaria). Preguntar-y-después-escribir
-- dejaría una ventana por la que se cuelan dos entregas simultáneas.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  repite_rebota boolean := false;
  primero_entra boolean := false;
begin
  insert into correo_procesado (email_id) values ('ZZZ-VERIF-0096');
  primero_entra := true;

  begin
    insert into correo_procesado (email_id) values ('ZZZ-VERIF-0096');
  exception when unique_violation then repite_rebota := true;
  end;

  delete from correo_procesado where email_id = 'ZZZ-VERIF-0096';

  raise exception E'CORREO_PROCESADO_0096  primero=%  repite_rebota=%   (esperado t/t)',
    primero_entra, repite_rebota;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ── 72. Notificaciones por agente: la huella va completa (mig. 0097) ───────
--
-- Lo que se comprueba:
--   1. Un `agente` con typo NO crea una fila de config inalcanzable en
--      silencio — el dominio duplica el catálogo de TypeScript a propósito.
--   2. Un `evento` inventado tampoco.
--   3. Magnitud negativa rebota.
--   4. LA HUELLA VA COMPLETA O NO VA: una con `avisado_en` pero sin
--      `magnitud_avisada` se leería como magnitud 0 —"cualquier cosa es
--      noticia"— y el anti-ruido dejaría de existir sin que nada fallara.
--   5. Completa sí entra.
--   6. EL CLAIM: un UPDATE condicional dentro del piso de 60 min afecta CERO
--      filas. Es lo que impide que dos corridas solapadas de Vercel Cron
--      manden dos copias del mismo aviso.
--   7. Borrar la flota se lleva su configuración.
--
-- CORRIDA REAL (14-ago-2026, proyecto gngoqsvrxdguxvsizpbw):
--   AGENTE_NOTIF_0097  agente_malo=t  evento_malo=t  magnitud_neg=t
--                      huella_coja=t  completa=t  claim_reciente_no_pasa=0
--                      huerfanas=0   (esperado t/t/t/t/t/0/0)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  t uuid;
  agente_malo boolean := false;
  evento_malo boolean := false;
  huella_coja boolean := false;
  magnitud_neg boolean := false;
  huella_completa_ok boolean := false;
  claim_gana int;
  quedan int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0097') returning id into t;

  begin
    insert into agente_notificacion_config (tenant_id, agente) values (t, 'liquidacionn');
  -- Desde la 0204 el candado es una FK a `agente_definicion` (la mudanza
  -- CHECK → FK del bloque 162); la garantía es la misma — el typo rebota.
  exception when check_violation or foreign_key_violation then agente_malo := true;
  end;

  begin
    insert into agente_notificacion_estado (tenant_id, agente, evento) values (t, 'cobranza', 'lo_que_sea');
  exception when check_violation then evento_malo := true;
  end;

  begin
    insert into agente_notificacion_estado (tenant_id, agente, evento, magnitud)
      values (t, 'cobranza', 'corrida_fallida', -1);
  exception when check_violation then magnitud_neg := true;
  end;

  begin
    insert into agente_notificacion_estado (tenant_id, agente, evento, avisado_en)
      values (t, 'cobranza', 'corrida_fallida', now());
  exception when check_violation then huella_coja := true;
  end;

  insert into agente_notificacion_estado (tenant_id, agente, evento, magnitud, avisado_en, magnitud_avisada)
    values (t, 'cobranza', 'corrida_fallida', 5, now(), 5);
  huella_completa_ok := true;

  update agente_notificacion_estado
     set avisado_en = now(), magnitud_avisada = 20
   where tenant_id = t and agente = 'cobranza' and evento = 'corrida_fallida'
     and (avisado_en is null or avisado_en < now() - interval '60 minutes');
  get diagnostics claim_gana = row_count;

  delete from tenant where id = t;
  select count(*) into quedan from agente_notificacion_config where tenant_id = t;

  raise exception E'AGENTE_NOTIF_0097  agente_malo=%  evento_malo=%  magnitud_neg=%  huella_coja=%  completa=%  claim_reciente_no_pasa=%  huerfanas=%   (esperado t/t/t/t/t/0/0)',
    agente_malo, evento_malo, magnitud_neg, huella_coja, huella_completa_ok, claim_gana, quedan;
end $$;

-- ── 73. Idempotencia durable de la API v1 (mig. 0098) ──────────────────────
--
-- Lo que se prueba NO es el duplicado: ése ya lo impide la llave natural
-- (`viaje_folio_unico`) y no depende de esta tabla. Se prueba lo que esta
-- tabla añade — que la MISMA llave no pueda servir dos respuestas distintas —
-- y las tres formas en que la base se niega a guardar basura que después se
-- serviría como si fuera buena.
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026. Salida real:
--   politicas=0  rls=true  filas_residuales=0  → todos los guardias rechazaron
--
-- `politicas=0` con `rls=true` es lo esperado y no un olvido: esta tabla la
-- toca EXCLUSIVAMENTE la capa de API con service role. Sin políticas, ningún
-- camino con llave anónima o de usuario puede leerla ni escribirla.
--
-- CORREGIDO el 15-ago-2026: `t` salía de `select id into t from tenant limit
-- 1` — depende de que YA exista una fila en `tenant`, algo que la base que
-- corrió esto el 14-ago tenía y una base efímera de CI no. Con `t` en NULL,
-- el primer INSERT truena por la columna NOT NULL antes de que el bloque
-- llegue a probar nada — lo confirmó la primera corrida automática de este
-- archivo en CI (15-ago-2026). Se siembra su propio tenant, como hace el
-- resto del archivo.
do $$
declare
  t uuid;
  llave_corta boolean := false;
  huella_mala boolean := false;
  status_500  boolean := false;
  dup_llave   boolean := false;
  otra_ruta_convive boolean := false;
  politicas int;
  rls_on boolean;
begin
  insert into public.tenant (nombre) values ('ZZZ VERIF API_IDEMPOTENCIA') returning id into t;

  -- Una llave de un carácter colisionaría entre peticiones sin relación, y
  -- quien llegara segundo recibiría la respuesta del primero.
  begin
    insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo)
    values (t,'v1.viajes.post','corta', repeat('a',64), 201, '{}'::jsonb);
  exception when check_violation then llave_corta := true; end;

  begin
    insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo)
    values (t,'v1.viajes.post','llave-valida-1234','no-es-un-hash',201,'{}'::jsonb);
  exception when check_violation then huella_mala := true; end;

  -- Un 500 NO se recuerda: un fallo sí se puede reintentar, y grabarlo dejaría
  -- al integrador replayando su propio error para siempre.
  begin
    insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo)
    values (t,'v1.viajes.post','llave-valida-1234',repeat('b',64),500,'{}'::jsonb);
  exception when check_violation then status_500 := true; end;

  insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo)
  values (t,'v1.viajes.post','llave-valida-1234',repeat('c',64),201,'{"dato":{"folio":"VJ-1"}}'::jsonb);

  begin
    insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo)
    values (t,'v1.viajes.post','llave-valida-1234',repeat('d',64),200,'{}'::jsonb);
  exception when unique_violation then dup_llave := true; end;

  -- La misma llave en OTRA ruta SÍ convive: un cliente que reusa su llave entre
  -- recursos no debe recibir el cuerpo del recurso equivocado, pero tampoco un
  -- rechazo — son dos operaciones distintas.
  insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo)
  values (t,'v1.unidades.post','llave-valida-1234',repeat('e',64),201,'{}'::jsonb);
  otra_ruta_convive := true;

  delete from public.api_idempotencia where tenant_id = t and llave = 'llave-valida-1234';

  select count(*) into politicas from pg_policies where tablename = 'api_idempotencia';
  select relrowsecurity into rls_on from pg_class where relname = 'api_idempotencia';

  delete from public.tenant where id = t;

  raise exception E'API_IDEMPOTENCIA_0098  llave_corta=%  huella_mala=%  status_500=%  dup_llave=%  otra_ruta=%  politicas=%  rls=%   (esperado t/t/t/t/t/0/t)',
    llave_corta, huella_mala, status_500, dup_llave, otra_ruta_convive, politicas, rls_on;
end $$;

-- ── 74. La purga de la idempotencia respeta lo reciente (mig. 0098) ────────
--
-- Una purga que borra de más es peor que no purgar: se lleva el recuerdo de
-- un reintento que todavía está en vuelo, y el TMS recibe una respuesta
-- distinta a la que ya había recibido. Por eso lo que se prueba no es que
-- borre, sino que DEJE la fresca.
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026. Salida real:
--   borradas=1  quedan_frescas=1  reporta_la_llave=t
--
-- `reporta_la_llave` verifica que `mantenimiento_de_datos` incluya el conteo
-- en su jsonb: el cron registra ese objeto en el log, y una purga que corre
-- sin aparecer ahí es una purga que nadie puede auditar.
--
-- CORREGIDO el 15-ago-2026: mismo caso que el bloque 73 — `t` dependía de que
-- YA existiera una fila en `tenant`. Se siembra su propio tenant. De paso,
-- `borradas` queda más preciso: con la tabla arrancando vacía para este
-- tenant, la única fila vieja que puede purgarse es la que este bloque
-- sembró, sin depender de cuántas otras filas viejas hubiera de antes.
do $$
declare t uuid; borradas bigint; quedan int; res jsonb;
begin
  insert into public.tenant (nombre) values ('ZZZ VERIF PURGA_0098') returning id into t;

  insert into public.api_idempotencia(tenant_id,ruta,llave,huella,status,cuerpo,created_at)
  values (t,'v1.viajes.post','purga-vieja-0001',repeat('a',64),201,'{}'::jsonb, now() - interval '9 days'),
         (t,'v1.viajes.post','purga-fresca-001',repeat('b',64),201,'{}'::jsonb, now() - interval '1 hour');

  borradas := public.purgar_api_idempotencia();

  select count(*) into quedan from public.api_idempotencia
   where tenant_id = t and llave in ('purga-vieja-0001','purga-fresca-001');

  res := public.mantenimiento_de_datos(30);

  delete from public.api_idempotencia where tenant_id = t and llave like 'purga-%';
  delete from public.tenant where id = t;

  raise exception E'PURGA_0098  borradas=%  quedan_frescas=%  reporta_la_llave=%   (esperado 1/1/t)',
    borradas, quedan, (res ? 'idempotenciaPurgada');
end $$;

-- ── 75. Ninguna función de purga es alcanzable por `anon` (mig. 0098) ──────
--
-- El bug que este bloque existe para que no vuelva: `purgar_api_idempotencia`
-- se creó SECURITY DEFINER SIN `revoke`, y Postgres deja EXECUTE a PUBLIC por
-- omisión. Supabase la publicaba en /rest/v1/rpc/, corría como `postgres`,
-- saltaba la RLS que la propia migración encendía, y cualquiera con la anon
-- key —pública por diseño, va en el bundle— podía vaciar la tabla desde
-- internet llamándola con p_dias=0.
--
-- Se comprueba el CONJUNTO y no solo la función culpable: el modo de falla es
-- omitir el revoke al escribir la SIGUIENTE, y una prueba que solo mira la de
-- ayer no atrapa la de mañana.
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026, antes y después del arreglo:
--   antes:   purgar_api_idempotencia  anon_puede=t   ← las otras 3 en f
--   después: purgar_api_idempotencia  anon_puede=f   acl = postgres=X | service_role=X
--
-- CORREGIDO el 15-ago-2026, dos veces:
--
--   1. La condición original decía "abierta a `anon` O a `authenticated`", y
--      el título del bloque dice `anon` — no las dos. Con `authenticated` en
--      la mezcla, el bloque nunca podía dar vacío: incluía a
--      `administra_flota()`/`ve_finanzas()`, abiertas a `authenticated` A
--      PROPÓSITO desde la 0054, para que el panel pueda llamarlas con
--      sesión.
--   2. Ajustada solo a `anon`, seguía sin poder dar vacío por
--      `get_user_tenant_ids()`/`is_superadmin()` — SECURITY DEFINER
--      ejecutables por `anon` A PROPÓSITO: las usan 38 y 42 políticas RLS
--      respectivamente, y el motor de RLS las llama con el rol de quien
--      pregunta —sesión anónima incluida—; revocarlas rompería el
--      aislamiento en vez de cerrarlo (mismo caso que documenta el bloque
--      18, y el mismo mecanismo de excepción automática que usa
--      `capa1_auditoria_estatica.sql`, bloque B: si alguna política RLS
--      nombra a la función en su USING/WITH CHECK, es un ayudante y se
--      exceptúa sola).
--
-- La primera corrida automática de este archivo en CI (15-ago-2026) lo
-- confirmó las dos veces: el bloque fallaba SIEMPRE, contra una base sana,
-- por su propia condición — nadie lo había notado porque nadie lo corría.
do $$
declare abiertas text;
begin
  select string_agg(p.proname, ', ') into abiertas
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef                       -- solo las que corren como postgres
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not exists (                      -- ayudante de RLS: se exceptúa sola
       select 1 from pg_policies pol
        where pol.schemaname = 'public'
          and (coalesce(pol.qual, '') ilike '%' || p.proname || '%'
               or coalesce(pol.with_check, '') ilike '%' || p.proname || '%')
     );

  raise exception E'PURGA_ACL_0098  funciones_security_definer_abiertas_a_anon=[%]   (esperado vacío)',
    coalesce(abiertas, '');
end $$;

-- ── 76. Carta Porte: los datos del transportista tienen dónde vivir (0099) ─
--
-- Seis columnas nuevas en `unidad` (configuración vehicular, peso bruto,
-- aseguradora y póliza RC, tipo y número de permiso SICT) y las dos
-- DECLARACIONES por viaje (¿pisa federal?, radio del tramo federal). Todas
-- nullables y sin defaults de catálogo: un permiso no declarado NO es TPXX00,
-- y un NULL en ccp_pisa_federal significa "falta declarar", nunca "no pisa".
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   parte 1: cols_unidad=6  cols_viaje=2  defaults_indebidos=0  checks=2
--   parte 2: CCP_0099  peso_250_rebota=t  radio_negativo_rebota=t  (esperado t/t)
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='unidad'
      and column_name in ('config_vehicular','peso_bruto_ton','aseguradora_rc','poliza_rc_numero','permiso_sict_tipo','permiso_sict_numero')) as cols_unidad,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='viaje'
      and column_name in ('ccp_pisa_federal','ccp_radio_federal_km')) as cols_viaje,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='unidad'
      and column_name in ('config_vehicular','permiso_sict_tipo') and column_default is not null) as defaults_indebidos,
  (select count(*) from pg_constraint where conname in ('unidad_peso_bruto_sano','viaje_ccp_radio_sano')) as checks;

do $$
declare t uuid; u uuid; peso_malo boolean := false; radio_malo boolean := false;
begin
  insert into public.tenant (nombre) values ('__verif_0099__') returning id into t;
  insert into public.unidad (tenant_id, numero_economico, peso_bruto_ton, config_vehicular)
    values (t, '__V99__', 17.5, 'T3S2') returning id into u;
  begin
    update public.unidad set peso_bruto_ton = 250 where id = u;
  exception when check_violation then peso_malo := true;
  end;
  begin
    insert into public.viaje (tenant_id, folio, ccp_radio_federal_km) values (t, '__V99__', -5);
  exception when others then radio_malo := true;
  end;
  delete from public.tenant where id = t;  -- el raise de abajo revierte todo igual
  raise exception E'CCP_0099  peso_250_rebota=%  radio_negativo_rebota=%   (esperado t/t)', peso_malo, radio_malo;
end $$;

-- ── 77. La oposición del titular tiene dónde vivir (0100) ──────────────────
--
-- `operador.oposicion_automatizada`: timestamptz nullable sin default. NULL =
-- derecho no ejercido (medición, no relleno); con fecha, el motor de cuadre
-- manda toda liquidación suya a revisión humana (diferencia oposicion_titular).
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   [{"column_name":"oposicion_automatizada","data_type":"timestamp with time zone","is_nullable":"YES","column_default":null}]
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='operador' and column_name='oposicion_automatizada';

-- ── 78. La purga del intake por correo existe y no es alcanzable (0101) ────
--
-- `correo_procesado` crecía para siempre: la 0096 creó el índice por fecha
-- "para poder limpiar" y `mantenimiento_de_datos` nunca la tocó (C3,
-- auditoría 4). Ahora la purga borra lo más viejo que 90 días, conserva lo
-- fresco, reporta su llave en el jsonb del mantenimiento, y NO es ejecutable
-- por `anon` (la lección de la 0098, aplicada de entrada).
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   PURGA_CORREO_0101  borradas=1  quedan_frescas=1  llave_en_jsonb=t  anon_puede=f  (esperado >=1/1/t/f)
do $$
declare res jsonb; quedan bigint; borro bigint; anon_puede boolean;
begin
  insert into public.correo_procesado (email_id, created_at) values
    ('verif-0101-viejo', now() - interval '120 days'),
    ('verif-0101-fresco', now() - interval '2 days');
  res := public.mantenimiento_de_datos(30);
  select count(*) into quedan from public.correo_procesado where email_id like 'verif-0101-%';
  borro := (res->>'correoPurgado')::bigint;
  select has_function_privilege('anon', 'public.purgar_correo_procesado(integer, timestamptz)', 'EXECUTE') into anon_puede;
  raise exception E'PURGA_CORREO_0101  borradas=%  quedan_frescas=%  llave_en_jsonb=%  anon_puede=%   (esperado >=1/1/t/f)',
    borro, quedan, (res ? 'correoPurgado'), anon_puede;
end $$;

-- ── 79. La bitácora de corridas de agentes existe y se purga (0102) ────────
--
-- `agente_corrida`: una fila por (corrida × flota) con Periodo · Estado ·
-- Tareas · Duración — la ficha de referencia. Dominios vigilados por CHECK,
-- lectura por tenant vía RLS, escritura solo service role, purga a 180 días
-- integrada a `mantenimiento_de_datos` con su revoke desde el día uno.
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   CORRIDA_0102  agente_malo_rebota=t  estado_malo_rebota=t  purga_reporta=t  purgo_vieja=1  anon_puede=f  (esperado t/t/t/1/f)
do $$
declare t uuid; rebota_agente boolean := false; rebota_estado boolean := false; res jsonb; anon_puede boolean;
begin
  insert into public.tenant (nombre) values ('__verif_0102__') returning id into t;
  insert into public.agente_corrida (tenant_id, agente, inicio, fin, estado, disparo, tareas_hechas, tareas_total)
    values (t, 'cobranza', now() - interval '5 minutes', now(), 'ok', 'cron', 3, 3);
  begin
    insert into public.agente_corrida (tenant_id, agente, inicio, estado) values (t, 'inventado', now(), 'ok');
  -- Desde la 0116 el guardián del agente es la FK contra agente_definicion,
  -- no el CHECK enumerado — la garantía es la misma (un agente inventado no
  -- escribe corridas), el mecanismo cambió. El bloque 91 prueba la mudanza
  -- completa; aquí solo se acepta el error nuevo junto al viejo.
  exception when check_violation or foreign_key_violation then rebota_agente := true;
  end;
  begin
    insert into public.agente_corrida (tenant_id, agente, inicio, estado) values (t, 'peajes', now(), 'verde');
  exception when check_violation then rebota_estado := true;
  end;
  insert into public.agente_corrida (tenant_id, agente, inicio, estado, creada_en)
    values (t, 'peajes', now() - interval '200 days', 'ok', now() - interval '200 days');
  res := public.mantenimiento_de_datos(30);
  select has_function_privilege('anon', 'public.purgar_agente_corrida(integer, timestamptz)', 'EXECUTE') into anon_puede;
  raise exception E'CORRIDA_0102  agente_malo_rebota=%  estado_malo_rebota=%  purga_reporta=%  purgo_vieja=%  anon_puede=%   (esperado t/t/t/1/f)',
    rebota_agente, rebota_estado, (res ? 'corridasPurgadas'), (res->>'corridasPurgadas'), anon_puede;
end $$;

-- ── 80. El índice muerto de conector_credencial se tiró (0103) ─────────────
--
-- El parcial `conector_credencial_por_flota` estaba totalmente cubierto por
-- el UNIQUE `conector_credencial_unica` (mismas columnas, sin filtro).
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   [{"indice_muerto":0,"unique_vivo":1}]
select
  (select count(*) from pg_indexes where schemaname='public' and indexname='conector_credencial_por_flota') as indice_muerto,
  (select count(*) from pg_indexes where schemaname='public' and indexname='conector_credencial_unica') as unique_vivo;

-- ── 81. F1 resuelto por evidencia: 0067-0069 NUNCA EXISTIERON ──────────────
--
-- La auditoría 4 reportó "migraciones 0067, 0068 y 0069 sin archivo" como el
-- modo de falla de apply_migration por MCP. Se verificó contra el registro
-- de producción (supabase_migrations.schema_migrations) y contra el repo:
--   · el registro NO tiene ninguna migración con esos números ni ninguna
--     entrada sin archivo correspondiente en esa ventana (05-ago-2026);
--   · cero referencias a 0067/0068/0069 en supabase/, src/ y docs/;
--   · el hueco es de NUMERACIÓN (la secuencia saltó de 0066 a 0070), no de
--     archivos perdidos: una base reconstruida desde el repo NO diverge por
--     esta causa.
-- Lo que el registro SÍ mostró es lo inverso: los archivos 0078-0085 no
-- aparecen en el ledger (se aplicaron fuera de él); sus objetos SÍ están en
-- producción — verificado abajo por muestreo (función de la 0084, columna de
-- la 0080). El repo sigue siendo la fuente de verdad reconstruible.
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   [{"f_0084":1,"col_0080":1,"col_avisos":1,"ledger_0067_69":0}]
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='sumar_combustible_ejercicio') as f_0084,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='operador' and column_name='rfc') as col_0080,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='viaje' and column_name='escalado_en') as col_avisos,
  (select count(*) from supabase_migrations.schema_migrations
    where name ~ '^00(6[7-9])') as ledger_0067_69;

-- ── 82. La retención operativa prometida ya corre (0104) ───────────────────
--
-- /privacidad prometía plazos de borrado sin ejecutor (E5, auditoría 4). Las
-- dos purgas nuevas (wa_conversacion y codigo_pendiente a 180 días) borran lo
-- viejo, conservan lo fresco, reportan sus llaves en el jsonb del
-- mantenimiento, y NO son ejecutables por anon. Nada fiscal se toca: el CFF
-- 30 obliga a conservarlo (ver la cabecera de la 0104 para el porqué de cada
-- exclusión).
--
-- CORRIDO CONTRA PRODUCCIÓN el 14-ago-2026:
--   RETENCION_0104  conv_purgadas=1  cod_purgados=1  quedan_conv=1  quedan_cod=1  anon=f/f  (esperado >=1/>=1/1/1/f/f)
do $$
declare t uuid; op uuid; v uuid; res jsonb; quedan_conv bigint; quedan_cod bigint; anon_conv boolean; anon_cod boolean;
begin
  insert into public.tenant (nombre) values ('__verif_0104__') returning id into t;
  insert into public.operador (tenant_id, nombre, telefono) values (t, '__V104__', '5210000000104') returning id into op;
  insert into public.viaje (tenant_id, operador_id, folio) values (t, op, '__V104__') returning id into v;
  insert into public.wa_conversacion (tenant_id, telefono, estado, updated_at) values
    (t, '5210000000001', '{}', now() - interval '200 days'),
    (t, '5210000000002', '{}', now() - interval '2 days');
  insert into public.codigo_pendiente (tenant_id, viaje_id, monto, creado_en) values
    (t, v, 100, now() - interval '200 days'),
    (t, v, 200, now() - interval '2 days');
  res := public.mantenimiento_de_datos(30);
  select count(*) into quedan_conv from public.wa_conversacion where tenant_id = t;
  select count(*) into quedan_cod from public.codigo_pendiente where tenant_id = t;
  select has_function_privilege('anon', 'public.purgar_wa_conversacion(integer, timestamptz, timestamptz)', 'EXECUTE') into anon_conv;
  select has_function_privilege('anon', 'public.purgar_codigo_pendiente(integer, timestamptz, timestamptz)', 'EXECUTE') into anon_cod;
  raise exception E'RETENCION_0104  conv_purgadas=%  cod_purgados=%  quedan_conv=%  quedan_cod=%  anon_conv=%  anon_cod=%   (esperado >=1 / >=1 / 1 / 1 / f / f)',
    (res->>'conversacionesPurgadas'), (res->>'codigosPurgados'), quedan_conv, quedan_cod, anon_conv, anon_cod;
end $$;

-- ── 83. La zona de vendedores (0105) ───────────────────────────────────────
--
-- Tres cosas que solo la base puede demostrar: (a) el rol `vendedor` entró
-- al dominio y un rol inventado sigue rebotando; (b) `prospecto` vigila su
-- embudo — estado fuera del dominio rebota, cerrado exige `cerrado_en` (y
-- viceversa), `tenant_id` solo se acepta en cerrado, empresa en blanco
-- rebota, y la tabla tiene RLS SIN políticas (deny-all: cero policies en
-- pg_policies); (c) `agente_corrida` acepta al agente `ventas` con
-- `tenant_id` NULL y sigue rebotando un agente inventado. Todo dentro de un
-- DO que revierte con su excepción final — no queda ni una fila.
--
-- SALIDA REAL (14-ago-2026, corrida vía MCP tras aplicar la 0105):
--   ERROR: P0001: VENDEDORES_0105  rol_malo_rebota=t  estado_malo=t
--   cerrado_sin_fecha=t  fecha_sin_cerrado=t  tenant_sin_cerrar=t
--   empresa_vacia=t  rls=t  policies=0  indice=1  agente_malo=t
--   (esperado t/t/t/t/t/t/t/0/1/t) — coincide; el RAISE final revirtió
--   todas las filas de prueba.
do $$
declare
  u uuid := gen_random_uuid(); p uuid; t uuid;
  rol_malo boolean := false; estado_malo boolean := false;
  cerrado_sin_fecha boolean := false; fecha_sin_cerrado boolean := false;
  tenant_sin_cerrar boolean := false; empresa_vacia boolean := false;
  agente_malo boolean := false; rls_activa boolean; policies int; idx int;
begin
  -- (a) el dominio de rol
  insert into public.app_user (id, email, rol, tenant_id) values (u, '__verif_0105__@likida.ai', 'vendedor', null);
  begin
    insert into public.app_user (id, email, rol) values (gen_random_uuid(), '__verif_0105b__@likida.ai', 'gerente');
  exception when check_violation then rol_malo := true;
  end;

  -- (b) el embudo de prospecto
  insert into public.prospecto (empresa, vacante, vendedor_id)
    values ('__VERIF_0105__', 'Analista de liquidaciones', u) returning id into p;
  begin
    insert into public.prospecto (empresa, estado) values ('__V105__', 'tibio');
  exception when check_violation then estado_malo := true;
  end;
  begin
    insert into public.prospecto (empresa, estado) values ('__V105__', 'cerrado');  -- sin cerrado_en
  exception when check_violation then cerrado_sin_fecha := true;
  end;
  begin
    insert into public.prospecto (empresa, estado, cerrado_en) values ('__V105__', 'nuevo', now());
  exception when check_violation then fecha_sin_cerrado := true;
  end;
  insert into public.tenant (nombre) values ('__verif_0105__') returning id into t;
  begin
    insert into public.prospecto (empresa, estado, tenant_id) values ('__V105__', 'nuevo', t);
  exception when check_violation then tenant_sin_cerrar := true;
  end;
  begin
    insert into public.prospecto (empresa) values ('   ');
  exception when check_violation then empresa_vacia := true;
  end;
  select relrowsecurity into rls_activa from pg_class where oid = 'public.prospecto'::regclass;
  select count(*) into policies from pg_policies where schemaname = 'public' and tablename = 'prospecto';
  select count(*) into idx from pg_indexes where schemaname = 'public' and indexname = 'prospecto_por_vendedor';

  -- (c) la bitácora del agente de ventas, sin flota
  insert into public.agente_corrida (tenant_id, agente, inicio, fin, estado, disparo, tareas_hechas, tareas_total)
    values (null, 'ventas', now() - interval '3 seconds', now(), 'ok', 'manual', 2, 2);
  begin
    insert into public.agente_corrida (tenant_id, agente, inicio, estado) values (null, 'marketing', now(), 'ok');
  -- Desde la 0116 el guardián es la FK, no el CHECK — misma garantía, error
  -- nuevo (ver la nota del bloque 79 y la mudanza completa en el 91).
  exception when check_violation or foreign_key_violation then agente_malo := true;
  end;

  raise exception E'VENDEDORES_0105  rol_malo_rebota=%  estado_malo=%  cerrado_sin_fecha=%  fecha_sin_cerrado=%  tenant_sin_cerrar=%  empresa_vacia=%  rls=%  policies=%  indice=%  agente_malo=%   (esperado t/t/t/t/t/t/t/0/1/t)',
    rol_malo, estado_malo, cerrado_sin_fecha, fecha_sin_cerrado, tenant_sin_cerrar, empresa_vacia, rls_activa, policies, idx, agente_malo;
end $$;

-- ── 84. El desglose del proveedor de peaje (0106) ──────────────────────────
--
-- Lo que solo la base puede demostrar de la 0106: (a) el dominio de estatus
-- rebota un valor inventado y el default es `sin_contraparte` (toda línea
-- nace sin conciliar — sin cruce no se afirma nada); (b) `diferencia` y
-- `viaje_id` aceptan NULL (NULL ≠ 0: sin contraparte no hay diferencia que
-- medir); (c) el UNIQUE (desglose_id, indice) rebota el renglón repetido;
-- (d) el periodo incoherente (hasta < desde) rebota; (e) ambas tablas tienen
-- RLS activa con CERO políticas (deny-all — todo acceso por service_role);
-- (f) los tres índices existen; (g) borrar el desglose arrastra sus líneas
-- (cascade). Todo dentro de un DO que revierte con su excepción final.
--
-- SALIDA REAL (14-ago-2026, corrida vía MCP tras aplicar la 0106 — con el
--   arreglo de operador_id anotado arriba):
--   ERROR: P0001: DESGLOSE_0106  default_sin_contraparte=t  diferencia_nula=t
--   estatus_malo_rebota=t  indice_repetido_rebota=t  periodo_malo_rebota=t
--   rls=t/t  policies=0  indices=3  lineas_tras_borrar=0
--   (esperado t/t/t/t/t/t/t/0/3/0) — coincide; el RAISE revirtió todo.
do $$
declare
  t uuid; o uuid; d uuid; v uuid; lin uuid;
  estatus_malo boolean := false; indice_repetido boolean := false;
  periodo_malo boolean := false;
  default_ok boolean; dif_nula boolean;
  rls_desglose boolean; rls_linea boolean; policies int; indices int;
  lineas_tras_borrar int;
begin
  insert into public.tenant (nombre) values ('__verif_0106__') returning id into t;
  -- viaje.operador_id es NOT NULL (0001): sin un operador de utilería el
  -- INSERT de abajo rebota — atrapado en la primera corrida real del bloque.
  insert into public.operador (tenant_id, nombre, telefono)
    values (t, '__verif_0106__', '5210000000106') returning id into o;
  insert into public.viaje (tenant_id, operador_id, folio) values (t, o, '__V106__') returning id into v;

  -- (a) default sin_contraparte + dominio vigilado
  insert into public.desglose_peaje (tenant_id, proveedor, archivo_nombre)
    values (t, 'IAVE', 'verif_0106.xlsx') returning id into d;
  insert into public.desglose_peaje_linea (tenant_id, desglose_id, indice, fecha, caseta, monto, tag)
    values (t, d, 0, current_date, 'Tepotzotlán', 189.00, 'IMDM00106') returning id into lin;
  select (estatus = 'sin_contraparte'), (diferencia is null)
    into default_ok, dif_nula
    from public.desglose_peaje_linea where id = lin;
  begin
    insert into public.desglose_peaje_linea (tenant_id, desglose_id, indice, monto, estatus)
      values (t, d, 1, 100.00, 'conciliada');  -- estatus de OTRA tabla: aquí no existe
  exception when check_violation then estatus_malo := true;
  end;

  -- (b) una línea que cuadra puede señalar su viaje y su diferencia medida
  update public.desglose_peaje_linea
     set estatus = 'cuadra', viaje_id = v, diferencia = 0.00 where id = lin;

  -- (c) el renglón repetido rebota
  begin
    insert into public.desglose_peaje_linea (tenant_id, desglose_id, indice, monto)
      values (t, d, 0, 55.00);
  exception when unique_violation then indice_repetido := true;
  end;

  -- (d) el periodo incoherente rebota
  begin
    insert into public.desglose_peaje (tenant_id, periodo_desde, periodo_hasta)
      values (t, '2026-08-10', '2026-08-01');
  exception when check_violation then periodo_malo := true;
  end;

  -- (e) RLS activa, cero policies en las dos
  select relrowsecurity into rls_desglose from pg_class where oid = 'public.desglose_peaje'::regclass;
  select relrowsecurity into rls_linea from pg_class where oid = 'public.desglose_peaje_linea'::regclass;
  select count(*) into policies from pg_policies
    where schemaname = 'public' and tablename in ('desglose_peaje', 'desglose_peaje_linea');

  -- (f) los tres índices
  select count(*) into indices from pg_indexes
    where schemaname = 'public' and indexname in
      ('desglose_peaje_linea_por_desglose', 'desglose_peaje_linea_por_estatus', 'desglose_peaje_por_flota');

  -- (g) borrar el desglose arrastra sus líneas
  delete from public.desglose_peaje where id = d;
  select count(*) into lineas_tras_borrar from public.desglose_peaje_linea where desglose_id = d;

  raise exception E'DESGLOSE_0106  default_sin_contraparte=%  diferencia_nula=%  estatus_malo_rebota=%  indice_repetido_rebota=%  periodo_malo_rebota=%  rls_desglose=%  rls_linea=%  policies=%  indices=%  lineas_tras_borrar=%   (esperado t / t / t / t / t / t / t / 0 / 3 / 0)',
    default_ok, dif_nula, estatus_malo, indice_repetido, periodo_malo,
    rls_desglose, rls_linea, policies, indices, lineas_tras_borrar;
end $$;

-- ── 85. La decisión de la talacha se firma o no existe (0107 + 0109) ───────
--
-- Lo que solo la base puede demostrar de la 0107: (a) el dominio de
-- `autorizacion` rebota un valor inventado; (b) una decisión SIN firma
-- (autorizada sin quién/cuándo) rebota — una "autorizada" anónima se leería
-- igual que una firmada, y la firma es todo el punto del circuito §4.6;
-- (c) una firma SIN decisión (pendiente con autorizada_en) también rebota —
-- la coherencia es bicondicional, como incidencia_cierre_coherente; (d) el
-- claim anti-doble-decisión: dos UPDATE condicionales `WHERE autorizacion =
-- 'pendiente'` — el primero toca 1 fila, el segundo 0, así el segundo botón
-- del jefe no re-firma ni pisa la primera decisión; (e) las incidencias de
-- siempre (autorizacion NULL) siguen entrando sin firma — la 0107 no les
-- exige nada nuevo; (f) el índice parcial de pendientes existe. Todo dentro
-- de un DO que revierte con su excepción final.
--
-- SALIDA REAL (14-ago-2026, DOS corridas vía MCP — y la primera ATRAPÓ un
--   hueco real):
--   1ª corrida (0107 recién aplicada, con el arreglo de operador_id anotado
--   arriba): firma_suelta_rebota=f — el check de la 0107 dejaba estampar
--   `autorizada_en` sola sobre una PENDIENTE (false=false pasa el ⇔). Todo
--   lo demás en verde: t/t/f/1/0/t/t contra esperado t/t/t/1/0/t/t.
--   2ª corrida (tras la 0109, que ata cada campo de la firma a la decisión):
--   ERROR: P0001: TALACHA_0107  dominio_rebota=t  sin_firma_rebota=t
--   firma_suelta_rebota=t  primer_claim=1  segundo_claim=0  vieja_entra=t
--   indice=t   (esperado t/t/t/1/0/t/t) — coincide; el RAISE revirtió todo.
do $$
declare
  t uuid; o uuid; v uuid; jefe uuid; inc uuid;
  dominio_rebota boolean := false; sin_firma_rebota boolean := false;
  firma_suelta_rebota boolean := false;
  primer_claim int; segundo_claim int;
  vieja_entra boolean := false; indice_existe boolean;
begin
  insert into public.tenant (nombre) values ('__verif_0107__') returning id into t;
  -- viaje.operador_id es NOT NULL (0001) — mismo arreglo que el bloque 84.
  insert into public.operador (tenant_id, nombre, telefono)
    values (t, '__verif_0107__', '5210000000107') returning id into o;
  insert into public.viaje (tenant_id, operador_id, folio) values (t, o, '__V107__') returning id into v;
  insert into public.app_user (id, tenant_id, email, rol)
    values (gen_random_uuid(), t, 'verif0107@likida.test', 'flota_admin') returning id into jefe;

  -- (e) la incidencia informativa de siempre: sin autorizacion, sin firma.
  begin
    insert into public.incidencia (tenant_id, viaje_id, tipo, descripcion)
      values (t, v, 'retraso', 'verif 0107: informativa');
    vieja_entra := true;
  exception when others then vieja_entra := false;
  end;

  -- La talacha pendiente del circuito.
  insert into public.incidencia (tenant_id, viaje_id, tipo, prioridad, descripcion, monto_estimado, autorizacion)
    values (t, v, 'averia', 'alta', 'verif 0107: talacha', 800, 'pendiente') returning id into inc;

  -- (a) dominio vigilado.
  begin
    update public.incidencia set autorizacion = 'verde' where id = inc;
  exception when check_violation then dominio_rebota := true;
  end;

  -- (b) decisión sin firma.
  begin
    update public.incidencia set autorizacion = 'autorizada' where id = inc;
  exception when check_violation then sin_firma_rebota := true;
  end;

  -- (c) firma sin decisión.
  begin
    update public.incidencia set autorizada_en = now() where id = inc;
  exception when check_violation then firma_suelta_rebota := true;
  end;

  -- (d) el claim: gana exactamente un botón.
  update public.incidencia
     set autorizacion = 'autorizada', autorizada_por = jefe, autorizada_en = now()
   where id = inc and autorizacion = 'pendiente';
  get diagnostics primer_claim = row_count;
  update public.incidencia
     set autorizacion = 'rechazada', autorizada_por = jefe, autorizada_en = now()
   where id = inc and autorizacion = 'pendiente';
  get diagnostics segundo_claim = row_count;

  -- (f) el índice parcial de pendientes.
  select count(*) = 1 into indice_existe
    from pg_indexes
   where schemaname = 'public' and indexname = 'incidencia_autorizacion_pendiente_idx';

  raise exception E'TALACHA_0107  dominio_rebota=%  sin_firma_rebota=%  firma_suelta_rebota=%  primer_claim=%  segundo_claim=%  vieja_entra=%  indice=%   (esperado t/t/t/1/0/t/t)',
    dominio_rebota, sin_firma_rebota, firma_suelta_rebota, primer_claim, segundo_claim, vieja_entra, indice_existe;
end $$;

-- ── 86. El flujo de proveedores: foto, SAT, export y disparo correo (0108) ──
--
-- Lo que solo la base puede demostrar de la 0108: (a) el dedup por
-- (tenant, cfdi_uuid) sigue vivo con las columnas nuevas puestas; (b) una
-- factura de FOTO cabe sin xml_crudo PORQUE trae ocr_confianza, y una fila
-- sin respaldo (ni XML ni OCR) rebota; (c) los dominios de origen y
-- estado_sat rebotan valores inventados; (d) exportada_en solo cabe sobre
-- una aprobada; (e) `agente_corrida` acepta el disparo 'correo' y sigue
-- rebotando uno inventado; (f) la tabla sigue deny-all para authenticated.
-- Todo dentro de un DO que revierte con su excepción final.
--
-- SALIDA REAL (14-ago-2026, corrida vía MCP tras aplicar la 0108):
--   ERROR: P0001: PROVEEDOR_FLUJO_0108  dedup=t  foto_sin_xml=1
--   sin_respaldo_rebota=t  origen_malo=t  sat_malo=t
--   export_pendiente_rebota=t  exportadas=1  disparo_correo_malo_rebota=t
--   rls=0   (esperado t/1/t/t/t/t/1/t/0) — coincide; el RAISE revirtió todo.
do $$
declare
  v_t uuid;
  dedup_vivo boolean := false;
  sin_respaldo_rebota boolean := false;
  origen_malo boolean := false;
  sat_malo boolean := false;
  export_pendiente_rebota boolean := false;
  disparo_malo boolean := false;
  n_foto int;
  n_export int;
  n_rls int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0108') returning id into v_t;

  -- (a) XML con las columnas nuevas, y el dedup contra una FOTO del mismo UUID
  insert into factura_proveedor (tenant_id, cfdi_uuid, total, xml_crudo, origen, estado_sat)
    values (v_t, 'uuid-verif-0108', 100, '<x/>', 'correo', 'vigente');
  begin
    insert into factura_proveedor (tenant_id, cfdi_uuid, total, ocr_confianza, origen)
      values (v_t, 'uuid-verif-0108', 100, 0.62, 'subida');
  exception when unique_violation then dedup_vivo := true;
  end;

  -- (b) la foto cabe sin XML porque declara su OCR; sin ninguno de los dos, no
  insert into factura_proveedor (tenant_id, cfdi_uuid, total, ocr_confianza, origen, estado_sat)
    values (v_t, 'uuid-verif-0108-f', 250, 0.62, 'subida', 'pendiente');
  select count(*) into n_foto from factura_proveedor
    where tenant_id = v_t and xml_crudo is null and ocr_confianza = 0.62;
  begin
    insert into factura_proveedor (tenant_id, cfdi_uuid, total)
      values (v_t, 'uuid-verif-0108-n', 300);
  exception when check_violation then sin_respaldo_rebota := true;
  end;

  -- (c) los dominios nuevos
  begin
    insert into factura_proveedor (tenant_id, cfdi_uuid, total, xml_crudo, origen)
      values (v_t, 'uuid-verif-0108-o', 10, '<x/>', 'fax');
  exception when check_violation then origen_malo := true;
  end;
  begin
    insert into factura_proveedor (tenant_id, cfdi_uuid, total, xml_crudo, estado_sat)
      values (v_t, 'uuid-verif-0108-s', 10, '<x/>', 'valido');
  exception when check_violation then sat_malo := true;
  end;

  -- (d) exportada_en: rebota sobre pendiente, cabe sobre aprobada
  begin
    update factura_proveedor set exportada_en = now()
      where tenant_id = v_t and cfdi_uuid = 'uuid-verif-0108';
  exception when check_violation then export_pendiente_rebota := true;
  end;
  update factura_proveedor set estado = 'aprobada', decidido_por = 'verif', decidido_en = now()
    where tenant_id = v_t and cfdi_uuid = 'uuid-verif-0108';
  update factura_proveedor set exportada_en = now()
    where tenant_id = v_t and cfdi_uuid = 'uuid-verif-0108';
  select count(*) into n_export from factura_proveedor
    where tenant_id = v_t and exportada_en is not null;

  -- (e) el disparo 'correo' de la bitácora
  insert into agente_corrida (tenant_id, agente, inicio, fin, estado, disparo, tareas_hechas, tareas_total)
    values (v_t, 'proveedores', now() - interval '2 seconds', now(), 'ok', 'correo', 1, 2);
  begin
    insert into agente_corrida (tenant_id, agente, inicio, estado, disparo)
      values (v_t, 'proveedores', now(), 'ok', 'webhook');
  exception when check_violation then disparo_malo := true;
  end;

  -- (f) deny-all intacto
  set local role authenticated;
  select count(*) into n_rls from factura_proveedor where tenant_id = v_t;
  reset role;

  delete from tenant where id = v_t;
  raise exception E'PROVEEDOR_FLUJO_0108  dedup=%  foto_sin_xml=%  sin_respaldo_rebota=%  origen_malo=%  sat_malo=%  export_pendiente_rebota=%  exportadas=%  disparo_correo_malo_rebota=%  rls=%   (esperado t/1/t/t/t/t/1/t/0)',
    dedup_vivo, n_foto, sin_respaldo_rebota, origen_malo, sat_malo, export_pendiente_rebota, n_export, disparo_malo, n_rls;
end $$;

-- ── 87. El kill switch y el dedup de impersonación (0110) ──────────────────
--
-- Lo que solo la base puede demostrar de la 0110: (a) `interruptor` vigila su
-- dominio — un nombre inventado rebota, 'global' y 'agente:cobranza' caben;
-- (b) apagar exige motivo NO VACÍO — sin motivo rebota, con espacios rebota,
-- con motivo cabe, y encendido sin motivo cabe (encender es el default);
-- (c) las dos tablas tienen RLS activa SIN políticas (deny-all: cero policies
-- en pg_policies) y `authenticated` no lee ni una fila; (d) el PK de
-- `impersonacion_dia` deduplica de verdad — el segundo insert del mismo
-- (actor, flota, día) rebota con unique_violation, que es el mecanismo por el
-- que la bitácora se firma UNA vez por día. Todo dentro de un DO que revierte
-- con su excepción final — no queda ni una fila.
--
-- SALIDA REAL (15-ago-2026, corrida vía MCP tras aplicar la 0110):
--   ERROR: P0001: INTERRUPTORES_0110  dominio_malo_rebota=t
--   apagado_sin_motivo_rebota=t  motivo_blanco_rebota=t  apagados=1
--   encendidos=1  dedup_impersonacion=t  rls_int=t  rls_imp=t
--   policies_int=0  policies_imp=0  lee_auth_int=0  lee_auth_imp=0
--   (esperado t/t/t/1/1/t/t/t/0/0/0/0) — coincide; el RAISE revirtió todo.
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid();
  dominio_malo boolean := false;
  apagado_sin_motivo boolean := false;
  apagado_motivo_blanco boolean := false;
  dedup_impersonacion boolean := false;
  n_apagados int; n_encendidos int;
  rls_int boolean; rls_imp boolean;
  pol_int int; pol_imp int;
  n_lee_int int; n_lee_imp int;
begin
  -- (a) el dominio del nombre
  insert into public.interruptor (id, apagado, motivo, cambiado_por)
    values ('agente:cobranza', true, 'verificación 0110: incidente de prueba', null);
  insert into public.interruptor (id) values ('global');  -- encendido, sin motivo: cabe
  begin
    insert into public.interruptor (id) values ('agente:marketing');
  exception when check_violation then dominio_malo := true;
  end;

  -- (b) apagar exige motivo no vacío
  begin
    insert into public.interruptor (id, apagado) values ('agente:peajes', true);
  exception when check_violation then apagado_sin_motivo := true;
  end;
  begin
    insert into public.interruptor (id, apagado, motivo) values ('agente:peajes', true, '   ');
  exception when check_violation then apagado_motivo_blanco := true;
  end;
  select count(*) into n_apagados from public.interruptor where apagado;
  select count(*) into n_encendidos from public.interruptor where not apagado;

  -- (d) el dedup de impersonacion_dia — necesita actor y flota reales (FKs)
  insert into public.tenant (nombre) values ('__verif_0110__') returning id into v_t;
  insert into public.app_user (id, email, rol, tenant_id)
    values (v_u, '__verif_0110__@likida.ai', 'superadmin', null);
  insert into public.impersonacion_dia (actor_id, tenant_id, dia) values (v_u, v_t, current_date);
  begin
    insert into public.impersonacion_dia (actor_id, tenant_id, dia) values (v_u, v_t, current_date);
  exception when unique_violation then dedup_impersonacion := true;
  end;

  -- (c) deny-all en las dos: RLS activa, cero policies, authenticated ciego
  select relrowsecurity into rls_int from pg_class where oid = 'public.interruptor'::regclass;
  select relrowsecurity into rls_imp from pg_class where oid = 'public.impersonacion_dia'::regclass;
  select count(*) into pol_int from pg_policies where schemaname = 'public' and tablename = 'interruptor';
  select count(*) into pol_imp from pg_policies where schemaname = 'public' and tablename = 'impersonacion_dia';
  set local role authenticated;
  select count(*) into n_lee_int from public.interruptor;
  select count(*) into n_lee_imp from public.impersonacion_dia;
  reset role;

  raise exception E'INTERRUPTORES_0110  dominio_malo_rebota=%  apagado_sin_motivo_rebota=%  motivo_blanco_rebota=%  apagados=%  encendidos=%  dedup_impersonacion=%  rls_int=%  rls_imp=%  policies_int=%  policies_imp=%  lee_auth_int=%  lee_auth_imp=%   (esperado t/t/t/1/1/t/t/t/0/0/0/0)',
    dominio_malo, apagado_sin_motivo, apagado_motivo_blanco, n_apagados, n_encendidos,
    dedup_impersonacion, rls_int, rls_imp, pol_int, pol_imp, n_lee_int, n_lee_imp;
end $$;

-- ── 88. Los dos índices de rango-de-fecha de la 0111 existen ────────────────
--
-- No hay concurrencia que probar: la garantía es que `gasto_tenant_fecha_idx`
-- y `viaje_tenant_fecha_inicio_idx` EXISTEN en el esquema público con la
-- definición exacta de la 0111 — un `create index if not exists` que alguien
-- renombró o aplicó a medias se ve idéntico desde el código, y el planeador
-- simplemente no lo usa. Se leen de pg_indexes y se cuentan.
--
-- Esperado: ambos=2  gasto_def=t  viaje_def=t
-- SALIDA REAL (15-ago-2026, corrida vía MCP tras aplicar la 0111):
--   ERROR: P0001: INDICES_0111  ambos=2  gasto_def=t  viaje_def=t
--   (esperado 2/t/t) — coincide.
do $$
declare
  n int;
  gasto_def boolean;
  viaje_def boolean;
begin
  select count(*) into n from pg_indexes
    where schemaname = 'public'
      and indexname in ('gasto_tenant_fecha_idx', 'viaje_tenant_fecha_inicio_idx');
  select indexdef ilike '%(tenant_id, fecha)%' into gasto_def from pg_indexes
    where schemaname = 'public' and indexname = 'gasto_tenant_fecha_idx';
  select indexdef ilike '%(tenant_id, fecha_inicio)%' into viaje_def from pg_indexes
    where schemaname = 'public' and indexname = 'viaje_tenant_fecha_inicio_idx';
  raise exception E'INDICES_0111  ambos=%  gasto_def=%  viaje_def=%   (esperado 2/t/t)',
    n, coalesce(gasto_def, false), coalesce(viaje_def, false);
end $$;

-- ── 89. Los 4 agregados de la 0112: existen, INVOKER, aislados, cuadran ─────
--
-- La 0112 movió CUATRO caminos de "traer filas → sumar en JS" a `sum()`/
-- `count()` en SQL (docs/escala-15k.md §6): `sumar_combustible_ejercicio`
-- (que YA EXISTÍA desde la 0084, muerta —cero llamadores en `src/`— y con un
-- bug real: no filtraba `monto > 0`), `serie_comparativa_tenant`,
-- `kpis_liquidacion_tenant` y `acreditables_liquidacion_tenant` (nuevas).
--
-- Este bloque comprueba CUATRO cosas:
--
--  1. **Las 4 existen, son SECURITY INVOKER (no definer) y los permisos son
--     los correctos** — anon/authenticated ciegos, service_role puede—,
--     leído del catálogo (mismo patrón que el bloque 43).
--
--  2. **AISLAMIENTO entre flotas.** Las cuatro las llama `service_role`, que
--     salta RLS: el `where tenant_id = p_tenant` es lo ÚNICO que separa una
--     flota de otra. Se siembran DOS flotas con números DISTINTOS y se exige
--     que las cifras de la flota A no contengan ni un centavo de la B — con
--     una sola flota esta prueba pasaría siempre sin probar nada (la misma
--     trampa que ya documentó el bloque 43).
--
--  3. **QUIÉN IMPIDE DE VERDAD EL MONTO NEGATIVO** — y aquí la primera
--     corrida real de este bloque (15-ago-2026) CORRIGIÓ a la 0112.
--
--     La 0112 dice en su encabezado que la RPC muerta "tenía un BUG real":
--     que sin `monto > 0`, una fila NEGATIVA inflaría el denominador del 15%
--     de la RFA. Este bloque intentó sembrar ese -777 y Postgres lo rechazó:
--
--       ERROR 23514: new row for relation "gasto" violates check constraint
--       "gasto_monto_no_negativo"
--
--     `gasto` trae DOS restricciones que la 0112 no menciona:
--     `gasto_monto_no_negativo` (CHECK monto >= 0) y `gasto_monto_no_nan`
--     (CHECK monto <> 'NaN'). O sea: **una fila negativa nunca fue posible**,
--     ni antes ni después de la 0112. Y como el único valor que la
--     restricción sí deja pasar es CERO, y sumar cero no mueve una suma, el
--     filtro `monto > 0` de la RPC **no corrige nada: es defensa en
--     profundidad**, correcta de tener y honesta de nombrar así.
--
--     Eso cambia dónde vive la protección, que es lo que este bloque tiene
--     que vigilar: el día que alguien tire cualquiera de las dos
--     restricciones, el filtro de la RPC pasa de redundante a ÚNICO guardia,
--     y `getSerieComparativa` —que a propósito NO filtra— se queda sin
--     ninguno. Por eso aquí se exige que **las dos restricciones existan** y
--     se comprueba que la de negativo **rechaza de verdad** (se intenta el
--     insert y se atrapa el 23514), en vez de medir un filtro sobre datos
--     que la base no admite.
--
--  4. **QUE CUADRAN** contra el cálculo hecho a mano sobre la siembra —el
--     mismo dataset que usan las pruebas de equivalencia JS-vs-RPC en TS
--     (`repo_acumulado.test.ts`, `analytics_kpis_acreditables.test.ts`), aquí
--     corrido contra Postgres de verdad y no contra un mock. OJO con esas
--     dos: siembran montos negativos en memoria, así que verifican un caso
--     que la base rechaza — pasan, pero no prueban producción.
--
-- TRAMPAS DE SIEMBRA: `viaje.operador_id` es NOT NULL (tenant → operador →
-- viaje); `liquidacion.estatus` tiene dominio (0025); `viaje.estatus` igual;
-- `uq_viaje_abierto_por_operador` (0029) permite solo UN 'abierto' por
-- operador — cada flota trae un solo viaje abierto. Las fechas de `gasto` y
-- `viaje.fecha_inicio` van relativas a `current_date` (no a un mes fijo) para
-- que la ventana de 7 días de `serie_comparativa_tenant` las alcance sin
-- importar cuándo se corra este bloque.
--
-- TRAMPA EXTRA que atrapó la segunda corrida: `liquidacion_viaje_uidx` admite
-- UNA liquidación por viaje — las dos de la flota A van sobre viajes
-- distintos (va1 y va2), no sobre el mismo.
--
-- Todo se revierte con el `raise` final.
--
-- SALIDA REAL (15-ago-2026, tercera corrida — las dos primeras fallaron y
-- ambas fallas están documentadas arriba: el -777 imposible y la liquidación
-- duplicada por viaje):
--   AGREGADOS_0112  funcs=4  invoker=t  ninguna_anon=t  ninguna_auth=t
--   todas_svc=t  checks=2  neg_rechazado=t  comb_total=2300.00
--   comb_efectivo=1500.00  comb_ok=t  kpis_ok=t  acred_ok=t  serie_ok=t
--   (esperado 4/t/t/t/t/2/t/2300/1500/t/t/t/t)
do $$
declare
  ta uuid; tb uuid; actor uuid:=gen_random_uuid(); liq record; oa uuid; ob uuid; va1 uuid; va2 uuid; vb1 uuid;
  anio int := extract(year from current_date)::int;
  n_funcs int; todas_invoker boolean; ninguna_anon boolean; ninguna_auth boolean; todas_svc boolean;
  r_comb record;
  j_kpis jsonb; j_acred jsonb; j_serie jsonb;
  ok_comb_total boolean; ok_comb_efectivo boolean;
  ok_kpis boolean; ok_acred boolean; ok_serie boolean;
  n_checks int; negativo_rechazado boolean := false;
begin
  -- ── 3. El guardia REAL del monto: las dos restricciones de `gasto` ──────
  select count(*) into n_checks from pg_constraint
   where conrelid = 'public.gasto'::regclass and contype = 'c'
     and conname in ('gasto_monto_no_negativo', 'gasto_monto_no_nan');
  -- ── FLOTA A: la que se mide ────────────────────────────────────────────
  insert into tenant (nombre) values ('ZZZ VERIF 0112 A') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0112 A', '5215559990112') returning id into oa;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (ta, oa, 'ZZZ-0112-A1', 'liquidado', current_date - 3, 1000) returning id into va1;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (ta, oa, 'ZZZ-0112-A2', 'abierto', current_date - 1, 500) returning id into va2;

  -- Combustible de A: 1500 (efectivo) + 800 (tarjeta) + 0 = 2300 total,
  -- 1500 efectivo. El cero es el ÚNICO monto no-positivo que la base admite,
  -- y no mueve ninguna suma: por eso el filtro `monto > 0` de la RPC es
  -- defensa, no corrección (ver punto 3 del encabezado).
  insert into gasto (tenant_id, viaje_id, concepto, monto, forma_pago, fecha) values
    (ta, va1, 'diesel', 1500, '01', current_date - 3),
    (ta, va1, 'diesel',  800, '04', current_date - 2),
    (ta, va1, 'diesel',    0, '01', current_date - 1);

  -- El negativo NO se puede sembrar: se intenta y se exige el rechazo. Si
  -- algún día esto deja de lanzar, la restricción se cayó y el filtro de la
  -- RPC pasó de redundante a único guardia — y `getSerieComparativa`, que no
  -- filtra, se quedó sin ninguno.
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, forma_pago, fecha)
      values (ta, va1, 'diesel', -777, '01', current_date - 2);
  exception when check_violation then
    negativo_rechazado := true;
  end;

  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, estatus, diferencias,
      ieps_acreditable, iva_acreditable, peaje_acreditable, litros_diesel_acreditables)
    values (ta, va1, 1500, 1500, 'con_diferencias',
      '[{"tipo":"sobre_politica","monto":120},{"tipo":"duplicado","monto":80},{"tipo":"folio_verificar","monto":0}]'::jsonb,
      50, 240, 30, 400.5);
  -- La SEGUNDA liquidación va sobre va2, no sobre va1: `liquidacion_viaje_uidx`
  -- admite UNA liquidación por viaje (trampa que atrapó la primera corrida).
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, estatus,
      ieps_acreditable, iva_acreditable, peaje_acreditable, litros_diesel_acreditables)
    values (ta, va2, 700, 700, 'cuadrada', 10, 60, 5, 90);

  -- ── FLOTA B: solo para probar que NO contamina a A ─────────────────────
  insert into tenant (nombre) values ('ZZZ VERIF 0112 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ 0112 B', '5215559990113') returning id into ob;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (tb, ob, 'ZZZ-0112-B1', 'liquidado', current_date - 2, 200) returning id into vb1;
  insert into gasto (tenant_id, viaje_id, concepto, monto, forma_pago, fecha)
    values (tb, vb1, 'diesel', 9999, '01', current_date - 2);
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, estatus, diferencias,
      ieps_acreditable, iva_acreditable, peaje_acreditable, litros_diesel_acreditables)
    values (tb, vb1, 8888, 8888, 'revisar', '[{"tipo":"duplicado","monto":50}]'::jsonb, 999, 999, 999, 999);

  -- Sólo la segunda, cuadrada y autoaprobada por 0299, suma antes de firmar
  -- la primera (con diferencias, pendiente). El pendiente no se acredita.
  j_acred := acreditables_liquidacion_tenant(ta, null);
  ok_acred := j_acred = '{"ieps":10,"iva":60,"peaje":5,"litrosDiesel":90}'::jsonb;
  insert into app_user(id,tenant_id,email,rol) values(actor,ta,'agregados-firma@example.invalid','flota_admin');
  for liq in select id from liquidacion where tenant_id=ta and revision='pendiente' loop
    perform revisar_liquidacion(ta,liq.id,'aprobar',null,null,actor,null);
  end loop;

  -- ── 1. Catálogo: existencia, INVOKER, permisos ─────────────────────────
  select count(*),
         count(*) filter (where p.prosecdef = false) = 4,
         count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) = 0,
         count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) = 0,
         count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 4
    into n_funcs, todas_invoker, ninguna_anon, ninguna_auth, todas_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('sumar_combustible_ejercicio', 'serie_comparativa_tenant',
                        'kpis_liquidacion_tenant', 'acreditables_liquidacion_tenant');

  -- ── 2+3. Combustible: aislada de B, y el bug del monto>0 sigue corregido ─
  select total, efectivo into r_comb from sumar_combustible_ejercicio(ta, anio, array['15101505']);
  ok_comb_total := r_comb.total = 2300;      -- si el filtro se cae: 1523. Si B contamina: +9999.
  ok_comb_efectivo := r_comb.efectivo = 1500; -- si el filtro se cae: 723. Si B contamina: +9999.

  -- ── 2+4. KPIs de A: cuadran y no ven a B ────────────────────────────────
  j_kpis := kpis_liquidacion_tenant(ta, null);
  ok_kpis := (j_kpis->>'viajesLiquidados')::int = 2
         and (j_kpis->>'montoComprobado')::numeric = 2200
         and (j_kpis->>'diferenciaDetectada')::numeric = 200
         and (j_kpis->>'conDiferencias')::int = 1
         and (j_kpis->>'porRevisar')::int = 0
         and (j_kpis->>'tasaCuadre')::int = 50;

  -- ── 2+4. Acreditables de A: cuadran y no ven a B ────────────────────────
  j_acred := acreditables_liquidacion_tenant(ta, null);
  ok_acred := ok_acred and (j_acred->>'ieps')::numeric = 60
          and (j_acred->>'iva')::numeric = 300
          and (j_acred->>'peaje')::numeric = 35
          and (j_acred->>'litrosDiesel')::numeric = 490.5;

  -- ── 2+4. Serie comparativa de A (7 días, 1 paso): cuadra y no ve a B ────
  -- `gastoTotal` NO filtra monto>0 (mismo criterio que la función JS que
  -- reemplaza: es un total operativo, no el denominador fiscal del 15%).
  -- Con las restricciones de `gasto` vivas, el único no-positivo posible es
  -- el cero, así que las dos cifras coinciden en 2300: la diferencia entre
  -- ambos criterios solo se vería si la restricción se cayera — que es
  -- exactamente lo que `checks=2` y `neg_rechazado=t` vigilan arriba.
  j_serie := serie_comparativa_tenant(ta, 7, 1, current_date) -> 0;
  ok_serie := (j_serie->>'gastoTotal')::numeric = 2300
          and (j_serie->>'totalViajes')::int = 2
          and (j_serie->>'viajesLiquidados')::int = 1
          and (j_serie->>'costoPorViaje')::numeric = 1150.00
          and (j_serie->>'liquidado')::numeric = 2200;

  delete from tenant where id in (ta, tb);

  -- anon/auth: `t` significa "NINGUNA de las 4 es ejecutable por ese rol"
  -- (la variable ya es el resultado de `count(...) = 0`), no "sí puede".
  raise exception E'AGREGADOS_0112  funcs=%  invoker=%  ninguna_anon=%  ninguna_auth=%  todas_svc=%  checks=%  neg_rechazado=%  comb_total=%  comb_efectivo=%  comb_ok=%  kpis_ok=%  acred_ok=%  serie_ok=%   (esperado 4/t/t/t/t/2/t/2300/1500/t/t/t/t)',
    n_funcs, todas_invoker, ninguna_anon, ninguna_auth, todas_svc,
    n_checks, negativo_rechazado,
    r_comb.total, r_comb.efectivo, ok_comb_total and ok_comb_efectivo,
    ok_kpis, ok_acred, ok_serie;
end $$;

-- ── 90. La señal de PMF: la descarga del PDF se registra y no se pisa (0114) ─
--
-- La 0114 agregó tres columnas a `liquidacion` y la RPC que las escribe. Nace
-- de una pregunta de producto, no de esquema: de las tres señales que dirían
-- que Likida tiene PMF, dos ya se podían medir (`viaje.recordatorio_
-- comprobacion_en` para "el chofer manda sin que le recuerden", y
-- `ticket_soporte.abierto_por` para "el cliente se queja cuando algo se rompe")
-- y la tercera —la más importante— no: nada distinguía un PDF generado y nunca
-- abierto de uno que el contador imprimió y archivó.
--
-- Este bloque comprueba CUATRO cosas, y la tercera es la que de verdad importa:
--
--  1. Las tres columnas y el índice parcial existen; la RPC es SECURITY
--     INVOKER con `anon` ciego y `service_role` habilitado (mismo patrón del
--     bloque 89).
--
--  2. **La primera descarga fija fecha Y rol.** El rol importa tanto como la
--     fecha: un `superadmin` bajando el PDF es Javier enseñando el producto,
--     no un cliente usándolo. Sin esa columna, un demo se lee en la base
--     exactamente igual que un cierre contable, y la señal de PMF quedaría
--     contaminada por las propias demos.
--
--  3. **La segunda descarga NO pisa a la primera.** Se baja otra vez con rol
--     'superadmin' y se exige que el contador siga registrado como el primero
--     y que el contador de descargas llegue a 2. Ese `coalesce` dentro del
--     UPDATE es lo que hace la operación segura ante dos descargas simultáneas
--     —el contador y su auxiliar apretando a la vez— sin transacción explícita.
--     Si alguien lo cambiara por un "leer y luego escribir", esta prueba lo
--     atrapa.
--
--  4. **Aislamiento entre flotas.** Se llama con la liquidación de la flota B
--     pero el tenant de la A: no debe tocar NADA. El filtro va dentro de la
--     función, no confiado al llamador — `service_role` salta RLS, así que es
--     lo único que separa una flota de otra.
--
-- TRAMPAS DE SIEMBRA: `viaje.operador_id` es NOT NULL; `liquidacion_viaje_uidx`
-- admite UNA liquidación por viaje (por eso cada flota trae la suya sobre su
-- propio viaje); los dominios de `viaje.estatus` y `liquidacion.estatus` aplican.
--
-- Todo se revierte con el `raise` final.
--
-- SALIDA REAL (15-ago-2026, primera corrida, en verde):
--   DESCARGA_0114  cols=3  indice=t  invoker=t  anon_no=t  svc_si=t
--   primera=t  no_pisa=t  aislada=t   (esperado 3/t/t/t/t/t/t/t)
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; va uuid; vb uuid; la uuid; lb uuid;
  n_cols int; hay_indice boolean; es_invoker boolean; anon_no boolean; svc_si boolean;
  r record; r_b record;
  ok_primera boolean; ok_no_pisa boolean; ok_aislada boolean;
begin
  select count(*) into n_cols from information_schema.columns
   where table_schema='public' and table_name='liquidacion'
     and column_name in ('primera_descarga_en','descargas','primera_descarga_rol');

  select exists(select 1 from pg_indexes where schemaname='public'
                and indexname='liquidacion_descargada_idx') into hay_indice;

  select p.prosecdef = false,
         not has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
    into es_invoker, anon_no, svc_si
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='registrar_descarga_liquidacion';

  insert into tenant (nombre) values ('ZZZ VERIF 0114 A') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta,'ZZZ 0114 A','5215559990114') returning id into oa;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (ta, oa, 'ZZZ-0114-A', 'liquidado', current_date, 1000) returning id into va;
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, estatus)
    values (ta, va, 900, 900, 'cuadrada') returning id into la;

  insert into tenant (nombre) values ('ZZZ VERIF 0114 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (tb,'ZZZ 0114 B','5215559990115') returning id into ob;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (tb, ob, 'ZZZ-0114-B', 'liquidado', current_date, 500) returning id into vb;
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, estatus)
    values (tb, vb, 400, 400, 'cuadrada') returning id into lb;

  perform registrar_descarga_liquidacion(la, ta, 'contador');
  select descargas, primera_descarga_rol, primera_descarga_en is not null as tiene_fecha
    into r from liquidacion where id = la;
  ok_primera := r.descargas = 1 and r.primera_descarga_rol = 'contador' and r.tiene_fecha;

  perform registrar_descarga_liquidacion(la, ta, 'superadmin');
  select descargas, primera_descarga_rol into r from liquidacion where id = la;
  ok_no_pisa := r.descargas = 2 and r.primera_descarga_rol = 'contador';

  perform registrar_descarga_liquidacion(lb, ta, 'contador');
  select descargas, primera_descarga_en is null as sin_fecha into r_b from liquidacion where id = lb;
  ok_aislada := r_b.descargas = 0 and r_b.sin_fecha;

  delete from tenant where id in (ta, tb);

  raise exception E'DESCARGA_0114  cols=%  indice=%  invoker=%  anon_no=%  svc_si=%  primera=%  no_pisa=%  aislada=%   (esperado 3/t/t/t/t/t/t/t)',
    n_cols, hay_indice, es_invoker, anon_no, svc_si, ok_primera, ok_no_pisa, ok_aislada;
end $$;

-- ── 91. El catálogo declarativo y la mudanza del CHECK a FK (mig. 0116) ─────
--
-- La decisión de arquitectura del plan hacia el 90% §(b): un agente nuevo es
-- una fila, no una migración. Lo que SOLO la base puede demostrar:
--
--  1. Los 7 agentes del producto están SEMBRADOS y `vivo` — es la garantía
--     que el CHECK viejo daba y que la mudanza no puede perder (estandares
--     §7: el dominio vive en tres lugares que tienen que coincidir).
--  2. La FK manda: una corrida de un agente NO declarado rebota con
--     foreign_key_violation — el CHECK enumerado murió, la referencia vive.
--  3. Un agente NUEVO entra como fila y su corrida ENTRA — el punto entero
--     de la 0116: de "migración + deploy" a un INSERT.
--  4. Los dominios del catálogo vigilan: departamento inventado rebota,
--     presupuesto negativo rebota.
--  5. Deny-all: RLS activa, cero policies, `authenticated` ciego.
--
-- Todo se revierte con el raise final.
--
-- CORRIDO CONTRA PRODUCCIÓN el 16-ago-2026 (Management API):
--   AGENTE_DEFINICION_0116  vivos_sembrados=7  fk_rebota=t  nuevo_entra=t
--   depto_malo_rebota=t  presupuesto_malo_rebota=t  rls=t  policies=0
--   lee_auth=0   (esperado 7/t/t/t/t/t/0/0) — coincide; el RAISE revirtió todo.
do $$
declare
  n_vivos int;
  fk_rebota boolean := false;
  nuevo_entra boolean := false;
  depto_malo boolean := false;
  presupuesto_malo boolean := false;
  rls_def boolean; pol_def int; n_lee int;
begin
  -- 1) los 7 del producto, sembrados y vivos
  select count(*) into n_vivos from public.agente_definicion
    where estado = 'vivo'
      and id in ('liquidacion','facturas','cobranza','conductores','peajes','proveedores','ventas');

  -- 2) una corrida de un agente no declarado rebota por FK
  begin
    insert into public.agente_corrida (tenant_id, agente, inicio, fin, estado, disparo)
      values (null, 'agente_fantasma', now(), now(), 'ok', 'manual');
  exception when foreign_key_violation then fk_rebota := true;
  end;

  -- 3) un agente nuevo es una fila, y su corrida entra
  insert into public.agente_definicion (id, nombre, departamento, disparador, estado)
    values ('verif_0116', 'Agente de verificación', 'ingenieria', 'manual', 'disenado');
  insert into public.agente_corrida (tenant_id, agente, inicio, fin, estado, disparo)
    values (null, 'verif_0116', now(), now(), 'ok', 'manual');
  nuevo_entra := true;

  -- 4) los dominios del catálogo
  begin
    insert into public.agente_definicion (id, nombre, departamento)
      values ('verif_depto', 'X', 'marketing_viral');
  exception when check_violation then depto_malo := true;
  end;
  begin
    insert into public.agente_definicion (id, nombre, departamento, presupuesto_dia_usd)
      values ('verif_presu', 'X', 'ingenieria', -5);
  exception when check_violation then presupuesto_malo := true;
  end;

  -- 5) deny-all
  select relrowsecurity into rls_def from pg_class where oid = 'public.agente_definicion'::regclass;
  select count(*) into pol_def from pg_policies where schemaname = 'public' and tablename = 'agente_definicion';
  set local role authenticated;
  select count(*) into n_lee from public.agente_definicion;
  reset role;

  raise exception E'AGENTE_DEFINICION_0116  vivos_sembrados=%  fk_rebota=%  nuevo_entra=%  depto_malo_rebota=%  presupuesto_malo_rebota=%  rls=%  policies=%  lee_auth=%   (esperado 7/t/t/t/t/t/0/0)',
    n_vivos, fk_rebota, nuevo_entra, depto_malo, presupuesto_malo, rls_def, pol_def, n_lee;
end $$;

-- ── 92. La cola de aprobación: enviar solo aprobado es de BASE (mig. 0117) ──
--
-- El candado de diseño de panel-de-adquisicion §3, que ninguna UI puede
-- suplir: (a) estampar `enviado_en` sobre una pieza NO aprobada rebota —
-- pendiente y rechazada por igual; sobre una aprobada cabe; (b) rechazar sin
-- motivo rebota (vacío y espacios); (c) resolución coherente: una pieza
-- aprobada sin `resuelto_en` rebota — no puede existir "aprobada por nadie";
-- (d) `cuerpo_final` (la edición humana) solo existe en aprobadas;
-- (e) la FK de `agente` manda: una pieza de un agente no declarado no entra;
-- (f) deny-all: RLS activa, cero policies, `authenticated` ciego.
--
-- Todo se revierte con el raise final.
--
-- CORRIDO CONTRA PRODUCCIÓN el 16-ago-2026 (Management API):
--   COLA_APROBACION_0117  envio_pendiente_rebota=t  envio_rechazada_rebota=t
--   envio_aprobada_cabe=t  rechazo_sin_motivo=t  rechazo_blanco=t
--   aprobada_sin_resolucion=t  edicion_en_pendiente=t  agente_fantasma_rebota=t
--   rls=t  policies=0  lee_auth=0   (esperado t/t/t/t/t/t/t/t/t/0/0) — coincide.
do $$
declare
  pid uuid;
  envio_pendiente_rebota boolean := false;
  envio_rechazada_rebota boolean := false;
  envio_aprobada_cabe boolean := false;
  rechazo_sin_motivo boolean := false;
  rechazo_blanco boolean := false;
  aprobada_sin_resolucion boolean := false;
  edicion_en_pendiente boolean := false;
  agente_fantasma boolean := false;
  rls_cola boolean; pol_cola int; n_lee int;
begin
  -- (a) enviar solo aprobado
  insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('correo_frio', 'normal', 'ventas', 'verif', 'cuerpo de prueba') returning id into pid;
  begin
    update public.cola_aprobacion set enviado_en = now() where id = pid;
  exception when check_violation then envio_pendiente_rebota := true;
  end;
  begin
    update public.cola_aprobacion
      set estado = 'rechazado', motivo_rechazo = 'verif', resuelto_en = now(), enviado_en = now()
      where id = pid;
  exception when check_violation then envio_rechazada_rebota := true;
  end;
  -- Con actor (0120): desde cola_resolucion_con_actor, resolver sin
  -- snapshot de email rebota — el bloque 94 lo prueba a propósito; aquí el
  -- camino feliz lo lleva puesto.
  update public.cola_aprobacion set estado = 'aprobado', resuelto_en = now(), resuelto_por_email = 'verif@likida.ai' where id = pid;
  update public.cola_aprobacion set enviado_en = now() where id = pid;
  envio_aprobada_cabe := true;

  -- (b) rechazar exige motivo (en fila nueva pendiente)
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, estado, resuelto_en)
      values ('correo_frio', 'normal', 'ventas', 'v2', 'x', 'rechazado', now());
  exception when check_violation then rechazo_sin_motivo := true;
  end;
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, estado, motivo_rechazo, resuelto_en)
      values ('correo_frio', 'normal', 'ventas', 'v2', 'x', 'rechazado', '   ', now());
  exception when check_violation then rechazo_blanco := true;
  end;

  -- (c) aprobada sin resolución no existe
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, estado)
      values ('correo_frio', 'normal', 'ventas', 'v3', 'x', 'aprobado');
  exception when check_violation then aprobada_sin_resolucion := true;
  end;

  -- (d) la edición solo vive en aprobadas
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, cuerpo_final)
      values ('correo_frio', 'normal', 'ventas', 'v4', 'x', 'editado');
  exception when check_violation then edicion_en_pendiente := true;
  end;

  -- (e) el autor tiene que estar declarado
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('correo_frio', 'normal', 'agente_fantasma', 'v5', 'x');
  exception when foreign_key_violation then agente_fantasma := true;
  end;

  -- (f) deny-all
  select relrowsecurity into rls_cola from pg_class where oid = 'public.cola_aprobacion'::regclass;
  select count(*) into pol_cola from pg_policies where schemaname = 'public' and tablename = 'cola_aprobacion';
  set local role authenticated;
  select count(*) into n_lee from public.cola_aprobacion;
  reset role;

  raise exception E'COLA_APROBACION_0117  envio_pendiente_rebota=%  envio_rechazada_rebota=%  envio_aprobada_cabe=%  rechazo_sin_motivo=%  rechazo_blanco=%  aprobada_sin_resolucion=%  edicion_en_pendiente=%  agente_fantasma_rebota=%  rls=%  policies=%  lee_auth=%   (esperado t/t/t/t/t/t/t/t/t/0/0)',
    envio_pendiente_rebota, envio_rechazada_rebota, envio_aprobada_cabe, rechazo_sin_motivo,
    rechazo_blanco, aprobada_sin_resolucion, edicion_en_pendiente, agente_fantasma,
    rls_cola, pol_cola, n_lee;
end $$;

-- ── 93. La bandeja durable del webhook: dedup por PK y deny-all (mig. 0119) ─
--
-- Lo que solo la base puede demostrar del P1 del kill switch: (a) la PK es
-- el wamid — la reentrega del MISMO evento por Meta rebota con
-- unique_violation y no duplica; (b) deny-all: RLS activa, cero policies,
-- `authenticated` ciego. Todo se revierte con el raise final.
do $$
declare
  dedup boolean := false;
  rls_wa boolean; pol_wa int; n_lee int;
begin
  insert into public.wa_evento_pendiente (id, evento) values ('wamid.verif.0119', '{"from":"x","type":"text"}'::jsonb);
  begin
    insert into public.wa_evento_pendiente (id, evento) values ('wamid.verif.0119', '{"from":"x","type":"text"}'::jsonb);
  exception when unique_violation then dedup := true;
  end;

  select relrowsecurity into rls_wa from pg_class where oid = 'public.wa_evento_pendiente'::regclass;
  select count(*) into pol_wa from pg_policies where schemaname = 'public' and tablename = 'wa_evento_pendiente';
  set local role authenticated;
  select count(*) into n_lee from public.wa_evento_pendiente;
  reset role;

  raise exception E'WA_PENDIENTE_0119  dedup_wamid=%  rls=%  policies=%  lee_auth=%   (esperado t/t/0/0)',
    dedup, rls_wa, pol_wa, n_lee;
end $$;

-- ── 94. La resolución de la cola exige actor con snapshot (mig. 0120) ───────
--
-- El CHECK que la 0117 prometía en su comentario y no tenía: a nivel esquema
-- podía existir una pieza aprobada por NADIE. Ahora `cola_resolucion_con_actor`
-- lo exige en los dos sentidos: (a) aprobar sin `resuelto_por_email` rebota;
-- (b) una pendiente CON email también rebota (un actor sin resolución es tan
-- incoherente como una resolución sin actor); (c) el camino completo con
-- actor cabe. Todo se revierte con el raise final.
do $$
declare
  sin_actor boolean := false;
  pendiente_con_actor boolean := false;
  con_actor_cabe boolean := false;
begin
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, estado, resuelto_en)
      values ('correo_frio', 'normal', 'ventas', 'v94a', 'x', 'aprobado', now());
  exception when check_violation then sin_actor := true;
  end;
  begin
    insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, resuelto_por_email)
      values ('correo_frio', 'normal', 'ventas', 'v94b', 'x', 'j@likida.ai');
  exception when check_violation then pendiente_con_actor := true;
  end;
  insert into public.cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo, estado, resuelto_en, resuelto_por_email)
    values ('correo_frio', 'normal', 'ventas', 'v94c', 'x', 'aprobado', now(), 'j@likida.ai');
  con_actor_cabe := true;

  raise exception E'COLA_ACTOR_0120  aprobada_sin_actor_rebota=%  pendiente_con_actor_rebota=%  con_actor_cabe=%   (esperado t/t/t)',
    sin_actor, pendiente_con_actor, con_actor_cabe;
end $$;

-- ── 95. Historial del copiloto: rol acotado, deny-all y cascade (mig. 0121) ─
-- El ESPEJO del bloque 63 (0088), porque la migración es el espejo de
-- aquella menos el tenant: el copiloto es de Likida, no de una flota, y su
-- ancla es SOLO el usuario (superadmin). Las mismas tres garantías que solo
-- la base demuestra: (a) el CHECK de `rol` rebota un rol fuera del dominio
-- usuario/asistente; (b) RLS activo SIN políticas = deny-all — hasta el
-- DUEÑO autenticado ve cero filas, el único camino es el service role del
-- servidor (que ancla user_id en copiloto-historial.ts); (c) borrar la
-- conversación se lleva sus mensajes (cascade), no deja huérfanos.
--
-- Escrito el 16-ago-2026 con la 0121 recién creada: primera corrida en el
-- Postgres de CI (que aplica todas las migraciones); la corrida contra el
-- proyecto real va después de aplicarla, como el resto.
--   (esperado t / 0 / 0 / 0 — los cuatro exactos)
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid(); v_c uuid;
  rol_rebota boolean := false;
  n_msjs_tras_borrar int; n_conv_rls int; n_msj_rls int;
begin
  -- El usuario exige tenant (app_user.tenant_id NOT NULL); la conversación, NO.
  insert into tenant (nombre) values ('ZZZ VERIF 0121') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-verif-copiloto@likida.test', 'superadmin');

  insert into copiloto_conversacion (user_id, titulo) values (v_u, 'ZZZ copiloto') returning id into v_c;
  insert into copiloto_mensaje (conversacion_id, rol, texto) values (v_c, 'usuario', 'hola'), (v_c, 'asistente', 'listo');

  -- El CHECK del rol: 'sistema' no existe en el dominio.
  begin
    insert into copiloto_mensaje (conversacion_id, rol, texto) values (v_c, 'sistema', 'colado');
  exception when check_violation then rol_rebota := true;
  end;

  -- Deny-all: hasta el DUEÑO autenticado ve cero — el único camino es el
  -- service role del servidor, que ancla user_id en código.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u)::text, true);
  select count(*) into n_conv_rls from copiloto_conversacion where id = v_c;
  select count(*) into n_msj_rls from copiloto_mensaje where conversacion_id = v_c;
  reset role;

  -- Cascade: borrar la conversación se lleva sus mensajes.
  delete from copiloto_conversacion where id = v_c;
  select count(*) into n_msjs_tras_borrar from copiloto_mensaje where conversacion_id = v_c;

  delete from tenant where id = v_t;
  raise exception E'COPILOTO_0121  rol-rebota=%  rls-conv=%  rls-msj=%  msjs-tras-borrar=%   (esperado t / 0 / 0 / 0)',
    rol_rebota, n_conv_rls, n_msj_rls, n_msjs_tras_borrar;
end $$;

-- ── 96. Runner acotado y campañas: activa exige aprobador (mig. 0123) ───────
-- Tres garantías de base del runner/campañas: (a) el CHECK
-- `campana_activa_solo_aprobada` rebota una campaña ACTIVA sin aprobador —
-- ninguna ruta puede activar gasto sin firma humana aunque el código
-- tuviera un bug; (b) la activa CON aprobador cabe; (c) un costo de corrida
-- negativo rebota (la medición del techo no admite gasto negativo) y
-- `runner_habilitado` nace en false — la autonomía es opt-in explícito.
--
-- Escrito el 16-ago-2026 con la 0123 recién creada: primera corrida en el
-- Postgres de CI; la corrida contra el proyecto real va tras aplicarla.
--   (esperado t / t / t / t — los cuatro exactos)
do $$
declare
  activa_sin_firma_rebota boolean := false;
  activa_con_firma_cabe boolean := false;
  costo_negativo_rebota boolean := false;
  runner_nace_apagado boolean := false;
  v_u uuid := gen_random_uuid(); v_t uuid; v_c uuid;
begin
  begin
    insert into public.campana (canal, nombre, presupuesto_aprobado_usd, estado)
      values ('meta', 'ZZZ v96a', 100, 'activa');
  exception when check_violation then activa_sin_firma_rebota := true;
  end;

  insert into tenant (nombre) values ('ZZZ VERIF 0123') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-verif-campana@likida.test', 'superadmin');
  insert into public.campana (canal, nombre, presupuesto_aprobado_usd, estado, aprobado_por, aprobado_por_email, aprobado_en)
    values ('meta', 'ZZZ v96b', 100, 'activa', v_u, 'zzz-verif-campana@likida.test', now())
    returning id into v_c;
  activa_con_firma_cabe := v_c is not null;

  begin
    insert into public.agente_corrida (tenant_id, agente, inicio, fin, estado, disparo, costo_usd)
      values (null, 'redactor', now(), now(), 'ok', 'cron', -1);
  exception when check_violation then costo_negativo_rebota := true;
  end;

  insert into public.agente_definicion (id, nombre, departamento, disparador, estado)
    values ('zzz_v96', 'ZZZ Verif', 'leads', 'cron', 'disenado');
  select not runner_habilitado into runner_nace_apagado from public.agente_definicion where id = 'zzz_v96';

  raise exception E'RUNNER_CAMPANA_0123  activa-sin-firma-rebota=%  activa-con-firma-cabe=%  costo-negativo-rebota=%  runner-nace-apagado=%   (esperado t / t / t / t)',
    activa_sin_firma_rebota, activa_con_firma_cabe, costo_negativo_rebota, runner_nace_apagado;
end $$;

-- ── 97. La cadencia es ATÓMICA: la reserva serializa por prospecto (mig. 0124) ─
-- La carrera que la auditoría externa encontró: SELECT historial → enviar →
-- INSERT permitía que dos piezas del MISMO prospecto salieran a la vez. La
-- garantía de base: (a) la primera reserva ENTRA y devuelve id; (b) la
-- segunda, dentro de la ventana, devuelve NULL — la decisión y el insert
-- son la misma transacción con advisory lock por prospecto; (c) tras la
-- COMPENSACIÓN (delete de la reserva — el proveedor rechazó), reservar
-- vuelve a ser posible: el bloqueo era del contacto, no un residuo.
--
-- Escrito el 16-ago-2026 con la 0124 recién creada: primera corrida en el
-- Postgres de CI; contra el proyecto real, tras aplicarla.
--   (esperado t / t / t — los tres exactos)
do $$
declare
  v_p uuid; v_r1 uuid; v_r2 uuid; v_r3 uuid;
  primera_entra boolean := false;
  segunda_rebota boolean := false;
  tras_compensar_entra boolean := false;
begin
  insert into public.prospecto (empresa, fuente) values ('ZZZ VERIF 0124', 'manual') returning id into v_p;

  v_r1 := public.reservar_envio_prospecto(v_p, null, null, 'ZZZ reserva 1', 48);
  primera_entra := v_r1 is not null;

  v_r2 := public.reservar_envio_prospecto(v_p, null, null, 'ZZZ reserva 2', 48);
  segunda_rebota := v_r2 is null;

  delete from public.prospecto_contacto where id = v_r1;
  v_r3 := public.reservar_envio_prospecto(v_p, null, null, 'ZZZ reserva 3', 48);
  tras_compensar_entra := v_r3 is not null;

  raise exception E'CADENCIA_0124  primera-entra=%  segunda-rebota=%  tras-compensar-entra=%   (esperado t / t / t)',
    primera_entra, segunda_rebota, tras_compensar_entra;
end $$;

-- ── 98. El hardening quedó puesto: anon fuera, índices calientes, initplan (mig. 0126) ─
-- Lo que el advisor midió y la 0126 corrigió, verificado como ESTADO:
-- (a) anon NO puede ejecutar ninguna de las 4 SECURITY DEFINER — un anon que
--     pudiera preguntarle a is_superadmin() no escala hoy, pero no pinta
--     nada ahí y una diligencia pregunta exactamente esto;
-- (b) los 12 índices de FKs calientes existen por nombre;
-- (c) las 4 policies re-escritas quedaron en patrón initplan: su expresión
--     contiene un sub-SELECT de auth/función, no la llamada desnuda por fila.
--   (esperado f / 12 / 4 — exactos)
do $$
declare
  anon_puede boolean;
  v_indices int;
  v_policies int;
begin
  select bool_or(has_function_privilege('anon', p.oid, 'execute'))
    into anon_puede
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('is_superadmin','get_user_tenant_ids','administra_flota','ve_finanzas');

  select count(*) into v_indices
    from pg_indexes
   where schemaname = 'public'
     and indexname in (
       'idx_agente_corrida_agente','idx_cola_aprobacion_tenant','idx_cola_aprobacion_prospecto',
       'idx_cola_aprobacion_agente','idx_prospecto_tenant','idx_prospecto_contacto_pieza',
       'idx_chat_conversacion_user','idx_ccl_gasto','idx_desglose_peaje_linea_viaje',
       'idx_factura_saas_suscripcion','idx_incidencia_gasto','idx_codigo_pendiente_tenant');

  -- Las 2 de public reescritas por la 0126 (las 2 de storage.objects no se
  -- cuentan aquí: el CI efímero no monta el schema storage de Supabase).
  select count(*) into v_policies
    from pg_policy
   where pg_get_expr(polqual, polrelid) ~ 'SELECT'
     and polname in ('app_user_self','plan_lectura');

  raise exception E'HARDENING_0126  anon-ejecuta=%  indices=%  policies-initplan=%   (esperado f / 12 / 2)',
    coalesce(anon_puede, false), v_indices, v_policies;
end $$;

-- ── 99. El bus de mando existe y falla cerrado (mig. 0127) ─────────────────
-- (a) las 4 tablas bus_* existen CON RLS encendido — sin policies, el único
--     actor es el service-role (el bucket 'bus' no se verifica aquí: el CI
--     efímero no monta el schema storage, mismo criterio que el bloque 98);
-- (b) los CHECKs que hacen imposible el estado mudo existen por nombre;
-- (c) el índice parcial de pendientes existe (el latido de la Mac pregunta
--     cada 5 min — no debe recorrer el historial);
-- (d) funcional: una orden marcada fallida SIN motivo REBOTA (el 23514 es el
--     candado, no una validación de UI).
--   (esperado 4 / 4 / t / t — exactos)
do $$
declare
  v_tablas_rls int;
  v_checks int;
  indice_existe boolean;
  fallida_sin_motivo_rebota boolean := false;
begin
  select count(*) into v_tablas_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('bus_corrida', 'bus_pieza', 'bus_orden', 'bus_rutina')
     and c.relrowsecurity;

  select count(*) into v_checks
    from pg_constraint
   where conname in ('bus_orden_tipo_dominio', 'bus_orden_fallo_con_motivo',
                     'bus_pieza_resolucion_coherente', 'bus_orden_rutina_requerida');

  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'idx_bus_orden_pendientes'
  ) into indice_existe;

  begin
    insert into public.bus_orden (tipo, estado, creado_por, tomada_en, resuelta_en)
    values ('nota', 'fallida', 'ZZZ VERIF 0127', now(), now());
  exception when check_violation then
    fallida_sin_motivo_rebota := true;
  end;

  raise exception E'BUS_0127  tablas-rls=%  checks=%  indice=%  fallida-sin-motivo-rebota=%   (esperado 4 / 4 / t / t)',
    v_tablas_rls, v_checks, indice_existe, fallida_sin_motivo_rebota;
end $$;

-- ── 100. Las coordenadas del prospecto existen y son coherentes (mig. 0128) ─
-- (a) lat/lng existen como double precision;
-- (b) los CHECKs de rango (México continental) y el de "o las dos o ninguna"
--     existen por nombre;
-- (c) funcional: un punto a medias (lat sin lng) REBOTA — media coordenada
--     pintaría un pin en el ecuador, no un prospecto.
--   (esperado 2 / 3 / t — exactos)
do $$
declare
  v_cols int;
  v_checks int;
  media_coordenada_rebota boolean := false;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'prospecto'
     and column_name in ('lat', 'lng') and data_type = 'double precision';

  select count(*) into v_checks
    from pg_constraint
   where conname in ('prospecto_lat_rango', 'prospecto_lng_rango', 'prospecto_geo_completa');

  begin
    insert into public.prospecto (empresa, fuente, lat)
    values ('ZZZ VERIF 0128', 'manual', 20.67);
  exception when check_violation then
    media_coordenada_rebota := true;
  end;

  raise exception E'GEO_0128  columnas=%  checks=%  media-coordenada-rebota=%   (esperado 2 / 3 / t)',
    v_cols, v_checks, media_coordenada_rebota;
end $$;

-- ── 101. Los mensajes del agente experto son coherentes (mig. 0129) ────────
-- (a) las 5 columnas mensaje* existen en prospecto;
-- (b) funcional: un mensaje sin fecha de generación REBOTA, y un modelo sin
--     generación REBOTA — el candado es de base, no de UI.
--   (esperado 5 / t / t — exactos)
do $$
declare
  v_cols int;
  sin_fecha_rebota boolean := false;
  modelo_suelto_rebota boolean := false;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'prospecto'
     and column_name in ('mensaje_wa', 'mensaje_correo_asunto', 'mensaje_correo',
                         'mensajes_generados_en', 'mensajes_modelo');

  begin
    insert into public.prospecto (empresa, fuente, mensaje_wa)
    values ('ZZZ VERIF 0129a', 'manual', 'hola');
  exception when check_violation then
    sin_fecha_rebota := true;
  end;

  begin
    insert into public.prospecto (empresa, fuente, mensajes_modelo)
    values ('ZZZ VERIF 0129b', 'manual', 'un-modelo');
  exception when check_violation then
    modelo_suelto_rebota := true;
  end;

  raise exception E'MENSAJES_0129  columnas=%  sin-fecha-rebota=%  modelo-suelto-rebota=%   (esperado 5 / t / t)',
    v_cols, sin_fecha_rebota, modelo_suelto_rebota;
end $$;

-- ── 102. El historial de toques existe y su canal tiene dominio (mig. 0130) ─
-- (a) la tabla existe CON RLS; (b) el índice del último-toque existe;
-- (c) funcional: un canal fuera del dominio REBOTA.
--   (esperado t / t / t — exactos)
do $$
declare
  tabla_rls boolean;
  indice boolean;
  canal_invalido_rebota boolean := false;
  v_p uuid;
begin
  select c.relrowsecurity into tabla_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'prospecto_toque';

  select exists (select 1 from pg_indexes where indexname = 'idx_toque_prospecto_fecha') into indice;

  insert into public.prospecto (empresa, fuente) values ('ZZZ VERIF 0130', 'manual') returning id into v_p;
  begin
    insert into public.prospecto_toque (prospecto_id, canal, actor) values (v_p, 'paloma-mensajera', 'verif');
  exception when check_violation then
    canal_invalido_rebota := true;
  end;

  raise exception E'TOQUES_0130  tabla-rls=%  indice=%  canal-invalido-rebota=%   (esperado t / t / t)',
    coalesce(tabla_rls, false), indice, canal_invalido_rebota;
end $$;

-- ── 103. El intent persistente existe y su gateo tiene dominio (mig. 0131) ──
-- (a) tabla CON RLS; (b) índice de expiración; (c) funcional: gateo fuera
-- del dominio REBOTA.   (esperado t / t / t — exactos)
do $$
declare
  tabla_rls boolean;
  indice boolean;
  gateo_invalido_rebota boolean := false;
begin
  select c.relrowsecurity into tabla_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'admin_action_intent';

  select exists (select 1 from pg_indexes where indexname = 'idx_intent_expira') into indice;

  begin
    insert into public.admin_action_intent (id, actor_id, accion, args_hash, gateo, expira_en)
    values (gen_random_uuid(), gen_random_uuid(), 'zzz_verif', 'hash', 'triple-salto', now());
  exception when check_violation then
    gateo_invalido_rebota := true;
  end;

  raise exception E'INTENTS_0131  tabla-rls=%  indice=%  gateo-invalido-rebota=%   (esperado t / t / t)',
    coalesce(tabla_rls, false), indice, gateo_invalido_rebota;
end $$;

-- ── 104. El ciclo de vida del evento Stripe (mig. 0132) ─────────────────────
-- (a) la columna aplicado_en existe; (b) el backfill corrió: NINGUNA fila
-- anterior a la migración quedó sin sellar (las viejas se aplicaron todas —
-- el flujo viejo borraba la marca al fallar).   (esperado t / 0 — exactos)
do $$
declare
  columna boolean;
  sin_sellar_viejas int;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'evento_stripe' and column_name = 'aplicado_en'
  ) into columna;

  select count(*) into sin_sellar_viejas
    from public.evento_stripe
   where aplicado_en is null and procesado_en < '2026-08-17';

  raise exception E'STRIPE_CICLO_0132  columna=%  filas-viejas-sin-sellar=%   (esperado t / 0)',
    columna, sin_sellar_viejas;
end $$;

-- ── 105. La telemetría de seguridad existe y su dominio aprieta (mig. 0133) ─
-- (a) tabla CON RLS; (b) funcional: un tipo fuera del dominio REBOTA.
--   (esperado t / t — exactos)
do $$
declare
  tabla_rls boolean;
  tipo_invalido_rebota boolean := false;
begin
  select c.relrowsecurity into tabla_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'evento_seguridad';

  begin
    insert into public.evento_seguridad (origen, tipo) values ('wa_webhook', 'chisme-de-pasillo');
  exception when check_violation then
    tipo_invalido_rebota := true;
  end;

  raise exception E'SEGURIDAD_0133  tabla-rls=%  tipo-invalido-rebota=%   (esperado t / t)',
    coalesce(tabla_rls, false), tipo_invalido_rebota;
end $$;

-- ── 106. EvalOps existe, con dominio y con el examen sembrado (mig. 0134) ───
-- (a) las 3 tablas CON RLS; (b) el examen del analista tiene casos y AL MENOS
-- una trampa (el diseño de 22-evaluacion.md exige trampas); (c) funcional: un
-- veredicto fuera del dominio REBOTA.   (esperado 3 / >0 / >0 / t — exactos)
do $$
declare
  tablas_rls int;
  casos int;
  trampas int;
  veredicto_invalido_rebota boolean := false;
  v_caso uuid;
  v_corrida uuid;
begin
  select count(*) into tablas_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('eval_caso', 'eval_corrida', 'eval_resultado')
     and c.relrowsecurity;

  select count(*) into casos from public.eval_caso where agente = 'analista' and activo;
  select count(*) into trampas from public.eval_caso where agente = 'analista' and tipo = 'trampa';

  select id into v_caso from public.eval_caso limit 1;
  insert into public.eval_corrida (agente, prompt_hash) values ('analista', 'zzz-verif') returning id into v_corrida;
  begin
    insert into public.eval_resultado (corrida_id, caso_id, veredicto) values (v_corrida, v_caso, 'diez-de-diez');
  exception when check_violation then
    veredicto_invalido_rebota := true;
  end;

  raise exception E'EVALOPS_0134  tablas-rls=%  casos=%  trampas=%  veredicto-invalido-rebota=%   (esperado 3 / >0 / >0 / t)',
    tablas_rls, casos, trampas, veredicto_invalido_rebota;
end $$;

-- ── 107. La identidad de worker existe y su hash es único (mig. 0135) ───────
-- (a) tabla CON RLS; (b) el índice parcial de llaves vivas; (c) funcional:
-- dos llaves con el mismo hash REBOTAN.   (esperado t / t / t — exactos)
do $$
declare
  tabla_rls boolean;
  indice boolean;
  hash_duplicado_rebota boolean := false;
begin
  select c.relrowsecurity into tabla_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'worker_llave';

  select exists (select 1 from pg_indexes where indexname = 'idx_worker_llave_hash') into indice;

  insert into public.worker_llave (nombre, hash, capacidades) values ('zzz-verif', 'hash-verif', '{bus.latido}');
  begin
    insert into public.worker_llave (nombre, hash, capacidades) values ('zzz-verif-2', 'hash-verif', '{bus.latido}');
  exception when unique_violation then
    hash_duplicado_rebota := true;
  end;

  raise exception E'WORKER_0135  tabla-rls=%  indice=%  hash-duplicado-rebota=%   (esperado t / t / t)',
    coalesce(tabla_rls, false), indice, hash_duplicado_rebota;
end $$;

-- ── 108. El catálogo de planes con precio live es coherente (mig. 0136 + 0055) ──
-- Un plan a medio configurar no revienta: MIENTE en silencio, y cada forma de
-- mentir cuesta distinto.
--   · con price y sin `precio_mensual` → la tarjeta dice "Sin precio
--     configurado" al lado de un botón de contratar que sí funciona: el cliente
--     descubre cuánto paga hasta el estado de cuenta;
--   · con price y `precio_iva_incluido` NULL → se cobra pero `emitirMensualidad`
--     se niega a timbrar (0066), y el cliente se queda sin CFDI sin que nadie
--     se entere hasta su declaración;
--   · `empresa` con un price viejo de sandbox → con llaves live ese id NO existe
--     y el checkout truena en la cara del cliente.
-- (d) es lo único que solo la base demuestra: el índice único de la 0055 impide
-- que dos planes compartan price. Dos planes con el mismo price cobran lo mismo
-- diciendo cosas distintas, y el webhook (que resuelve el plan POR price id, ver
-- suscripcion.ts) le asignaría a la flota el plan equivocado.
--   (esperado 0 / 0 / t / t — exactos)
do $$
declare
  con_price_sin_monto int;
  con_price_sin_iva int;
  empresa_sin_price boolean;
  price_duplicado_rebota boolean := false;
begin
  select count(*) into con_price_sin_monto
    from public.plan where stripe_price_id is not null and precio_mensual is null;

  select count(*) into con_price_sin_iva
    from public.plan where stripe_price_id is not null and precio_iva_incluido is null;

  select stripe_price_id is null into empresa_sin_price
    from public.plan where clave = 'empresa';

  -- Funcional: robarle a `demo` el price de `flota` tiene que rebotar.
  begin
    update public.plan
       set stripe_price_id = (select stripe_price_id from public.plan where clave = 'flota')
     where clave = 'demo';
  exception when unique_violation then
    price_duplicado_rebota := true;
  end;

  raise exception E'PLANES_0136  con-price-sin-monto=%  con-price-sin-iva=%  empresa-sin-price=%  price-duplicado-rebota=%   (esperado 0 / 0 / t / t)',
    con_price_sin_monto, con_price_sin_iva, coalesce(empresa_sin_price, false), price_duplicado_rebota;
end $$;

-- ── 109. La libreta de decisores no deja pasar un dato adivinado (mig. 0138) ──
-- La 0138 existe para separar "lo leí en su sitio" de "lo adiviné", y esa
-- separación solo vale si la base la HACE CUMPLIR: un agente investigando
-- deduce correos del patrón nombre.apellido@dominio, y si esos se guardan
-- indistinguibles de los verificados, se mandan, rebotan y queman la
-- reputación del dominio de Likida — lo que degrada la entregabilidad de todo
-- lo demás, incluida la factura de un cliente real.
-- (a) tabla CON RLS; (b) el índice único por correo; (c) funcional: un
-- `inferido` declarado de confianza 'alta' REBOTA; (d) funcional: el mismo
-- correo dos veces en el mismo prospecto REBOTA.
--   (esperado t / t / t / t — exactos)
do $$
declare
  tabla_rls boolean;
  indice boolean;
  inferido_alta_rebota boolean := false;
  correo_duplicado_rebota boolean := false;
  v_prospecto uuid;
begin
  select c.relrowsecurity into tabla_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'prospecto_persona';

  select exists (select 1 from pg_indexes where indexname = 'idx_prospecto_persona_correo_unico') into indice;

  insert into public.prospecto (empresa) values ('zzz-verif-persona') returning id into v_prospecto;

  begin
    insert into public.prospecto_persona (prospecto_id, nombre, origen, confianza)
      values (v_prospecto, 'zzz Adivinado', 'inferido', 'alta');
  exception when check_violation then
    inferido_alta_rebota := true;
  end;

  insert into public.prospecto_persona (prospecto_id, nombre, correo, origen, confianza)
    values (v_prospecto, 'zzz Uno', 'zzz@ejemplo.invalid', 'sitio_empresa', 'alta');
  begin
    insert into public.prospecto_persona (prospecto_id, nombre, correo, origen, confianza)
      values (v_prospecto, 'zzz Dos', 'ZZZ@ejemplo.invalid', 'linkedin', 'media');
  exception when unique_violation then
    correo_duplicado_rebota := true;
  end;

  raise exception E'PERSONAS_0138  tabla-rls=%  indice=%  inferido-alta-rebota=%  correo-duplicado-rebota=%   (esperado t / t / t / t)',
    coalesce(tabla_rls, false), indice, inferido_alta_rebota, correo_duplicado_rebota;
end $$;

-- ── 110. Un duplicado marcado no puede esconder la fila buena (mig. 0139) ───
-- `duplicado_de` decide qué prospecto VE el vendedor: el tablero filtra por
-- `duplicado_de is null`. Una fila que se apunte a sí misma desaparecería para
-- siempre sin dejar a dónde ir, y un ciclo A→B→A escondería las dos.
-- (a) el check impide la autorreferencia; (b) la FK impide apuntar a un id
-- inexistente —que dejaría la fila invisible apuntando a la nada—; (c) los
-- índices de calidad existen.   (esperado t / t / t)
do $$
declare
  auto_rebota boolean := false;
  fantasma_rebota boolean := false;
  indices boolean;
  v_id uuid;
begin
  insert into public.prospecto (empresa) values ('zzz-verif-dup') returning id into v_id;

  begin
    update public.prospecto set duplicado_de = v_id where id = v_id;
  exception when check_violation then
    auto_rebota := true;
  end;

  begin
    update public.prospecto set duplicado_de = '00000000-0000-0000-0000-000000000000' where id = v_id;
  exception when foreign_key_violation then
    fantasma_rebota := true;
  end;

  select count(*) = 3 into indices from pg_indexes
   where indexname in ('idx_prospecto_sitio', 'idx_prospecto_scian', 'idx_prospecto_vivos');

  raise exception E'CALIDAD_0139  auto-rebota=%  fantasma-rebota=%  indices=%   (esperado t / t / t)',
    auto_rebota, fantasma_rebota, indices;
end $$;

-- ── 111. La RLS de liquidacion gatea por rol financiero (mig. 0144) ─────────
-- Un `encargado` (ve_finanzas() = false) NO debe poder leer/escribir el dinero
-- de las liquidaciones por PostgREST directo. La policy debe checar ve_finanzas(),
-- igual que cliente/pago_recibido/factura_emitida (0048). Si alguien la revierte
-- a solo tenant_id, este bloque lo grita. También fija el CHECK de factura_proveedor.
do $$
declare gatea boolean; tiene_check boolean;
begin
  select bool_or((qual::text ilike '%ve_finanzas%')) into gatea
    from pg_policies where schemaname = 'public' and tablename = 'liquidacion';
  select count(*) = 2 into tiene_check
    from pg_constraint
   where conrelid = 'public.factura_proveedor'::regclass and contype = 'c'
     and conname in ('factura_proveedor_total_positivo', 'factura_proveedor_conceptos_positivo');
  raise exception E'RLS_LIQUIDACION_0144  gatea_finanzas=%  check_factura_proveedor=%   (esperado t / t)',
    coalesce(gatea, false), coalesce(tiene_check, false);
end $$;

-- ── 112. TODA FK entre tablas con tenant_id lleva su compuesta (mig. 0145) ──
-- La 0028 escribió la regla y la aplicó a cuatro relaciones; la 0073 arregló
-- una más y dejó escrito que el resto seguía abierto. Este bloque es la regla
-- hecha catálogo: barre pg_constraint y LISTA cada FK simple entre dos tablas
-- con tenant_id NOT NULL (destino ≠ tenant) que no tenga una hermana
-- compuesta (col, tenant_id). Esperado: lista vacía. Una tabla nueva que se
-- salte el patrón aparece aquí con nombre, y CI se pone rojo.
-- Quedan fuera por diseño los destinos con tenant_id NULLABLE (app_user —el
-- superadmin no tiene flota—, prospecto, campania): una compuesta contra
-- ellos rechazaría filas legítimas.
-- Y lo funcional, sobre la cadena de cobranza que era el escenario C3:
-- (b) factura de A con cliente de B rebota; (c) pago de B sobre factura de A
-- rebota; (d) factura_viaje {factura A, viaje B} rebota; (e) la liga propia
-- entra y HEREDA el tenant de la factura sin que el INSERT lo mande.
do $$
declare
  sin_tenant text;
  ta uuid; tb uuid; oa uuid; ob uuid; ca uuid; cb uuid; fa uuid; va uuid; vb uuid;
  factura_cliente_ajeno_rebota boolean := false;
  pago_factura_ajena_rebota boolean := false;
  liga_viaje_ajeno_rebota boolean := false;
  liga_propia_hereda boolean := false;
begin
  with t as (
    select c.oid, c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id'
                      and a.attnotnull and not a.attisdropped)
  )
  select coalesce(string_agg(h.relname || '.' || a.attname || '->' || d.relname, ', ' order by h.relname, a.attname), '—')
    into sin_tenant
    from pg_constraint con
    join t h on h.oid = con.conrelid
    join t d on d.oid = con.confrelid
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
   where con.contype = 'f' and array_length(con.conkey, 1) = 1 and d.relname <> 'tenant'
     and not exists (
       select 1 from pg_constraint c2
        where c2.contype = 'f' and c2.conrelid = con.conrelid and c2.confrelid = con.confrelid
          and con.conkey[1] = any (c2.conkey)
          and exists (select 1 from pg_attribute a2
                       where a2.attrelid = c2.conrelid and a2.attnum = any (c2.conkey)
                         and a2.attname = 'tenant_id'));

  insert into tenant (nombre) values ('ZZZ VERIF 0145 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0145 B') returning id into tb;
  insert into cliente (tenant_id, nombre, rfc) values (ta, 'ZZZ cli A', 'XAXX010101000') returning id into ca;
  insert into cliente (tenant_id, nombre, rfc) values (tb, 'ZZZ cli B', 'XAXX010101000') returning id into cb;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0145 A', '5215559990145') returning id into oa;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ 0145 B', '5215559990146') returning id into ob;
  insert into viaje (tenant_id, operador_id) values (ta, oa) returning id into va;
  insert into viaje (tenant_id, operador_id) values (tb, ob) returning id into vb;

  begin
    insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
      values (ta, cb, 100, 16, 116, 'emitida');
  exception when foreign_key_violation then factura_cliente_ajeno_rebota := true;
  end;

  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, ca, 100, 16, 116, 'emitida') returning id into fa;

  begin
    insert into pago_recibido (tenant_id, factura_id, monto) values (tb, fa, 116);
  exception when foreign_key_violation then pago_factura_ajena_rebota := true;
  end;

  begin
    insert into factura_viaje (factura_id, viaje_id) values (fa, vb);
  exception when foreign_key_violation then liga_viaje_ajeno_rebota := true;
  end;

  insert into factura_viaje (factura_id, viaje_id) values (fa, va);
  select tenant_id = ta into liga_propia_hereda
    from factura_viaje where factura_id = fa and viaje_id = va;

  raise exception E'FKS_CON_TENANT_0145  fks-sin-tenant=%  factura-cliente-ajeno-rebota=%  pago-factura-ajena-rebota=%  liga-viaje-ajeno-rebota=%  liga-propia-hereda-tenant=%   (esperado — / t / t / t / t)',
    sin_tenant, factura_cliente_ajeno_rebota, pago_factura_ajena_rebota, liga_viaje_ajeno_rebota, coalesce(liga_propia_hereda, false);
end $$;

-- ── 113. wa_conversacion ya no admite filas sin flota (mig. 0145, B9) ───────
-- Con tenant_id NULL el índice único (tenant_id, telefono) no cubría la fila
-- y `tenant_id = any(...)` daba NULL en toda policy: historial de WhatsApp
-- (dato personal) sin dueño y sin pantalla desde la cual borrarlo.
-- (a) la columna es NOT NULL; (b) el INSERT sin tenant rebota; (c) ahora que
-- entra al barrido, una conversación de A con el operador de B rebota.
do $$
declare
  not_null boolean; sin_tenant_rebota boolean := false; operador_ajeno_rebota boolean := false;
  ta uuid; tb uuid; ob uuid;
begin
  select attnotnull into not_null from pg_attribute
   where attrelid = 'public.wa_conversacion'::regclass and attname = 'tenant_id';

  insert into tenant (nombre) values ('ZZZ VERIF B9 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF B9 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ B9 B', '5215559990147') returning id into ob;

  begin
    insert into wa_conversacion (telefono, estado) values ('5215500001001', '{"turns":[]}'::jsonb);
  exception when not_null_violation then sin_tenant_rebota := true;
  end;

  begin
    insert into wa_conversacion (tenant_id, operador_id, telefono, estado)
      values (ta, ob, '5215500001002', '{"turns":[]}'::jsonb);
  exception when foreign_key_violation then operador_ajeno_rebota := true;
  end;

  raise exception E'WA_TENANT_0145  tenant-not-null=%  sin-tenant-rebota=%  operador-ajeno-rebota=%   (esperado t / t / t)',
    coalesce(not_null, false), sin_tenant_rebota, operador_ajeno_rebota;
end $$;

-- ── 114. El encargado NO lee ni escribe `gasto` por PostgREST (mig. 0146, A15) ──
-- Misma forma que el bloque 29 (0048) y el 111 (0144), sobre la tabla que
-- faltaba: se impersona a un ENCARGADO de la flota y (a) cuenta 0 gastos de
-- su propia flota, (b) su INSERT de $40,000 de diésel rebota con 42501 —el
-- escenario literal de A15—; y a un CONTADOR de la misma flota, que sí los
-- ve. El intake de WhatsApp escribe con service role y no pasa por aquí.
do $$
declare
  ta uuid; oa uuid; va uuid;
  u_enc uuid := gen_random_uuid(); u_con uuid := gen_random_uuid();
  gatea boolean; n_enc int; inserta_enc boolean := true; n_con int;
begin
  select bool_or(qual::text ilike '%ve_finanzas%') into gatea
    from pg_policies where schemaname = 'public' and tablename = 'gasto';

  insert into tenant (nombre) values ('ZZZ VERIF 0146 GASTO') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0146', '5215559990148') returning id into oa;
  insert into viaje (tenant_id, operador_id) values (ta, oa) returning id into va;
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (ta, va, 'diesel', 500);
  insert into app_user (id, tenant_id, email, rol) values (u_enc, ta, 'zzz-verif-0146-enc@likida.test', 'encargado');
  insert into app_user (id, tenant_id, email, rol) values (u_con, ta, 'zzz-verif-0146-con@likida.test', 'contador');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u_enc)::text, true);
  select count(*) into n_enc from gasto where tenant_id = ta;
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, forma_pago)
      values (ta, va, 'diesel', 40000, '01');
  exception when insufficient_privilege then inserta_enc := false;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', u_con)::text, true);
  select count(*) into n_con from gasto where tenant_id = ta;
  reset role;

  raise exception E'GASTO_FINANZAS_0146  policy-gatea=%  encargado-lee=%  encargado-inserta=%  contador-lee=%   (esperado t / 0 / f / 1)',
    coalesce(gatea, false), n_enc, inserta_enc, n_con;
end $$;

-- ── 115. Los totales de liquidacion y ocr_confianza tienen dominio (mig. 0146, M11 + M12) ──
-- (a) un total negativo rebota; (b) una diferencia que no es anticipo −
-- comprobado rebota; (c) la fila coherente del motor entra (diferencia
-- negativa incluida: se comprobó más que el anticipo); (d) ocr_confianza
-- 9.999 rebota; (e) 0.85 entra.
do $$
declare
  ta uuid; oa uuid; ob uuid; v1 uuid; v2 uuid; g uuid;
  negativo_rebota boolean := false; descuadre_rebota boolean := false; coherente_entra boolean := false;
  ocr_fuera_rebota boolean := false; ocr_dentro_entra boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0146 DOM') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0146 D', '5215559990149') returning id into oa;
  insert into viaje (tenant_id, operador_id) values (ta, oa) returning id into v1;
  -- Segundo operador: uq_viaje_abierto_por_operador admite UN viaje abierto por chofer.
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0146 E', '5215559990150') returning id into ob;
  insert into viaje (tenant_id, operador_id) values (ta, ob) returning id into v2;

  begin
    insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia)
      values (ta, v1, -5000, 6000, 11000);
  exception when check_violation then negativo_rebota := true;
  end;
  begin
    insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia)
      values (ta, v1, 5000, 6000, 0);
  exception when check_violation then descuadre_rebota := true;
  end;
  begin
    insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia)
      values (ta, v1, 7150.25, 6000, -1150.25);
    coherente_entra := true;
  exception when check_violation then coherente_entra := false;
  end;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, ocr_confianza)
      values (ta, v2, 'diesel', 100, 9.999);
  exception when check_violation then ocr_fuera_rebota := true;
  end;
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, ocr_confianza)
      values (ta, v2, 'diesel', 100, 0.85) returning id into g;
    ocr_dentro_entra := g is not null;
  exception when check_violation then ocr_dentro_entra := false;
  end;

  raise exception E'DOMINIOS_0146  total-negativo-rebota=%  descuadre-rebota=%  coherente-entra=%  ocr-fuera-rebota=%  ocr-dentro-entra=%   (esperado t / t / t / t / t)',
    negativo_rebota, descuadre_rebota, coherente_entra, ocr_fuera_rebota, ocr_dentro_entra;
end $$;

-- ── 116. Un duplicado solo apunta a una fila VISIBLE (mig. 0147, M13) ───────
-- El bloque 110 nombraba el ciclo A→B→A y no lo probaba. Aquí: A→B entra;
-- (a) B→A rebota (B apuntaría a una copia); (b) B→C colapsa la cadena: A pasa
-- a apuntar a C, no a la B escondida; (c) D→A rebota porque A ya es copia.
do $$
declare
  a uuid; b uuid; c uuid; d uuid;
  ciclo_rebota boolean := false; cadena_colapsa boolean := false; copia_de_copia_rebota boolean := false;
begin
  insert into public.prospecto (empresa) values ('zzz-verif-dup-A') returning id into a;
  insert into public.prospecto (empresa) values ('zzz-verif-dup-B') returning id into b;
  insert into public.prospecto (empresa) values ('zzz-verif-dup-C') returning id into c;
  insert into public.prospecto (empresa) values ('zzz-verif-dup-D') returning id into d;

  update public.prospecto set duplicado_de = b where id = a;

  begin
    update public.prospecto set duplicado_de = a where id = b;
  exception when check_violation then ciclo_rebota := true;
  end;

  update public.prospecto set duplicado_de = c where id = b;
  select duplicado_de = c into cadena_colapsa from public.prospecto where id = a;

  begin
    update public.prospecto set duplicado_de = a where id = d;
  exception when check_violation then copia_de_copia_rebota := true;
  end;

  raise exception E'DUPLICADO_VISIBLE_0147  ciclo-rebota=%  cadena-colapsa=%  copia-de-copia-rebota=%   (esperado t / t / t)',
    ciclo_rebota, coalesce(cadena_colapsa, false), copia_de_copia_rebota;
end $$;

-- ── 117. El bucket `avatares` hace cumplir tipo y peso (mig. 0147, M25) ─────
-- Los candados vivían solo en los server actions de mi-perfil; una subida
-- directa al Storage con el access token los saltaba. Supabase Storage sí
-- hace cumplir estos dos campos del bucket. Esperado: 2 MB, las 3 imágenes
-- de `TIPOS`, y sigue público (la foto de perfil no es un comprobante).
do $$
declare limite bigint; mimes int; es_publico boolean;
begin
  select file_size_limit, cardinality(allowed_mime_types), public
    into limite, mimes, es_publico
    from storage.buckets where id = 'avatares';
  raise exception E'AVATARES_LIMITES_0147  limite-bytes=%  mimes=%  publico=%   (esperado 2097152 / 3 / t)',
    coalesce(limite, 0), coalesce(mimes, 0), coalesce(es_publico, false);
end $$;

-- ── 118. worker_llave.capacidades tiene dominio y no está vacío (mig. 0147, B10) ──
-- '{}' y '{bus.piezas}' (plural) rebotan; las cuatro reales entran.
do $$
declare vacia_rebota boolean := false; inventada_rebota boolean := false; las_cuatro_entran boolean := false;
begin
  begin
    insert into public.worker_llave (nombre, hash, capacidades) values ('zzz-verif-vacia', 'zzz-hash-1', '{}');
  exception when check_violation then vacia_rebota := true;
  end;
  begin
    insert into public.worker_llave (nombre, hash, capacidades) values ('zzz-verif-plural', 'zzz-hash-2', '{bus.latido,bus.piezas}');
  exception when check_violation then inventada_rebota := true;
  end;
  insert into public.worker_llave (nombre, hash, capacidades)
    values ('zzz-verif-cuatro', 'zzz-hash-3', '{bus.latido,bus.pieza,bus.catalogo,bus.ordenes}');
  las_cuatro_entran := true;

  raise exception E'CAPACIDADES_0147  vacia-rebota=%  inventada-rebota=%  las-cuatro-entran=%   (esperado t / t / t)',
    vacia_rebota, inventada_rebota, las_cuatro_entran;
end $$;

-- ── 119. reservar_envio_prospecto no es ejecutable desde internet (mig. 0147, B15) ──
-- Postgres da EXECUTE a PUBLIC en toda función nueva (lección de la 0054).
-- `proacl` NULL = privilegios por defecto = abierta. Esperado: cerrada a
-- public/anon/authenticated, abierta solo a service_role (cola.ts la llama
-- con supabaseAdmin()).
do $$
declare publico boolean; anon_si boolean; auth_si boolean; svc_si boolean;
begin
  select coalesce((select bool_or(grantee = 0) from aclexplode(p.proacl)), true),
         has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
    into publico, anon_si, auth_si, svc_si
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reservar_envio_prospecto';
  raise exception E'RPC_CADENCIA_0147  public=%  anon=%  authenticated=%  service_role=%   (esperado f / f / f / t)',
    coalesce(publico, true), coalesce(anon_si, true), coalesce(auth_si, true), coalesce(svc_si, false);
end $$;

-- ── 120. Las personas de prospectos fríos se purgan COMPLETAS; las de tratos vivos y las frenadas no (mig. 0148 + 0191) ──
--
-- /aviso/prospectos promete "a los 12 meses sin ningún contacto se borran".
-- Aquí se comprueba que algo lo ejecuta y que NO borra de más: un prospecto
-- con toque reciente conserva a su gente, uno en `negociacion` también, y
-- `conservar_hasta` en el futuro frena la purga aunque el prospecto esté
-- frío. `anon` no puede ejecutar la purga. Todo revierte con el RAISE final.
--
-- AUDITORÍA 19 (legal C4, CRÍTICO): la 0148 solo anulaba `contacto_nombre` —
-- `telefono`/`correo`/`notas`/`lead_clave` de la MISMA persona quedaban
-- intactos. La 0191 los anula los cinco, y el bloque ahora siembra los
-- cinco en el frío para probarlo. `empresa` (el NEGOCIO, no la persona) se
-- queda a propósito: se comprueba que sigue viva.
--
-- Y el caso que la 0148 no cubría: un prospecto del censo puede nacer SIN
-- `contacto_nombre` pero CON teléfono/correo — antes la condición del
-- UPDATE (`contacto_nombre is not null`) nunca lo tocaba. `sin_nombre`
-- simula justo eso.
--
-- 0258 (hallazgo 5 de la auditoría de tandas 21-24): `conservar_hasta` ahora
-- congela el EXPEDIENTE COMPLETO, no solo la fila de la persona — en un ARCO
-- en disputa los mensajes/atribución del prospecto pueden ser la evidencia
-- del tratamiento reclamado, y en «escríbanme en enero» anular el correo de
-- la fila era exactamente al revés de lo pactado. Por eso la persona frenada
-- ya no se siembra en el MISMO prospecto frío (antes se esperaba purgar a su
-- vecina y limpiar la fila; hoy eso sería partir un expediente congelado):
-- vive en su PROPIO prospecto frío `frenado`, y se comprueba que su fila
-- conserva TODO — persona, contacto y datos.
--
-- Esperado:
--   RETENCION_0148_0191  purgadas=1  quedan=3  frio_limpio=t  sin_nombre_limpio=t  empresa_viva=t  reciente_con_datos=t  frenado_con_datos=t  llave=t  anon=f
do $$
declare
  frio uuid; sin_nombre uuid; reciente uuid; trato uuid; frenado uuid; res jsonb; purgadas bigint; quedan bigint;
  frio_limpio boolean; sin_nombre_limpio boolean; empresa_viva boolean; reciente_con_datos boolean;
  frenado_con_datos boolean;
  tiene_llave boolean; anon_ok boolean;
begin
  insert into public.prospecto (empresa, estado, contacto_nombre, telefono, correo, notas, lead_clave, created_at)
    values ('__verif_0148_frio__', 'contactado', 'Ing. Prueba Frío', '5219990000001', 'frio@verif.test', 'notas del vendedor', 'frio@verif.test', now() - interval '400 days') returning id into frio;
  insert into public.prospecto (empresa, estado, contacto_nombre, telefono, correo, created_at)
    values ('__verif_0148_sinnombre__', 'nuevo', null, '5219990000002', 'sinnombre@verif.test', now() - interval '400 days') returning id into sin_nombre;
  insert into public.prospecto (empresa, estado, contacto_nombre, telefono, correo, created_at)
    values ('__verif_0148_reciente__', 'contactado', 'Lic. Prueba Reciente', '5219990000003', 'reciente@verif.test', now() - interval '400 days') returning id into reciente;
  insert into public.prospecto (empresa, estado, contacto_nombre, created_at)
    values ('__verif_0148_trato__', 'negociacion', 'Prueba Trato', now() - interval '400 days') returning id into trato;
  -- Frío de 400 días con freno vigente: el expediente entero debe sobrevivir.
  insert into public.prospecto (empresa, estado, contacto_nombre, telefono, correo, mensaje_wa,
                                mensajes_generados_en, mensajes_modelo, created_at)
    values ('__verif_0148_frenado__', 'contactado', 'Prueba Frenada', '5219990000004', 'frenado@verif.test',
            'Hola Prueba, seguimos en enero como quedamos.',
            now() - interval '400 days', 'modelo-de-prueba', now() - interval '400 days') returning id into frenado;
  -- El reciente tuvo un toque hace 10 días; los demás fríos, ninguno.
  insert into public.prospecto_contacto (prospecto_id, canal, direccion, resumen, ocurrio_en)
    values (reciente, 'correo', 'salida', '__verif_0148__', now() - interval '10 days');
  insert into public.prospecto_persona (prospecto_id, nombre, origen, created_at) values
    (frio,     '__V148 frío sin freno__',  'directorio', now() - interval '400 days'),
    (frenado,  '__V148 frío con freno__',  'directorio', now() - interval '400 days'),
    (reciente, '__V148 reciente__',        'directorio', now() - interval '400 days'),
    (trato,    '__V148 en trato__',        'directorio', now() - interval '400 days');
  update public.prospecto_persona set conservar_hasta = now() + interval '30 days'
   where prospecto_id = frenado and nombre = '__V148 frío con freno__';

  res := public.mantenimiento_de_datos(30);
  purgadas := (res->>'prospectoPersonasPurgadas')::bigint;
  select count(*) into quedan from public.prospecto_persona where nombre like '__V148%';
  select (contacto_nombre is null and telefono is null and correo is null and notas is null and lead_clave is null)
    into frio_limpio from public.prospecto where id = frio;
  select (telefono is null and correo is null) into sin_nombre_limpio from public.prospecto where id = sin_nombre;
  select (empresa = '__verif_0148_frio__') into empresa_viva from public.prospecto where id = frio;
  select (contacto_nombre is not null and telefono is not null and correo is not null)
    into reciente_con_datos from public.prospecto where id = reciente;
  select (contacto_nombre is not null and telefono is not null and correo is not null and mensaje_wa is not null)
    into frenado_con_datos from public.prospecto where id = frenado;
  tiene_llave := res ? 'prospectoPersonasPurgadas';
  select has_function_privilege('anon', 'public.purgar_prospecto_persona(integer, timestamptz)', 'EXECUTE') into anon_ok;
  raise exception E'RETENCION_0148_0191  purgadas=%  quedan=%  frio_limpio=%  sin_nombre_limpio=%  empresa_viva=%  reciente_con_datos=%  frenado_con_datos=%  llave=%  anon=%   (esperado 1/3/t/t/t/t/t/t/f)',
    purgadas, quedan, frio_limpio, sin_nombre_limpio, empresa_viva, reciente_con_datos, frenado_con_datos, tiene_llave, anon_ok;
end $$;

-- ── 121. El claim huérfano se retoma; el completado no (mig. 0149) ──────────
-- `claimMessage` (conv.ts) decide ante un 23505 con el MISMO update anclado
-- de aquí: `where completado_en is null and created_at < now() - lease`. Si
-- alguien quita la columna o cambia la semántica, este bloque lo grita. El
-- lease real es 150 s; aquí se usan 1 h / 1 min para que el caso sea nítido.
do $$
declare
  retomado int; completado_no_retomado int; fresco_no_retomado int; columna boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'wa_mensaje_procesado' and column_name = 'completado_en'
  ) into columna;

  -- Huérfano: reclamado hace 1 h, nunca completado → SE RETOMA (1 fila).
  insert into public.wa_mensaje_procesado (wa_message_id, created_at)
    values ('zzz-verif-0149-huerfano', now() - interval '1 hour');
  update public.wa_mensaje_procesado set created_at = now()
   where wa_message_id = 'zzz-verif-0149-huerfano'
     and completado_en is null and created_at < now() - interval '1 minute';
  get diagnostics retomado = row_count;

  -- Completado hace 1 h → NO se retoma (0 filas): es un duplicado de verdad.
  insert into public.wa_mensaje_procesado (wa_message_id, created_at, completado_en)
    values ('zzz-verif-0149-completo', now() - interval '1 hour', now() - interval '59 minutes');
  update public.wa_mensaje_procesado set created_at = now()
   where wa_message_id = 'zzz-verif-0149-completo'
     and completado_en is null and created_at < now() - interval '1 minute';
  get diagnostics completado_no_retomado = row_count;

  -- Fresco (en curso en otra invocación) → NO se retoma (0 filas).
  insert into public.wa_mensaje_procesado (wa_message_id) values ('zzz-verif-0149-fresco');
  update public.wa_mensaje_procesado set created_at = now()
   where wa_message_id = 'zzz-verif-0149-fresco'
     and completado_en is null and created_at < now() - interval '1 minute';
  get diagnostics fresco_no_retomado = row_count;

  raise exception E'CLAIM_0149  columna=%  huerfano_retomado=%  completado_retomado=%  fresco_retomado=%   (esperado t / 1 / 0 / 0)',
    columna, retomado, completado_no_retomado, fresco_no_retomado;
end $$;

-- ── 125. resumen_negocio() cuenta por flota y por día LOCAL MX, y no es ejecutable desde internet (mig. 0153) ──
--
-- La RPC es CROSS-TENANT A PROPÓSITO (solo la consola de superadmin, vía
-- service_role). Corre contra el catálogo REAL, así que los totales incluyen
-- lo que ya haya: por eso se comprueban (a) las entradas de las DOS flotas
-- sembradas en `viajesPorTenant` —aislamiento: 2 y 1, no 3 y 3— y (b) un día
-- en el AÑO 2000 (Likida nació en 2026: no hay filas reales ahí), con el caso
-- UTC: '2001-01-01T01:00Z' es el 31-dic-2000 a las 19:00 en CDMX y tiene que
-- caer en la barra del 31, junto con la de mediodía; la barra del 1-ene NO
-- existe. Equivalencia numérica: la suma de `viajesPorTenant` es `viajesTotal`
-- y `facturasTotal` creció exactamente en 2 con respecto a antes de sembrar.
-- Todo revierte con el RAISE final.
--
-- PENDIENTE DE CORRER CONTRA PRODUCCIÓN (escala 50k, 22-ago-2026). Esperado:
--   RESUMEN_NEGOCIO_0153  a=2  b=1  suma=t  facturas+2=t  dia31=2  dia01=f  anon=f  auth=f  svc=t  idx=2
do $$
declare
  t_a uuid; t_b uuid; o_a uuid; o_a2 uuid; o_b uuid; v uuid;
  antes jsonb; r jsonb; n_a int; n_b int; suma_ok boolean; facturas_ok boolean;
  dia31 int; dia01 boolean; anon_si boolean; auth_si boolean; svc_si boolean; idx int;
begin
  antes := public.resumen_negocio(null);

  insert into public.tenant (nombre) values ('ZZZ VERIF 0153 A') returning id into t_a;
  insert into public.tenant (nombre) values ('ZZZ VERIF 0153 B') returning id into t_b;
  insert into public.operador (tenant_id, nombre, telefono) values (t_a, 'P', '+520000015301') returning id into o_a;
  insert into public.operador (tenant_id, nombre, telefono) values (t_b, 'P', '+520000015302') returning id into o_b;
  insert into public.viaje (tenant_id, operador_id) values (t_a, o_a) returning id into v;
  -- El segundo viaje de la flota A va con OTRO operador: la 0029 impide dos
  -- viajes abiertos por operador, y lo que este bloque mide es el conteo por
  -- tenant, no quién los maneja.
  insert into public.operador (tenant_id, nombre, telefono) values (t_a, 'P2', '+520000015303') returning id into o_a2;
  insert into public.viaje (tenant_id, operador_id) values (t_a, o_a2);
  insert into public.viaje (tenant_id, operador_id) values (t_b, o_b);
  -- Dos comprobantes de la flota A en el año 2000: 19:00 CDMX del 31-dic
  -- (ya 1-ene en UTC) y mediodía del 31-dic.
  insert into public.gasto (tenant_id, viaje_id, concepto, monto, created_at)
    values (t_a, v, 'diesel', 100, '2001-01-01T01:00:00Z'),
           (t_a, v, 'diesel', 100, '2000-12-31T18:00:00Z');

  r := public.resumen_negocio('2000-12-31T06:00:00Z'::timestamptz);

  select (e->>'n')::int into n_a from jsonb_array_elements(r->'viajesPorTenant') e where e->>'tenantId' = t_a::text;
  select (e->>'n')::int into n_b from jsonb_array_elements(r->'viajesPorTenant') e where e->>'tenantId' = t_b::text;
  select coalesce(sum((e->>'n')::bigint), 0) = (r->>'viajesTotal')::bigint into suma_ok
    from jsonb_array_elements(r->'viajesPorTenant') e;
  facturas_ok := (r->>'facturasTotal')::bigint = (antes->>'facturasTotal')::bigint + 2;
  select (e->>'n')::int into dia31 from jsonb_array_elements(r->'facturasPorDia') e where e->>'dia' = '2000-12-31';
  select exists (select 1 from jsonb_array_elements(r->'facturasPorDia') e where e->>'dia' = '2001-01-01') into dia01;

  select has_function_privilege('anon', 'public.resumen_negocio(timestamptz)', 'execute'),
         has_function_privilege('authenticated', 'public.resumen_negocio(timestamptz)', 'execute'),
         has_function_privilege('service_role', 'public.resumen_negocio(timestamptz)', 'execute')
    into anon_si, auth_si, svc_si;
  select count(*) into idx from pg_indexes
   where schemaname = 'public' and indexname in ('gasto_created_at_idx', 'liquidacion_revisar_created_idx');

  raise exception E'RESUMEN_NEGOCIO_0153  a=%  b=%  suma=%  facturas+2=%  dia31=%  dia01=%  anon=%  auth=%  svc=%  idx=%   (esperado 2 / 1 / t / t / 2 / f / f / f / t / 2)',
    coalesce(n_a, -1), coalesce(n_b, -1), suma_ok, facturas_ok, coalesce(dia31, -1), dia01, anon_si, auth_si, svc_si, idx;
end $$;

-- ── 126. El Registro de Viajes pagina por cursor y cuenta de un golpe, sin mezclar flotas (mig. 0154) ──
-- Dos flotas sembradas a mano. La A tiene 7 viajes (dos sin fecha, dos con la
-- MISMA fecha para forzar el desempate por created_at/id, uno escalado sin
-- aceptar); la B tiene 2. Se recorre el registro de A con páginas de 2 por
-- cursor (la forma nueva) y se compara, viaje a viaje, contra el ORDER BY +
-- OFFSET de siempre (la forma vieja) — EQUIVALENCIA. Ningún id de B aparece.
-- `conteos_viajes_tenant` tiene que dar lo mismo que los cinco count(*) de
-- contarViajes/contarEscalados. Las dos RPC cerradas a anon. Todo revierte.
--
-- CORRIDO el 22-ago-2026 contra producción DENTRO de una transacción revertida
-- (la 0154 aún no está aplicada: se creó y se deshizo en el mismo `begin …
-- rollback`, así que la base quedó como estaba). Salida real:
--   REGISTRO_0154  paginas=4  equivalente=t  filtrado_B=t  escalados_filtro=1  busca_monte=1  conteos_ok=t  tope_100=t  anon=f/f
-- Esperado: exactamente eso. Al aplicar la 0154 hay que volver a correrlo.
do $$
declare
  ta uuid; tb uuid; ops uuid[] := '{}'; o uuid;
  viejo uuid[]; nuevo uuid[] := '{}'; ids_b uuid[];
  pag jsonb; ultima jsonb; paginas int := 0; n int;
  esc int; busca int; conteos jsonb; conteos_ok boolean; tope_ok boolean;
  anon_reg boolean; anon_con boolean;
  v_fecha date; v_created timestamptz; v_id uuid;
begin
  insert into public.tenant (nombre) values ('__verif_0154_A__') returning id into ta;
  insert into public.tenant (nombre) values ('__verif_0154_B__') returning id into tb;
  -- Un operador por viaje: uq_viaje_abierto_por_operador no deja dos viajes
  -- sin liquidar al mismo chofer.
  for i in 1..9 loop
    insert into public.operador (tenant_id, nombre, telefono)
      values (case when i <= 7 then ta else tb end, '__V154_' || i, '52100000154' || i) returning id into o;
    ops := ops || o;
  end loop;

  -- avisado_en va con los escalados/aceptados: viaje_aceptado_requiere_aviso (0058).
  insert into public.viaje (tenant_id, operador_id, folio, origen, destino, estatus, fecha_inicio, created_at, avisado_en, escalado_en, aceptado_en) values
    (ta, ops[1], 'A1', 'Monterrey', 'CDMX',     'abierto',    '2026-08-20', now() - interval '7 min', null,  null,  null),
    (ta, ops[2], 'A2', 'Saltillo',  'Torreón',  'en_cuadre',  '2026-08-20', now() - interval '6 min', now(), now(), null),
    (ta, ops[3], 'A3', 'León',      'Puebla',   'liquidado',  '2026-08-18', now() - interval '5 min', null,  null,  null),
    (ta, ops[4], 'A4', 'Querétaro', 'Veracruz', 'abierto',    '2026-08-01', now() - interval '4 min', now(), now(), now()),
    (ta, ops[5], 'A5', 'Tampico',   'Tuxpan',   'liquidado',  null,         now() - interval '3 min', null,  null,  null),
    (ta, ops[6], 'A6', 'Colima',    'Manzanillo','abierto',   null,         now() - interval '2 min', null,  null,  null),
    (ta, ops[7], 'A7', 'Mérida',    'Cancún',   'abierto',    '2026-08-21', now() - interval '1 min', null,  null,  null);
  insert into public.viaje (tenant_id, operador_id, folio, origen, destino, estatus, fecha_inicio) values
    (tb, ops[8], 'B1', 'Monterrey', 'CDMX', 'abierto', '2026-08-21'),
    (tb, ops[9], 'B2', 'Monterrey', 'CDMX', 'liquidado', null);

  -- Forma VIEJA: el orden del registro con OFFSET (lo que hacía .range()).
  select array_agg(id order by fecha_inicio desc nulls last, created_at desc, id desc)
    into viejo from public.viaje where tenant_id = ta;
  select array_agg(id) into ids_b from public.viaje where tenant_id = tb;

  -- Forma NUEVA: páginas de 2 por cursor hasta agotar (limite+1 = 3 filas
  -- cuando hay más; la tercera solo dice "hay otra página").
  v_fecha := null; v_created := null; v_id := null;
  loop
    pag := public.viajes_registro_tenant(ta, 'todos', null, v_fecha, v_created, v_id, 2);
    paginas := paginas + 1;
    n := jsonb_array_length(pag);
    for i in 0 .. least(n, 2) - 1 loop
      nuevo := nuevo || (pag -> i ->> 'id')::uuid;
    end loop;
    exit when n <= 2 or paginas > 10;
    ultima := pag -> 1;
    v_fecha := (ultima ->> 'fecha_inicio')::date;
    v_created := (ultima ->> 'created_at')::timestamptz;
    v_id := (ultima ->> 'id')::uuid;
  end loop;

  -- Filtro "escalados": A2 (escalado sin aceptar) sí; A4 (ya aceptado) no.
  select jsonb_array_length(public.viajes_registro_tenant(ta, 'escalados', null, null, null, null, 100)) into esc;

  -- Búsqueda: "monte" pega en Monterrey (A1) — y NO en los B1 de la otra flota.
  select jsonb_array_length(public.viajes_registro_tenant(ta, 'todos', 'monte', null, null, null, 100)) into busca;

  -- Tope 100 aunque pidan 10,000 (devuelve a lo sumo 101).
  select jsonb_array_length(public.viajes_registro_tenant(ta, 'todos', null, null, null, null, 10000)) <= 101 into tope_ok;

  conteos := public.conteos_viajes_tenant(ta);
  conteos_ok := (conteos ->> 'total')::int = 7 and (conteos ->> 'abiertos')::int = 4
    and (conteos ->> 'enCuadre')::int = 1 and (conteos ->> 'liquidados')::int = 2
    and (conteos ->> 'escalados')::int = 1;

  select has_function_privilege('anon', 'public.viajes_registro_tenant(uuid, text, text, date, timestamptz, uuid, int)', 'execute') into anon_reg;
  select has_function_privilege('anon', 'public.conteos_viajes_tenant(uuid)', 'execute') into anon_con;

  raise exception E'REGISTRO_0154  paginas=%  equivalente=%  filtrado_B=%  escalados_filtro=%  busca_monte=%  conteos_ok=%  tope_100=%  anon_reg=%  anon_con=%   (esperado 4 / t / t / 1 / 1 / t / t / f / f)',
    paginas, (nuevo = viejo), not (nuevo && ids_b), esc, busca, conteos_ok, tope_ok, anon_reg, anon_con;
end $$;

-- ── 129. El cursor de /v1/viajes tiene índice y el ANALYZE es sólo del servidor (mig. 0157) ──
-- ESC-15: sin `viaje_tenant_created_id_idx` cada página del cursor barre la
-- flota entera. ESC-18: `analizar_tablas_operacion()` corre ANALYZE como
-- dueño — si la anon key pudiera llamarla, cualquiera con la URL del
-- proyecto le pegaría a la base un ANALYZE en bucle. Las tres cosas las
-- demuestra sólo la base: el índice existe con ese orden, la función corre,
-- y anon/authenticated NO pueden ejecutarla mientras service_role sí.
do $$
declare
  idx_def text; anon_ok boolean; auth_ok boolean; svc_ok boolean; corrio boolean := false;
begin
  select indexdef into idx_def from pg_indexes
   where schemaname = 'public' and tablename = 'viaje' and indexname = 'viaje_tenant_created_id_idx';

  anon_ok := has_function_privilege('anon', 'public.analizar_tablas_operacion()', 'execute');
  auth_ok := has_function_privilege('authenticated', 'public.analizar_tablas_operacion()', 'execute');
  svc_ok  := has_function_privilege('service_role', 'public.analizar_tablas_operacion()', 'execute');

  perform public.analizar_tablas_operacion();
  corrio := true;

  raise exception E'CURSOR_ANALYZE_0157  indice=%  anon=%  authenticated=%  service_role=%  corrio=%   (esperado "(tenant_id, created_at DESC, id DESC)" / f / f / t / t)',
    coalesce(substring(idx_def from '\(.*\)'), 'FALTA'), anon_ok, auth_ok, svc_ok, corrio;
end $$;

-- ── 123. El agregado fiscal no juzga, no mezcla flotas y cuadra (mig. 0151) ──
-- Dos flotas sembradas a mano. A trae un comprobante por cada dimensión que
-- la ley en TS consulta (EFOS, cancelado, efectivo sobre/bajo tope, diésel
-- en efectivo, caseta con y sin base, alimentación timbrada sobre el tope en
-- un mismo día, tickets sin CFDI viejos y recientes, uno sin fecha). B tiene
-- un gasto de 9999 que NO debe aparecer en ninguna celda de A. Equivalencia
-- numérica: las sumas y conteos de las celdas de A son EXACTAMENTE los de
-- `gasto` filtrado igual — el agregado no inventa ni pierde un peso.
do $$
declare
  ta uuid; tb uuid; oa uuid; oa2 uuid; ob uuid; va1 uuid; va2 uuid; vb1 uuid;
  j jsonb; celdas int; n_total int; monto_total numeric; monto_directo numeric; n_directo int;
  con_cfdi int; con_cfdi_directo int;
  sobre_tope int; dia_partido numeric; bandas text; contamina boolean;
  sin_cota_n int; sin_fecha int;
  es_invoker boolean; anon_ok boolean; auth_ok boolean; svc_ok boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0151 A') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0151 A', '5215559990151') returning id into oa;
  -- La 0029 sólo admite UN viaje abierto por operador: el segundo va con su
  -- propio operador. El bloque agrega por tenant, así que no cambia lo que mide.
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (ta, oa, 'ZZZ-0151-A1', 'abierto', current_date - 10, 1000) returning id into va1;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'P2', '+520000015104') returning id into oa2;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (ta, oa2, 'ZZZ-0151-A2', 'abierto', current_date - 5, 1000) returning id into va2;

  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, cfdi_uuid, estado_sat, efos, forma_pago, iva_traslado, clave_prod_serv, sub_total, ocr_extra) values
    -- diésel con CFDI vigente, tarjeta — limpio
    (ta, va1, 'diesel', 1000, current_date - 3, 'zzz-0151-u1', 'vigente', false, '04', 137.93, '15101505', 862.07, null),
    -- diésel en efectivo con CFDI — combustible_efectivo
    (ta, va1, 'diesel',  500, current_date - 3, 'zzz-0151-u2', 'vigente', false, '01',  68.97, '15101505', 431.03, null),
    -- EFOS
    (ta, va1, 'otro',    300, current_date - 3, 'zzz-0151-u3', 'vigente', true,  '04',  41.38, null, null, null),
    -- cancelado
    (ta, va1, 'otro',    200, current_date - 3, 'zzz-0151-u4', 'cancelado', false, '04', 27.59, null, null, null),
    -- efectivo SOBRE el tope (2000) y BAJO el tope: misma dimensión salvo sobre_tope
    (ta, va1, 'otro',   2500, current_date - 3, 'zzz-0151-u5', 'vigente', false, '01', 344.83, null, null, null),
    (ta, va1, 'otro',   1500, current_date - 3, 'zzz-0151-u6', 'vigente', false, '01', 206.90, null, null, null),
    -- casetas: una con base, una sin
    (ta, va1, 'caseta',  348, current_date - 2, 'zzz-0151-u7', 'vigente', false, '04', 48, null, 300, null),
    (ta, va1, 'caseta',  232, current_date - 2, 'zzz-0151-u8', 'vigente', false, '04', null, null, null, null),
    -- alimentación TIMBRADA, mismo viaje y día, 500 + 400 = 900 > 750
    (ta, va2, 'alimentacion', 500, current_date - 4, 'zzz-0151-u9',  'vigente', false, '04', 68.97, null, null, null),
    (ta, va2, 'alimentacion', 400, current_date - 4, 'zzz-0151-u10', 'vigente', false, '04', 55.17, null, null, null),
    -- sin CFDI: reciente (banda 0 con los cortes de abajo) y vieja (banda 2)
    (ta, va2, 'diesel', 800, current_date - 1, null, null, null, null, null, null, null, '{"urlFacturacion":"https://facturacion.oxxogas.com/?folio=ZZZ1","emisor":"OXXO GAS"}'::jsonb),
    (ta, va2, 'diesel', 700, current_date - 120, null, null, null, null, null, null, null, '{"urlFacturacion":"https://facturacion.oxxogas.com/?folio=ZZZ2","emisor":"OXXO GAS"}'::jsonb),
    -- sin fecha: fuera de cualquier corte, cuenta solo sin cota
    (ta, va2, 'otro', 50, null, null, null, null, null, null, null, null, null);

  insert into tenant (nombre) values ('ZZZ VERIF 0151 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ 0151 B', '5215559990152') returning id into ob;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (tb, ob, 'ZZZ-0151-B1', 'abierto', current_date - 3, 100) returning id into vb1;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, forma_pago)
    values (tb, vb1, 'diesel', 9999, current_date - 3, '01');

  -- Catálogo: INVOKER y permisos
  select p.prosecdef = false,
         has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
    into es_invoker, anon_ok, auth_ok, svc_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gastos_fiscales_agregados_tenant';

  -- Ejercicio (últimos 30 días aquí), tope efectivo 2000, tope alimentación 750,
  -- cortes: hace 60 y hace 30 días (mes_siguiente / mes_natural simulados).
  j := gastos_fiscales_agregados_tenant(ta, current_date - 30, current_date, 2000, 750,
         array['alimentacion','viaticos'], array[(current_date - 60)::date, (current_date - 30)::date]);

  select count(*), sum((c->>'n')::int), sum((c->>'monto')::numeric),
         sum((c->>'n')::int) filter (where (c->>'tieneCfdi')::boolean),
         sum((c->>'n')::int) filter (where (c->>'sobreTopeEfectivo')::boolean),
         max((c->>'totalTimbradoDia')::numeric),
         string_agg(c->>'banda', ',' order by c->>'banda') filter (where c->>'banda' is not null),
         bool_or((c->>'monto')::numeric >= 9999)
    into celdas, n_total, monto_total, con_cfdi, sobre_tope, dia_partido, bandas, contamina
    from jsonb_array_elements(j) c;

  select count(*), sum(monto), count(*) filter (where cfdi_uuid is not null)
    into n_directo, monto_directo, con_cfdi_directo
    from gasto where tenant_id = ta and fecha >= current_date - 30 and fecha <= current_date;

  -- Sin cota: entran la vieja (banda 2) y la sin fecha
  j := gastos_fiscales_agregados_tenant(ta, null, null, 2000, 750,
         array['alimentacion','viaticos'], array[(current_date - 60)::date, (current_date - 30)::date]);
  select sum((c->>'n')::int), sum((c->>'n')::int) filter (where (c->>'sinFecha')::boolean),
         string_agg(c->>'banda', ',' order by c->>'banda') filter (where c->>'banda' is not null)
    into sin_cota_n, sin_fecha, bandas
    from jsonb_array_elements(j) c;

  raise exception E'FISCAL_AGREGADO_0151  invoker=%  anon=%  auth=%  svc=%  periodo_celdas=%  n_iguales=%  monto_iguales=%  con_cfdi_iguales=%  sobre_tope=%  dia_partido=%  B_contamina=%  sin_cota_n=%  sin_fecha=%  bandas=%   (esperado t / f / f / t / >0 / t / t / t / 1 / 900 / f / 13 / 1 / 0,2)',
    es_invoker, anon_ok, auth_ok, svc_ok, celdas, (n_total = n_directo), (monto_total = monto_directo),
    (con_cfdi = con_cfdi_directo), sobre_tope, dia_partido, contamina, sin_cota_n, sin_fecha, bandas;
end $$;

-- ── 122. Los 11 agregados de la 0150: existen, INVOKER, aislados, cuadran ───
--
-- La 0150 (ESCALA 50k, docs/escala-50k/MAPA.md) movió ONCE caminos de
-- analytics.ts de "traerTodo → agregar en JS" a RPC: anomalias_gasto_tenant,
-- gasto_semanal_tenant, top_rutas_gasto_tenant, gasto_por_concepto_tenant,
-- stats_operador_tenant, liquidado_semanal_tenant, viajes_por_mes_tenant,
-- operadores_detalle_tenant, dinero_observado_por_tipo_tenant,
-- liquidaciones_por_dia_tenant y conciliacion_consolidado_tenant.
--
-- Mismo molde que el bloque 89 (0112): (1) catálogo — las 11 existen, son
-- SECURITY INVOKER, anon/authenticated ciegos, service_role puede; (2)
-- AISLAMIENTO — dos flotas sembradas a mano con cifras distintas, y las de A
-- no contienen ni un centavo de B; (3) EQUIVALENCIA numérica contra el
-- cálculo a mano sobre la siembra (las mismas reglas que la prueba JS de
-- `analytics_agregados_0150.test.ts` comprueba contra el Postgres falso,
-- aquí contra Postgres de verdad).
--
-- Siembra de A (trampas conocidas: viaje.operador_id NOT NULL; UN 'abierto'
-- por operador —0029—; UNA liquidación por viaje; gasto.monto >= 0;
-- uq_gasto_cfdi_uuid (tenant, uuid, orden)):
--   · operadores oa1 (normal) y oa2 (con oposición → fuera de stats)
--   · viajes va1 (oa1, liquidado, anticipo 1000), va2 (oa1, abierto, 500),
--     va3 (oa2, liquidado, 300, fecha_inicio NULL → fuera de viajes_por_mes)
--   · gastos: diésel 1500 (va1) + 800 (va2) = 2300; caseta 200 (va1);
--     el MISMO CFDI 'zzz-uuid-0150-a' orden 1 en va1 y va2 → 1 anomalía
--     cfdi_duplicado; folio 'A-991' caseta 200 sin uuid en va1 y va3 → 1
--     anomalía folio_duplicado; concepto NULL 50 (va1) → 'otro'.
--   · liquidaciones: va1 (1500, diferencia -150, diferencias sobre_politica
--     120 + duplicado 80), va2 (700, diferencia 0.005 → NO cuenta), todas
--     creadas HOY a las 20:00 MX (que en UTC puede ser mañana: el bucket por
--     día local las tiene que fechar HOY).
--   · consolidado: 1 cfdi_xml con 3 líneas (conciliada, por_conciliar, sin_match).
-- Flota B: un operador, un viaje, un diésel de 9999, una liquidación de 8888
-- con diferencia 50: cualquier cifra de A que la toque se nota.
--
-- Todo se revierte con el `raise` final.
--
-- SALIDA ESPERADA:
--   AGREGADOS_0150  funcs=11  invoker=t  ninguna_anon=t  ninguna_auth=t
--   todas_svc=t  anomalias_ok=t  semanal_ok=t  rutas_ok=t  concepto_ok=t
--   stats_ok=t  liquidado_ok=t  meses_ok=t  detalle_ok=t  dinero_ok=t
--   dias_ok=t  consolidado_ok=t
--   (esperado 11/t/t/t/t y once `t`)
do $$
declare
  ta uuid; tb uuid; oa1 uuid; oa2 uuid; ob uuid; va1 uuid; va2 uuid; va3 uuid; vb1 uuid; xa uuid; indice_impide_duplicado boolean;
  hoy_mx date := (now() at time zone 'America/Mexico_City')::date;
  ts_20 timestamptz := (hoy_mx::text || ' 20:00')::timestamp at time zone 'America/Mexico_City';
  n_funcs int; todas_invoker boolean; ninguna_anon boolean; ninguna_auth boolean; todas_svc boolean;
  j jsonb; j1 jsonb; j2 jsonb;
  ok_anom boolean; ok_sem boolean; ok_rutas boolean; ok_conc boolean; ok_stats boolean; ok_liq boolean;
  ok_meses boolean; ok_det boolean; ok_dinero boolean; ok_dias boolean; ok_cons boolean;
begin
  -- ── FLOTA A ───────────────────────────────────────────────────────────
  insert into tenant (nombre) values ('ZZZ VERIF 0150 A') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ 0150 A1', '5215559990150') returning id into oa1;
  insert into operador (tenant_id, nombre, telefono, oposicion_automatizada) values (ta, 'ZZZ 0150 A2', '5215559990151', now()) returning id into oa2;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, origen, destino)
    values (ta, oa1, 'ZZZ-0150-A1', 'liquidado', hoy_mx - 3, 1000, 'CDMX', 'Guadalajara') returning id into va1;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, origen, destino)
    values (ta, oa1, 'ZZZ-0150-A2', 'abierto', hoy_mx - 1, 500, 'CDMX', 'Guadalajara') returning id into va2;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, origen, destino)
    values (ta, oa2, 'ZZZ-0150-A3', 'liquidado', null, 300, 'Monterrey', null) returning id into va3;

  -- 23-AGO-2026 · YA NO SE SIEMBRA UN CFDI DUPLICADO, PORQUE NO CABE.
  -- La 0065 amplió `uq_gasto_cfdi_uuid` a (tenant, uuid, ORDEN) para admitir la
  -- factura de CAPUFE —un CFDI que cubre varias casetas—, y con eso el mismo
  -- (uuid, orden) en dos viajes de una flota pasó a ser IMPOSIBLE. Este bloque
  -- llevaba desde entonces reventando en el INSERT sin llegar a su RAISE, o sea
  -- sin verificar nada. Lo que se prueba ahora es la garantía que sí existe: que
  -- el índice lo IMPIDE, que es más fuerte que detectarlo después. La rama
  -- `cfdi_duplicado` del RPC se queda —sigue cubriendo datos anteriores a la
  -- 0065 y el día que alguien toque el índice— pero ya no se le exige disparar.
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, folio, cfdi_uuid, cfdi_orden) values
    (ta, va1, 'diesel', 1500, hoy_mx - 3, 'D1', 'zzz-uuid-0150-a', 1),
    (ta, va2, 'diesel',  800, hoy_mx - 1, 'D2', 'zzz-uuid-0150-b', 1),   -- CFDI DISTINTO: el índice no deja repetir
    (ta, va1, 'caseta',  200, hoy_mx - 2, 'A-991', null, 1),
    (ta, va3, 'caseta',  200, hoy_mx - 2, 'A-991', null, 1),            -- mismo folio+concepto+monto, otro viaje
    -- `concepto` es NOT NULL desde la 0001 y su CHECK sólo admite el catálogo:
    -- este bloque sembraba NULL y por eso reventaba en el INSERT sin llegar
    -- NUNCA a su RAISE — o sea, llevaba desde que se escribió sin verificar
    -- nada, en rojo, sin que nadie lo mirara. Se siembra 'otro' explícito, que
    -- es lo que el `coalesce(concepto,'otro')` del RPC produce de todas formas.
    (ta, va1, 'otro',     50, hoy_mx - 2, null, null, 1);

  -- El índice hace imposible el duplicado que el RPC buscaría.
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, folio, cfdi_uuid, cfdi_orden)
      values (ta, va3, 'diesel', 999, hoy_mx - 1, 'DX', 'zzz-uuid-0150-a', 1);
    indice_impide_duplicado := false;   -- entró: el índice NO está protegiendo
  exception when unique_violation then
    indice_impide_duplicado := true;
  end;

  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, diferencias, created_at)
    -- El CHECK `liquidacion_diferencia_cuadra` (posterior a este bloque) exige
    -- diferencia = anticipo − comprobado; antes decía 1500/1500 con −150 y por
    -- eso reventaba. Se mueve el ANTICIPO de la liquidación, no el comprobado:
    -- `comprobadoTotal` (2200) y `anticipoTotal` (que sale de viaje.anticipo, no
    -- de aquí) siguen siendo los mismos, así que el bloque mide lo que siempre
    -- quiso medir.
    values (ta, va1, 1500, 1650, 150, 'con_diferencias',
      '[{"tipo":"sobre_politica","monto":120},{"tipo":"duplicado","monto":-80},{"monto":0}]'::jsonb, ts_20);
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, created_at)
    values (ta, va2, 700, 700, 0.005, 'cuadrada', ts_20);

  insert into cfdi_xml (tenant_id, cfdi_uuid, xml) values (ta, 'zzz-cons-0150-a', '<x/>') returning id into xa;
  insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, estatus) values
    (ta, xa, 1, 'ecc12', 10, 'conciliada'), (ta, xa, 2, 'ecc12', 20, 'por_conciliar'), (ta, xa, 3, 'ecc12', 30, 'sin_match');

  -- ── FLOTA B: solo para probar que NO contamina a A ───────────────────
  insert into tenant (nombre) values ('ZZZ VERIF 0150 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ 0150 B', '5215559990152') returning id into ob;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, origen, destino)
    values (tb, ob, 'ZZZ-0150-B1', 'liquidado', hoy_mx - 2, 200, 'CDMX', 'Guadalajara') returning id into vb1;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, folio, cfdi_uuid, cfdi_orden)
    values (tb, vb1, 'diesel', 9999, hoy_mx - 2, 'A-991', 'zzz-uuid-0150-a', 1);  -- mismo uuid/folio, OTRA flota
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, diferencias, created_at)
    values (tb, vb1, 8888, 8938, 50, 'revisar', '[{"tipo":"duplicado","monto":50}]'::jsonb, ts_20);

  -- ── 1. Catálogo ──────────────────────────────────────────────────────
  select count(*),
         count(*) filter (where p.prosecdef = false) = 11,
         count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) = 0,
         count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) = 0,
         count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 11
    into n_funcs, todas_invoker, ninguna_anon, ninguna_auth, todas_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('anomalias_gasto_tenant', 'gasto_semanal_tenant', 'top_rutas_gasto_tenant',
                       'gasto_por_concepto_tenant', 'stats_operador_tenant', 'liquidado_semanal_tenant',
                       'viajes_por_mes_tenant', 'operadores_detalle_tenant', 'dinero_observado_por_tipo_tenant',
                       'liquidaciones_por_dia_tenant', 'conciliacion_consolidado_tenant');

  -- ── 2+3. Anomalías: 1 cfdi (va1, va2) + 1 folio (va1, va3); B no entra ─
  -- Queda UNA anomalía: la de folio. El duplicado de CFDI ya no puede existir
  -- (lo impide el índice, probado arriba), y `folio_duplicado` sí — un ticket
  -- sin UUID no tiene índice que lo detenga, y por eso el RPC hace falta.
  j := anomalias_gasto_tenant(ta);
  ok_anom := jsonb_array_length(j) = 1
    and j->0->>'tipo' = 'folio_duplicado' and (j->0->>'monto')::numeric = 200
    and j->0->>'detalle' = 'Folio A-991 (caseta) liquidado en 2 viajes'
    and jsonb_array_length(j->0->'viajes') = 2
    and jsonb_array_length(anomalias_gasto_tenant(tb)) = 0;

  -- ── Gasto semanal (ventana de 7 días): suma por concepto = 2300/400/50 ─
  j := gasto_semanal_tenant(ta, hoy_mx - 6, hoy_mx);
  select coalesce(sum((e->>'total')::numeric) filter (where e->>'concepto' = 'diesel'), 0),
         coalesce(sum((e->>'total')::numeric) filter (where e->>'concepto' = 'caseta'), 0)
    into j1, j2 from jsonb_array_elements(j) e;
  ok_sem := j1::numeric = 2300 and j2::numeric = 400
    and (select count(*) from jsonb_array_elements(j) e where e->>'concepto' = 'otro' and (e->>'total')::numeric = 50) = 1
    and (select bool_and(e->>'semana' ~ '^\d{4}-S\d{2}$') from jsonb_array_elements(j) e);

  -- ── Top rutas: CDMX→Guadalajara 2550 primero; Monterrey→'—' 200; B fuera ─
  j := top_rutas_gasto_tenant(ta, 5, null, null);
  ok_rutas := jsonb_array_length(j) = 2
    and j->0->>'origen' = 'CDMX' and j->0->>'destino' = 'Guadalajara' and (j->0->>'total')::numeric = 2550
    and j->1->>'destino' = '—' and (j->1->>'total')::numeric = 200
    and jsonb_array_length(top_rutas_gasto_tenant(ta, 1, null, null)) = 1
    and jsonb_array_length(top_rutas_gasto_tenant(ta, 5, hoy_mx - 1, hoy_mx)) = 1;  -- solo el diésel de va2

  -- ── Gasto por concepto: diesel 2300 (2), caseta 400 (2), otro 50 (1) ──
  j := gasto_por_concepto_tenant(ta);
  ok_conc := jsonb_array_length(j) = 3
    and j->0->>'concepto' = 'diesel' and (j->0->>'total')::numeric = 2300 and (j->0->>'n')::int = 2
    and j->1->>'concepto' = 'caseta' and (j->1->>'total')::numeric = 400
    and j->2->>'concepto' = 'otro' and (j->2->>'total')::numeric = 50;

  -- ── Stats por operador: solo oa1 (oa2 se opuso); 2 viajes con diésel, 2300, 1 diferencia ─
  j := stats_operador_tenant(ta);
  ok_stats := jsonb_array_length(j) = 1
    and j->0->>'operadorId' = oa1::text
    and (j->0->>'viajes')::int = 2 and (j->0->>'dieselTotal')::numeric = 2300
    and (j->0->>'diferencias')::int = 1;  -- va2 (0.005) es redondeo, no cuenta

  -- ── Liquidado semanal: 2200 en la semana ISO de HOY (día local) ──────
  j := liquidado_semanal_tenant(ta, (hoy_mx - 6)::timestamp at time zone 'UTC');
  ok_liq := jsonb_array_length(j) = 1
    and j->0->>'semana' = to_char(hoy_mx, 'IYYY-"S"IW')
    and (j->0->>'total')::numeric = 2200;

  -- ── Viajes por mes: va3 sin fecha no entra; va1/va2 sí ───────────────
  j := viajes_por_mes_tenant(ta);
  select coalesce(sum((e->>'n')::int), 0) into j1 from jsonb_array_elements(j) e;
  ok_meses := j1::int = 2 and (select bool_and(e->>'mes' ~ '^\d{4}-\d{2}$') from jsonb_array_elements(j) e);

  -- ── Operadores detalle: oa1 2 viajes/1500 anticipo/2200 comprobado; oa2 1/300/0 ─
  j := operadores_detalle_tenant(ta);
  ok_det := jsonb_array_length(j) = 2
    and j->0->>'operadorId' = oa1::text and (j->0->>'viajes')::int = 2
    and (j->0->>'anticipoTotal')::numeric = 1500 and (j->0->>'comprobadoTotal')::numeric = 2200
    and j->1->>'operadorId' = oa2::text and (j->1->>'viajes')::int = 1
    and (j->1->>'anticipoTotal')::numeric = 300 and (j->1->>'comprobadoTotal')::numeric = 0;

  -- ── Dinero observado: sobre_politica 120 (1), duplicado |−80| (1), otro 0 (1); B (50) fuera ─
  j := dinero_observado_por_tipo_tenant(ta);
  ok_dinero := jsonb_array_length(j) = 3
    and j->0->>'tipo' = 'sobre_politica' and (j->0->>'monto')::numeric = 120
    and j->1->>'tipo' = 'duplicado' and (j->1->>'monto')::numeric = 80
    and j->2->>'tipo' = 'otro' and (j->2->>'monto')::numeric = 0 and (j->2->>'n')::int = 1;

  -- ── Cierres por día LOCAL: los dos de las 20:00 MX caen HOY, no mañana ─
  j := liquidaciones_por_dia_tenant(ta, (hoy_mx - 6)::timestamp at time zone 'UTC');
  ok_dias := jsonb_array_length(j) = 1
    and j->0->>'dia' = to_char(hoy_mx, 'YYYY-MM-DD') and (j->0->>'n')::int = 2;

  -- ── Consolidado: 3 líneas, 1 conciliada, 1 sin_match, 1 cfdi; B = 0 ──
  j := conciliacion_consolidado_tenant(ta);
  ok_cons := (j->>'total')::int = 3 and (j->>'conciliadas')::int = 1 and (j->>'sinMatch')::int = 1
    and (j->>'cfdis')::int = 1
    and (conciliacion_consolidado_tenant(tb)->>'total')::int = 0;

  delete from tenant where id in (ta, tb);

  raise exception E'AGREGADOS_0150  funcs=%  invoker=%  ninguna_anon=%  ninguna_auth=%  todas_svc=%  anomalias_ok=%  semanal_ok=%  rutas_ok=%  concepto_ok=%  stats_ok=%  liquidado_ok=%  meses_ok=%  detalle_ok=%  dinero_ok=%  dias_ok=%  consolidado_ok=%  indice_impide_duplicado=%   (esperado 11 / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t)',
    n_funcs, todas_invoker, ninguna_anon, ninguna_auth, todas_svc,
    ok_anom, ok_sem, ok_rutas, ok_conc, ok_stats, ok_liq, ok_meses, ok_det, ok_dinero, ok_dias, ok_cons,
    indice_impide_duplicado;
end $$;

-- ── 124. Los 7 agregados de la 0152: existen, INVOKER, aislados y cuadran ───
--
-- La 0152 movió OCHO lecturas del lado del ingreso y del encargado de "traer
-- la tabla a JS" a `sum()`/`count()` en SQL (docs/escala-50k/MAPA.md #12-#19).
-- Mismo criterio que el bloque 89 (0112), y las mismas cuatro comprobaciones:
--
--  1. **Las 7 existen, son SECURITY INVOKER y los permisos son los correctos**
--     (anon/authenticated ciegos, service_role puede), leído del catálogo.
--
--  2. **AISLAMIENTO entre flotas.** Las llama `service_role`, que salta RLS:
--     el `where tenant_id = p_tenant` es lo ÚNICO que separa una flota de
--     otra. Se siembran DOS flotas con cifras distintas y se exige que las de
--     A no contengan ni un peso de B — con una sola flota esto pasaría
--     siempre sin probar nada. La flota B trae 99,999 de ingreso, 88,888 de
--     comprobado y una factura de 70,000 vencida: cualquier fuga se ve.
--
--  3. **QUE CUADRAN** contra el cálculo hecho a mano sobre la siembra — el
--     mismo dataset que usan las pruebas de equivalencia JS-vs-RPC en TS
--     (comercial_equivalencia.test.ts, operacion_equivalencia.test.ts), aquí
--     contra Postgres de verdad y no contra un espejo en JS.
--
--  4. **QUE LA CARTERA CUADRA CONTRA SÍ MISMA**: la suma de las cinco cubetas
--     ES el `porCobrar`, al centavo. Es la única comprobación que un contralor
--     le puede hacer a esa tabla de un vistazo, y una tabla que no cuadra por
--     un centavo se descarta entera.
--
-- LA SIEMBRA (flota A), y por qué cada fila:
--   · va1 liquidado, ingreso 10,000, cliente ca, unidad ua, POD ninguno.
--   · va2 liquidado SIN ingreso (null ≠ 0), cliente ca, con factura BORRADOR
--     (F3, vía factura_viaje) y factura CANCELADA (F4, vía viaje_id): sigue
--     "en la mesa" y marcado `soloBorrador` — el caso de refacturación que la
--     0049 previó.
--   · va3 abierto, cliente ca2, ingreso 5,000, unidad ua, POD subido.
--   · va4 en_cuadre, SIN cliente y SIN unidad, del operador oa2, con una
--     incidencia abierta con SLA: alimenta `sinUnidad`, `podPendientes` e
--     `incidenciasAbiertas`.
--   · F1 emitida 11,600 con 5,000 pagados y vencida hace 45 días → saldo 6,600
--     en la cubeta 31-60. F2 emitida 2,320 SIN vence_en → cubeta sin_fecha (no
--     es corriente ni vencida: no se pactó cuándo).
--   · Una incidencia RESUELTA hace 200 días: no la lista `incidencias_tenant`
--     con `p_desde` de 90 días, y sí cuando `p_desde` es null.
--
-- TRAMPAS DE SIEMBRA (las que atraparon las primeras corridas):
--   `viaje.operador_id` es NOT NULL; `liquidacion_diferencia_cuadra` exige
--   `diferencia = total_anticipo - total_comprobado`; `liquidacion_viaje_uidx`
--   admite UNA liquidación por viaje; `factura_total_cuadra` exige
--   `total = subtotal + iva`; `factura_borrador_sin_uuid`; y
--   `uq_viaje_abierto_por_operador` (0029) deja UN solo 'abierto' por operador.
--
-- SALIDA REAL (22-ago-2026, primera corrida en verde):
--   AGREGADOS_0152  funcs=7  invoker=t  ninguna_anon=t  ninguna_auth=t
--   todas_svc=t  rent_ok=t  cart_ok=t  cob_ok=t  cob_pag=2  fact_ok=t
--   cubetas_cuadran=t  mesa_ok=t  tab_ok=t  carga_ok=t  inc_ok=t  inc_90=1
--   inc_todas=2   (esperado 7/t/t/t/t/t/t/t/2/t/t/t/t/t/t/1/2)
do $$
declare
  ta uuid; tb uuid; oa uuid; oa2 uuid; ob uuid; ca uuid; ca2 uuid; cb uuid;
  va1 uuid; va2 uuid; va3 uuid; va4 uuid; vb1 uuid; ua uuid; ub uuid;
  fa1 uuid; fa2 uuid; fa3 uuid; fa4 uuid;
  n_funcs int; todas_invoker boolean; ninguna_anon boolean; ninguna_auth boolean; todas_svc boolean;
  j jsonb; jc jsonb; jm jsonb;
  ok_rent boolean; ok_cart boolean; ok_cob boolean; n_cob_pag int; ok_fact boolean;
  cubetas_cuadran boolean; ok_mesa boolean; ok_tab boolean; ok_carga boolean; ok_inc boolean;
  n_inc_90 int; n_inc_todas int;
begin
  -- ── FLOTA A: la que se mide ────────────────────────────────────────────
  insert into tenant (nombre) values ('ZZZ VERIF 0152 A') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ Ana 0152', '5215559990152') returning id into oa;
  insert into operador (tenant_id, nombre, telefono, activo) values (ta, 'ZZZ Beto 0152', '5215559990153', false) returning id into oa2;
  insert into cliente (tenant_id, nombre, rfc, dias_credito, contacto)
    values (ta, 'ZZZ Cementos 0152', 'CEM010101AAA', 30, 'Lic. Paz') returning id into ca;
  insert into cliente (tenant_id, nombre) values (ta, 'ZZZ Acero 0152') returning id into ca2;
  insert into unidad (tenant_id, numero_economico, estado) values (ta, 'ZZZ-0152-T01', 'disponible') returning id into ua;
  insert into unidad (tenant_id, numero_economico, estado) values (ta, 'ZZZ-0152-T02', 'taller');
  -- Inactiva: NO cuenta como disponible (el tablero mira `activo`).
  insert into unidad (tenant_id, numero_economico, estado, activo) values (ta, 'ZZZ-0152-T03', 'disponible', false);

  -- `created_at` EXPLÍCITO en los dos liquidados: es la columna por la que
  -- `carga_operadores_tenant` acota (FE-3) y `rentabilidad_tenant` corta por
  -- periodo. Con el default (`now()`) una ventana de un día los seguiría
  -- contando y la prueba del filtro pasaría sin probar nada.
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, fecha_fin, anticipo, cliente_id, ingreso_flete, unidad_id, created_at)
    values (ta, oa, 'ZZZ-0152-A1', 'liquidado', current_date - 40, current_date - 38, 1000, ca, 10000, ua, now() - interval '40 days') returning id into va1;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, fecha_fin, anticipo, cliente_id, ingreso_flete, created_at)
    values (ta, oa, 'ZZZ-0152-A2', 'liquidado', current_date - 10, current_date - 9, 800, ca, null, now() - interval '10 days') returning id into va2;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, cliente_id, ingreso_flete, unidad_id)
    values (ta, oa, 'ZZZ-0152-A3', 'abierto', current_date - 1, 500, ca2, 5000, ua) returning id into va3;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo)
    values (ta, oa2, 'ZZZ-0152-A4', 'en_cuadre', current_date - 2, 500) returning id into va4;

  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, created_at)
    values (ta, va1, 1500, 1000, -500, 'cuadrada',
            (current_date - 38)::timestamp at time zone 'America/Mexico_City' + interval '20 hours');
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, created_at)
    values (ta, va2, 700, 800, 100, 'cuadrada',
            (current_date - 9)::timestamp at time zone 'America/Mexico_City' + interval '3 hours');

  insert into factura_emitida (tenant_id, cliente_id, viaje_id, folio, fecha, subtotal, iva, total, estatus, vence_en)
    values (ta, ca, va1, 'ZZZ-0152-F1', current_date - 75, 10000, 1600, 11600, 'emitida', current_date - 45) returning id into fa1;
  insert into factura_emitida (tenant_id, cliente_id, folio, fecha, subtotal, iva, total, estatus, vence_en)
    values (ta, ca2, 'ZZZ-0152-F2', current_date - 3, 2000, 320, 2320, 'emitida', null) returning id into fa2;
  insert into factura_emitida (tenant_id, cliente_id, folio, fecha, subtotal, iva, total, estatus, vence_en)
    values (ta, ca, 'ZZZ-0152-F3', current_date - 2, 1000, 0, 1000, 'borrador', current_date + 28) returning id into fa3;
  insert into factura_emitida (tenant_id, cliente_id, viaje_id, folio, fecha, subtotal, iva, total, estatus, vence_en)
    values (ta, ca, va2, 'ZZZ-0152-F4', current_date - 1, 500, 0, 500, 'cancelada', current_date + 29) returning id into fa4;
  insert into factura_viaje (factura_id, viaje_id) values (fa3, va2);
  insert into pago_recibido (tenant_id, factura_id, fecha, monto) values (ta, fa1, current_date - 30, 5000);

  insert into pod (tenant_id, viaje_id, estado, storage_path) values (ta, va3, 'subido', 'zzz/0152.jpg');
  insert into incidencia (tenant_id, viaje_id, unidad_id, tipo, prioridad, estado, sla_horas, abierta_en)
    values (ta, va4, ua, 'retraso', 'alta', 'abierta', 4, now() - interval '12 hours');
  insert into incidencia (tenant_id, viaje_id, tipo, estado, abierta_en, resuelta_en)
    values (ta, va1, 'averia', 'resuelta', now() - interval '200 days', now() - interval '199 days');

  -- ── FLOTA B: solo para probar que NO contamina a A ─────────────────────
  insert into tenant (nombre) values ('ZZZ VERIF 0152 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ Otro 0152', '5215559990154') returning id into ob;
  insert into cliente (tenant_id, nombre) values (tb, 'ZZZ Ajeno 0152') returning id into cb;
  insert into unidad (tenant_id, numero_economico, estado) values (tb, 'ZZZ-0152-B01', 'disponible') returning id into ub;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, cliente_id, ingreso_flete, unidad_id)
    values (tb, ob, 'ZZZ-0152-B1', 'abierto', current_date - 5, 200, cb, 99999, ub) returning id into vb1;
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus)
    values (tb, vb1, 88888, 200, -88688, 'cuadrada');
  insert into factura_emitida (tenant_id, cliente_id, viaje_id, folio, fecha, subtotal, iva, total, estatus, vence_en)
    values (tb, cb, vb1, 'ZZZ-0152-FB', current_date - 90, 70000, 0, 70000, 'emitida', current_date - 60);
  insert into incidencia (tenant_id, viaje_id, unidad_id, tipo, estado)
    values (tb, vb1, ub, 'averia', 'abierta');

  -- ── 1. Catálogo: existencia, INVOKER, permisos ─────────────────────────
  select count(*),
         count(*) filter (where p.prosecdef = false) = 7,
         count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) = 0,
         count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) = 0,
         count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 7
    into n_funcs, todas_invoker, ninguna_anon, ninguna_auth, todas_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rentabilidad_tenant', 'cartera_tenant', 'cobranza_tenant',
                       'facturacion_clientes_tenant', 'tablero_operacion_tenant',
                       'carga_operadores_tenant', 'incidencias_tenant');

  -- ── 2+3. Rentabilidad: 15,000 de ingreso (el null NO suma), 2 sin ingreso ─
  j := rentabilidad_tenant(ta, null);
  ok_rent := (j->>'ingreso')::numeric = 15000        -- si B contamina: +99,999
         and (j->>'costoComprobado')::numeric = 2200 -- si B contamina: +88,888
         and (j->>'viajesConIngreso')::int = 2
         and (j->>'viajesSinIngreso')::int = 2;

  -- ── 2+3. Cartera: reparto por cliente, saldo del más grande, sin cliente ─
  j := cartera_tenant(ta);
  ok_cart := (j->'clientes'->0->>'nombre') = 'ZZZ Cementos 0152'
         and (j->'clientes'->0->>'ingreso')::numeric = 10000
         and (j->'clientes'->0->>'viajesSinIngreso')::int = 1
         and (j->'clientes'->0->>'saldoPorCobrar')::numeric = 6600
         and (j->'clientes'->0->>'vencido')::numeric = 6600
         and (j->'clientes'->1->>'saldoPorCobrar')::numeric = 2320
         and (j->'clientes'->1->>'vencido')::numeric = 0
         and (j->>'viajesSinCliente')::int = 1
         and (j->>'conIngreso')::int = 2
         and jsonb_array_length(j->'clientes') = 2;   -- el de B no está

  -- ── 2+3. Cobranza: agregados sobre TODO, lista PAGINADA ────────────────
  j := cobranza_tenant(ta, null, null, 100, 0);
  ok_cob := (j->>'porCobrar')::numeric = 8920         -- 6,600 + 2,320 (ni borrador ni cancelada)
        and (j->>'vencido')::numeric = 6600
        and (j->>'sinCondiciones')::int = 1
        and (j->'facturas'->0->>'folio') = 'ZZZ-0152-F1'   -- la vencida primero
        and (j->'facturas'->0->>'cliente') = 'ZZZ Cementos 0152'
        and jsonb_array_length(j->'facturas') = 4;
  -- La página de 2 con desplazamiento 2 devuelve 2 renglones y los MISMOS
  -- agregados: recortar la lista nunca recorta la cifra.
  j := cobranza_tenant(ta, null, null, 2, 2);
  n_cob_pag := jsonb_array_length(j->'facturas');
  ok_cob := ok_cob and (j->>'porCobrar')::numeric = 8920;

  -- ── 2+3+4. Facturación a clientes: cartera por antigüedad + la mesa ────
  j := facturacion_clientes_tenant(ta, current_date, null, null, 100);
  jc := j->'cartera';
  jm := j->'enLaMesa';
  ok_fact := (jc->>'vivas')::int = 2
         and (jc->>'borradores')::int = 1
         and (jc->>'canceladas')::int = 1
         and (jc->>'facturado')::numeric = 13920
         and (jc->>'cobrado')::numeric = 5000
         and (jc->>'porCobrar')::numeric = 8920
         and (jc->>'vencido')::numeric = 6600
         and (jc->>'sinCondiciones')::int = 1
         and (jc->'cubetas'->2->>'clave') = 'v31_60'
         and (jc->'cubetas'->2->>'saldo')::numeric = 6600     -- vencida hace 45 días
         and (jc->'cubetas'->4->>'saldo')::numeric = 2320     -- sin_fecha, NO corriente
         and (jc->'clientes'->0->>'diasMasVencido')::int = 45;
  -- La suma de las CINCO cubetas es EXACTAMENTE el por cobrar.
  select coalesce(sum((c->>'saldo')::numeric), 0) = (jc->>'porCobrar')::numeric
    into cubetas_cuadran
    from jsonb_array_elements(jc->'cubetas') c;
  -- La mesa: va2 (liquidado, con borrador y con cancelada) sigue sin facturar;
  -- va1 (con factura viva) NO está. Su ingreso es null → no suma, se cuenta.
  ok_mesa := (jm->>'total')::int = 1
         and (jm->'viajes'->0->>'folio') = 'ZZZ-0152-A2'
         and (jm->'viajes'->0->>'soloBorrador')::boolean
         and (jm->>'sinIngreso')::int = 1
         and (jm->>'ingresoCapturado')::numeric = 0
         and (jm->>'diasMasViejo')::int = 9      -- cierre en día LOCAL MX, no UTC
         and (j->>'viajesLiquidados')::int = 2;

  -- ── 2+3. Tablero del encargado: seis conteos, ninguno es dinero ────────
  j := tablero_operacion_tenant(ta);
  ok_tab := (j->>'viajesActivos')::int = 2        -- va3 + va4 (el de B no)
        and (j->>'sinUnidad')::int = 1            -- va4
        and (j->>'unidadesDisponibles')::int = 1  -- la inactiva NO cuenta
        and (j->>'unidadesEnTaller')::int = 1
        and (j->>'incidenciasAbiertas')::int = 1  -- la resuelta no; la de B tampoco
        and (j->>'podPendientes')::int = 1;       -- va4: nadie creó el registro

  -- ── 2+3. Carga por operador: vivos siempre, liquidados en ventana (FE-3) ─
  j := carga_operadores_tenant(ta, now() - interval '90 days');
  ok_carga := jsonb_array_length(j) = 2
          and (j->0->>'nombre') = 'ZZZ Ana 0152'
          and (j->0->>'enCurso')::int = 1
          and (j->0->>'liquidados')::int = 2
          and (j->0->>'sinPod')::int = 0          -- va3 tiene POD subido
          and (j->1->>'nombre') = 'ZZZ Beto 0152'
          and (j->1->>'sinPod')::int = 1          -- va4 sin POD
          and (j->1->>'incidenciasAbiertas')::int = 1
          and (j->1->>'activo')::boolean = false;
  -- Con ventana de 1 día, los dos liquidados (hace 38 y 9) quedan fuera y el
  -- operador sigue apareciendo con sus vivos: filtrar no borra operadores.
  ok_carga := ok_carga
          and (carga_operadores_tenant(ta, now() - interval '1 day')->0->>'liquidados')::int = 0;

  -- ── 2+3. Incidencias: join en SQL, resueltas acotadas por ventana ──────
  n_inc_90 := jsonb_array_length(incidencias_tenant(ta, now() - interval '90 days', 500));
  n_inc_todas := jsonb_array_length(incidencias_tenant(ta, null, 500));
  -- El JOIN: folio del viaje y número económico de la unidad, resueltos en
  -- SQL y anclados por tenant. Antes esto costaba traer los 600k viajes.
  j := incidencias_tenant(ta, now() - interval '90 days', 500);
  ok_inc := (j->0->>'folio') = 'ZZZ-0152-A4'
        and (j->0->>'numeroEconomico') = 'ZZZ-0152-T01'
        and (j->0->>'slaHoras')::int = 4
        and (j->0->>'estado') = 'abierta';

  delete from tenant where id in (ta, tb);

  raise exception E'AGREGADOS_0152  funcs=%  invoker=%  ninguna_anon=%  ninguna_auth=%  todas_svc=%  rent_ok=%  cart_ok=%  cob_ok=%  cob_pag=%  fact_ok=%  cubetas_cuadran=%  mesa_ok=%  tab_ok=%  carga_ok=%  inc_ok=%  inc_90=%  inc_todas=%   (esperado 7/t/t/t/t/t/t/t/2/t/t/t/t/t/t/1/2)',
    n_funcs, todas_invoker, ninguna_anon, ninguna_auth, todas_svc,
    ok_rent, ok_cart, ok_cob, n_cob_pag, ok_fact, cubetas_cuadran, ok_mesa,
    ok_tab, ok_carga, ok_inc, n_inc_90, n_inc_todas;
end $$;

-- ── 127. Purgas en tandas, retención de la bandeja y bucket comprobantes (mig. 0155) ──
-- ESC-2/RES-14/ESC-16/ESC-17/ESC-13/ESC-10/RES-7. Se siembran tres filas en
-- `wa_evento_pendiente` (procesada hace 40 d, carta muerta de 100 d, pendiente
-- VIVA de 100 d con intentos=1) y una de `bitacora_auditoria` de 400 d; la
-- purga tiene que borrar exactamente dos eventos y la bitácora, y dejar la
-- viva. Además: `mantenimiento_de_datos` trae `parcial` y las llaves nuevas
-- conservando `prospectoPersonasPurgadas`; el bucket tiene 8 MB y 2 mimes;
-- `resumen_costo_ia(null,null)` devuelve `totales.n`; `cron_latido` rebota un
-- id fuera del dominio; y ninguna purga es ejecutable por `anon`. Esperado:
--   PURGAS_0155  eventos_borrados=2  viva_queda=t  bitacora_borrada=1  parcial=f
--                llaves=t  bucket=8388608/2  resumen_n=t  latido_rebota=t  anon=f
do $$
declare
  res jsonb; viva boolean; quedan_eventos int; bit_antes int; bit_despues int;
  tiene_llaves boolean; limite bigint; mimes int; resumen_n boolean;
  latido_rebota boolean := false; anon_ok boolean;
begin
  insert into public.wa_evento_pendiente (id, evento, recibido_en, intentos, procesado_en) values
    ('zzz-verif-0155-procesada', '{"from":"x"}', now() - interval '41 days', 1, now() - interval '40 days'),
    ('zzz-verif-0155-muerta',    '{"from":"x"}', now() - interval '100 days', 5, null),
    ('zzz-verif-0155-viva',      '{"from":"x"}', now() - interval '100 days', 1, null);
  insert into public.bitacora_auditoria (accion, ocurrio_en) values ('zzz.verif.0155', now() - interval '400 days');
  select count(*) into bit_antes from public.bitacora_auditoria where accion = 'zzz.verif.0155';

  res := public.mantenimiento_de_datos(30);

  select count(*) into quedan_eventos from public.wa_evento_pendiente where id like 'zzz-verif-0155-%';
  select exists (select 1 from public.wa_evento_pendiente where id = 'zzz-verif-0155-viva') into viva;
  select count(*) into bit_despues from public.bitacora_auditoria where accion = 'zzz.verif.0155';
  tiene_llaves := (res ? 'parcial') and (res ? 'waEventosPurgados') and (res ? 'posicionesPurgadas')
    and (res ? 'llmCostoPurgado') and (res ? 'bitacoraPurgada') and (res ? 'cobranzaContactosPurgados')
    and (res ? 'prospectoPersonasPurgadas') and jsonb_typeof(res->'llmCostoPurgado') = 'number';
  select file_size_limit, cardinality(allowed_mime_types) into limite, mimes from storage.buckets where id = 'comprobantes';
  resumen_n := jsonb_typeof(public.resumen_costo_ia(null, null)->'totales'->'n') = 'number';
  begin
    insert into public.cron_latido (id) values ('zzz-inventado');
  exception when check_violation then latido_rebota := true;
  end;
  select has_function_privilege('anon', 'public.purgar_wa_evento_pendiente(integer, integer, timestamptz, timestamptz)', 'EXECUTE')
      or has_function_privilege('anon', 'public.purgar_en_tandas(regclass, text, timestamptz, integer)', 'EXECUTE')
      or has_function_privilege('anon', 'public.purgar_llm_costo(integer, timestamptz, timestamptz)', 'EXECUTE')
    into anon_ok;

  raise exception E'PURGAS_0155  eventos_borrados=%  viva_queda=%  bitacora_borrada=%  parcial=%  llaves=%  bucket_limite=%  bucket_mimes=%  resumen_n=%  latido_rebota=%  anon=%   (esperado 2 / t / 1 / f / t / 8388608 / 2 / t / t / f)',
    3 - quedan_eventos, viva, bit_antes - bit_despues, (res->>'parcial')::boolean, tiene_llaves,
    coalesce(limite, 0), coalesce(mimes, 0), resumen_n, latido_rebota, anon_ok;
end $$;

-- ── 131. Las tres escrituras de dinero ya son atómicas (mig. 0159) ──────────
-- Los tres hallazgos de la auditoría 18 que compartían forma —leer, decidir en
-- TypeScript, escribir— y por eso el mismo modo de fallo. Aquí se reproducen
-- los tres escenarios contra Postgres, que es el único que puede demostrarlo:
--
--   A · DAT-05  dos abonos sobre la misma factura: el segundo ve el saldo que
--               dejó el primero (con la factura trabada) y REBOTA. Antes los
--               dos veían $0 pagados y `factura_saldo` quedaba en negativo.
--   B · DAT-06  reabrir un viaje cuyo operador YA tiene otro abierto: el
--               UPDATE choca con uq_viaje_abierto_por_operador (0029) y toda
--               la transacción revierte CON SU LIQUIDACIÓN INTACTA. Antes la
--               liquidación se borraba primero y el rebote la dejaba perdida.
--               En el camino bueno, la liquidación se ARCHIVA antes de irse.
--   C · DAT-20  la mezcla de `tenant.config` ocurre dentro del UPDATE, es
--               PROFUNDA (el `||` de jsonb borraría el subárbol hermano) y el
--               CHECK sigue vivo. Incluye la llave `agentes`, que hasta la
--               0159 el CHECK rechazaba: la estrategia por agente no podía
--               guardarse en absoluto.
--   D · DAT-41  el id de la liquidación se deriva del viaje, así que el folio
--               que imprime el PDF es el que de verdad queda en la base.
--
-- PENDIENTE DE CORRER CONTRA PRODUCCIÓN (auditoría 18). Corrido el 22-ago-2026
-- contra Postgres 17.11 con las 159 migraciones aplicadas. Salida REAL:
--   RPCS_0159  parcial-entra=t  sobrepago-rebota=t  saldo-nunca-negativo=t
--              salda-y-marca-pagada=t  factura-ajena-rebota=t
--              reabrir-rebota-con-liq-viva=t  reabrir-archiva=t  pdf-devuelto=t
--              liq-borrada=t  viaje-abierto=t  id-derivado-del-viaje=t
--              merge-conserva-hermanos=t  merge-profundo-agentes=t
--              llave-inventada-rebota=t  borrado-explicito=t  anon=f
do $$
declare
  ta uuid; tb uuid; cli uuid; fac uuid; facb uuid;
  op uuid; v1 uuid; v2 uuid; liq uuid;
  res jsonb; cfg jsonb;
  parcial_entra boolean := false;
  sobrepago_rebota boolean := false;
  saldo_no_negativo boolean := false;
  salda_y_marca boolean := false;
  factura_ajena_rebota boolean := false;
  reabrir_rebota_liq_viva boolean := false;
  reabrir_archiva boolean := false;
  pdf_devuelto boolean := false;
  liq_borrada boolean := false;
  viaje_abierto boolean := false;
  id_derivado boolean := false;
  merge_hermanos boolean := false;
  merge_profundo boolean := false;
  llave_inventada_rebota boolean := false;
  borrado_explicito boolean := false;
  anon_ok boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0159 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0159 B') returning id into tb;

  -- ── A · DAT-05: el saldo se lee con la factura trabada ────────────────────
  insert into cliente (tenant_id, nombre, rfc) values (ta, 'ZZZ cli 0159', 'XAXX010101000') returning id into cli;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, cli, 10000, 1600, 11600, 'emitida') returning id into fac;

  -- Primer abono: parcial, entra y NO marca pagada.
  res := registrar_pago_tx(ta, fac, current_date, 10000, 'transferencia', null);
  parcial_entra := (res ->> 'saldada')::boolean = false
                   and (select estatus from factura_emitida where id = fac) = 'emitida';

  -- Segundo abono de $2,000 sobre un saldo de $1,600: ESTE es el que antes
  -- pasaba (veía $0 pagados) y dejaba la factura sobrepagada.
  begin
    res := registrar_pago_tx(ta, fac, current_date, 2000, 'transferencia', null);
  exception when sqlstate 'CU011' then
    sobrepago_rebota := position('motivo=sobrepago' in sqlerrm) > 0;
  end;

  select saldo >= 0 into saldo_no_negativo from factura_saldo where factura_id = fac;

  -- El que SÍ cabe salda y marca `pagada` en la misma transacción.
  res := registrar_pago_tx(ta, fac, current_date, 1600, 'efectivo', 'REF-1');
  salda_y_marca := (res ->> 'saldada')::boolean
                   and (select estatus from factura_emitida where id = fac) = 'pagada'
                   and (select saldo from factura_saldo where factura_id = fac) = 0;

  -- La factura de OTRA flota ni se traba.
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, cli, 100, 16, 116, 'emitida') returning id into facb;
  begin
    res := registrar_pago_tx(tb, facb, current_date, 10, 'efectivo', null);
  exception when sqlstate 'CU010' then factura_ajena_rebota := true;
  end;

  -- ── B · DAT-06: el orden que salva la liquidación ─────────────────────────
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ op 0159', '5215559990159') returning id into op;
  insert into viaje (tenant_id, operador_id, estatus) values (ta, op, 'liquidado') returning id into v1;
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, pdf_url)
    values (ta, v1, 10000, 10000, 0, 'cuadrada', 'ta/v1.pdf') returning id into liq;

  -- D · el id NO es aleatorio: sale del viaje, que es lo que el PDF puede
  -- calcular antes de que la fila exista.
  id_derivado := liq = md5(v1::text || ':liquidacion')::uuid;

  -- El MISMO operador con otro viaje abierto: `uq_viaje_abierto_por_operador`
  -- va a rechazar el UPDATE de estatus.
  insert into viaje (tenant_id, operador_id, estatus) values (ta, op, 'abierto') returning id into v2;

  begin
    res := reabrir_viaje_tx(ta, v1);
  exception when unique_violation then
    -- LO QUE IMPORTA: la liquidación sigue ahí. Antes se borraba PRIMERO y
    -- este rebote la dejaba perdida, con el viaje liquidado sin papel.
    reabrir_rebota_liq_viva := exists (select 1 from liquidacion where viaje_id = v1)
                               and (select estatus from viaje where id = v1) = 'liquidado';
  end;

  -- Se cierra el estorbo y ahora el reabrir procede.
  update viaje set estatus = 'liquidado' where id = v2;
  res := reabrir_viaje_tx(ta, v1);
  pdf_devuelto    := res ->> 'pdf_perdido' = 'ta/v1.pdf' and (res ->> 'hubo_liquidacion')::boolean;
  liq_borrada     := not exists (select 1 from liquidacion where viaje_id = v1);
  viaje_abierto   := (select estatus from viaje where id = v1) = 'abierto';
  reabrir_archiva := exists (
    select 1 from liquidacion_historico
     where viaje_id = v1 and liquidacion_id = liq and pdf_url = 'ta/v1.pdf'
       and total_comprobado = 10000 and motivo = 'reabrir');

  -- ── C · DAT-20: la mezcla, dentro del UPDATE y PROFUNDA ───────────────────
  update tenant set config = jsonb_build_object(
    'estimulos', jsonb_build_object('viaticosTopeFiscalDiarioMxn', 750),
    'politica',  '[{"concepto":"diesel","topeMonto":4000}]'::jsonb,
    'facilidadCombustibleEfectivo', '{"dedicacionExclusivaCarga":true,"regimenElegible":true}'::jsonb,
    'agentes',   '{"conductores":{"horasEscalacion":5}}'::jsonb
  ) where id = ta;

  -- Guardar la política NO se lleva a los hermanos (el bug de config.ts, en SQL).
  cfg := tenant_config_merge(ta, '{"politica":[{"concepto":"caseta","topeMonto":1500}]}'::jsonb);
  merge_hermanos := cfg -> 'estimulos' ->> 'viaticosTopeFiscalDiarioMxn' = '750'
                    and cfg -> 'politica' -> 0 ->> 'concepto' = 'caseta'
                    and jsonb_array_length(cfg -> 'politica') = 1;   -- los arrays REEMPLAZAN

  -- Y la mezcla del subárbol es PROFUNDA: `||` habría borrado `conductores`.
  cfg := tenant_config_merge(ta, '{"agentes":{"liquidacion":{"umbralConfianza":0.85}}}'::jsonb);
  merge_profundo := cfg -> 'agentes' -> 'conductores' ->> 'horasEscalacion' = '5'
                    and cfg -> 'agentes' -> 'liquidacion' ->> 'umbralConfianza' = '0.85';

  -- El CHECK sigue vivo a través del RPC: una llave que el tipo no conoce rebota.
  begin
    cfg := tenant_config_merge(ta, '{"politicas":[{"concepto":"diesel"}]}'::jsonb);
  exception when others then llave_inventada_rebota := true;
  end;

  -- Y el borrado explícito de una llave (la facilidad del 15% sin declarar).
  cfg := tenant_config_merge(ta, '{}'::jsonb, array['facilidadCombustibleEfectivo']);
  borrado_explicito := not (cfg ? 'facilidadCombustibleEfectivo') and cfg ? 'estimulos';

  -- ── Permisos: nada de esto se ejecuta desde internet ──────────────────────
  -- La firma lleva SIETE argumentos desde la 0237: el séptimo (`p_propuesta`,
  -- con default null) es la llave de idempotencia del abono conciliado. La
  -- firma de seis ya no existe, y preguntar por ella aquí haría fallar el
  -- bloque con «function does not exist» en vez de medir el permiso.
  select has_function_privilege('anon', 'public.registrar_pago_tx(uuid, uuid, date, numeric, text, text, uuid)', 'EXECUTE')
      or has_function_privilege('anon', 'public.reabrir_viaje_tx(uuid, uuid)', 'EXECUTE')
      or has_function_privilege('anon', 'public.tenant_config_merge(uuid, jsonb, text[])', 'EXECUTE')
    into anon_ok;

  raise exception E'RPCS_0159  parcial-entra=%  sobrepago-rebota=%  saldo-nunca-negativo=%\n           salda-y-marca-pagada=%  factura-ajena-rebota=%\n           reabrir-rebota-con-liq-viva=%  reabrir-archiva=%  pdf-devuelto=%\n           liq-borrada=%  viaje-abierto=%  id-derivado-del-viaje=%\n           merge-conserva-hermanos=%  merge-profundo-agentes=%\n           llave-inventada-rebota=%  borrado-explicito=%  anon=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / f)',
    parcial_entra, sobrepago_rebota, saldo_no_negativo,
    salda_y_marca, factura_ajena_rebota,
    reabrir_rebota_liq_viva, reabrir_archiva, pdf_devuelto,
    liq_borrada, viaje_abierto, id_derivado,
    merge_hermanos, merge_profundo,
    llave_inventada_rebota, borrado_explicito, anon_ok;
end $$;

-- ── 130. La integridad fiscal de la 0158, atacada de once formas ────────────
--
-- Un solo bloque para los once hallazgos del rubro DATOS de la auditoría 18
-- porque todos comparten el mismo montaje —una flota, un viaje, un gasto, una
-- liquidación— y montarlo once veces sería once veces más lento sin decir
-- nada nuevo. Cada clave del mensaje es un hallazgo:
--
--   descuadre_rebota      DAT-02 · el cierre cuenta los comprobantes DENTRO
--                         del candado del viaje: si entró una foto entre el
--                         cuadre y el cierre, CU003 y no hay liquidación.
--   tenant_ajeno_rebota   DAT-14 · el viaje tiene que ser de la flota que
--                         cierra (antes: insert de liquidación + update de
--                         cero filas, sin un solo error).
--   sin_delete            DAT-03 · CERO policies de DELETE (o `for all`) en
--                         gasto/viaje/liquidacion. Leído del catálogo: se
--                         pone rojo con cualquier `for all` que renazca.
--   borrado_rebota        DAT-03 · y si renaciera, el trigger frena igual.
--                         Se FALSIFICA aquí: se crea la `for all` que la
--                         0086 recreó sin mirar, y el DELETE del autenticado
--                         choca contra el trigger (CU004).
--   concepto_rebota       DAT-07 · `concepto` decide política y tope; con la
--                         liquidación emitida ya no se reedita.
--   anticipo_rebota       DAT-07 · el anticipo es el minuendo de la
--                         diferencia que el operador lee en WhatsApp.
--   uuid_mayus_rebota     DAT-26 · el mismo CFDI en mayúsculas ya no entra
--                         como si fuera otro comprobante.
--   pago_huerfano_rebota  DAT-27 · borrar una factura con abonos rebota
--                         (23503) en vez de llevarse el dinero cobrado.
--   fecha_imposible_rebota DAT-28 · un ticket fechado dentro de dos años no
--                         existe (lo meramente sospechoso lo sigue marcando
--                         fecha_dudosa.ts, que pide otra foto).
--   diferencias_rebota    DAT-30 · `diferencias` es arreglo o no es nada:
--                         un objeto ahí revienta el panel entero.
--   folio_mayus_rebota    DAT-36 · «VJ-1» y «vj-1» son el MISMO folio.
--
-- Todo revierte con el RAISE final. PENDIENTE DE CORRER CONTRA PRODUCCIÓN
-- (auditoría 18, rubro datos). Esperado:
--   INTEGRIDAD_0158  descuadre_rebota=t  tenant_ajeno_rebota=t  sin_delete=0
--   borrado_rebota=t  concepto_rebota=t  anticipo_rebota=t  uuid_mayus_rebota=t
--   pago_huerfano_rebota=t  fecha_imposible_rebota=t  diferencias_rebota=t
--   folio_mayus_rebota=t
do $$
declare
  v_t uuid; v_t2 uuid; v_o uuid; v_o2 uuid; v_v uuid; v_v2 uuid; v_g uuid; v_c uuid; v_f uuid;
  descuadre_rebota boolean := false; tenant_ajeno_rebota boolean := false;
  sin_delete int; borrado_rebota boolean := false;
  concepto_rebota boolean := false; anticipo_rebota boolean := false;
  uuid_mayus_rebota boolean := false; pago_huerfano_rebota boolean := false;
  fecha_imposible_rebota boolean := false; diferencias_rebota boolean := false;
  folio_mayus_rebota boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0158 A') returning id into v_t;
  insert into tenant (nombre) values ('ZZZ VERIF 0158 B') returning id into v_t2;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','5215500000158') returning id into v_o;
  insert into viaje (tenant_id, operador_id, anticipo, folio) values (v_t, v_o, 5000, 'VJ-0158') returning id into v_v;
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'diesel', 4850) returning id into v_g;

  -- ═══ DAT-02 · el cierre cuenta ═══════════════════════════════════════════
  -- El cuadre vio UN comprobante; entre el PDF y el cierre entró otro. Con
  -- p_n_gastos = 1 y dos gastos en la base, el cierre entero se cae.
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'caseta', 800);
  begin
    perform guardar_liquidacion_tx(v_t, v_v, 4850, 5000, 150, 'cuadrada', '[]'::jsonb, 0,0,0, 'https://x/liq.pdf', 0, 1);
  exception when others then descuadre_rebota := (SQLSTATE = 'CU003');
  end;

  -- ═══ DAT-14 · el viaje es de quien cierra ════════════════════════════════
  begin
    perform guardar_liquidacion_tx(v_t2, v_v, 4850, 5000, 150, 'cuadrada', '[]'::jsonb, 0,0,0, null, 0, null);
  exception when others then tenant_ajeno_rebota := (SQLSTATE = 'CU002');
  end;

  -- Con el conteo correcto, el cierre SÍ pasa: el resto del bloque necesita
  -- una liquidación emitida de verdad.
  perform guardar_liquidacion_tx(v_t, v_v, 5650, 5000, -650, 'cuadrada', '[]'::jsonb, 0,0,0, 'https://x/liq.pdf', 0, 2);

  -- ═══ DAT-03 · ninguna policy deja borrar dinero ══════════════════════════
  select count(*) into sin_delete from pg_policies
   where schemaname = 'public' and tablename in ('gasto','viaje','liquidacion')
     and cmd in ('ALL', 'DELETE');

  -- Y si mañana renaciera una `for all` —lo que hizo la 0086 con las policies
  -- finas de la 0045—, el trigger sigue de pie.
  -- La policy falsificada no basta desde 0321: el serializador anterior
  -- exige este helper. Sólo este bloque lo habilita; el RAISE final revierte
  -- ambos permisos para alcanzar y probar específicamente CU004.
  grant execute on function public.cierre_tenant_lock_key(uuid) to authenticated;
  create policy zzz_verif_0158_falsificada on gasto for all using (true) with check (true);
  begin
    set local role authenticated;
    begin
      delete from gasto where id = v_g;
    exception when others then borrado_rebota := (SQLSTATE = 'CU004');
    end;
    reset role;
  exception when others then reset role; raise;
  end;
  drop policy zzz_verif_0158_falsificada on gasto;

  -- ═══ DAT-07 · lo que ya no se reedita ════════════════════════════════════
  begin
    update gasto set concepto = 'caseta' where id = v_g;
  exception when others then concepto_rebota := (SQLSTATE = 'CU001');
  end;
  begin
    update viaje set anticipo = 9999 where id = v_v;
  exception when others then anticipo_rebota := (SQLSTATE = 'CU004');
  end;

  -- Los dos ataques que siguen entran por un viaje ABIERTO a propósito: en el
  -- ya liquidado los frenaría antes el trigger de la 0036 (BEFORE INSERT corre
  -- antes que los CHECK) y este bloque diría «rebotó» sin haber probado nada
  -- de lo que dice probar. El operador es el mismo porque el primer viaje ya
  -- quedó `liquidado` y la 0029 solo prohíbe DOS ABIERTOS a la vez.
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v2;

  -- ═══ DAT-26 · el UUID vive en minúsculas ═════════════════════════════════
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, cfdi_uuid)
      values (v_t, v_v2, 'caseta', 10, 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
  exception when check_violation then uuid_mayus_rebota := true;
    when others then uuid_mayus_rebota := false;
  end;

  -- ═══ DAT-28 · una fecha imposible no entra ═══════════════════════════════
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
      values (v_t, v_v2, 'caseta', 10, (current_date + 800));
  exception when others then fecha_imposible_rebota := (SQLSTATE = 'CU005');
  end;

  -- ═══ DAT-30 · `diferencias` es un arreglo ════════════════════════════════
  begin
    update liquidacion set diferencias = '{"tipo":"efectivo"}'::jsonb where viaje_id = v_v;
  exception when check_violation then diferencias_rebota := true;
  end;

  -- ═══ DAT-27 · el abono no se va con la factura ═══════════════════════════
  insert into cliente (tenant_id, nombre) values (v_t, 'ZZZ Cliente 0158') returning id into v_c;
  insert into factura_emitida (tenant_id, cliente_id, folio, subtotal, iva, total, estatus)
    values (v_t, v_c, 'F-0158', 1000, 160, 1160, 'emitida') returning id into v_f;
  insert into pago_recibido (tenant_id, factura_id, monto) values (v_t, v_f, 500);
  begin
    delete from factura_emitida where id = v_f;
  exception when foreign_key_violation then pago_huerfano_rebota := true;
  end;

  -- ═══ DAT-36 · el folio no tiene dos ortografías ══════════════════════════
  -- Con OTRO operador: con el mismo, el choque sería el de la 0029 («un solo
  -- viaje abierto por operador») y este bloque cantaría victoria sin haber
  -- tocado el índice del folio.
  insert into operador (tenant_id, nombre, telefono) values (v_t,'Q','5215500000159') returning id into v_o2;
  begin
    insert into viaje (tenant_id, operador_id, folio) values (v_t, v_o2, 'vj-0158');
  exception when unique_violation then folio_mayus_rebota := true;
  end;

  raise exception E'INTEGRIDAD_0158  descuadre_rebota=%  tenant_ajeno_rebota=%  sin_delete=%  borrado_rebota=%  concepto_rebota=%  anticipo_rebota=%  uuid_mayus_rebota=%  pago_huerfano_rebota=%  fecha_imposible_rebota=%  diferencias_rebota=%  folio_mayus_rebota=%   (esperado t / t / 0 / t / t / t / t / t / t / t / t)',
    descuadre_rebota, tenant_ajeno_rebota, sin_delete, borrado_rebota,
    concepto_rebota, anticipo_rebota, uuid_mayus_rebota, pago_huerfano_rebota,
    fecha_imposible_rebota, diferencias_rebota, folio_mayus_rebota;
end $$;

-- ── 133. El día de la base es el día de MÉXICO, no el de Londres (mig. 0161) ──
--
-- DAT-23. Supabase corre en UTC y México va seis horas atrás: de las 18:00 a
-- las 24:00 hora local, `current_date` YA ES MAÑANA. De ahí colgaban
-- `factura_saldo.vencida` (y con ella TODA la cobranza, porque `cobranza_tenant`
-- y `facturacion_clientes_tenant` de la 0152 leen ese flag en vez de
-- recalcularlo) y los defaults de cuatro columnas de fecha.
--
-- El bloque NO puede mover el reloj de la base, así que comprueba las tres
-- cosas que sí son deterministas a cualquier hora:
--
--   (a) LA ARITMÉTICA, con el peor caso escrito a mano: las 19:00 del 31 de
--       diciembre en México son las 01:00Z del 1 de enero. Leído en México da
--       2026-12-31; leído en UTC da 2027-01-01 — un EJERCICIO FISCAL de
--       diferencia. Es el bug, demostrado sin depender de qué hora sea.
--   (b) LA DEFINICIÓN VIVA de la vista: ya no nombra `current_date`, sí nombra
--       la zona, y SIGUE SIENDO `security_invoker`. Lo tercero no es adorno:
--       `create or replace view` RESETEA las reloptions, así que la primera
--       versión de la 0161 borró sin querer el `security_invoker = true` que
--       la 0054 puso para tapar la fuga entre inquilinos, y el bloque 33 se
--       puso rojo (`via-vista=2`) al aplicarla. Se comprueba aquí también
--       para que el bloque de la migración que la tocó lo vigile de cerca.
--   (c) LOS CUATRO DEFAULTS, leídos de `information_schema`.
--
-- Y además la semántica con filas reales: una factura que vence HOY (día de
-- México) NO está vencida —el día del vencimiento todavía se puede pagar— y
-- una que venció ayer SÍ. Corriendo después de las 18:00 hora de México, esta
-- última pareja es la que se ponía roja de más. Todo revierte con el RAISE.
--
-- CORRIDO EL 22-AGO-2026 contra un Postgres 17.11 virgen con el andamio de CI
-- y las 154 migraciones aplicadas en orden. Salida REAL, copiada tal cual:
--
--   FECHAS_LOCALES_0161  mx_19=2026-12-31  utc_19=2027-01-01  difieren=t
--     vista_sin_current_date=t  vista_con_zona=t  vista_invoker=t  defaults_mx=4
--     vence_hoy_no_vencida=f  vencio_ayer_si=t
--
-- PENDIENTE DE CORRER CONTRA PRODUCCIÓN (escala 50k). Esperado:
--   FECHAS_LOCALES_0161  mx_19=2026-12-31  utc_19=2027-01-01  difieren=t
--                        vista_sin_current_date=t  vista_con_zona=t  vista_invoker=t
--                        defaults_mx=4  vence_hoy_no_vencida=f  vencio_ayer_si=t
do $$
declare
  t uuid; c uuid; hoy_mx date;
  mx_19 date; utc_19 date; difieren boolean;
  def_vista text; sin_current_date boolean; con_zona boolean; invoker boolean;
  defaults_mx int;
  f_hoy uuid; f_ayer uuid; vencida_hoy boolean; vencida_ayer boolean;
begin
  hoy_mx := (now() at time zone 'America/Mexico_City')::date;

  -- ── (a) El peor caso, escrito a mano ──────────────────────────────────
  mx_19  := (timestamptz '2027-01-01T01:00:00Z' at time zone 'America/Mexico_City')::date;
  utc_19 := (timestamptz '2027-01-01T01:00:00Z' at time zone 'UTC')::date;
  difieren := mx_19 <> utc_19;

  -- ── (b) La definición viva de la vista ────────────────────────────────
  def_vista := pg_get_viewdef('public.factura_saldo'::regclass, true);
  sin_current_date := def_vista not ilike '%current_date%';
  con_zona         := def_vista ilike '%America/Mexico_City%';
  -- La opción que un `create or replace view` descuidado borra (ver arriba).
  select coalesce('security_invoker=true' = any(reloptions), false) into invoker
    from pg_class where oid = 'public.factura_saldo'::regclass;

  -- ── (c) Los cuatro defaults ───────────────────────────────────────────
  select count(*) into defaults_mx
    from information_schema.columns
   where table_schema = 'public'
     and (table_name, column_name) in (
       ('factura_emitida', 'fecha'), ('pago_recibido', 'fecha'),
       ('tarifa', 'vigente_desde'), ('suscripcion', 'inicio'))
     and column_default ilike '%America/Mexico_City%';

  -- ── La semántica, con filas reales ────────────────────────────────────
  insert into public.tenant (nombre) values ('ZZZ VERIF 0161') returning id into t;
  insert into public.cliente (tenant_id, nombre) values (t, 'ZZZ VERIF 0161 CLIENTE') returning id into c;
  -- `fecha` explícita y anterior al vencimiento: el CHECK `factura_vence_despues`
  -- exige vence_en >= fecha, y sembrar con el default sería probar el default
  -- con el default.
  insert into public.factura_emitida (tenant_id, cliente_id, fecha, subtotal, iva, total, estatus, vence_en)
    values (t, c, hoy_mx - 30, 1000, 160, 1160, 'emitida', hoy_mx)
    returning id into f_hoy;
  insert into public.factura_emitida (tenant_id, cliente_id, fecha, subtotal, iva, total, estatus, vence_en)
    values (t, c, hoy_mx - 30, 1000, 160, 1160, 'emitida', hoy_mx - 1)
    returning id into f_ayer;

  select vencida into vencida_hoy  from public.factura_saldo where factura_id = f_hoy;
  select vencida into vencida_ayer from public.factura_saldo where factura_id = f_ayer;

  delete from public.tenant where id = t;

  raise exception E'FECHAS_LOCALES_0161  mx_19=%  utc_19=%  difieren=%  vista_sin_current_date=%  vista_con_zona=%  vista_invoker=%  defaults_mx=%  vence_hoy_no_vencida=%  vencio_ayer_si=%   (esperado 2026-12-31 / 2027-01-01 / t / t / t / t / 4 / f / t)',
    mx_19, utc_19, difieren, sin_current_date, con_zona, invoker, defaults_mx, vencida_hoy, vencida_ayer;
end $$;

-- ── 134. La consola cuenta en la base y Storage se limpia sin llevarse la evidencia (mig. 0162) ──
-- ESC-9 / ESC-11 / FE-8 / DAT-35. Cinco funciones nuevas, y de las cinco lo que
-- solo Postgres puede demostrar:
--
--   A · `senales_pmf` agrega bien y NO MEZCLA FLOTAS, con `p_tenant` y sin él.
--       El `<> 'superadmin'` es el que traduce el `.neq` de PostgREST: una
--       descarga SIN rol no cuenta como "por cliente" (NULL <> x es NULL).
--   B · `estado_rastreo_tenant` cuenta unidades DISTINTAS y toma el máximo,
--       de UNA flota.
--   C · `slo_agente_corrida` calcula el p95 por RANGO MÁS CERCANO
--       (`percentile_disc`), que es el mismo estadístico que hacía el JS —
--       `percentile_cont` habría movido la cifra del SLO. Con 20 duraciones
--       1..20 s, el p95 es 19, no 19.05.
--   D · `consumo_agentes` suma el gasto de 30 días y el subtotal de HOY por
--       separado, y `costo_usd` NULL (corridas anteriores a la 0123) suma 0.
--   E · `limpiar_storage_huerfano` — LA IMPORTANTE, porque un falso positivo
--       aquí DESTRUYE EVIDENCIA FISCAL (CFF art. 30: cinco años). Se siembran
--       diez objetos y se afirma cuáles cuatro se van y cuáles seis se quedan:
--         se van   · la foto de un viaje BORRADO
--                  · la foto de una flota BORRADA
--                  · el PDF `-operador` de un viaje borrado (a ese no lo
--                    nombra ninguna columna: es el que solo la estructura
--                    puede juzgar)
--                  · el informe de una flota borrada
--         se quedan· la foto de un viaje VIVO
--                  · una foto reciente (dentro de la gracia de 7 días) aunque
--                    su viaje no exista: `subirComprobante` sube ANTES de que
--                    exista la fila del gasto
--                  · la foto en `sin-viaje` de la sala de espera
--                  · la foto de un viaje borrado que `comprobante_huerfano`
--                    todavía nombra (su `viaje_id` es `on delete set null`)
--                  · el PDF que `liquidacion_historico` nombra (papel emitido)
--                  · EL INFORME DE UNA FLOTA VIVA — `informes/{tenant}/...`
--                    mete la flota en el SEGUNDO segmento, que es donde otras
--                    rutas traen el VIAJE: leerlo como viaje habría borrado
--                    todos los informes del producto de un golpe.
--   F · Ninguna de las cinco es ejecutable por `anon`.
--
-- OJO AL CORRERLO: `limpiar_storage_huerfano` barre `storage.objects` ENTERO
-- desde el cursor, así que en una base con muchos objetos tarda — y la tanda
-- de abajo es deliberadamente grande para que una sola pasada cubra los diez
-- sembrados. Todo revierte con el `raise` final.
--
-- Esperado:
--   PMF_STORAGE_0162  pmf_una=t  pmf_todas=t  pmf_sin_mezcla=t  demo_no_cuenta=t
--                     rastreo_n=2  rastreo_max=t  p95=19  consumo=t  storage_marcados=4
--                     viva=t  reciente=t  sin_viaje=t  espera=t  historico=t
--                     informe_vivo=t  anon=f
do $$
declare
  v_t uuid; v_t2 uuid; v_o uuid; v_v uuid; v_v2 uuid; v_u1 uuid; v_u2 uuid; v_u3 uuid;
  v_tf uuid := '00000000-0000-4000-8000-000000000162';   -- flota que NO existe
  v_vf uuid := '00000000-0000-4000-8000-000000000163';   -- viaje que NO existe
  v_liq uuid;
  res jsonb; fila jsonb;
  pmf_una boolean; pmf_todas boolean; pmf_sin_mezcla boolean; demo_no_cuenta boolean;
  rastreo_n int; rastreo_max boolean;
  p95 numeric; consumo_ok boolean;
  storage_borrados bigint; storage_borrados_sql bigint;
  queda_viva boolean; queda_reciente boolean; queda_sin_viaje boolean;
  queda_espera boolean; queda_historico boolean; queda_informe_vivo boolean;
  anon_ok boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0162 A') returning id into v_t;
  insert into tenant (nombre) values ('ZZZ VERIF 0162 B') returning id into v_t2;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'ZZZ op 0162', '5215500000162') returning id into v_o;
  insert into viaje (tenant_id, operador_id, estatus) values (v_t, v_o, 'liquidado') returning id into v_v;
  insert into viaje (tenant_id, operador_id, estatus) values (v_t, v_o, 'liquidado') returning id into v_v2;

  -- ═══ A · senales_pmf ═════════════════════════════════════════════════════
  -- Dos liquidaciones de la flota A: una descargada por el CONTADOR (señal
  -- real) y otra por SUPERADMIN (un demo de Javier: no es señal). Una tercera
  -- de la flota B, para que mezclar flotas se note.
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia,
                           primera_descarga_en, primera_descarga_rol)
    values (v_t, v_v, 0, 0, 0, now(), 'contador');
  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia,
                           primera_descarga_en, primera_descarga_rol)
    values (v_t, v_v2, 0, 0, 0, now(), 'superadmin');
  -- El viaje v_v cerró SIN recordatorio (el chofer comprobó solo); v_v2 con él.
  update viaje set recordatorio_comprobacion_en = now() where id = v_v2;

  fila := (select j from jsonb_array_elements(public.senales_pmf(v_t)) j
            where j->>'tenantId' = v_t::text);
  pmf_una := (fila->>'liquidaciones')::int = 2
         and (fila->>'descargadas')::int = 2
         and (fila->>'porCliente')::int = 1        -- el demo NO cuenta
         and (fila->>'liquidados')::int = 2
         and (fila->>'sinRecordatorio')::int = 1;
  demo_no_cuenta := (fila->>'descargadas')::int - (fila->>'porCliente')::int = 1;

  res := public.senales_pmf(null);
  pmf_todas := exists (select 1 from jsonb_array_elements(res) j where j->>'tenantId' = v_t::text);
  -- La flota B no tiene NI UNA fila en las tres tablas: no aparece. "No
  -- aparece" se lee como SIN DATOS, y por eso no puede salir con ceros.
  pmf_sin_mezcla := not exists (select 1 from jsonb_array_elements(res) j where j->>'tenantId' = v_t2::text);

  -- ═══ B · estado_rastreo_tenant ═══════════════════════════════════════════
  insert into unidad (tenant_id, numero_economico) values (v_t,  'ZZZ-0162-1') returning id into v_u1;
  insert into unidad (tenant_id, numero_economico) values (v_t,  'ZZZ-0162-2') returning id into v_u2;
  insert into unidad (tenant_id, numero_economico) values (v_t2, 'ZZZ-0162-3') returning id into v_u3;
  insert into posicion (tenant_id, unidad_id, lat, lng, medida_en, proveedor) values
    (v_t,  v_u1, 20, -100, now() - interval '2 hours', 'zzz'),
    (v_t,  v_u1, 20, -100, now() - interval '1 hour',  'zzz'),  -- misma unidad: NO cuenta dos
    (v_t,  v_u2, 20, -100, now() - interval '3 hours', 'zzz'),
    (v_t2, v_u3, 20, -100, now(),                      'zzz');  -- otra flota: no se mezcla
  res := public.estado_rastreo_tenant(v_t);
  rastreo_n := (res->>'unidadesConPosicion')::int;
  rastreo_max := (res->>'ultimaPosicion')::timestamptz < now() - interval '30 minutes';

  -- ═══ C y D · slo_agente_corrida y consumo_agentes ════════════════════════
  -- Veinte corridas de 1..20 segundos. p95 por rango más cercano = el valor
  -- en la posición ceil(20 * 0.95) = 19 → 19 s. Una de ellas en `fallo` y una
  -- con `costo_usd` NULL (corrida anterior a la 0123).
  insert into agente_corrida (tenant_id, agente, inicio, fin, estado, costo_usd)
  select v_t, 'liquidacion',
         now() - interval '1 day',
         now() - interval '1 day' + make_interval(secs => i),
         case when i = 20 then 'fallo' else 'ok' end,
         case when i = 1 then null else 0.01 end
    from generate_series(1, 20) i;
  res := public.slo_agente_corrida(now() - interval '30 days');
  -- `round` solo para que el mensaje diga «19» y no «19.000000»: el runner de
  -- CI compara el texto contra el `(esperado …)` de abajo, token por token.
  p95 := round((res->>'p95Segundos')::numeric);

  res := public.consumo_agentes(now() - interval '30 days', now() - interval '2 days');
  fila := (select j from jsonb_array_elements(res) j where j->>'agente' = 'liquidacion');
  consumo_ok := (fila->>'n')::int = 20
            and (fila->>'fallos')::int = 1
            -- 19 corridas × 0.01 (la primera trae NULL y suma 0)
            and abs((fila->>'g30')::numeric - 0.19) < 0.000001
            -- Todas empezaron hace 1 día, o sea DESPUÉS del corte de hace 2.
            and abs((fila->>'hoy')::numeric - 0.19) < 0.000001;

  -- ═══ E · limpiar_storage_huerfano ════════════════════════════════════════
  insert into storage.objects (bucket_id, name, created_at) values
    -- se QUEDAN
    ('comprobantes',  v_t::text  || '/' || v_v::text  || '/viva.jpg',      now() - interval '30 days'),
    ('comprobantes',  v_t::text  || '/' || v_vf::text || '/reciente.jpg',  now() - interval '1 day'),
    ('comprobantes',  v_t::text  || '/sin-viaje/espera.jpg',               now() - interval '30 days'),
    ('comprobantes',  v_t::text  || '/' || v_vf::text || '/en-espera.jpg', now() - interval '30 days'),
    ('liquidaciones', v_t::text  || '/' || v_vf::text || '.pdf',           now() - interval '30 days'),
    ('liquidaciones', 'informes/' || v_t::text || '/informe-vivo.pdf',     now() - interval '30 days'),
    -- se VAN
    ('comprobantes',  v_t::text  || '/' || v_vf::text || '/huerfana.jpg',  now() - interval '30 days'),
    ('comprobantes',  v_tf::text || '/' || v_vf::text || '/de-flota-muerta.jpg', now() - interval '30 days'),
    ('liquidaciones', v_t::text  || '/' || v_vf::text || '-operador.pdf',  now() - interval '30 days'),
    ('liquidaciones', 'informes/' || v_tf::text || '/informe-muerto.pdf',  now() - interval '30 days');

  -- Los dos cinturones: la sala de espera y el papel archivado.
  insert into comprobante_huerfano (tenant_id, operador_id, ruta_imagen, gasto, motivo)
    values (v_t, v_o, v_t::text || '/' || v_vf::text || '/en-espera.jpg', '{}'::jsonb, 'sin_viaje');
  insert into comprobante_huerfano (tenant_id, operador_id, ruta_imagen, gasto, motivo)
    values (v_t, v_o, v_t::text || '/sin-viaje/espera.jpg', '{}'::jsonb, 'sin_viaje');
  insert into liquidacion_historico (liquidacion_id, tenant_id, viaje_id, pdf_url)
    values (gen_random_uuid(), v_t, v_vf, v_t::text || '/' || v_vf::text || '.pdf');

  -- 23-AGO-2026 · SE LEE `marcados`, NO `borrados`. La 0165 cambió el contrato
  -- a propósito: Supabase prohíbe `delete from storage.objects` con un trigger,
  -- así que esta función dejó de BORRAR y pasó a MARCAR candidatos —devuelve
  -- `borrados: 0` fijo—. Este bloque es de la 0162 y seguía exigiendo 4
  -- borrados, así que llevaba desde entonces en rojo midiendo un contrato que
  -- ya no existe. El borrado real ocurre fuera de SQL, por la API, en
  -- `storage_borrado.ts` (que tiene sus propias pruebas).
  res := public.limpiar_storage_huerfano(7, 100000, now(), clock_timestamp() + interval '120 seconds');
  storage_borrados := (res->>'marcados')::bigint;
  -- Se reporta TAMBIÉN `borrados`, que la 0165 fija en 0: así el mensaje deja
  -- constancia explícita de que esta función ya no borra desde SQL, en vez de
  -- que haya que acordárselo. (Idea de la rama fix/panel-dueno-onboarding.)
  storage_borrados_sql := coalesce((res->>'borrados')::bigint, -1);

  select exists (select 1 from storage.objects where name = v_t::text || '/' || v_v::text || '/viva.jpg')
    into queda_viva;
  select exists (select 1 from storage.objects where name = v_t::text || '/' || v_vf::text || '/reciente.jpg')
    into queda_reciente;
  select exists (select 1 from storage.objects where name = v_t::text || '/sin-viaje/espera.jpg')
    into queda_sin_viaje;
  select exists (select 1 from storage.objects where name = v_t::text || '/' || v_vf::text || '/en-espera.jpg')
    into queda_espera;
  select exists (select 1 from storage.objects where name = v_t::text || '/' || v_vf::text || '.pdf')
    into queda_historico;
  select exists (select 1 from storage.objects where name = 'informes/' || v_t::text || '/informe-vivo.pdf')
    into queda_informe_vivo;

  -- ═══ F · nada de esto se ejecuta desde internet ══════════════════════════
  select has_function_privilege('anon', 'public.senales_pmf(uuid)', 'EXECUTE')
      or has_function_privilege('anon', 'public.estado_rastreo_tenant(uuid)', 'EXECUTE')
      or has_function_privilege('anon', 'public.consumo_agentes(timestamptz, timestamptz)', 'EXECUTE')
      or has_function_privilege('anon', 'public.slo_agente_corrida(timestamptz)', 'EXECUTE')
      or has_function_privilege('anon', 'public.limpiar_storage_huerfano(integer, integer, timestamptz, timestamptz)', 'EXECUTE')
    into anon_ok;

  raise exception E'PMF_STORAGE_0162  pmf_una=%  pmf_todas=%  pmf_sin_mezcla=%  demo_no_cuenta=%  rastreo_n=%  rastreo_max=%  p95=%  consumo=%  storage_marcados=%  storage_borrados=%  viva=%  reciente=%  sin_viaje=%  espera=%  historico=%  informe_vivo=%  anon=%   (esperado t / t / t / t / 2 / t / 19 / t / 4 / 0 / t / t / t / t / t / t / f)',
    pmf_una, pmf_todas, pmf_sin_mezcla, demo_no_cuenta, rastreo_n, rastreo_max,
    p95, consumo_ok, storage_borrados, storage_borrados_sql,
    queda_viva, queda_reciente, queda_sin_viaje, queda_espera, queda_historico, queda_informe_vivo,
    anon_ok;
end $$;

-- ── 135. El cobro de Stripe contra la base (mig. 0163) ──────────────────────
--
-- Los cuatro hallazgos de dinero de la auditoría 18 que la 0163 cierra, en un
-- solo bloque porque comparten el montaje —una flota, un plan, una factura— y
-- montarlo cuatro veces no diría nada nuevo. Cada clave del mensaje es un
-- hallazgo:
--
--   stripe_convive       DAT-12 · la factura de STRIPE y la mensualidad
--                        emitida A MANO del mismo mes conviven. Antes la de
--                        Stripe nacía con `metodo_cobro` en 'transferencia'
--                        (el default de la 0057), entraba al índice
--                        `factura_saas_una_por_periodo` y chocaba: 23505 →
--                        webhook 500 → Stripe reintenta hasta rendirse y el
--                        COBRO REAL nunca queda registrado.
--   metodo_incoherente_rebota
--                        DAT-12 · y ya no se puede volver a escribir la
--                        incoherencia: un `stripe_invoice_id` con método
--                        'transferencia' rebota contra el CHECK.
--   price_viejo_resuelve DAT-11 · subirle el precio a un plan NO huerfana a
--                        quien ya paga: el price anterior sigue sabiendo de
--                        qué plan era. Antes `planDePrice` devolvía null, el
--                        webhook lanzaba y a esa flota no se le aplicaba un
--                        solo evento más (ni el pago, ni la cancelación).
--   reserva_gana_una     DAT-13 · el compare-and-set del timbrado: dos
--                        intentos, UNA reserva. La segunda no llama al PAC,
--                        así que no hay dos CFDI reales que cancelar.
--   reserva_caducada_entra
--                        DAT-13 · y una reserva de hace 20 minutos (un
--                        intento que murió a media llamada) no deja la
--                        factura sin timbrar para siempre.
--   conciliar_gana_una   DAT-13 · el mismo candado en el pago: la segunda
--                        conciliación no toca fila, y por eso no dispara un
--                        segundo timbrado.
--   cancelado_sin_uuid_rebota
--                        DAT-33 · «CFDI cancelado» de un CFDI que nunca se
--                        timbró no existe.
--   anon_price           DAT-11 · `plan_price` decide de qué plan es un
--                        price: escribirlo desde internet sería cambiarse el
--                        propio precio.
--
-- Todo revierte con el RAISE final. PENDIENTE DE CORRER CONTRA PRODUCCIÓN
-- (auditoría 18, rubro datos). Esperado:
--   STRIPE_0163  stripe_convive=t  metodo_incoherente_rebota=t
--   price_viejo_resuelve=t  reserva_gana_una=t  reserva_caducada_entra=t
--   conciliar_gana_una=t  cancelado_sin_uuid_rebota=t  anon_price=f
do $$
declare
  v_t uuid; v_f uuid; v_plan text := 'zzz_verif_0163';
  stripe_convive boolean := false; metodo_incoherente_rebota boolean := false;
  price_viejo_resuelve boolean := false;
  reserva_gana_una boolean := false; reserva_caducada_entra boolean := false;
  conciliar_gana_una boolean := false; cancelado_sin_uuid_rebota boolean := false;
  anon_price boolean := false;
  n1 int; n2 int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0163') returning id into v_t;
  insert into plan (clave, nombre, stripe_price_id, precio_mensual, moneda, precio_iva_incluido, activo)
    values (v_plan, 'ZZZ 0163', 'price_zzz_viejo', 10000, 'MXN', true, false);

  -- ═══ DAT-12 · las dos formas de cobrar el mismo mes conviven ═════════════
  -- La manual: la que /admin emite con su referencia para transferir.
  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro, referencia)
    values (v_t, date '2026-08-01', date '2026-08-31', 11600, 'transferencia', 'LKZZZ202608')
    returning id into v_f;
  -- La de Stripe, MISMO periodo. Antes rebotaba contra `factura_saas_una_por_periodo`.
  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro, stripe_invoice_id)
      values (v_t, date '2026-08-01', date '2026-08-31', 11600, 'stripe', 'in_zzz_0163');
    stripe_convive := true;
  exception when others then stripe_convive := false;
  end;

  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro, stripe_invoice_id)
      values (v_t, date '2026-07-01', date '2026-07-31', 11600, 'transferencia', 'in_zzz_incoherente');
  exception when check_violation then metodo_incoherente_rebota := true;
  end;

  -- ═══ DAT-11 · el price viejo no se queda huérfano ════════════════════════
  insert into plan_price (stripe_price_id, plan_clave, precio_mensual, moneda, precio_iva_incluido)
    values ('price_zzz_viejo', v_plan, 10000, 'MXN', true);
  -- /admin liga un price NUEVO (subida de precio): el plan deja de apuntar al viejo.
  insert into plan_price (stripe_price_id, plan_clave, precio_mensual, moneda, precio_iva_incluido)
    values ('price_zzz_nuevo', v_plan, 12000, 'MXN', true);
  update plan_price set reemplazado_en = now() where stripe_price_id = 'price_zzz_viejo';
  update plan set stripe_price_id = 'price_zzz_nuevo', precio_mensual = 12000 where clave = v_plan;

  price_viejo_resuelve :=
    (select count(*) from plan where stripe_price_id = 'price_zzz_viejo') = 0
    and (select plan_clave from plan_price where stripe_price_id = 'price_zzz_viejo') = v_plan;

  -- ═══ DAT-13 · la reserva del timbrado ════════════════════════════════════
  update factura_saas set estado = 'pagada', pagada_en = now() where id = v_f;

  update factura_saas set timbrando_en = now()
   where id = v_f and cfdi_uuid is null
     and (timbrando_en is null or timbrando_en < now() - interval '10 minutes');
  get diagnostics n1 = row_count;
  update factura_saas set timbrando_en = now()
   where id = v_f and cfdi_uuid is null
     and (timbrando_en is null or timbrando_en < now() - interval '10 minutes');
  get diagnostics n2 = row_count;
  reserva_gana_una := (n1 = 1 and n2 = 0);

  -- El intento que murió a media llamada al PAC no bloquea para siempre.
  update factura_saas set timbrando_en = now() - interval '20 minutes' where id = v_f;
  update factura_saas set timbrando_en = now()
   where id = v_f and cfdi_uuid is null
     and (timbrando_en is null or timbrando_en < now() - interval '10 minutes');
  get diagnostics n1 = row_count;
  reserva_caducada_entra := (n1 = 1);

  -- ═══ DAT-13 · el mismo candado al conciliar ══════════════════════════════
  update factura_saas set estado = 'pendiente', pagada_en = null, timbrando_en = null where id = v_f;
  update factura_saas set estado = 'pagada', pagada_en = now(), referencia_banco = 'SPEI-1',
         conciliada_por = null, conciliada_en = null
   where id = v_f and estado <> 'pagada';
  get diagnostics n1 = row_count;
  update factura_saas set estado = 'pagada', pagada_en = now(), referencia_banco = 'SPEI-2'
   where id = v_f and estado <> 'pagada';
  get diagnostics n2 = row_count;
  conciliar_gana_una := (n1 = 1 and n2 = 0
    and (select referencia_banco from factura_saas where id = v_f) = 'SPEI-1');

  -- ═══ DAT-33 · no se cancela un papel que no existe ═══════════════════════
  begin
    update factura_saas set cfdi_cancelado_en = now() where id = v_f;
  exception when check_violation then cancelado_sin_uuid_rebota := true;
  end;

  -- ═══ DAT-11 · y el catálogo de precios no se escribe desde internet ══════
  begin
    set local role anon;
    begin
      insert into plan_price (stripe_price_id, plan_clave) values ('price_zzz_anon', v_plan);
      anon_price := true;
    exception when others then anon_price := false;
    end;
    reset role;
  exception when others then reset role; raise;
  end;

  raise exception E'STRIPE_0163  stripe_convive=%  metodo_incoherente_rebota=%  price_viejo_resuelve=%\n           reserva_gana_una=%  reserva_caducada_entra=%  conciliar_gana_una=%\n           cancelado_sin_uuid_rebota=%  anon_price=%   (esperado t / t / t / t / t / t / t / f)',
    stripe_convive, metodo_incoherente_rebota, price_viejo_resuelve,
    reserva_gana_una, reserva_caducada_entra, conciliar_gana_una,
    cancelado_sin_uuid_rebota, anon_price;
end $$;

-- ── 132. Los catálogos del panel se buscan por índice y el `%q%` no barre (mig. 0160) ──
-- FE-2 (CRÍTICO). `listOperadores` y los catálogos de cliente/unidad de
-- /dashboard/despacho no llevaban `.limit()`: PostgREST recortaba a 1,000 EN
-- SILENCIO y el chofer 1,001 no existía para el despacho. El tope ya vive en
-- el código (`buscarCatalogo`, tope 20); lo que sólo la base puede demostrar
-- es lo otro: que el `ilike '%q%'` que el combo dispara en cada tecla tiene
-- índice de trigramas y no es un barrido de la flota. Se comprueba que los
-- seis índices de la 0160 existan (tres parciales de arranque + tres GIN) y
-- que pg_trgm esté en `extensions`, que es de donde la opclass se nombra.
--
-- Un índice ausente NO revienta: la pantalla sigue correcta y sólo se pone
-- lenta — exactamente la clase de falla muda que este hallazgo vino a cerrar,
-- y por eso lleva bloque aunque sean "sólo" índices de velocidad.
--
-- Esperado:
--   CATALOGOS_0160  trgm_en_extensions=t  arranque=3  gin=3  op_parcial=t  uni_col=t
do $$
declare
  trgm_ext text; n_arranque int; n_gin int; op_parcial boolean; uni_col boolean;
begin
  select n.nspname into trgm_ext
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';

  select count(*) into n_arranque from pg_indexes
   where schemaname = 'public'
     and indexname in ('operador_catalogo_idx', 'cliente_catalogo_idx', 'unidad_catalogo_idx');

  select count(*) into n_gin from pg_indexes
   where schemaname = 'public'
     and indexname in ('operador_nombre_trgm_idx', 'cliente_nombre_trgm_idx', 'unidad_numero_economico_trgm_idx')
     and indexdef ilike '%gin%';

  -- El parcial `where activo` es la mitad del ahorro: sin él, ordenar por
  -- nombre vuelve a tocar a los choferes dados de baja.
  select coalesce(bool_or(indexdef ilike '%where activo%'), false) into op_parcial
    from pg_indexes where schemaname = 'public' and indexname = 'operador_catalogo_idx';

  -- La unidad se ordena y se busca por numero_economico, que es lo que la
  -- pantalla enseña — indexar `nombre` (que no existe) o cualquier otra
  -- columna dejaría el combo sin índice sin que nadie lo note.
  select coalesce(bool_or(indexdef ilike '%numero_economico%'), false) into uni_col
    from pg_indexes where schemaname = 'public' and indexname = 'unidad_numero_economico_trgm_idx';

  raise exception E'CATALOGOS_0160  trgm_en_extensions=%  arranque=%  gin=%  op_parcial=%  uni_col=%   (esperado t/3/3/t/t)',
    (coalesce(trgm_ext, 'FALTA') = 'extensions'), n_arranque, n_gin, op_parcial, uni_col;
end $$;

-- ── 136. El mismo comprobante no entra dos veces, ni por reproceso (mig. 0164) ──
--
-- AUDITORÍA PROD 22-ago-2026, DAT-01 (CRÍTICO) y DAT-37. En producción NINGÚN
-- gasto llevaba `img_hash`: el hash se calculaba tras `LIKIDA_DEDUP_FOTOS ===
-- '1'`, bandera que producción no tiene puesta, así que `uq_gasto_img_hash`
-- (0027) llevaba meses indexando el vacío. El código ya lo calcula siempre;
-- este bloque comprueba la llave NUEVA, la que cubre el caso que el hash no
-- puede cubrir: que el reintento seamos NOSOTROS.
--
-- Cada clave del mensaje es un hecho que sólo la base puede demostrar:
--
--   wamid_rebota          DAT-01 · dos gastos con el mismo wamid en la misma
--                         flota = el mismo mensaje reprocesado. El say()
--                         posterior al alta puede lanzar y el turno se
--                         reintenta con el mismo wamid: sin este índice, el
--                         diésel de $8,000 quedaba comprobado dos veces.
--   wamid_otra_flota      El índice es POR FLOTA. Dos flotas distintas no
--                         comparten espacio de wamid, y bloquear ahí sería
--                         un falso positivo entre clientes.
--   wamid_null_entra      Un gasto de alta manual (panel, importación,
--                         huérfano adjuntado) no tiene wamid, y los NULL no
--                         colisionan: el camino sin WhatsApp queda intacto.
--   huerfano_rebota       DAT-01 · la sala de espera guardaba el mismo papel
--                         N veces, y el «sí» del operador los adjuntaba
--                         todos. Ahora la segunda fila EN ESPERA rebota.
--   huerfano_resuelto_ok  El índice es parcial: un huérfano ya resuelto es
--                         historia y no puede impedir que el mismo papel
--                         vuelva a la sala de espera más adelante.
--   codigo_rebota         DAT-37 · el mismo acercamiento apuntado dos veces
--                         deja una fila que nunca empareja con nada.
--   codigo_otro_monto_ok  La llave es el CÓDIGO, no el monto: dos casetas del
--                         mismo importe son dos papeles distintos y las dos
--                         tienen que caber.
--
-- Todo revierte con el RAISE final. Esperado:
--   DEDUP_0164  wamid_rebota=t  wamid_otra_flota=t  wamid_null_entra=t
--   huerfano_rebota=t  huerfano_resuelto_ok=t  codigo_rebota=t
--   codigo_otro_monto_ok=t
do $$
declare
  v_t uuid; v_t2 uuid; v_o uuid; v_o2 uuid; v_v uuid; v_v2 uuid; v_h uuid;
  wamid_rebota boolean := false; wamid_otra_flota boolean := false;
  wamid_null_entra boolean := false; huerfano_rebota boolean := false;
  huerfano_resuelto_ok boolean := false; codigo_rebota boolean := false;
  codigo_otro_monto_ok boolean := false;
  k_wamid constant text := 'wamid.ZZZVERIF0164';
  k_hash  constant text := 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0164';
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0164 A') returning id into v_t;
  insert into tenant (nombre) values ('ZZZ VERIF 0164 B') returning id into v_t2;
  insert into operador (tenant_id, nombre, telefono) values (v_t,'P','5215500000164') returning id into v_o;
  insert into operador (tenant_id, nombre, telefono) values (v_t2,'Q','5215500001064') returning id into v_o2;
  insert into viaje (tenant_id, operador_id, anticipo) values (v_t, v_o, 9000) returning id into v_v;
  insert into viaje (tenant_id, operador_id, anticipo) values (v_t2, v_o2, 9000) returning id into v_v2;

  -- ═══ DAT-01 · el mismo mensaje, reprocesado ══════════════════════════════
  insert into gasto (tenant_id, viaje_id, concepto, monto, wa_message_id)
    values (v_t, v_v, 'diesel', 8000, k_wamid);
  begin
    -- El reproceso trae OTRO id de gasto y OTRO OCR: sin este índice, entra.
    insert into gasto (tenant_id, viaje_id, concepto, monto, wa_message_id)
      values (v_t, v_v, 'diesel', 8000, k_wamid);
  exception when unique_violation then wamid_rebota := true;
  end;

  -- ═══ Otra flota con el mismo wamid: NO es el mismo comprobante ═══════════
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, wa_message_id)
      values (v_t2, v_v2, 'diesel', 8000, k_wamid);
    wamid_otra_flota := true;
  exception when others then wamid_otra_flota := false;
  end;

  -- ═══ Sin wamid (alta manual): dos gastos, ningún choque ══════════════════
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'caseta', 100);
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'caseta', 100);
    wamid_null_entra := true;
  exception when others then wamid_null_entra := false;
  end;

  -- ═══ DAT-01 · la sala de espera no guarda el mismo papel dos veces ═══════
  insert into comprobante_huerfano (tenant_id, operador_id, gasto, motivo)
    values (v_t, v_o, jsonb_build_object('concepto','diesel','monto',8000,'imgHash',k_hash), 'sin_viaje')
    returning id into v_h;
  begin
    insert into comprobante_huerfano (tenant_id, operador_id, gasto, motivo)
      values (v_t, v_o, jsonb_build_object('concepto','diesel','monto',8000,'imgHash',k_hash), 'sin_viaje');
  exception when unique_violation then huerfano_rebota := true;
  end;

  -- Resuelto el primero, el mismo papel PUEDE volver a esperar: el operador
  -- que descartó por error y reenvía la foto no puede quedarse sin sala.
  update comprobante_huerfano set resuelto_en = now(), resolucion = 'descartado' where id = v_h;
  begin
    insert into comprobante_huerfano (tenant_id, operador_id, gasto, motivo)
      values (v_t, v_o, jsonb_build_object('concepto','diesel','monto',8000,'imgHash',k_hash), 'sin_viaje');
    huerfano_resuelto_ok := true;
  exception when others then huerfano_resuelto_ok := false;
  end;

  -- ═══ DAT-37 · un acercamiento = una fila en la bandeja de códigos ════════
  insert into codigo_pendiente (tenant_id, viaje_id, monto, folio_portal)
    values (v_t, v_v, 420, 'FOLIO-0164');
  begin
    insert into codigo_pendiente (tenant_id, viaje_id, monto, folio_portal)
      values (v_t, v_v, 420, 'FOLIO-0164');
  exception when unique_violation then codigo_rebota := true;
  end;

  -- Mismo monto, OTRO folio: son dos casetas iguales, y las dos tienen que caber.
  begin
    insert into codigo_pendiente (tenant_id, viaje_id, monto, folio_portal)
      values (v_t, v_v, 420, 'FOLIO-0164-BIS');
    codigo_otro_monto_ok := true;
  exception when others then codigo_otro_monto_ok := false;
  end;

  raise exception E'DEDUP_0164  wamid_rebota=%  wamid_otra_flota=%  wamid_null_entra=%  huerfano_rebota=%  huerfano_resuelto_ok=%  codigo_rebota=%  codigo_otro_monto_ok=%   (esperado t / t / t / t / t / t / t)',
    wamid_rebota, wamid_otra_flota, wamid_null_entra, huerfano_rebota,
    huerfano_resuelto_ok, codigo_rebota, codigo_otro_monto_ok;
end $$;

-- ── 137. El mantenimiento nocturno no se cae entero, y el barrido de Storage MARCA en vez de borrar (mig. 0165) ──
--
-- El 22-ago-2026 `mantenimiento_de_datos()` dejó de correr COMPLETO en
-- producción: la 0162 borraba con `delete from storage.objects` y Supabase lo
-- prohíbe con un trigger (`42501 · Direct deletion from storage tables is not
-- allowed`). Como las catorce purgas iban en fila, la que lanzó se llevó a las
-- que faltaban — incluidas las de PRIVACIDAD, que un aviso público promete.
--
-- Este bloque fija las dos garantías: (a) una purga que lanza NO tumba a las
-- demás y su nombre sale en `fallos`; (b) el barrido de Storage no borra, deja
-- candidatos en `storage_huerfano_candidato` para que el servidor los borre
-- por la Storage API. Todo revierte con el RAISE final.
do $$
declare
  res jsonb;
  sobrevive boolean;
  nombra_fallo boolean;
  candidatos_ok boolean;
  no_borra boolean;
  anon_ok boolean;
begin
  -- (a) una purga rota no se lleva a las demás: se rompe adrede la de posiciones
  -- `create or replace` NO puede renombrar los parámetros de una función que
  -- ya existe con nombres (p_dias, ...). Se respetan los nombres reales para
  -- que el bloque siga probando lo suyo —que una purga rota no se lleve a las
  -- demás— en vez de morir en el andamio.
  create or replace function public.purgar_posicion(p_dias integer default 90, p_ahora timestamptz default now(), p_vence timestamptz default null)
  returns jsonb language plpgsql as $roto$
  begin raise exception 'roto a proposito' using errcode = 'PU999'; end $roto$;

  res := public.mantenimiento_de_datos(30, now());
  -- las que corren DESPUÉS de posicion en el orden de la función
  sobrevive    := (res ? 'bitacoraPurgada') and (res ? 'cobranzaContactosPurgados')
                  and (res ? 'prospectoPersonasPurgadas');
  nombra_fallo := (res->'fallos')::text like '%posicion%';

  -- (b) el barrido deja candidatos y NO toca storage.objects
  candidatos_ok := res ? 'storageHuerfanoMarcado';
  no_borra := not exists (
    select 1 from pg_proc p
     where p.proname = 'limpiar_storage_huerfano'
       and pg_get_functiondef(p.oid) ~ 'delete\s+from\s+storage\.objects');

  -- 23-AGO-2026 · SE CORRIGE LO QUE MIDE. Antes preguntaba por el GRANT de
  -- SELECT a `anon`, y eso en Supabase es SIEMPRE verdadero: el proyecto
  -- concede `select` a `anon`/`authenticated` sobre todo `public` por defecto
  -- —se comprobó contra producción: las 80 tablas lo tienen— y la puerta real
  -- la cierra RLS. Preguntar por el grant hacía que este bloque reprobara para
  -- siempre por algo que no depende del repo, y un bloque que no puede pasar es
  -- un bloque que se acaba ignorando.
  --
  -- Lo que SÍ hay que exigir: que la tabla tenga RLS y que NINGUNA política le
  -- abra la puerta a `anon`. Con RLS activa y cero políticas, nadie lee — que
  -- es exactamente el estado de `storage_huerfano_candidato`: es una cola
  -- interna del mantenimiento, no un dato de nadie.
  anon_ok := has_function_privilege('anon', 'public.mantenimiento_de_datos(integer, timestamptz)', 'EXECUTE')
          or not exists (
               select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = 'storage_huerfano_candidato'
                  and c.relrowsecurity)
          or exists (
               select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'storage_huerfano_candidato'
                  and ('anon' = any(p.roles) or 'public' = any(p.roles)));

  raise exception E'MANTENIMIENTO_0165  sobrevive=%  nombra_fallo=%  candidatos=%  no_borra_storage=%  anon=%   (esperado t / t / t / t / f)',
    sobrevive, nombra_fallo, candidatos_ok, no_borra, anon_ok;
end $$;

-- ── 138. Una factura se identifica por SERIE + FOLIO + EJERCICIO (mig. 0166) ──
--
-- RES-22 (auditoría prod): `factura_folio_unico` (0049) era (tenant_id, folio)
-- y `factura_emitida_folio_upper_uidx` (0158) era (tenant_id, upper(folio)).
-- Ninguno miraba la serie ni el año, así que la A-1 de 2025 y la A-1 de 2026
-- —dos CFDI distintos, los dos timbrados— chocaban, y la flota que reinicia
-- folios cada 1 de enero (lo normal en México) no podía capturar su cobranza.
--
-- Esto es de las cosas que SOLO la base puede demostrar: es un índice único
-- sobre expresiones. Se ataca por los cuatro lados —el año, la serie, la
-- repetición real y la normalización— y además se comprueba que arreglar
-- RES-22 no REABRIÓ DAT-36 (0158: «a-1» y «A-1» siguen siendo el mismo folio)
-- y que el índice viejo de la 0158 ya no está duplicando el candado.
--
-- Corrido el 22-ago-2026 contra Postgres 17.11 con las 163 migraciones
-- aplicadas sobre base virgen. Salida REAL:
--   SERIE_0166  mismo-folio-otro-anio=t  otra-serie-mismo-anio=t
--               repetida-rebota=t  sin-serie-repetida-rebota=t
--               sin-serie-otro-anio=t  mayusculas-siguen-chocando=t
--               serie-con-espacios-rebota=t  serie-vacia-rebota=t
--               otra-flota-entra=t  indice-0158-retirado=t
do $$
declare
  ta uuid; tb uuid; cli uuid; clib uuid;
  mismo_folio_otro_anio boolean := false;
  otra_serie_mismo_anio boolean := false;
  repetida_rebota boolean := false;
  sin_serie_repetida_rebota boolean := false;
  sin_serie_otro_anio boolean := false;
  mayusculas_chocan boolean := false;
  serie_espacios_rebota boolean := false;
  serie_vacia_rebota boolean := false;
  otra_flota_entra boolean := false;
  indice_0158_retirado boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0166 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0166 B') returning id into tb;
  insert into cliente (tenant_id, nombre, rfc) values (ta, 'ZZZ cli 0166 A', 'XAXX010101000') returning id into cli;
  insert into cliente (tenant_id, nombre, rfc) values (tb, 'ZZZ cli 0166 B', 'XAXX010101000') returning id into clib;

  -- ── EL CASO DEL HALLAZGO: A-1 de 2025 y A-1 de 2026 son dos facturas ─────
  insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
    values (ta, cli, 'A', '1', date '2025-01-02', 1000, 160, 1160, 'emitida');
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, 'A', '1', date '2026-01-02', 1000, 160, 1160, 'emitida');
    mismo_folio_otro_anio := true;
  exception when others then mismo_folio_otro_anio := false;
  end;

  -- ── Y B-1 del MISMO año tampoco es la A-1: otra serie, otro consecutivo ──
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, 'B', '1', date '2026-01-02', 1000, 160, 1160, 'emitida');
    otra_serie_mismo_anio := true;
  exception when others then otra_serie_mismo_anio := false;
  end;

  -- ── LO QUE SÍ TIENE QUE REBOTAR: la MISMA A-1 del MISMO ejercicio ────────
  -- Aflojar el candado no puede significar quitarlo: dentro de una serie y de
  -- un año, el folio sigue siendo irrepetible. Otro día del mismo 2026 y otro
  -- monto, para que lo único compartido sea la llave.
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, 'A', '1', date '2026-11-30', 5000, 800, 5800, 'emitida');
  exception when unique_violation then
    repetida_rebota := position('factura_folio_unico' in sqlerrm) > 0;
  end;

  -- ── LA FLOTA SIN SERIES (todas las de hoy) sigue protegida ───────────────
  -- `coalesce(serie,'')`: un NULL no colisiona con nada en un índice único, y
  -- sin el coalesce estas dos filas se habrían colado.
  insert into factura_emitida (tenant_id, cliente_id, folio, fecha, subtotal, iva, total, estatus)
    values (ta, cli, 'SF-9', date '2026-03-01', 100, 16, 116, 'emitida');
  begin
    insert into factura_emitida (tenant_id, cliente_id, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, 'SF-9', date '2026-04-01', 100, 16, 116, 'emitida');
  exception when unique_violation then sin_serie_repetida_rebota := true;
  end;
  begin
    insert into factura_emitida (tenant_id, cliente_id, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, 'SF-9', date '2025-04-01', 100, 16, 116, 'emitida');
    sin_serie_otro_anio := true;
  exception when others then sin_serie_otro_anio := false;
  end;

  -- ── DAT-36 (0158) NO SE REABRIÓ ──────────────────────────────────────────
  -- El índice nuevo compara upper() en serie Y en folio. Si comparara el texto
  -- crudo, «a / x-1» y «A / X-1» volverían a ser dos facturas para la base y
  -- una sola para la flota — el hallazgo que la 0158 cerró.
  insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
    values (ta, cli, 'A', 'X-1', date '2026-05-01', 100, 16, 116, 'emitida');
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, 'a', 'x-1', date '2026-06-01', 100, 16, 116, 'emitida');
  exception when unique_violation then mayusculas_chocan := true;
  end;

  -- ── La serie se guarda tal como se compara (`factura_serie_btrim`) ───────
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, ' C ', '7', date '2026-07-01', 100, 16, 116, 'emitida');
  exception when check_violation then
    serie_espacios_rebota := position('factura_serie_btrim' in sqlerrm) > 0;
  end;
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (ta, cli, '', '8', date '2026-07-01', 100, 16, 116, 'emitida');
  exception when check_violation then serie_vacia_rebota := true;
  end;

  -- ── El consecutivo es DE CADA FLOTA ─────────────────────────────────────
  begin
    insert into factura_emitida (tenant_id, cliente_id, serie, folio, fecha, subtotal, iva, total, estatus)
      values (tb, clib, 'A', '1', date '2026-01-02', 1000, 160, 1160, 'emitida');
    otra_flota_entra := true;
  exception when others then otra_flota_entra := false;
  end;

  -- ── Y el candado viejo de la 0158 ya no está encima ──────────────────────
  -- Si sobreviviera, seguiría rechazando la A-1 de 2026 y todo lo de arriba
  -- sería teatro: el arreglo tenía que sustituir a LOS DOS índices.
  indice_0158_retirado := not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'factura_emitida_folio_upper_uidx');

  raise exception E'SERIE_0166  mismo-folio-otro-anio=%  otra-serie-mismo-anio=%  repetida-rebota=%  sin-serie-repetida-rebota=%  sin-serie-otro-anio=%  mayusculas-siguen-chocando=%  serie-con-espacios-rebota=%  serie-vacia-rebota=%  otra-flota-entra=%  indice-0158-retirado=%   (esperado t / t / t / t / t / t / t / t / t / t)',
    mismo_folio_otro_anio, otra_serie_mismo_anio, repetida_rebota,
    sin_serie_repetida_rebota, sin_serie_otro_anio, mayusculas_chocan,
    serie_espacios_rebota, serie_vacia_rebota, otra_flota_entra,
    indice_0158_retirado;
end $$;

-- ── 139. `updated_at` dice la verdad y un toque sella a su prospecto (mig. 0167) ──
--
-- El delta del Cerebro de ventas (FE-16) pregunta `updated_at > marca`. Esa
-- pregunta solo sirve si la columna se mueve cuando la fila cambia, y hasta la
-- 0167 NO se movía: `default now()` en el insert y nadie la tocaba después.
-- Medido en producción el 22-ago-2026, antes de aplicar la migración:
--
--     select count(*) filter (where updated_at > created_at + interval '1 second')
--     from prospecto;   →   0     (de 33,071 filas)
--
-- Un mapa que contesta "nada cambió" mientras el embudo avanza se ve
-- EXACTAMENTE IGUAL que un mapa al día — por eso esto se comprueba contra la
-- base y no con un mock. Tres garantías: (a) cualquier update sella la hora;
-- (b) el valor que mande el llamador NO gana (un reloj de cliente adelantado
-- escondería la fila de todas las lecturas siguientes); (c) insertar un toque
-- —que vive en OTRA tabla— también sella al prospecto, o el filtro "sin
-- contactar en N días" nunca llegaría a los demás Cerebros abiertos.
-- Todo revierte con el RAISE final.
do $$
declare
  v_p uuid;
  t_alta timestamptz;
  t_update timestamptz;
  t_toque timestamptz;
  sella_update boolean;
  ignora_valor_ajeno boolean;
  toque_sella boolean;
  indice_ok boolean;
begin
  insert into prospecto (empresa, fuente, estado)
    values ('VERIF-0167 SA de CV', 'manual', 'nuevo')
    returning id, updated_at into v_p, t_alta;

  -- (a) y (b) a la vez: se le manda a propósito una hora del año 2000 y el
  -- trigger tiene que ignorarla y poner la de la base.
  update prospecto set estado = 'contactado', updated_at = '2000-01-01T00:00:00Z' where id = v_p;
  select updated_at into t_update from prospecto where id = v_p;
  sella_update       := t_update > t_alta;
  ignora_valor_ajeno := t_update > '2020-01-01T00:00:00Z'::timestamptz;

  -- (c) el toque vive en prospecto_toque y aun así mueve la marca del padre.
  insert into prospecto_toque (prospecto_id, canal, actor)
    values (v_p, 'whatsapp', gen_random_uuid());
  select updated_at into t_toque from prospecto where id = v_p;
  toque_sella := t_toque > t_update;

  indice_ok := exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'prospecto'
       and indexname = 'idx_prospecto_updated_at');

  raise exception E'DELTA_PROSPECTO_0167  sella_update=%  ignora_valor_ajeno=%  toque_sella=%  indice=%   (esperado t / t / t / t)',
    sella_update, ignora_valor_ajeno, toque_sella, indice_ok;
end $$;

-- ── 140. `tenant.perfil` sella su historial con TRIGGER, no por convención (mig. 0169) ──
--
-- FASE 3 (docs/asistencia/PLAN-FASES.md, docs/perfil/PERFIL-OPERATIVO.md):
-- consolidar el perfil del cliente exige poder decir CUÁNDO cambió y QUIÉN lo
-- cambió — `actualizarFacilidad15` (código existente) ya escribe sin bitácora
-- y nadie lo notó, y ese es el patrón de bug que este trigger existe para no
-- repetir. Se prueba contra la base real, no contra un mock: un UPDATE de
-- `perfil` sella una fila en `tenant_perfil_version` con quien lo hizo
-- (`perfil_actualizado_por`, viaja en el MISMO statement — el trigger no
-- tiene otra forma de saberlo); un segundo UPDATE con el MISMO valor NO
-- ensucia el historial (`is distinct from`); y la fila ya sellada sobrevive
-- al borrado de su `app_user` con la referencia en NULL (`on delete set
-- null`, no se pierde el rastro de que ALGUIEN lo cambió aunque ya no
-- sepamos quién).
do $$
declare
  v_tenant uuid;
  v_user uuid;
  n_antes bigint;
  n_tras_cambio bigint;
  n_tras_no_cambio bigint;
  quien_sello_bien boolean;
  sobrevive_al_borrado boolean;
begin
  insert into tenant (nombre, plan) values ('VERIF-0169 SA de CV', 'demo') returning id into v_tenant;
  insert into app_user (id, tenant_id, email, rol)
    values (gen_random_uuid(), v_tenant, 'verif-0169@likida.test', 'flota_admin')
    returning id into v_user;

  select count(*) into n_antes from tenant_perfil_version where tenant_id = v_tenant;

  update tenant
    set perfil = '{"ingresosAnualesMxn":{"valor":1,"procedencia":"declarado"}}'::jsonb,
        perfil_actualizado_por = v_user
    where id = v_tenant;
  select count(*) into n_tras_cambio from tenant_perfil_version where tenant_id = v_tenant;
  select (actualizado_por = v_user) into quien_sello_bien
    from tenant_perfil_version where tenant_id = v_tenant order by created_at desc limit 1;

  -- MISMO valor: is distinct from tiene que verlo como "sin cambio".
  update tenant
    set perfil = '{"ingresosAnualesMxn":{"valor":1,"procedencia":"declarado"}}'::jsonb
    where id = v_tenant;
  select count(*) into n_tras_no_cambio from tenant_perfil_version where tenant_id = v_tenant;

  delete from app_user where id = v_user;
  select (actualizado_por is null) into sobrevive_al_borrado
    from tenant_perfil_version where tenant_id = v_tenant order by created_at desc limit 1;

  raise exception E'PERFIL_VERSION_0169  antes=%  tras_cambio=%  quien_sello_bien=%  tras_no_cambio=%  sobrevive_al_borrado=%   (esperado 0 / 1 / t / 1 / t)',
    n_antes, n_tras_cambio, quien_sello_bien, n_tras_no_cambio, sobrevive_al_borrado;
end $$;
-- ── 141. 0170 · la función definer de la 0167 ya no la ejecuta cualquiera ──
--
-- La 0167 creó `prospecto_toque_marca_prospecto()` como `security definer` y
-- olvidó revocarle los permisos por defecto. En Postgres una función nace con
-- EXECUTE para PUBLIC, y `anon` está en PUBLIC: quedó una función definer al
-- alcance de la llave anónima. La 0170 la cierra.
--
-- Esperado: PU170  es_definer=t  anon=f  authenticated=f  public=f  trigger_vivo=t
do $$
declare
  es_definer boolean; anon_ok boolean; auth_ok boolean; public_ok boolean; trigger_vivo boolean;
begin
  select p.prosecdef into es_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'prospecto_toque_marca_prospecto';

  anon_ok   := has_function_privilege('anon',          'public.prospecto_toque_marca_prospecto()', 'execute');
  auth_ok   := has_function_privilege('authenticated', 'public.prospecto_toque_marca_prospecto()', 'execute');
  public_ok := has_function_privilege('public',        'public.prospecto_toque_marca_prospecto()', 'execute');

  -- Revocar no debe romper el trigger: lo corre el dueño de la tabla.
  trigger_vivo := exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'prospecto_toque' and t.tgname = 'trg_toque_marca_prospecto');

  raise exception E'PU170  es_definer=%  anon=%  authenticated=%  public=%  trigger_vivo=%   (esperado t / f / f / f / t)',
    es_definer, anon_ok, auth_ok, public_ok, trigger_vivo;
end $$;

-- ── 142. 0171 · `gasto.descuento`, la base del estímulo de peaje ───────────
--
-- El 50% de peaje se calculaba sobre `sub_total` íntegro aunque el CFDI
-- trajera `@Descuento`. La columna existe, acepta NULL (el CFDI no lo trae),
-- rechaza negativos, y NO tiene default: una base fiscal no se rellena sola.
--
-- Esperado: DESCUENTO_0171  existe=t  nullable=t  sin_default=t  guarda=102000.00
--                           rechaza_negativo=t  cero_entra=t
do $$
declare
  ta uuid; oa uuid; va uuid;
  existe boolean; nullable boolean; sin_default boolean;
  guardado numeric; rechaza_negativo boolean := false; cero_entra boolean := false;
begin
  select true, (a.attnotnull = false), (d.adbin is null)
    into existe, nullable, sin_default
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where c.relname = 'gasto' and a.attname = 'descuento' and a.attnum > 0;

  insert into tenant (nombre) values ('ZZZ VERIF 0170') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'P', '+520000017001') returning id into oa;
  insert into viaje (tenant_id, operador_id) values (ta, oa) returning id into va;

  insert into gasto (tenant_id, viaje_id, concepto, monto, sub_total, descuento)
    values (ta, va, 'caseta', 139200, 120000, 18000);
  select sub_total - descuento into guardado from gasto where tenant_id = ta and descuento is not null;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, sub_total, descuento)
      values (ta, va, 'caseta', 100, 100, -1);
  exception when check_violation then rechaza_negativo := true;
  end;

  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto, sub_total, descuento)
      values (ta, va, 'caseta', 100, 100, 0);
    cero_entra := true;
  exception when others then cero_entra := false;
  end;

  raise exception E'DESCUENTO_0171  existe=%  nullable=%  sin_default=%  guarda=%  rechaza_negativo=%  cero_entra=%   (esperado t / t / t / 102000.00 / t / t)',
    existe, nullable, sin_default, guardado, rechaza_negativo, cero_entra;
end $$;

-- ── 143. NINGÚN RPC agregado ve datos de otra flota (prueba adversarial) ──
--
-- P0 de la auditoría externa (23-ago-2026): las "pruebas de equivalencia SQL"
-- de `comercial_equivalencia.test.ts` comparan la reducción JS vieja contra un
-- ESPEJO EN TYPESCRIPT del RPC (`espejo_0152.pruebas.ts`) — no ejecutan una
-- línea de SQL. Quitarle `where tenant_id = p_tenant` a una función dejaba
-- miles de pruebas en verde. Eso es falsa confianza, y este bloque existe para
-- que deje de serlo.
--
-- CÓMO ATACA, y por qué no hace falta escribir un caso por función: se siembran
-- DOS flotas con datos equivalentes, se pide cada RPC con `p_tenant = A` y se
-- guarda el hash del resultado; luego se BORRA todo lo de B y se vuelve a
-- pedir. Si algún hash cambia, esa función estaba leyendo del vecino. La lista
-- se descubre del catálogo (`pg_proc`), así que un RPC nuevo entra a la prueba
-- solo — no hay que acordarse de añadirlo.
--
-- Esperado: AISLAMIENTO_RPC  probados=>=15  contaminados=—  vacios_ambos=—
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; va uuid; vb uuid;
  ca uuid; cb uuid; fa uuid; fb uuid;
  f record;
  h_antes text; h_despues text;
  contaminados text := '';
  sin_datos text := '';
  probados int := 0;
  caza_la_fuga boolean;
begin
  -- ── Dos flotas con la misma forma de datos ───────────────────────────────
  insert into tenant (nombre) values ('ZZZ AISLA A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ AISLA B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (ta,'OA','+520000014301') returning id into oa;
  insert into operador (tenant_id, nombre, telefono) values (tb,'OB','+520000014302') returning id into ob;

  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, origen, destino)
    values (ta, oa, 'ZZZ-A-1','liquidado', current_date - 3, 5000,'CDMX','GDL') returning id into va;
  insert into viaje (tenant_id, operador_id, folio, estatus, fecha_inicio, anticipo, origen, destino)
    values (tb, ob, 'ZZZ-B-1','liquidado', current_date - 3, 9999,'MTY','QRO') returning id into vb;

  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, folio, sub_total, forma_pago)
    values (ta, va,'diesel', 1500, current_date - 2,'GA-1', 1293.10,'04'),
           (ta, va,'caseta',  300, current_date - 2,'CA-1',  258.62,'04'),
           (tb, vb,'diesel', 7777, current_date - 2,'GB-1', 6704.31,'04'),
           (tb, vb,'caseta',  888, current_date - 2,'CB-1',  765.52,'04');

  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus)
    values (ta, va, 1800, 5000, 3200,'con_diferencias'), (tb, vb, 8665, 9999, 1334,'con_diferencias');

  insert into cliente (tenant_id, nombre) values (ta,'CA') returning id into ca;
  insert into cliente (tenant_id, nombre) values (tb,'CB') returning id into cb;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total)
    values (ta, ca, 10000, 1600, 11600) returning id into fa;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total)
    values (tb, cb, 90000, 14400, 104400) returning id into fb;
  insert into pago_recibido (tenant_id, factura_id, monto)
    values (ta, fa, 1000), (tb, fb, 9000);

  insert into incidencia (tenant_id, viaje_id, tipo) values (ta, va,'averia'), (tb, vb,'averia');
  insert into llm_costo (tenant_id, viaje_id, fase, modelo)
    values (ta, va,'ocr','m'), (tb, vb,'ocr','m');

  -- ── 1ª pasada: con B poblado ─────────────────────────────────────────────
  create temp table _hashes (fn text primary key, h text) on commit drop;
  for f in
    select p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and pg_get_function_identity_arguments(p.oid) like 'p_tenant uuid%'
       and p.provolatile in ('s','i')
       and p.pronargs - p.pronargdefaults <= 1
     order by 1
  loop
    begin
      execute format(
        'select md5(coalesce(string_agg(t::text, ''|'' order by t::text), ''SIN_FILAS'')) from %I($1) t',
        f.fn) into h_antes using ta;
      insert into _hashes values (f.fn, h_antes);
    exception when others then
      -- Una función que no se deja llamar así no se prueba, pero se NOMBRA:
      -- callar aquí sería repetir el pecado que este bloque viene a corregir.
      sin_datos := sin_datos || f.fn || ' ';
    end;
  end loop;

  -- ── Se borra TODO lo de la flota B ───────────────────────────────────────
  delete from llm_costo   where tenant_id = tb;
  delete from incidencia  where tenant_id = tb;
  delete from pago_recibido   where tenant_id = tb;
  delete from factura_emitida where tenant_id = tb;
  delete from cliente     where tenant_id = tb;
  delete from liquidacion where tenant_id = tb;
  delete from gasto       where tenant_id = tb;
  delete from viaje       where tenant_id = tb;
  delete from operador    where tenant_id = tb;

  -- ── 2ª pasada: lo de A no puede haber cambiado ───────────────────────────
  for f in select fn, h from _hashes order by fn loop
    execute format(
      'select md5(coalesce(string_agg(t::text, ''|'' order by t::text), ''SIN_FILAS'')) from %I($1) t',
      f.fn) into h_despues using ta;
    probados := probados + 1;
    if h_despues is distinct from f.h then
      contaminados := contaminados || f.fn || ' ';
    end if;
  end loop;

  -- ── FALSIFICACIÓN: se le quita el filtro de tenant a un RPC y se comprueba
  --    que este mismo bloque lo caza. Una prueba de aislamiento que no sabe
  --    fallar no prueba nada — es justo el pecado que este bloque corrige.
  execute $f$
    create or replace function public.gasto_por_concepto_tenant(p_tenant uuid)
    returns jsonb language sql stable parallel safe set search_path to 'public','pg_catalog'
    as $roto$
      select coalesce(jsonb_agg(jsonb_build_object('concepto', concepto, 'n', n, 'total', total)
             order by total desc, concepto), '[]'::jsonb)
      from (select coalesce(concepto,'otro') as concepto, count(*) as n, coalesce(sum(monto),0) as total
              from gasto group by 1) t;
    $roto$;
  $f$;
  -- B quedó vacía tras el borrado: se le devuelve un gasto para que HAYA algo
  -- ajeno que la función sin filtro pueda sumar.
  insert into operador (tenant_id, nombre, telefono) values (tb,'OB2','+520000014303') returning id into ob;
  insert into viaje (tenant_id, operador_id) values (tb, ob) returning id into vb;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, folio)
    values (tb, vb, 'diesel', 4242, current_date - 1, 'FUGA-B');
  execute 'select md5(coalesce(string_agg(t::text, ''|'' order by t::text), ''SIN_FILAS'')) from gasto_por_concepto_tenant($1) t'
    into h_despues using ta;
  select h into h_antes from _hashes where fn = 'gasto_por_concepto_tenant';
  caza_la_fuga := (h_despues is distinct from h_antes);

  raise exception E'AISLAMIENTO_RPC  probados=%  contaminados=%  no_probados=%  FALSIFICADO (sin filtro de tenant): caza_la_fuga=%   (esperado >=15 / — / —)',
    probados,
    coalesce(nullif(trim(contaminados), ''), '—'),
    coalesce(nullif(trim(sin_datos), ''), '—'),
    caza_la_fuga;
end $$;

-- ── 144. ARCO separa oposición/cancelación y conserva evidencia fiscal (migs. 0173 + 0178) ──
--
-- P0-6 de la auditoría externa: `solicitud_arco` sólo registraba. Ahora
-- `ejecutar_arco_cancelacion` anonimiza al titular y borra sólo lo conversacional.
-- La 0178 corrige el comportamiento previo: una imagen de gasto/CFDI NO se manda
-- a Storage; queda retenida por CFF art. 30. Además, oposición no es cancelación:
-- la primera exige revisión humana y no toca identidad ni evidencia fiscal.
--
-- Esperado: ARCO_0178  ok=t  seudonimo=t  tel_fuera=t  wa_fuera=0  foto_en_cola=0
--                      gasto_vive=1  cfdi_vive=t  evidencia=t  cerrada=t
--                      otra_flota_rebota=t  acceso_rebota=t  oposicion_no_cancela=t
--                      oposicion_revision=t  retencion_fiscal=t
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; va uuid; sa uuid; sb uuid; s_acc uuid; s_opp uuid;
  conv uuid; g_id uuid;
  r jsonb;
  ok boolean; seudonimo_ok boolean; tel_fuera boolean;
  wa_quedan int; foto_en_cola int; gasto_vive int; cfdi_vive boolean;
  evidencia_ok boolean; cerrada boolean;
  otra_flota_rebota boolean; acceso_rebota boolean; oposicion_no_cancela boolean;
  oposicion_revision boolean; retencion_fiscal boolean;
begin
  insert into tenant (nombre) values ('ZZZ ARCO A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ ARCO B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (ta,'Juan Perez','+520000017301') returning id into oa;
  insert into operador (tenant_id, nombre, telefono) values (tb,'Otro','+520000017302') returning id into ob;
  insert into viaje (tenant_id, operador_id) values (ta, oa) returning id into va;

  -- Un gasto CON CFDI: es contabilidad, tiene que sobrevivir.
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, cfdi_uuid, imagen_url)
    values (ta, va,'diesel', 1000, current_date - 1, 'zzz-arco-cfdi-1',
            'https://x.supabase.co/storage/v1/object/public/comprobantes/ta/foto-arco.jpg')
    returning id into g_id;

  -- La defensa de Storage también clasifica por referencia viva: aunque un
  -- llamador intente ofrecer la foto como operativa, el trigger la retiene.
  insert into storage_huerfano_candidato (bucket, nombre, motivo, clase_retencion)
    values ('comprobantes', 'ta/foto-arco.jpg', 'verificacion_0178', 'operativa')
  returning clase_retencion = 'fiscal_cff_30' into retencion_fiscal;

  -- Conversación de WhatsApp: es sólo suya, se va.
  insert into wa_conversacion (tenant_id, operador_id, telefono) values (ta, oa,'+520000017301') returning id into conv;

  insert into solicitud_arco (tenant_id, operador_id, tipo, canal, vence_en)
    values (ta, oa,'cancelacion','whatsapp', current_date + 15) returning id into sa;
  insert into solicitud_arco (tenant_id, operador_id, tipo, canal, vence_en)
    values (tb, ob,'cancelacion','whatsapp', current_date + 15) returning id into sb;
  insert into solicitud_arco (tenant_id, operador_id, tipo, canal, vence_en)
    values (ta, oa,'acceso','whatsapp', current_date + 15) returning id into s_acc;
  insert into solicitud_arco (tenant_id, operador_id, tipo, canal, vence_en)
    values (tb, ob,'oposicion','whatsapp', current_date + 15) returning id into s_opp;

  r := public.ejecutar_arco_cancelacion(ta, sa);
  ok := (r->>'ok')::boolean;

  select nombre like 'Operador %', telefono like 'anon:%' into seudonimo_ok, tel_fuera
    from operador where id = oa;
  select count(*) into wa_quedan from wa_conversacion where operador_id = oa;
  select count(*) into foto_en_cola from storage_huerfano_candidato
    where motivo = 'arco' and nombre like '%foto-arco.jpg';

  -- LA CONTABILIDAD SIGUE AHÍ: el gasto y su CFDI no son datos del chofer.
  select count(*) into gasto_vive from gasto where id = g_id;
  select cfdi_uuid = 'zzz-arco-cfdi-1' into cfdi_vive from gasto where id = g_id;

  select evidencia is not null and evidencia ? 'operador_anonimizado'
         and evidencia ? 'evidencia_fiscal_retenida',
         estado = 'resuelta' and resuelta_en is not null and ejecutada_en is not null
    into evidencia_ok, cerrada
    from solicitud_arco where id = sa;

  -- La solicitud de OTRA flota no existe para esta llamada.
  otra_flota_rebota := not ((public.ejecutar_arco_cancelacion(ta, sb))->>'ok')::boolean;
  -- Un ACCESO no se ejecuta solo: lo contesta una persona.
  acceso_rebota := not ((public.ejecutar_arco_cancelacion(ta, s_acc))->>'ok')::boolean;
  -- Una OPOSICIÓN tampoco pasa por cancelación; queda en revisión humana.
  oposicion_no_cancela := not ((public.ejecutar_arco_cancelacion(tb, s_opp))->>'ok')::boolean;
  r := public.ejecutar_arco_oposicion(tb, s_opp);
  select (r->>'ok')::boolean and estado = 'en_proceso'
         and coalesce((evidencia->>'oposicion_automatizada_vigente')::boolean, false)
    into oposicion_revision
    from solicitud_arco where id = s_opp;

  raise exception E'ARCO_0178  ok=%  seudonimo=%  tel_fuera=%  wa_fuera=%  foto_en_cola=%  gasto_vive=%  cfdi_vive=%  evidencia=%  cerrada=%  otra_flota_rebota=%  acceso_rebota=%  oposicion_no_cancela=%  oposicion_revision=%  retencion_fiscal=%   (esperado t / t / t / 0 / 0 / 1 / t / t / t / t / t / t / t / t)',
    ok, seudonimo_ok, tel_fuera, wa_quedan, foto_en_cola, gasto_vive, cfdi_vive,
    evidencia_ok, cerrada, otra_flota_rebota, acceso_rebota, oposicion_no_cancela,
    oposicion_revision, retencion_fiscal;
end $$;

-- ── 210. La cancelación ARCO también anonimiza el RFC y la licencia del operador (mig. 0262) ──
--
-- LEG-C2 (auditoría E.28): `ejecutar_arco_cancelacion` anonimizaba nombre y
-- teléfono pero dejaba intactos `operador.rfc` (0080) y `licencia`/
-- `licencia_tipo`/`licencia_vence` (0053) — un descuido de alcance en el
-- UPDATE de 0178, no una decisión: esas columnas son ANTERIORES a 0178 y
-- nunca se auditó el esquema completo de `operador` al escribirlo. 0262
-- añade las cuatro al mismo UPDATE. Este bloque prueba justo eso: un
-- operador con RFC y licencia capturados, tras la cancelación, sale con las
-- cuatro columnas en NULL — sin tocar la evidencia fiscal ya emitida
-- (gasto/CFDI), que sigue viva por el mismo bloque de arriba.
--
-- Esperado: ARCO_0262  ok=t  rfc_fuera=t  licencia_fuera=t  tipo_fuera=t  vence_fuera=t  seudonimo=t
do $$
declare
  ta uuid; oa uuid; sa uuid;
  r jsonb;
  ok boolean;
  rfc_fuera boolean; licencia_fuera boolean; tipo_fuera boolean; vence_fuera boolean; seudonimo_ok boolean;
begin
  insert into tenant (nombre) values ('ZZZ ARCO 0262') returning id into ta;
  insert into operador (tenant_id, nombre, telefono, rfc, licencia, licencia_tipo, licencia_vence)
    values (ta, 'Juan Perez', '+520000017303', 'XAXX010101000', 'B12345678', 'B', current_date + 365)
    returning id into oa;

  insert into solicitud_arco (tenant_id, operador_id, tipo, canal, vence_en)
    values (ta, oa, 'cancelacion', 'whatsapp', current_date + 15) returning id into sa;

  r := public.ejecutar_arco_cancelacion(ta, sa);
  ok := (r->>'ok')::boolean;

  select rfc is null, licencia is null, licencia_tipo is null, licencia_vence is null,
         nombre like 'Operador %'
    into rfc_fuera, licencia_fuera, tipo_fuera, vence_fuera, seudonimo_ok
    from operador where id = oa;

  raise exception E'ARCO_0262  ok=%  rfc_fuera=%  licencia_fuera=%  tipo_fuera=%  vence_fuera=%  seudonimo=%   (esperado t / t / t / t / t / t)',
    ok, rfc_fuera, licencia_fuera, tipo_fuera, vence_fuera, seudonimo_ok;
end $$;

-- ── 145. Un centavo de redondeo no es una diferencia del operador (mig. 0174) ──
--
-- `stats_operador_tenant` (0150) declara en su propio comentario que «centavos
-- de redondeo no son una conversación», y filtraba con `abs(diferencia) >= 0.01`.
-- Ese umbral no excluía NADA: `liquidacion.diferencia` es `numeric(12,2)`, así
-- que cualquier valor distinto de cero ya vale ≥ 0.01 — medio centavo se
-- redondea a un centavo AL GUARDARSE y cruzaba el filtro. Un operador cuya
-- liquidación cuadró salvo por el IVA aparecía con una diferencia a su nombre.
--
-- La 0174 sube el umbral a `> 0.01`: más de un centavo. Este bloque prueba las
-- dos orillas — que el centavo NO cuente y que dos centavos SÍ.
--
-- Esperado: REDONDEO_0174  columna_2dec=t  centavo_no_cuenta=0  dos_centavos_cuentan=1
--                          real_cuenta=1  invoker=t  anon=f
do $$
declare
  ta uuid; o1 uuid; o2 uuid; o3 uuid; v1 uuid; v2 uuid; v3 uuid;
  j jsonb;
  columna_2dec boolean; centavo int; dos_centavos int; real_cuenta int;
  invoker boolean; anon_ok boolean;
begin
  select numeric_scale = 2 into columna_2dec
    from information_schema.columns
   where table_name = 'liquidacion' and column_name = 'diferencia';

  insert into tenant (nombre) values ('ZZZ VERIF 0174') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta,'UnCentavo','+520000017401') returning id into o1;
  insert into operador (tenant_id, nombre, telefono) values (ta,'DosCentavos','+520000017402') returning id into o2;
  insert into operador (tenant_id, nombre, telefono) values (ta,'Real','+520000017403') returning id into o3;
  insert into viaje (tenant_id, operador_id) values (ta,o1) returning id into v1;
  insert into viaje (tenant_id, operador_id) values (ta,o2) returning id into v2;
  insert into viaje (tenant_id, operador_id) values (ta,o3) returning id into v3;

  -- Los tres necesitan un gasto de diésel para aparecer en el agregado.
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
    values (ta,v1,'diesel',100,current_date), (ta,v2,'diesel',100,current_date), (ta,v3,'diesel',100,current_date);

  insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus) values
    (ta, v1, 1000, 1000.01,   0.01, 'cuadrada'),          -- redondeo: NO cuenta
    (ta, v2, 1000, 1000.02,   0.02, 'con_diferencias'),   -- dos centavos: SÍ
    (ta, v3, 1000, 1150,    150,    'con_diferencias');   -- diferencia real

  j := stats_operador_tenant(ta);
  select (x->>'diferencias')::int into centavo      from jsonb_array_elements(j) x where x->>'nombre' = 'UnCentavo';
  select (x->>'diferencias')::int into dos_centavos from jsonb_array_elements(j) x where x->>'nombre' = 'DosCentavos';
  select (x->>'diferencias')::int into real_cuenta  from jsonb_array_elements(j) x where x->>'nombre' = 'Real';

  select p.prosecdef = false into invoker
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'stats_operador_tenant';
  anon_ok := has_function_privilege('anon', 'public.stats_operador_tenant(uuid)', 'EXECUTE');

  raise exception E'REDONDEO_0174  columna_2dec=%  centavo_no_cuenta=%  dos_centavos_cuentan=%  real_cuenta=%  invoker=%  anon=%   (esperado t / 0 / 1 / 1 / t / f)',
    columna_2dec, centavo, dos_centavos, real_cuenta, invoker, anon_ok;
end $$;

-- ── 146. La póliza conserva una base desconocida como desconocida (migs. 0175 + 0178) ──
--
-- La landing promete «el formato que SAP Business One o CONTPAQi ya sabe
-- importar». Para eso hace falta el desglose POR CONCEPTO de cada liquidación,
-- que no salía de ningún lado: `liquidacion` guarda totales e IVA, y los
-- subtotales viven en `gasto`. `poliza_datos_tenant` los agrega en SQL —traer
-- los gastos de un mes a memoria es el patrón que revienta a 50k viajes/mes.
--
-- Lo que se prueba: que el desglose sea correcto, que un gasto SIN `sub_total`
-- quede con base nula y `baseConocida=false` (nunca se sustituye por el total),
-- que la flota vecina no aparezca, y que la
-- función esté cerrada a `anon` y a `authenticated`.
--
-- Esperado: POLIZA_0178  n=1  diesel=3000  caseta=1000  iva=640  anticipo=5000
--                        base_desconocida=1  otro_base_conocida=f  otro_subtotal_nulo=t
--                        ajena_no_entra=t  invoker=t  anon=f  auth=f
--                        erp_confirmado=t  erp_sin_confirmar_rechazado=t  erp_rls=t
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; va uuid; vb uuid;
  j jsonb; fila jsonb;
  n int; diesel numeric; caseta numeric; iva numeric; anticipo numeric; base_desconocida int;
  otro_base_conocida boolean; otro_subtotal_nulo boolean;
  ajena_no_entra boolean; invoker boolean; anon_ok boolean; auth_ok boolean;
  erp_confirmado boolean; erp_sin_confirmar_rechazado boolean := false; erp_rls boolean;
begin
  insert into tenant (nombre) values ('ZZZ POLIZA A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ POLIZA B') returning id into tb;
  insert into operador (tenant_id,nombre,telefono) values (ta,'Juan Perez','+520000017501') returning id into oa;
  insert into operador (tenant_id,nombre,telefono) values (tb,'Otro','+520000017502') returning id into ob;
  insert into viaje (tenant_id,operador_id,folio,anticipo) values (ta,oa,'VJ-POL-A',5000) returning id into va;
  insert into viaje (tenant_id,operador_id,folio,anticipo) values (tb,ob,'VJ-POL-B',9999) returning id into vb;

  insert into gasto (tenant_id,viaje_id,concepto,monto,sub_total,fecha) values
    (ta,va,'diesel',3480,3000,current_date),
    (ta,va,'caseta',1160,1000,current_date),
    -- Sin `sub_total`: no puede hacerse pasar por base.
    (ta,va,'otro',200,null,current_date),
    (tb,vb,'diesel',7777,6704,current_date);

  insert into liquidacion (tenant_id,viaje_id,total_comprobado,total_anticipo,diferencia,estatus,iva_acreditable) values
    (ta,va,4640,5000,360,'con_diferencias',640),
    (tb,vb,6704,9999,3295,'con_diferencias',1073);

  j := poliza_datos_tenant(ta, current_date - 1, current_date + 1);
  n := jsonb_array_length(j);
  fila := j->0;
  anticipo := (fila->>'anticipo')::numeric;
  iva      := (fila->>'ivaAcreditable')::numeric;
  base_desconocida := (fila->>'baseDesconocida')::int;
  select (x->>'subtotal')::numeric into diesel
    from jsonb_array_elements(fila->'porConcepto') x where x->>'concepto' = 'diesel';
  select (x->>'subtotal')::numeric into caseta
    from jsonb_array_elements(fila->'porConcepto') x where x->>'concepto' = 'caseta';
  select (x->>'baseConocida')::boolean, (x->>'subtotal') is null
    into otro_base_conocida, otro_subtotal_nulo
    from jsonb_array_elements(fila->'porConcepto') x where x->>'concepto' = 'otro';

  -- La flota vecina no entra ni por el desglose ni por el conteo.
  ajena_no_entra := (n = 1) and not (j::text like '%VJ-POL-B%');

  select p.prosecdef = false into invoker
    from pg_proc p join pg_namespace nn on nn.oid = p.pronamespace
   where nn.nspname = 'public' and p.proname = 'poliza_datos_tenant';
  anon_ok := has_function_privilege('anon',          'public.poliza_datos_tenant(uuid, date, date)', 'EXECUTE');
  auth_ok := has_function_privilege('authenticated', 'public.poliza_datos_tenant(uuid, date, date)', 'EXECUTE');

  -- El perfil ERP se almacena por flota y exige una confirmación fechada. La
  -- validación de columnas exactas vive en la ruta TS, porque cada instancia
  -- tiene una plantilla distinta; SQL no inventa un layout genérico.
  insert into erp_export_perfil (tenant_id, sistema, plantilla, confirmado_en)
    values (ta, 'contpaqi', '{"tipo":"Dr","numeroInicial":1,"separador":",","encabezado":["A","B","C","D","E","F","G","H","I"]}'::jsonb, now());
  select exists (
    select 1 from erp_export_perfil
     where tenant_id = ta and sistema = 'contpaqi' and confirmado_en is not null
  ) into erp_confirmado;
  begin
    insert into erp_export_perfil (tenant_id, sistema, plantilla, confirmado_en)
      values (ta, 'sap_b1', '{}'::jsonb, null);
  exception when not_null_violation then
    erp_sin_confirmar_rechazado := true;
  end;
  select relrowsecurity into erp_rls
    from pg_class c join pg_namespace nn on nn.oid = c.relnamespace
   where nn.nspname = 'public' and c.relname = 'erp_export_perfil';

  raise exception E'POLIZA_0178  n=%  diesel=%  caseta=%  iva=%  anticipo=%  base_desconocida=%  otro_base_conocida=%  otro_subtotal_nulo=%  ajena_no_entra=%  invoker=%  anon=%  auth=%  erp_confirmado=%  erp_sin_confirmar_rechazado=%  erp_rls=%   (esperado 1 / 3000.00 / 1000.00 / 640.00 / 5000.00 / 1 / f / t / t / t / f / f / t / t / t)',
    n, diesel, caseta, iva, anticipo, base_desconocida, otro_base_conocida,
    otro_subtotal_nulo, ajena_no_entra, invoker, anon_ok, auth_ok, erp_confirmado,
    erp_sin_confirmar_rechazado, erp_rls;
end $$;

-- ── 147. El GPS de la flota entra de verdad, y sin duplicar (mig. 0176) ───
-- GPS_0176 — la ingesta de posiciones: que se pueda ligar un camión a su GPS,
-- que dos camiones no compartan dispositivo, y que la MISMA última posición
-- entre corridas no se duplique.
--
-- El poller corre cada 5 minutos y el proveedor devuelve la ÚLTIMA posición
-- conocida: con el camión parado, dos corridas seguidas traen la misma lectura
-- con la misma `medida_en`. Sin `uq_posicion_lectura` la tabla se llena de
-- copias y cualquier conteo por unidad miente.
--
-- Y el único va SIN predicado a propósito: uno PARCIAL no se puede inferir
-- desde `on_conflict=`, y el upsert del poller reventaría en producción con un
-- error que aquí no se vería. Por eso se prueba el `on conflict` DE VERDAD, no
-- sólo la existencia del índice.
--
-- Esperado: GPS_0176  dup_unidad_rechazado=t  otra_flota_ok=t  repetida_ignorada=t
--                     n_posiciones=1  idx_lectura=t  parcial=f  idx_consulta=t  cron_gps=t
do $$
declare
  ta uuid; tb uuid; ua uuid; ub uuid; uotro uuid;
  dup_unidad_rechazado boolean := false;
  otra_flota_ok boolean := false;
  repetida_ignorada boolean := true;
  n_pos int; idx_lectura boolean; parcial boolean; idx_consulta boolean; cron_gps boolean;
begin
  insert into tenant (nombre) values ('ZZZ GPS A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ GPS B') returning id into tb;
  insert into unidad (tenant_id,numero_economico,gps_proveedor,gps_device_id)
    values (ta,'C2-01','samsara','DEV-1') returning id into ua;
  insert into unidad (tenant_id,numero_economico) values (ta,'C2-02') returning id into ub;

  -- Dos unidades de la MISMA flota no pueden apuntar al mismo dispositivo: las
  -- posiciones de un camión se repartirían entre dos y ninguna serie sería cierta.
  begin
    update unidad set gps_proveedor='samsara', gps_device_id='DEV-1' where id = ub;
  exception when unique_violation then
    dup_unidad_rechazado := true;
  end;

  -- Pero el mismo número EN OTRA FLOTA sí: dos proveedores distintos numeran
  -- sus dispositivos por su cuenta, y una flota no le reserva ids a la otra.
  begin
    insert into unidad (tenant_id,numero_economico,gps_proveedor,gps_device_id)
      values (tb,'C2-01','samsara','DEV-1') returning id into uotro;
    otra_flota_ok := true;
  exception when unique_violation then
    otra_flota_ok := false;
  end;

  insert into posicion (tenant_id,unidad_id,lat,lng,medida_en,proveedor)
    values (ta,ua,20.9674,-89.5926,'2026-08-23T18:00:00Z','samsara');

  -- La MISMA lectura otra vez, como la trae la corrida siguiente. Se hace con
  -- la forma exacta que manda PostgREST: `on conflict (cols) do nothing`, sin
  -- predicado. Si el índice fuera parcial, esto lanzaría 42P10 aquí mismo.
  begin
    insert into posicion (tenant_id,unidad_id,lat,lng,medida_en,proveedor)
      values (ta,ua,20.9674,-89.5926,'2026-08-23T18:00:00Z','samsara')
      on conflict (tenant_id, unidad_id, medida_en) do nothing;
  exception when others then
    repetida_ignorada := false;
  end;

  select count(*) into n_pos from posicion where tenant_id = ta and unidad_id = ua;

  select true, i.indpred is not null into idx_lectura, parcial
    from pg_class c join pg_index i on i.indexrelid = c.oid
   where c.relname = 'uq_posicion_lectura';
  idx_lectura := coalesce(idx_lectura, false);
  parcial := coalesce(parcial, true);

  select exists (select 1 from pg_class where relname = 'posicion_unidad_medida_idx')
    into idx_consulta;

  -- El cron nuevo tiene que caber en el dominio de `cron_latido` (0155), o el
  -- primer latido reventaría y el panel de salud lo daría por muerto.
  begin
    insert into cron_latido (id, ultimo_latido, estado) values ('gps', now(), 'ok')
      on conflict (id) do update set ultimo_latido = excluded.ultimo_latido;
    cron_gps := true;
  exception when check_violation then
    cron_gps := false;
  end;

  raise exception E'GPS_0176  dup_unidad_rechazado=%  otra_flota_ok=%  repetida_ignorada=%  n_posiciones=%  idx_lectura=%  parcial=%  idx_consulta=%  cron_gps=%   (esperado t / t / t / 1 / t / f / t / t)',
    dup_unidad_rechazado, otra_flota_ok, repetida_ignorada, n_pos, idx_lectura, parcial, idx_consulta, cron_gps;
end $$;

-- ── 148. Claims de correo y WhatsApp son leases exclusivos (0177) ─────────
-- Esperado: CLAIMS_0177 correo=t busy=t relevo=t aplicado=t viejo=f wa=t lease=t segundo=0 permisos=f
do $$
declare a text; b text; c text; d text; t1 uuid; t2 uuid; tw uuid; n int;
  correo boolean; busy boolean; relevo boolean; aplicado boolean; viejo boolean;
  wa boolean; lease boolean; permisos boolean;
begin
  delete from public.correo_procesado where email_id='zzz-verif-0177-correo';
  select resultado,token into a,t1 from public.reclamar_correo('zzz-verif-0177-correo',90);
  select resultado into b from public.reclamar_correo('zzz-verif-0177-correo',90);
  perform public.finalizar_correo('zzz-verif-0177-correo',t1,false,'transitorio');
  select resultado,token into c,t2 from public.reclamar_correo('zzz-verif-0177-correo',90);
  viejo := public.finalizar_correo('zzz-verif-0177-correo',t1,true,null);
  perform public.finalizar_correo('zzz-verif-0177-correo',t2,true,null);
  select resultado into d from public.reclamar_correo('zzz-verif-0177-correo',90);
  correo := a='claimed' and t1 is not null; busy := b='busy'; relevo := c='claimed' and t2<>t1; aplicado := d='applied';

  delete from public.wa_evento_pendiente where id='zzz-verif-0177-wa';
  insert into public.wa_evento_pendiente(id,evento) values ('zzz-verif-0177-wa','{"from":"521000000000","type":"text"}');
  select claim_token into tw from public.reclamar_wa_pendiente('zzz-verif-0177-wa',0,'verif',90);
  select count(*) into n from public.reclamar_wa_pendiente('zzz-verif-0177-wa',0,'otro',90);
  select lease_expires_at>now() into lease from public.wa_evento_pendiente where id='zzz-verif-0177-wa'; wa := tw is not null and n=0;
  permisos := has_function_privilege('anon','public.reclamar_correo(text,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.finalizar_correo(text,uuid,boolean,text)','EXECUTE')
    or has_function_privilege('anon','public.reclamar_wa_pendiente(text,integer,text,integer)','EXECUTE');
  raise exception E'CLAIMS_0177 correo=% busy=% relevo=% aplicado=% viejo=% wa=% lease=% segundo=% permisos=% (esperado t/t/t/t/f/t/t/0/f)',correo,busy,relevo,aplicado,viejo,wa,lease,n,permisos;
end $$;

-- ── 149. Outbox y presupuesto se reclaman una sola vez (0180) ────────────
-- Esperado: OUTBOX_RESERVA_0180 claim=t exclusivo=t retry=t sent=t cerrado=t reserva=t segunda=f reabre=t permisos=f
do $$
declare o uuid; l1 uuid; l2 uuid; r1 uuid; r2 uuid; r3 uuid; x int; monto numeric;
  claim boolean; exclusivo boolean; retry boolean; sent boolean; cerrado boolean;
  reserva boolean; segunda boolean; reabre boolean; permisos boolean;
begin
  insert into public.wa_outbox(payload) values ('{"type":"text","to":"529990000000","text":{"body":"verif"}}') returning id into o;
  select id,lease_token into o,l1 from public.reclamar_wa_outbox(1,90) where id=o; claim := l1 is not null;
  select count(*) into x from public.reclamar_wa_outbox(1,90) where id=o; exclusivo := x=0;
  perform public.finalizar_wa_outbox(o,l1,null,'transitorio'); update public.wa_outbox set proximo_intento_en=now() where id=o;
  select lease_token into l2 from public.reclamar_wa_outbox(1,90) where id=o; retry := l2 is not null and l2<>l1;
  perform public.finalizar_wa_outbox(o,l2,'wamid.verif.0180',null);
  select estado='sent' and provider_message_id='wamid.verif.0180' into sent from public.wa_outbox where id=o;
  cerrado := not has_table_privilege('anon','public.wa_outbox','SELECT') and not has_table_privilege('authenticated','public.wa_outbox','INSERT');

  select id,disponible_usd into r1,monto from public.reservar_presupuesto_agente('zzz-verif-0180',current_date,1,90); reserva := r1 is not null and monto=1;
  select id into r2 from public.reservar_presupuesto_agente('zzz-verif-0180',current_date,1,90); segunda := r2 is not null;
  perform public.cerrar_reserva_presupuesto_agente(r1,0);
  select id into r3 from public.reservar_presupuesto_agente('zzz-verif-0180',current_date,1,90); reabre := r3 is not null;
  perform public.cerrar_reserva_presupuesto_agente(r3,0);
  permisos := has_function_privilege('anon','public.reclamar_wa_outbox(integer,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.reservar_presupuesto_agente(text,date,numeric,integer)','EXECUTE')
    or has_function_privilege('anon','public.cerrar_reserva_presupuesto_agente(uuid,numeric)','EXECUTE');
  raise exception E'OUTBOX_RESERVA_0180 claim=% exclusivo=% retry=% sent=% cerrado=% reserva=% segunda=% reabre=% permisos=% (esperado t/t/t/t/t/t/f/t/f)',claim,exclusivo,retry,sent,cerrado,reserva,segunda,reabre,permisos;
end $$;

-- ── 150. El CRM deduplica leads y conserva un ledger idempotente (mig. 0181) ─
-- 0181: la clave natural parcial evita que dos instancias creen el mismo lead,
-- y `comercial_evento` es la bitácora única para citas y cierres. Se comprueba
-- la colisión REAL, el webhook repetido, y RLS deny-all para clientes.
do $$
declare
  p uuid;
  clave_rebota boolean := false;
  evento_repite boolean := false;
  fila_eventos int;
  idx_lead boolean;
  idx_evento boolean;
  rls_evento boolean;
  policies_evento int;
begin
  select exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'prospecto_lead_clave_unica') into idx_lead;
  select exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'comercial_evento_clave_unica') into idx_evento;
  select c.relrowsecurity into rls_evento
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'comercial_evento';
  select count(*) into policies_evento
    from pg_policies where schemaname = 'public' and tablename = 'comercial_evento';

  insert into public.prospecto (empresa, correo, lead_clave, fuente)
    values ('__V181 CRM__', '__v181__@example.invalid', 'correo:__v181__', 'landing') returning id into p;
  begin
    insert into public.prospecto (empresa, correo, lead_clave, fuente)
      values ('__V181 CRM duplicado__', '__v181__@example.invalid', 'correo:__v181__', 'landing');
  exception when unique_violation then
    clave_rebota := true;
  end;

  insert into public.comercial_evento (clave_idempotencia, fuente, tipo, prospecto_id, externo_id, payload)
    values ('__V181_EVENTO__', 'test', 'booking.created', p, '__v181-booking__', '{"test":true}');
  begin
    insert into public.comercial_evento (clave_idempotencia, fuente, tipo, prospecto_id, externo_id, payload)
      values ('__V181_EVENTO__', 'test', 'booking.created', p, '__v181-booking__', '{"test":true}');
  exception when unique_violation then
    evento_repite := true;
  end;
  select count(*) into fila_eventos from public.comercial_evento where clave_idempotencia = '__V181_EVENTO__';

  raise exception E'CRM_0181  clave_rebota=%  evento_repite=%  fila_eventos=%  idx_lead=%  idx_evento=%  rls=%  policies=%   (esperado t / t / 1 / t / t / t / 0)',
    clave_rebota, evento_repite, fila_eventos, idx_lead, idx_evento, rls_evento, policies_evento;
end $$;

-- ── 151. El score ICP interpreta SCIAN de seis dígitos (mig. 0182) ────────
-- 484xxx/485xxx/488xxx son transporte de carga; un giro 999xxx no recibe los
-- 40 puntos SCIAN. Se comprueba el valor generado y el índice de vivos.
do $$
declare
  p_bueno uuid;
  p_malo uuid;
  score_bueno int;
  score_malo int;
  indice boolean;
begin
  select exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_prospecto_similitud') into indice;
  insert into public.prospecto (empresa, scian, vacante, num_unidades, sitio_verificado, fuente)
    values ('__V182 SCIAN bueno__', '484110', 'Operador', 10, true, 'denue') returning id into p_bueno;
  insert into public.prospecto (empresa, scian, fuente)
    values ('__V182 SCIAN malo__', '999999', 'denue') returning id into p_malo;
  select similitud_icp_pct into score_bueno from public.prospecto where id = p_bueno;
  select similitud_icp_pct into score_malo from public.prospecto where id = p_malo;

  raise exception E'CRM_0182  score_484110=%  score_999999=%  indice=%   (esperado 100 / 0 / t)',
    score_bueno, score_malo, indice;
end $$;

-- ── 153. El lease de herramientas usa el reloj de PostgreSQL (mig. 0188) ──
-- El primer worker ejecuta, el segundo ve busy, solo el token vigente renueva
-- y, tras vencer el lease en la base, un token nuevo cerca al anterior. El
-- resultado completado se devuelve sin repetir el efecto y ningún rol cliente
-- puede ejecutar las RPCs SECURITY DEFINER.
-- Esperado: RUNTIME_CLOCK_0188 primero=execute busy=busy renueva=t ajeno=f reloj=t relevo=execute viejo=f nuevo=t cached=cached dato=true permisos=f
do $$
declare
  t uuid;
  token_1 uuid;
  token_2 uuid;
  primero text;
  ocupado text;
  relevo text;
  cached text;
  dato jsonb;
  renueva boolean;
  ajeno boolean;
  reloj boolean;
  viejo boolean;
  nuevo boolean;
  permisos boolean;
begin
  insert into public.tenant (nombre) values ('ZZZ RUNTIME CLOCK 0188') returning id into t;

  select kind, token into primero, token_1
    from public.claim_agente_mutacion(t, 'verif:0188', 'verificador', 90);
  select kind into ocupado
    from public.claim_agente_mutacion(t, 'verif:0188', 'verificador', 90);

  ajeno := public.renew_agente_mutacion(t, 'verif:0188', gen_random_uuid(), 120);
  renueva := public.renew_agente_mutacion(t, 'verif:0188', token_1, 120);
  select lease_until > clock_timestamp() into reloj
    from public.agente_mutacion_idempotencia
   where tenant_id = t and effect_key = 'verif:0188';

  update public.agente_mutacion_idempotencia
     set lease_until = clock_timestamp() - interval '1 second'
   where tenant_id = t and effect_key = 'verif:0188';
  select kind, token into relevo, token_2
    from public.claim_agente_mutacion(t, 'verif:0188', 'verificador', 90);

  viejo := public.complete_agente_mutacion(t, 'verif:0188', token_1, '{"saved":false}'::jsonb);
  nuevo := public.complete_agente_mutacion(t, 'verif:0188', token_2, '{"saved":true}'::jsonb);
  select kind, result into cached, dato
    from public.claim_agente_mutacion(t, 'verif:0188', 'verificador', 90);

  permisos :=
    has_function_privilege('anon', 'public.claim_agente_mutacion(uuid,text,text,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.claim_agente_mutacion(uuid,text,text,integer)', 'EXECUTE')
    or has_function_privilege('anon', 'public.renew_agente_mutacion(uuid,text,uuid,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.complete_agente_mutacion(uuid,text,uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.fail_agente_mutacion(uuid,text,uuid,text)', 'EXECUTE');

  raise exception E'RUNTIME_CLOCK_0188 primero=% busy=% renueva=% ajeno=% reloj=% relevo=% viejo=% nuevo=% cached=% dato=% permisos=% (esperado execute/busy/t/f/t/execute/f/t/cached/true/f)',
    primero, ocupado, renueva, ajeno, reloj, relevo, viejo, nuevo, cached,
    dato->>'saved', permisos;
end $$;

-- ── 152. El ledger del panel de QA es una tabla, con las garantías que el JSON no daba (mig. 0185) ──
--
-- La Fase A guardaba el banco de fotos y las corridas como JSON en Storage,
-- por una razón que ya caducó (migraciones congeladas). Este bloque comprueba
-- las TRES cosas que solo la base puede demostrar y que el archivo no podía:
--
--   · DEDUP POR CONSTRUCCIÓN. En el JSON, `subirFotos` leía el manifiesto,
--     buscaba el hash y reescribía el archivo entero: dos subidas concurrentes
--     leen lo mismo y la segunda pisa a la primera. El `unique` sobre el hash
--     hace que la carrera no exista.
--   · UN PASO N POR CORRIDA. El motor reescribe cada paso en cada transición
--     (pendiente → corriendo → ok). Con PK compuesta el upsert cae siempre en
--     la misma fila; sin ella, un reintento duplicaba el paso en la pantalla.
--   · UNA CONFIRMACIÓN SIN FIRMA NO ES UNA CONFIRMACIÓN. `ocr_esperado` es el
--     oráculo humano: si se pudiera escribir sin `confirmado_en`, existiría un
--     "esperado" que nadie respalda — y el veredicto lo leería como verdad.
--
-- Y dos de higiene: el cascade no deja pasos huérfanos, y RLS deja ciego a
-- anon (una foto de ticket real trae RFC y domicilio, LFPDPPP art. 2 fr. VI).
do $$
declare
  v_corrida uuid; v_otra uuid; v_foto uuid;
  hash_rebota boolean; carril_rebota boolean; confirmacion_rebota boolean;
  n_pasos int; nombre_final text; n_tras_cascade int;
  n_anon int; nota_anon text;
begin
  insert into qa_foto (hash, path, mime, etiqueta, bytes)
    values ('zzz0185deadbeef', 'banco/zzz-0185.jpg', 'image/jpeg', 'ticket 0185', 100)
    returning id into v_foto;

  -- LA MISMA FOTO, OTRA VEZ: el banco no la admite dos veces.
  begin
    insert into qa_foto (hash, path, mime, etiqueta, bytes)
      values ('zzz0185deadbeef', 'banco/zzz-0185-bis.jpg', 'image/jpeg', 'la misma', 100);
    hash_rebota := false;
  exception when unique_violation then
    hash_rebota := true;
  end;

  -- UN "ESPERADO" SIN FIRMA: no se puede escribir.
  begin
    update qa_foto set ocr_esperado = '{"monto": 1200}'::jsonb where id = v_foto;
    confirmacion_rebota := false;
  exception when check_violation then
    confirmacion_rebota := true;
  end;

  insert into qa_corrida (escenario, parametros, estado, tenant_nombre)
    values ('feliz', '{"anticipo": 1000}'::jsonb, 'corriendo', 'ZZZ QA 0185')
    returning id into v_corrida;

  -- Un carril inventado no entra (y 'completo' sí — la Fase C no pide DDL).
  begin
    insert into qa_corrida (escenario, carril, parametros, estado, tenant_nombre)
      values ('feliz', 'teletransporte', '{}'::jsonb, 'pendiente', 'ZZZ QA 0185')
      returning id into v_otra;
    carril_rebota := false;
  exception when check_violation then
    carril_rebota := true;
  end;
  insert into qa_corrida (escenario, carril, parametros, estado, tenant_nombre)
    values ('feliz', 'completo', '{}'::jsonb, 'pendiente', 'ZZZ QA 0185')
    returning id into v_otra;

  -- EL MISMO PASO, TRES VECES: es una fila, con el último estado.
  insert into qa_corrida_paso (corrida_id, n, nombre, estado)
    values (v_corrida, 1, 'intake', 'pendiente');
  insert into qa_corrida_paso (corrida_id, n, nombre, estado)
    values (v_corrida, 1, 'intake', 'corriendo')
    on conflict (corrida_id, n) do update set estado = excluded.estado, nombre = excluded.nombre;
  insert into qa_corrida_paso (corrida_id, n, nombre, estado)
    values (v_corrida, 1, 'intake · OCR', 'ok')
    on conflict (corrida_id, n) do update set estado = excluded.estado, nombre = excluded.nombre;
  select count(*) into n_pasos from qa_corrida_paso where corrida_id = v_corrida;
  select nombre into nombre_final from qa_corrida_paso where corrida_id = v_corrida and n = 1;

  -- DATOS-19C2 (barrido MEDIO/BAJO, mig. 0196): antes solo RLS dejaba a
  -- `anon` a ciegas (0 filas); ahora ni siquiera tiene el GRANT de tabla —
  -- el intento rebota en el privilegio, antes de que RLS entre a evaluar.
  -- Más estricto (doble candado), por eso el `esperado` cambió de 0 a -1.
  begin
    set local role anon;
    select count(*) into n_anon from qa_foto where id = v_foto;
    reset role;
    nota_anon := case when n_anon = 0 then 'RLS lo deja a ciegas' else 'FUGA: anon LEE fotos de tickets' end;
  exception when insufficient_privilege then
    reset role;
    n_anon := -1; nota_anon := 'denegado por privilegios de tabla';
  end;

  -- Borrar la corrida se lleva sus pasos: nada de filas colgando.
  delete from qa_corrida where id = v_corrida;
  select count(*) into n_tras_cascade from qa_corrida_paso where corrida_id = v_corrida;

  raise exception E'QA_PANEL_0185  hash_rebota=%  confirmacion_rebota=%  carril_rebota=%  pasos=%  nombre_final=%  tras_cascade=%  anon=%  nota=%   (esperado t / t / t / 1 / intake · OCR / 0 / -1 / denegado por privilegios de tabla)',
    hash_rebota, confirmacion_rebota, carril_rebota, n_pasos, nombre_final, n_tras_cascade, n_anon, nota_anon;
end $$;

-- ── 154. El tope diario de presupuesto de IA usa el día de México, y una reserva muerta vence (mig. 0193) ──
--
-- AGEN-19C2-4 — el tope diario reiniciaba en medianoche UTC (18:00 hora de
-- México), y una reserva de una invocación que muere sin liquidarse (crash,
-- deploy, OOM) contaba contra el tope para siempre — no vencía.
--
-- (a)/(b) prueban la fórmula de "medianoche MX" contra un instante FIJO
-- (2027-01-01T02:00:00-06:00), no contra `now()` — así el bloque da el mismo
-- resultado sin importar a qué hora real corra en CI — y confirman que la
-- función DESPLEGADA (no solo la fórmula en abstracto) la usa.
-- (c)/(d) prueban que una reserva vencida (`expira_en` en el pasado) deja de
-- contar contra el tope del tenant, pero una vigente sigue contando igual
-- que antes — el fix no perdona presupuesto real, solo el fantasma de una
-- invocación muerta.
-- ACTUALIZACIÓN (auditoría de graduación de agentes, 2-sep-2026, migración
-- 0302): este bloque llamaba al overload de 6 argumentos de
-- `reservar_presupuesto_llm` (booleano) — el que existía cuando se escribió
-- este bloque, antes de que la 0244 lo sustituyera por el de 8 argumentos
-- (texto: 'ok'/'tope_tenant'/'tope_proposito'/'tope_run'). La 0302 retiró
-- ese overload de 6 por huérfano (0 callers reales en `src/`), y este bloque
-- CI dejó de compilar — "ERROR INESPERADO... function ... does not exist"
-- (block 154, no llegó ni a su RAISE de cierre). Se migró a la firma de 8
-- args con `proposito='fondo'` y `reserva_interactivo_usd=0` — con la
-- reserva de interactivo en cero, el sub-tope de 'fondo' coincide con el
-- tope del tenant, así que el bloque sigue probando EXACTAMENTE lo mismo
-- que antes (el tope diario completo, no el reparto por propósito de la
-- 0244 — eso ya lo prueba el bloque 200/0244). El tipo de retorno cambió de
-- boolean a text: `acepta_tras_expirada`/`acepta_tras_vigente` ahora
-- comparan contra 'ok'/'tope_tenant', no contra t/f.
do $$
declare
  t uuid;
  r_expirada uuid := gen_random_uuid();
  r_nueva_c  uuid := gen_random_uuid();
  r_vigente  uuid := gen_random_uuid();
  r_nueva_d  uuid := gen_random_uuid();
  ejemplo_mx timestamptz;
  formula_ok boolean;
  def_fn text;
  fn_usa_mx boolean;
  fn_usa_expira boolean;
  acepta_tras_expirada text;
  acepta_tras_vigente text;
begin
  insert into public.tenant (nombre) values ('ZZZ VERIF 0193') returning id into t;

  -- (a) 2027-01-01T02:00:00-06:00 es la 01:00 del 1-ene en MX; su medianoche
  -- MX es el 1-ene 00:00 hora MX = 2027-01-01T00:00:00-06:00 en UTC.
  ejemplo_mx := date_trunc('day', timestamptz '2027-01-01T02:00:00-06:00' at time zone 'America/Mexico_City')
                  at time zone 'America/Mexico_City';
  formula_ok := ejemplo_mx = timestamptz '2027-01-01T00:00:00-06:00';

  -- (b) La función desplegada de verdad usa esa fórmula (y la columna de
  -- expiración), no `date_trunc('day', now())` a secas.
  def_fn := pg_get_functiondef('public.reservar_presupuesto_llm(uuid,uuid,uuid,numeric,numeric,numeric,text,numeric)'::regprocedure);
  fn_usa_mx := def_fn ilike '%America/Mexico_City%';
  fn_usa_expira := def_fn ilike '%expira_en%';

  -- (c) Una reserva YA EXPIRADA no cuenta contra el tope del tenant.
  insert into public.llm_presupuesto_reserva (id, tenant_id, run_id, reservado_usd, estado, expira_en)
    values (r_expirada, t, gen_random_uuid(), 0.90, 'reservado', now() - interval '1 minute');
  acepta_tras_expirada := public.reservar_presupuesto_llm(r_nueva_c, t, gen_random_uuid(), 0.50, 10.00, 1.00, 'fondo', 0);
  delete from public.llm_presupuesto_reserva where id in (r_expirada, r_nueva_c);

  -- (d) Pero una reserva VIGENTE (no vencida) SÍ sigue contando: 0.90 + 0.50
  -- > 1.00 de tope, así que esta debe RECHAZARSE.
  insert into public.llm_presupuesto_reserva (id, tenant_id, run_id, reservado_usd, estado, expira_en)
    values (r_vigente, t, gen_random_uuid(), 0.90, 'reservado', now() + interval '10 minutes');
  acepta_tras_vigente := public.reservar_presupuesto_llm(r_nueva_d, t, gen_random_uuid(), 0.50, 10.00, 1.00, 'fondo', 0);

  delete from public.llm_presupuesto_reserva where tenant_id = t;
  delete from public.tenant where id = t;

  raise exception 'PRESUPUESTO_LLM_0193  formula_dia_mx_ok=%  fn_usa_mx=%  fn_usa_expira=%  acepta_tras_expirada=%  acepta_tras_vigente=%   (esperado t / t / t / ok / tope_tenant)',
    formula_ok, fn_usa_mx, fn_usa_expira, acepta_tras_expirada, acepta_tras_vigente;
end $$;

-- ── 155. El panel de QA sin grants directos, y `escenario` con dominio cerrado (mig. 0196) ──
-- La 0185 dejó `qa_foto`/`qa_corrida`/`qa_corrida_paso` solo protegidas por
-- RLS, sin el `revoke` que ya usan sus hermanas de 0186. Un banco de fotos
-- que guarda OCR con RFC/domicilio real se merece el mismo doble candado.
-- `escenario` en `qa_corrida` tampoco tenía CHECK, a diferencia de `carril`
-- y `estado` en la misma tabla.
do $$
declare
  v_id uuid; n_anon int; n_auth int; escenario_malo_rebota boolean; escenario_bueno_entra boolean;
begin
  -- (a) Sin grant directo: ni anon ni authenticated pueden leer, con o sin RLS de por medio.
  begin
    set local role anon;
    select count(*) into n_anon from qa_foto;
    reset role;
  exception when insufficient_privilege then
    reset role; n_anon := -1;
  end;
  begin
    set local role authenticated;
    select count(*) into n_auth from qa_corrida;
    reset role;
  exception when insufficient_privilege then
    reset role; n_auth := -1;
  end;

  -- (b) El dominio cerrado de `escenario`: un valor fuera del catálogo actual rebota.
  begin
    insert into qa_corrida (escenario, parametros, estado, tenant_nombre)
      values ('escenario_inventado', '{}'::jsonb, 'pendiente', 'ZZZ VERIF 0196');
    escenario_malo_rebota := false;
  exception when check_violation then
    escenario_malo_rebota := true;
  end;
  insert into qa_corrida (escenario, parametros, estado, tenant_nombre)
    values ('demo_guion', '{}'::jsonb, 'pendiente', 'ZZZ VERIF 0196')
    returning id into v_id;
  escenario_bueno_entra := v_id is not null;
  delete from qa_corrida where id = v_id;

  raise exception 'QA_PANEL_GRANTS_0196  anon=%  authenticated=%  escenario_malo_rebota=%  escenario_bueno_entra=%   (esperado -1 / -1 / t / t)',
    n_anon, n_auth, escenario_malo_rebota, escenario_bueno_entra;
end $$;

-- ── 156. Asistencia en carretera: tipos/prioridad nuevos, candados y bitácora (mig. 0198) ──
-- El circuito de siniestros amplía `incidencia` (siniestro/robo/emergencia_
-- medica/varado/bloqueo, prioridad critica) y trae cuatro tablas nuevas.
-- `flota_poliza` guarda el 800 de siniestros de la aseguradora — un dato que
-- ni anon ni authenticated deben poder leer (doble candado 0186/0196). Y la
-- unicidad `(incidencia_id, wa_message_id)` es la idempotencia de la bitácora:
-- el mismo WhatsApp reentregado no puede duplicar el evento.
do $$
declare
  t uuid; inc uuid; n_anon int;
  tipo_nuevo_entra boolean; tipo_basura_rebota boolean; critica_entra boolean;
  evento_repetido_rebota boolean; sin_wa_no_compiten boolean;
begin
  insert into tenant (nombre) values ('ZZZ ASISTENCIA 0198') returning id into t;

  -- (a) Los tipos nuevos entran con prioridad crítica; la basura sigue rebotando.
  begin
    insert into incidencia (tenant_id, tipo, prioridad, descripcion, hay_lesionados)
      values (t, 'siniestro', 'critica', 'volcadura km 40', null)
      returning id into inc;
    tipo_nuevo_entra := inc is not null;
    critica_entra := true;
  exception when check_violation then
    tipo_nuevo_entra := false; critica_entra := false;
  end;
  begin
    insert into incidencia (tenant_id, tipo) values (t, 'tipo_inventado');
    tipo_basura_rebota := false;
  exception when check_violation then
    tipo_basura_rebota := true;
  end;

  -- (b) La bitácora: mismo wa_message_id → una sola fila; sin wa_message_id
  --     los eventos del sistema no compiten entre sí.
  insert into incidencia_evento (tenant_id, incidencia_id, tipo, wa_message_id)
    values (t, inc, 'abierta', 'wamid.PRUEBA-0198');
  begin
    insert into incidencia_evento (tenant_id, incidencia_id, tipo, wa_message_id)
      values (t, inc, 'mensaje_adicional', 'wamid.PRUEBA-0198');
    evento_repetido_rebota := false;
  exception when unique_violation then
    evento_repetido_rebota := true;
  end;
  insert into incidencia_evento (tenant_id, incidencia_id, tipo) values (t, inc, 'aviso_jefe_enviado');
  insert into incidencia_evento (tenant_id, incidencia_id, tipo) values (t, inc, 'reconocida');
  select count(*) = 3 into sin_wa_no_compiten
    from incidencia_evento where incidencia_id = inc;

  -- (c) El 800 de siniestros fuera del alcance de anon: rebota por privilegio
  --     de tabla (-1), no "0 filas por RLS" — el doble candado de 0196.
  begin
    set local role anon;
    select count(*) into n_anon from flota_poliza;
    reset role;
  exception when insufficient_privilege then
    reset role; n_anon := -1;
  end;

  raise exception 'ASISTENCIA_0198  tipo_nuevo=%  critica=%  basura_rebota=%  evento_repetido_rebota=%  bitacora=%  anon=%   (esperado t / t / t / t / t / -1)',
    tipo_nuevo_entra, critica_entra, tipo_basura_rebota, evento_repetido_rebota, sin_wa_no_compiten, n_anon;
end $$;

-- ── 157. El REP libera el IVA a crédito con rastro e idempotencia (mig. 0199) ──
-- `cfdi_pago` es el registro de cada DoctoRelacionado de cada complemento de
-- pago ingerido: sin grants directos (solo service_role — mismo doble candado
-- que 0196), y con unicidad por (tenant, REP, docto) para que el mismo REP
-- reenviado no duplique. Y `gasto.metodo_pago` con dominio cerrado PUE/PPD:
-- un valor inventado del OCR o de un XML roto rebota, no se guarda.
do $$
declare
  t uuid; v_op uuid; n_anon int; n_auth int; duplicado_rebota boolean; metodo_malo_rebota boolean;
begin
  -- (a) Sin grant directo: ni anon ni authenticated pueden leer cfdi_pago.
  begin
    set local role anon;
    select count(*) into n_anon from cfdi_pago;
    reset role;
  exception when insufficient_privilege then
    reset role; n_anon := -1;
  end;
  begin
    set local role authenticated;
    select count(*) into n_auth from cfdi_pago;
    reset role;
  exception when insufficient_privilege then
    reset role; n_auth := -1;
  end;

  -- (b) La idempotencia: el mismo (tenant, REP, docto) dos veces rebota.
  insert into tenant (nombre) values ('ZZZ REP 0199') returning id into t;
  insert into cfdi_pago (tenant_id, cfdi_uuid, fecha_pago, docto_relacionado_uuid, imp_pagado, imp_saldo_insoluto)
    values (t, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0199', '2026-08-01', '11111111-2222-3333-4444-555555550199', 1160.00, 0);
  begin
    insert into cfdi_pago (tenant_id, cfdi_uuid, fecha_pago, docto_relacionado_uuid, imp_pagado, imp_saldo_insoluto)
      values (t, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0199', '2026-08-01', '11111111-2222-3333-4444-555555550199', 1160.00, 0);
    duplicado_rebota := false;
  exception when unique_violation then
    duplicado_rebota := true;
  end;

  -- (c) El dominio de metodo_pago: basura rebota.
  begin
    -- Un UPDATE de 0 filas no evalúa el CHECK: se prueba con un INSERT real.
    -- `viaje.operador_id` es NOT NULL: se crea un operador de andamiaje antes
    -- (el fallo original de este bloque en CI fue exactamente ese NOT NULL).
    insert into operador (tenant_id, nombre, telefono) values (t, 'P', '+520000000199') returning id into v_op;
    insert into viaje (tenant_id, operador_id, folio) values (t, v_op, 'ZZZ-REP');
    insert into gasto (tenant_id, viaje_id, concepto, monto, metodo_pago)
      select t, v.id, 'diesel', 100, 'XXX' from viaje v where v.tenant_id = t limit 1;
    metodo_malo_rebota := false;
  exception when check_violation then
    metodo_malo_rebota := true;
  end;

  raise exception 'REP_CFDI_PAGO_0199  anon=%  authenticated=%  duplicado_rebota=%  metodo_malo_rebota=%   (esperado -1 / -1 / t / t)',
    n_anon, n_auth, duplicado_rebota, metodo_malo_rebota;
end $$;

-- ── 158. Un expediente de asistencia por chofer (mig. 0201) ──
-- La carrera check-then-create del webhook: dos mensajes ROJO concurrentes
-- del mismo chofer no pueden abrir dos expedientes con dos 🚨 al jefe. El
-- índice único parcial deja ganar a uno; se comprueba además que NO compite
-- con la talacha (`averia` está fuera del predicado), que resolver libera al
-- chofer para el siguiente expediente, y que las incidencias de oficina
-- (operador NULL) no chocan entre sí.
do $$
declare
  t uuid; v_op uuid; inc1 uuid;
  segundo_rebota boolean; talacha_no_compite boolean;
  resuelta_libera boolean; oficina_no_choca boolean;
begin
  insert into tenant (nombre) values ('ZZZ EXPEDIENTE 0201') returning id into t;
  insert into operador (tenant_id, nombre, telefono) values (t, 'P', '+520000000201') returning id into v_op;

  -- (a) El segundo expediente abierto del mismo chofer rebota.
  insert into incidencia (tenant_id, operador_id, tipo, prioridad)
    values (t, v_op, 'varado', 'alta') returning id into inc1;
  begin
    insert into incidencia (tenant_id, operador_id, tipo, prioridad)
      values (t, v_op, 'siniestro', 'critica');
    segundo_rebota := false;
  exception when unique_violation then
    segundo_rebota := true;
  end;

  -- (b) La talacha del mismo chofer NO compite: `averia` está fuera del predicado.
  begin
    insert into incidencia (tenant_id, operador_id, tipo, prioridad)
      values (t, v_op, 'averia', 'alta');
    talacha_no_compite := true;
  exception when unique_violation then
    talacha_no_compite := false;
  end;

  -- (c) Resolver el expediente libera al chofer para el siguiente.
  update incidencia set estado = 'resuelta', resuelta_en = now() where id = inc1;
  begin
    insert into incidencia (tenant_id, operador_id, tipo, prioridad)
      values (t, v_op, 'siniestro', 'critica');
    resuelta_libera := true;
  exception when unique_violation then
    resuelta_libera := false;
  end;

  -- (d) Dos incidencias de oficina (operador NULL) no chocan entre sí.
  insert into incidencia (tenant_id, tipo, prioridad) values (t, 'siniestro', 'critica');
  begin
    insert into incidencia (tenant_id, tipo, prioridad) values (t, 'robo', 'critica');
    oficina_no_choca := true;
  exception when unique_violation then
    oficina_no_choca := false;
  end;

  raise exception 'EXPEDIENTE_UNICO_0201  segundo_rebota=%  talacha_no_compite=%  resuelta_libera=%  oficina_no_choca=%   (esperado t / t / t / t)',
    segundo_rebota, talacha_no_compite, resuelta_libera, oficina_no_choca;
end $$;

-- ── 159. El sello de avisos de vencimiento: una vez por umbral, ciego para la app (mig. 0202) ──
-- `aviso_vigencia` es la memoria de "este WhatsApp ya salió": sin la unicidad
-- de su llave, el barrido horario mandaría el mismo aviso 24 veces al día. Y
-- como guarda qué papeles de qué flota están por vencer, ni anon ni
-- authenticated deben poder leerla (doble candado 0196/0198). Los dominios de
-- objeto/documento/umbral rechazan basura: un sello con umbral inventado
-- jamás casaría con lo que el barrido busca y el aviso saldría doble.
do $$
declare
  t uuid; u uuid; n_anon int; n_auth int;
  duplicado_rebota boolean; umbral_malo_rebota boolean; renovacion_entra boolean;
begin
  -- (a) Sin grant directo.
  begin
    set local role anon;
    select count(*) into n_anon from aviso_vigencia;
    reset role;
  exception when insufficient_privilege then
    reset role; n_anon := -1;
  end;
  begin
    set local role authenticated;
    select count(*) into n_auth from aviso_vigencia;
    reset role;
  exception when insufficient_privilege then
    reset role; n_auth := -1;
  end;

  -- (b) El mismo (objeto, documento, umbral, fecha) dos veces rebota…
  insert into tenant (nombre) values ('ZZZ VIGENCIA 0202') returning id into t;
  u := gen_random_uuid();
  insert into aviso_vigencia (tenant_id, objeto, objeto_id, documento, umbral, vence)
    values (t, 'unidad', u, 'verificacion', 7, '2026-09-15');
  begin
    insert into aviso_vigencia (tenant_id, objeto, objeto_id, documento, umbral, vence)
      values (t, 'unidad', u, 'verificacion', 7, '2026-09-15');
    duplicado_rebota := false;
  exception when unique_violation then
    duplicado_rebota := true;
  end;

  -- …pero el documento RENOVADO (fecha nueva) SÍ entra: es un ciclo nuevo.
  begin
    insert into aviso_vigencia (tenant_id, objeto, objeto_id, documento, umbral, vence)
      values (t, 'unidad', u, 'verificacion', 7, '2027-09-15');
    renovacion_entra := true;
  exception when others then
    renovacion_entra := false;
  end;

  -- (c) Umbral fuera del dominio rebota.
  begin
    insert into aviso_vigencia (tenant_id, objeto, objeto_id, documento, umbral, vence)
      values (t, 'unidad', u, 'poliza', 15, '2026-09-15');
    umbral_malo_rebota := false;
  exception when check_violation then
    umbral_malo_rebota := true;
  end;

  raise exception 'AVISO_VIGENCIA_0202  anon=%  authenticated=%  duplicado_rebota=%  renovacion_entra=%  umbral_malo_rebota=%   (esperado -1 / -1 / t / t / t)',
    n_anon, n_auth, duplicado_rebota, renovacion_entra, umbral_malo_rebota;
end $$;

-- ── 160. El agregado GPS cuenta por unidad y día de MÉXICO, sin fugas (mig. 0205) ──
-- La evidencia GPS de los cruces de peaje se mide por día de America/Mexico_City
-- (UTC-6 fijo desde 2022): una posición a las 05:59 UTC es del día ANTERIOR en
-- México y a las 06:00 UTC ya es del día que corre. Se comprueba además que el
-- margen de ±1 día del filtro por timestamptz NO deja salir días fuera del rango
-- pedido, que las posiciones de otra unidad no prestan conteo, que el tenant
-- ajeno no aparece ni pasando su unidad en el arreglo, y que anon/authenticated
-- no pueden ejecutar el RPC (solo service_role).
do $$
declare
  ta uuid; tb uuid; ua uuid; ub uuid; ux uuid;
  dia20 bigint; dia21 bigint;
  fuera boolean; tenant_ajeno boolean;
  puede_anon boolean; puede_auth boolean; puede_service boolean;
begin
  insert into tenant (nombre) values ('ZZZ GPS 0205 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ GPS 0205 B') returning id into tb;
  insert into unidad (tenant_id, numero_economico, estado) values (ta, 'ZZZ-0205-A', 'disponible') returning id into ua;
  insert into unidad (tenant_id, numero_economico, estado) values (ta, 'ZZZ-0205-B', 'disponible') returning id into ub;
  insert into unidad (tenant_id, numero_economico, estado) values (tb, 'ZZZ-0205-X', 'disponible') returning id into ux;

  insert into posicion (tenant_id, unidad_id, lat, lng, medida_en, proveedor) values
    -- frontera de zona horaria: 05:59 UTC = 23:59 del día 20 en México
    (ta, ua, 19.6, -99.2, '2026-08-21 05:59:00+00', 'verificacion'),
    -- 06:00 UTC = 00:00 del día 21 en México
    (ta, ua, 19.6, -99.2, '2026-08-21 06:00:00+00', 'verificacion'),
    (ta, ua, 20.1, -99.8, '2026-08-21 18:00:00+00', 'verificacion'),
    -- día 19 MX: dentro del margen ±1 del filtro, FUERA del rango pedido
    (ta, ua, 19.6, -99.2, '2026-08-19 12:00:00+00', 'verificacion'),
    -- otra unidad del mismo tenant, mismo día: no presta conteo a la unidad A
    (ta, ub, 19.6, -99.2, '2026-08-21 12:00:00+00', 'verificacion'),
    -- tenant ajeno: no aparece ni pidiéndolo en el arreglo
    (tb, ux, 19.6, -99.2, '2026-08-21 12:00:00+00', 'verificacion');

  select coalesce(max(n) filter (where dia = '2026-08-20'), 0),
         coalesce(max(n) filter (where dia = '2026-08-21'), 0)
    into dia20, dia21
    from posiciones_por_unidad_dia(ta, array[ua], '2026-08-20', '2026-08-21')
   where unidad_id = ua;

  select exists (
    select 1 from posiciones_por_unidad_dia(ta, array[ua], '2026-08-20', '2026-08-21')
     where dia not between '2026-08-20' and '2026-08-21'
  ) into fuera;

  select exists (
    select 1 from posiciones_por_unidad_dia(ta, array[ua, ux], '2026-08-20', '2026-08-21')
     where unidad_id = ux
  ) into tenant_ajeno;

  puede_anon := has_function_privilege('anon', 'public.posiciones_por_unidad_dia(uuid, uuid[], date, date)', 'execute');
  puede_auth := has_function_privilege('authenticated', 'public.posiciones_por_unidad_dia(uuid, uuid[], date, date)', 'execute');
  puede_service := has_function_privilege('service_role', 'public.posiciones_por_unidad_dia(uuid, uuid[], date, date)', 'execute');

  raise exception 'GPS_POR_DIA_0205  dia20=%  dia21=%  fuera=%  tenant_ajeno=%  anon=%  auth=%  service=%   (esperado 1 / 2 / f / f / f / f / t)',
    dia20, dia21, fuera, tenant_ajeno, puede_anon, puede_auth, puede_service;
end $$;

-- ── 161. Eventos de cámara del cliente: idempotencia y doble candado (mig. 0203) ──
-- `evento_seguridad_flota` guarda lo que las cámaras del CLIENTE detectan.
-- La unicidad (tenant, proveedor, evento externo) es la idempotencia del
-- poller de ventana traslapada: releer no duplica NI vuelve a disparar el 🚨.
-- Y como toda tabla nueva con datos de flota: RLS deny-all + sin grants —
-- anon/authenticated rebotan por privilegio (-1), no "0 filas".
do $$
declare
  t uuid; v_op uuid; v_uni uuid; n_anon int; n_auth int;
  duplicado_rebota boolean; unidad_ajena_rebota boolean;
begin
  -- (a) Sin grant directo.
  begin
    set local role anon;
    select count(*) into n_anon from evento_seguridad_flota;
    reset role;
  exception when insufficient_privilege then
    reset role; n_anon := -1;
  end;
  begin
    set local role authenticated;
    select count(*) into n_auth from evento_seguridad_flota;
    reset role;
  exception when insufficient_privilege then
    reset role; n_auth := -1;
  end;

  -- (b) La idempotencia: el mismo (tenant, proveedor, evento) dos veces rebota.
  insert into tenant (nombre) values ('ZZZ EVENTOS 0203') returning id into t;
  insert into operador (tenant_id, nombre, telefono) values (t, 'P', '+520000000203') returning id into v_op;
  insert into unidad (tenant_id, numero_economico) values (t, 'ECO-0203') returning id into v_uni;
  insert into evento_seguridad_flota (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, grave, ocurrido_en)
    values (t, 'samsara', 'evt-0203-a', v_uni, array['Crash'], true, now());
  begin
    insert into evento_seguridad_flota (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, grave, ocurrido_en)
      values (t, 'samsara', 'evt-0203-a', v_uni, array['Crash'], true, now());
    duplicado_rebota := false;
  exception when unique_violation then
    duplicado_rebota := true;
  end;

  -- (c) La FK compuesta (unidad_id, tenant_id): una unidad de OTRA flota no
  --     se puede colgar aquí — el candado de la 0028/0145 en la tabla nueva.
  declare
    t2 uuid;
  begin
    insert into tenant (nombre) values ('ZZZ EVENTOS 0203 B') returning id into t2;
    begin
      insert into evento_seguridad_flota (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, ocurrido_en)
        values (t2, 'samsara', 'evt-0203-b', v_uni, array['Crash'], now());
      unidad_ajena_rebota := false;
    exception when foreign_key_violation then
      unidad_ajena_rebota := true;
    end;
  end;

  raise exception 'EVENTOS_CAMARA_0203  anon=%  authenticated=%  duplicado_rebota=%  unidad_ajena_rebota=%   (esperado -1 / -1 / t / t)',
    n_anon, n_auth, duplicado_rebota, unidad_ajena_rebota;
end $$;

-- ── 162. La mercancía de Carta Porte no cruza flotas, y el catálogo de agentes manda (mig. 0204) ──
-- Tres garantías que solo la base demuestra: (a) la FK COMPUESTA de
-- `viaje_mercancia` rebota una mercancía colgada del viaje de OTRA flota
-- aunque el insert traiga un viaje_id real; (b) los CHECKs de captura
-- (cantidad > 0, clave de 8 dígitos, CP de 5) rebotan basura antes de que un
-- borrador la tome por dato; (c) la mudanza CHECK → FK de las notificaciones
-- deja entrar a `carta_porte` (sembrado por la 0204) y rebota a un agente que
-- NADIE declaró en `agente_definicion`. De paso, el doble candado de permisos:
-- ni anon ni authenticated tocan `viaje_mercancia` directo.
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; va uuid; vb uuid;
  fk_cruzada boolean; cantidad_cero_rebota boolean; clave_corta_rebota boolean;
  cp_formato_rebota boolean; carta_porte_entra boolean; no_declarado_rebota boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ CCP A 0204') returning id into ta;
  insert into tenant (nombre) values ('ZZZ CCP B 0204') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'A', '+520000002041') returning id into oa;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'B', '+520000002042') returning id into ob;
  insert into viaje (tenant_id, operador_id) values (ta, oa) returning id into va;
  insert into viaje (tenant_id, operador_id) values (tb, ob) returning id into vb;

  -- (a) La flota A no puede colgar mercancía del viaje de la flota B.
  begin
    insert into viaje_mercancia (tenant_id, viaje_id, descripcion, cantidad)
      values (ta, vb, 'ajena', 1);
    fk_cruzada := false;
  exception when foreign_key_violation then
    fk_cruzada := true;
  end;

  -- La legítima sí entra (si esto truena, el bloque entero truena — bien).
  insert into viaje_mercancia (tenant_id, viaje_id, descripcion, bienes_transp, cantidad, clave_unidad, peso_kg, material_peligroso)
    values (ta, va, 'Cajas de aguacate', '50301700', 120, 'XBX', 1200, false);

  -- (b) Los CHECKs de captura.
  begin
    insert into viaje_mercancia (tenant_id, viaje_id, descripcion, cantidad) values (ta, va, 'cero', 0);
    cantidad_cero_rebota := false;
  exception when check_violation then
    cantidad_cero_rebota := true;
  end;
  begin
    insert into viaje_mercancia (tenant_id, viaje_id, descripcion, bienes_transp, cantidad) values (ta, va, 'clave corta', '1234', 1);
    clave_corta_rebota := false;
  exception when check_violation then
    clave_corta_rebota := true;
  end;
  begin
    update viaje set ccp_origen_cp = '6400' where id = va;
    cp_formato_rebota := false;
  exception when check_violation then
    cp_formato_rebota := true;
  end;

  -- (c) La FK de notificaciones: el declarado entra, el inventado no.
  begin
    insert into agente_notificacion_config (tenant_id, agente) values (ta, 'carta_porte');
    carta_porte_entra := true;
  exception when foreign_key_violation then
    carta_porte_entra := false;
  end;
  begin
    insert into agente_notificacion_config (tenant_id, agente) values (ta, 'agente_inventado');
    no_declarado_rebota := false;
  exception when foreign_key_violation then
    no_declarado_rebota := true;
  end;

  cerrado := not has_table_privilege('anon', 'public.viaje_mercancia', 'SELECT')
    and not has_table_privilege('authenticated', 'public.viaje_mercancia', 'INSERT')
    and has_table_privilege('service_role', 'public.viaje_mercancia', 'SELECT');

  raise exception 'CCP_MERCANCIA_0204  fk_cruzada=%  cantidad_cero_rebota=%  clave_corta_rebota=%  cp_formato_rebota=%  carta_porte_entra=%  no_declarado_rebota=%  cerrado=%   (esperado t / t / t / t / t / t / t)',
    fk_cruzada, cantidad_cero_rebota, clave_corta_rebota, cp_formato_rebota, carta_porte_entra, no_declarado_rebota, cerrado;
end $$;

-- ── 163. Un expediente de asistencia por unidad sin chofer (mig. 0206) ──
-- El espejo del 0201 para el caso de cámara sin viaje vigente: dos eventos
-- graves de la misma unidad en corridas solapadas no pueden abrir DOS
-- incidencias con DOS 🚨. Se comprueba además que NO compite con el candado
-- por chofer (operador_id puesto → rige el 0201, no este), que resolver
-- libera a la unidad, y que dos incidencias de oficina sin unidad ni
-- operador siguen sin chocar.
do $$
declare
  t uuid; v_op uuid; u uuid; inc1 uuid;
  segundo_rebota boolean; con_chofer_no_compite boolean;
  resuelta_libera boolean; sin_unidad_no_choca boolean;
begin
  insert into tenant (nombre) values ('ZZZ UNIDAD 0206') returning id into t;
  insert into operador (tenant_id, nombre, telefono) values (t, 'P', '+520000000206') returning id into v_op;
  insert into unidad (tenant_id, numero_economico, estado) values (t, 'ZZZ-0206-U1', 'disponible') returning id into u;

  -- (a) El segundo expediente abierto de la misma unidad SIN chofer rebota.
  insert into incidencia (tenant_id, unidad_id, tipo, prioridad)
    values (t, u, 'siniestro', 'critica') returning id into inc1;
  begin
    insert into incidencia (tenant_id, unidad_id, tipo, prioridad)
      values (t, u, 'siniestro', 'critica');
    segundo_rebota := false;
  exception when unique_violation then
    segundo_rebota := true;
  end;

  -- (b) Con chofer identificado NO compite: ahí rige el 0201 (por operador).
  begin
    insert into incidencia (tenant_id, unidad_id, operador_id, tipo, prioridad)
      values (t, u, v_op, 'siniestro', 'critica');
    con_chofer_no_compite := true;
  exception when unique_violation then
    con_chofer_no_compite := false;
  end;

  -- (c) Resolver el expediente libera a la unidad para el siguiente.
  update incidencia set estado = 'resuelta', resuelta_en = now() where id = inc1;
  begin
    insert into incidencia (tenant_id, unidad_id, tipo, prioridad)
      values (t, u, 'varado', 'alta');
    resuelta_libera := true;
  exception when unique_violation then
    resuelta_libera := false;
  end;

  -- (d) Dos incidencias de oficina (sin unidad NI operador) no chocan.
  insert into incidencia (tenant_id, tipo, prioridad) values (t, 'bloqueo', 'alta');
  begin
    insert into incidencia (tenant_id, tipo, prioridad) values (t, 'bloqueo', 'alta');
    sin_unidad_no_choca := true;
  exception when unique_violation then
    sin_unidad_no_choca := false;
  end;

  raise exception 'UNIDAD_UNICA_0206  segundo_rebota=%  con_chofer_no_compite=%  resuelta_libera=%  sin_unidad_no_choca=%   (esperado t / t / t / t)',
    segundo_rebota, con_chofer_no_compite, resuelta_libera, sin_unidad_no_choca;
end $$;

-- ── 164. El pacto de detención no cruza flotas y la presencia se mide con aritmética verificable (mig. 0207) ──
-- Lo que solo la base demuestra: (a) la FK COMPUESTA de `politica_detencion`
-- rebota un pacto colgado del cliente de OTRA flota; (b) los únicos parciales
-- dejan UN pacto de flota y UNO por cliente — el duplicado rebota, que es lo
-- que permite al escritor resolver la carrera con update; (c) los CHECKs
-- rebotan horas negativas y tarifa en cero (un pacto de $0/h no es un pacto,
-- es un invento); (d) `presencia_en_sitios` cuenta SOLO las posiciones dentro
-- del radio y de la ventana — la posición a 5 km o fuera de horario no
-- fabrica presencia; (e) el doble candado: ni anon ni authenticated tocan la
-- tabla ni ejecutan la función.
do $$
declare
  ta uuid; tb uuid; ca uuid; cb uuid; v_uni uuid; v_via uuid; v_op uuid;
  fk_cruzada boolean; flota_duplicada_rebota boolean; cliente_duplicado_rebota boolean;
  horas_negativas_rebotan boolean; tarifa_cero_rebota boolean;
  n_presencia bigint; primera_ok boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ DETENCION A 0207') returning id into ta;
  insert into tenant (nombre) values ('ZZZ DETENCION B 0207') returning id into tb;
  insert into cliente (tenant_id, nombre) values (ta, 'CEDIS A') returning id into ca;
  insert into cliente (tenant_id, nombre) values (tb, 'CEDIS B') returning id into cb;

  -- (a) El pacto de la flota A no puede colgarse del cliente de la flota B.
  begin
    insert into politica_detencion (tenant_id, cliente_id, horas_libres, tarifa_hora)
      values (ta, cb, 2, 500);
    fk_cruzada := false;
  exception when foreign_key_violation then
    fk_cruzada := true;
  end;

  -- Los legítimos sí entran (si esto truena, el bloque entero truena — bien).
  insert into politica_detencion (tenant_id, cliente_id, horas_libres, tarifa_hora) values (ta, null, 4, 300);
  insert into politica_detencion (tenant_id, cliente_id, horas_libres, tarifa_hora) values (ta, ca, 2, 500);

  -- (b) Un solo pacto vigente por alcance: el duplicado rebota.
  begin
    insert into politica_detencion (tenant_id, cliente_id, horas_libres) values (ta, null, 8);
    flota_duplicada_rebota := false;
  exception when unique_violation then
    flota_duplicada_rebota := true;
  end;
  begin
    insert into politica_detencion (tenant_id, cliente_id, horas_libres) values (ta, ca, 8);
    cliente_duplicado_rebota := false;
  exception when unique_violation then
    cliente_duplicado_rebota := true;
  end;

  -- (c) Los CHECKs.
  begin
    insert into politica_detencion (tenant_id, cliente_id, horas_libres) values (tb, cb, -1);
    horas_negativas_rebotan := false;
  exception when check_violation then
    horas_negativas_rebotan := true;
  end;
  begin
    insert into politica_detencion (tenant_id, cliente_id, tarifa_hora) values (tb, cb, 0);
    tarifa_cero_rebota := false;
  exception when check_violation then
    tarifa_cero_rebota := true;
  end;

  -- (d) La presencia medida: dos posiciones dentro del radio (≈22 m y ≈55 m
  --     del centro), una a ≈5.5 km y una dentro del radio pero FUERA de la
  --     ventana. Esperado: n=2 y la primera es la de las 10:05.
  insert into operador (tenant_id, nombre, telefono) values (ta, 'O', '+520000002071') returning id into v_op;
  insert into unidad (tenant_id, numero_economico) values (ta, 'ECO-0207') returning id into v_uni;
  insert into viaje (tenant_id, operador_id, unidad_id) values (ta, v_op, v_uni) returning id into v_via;
  insert into posicion (tenant_id, unidad_id, lat, lng, medida_en, proveedor) values
    (ta, v_uni, 21.0002, -89.0000, '2026-08-25T10:05:00Z', 'prueba'),
    (ta, v_uni, 21.0005, -89.0000, '2026-08-25T11:00:00Z', 'prueba'),
    (ta, v_uni, 21.0500, -89.0000, '2026-08-25T12:00:00Z', 'prueba'),
    (ta, v_uni, 21.0002, -89.0000, '2026-08-25T09:00:00Z', 'prueba');
  select n, (primera = '2026-08-25T10:05:00Z'::timestamptz) into n_presencia, primera_ok
    from presencia_en_sitios(ta, jsonb_build_array(jsonb_build_object(
      'viaje_id', v_via, 'unidad_id', v_uni,
      'desde', '2026-08-25T10:00:00Z', 'hasta', '2026-08-25T16:00:00Z',
      'lat', 21.0, 'lng', -89.0, 'radio_m', 200)));

  cerrado := not has_table_privilege('anon', 'public.politica_detencion', 'SELECT')
    and not has_table_privilege('authenticated', 'public.politica_detencion', 'INSERT')
    and has_table_privilege('service_role', 'public.politica_detencion', 'SELECT')
    and not has_function_privilege('authenticated', 'public.presencia_en_sitios(uuid, jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.presencia_en_sitios(uuid, jsonb)', 'EXECUTE');

  raise exception 'DETENCION_0207  fk_cruzada=%  flota_duplicada_rebota=%  cliente_duplicado_rebota=%  horas_negativas_rebotan=%  tarifa_cero_rebota=%  n_presencia=%  primera_ok=%  cerrado=%   (esperado t / t / t / t / t / 2 / t / t)',
    fk_cruzada, flota_duplicada_rebota, cliente_duplicado_rebota, horas_negativas_rebotan, tarifa_cero_rebota, n_presencia, primera_ok, cerrado;
end $$;

-- ── 166. El taller escribe con candados: una orden por avería, una abierta por rutina+unidad, y el experto fiscal vivo (mig. 0209) ──
-- Lo que solo la base demuestra: (a) la FK COMPUESTA rebota una orden colgada
-- de la avería de OTRA flota; (b) una avería abre a lo más UNA orden — el
-- reintento del webhook rebota; (c) una rutina sin ninguna cadencia rebota
-- (sin reloj no hay rutina), y la cadencia en cero también; (d) una rutina
-- con orden NO cerrada en una unidad no abre otra, y al cerrar la primera la
-- siguiente SÍ entra (el reloj continúa); (e) el nombre de rutina no se
-- duplica ni cambiando mayúsculas o espacios; (f) `experto_fiscal` quedó
-- 'vivo' en el catálogo — la Fase 9 encendida es una fila comprobable, no un
-- comentario; (g) el doble candado: ni anon ni authenticated tocan
-- `rutina_mantenimiento`.
do $$
declare
  ta uuid; tb uuid; u_a uuid; inc_a uuid; inc_b uuid; rut uuid;
  fk_cruzada boolean; segunda_orden_rebota boolean;
  rutina_sin_reloj_rebota boolean; cadencia_cero_rebota boolean;
  doble_abierta_rebota boolean; tras_cierre_entra boolean;
  nombre_duplicado_rebota boolean; fiscal_vivo boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ TALLER A 0209') returning id into ta;
  insert into tenant (nombre) values ('ZZZ TALLER B 0209') returning id into tb;
  insert into unidad (tenant_id, numero_economico) values (ta, 'ECO-0209') returning id into u_a;
  insert into incidencia (tenant_id, tipo, descripcion) values (ta, 'averia', 'se tronó la marcha') returning id into inc_a;
  insert into incidencia (tenant_id, tipo, descripcion) values (tb, 'averia', 'ajena') returning id into inc_b;

  -- (a) La orden de la flota A no puede colgarse de la avería de la flota B.
  begin
    insert into mantenimiento (tenant_id, unidad_id, tipo, incidencia_id)
      values (ta, u_a, 'correctivo', inc_b);
    fk_cruzada := false;
  exception when foreign_key_violation then
    fk_cruzada := true;
  end;

  -- La legítima entra; (b) el reintento de la MISMA avería rebota.
  insert into mantenimiento (tenant_id, unidad_id, tipo, incidencia_id)
    values (ta, u_a, 'correctivo', inc_a);
  begin
    insert into mantenimiento (tenant_id, unidad_id, tipo, incidencia_id)
      values (ta, u_a, 'correctivo', inc_a);
    segunda_orden_rebota := false;
  exception when unique_violation then
    segunda_orden_rebota := true;
  end;

  -- (c) Sin reloj no hay rutina; y un reloj de 0 días tampoco es reloj.
  begin
    insert into rutina_mantenimiento (tenant_id, nombre) values (ta, 'Sin reloj');
    rutina_sin_reloj_rebota := false;
  exception when check_violation then
    rutina_sin_reloj_rebota := true;
  end;
  begin
    insert into rutina_mantenimiento (tenant_id, nombre, cada_dias) values (ta, 'Cero', 0);
    cadencia_cero_rebota := false;
  exception when check_violation then
    cadencia_cero_rebota := true;
  end;

  -- (d) Una abierta por rutina+unidad; cerrada la primera, la nueva entra.
  insert into rutina_mantenimiento (tenant_id, nombre, cada_dias) values (ta, 'Servicio de motor', 180) returning id into rut;
  insert into mantenimiento (tenant_id, unidad_id, tipo, rutina_id) values (ta, u_a, 'preventivo', rut);
  begin
    insert into mantenimiento (tenant_id, unidad_id, tipo, rutina_id) values (ta, u_a, 'preventivo', rut);
    doble_abierta_rebota := false;
  exception when unique_violation then
    doble_abierta_rebota := true;
  end;
  update mantenimiento set estado = 'cerrada', cerrada_en = now(), km_servicio = 80000
    where tenant_id = ta and rutina_id = rut and estado <> 'cerrada';
  begin
    insert into mantenimiento (tenant_id, unidad_id, tipo, rutina_id) values (ta, u_a, 'preventivo', rut);
    tras_cierre_entra := true;
  exception when unique_violation then
    tras_cierre_entra := false;
  end;

  -- (e) El nombre no se duplica ni disfrazado.
  begin
    insert into rutina_mantenimiento (tenant_id, nombre, cada_km) values (ta, '  servicio DE motor ', 10000);
    nombre_duplicado_rebota := false;
  exception when unique_violation then
    nombre_duplicado_rebota := true;
  end;

  -- (f) La Fase 9 encendida es una fila, no un comentario.
  select (estado = 'vivo') into fiscal_vivo from agente_definicion where id = 'experto_fiscal';

  -- (g) Doble candado.
  cerrado := not has_table_privilege('anon', 'public.rutina_mantenimiento', 'SELECT')
    and not has_table_privilege('authenticated', 'public.rutina_mantenimiento', 'INSERT')
    and has_table_privilege('service_role', 'public.rutina_mantenimiento', 'SELECT');

  raise exception 'TALLER_0209  fk_cruzada=%  segunda_orden_rebota=%  rutina_sin_reloj_rebota=%  cadencia_cero_rebota=%  doble_abierta_rebota=%  tras_cierre_entra=%  nombre_duplicado_rebota=%  fiscal_vivo=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t)',
    fk_cruzada, segunda_orden_rebota, rutina_sin_reloj_rebota, cadencia_cero_rebota, doble_abierta_rebota, tras_cierre_entra, nombre_duplicado_rebota, fiscal_vivo, cerrado;
end $$;

-- ── 170. La coordinación con el proveedor: una viva por emergencia, y el expediente sobrevive al directorio (mig. 0213) ──
-- (Los bloques 167-169 quedaron reservados a fases paralelas que no
-- necesitaron SQL — hueco a propósito, como el 165.)
-- Lo que solo la base demuestra: (a) la FK COMPUESTA rebota una coordinación
-- colgada de la incidencia de OTRA flota; (b) el único parcial deja UNA
-- gestión viva por incidencia — el duplicado rebota, la descartada libera, y
-- la CONFIRMADA sigue bloqueando (dos servicios comprometidos para la misma
-- emergencia sería el bug caro); (c) los CHECKs rebotan eta en cero y precio
-- en cero (un ETA de 0 min o un servicio de $0 no son datos, son inventos);
-- (d) borrar el proveedor del directorio NO borra el expediente — el set
-- null acotado deja el snapshot citable; (e) el doble candado: ni anon ni
-- authenticated tocan la tabla.
do $$
declare
  ta uuid; tb uuid; inc_a uuid; inc_a2 uuid; inc_b uuid; prov uuid; coord uuid;
  fk_cruzada boolean; duplicada_rebota boolean; descartada_libera boolean;
  confirmada_bloquea boolean; eta_cero_rebota boolean; precio_cero_rebota boolean;
  snapshot_queda boolean; cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ COORDINACION A 0213') returning id into ta;
  insert into tenant (nombre) values ('ZZZ COORDINACION B 0213') returning id into tb;
  -- Incidencias "de oficina" (sin unidad ni operador): los candados 0201/0206
  -- no compiten aquí (el bloque 164 ya lo demostró).
  insert into incidencia (tenant_id, tipo, prioridad) values (ta, 'varado', 'alta') returning id into inc_a;
  insert into incidencia (tenant_id, tipo, prioridad) values (ta, 'varado', 'alta') returning id into inc_a2;
  insert into incidencia (tenant_id, tipo, prioridad) values (tb, 'varado', 'alta') returning id into inc_b;
  insert into proveedor_emergencia (tenant_id, tipo, nombre, telefono)
    values (ta, 'grua', 'Gruas Prueba 0213', '5299911122233') returning id into prov;

  -- (a) La coordinación de la flota A no puede colgarse de la incidencia de B.
  begin
    insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_nombre, proveedor_telefono, mensaje_preparado)
      values (ta, inc_b, 'Gruas Prueba 0213', '5299911122233', 'msj');
    fk_cruzada := false;
  exception when foreign_key_violation then
    fk_cruzada := true;
  end;

  -- La legítima sí entra (si esto truena, el bloque entero truena — bien).
  insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_id, proveedor_nombre, proveedor_telefono, mensaje_preparado)
    values (ta, inc_a, prov, 'Gruas Prueba 0213', '5299911122233', 'msj') returning id into coord;

  -- (b) Una gestión viva por incidencia: el duplicado rebota...
  begin
    insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_nombre, proveedor_telefono, mensaje_preparado)
      values (ta, inc_a, 'Otra Grua', '5299900000000', 'msj');
    duplicada_rebota := false;
  exception when unique_violation then
    duplicada_rebota := true;
  end;
  -- ...la descartada libera para el siguiente candidato...
  update coordinacion_proveedor set estado = 'descartada', decidida_en = now() where id = coord;
  begin
    insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_id, proveedor_nombre, proveedor_telefono, mensaje_preparado)
      values (ta, inc_a, prov, 'Otra Grua', '5299900000000', 'msj') returning id into coord;
    descartada_libera := true;
  exception when unique_violation then
    descartada_libera := false;
  end;
  -- ...y la CONFIRMADA sigue bloqueando.
  update coordinacion_proveedor set estado = 'confirmada', decidida_en = now() where id = coord;
  begin
    insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_nombre, proveedor_telefono, mensaje_preparado)
      values (ta, inc_a, 'Tercera Grua', '5299900000001', 'msj');
    confirmada_bloquea := false;
  exception when unique_violation then
    confirmada_bloquea := true;
  end;

  -- (c) Los CHECKs: cifras en cero no son datos.
  begin
    insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_nombre, proveedor_telefono, mensaje_preparado, eta_min)
      values (ta, inc_a2, 'Gruas Prueba 0213', '5299911122233', 'msj', 0);
    eta_cero_rebota := false;
  exception when check_violation then
    eta_cero_rebota := true;
  end;
  begin
    insert into coordinacion_proveedor (tenant_id, incidencia_id, proveedor_nombre, proveedor_telefono, mensaje_preparado, precio)
      values (ta, inc_a2, 'Gruas Prueba 0213', '5299911122233', 'msj', 0);
    precio_cero_rebota := false;
  exception when check_violation then
    precio_cero_rebota := true;
  end;

  -- (d) Borrar el proveedor del directorio deja el expediente con su snapshot
  -- (la confirmada apuntaba a `prov` — el set null acotado suelta la
  -- referencia y el nombre/teléfono capturados quedan).
  delete from proveedor_emergencia where id = prov;
  select (proveedor_id is null and proveedor_nombre = 'Otra Grua')
    into snapshot_queda
    from coordinacion_proveedor
    where tenant_id = ta and incidencia_id = inc_a and estado = 'confirmada';

  -- (e) El doble candado.
  cerrado := not has_table_privilege('anon', 'public.coordinacion_proveedor', 'SELECT')
    and not has_table_privilege('authenticated', 'public.coordinacion_proveedor', 'SELECT')
    and has_table_privilege('service_role', 'public.coordinacion_proveedor', 'SELECT');

  raise exception 'COORDINACION_0213  fk_cruzada=%  duplicada_rebota=%  descartada_libera=%  confirmada_bloquea=%  eta_cero_rebota=%  precio_cero_rebota=%  snapshot_queda=%  cerrado=%   (esperado t / t / t / t / t / t / t / t)',
    fk_cruzada, duplicada_rebota, descartada_libera, confirmada_bloquea, eta_cero_rebota, precio_cero_rebota, snapshot_queda, cerrado;
end $$;

-- ── 172. Los 4 agentes financieros vivos y su idempotencia por periodo (mig. 0215) ──
-- Lo que solo la base demuestra: (a) UN parte por (agente, periodo) — dos
-- corridas del runner que compitan por el mismo título lo resuelve el índice
-- único parcial, gana exactamente una; (b) la parcialidad es real: el
-- Redactor SÍ puede repetir título entre piezas (dos prospectos con el mismo
-- asunto son legítimos); (c) `finanzas_config` es UNA fila (el segundo INSERT
-- rebota por PK anclada a true) y el saldo sin fecha rebota (viajan juntos);
-- (d) el interruptor acepta `agente:control_costos` y sigue rechazando
-- basura; (e) los cuatro quedaron vivos, habilitados en el runner y CON
-- techo declarado — el candado 3 del runner es comprobable como fila; (f) el
-- doble candado: ni anon ni authenticated tocan `finanzas_config`.
do $$
declare
  parte_duplicado_rebota boolean; redactor_repite_ok boolean;
  segunda_config_rebota boolean; saldo_sin_fecha_rebota boolean;
  interruptor_acepta boolean; interruptor_rechaza boolean;
  vivos_con_techo int; cerrado boolean;
begin
  -- (a) El mismo periodo, dos veces: la segunda rebota.
  insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
    values ('parte_costos', 'control_costos', 'Costos — 2099-01-01', 'parte de prueba');
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('parte_costos', 'control_costos', 'Costos — 2099-01-01', 'parte repetido');
    parte_duplicado_rebota := false;
  exception when unique_violation then
    parte_duplicado_rebota := true;
  end;

  -- (b) La parcialidad: el Redactor repite título sin rebotar.
  insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
    values ('correo_frio', 'redactor', 'Asunto repetible 0215', 'pieza 1');
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('correo_frio', 'redactor', 'Asunto repetible 0215', 'pieza 2');
    redactor_repite_ok := true;
  exception when unique_violation then
    redactor_repite_ok := false;
  end;

  -- (c) Una sola config; y saldo sin fecha rebota.
  --     (id=true explícito en el duplicado: el default ya es true — el
  --     rebote debe venir de la PK, no de una casualidad.)
  insert into finanzas_config (saldo_mxn, saldo_fecha) values (100000, '2099-01-01')
    on conflict (id) do nothing;
  begin
    insert into finanzas_config (id, fijos_mxn) values (true, 6500);
    segunda_config_rebota := false;
  exception when unique_violation then
    segunda_config_rebota := true;
  end;
  begin
    update finanzas_config set saldo_mxn = 5, saldo_fecha = null where id;
    saldo_sin_fecha_rebota := false;
  exception when check_violation then
    saldo_sin_fecha_rebota := true;
  end;

  -- (d) El dominio del interruptor, en las dos direcciones.
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:control_costos', true, 'prueba 0215');
    interruptor_acepta := true;
    delete from interruptor where id = 'agente:control_costos' and motivo = 'prueba 0215';
  exception when check_violation then
    interruptor_acepta := false;
  end;
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:inventado_0215', true, 'basura');
    interruptor_rechaza := false;
  exception when check_violation then
    interruptor_rechaza := true;
  end;

  -- (e) Los cuatro, vivos + habilitados + con techo (candado 3 del runner).
  select count(*) into vivos_con_techo from agente_definicion
    where id in ('analista_metricas', 'control_costos', 'tesoreria', 'cierre_mensual')
      and estado = 'vivo' and runner_habilitado and presupuesto_dia_usd > 0;

  -- (f) El doble candado.
  cerrado := not has_table_privilege('anon', 'public.finanzas_config', 'SELECT')
    and not has_table_privilege('authenticated', 'public.finanzas_config', 'SELECT')
    and has_table_privilege('service_role', 'public.finanzas_config', 'SELECT');

  raise exception 'FINANZAS_0215  parte_duplicado_rebota=%  redactor_repite_ok=%  segunda_config_rebota=%  saldo_sin_fecha_rebota=%  interruptor_acepta=%  interruptor_rechaza=%  vivos_con_techo=%  cerrado=%   (esperado t / t / t / t / t / t / 4 / t)',
    parte_duplicado_rebota, redactor_repite_ok, segunda_config_rebota, saldo_sin_fecha_rebota,
    interruptor_acepta, interruptor_rechaza, vivos_con_techo, cerrado;
end $$;

-- ── 173. La dirección: un reporte por (agente, periodo), sellado y cerrado (mig. 0216) ──
-- Lo que solo la base demuestra del sello de los reportes de dirección:
--   (a) el catálogo manda — un reporte de un agente NO declarado rebota (FK
--       a agente_definicion, patrón 0116);
--   (b) la idempotencia es el unique (agente, periodo): la carrera de dos
--       pasadas del runner la gana exactamente una;
--   (c) el periodo tiene forma fija ('dia-'/'lun-' + fecha) — dos ortografías
--       del mismo día serían dos sellos y el candado dejaría pasar el doble
--       correo que existe para impedir;
--   (d) los cuatro agentes de dirección quedaron VIVOS con techo declarado y
--       palanca en el dominio del interruptor (candados 1 y 3 del runner);
--   (e) la tabla está en deny-all: RLS activa, cero policies — solo el
--       servidor la toca, como prospecto (0105) y cola_aprobacion (0117).
do $$
declare
  fk_rebota boolean; dup_rebota boolean; periodo_rebota boolean;
  vivos_con_techo boolean; palancas_en_dominio boolean; rls_cerrada boolean;
begin
  -- (a) Un autor no declarado no sella nada.
  begin
    insert into reporte_direccion (agente, periodo, cuerpo)
      values ('agente_fantasma_0216', 'dia-2026-01-01', 'x');
    fk_rebota := false;
  exception when foreign_key_violation then
    fk_rebota := true;
  end;

  -- (b) El mismo periodo del mismo agente sella UNA vez.
  insert into reporte_direccion (agente, periodo, cuerpo)
    values ('kpi_whatsapp', 'dia-2026-01-01', 'reporte de prueba 0216');
  begin
    insert into reporte_direccion (agente, periodo, cuerpo)
      values ('kpi_whatsapp', 'dia-2026-01-01', 'el doble que no debe salir');
    dup_rebota := false;
  exception when unique_violation then
    dup_rebota := true;
  end;

  -- (c) Un periodo con forma libre no entra.
  begin
    insert into reporte_direccion (agente, periodo, cuerpo)
      values ('orquestador', 'semana-1', 'x');
    periodo_rebota := false;
  exception when check_violation then
    periodo_rebota := true;
  end;

  -- (d) El flip de la 0216: vivos, habilitados, con techo — y con palanca.
  select count(*) = 4 into vivos_con_techo
    from agente_definicion
    where id in ('kpi_whatsapp', 'desempeno_startup', 'orquestador', 'orquestador_semanal')
      and estado = 'vivo' and runner_habilitado and presupuesto_dia_usd > 0;
  begin
    insert into interruptor (id, apagado, motivo)
      values ('agente:orquestador', true, 'prueba 0216');
    palancas_en_dominio := true;
  exception when check_violation then
    palancas_en_dominio := false;
  end;

  -- (e) Deny-all de verdad: RLS activa y cero policies.
  select c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    into rls_cerrada
    from pg_class c
    where c.oid = 'public.reporte_direccion'::regclass;

  raise exception 'REPORTE_DIRECCION_0216  fk_rebota=%  dup_rebota=%  periodo_rebota=%  vivos_con_techo=%  palancas_en_dominio=%  rls_cerrada=%   (esperado t / t / t / t / t / t)',
    fk_rebota, dup_rebota, periodo_rebota, vivos_con_techo, palancas_en_dominio, rls_cerrada;
end $$;

-- ── 174. La máquina de prospección: correos con fuente y sin duplicar, la lista de bajas y sus candados (mig. 0217) ──
-- (El 171 quedó reservado a una ola paralela que no necesitó SQL — hueco a
-- propósito, como el 165 y los 167-169.)
-- Lo que solo la base demuestra: (a) `prospecto_correo_unico` — el mismo
-- correo de la misma empresa entra UNA vez sin importar mayúsculas (el
-- investigador corre a diario; su duplicado rebota en el índice, no en un
-- `if`), y el mismo correo en OTRA empresa sí entra; (b) el CHECK de formato
-- rebota lo que no es un correo, y el de fuente rebota la fuente vacía — un
-- correo sin fuente es un correo inventado; (c) `correo_suprimido` es PK (la
-- baja doble es una) y el CHECK de minúsculas rebota la variante en
-- mayúsculas que se colaría como "otra" dirección; (d) el dossier es UNO por
-- prospecto (PK): el segundo insert rebota — el último gana por upsert, no
-- por duplicado; (e) el CHECK de interruptores acepta los tres kill switches
-- nuevos y sigue rebotando el nombre inventado; (f) el doble candado: ni
-- anon ni authenticated tocan las tres tablas nuevas.
do $$
declare
  pra uuid; prb uuid;
  dup_rebota boolean; otra_empresa_entra boolean; formato_rebota boolean;
  fuente_vacia_rebota boolean; baja_doble_es_una boolean; mayusculas_rebota boolean;
  dossier_unico boolean; switch_nuevo_entra boolean; switch_inventado_rebota boolean;
  cerrado boolean;
begin
  insert into prospecto (empresa) values ('ZZZ PROSPECCION A 0217') returning id into pra;
  insert into prospecto (empresa) values ('ZZZ PROSPECCION B 0217') returning id into prb;

  -- (a) El mismo correo, la misma empresa, dos grafías: una sola fila.
  insert into prospecto_correo (prospecto_id, correo, fuente)
    values (pra, 'ventas@zzz0217.mx', 'https://zzz0217.mx/contacto');
  begin
    insert into prospecto_correo (prospecto_id, correo, fuente)
      values (pra, 'VENTAS@zzz0217.mx', 'https://zzz0217.mx/nosotros');
    dup_rebota := false;
  exception when unique_violation then
    dup_rebota := true;
  end;
  begin
    insert into prospecto_correo (prospecto_id, correo, fuente)
      values (prb, 'ventas@zzz0217.mx', 'https://zzz0217.mx/contacto');
    otra_empresa_entra := true;
  exception when unique_violation then
    otra_empresa_entra := false;
  end;

  -- (b) Formato y fuente: lo roto y lo sin-fuente no entran.
  begin
    insert into prospecto_correo (prospecto_id, correo, fuente)
      values (pra, 'no-es-correo', 'https://zzz0217.mx');
    formato_rebota := false;
  exception when check_violation then
    formato_rebota := true;
  end;
  begin
    insert into prospecto_correo (prospecto_id, correo, fuente)
      values (pra, 'otro@zzz0217.mx', '   ');
    fuente_vacia_rebota := false;
  exception when check_violation then
    fuente_vacia_rebota := true;
  end;

  -- (c) La lista de bajas: la doble es una, y solo minúsculas.
  insert into correo_suprimido (correo, motivo) values ('baja@zzz0217.mx', 'rebote (prueba)');
  begin
    insert into correo_suprimido (correo, motivo) values ('baja@zzz0217.mx', 'queja (prueba)');
    baja_doble_es_una := false;
  exception when unique_violation then
    baja_doble_es_una := true;
  end;
  begin
    insert into correo_suprimido (correo, motivo) values ('BAJA2@zzz0217.mx', 'rebote (prueba)');
    mayusculas_rebota := false;
  exception when check_violation then
    mayusculas_rebota := true;
  end;

  -- (d) Un dossier por prospecto: el segundo INSERT rebota (el último gana
  -- por upsert, no acumulando filas).
  insert into prospecto_dossier (prospecto_id, fuentes) values (pra, '["https://zzz0217.mx"]'::jsonb);
  begin
    insert into prospecto_dossier (prospecto_id, fuentes) values (pra, '[]'::jsonb);
    dossier_unico := false;
  exception when unique_violation then
    dossier_unico := true;
  end;

  -- (e) Los kill switches nuevos entran; el inventado sigue rebotando.
  begin
    insert into interruptor (id) values ('agente:enviador');
    insert into interruptor (id) values ('agente:enriquecedor');
    insert into interruptor (id) values ('agente:sdr');
    switch_nuevo_entra := true;
  exception when check_violation then
    switch_nuevo_entra := false;
  end;
  begin
    insert into interruptor (id) values ('agente:inventado');
    switch_inventado_rebota := false;
  exception when check_violation then
    switch_inventado_rebota := true;
  end;

  -- (f) El doble candado en las tres tablas nuevas.
  cerrado := not has_table_privilege('anon', 'public.prospecto_correo', 'SELECT')
    and not has_table_privilege('authenticated', 'public.prospecto_correo', 'SELECT')
    and has_table_privilege('service_role', 'public.prospecto_correo', 'SELECT')
    and not has_table_privilege('anon', 'public.prospecto_dossier', 'SELECT')
    and not has_table_privilege('authenticated', 'public.prospecto_dossier', 'SELECT')
    and has_table_privilege('service_role', 'public.prospecto_dossier', 'SELECT')
    and not has_table_privilege('anon', 'public.correo_suprimido', 'SELECT')
    and not has_table_privilege('authenticated', 'public.correo_suprimido', 'SELECT')
    and has_table_privilege('service_role', 'public.correo_suprimido', 'SELECT');

  raise exception 'PROSPECCION_0217  dup_rebota=%  otra_empresa_entra=%  formato_rebota=%  fuente_vacia_rebota=%  baja_doble_es_una=%  mayusculas_rebota=%  dossier_unico=%  switch_nuevo_entra=%  switch_inventado_rebota=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t)',
    dup_rebota, otra_empresa_entra, formato_rebota, fuente_vacia_rebota, baja_doble_es_una, mayusculas_rebota, dossier_unico, switch_nuevo_entra, switch_inventado_rebota, cerrado;
end $$;

-- ── 176. Éxito del cliente: una pieza por periodo, y los seis con palanca, reloj y techo (mig. 0218) ──
-- Lo que solo la base demuestra: (a) UNA pieza por (agente, título) — dos
-- pasadas del runner que compitan por el mismo parte las resuelve el índice
-- único parcial, gana exactamente una; (b) la parcialidad es real: el
-- Redactor SÍ puede repetir título entre piezas (dos prospectos con el mismo
-- asunto de campaña son legítimos); (c) el interruptor acepta los seis kill
-- switches nuevos Y SIGUE aceptando los de las olas anteriores — recrear el
-- CHECK enumerando solo los propios habría borrado en silencio las palancas
-- de la 0215/0216/0217, que es el modo de falla que este bloque existe para
-- cazar; (d) y sigue rechazando un id inventado; (e) los seis quedaron
-- vivos, habilitados, disparados por reloj y CON techo declarado: el candado
-- 3 del runner, comprobable como fila; (f) una pieza de un agente NO
-- declarado no entra a la cola — la FK contra agente_definicion es la
-- trazabilidad mínima de quién preparó qué.
do $$
declare
  pieza_duplicada_rebota boolean; redactor_repite_ok boolean;
  switches_nuevos_entran boolean; switches_previos_siguen boolean;
  switch_inventado_rebota boolean; agente_no_declarado_rebota boolean;
  vivos_con_techo int; en_cron int;
  s text;
begin
  -- (a) Dos partes del mismo agente y periodo: el segundo rebota.
  insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
    values ('parte_onboarding', 'onboarding_cliente', 'Onboarding — 2026-08-27', 'cuerpo');
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('parte_onboarding', 'onboarding_cliente', 'Onboarding — 2026-08-27', 'otro cuerpo');
    pieza_duplicada_rebota := false;
  exception when unique_violation then
    pieza_duplicada_rebota := true;
  end;

  -- (b) El Redactor NO entra al índice parcial: repetir asunto es legítimo.
  insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
    values ('correo_frio', 'redactor', 'Mismo asunto de campaña', 'uno');
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('correo_frio', 'redactor', 'Mismo asunto de campaña', 'dos');
    redactor_repite_ok := true;
  exception when unique_violation then
    redactor_repite_ok := false;
  end;

  -- (c) Los seis nuevos entran…
  switches_nuevos_entran := true;
  foreach s in array array['agente:onboarding_cliente', 'agente:exito_cliente', 'agente:retencion',
                           'agente:cobranza_saas', 'agente:soporte', 'agente:atencion_faq'] loop
    begin
      insert into interruptor (id, apagado, motivo) values (s, true, 'prueba 0218');
    exception when check_violation then
      switches_nuevos_entran := false;
    end;
  end loop;

  -- …y las palancas de las olas anteriores siguen vivas.
  switches_previos_siguen := true;
  foreach s in array array['agente:liquidacion', 'agente:redactor', 'agente:control_costos',
                           'agente:orquestador_semanal', 'agente:enviador'] loop
    begin
      insert into interruptor (id, apagado, motivo) values (s, true, 'prueba 0218');
    exception when check_violation then
      switches_previos_siguen := false;
    end;
  end loop;

  -- (d) Un id fuera del catálogo sigue rebotando.
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:inventado_0218', true, 'basura');
    switch_inventado_rebota := false;
  exception when check_violation then
    switch_inventado_rebota := true;
  end;

  -- (e) Los seis: vivos + habilitados + con techo, y por reloj.
  select count(*) into vivos_con_techo from agente_definicion
    where id in ('onboarding_cliente', 'exito_cliente', 'retencion', 'cobranza_saas', 'soporte', 'atencion_faq')
      and estado = 'vivo' and runner_habilitado and presupuesto_dia_usd > 0;
  select count(*) into en_cron from agente_definicion
    where id in ('onboarding_cliente', 'exito_cliente', 'retencion', 'cobranza_saas', 'soporte', 'atencion_faq')
      and disparador = 'cron';

  -- (f) Un agente sin declarar no deja pieza en la cola.
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('parte_onboarding', 'agente_fantasma_0218', 'sin autor declarado', 'y');
    agente_no_declarado_rebota := false;
  exception when foreign_key_violation then
    agente_no_declarado_rebota := true;
  end;

  raise exception 'EXITO_CLIENTE_0218  pieza_duplicada_rebota=%  redactor_repite_ok=%  switches_nuevos_entran=%  switches_previos_siguen=%  switch_inventado_rebota=%  vivos_con_techo=%  en_cron=%  agente_no_declarado_rebota=%   (esperado t / t / t / t / t / 6 / 6 / t)',
    pieza_duplicada_rebota, redactor_repite_ok, switches_nuevos_entran, switches_previos_siguen,
    switch_inventado_rebota, vivos_con_techo, en_cron, agente_no_declarado_rebota;
end $$;

-- ── 177. El back office restante: un parte por periodo, el registro de talento y sus candados (mig. 0219) ──
-- Lo que solo la base demuestra del flip de los cuatro últimos del back
-- office: (a) `cola_parte_backoffice_por_periodo` — dos pasadas del runner
-- que compitan por el parte de la misma semana las resuelve el índice único
-- parcial: gana exactamente una; (b) la parcialidad es real y el índice es
-- por (agente, titulo): DOS agentes distintos con el MISMO título entran los
-- dos, y el Redactor sigue pudiendo repetir asunto; (c) los cuatro quedaron
-- vivos, habilitados, con techo y disparando por reloj — los candados 2 y 3
-- del runner, comprobables como fila; (d) el CHECK del interruptor acepta las
-- cuatro palancas nuevas y sigue rechazando el nombre inventado; (e) el
-- pendiente societario se siembra SIN fecha objetivo (la migración no
-- inventa un compromiso) y su coherencia de cierre rebota el 'cerrado' sin
-- fecha; (f) `candidato` no admite el mismo correo dos veces en la misma
-- vacante, ni un puntaje fuera de 0-100, ni un estado avanzado sin
-- `cribado_en`; (g) el doble candado sobre las tres tablas nuevas: ni anon ni
-- authenticated las tocan, service_role sí.
do $$
declare
  v uuid;
  parte_duplicado_rebota boolean; otro_agente_mismo_titulo_ok boolean;
  vivos_listos int; switch_nuevo_entra boolean; switch_inventado_rebota boolean;
  societarios_sin_fecha int; cierre_sin_fecha_rebota boolean;
  correo_repetido_rebota boolean; puntaje_fuera_rebota boolean; criba_incoherente_rebota boolean;
  cerrado boolean;
begin
  -- (a) El mismo parte de la misma semana, dos veces: la segunda rebota.
  insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
    values ('parte_calidad', 'vigilante_calidad', 'Calidad — semana del 2099-01-05', 'parte de prueba');
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('parte_calidad', 'vigilante_calidad', 'Calidad — semana del 2099-01-05', 'el doble');
    parte_duplicado_rebota := false;
  exception when unique_violation then
    parte_duplicado_rebota := true;
  end;

  -- (b) El índice es por (agente, titulo): otro agente con el mismo título sí.
  begin
    insert into cola_aprobacion (tipo, agente, titulo, cuerpo)
      values ('parte_documentacion', 'documentacion', 'Calidad — semana del 2099-01-05', 'otro autor');
    otro_agente_mismo_titulo_ok := true;
  exception when unique_violation then
    otro_agente_mismo_titulo_ok := false;
  end;

  -- (c) El flip de la 0219: vivos, habilitados, con techo y por reloj.
  select count(*) into vivos_listos from agente_definicion
    where id in ('vigilante_calidad', 'documentacion', 'legal_compliance', 'talento')
      and estado = 'vivo' and runner_habilitado and disparador = 'cron'
      and presupuesto_dia_usd > 0;

  -- (d) El dominio del interruptor, en las dos direcciones.
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:legal_compliance', true, 'prueba 0219');
    switch_nuevo_entra := true;
  exception when check_violation then
    switch_nuevo_entra := false;
  end;
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:inventado_0219', true, 'basura');
    switch_inventado_rebota := false;
  exception when check_violation then
    switch_inventado_rebota := true;
  end;

  -- (e) Los societarios sembrados van SIN fecha; y cerrar sin fecha rebota.
  select count(*) into societarios_sin_fecha from pendiente_societario
    where id in ('sapi', 'marca_impi') and fecha_objetivo is null;
  begin
    update pendiente_societario set estado = 'cerrado' where id = 'sapi';
    cierre_sin_fecha_rebota := false;
  exception when check_violation then
    cierre_sin_fecha_rebota := true;
  end;

  -- (f) El registro de talento y sus tres candados.
  insert into vacante (clave, titulo) values ('contador-0219', 'Contador de prueba') returning id into v;
  insert into candidato (vacante_id, nombre, correo) values (v, 'Ana', 'ana@ejemplo.mx');
  begin
    insert into candidato (vacante_id, nombre, correo) values (v, 'Ana otra vez', 'ana@ejemplo.mx');
    correo_repetido_rebota := false;
  exception when unique_violation then
    correo_repetido_rebota := true;
  end;
  begin
    insert into candidato (vacante_id, nombre, correo, puntaje) values (v, 'Beto', 'beto@ejemplo.mx', 140);
    puntaje_fuera_rebota := false;
  exception when check_violation then
    puntaje_fuera_rebota := true;
  end;
  begin
    insert into candidato (vacante_id, nombre, correo, estado) values (v, 'Ceci', 'ceci@ejemplo.mx', 'cribado');
    criba_incoherente_rebota := false;
  exception when check_violation then
    criba_incoherente_rebota := true;
  end;

  -- (g) El doble candado sobre las tres tablas nuevas.
  cerrado := not has_table_privilege('anon', 'public.vacante', 'SELECT')
    and not has_table_privilege('authenticated', 'public.vacante', 'SELECT')
    and has_table_privilege('service_role', 'public.vacante', 'SELECT')
    and not has_table_privilege('anon', 'public.candidato', 'SELECT')
    and not has_table_privilege('authenticated', 'public.candidato', 'SELECT')
    and has_table_privilege('service_role', 'public.candidato', 'SELECT')
    and not has_table_privilege('anon', 'public.pendiente_societario', 'SELECT')
    and not has_table_privilege('authenticated', 'public.pendiente_societario', 'SELECT')
    and has_table_privilege('service_role', 'public.pendiente_societario', 'SELECT');

  raise exception 'BACKOFFICE_0219  parte_duplicado_rebota=%  otro_agente_mismo_titulo_ok=%  vivos_listos=%  switch_nuevo_entra=%  switch_inventado_rebota=%  societarios_sin_fecha=%  cierre_sin_fecha_rebota=%  correo_repetido_rebota=%  puntaje_fuera_rebota=%  criba_incoherente_rebota=%  cerrado=%   (esperado t / t / 4 / t / t / 2 / t / t / t / t / t)',
    parte_duplicado_rebota, otro_agente_mismo_titulo_ok, vivos_listos,
    switch_nuevo_entra, switch_inventado_rebota, societarios_sin_fecha, cierre_sin_fecha_rebota,
    correo_repetido_rebota, puntaje_fuera_rebota, criba_incoherente_rebota, cerrado;
end $$;

-- ── 178. El cotizador: costos declarados con candados, y la cotización decidida UNA vez (mig. 0225) ──
-- (El bloque 175 sigue reservado a una ola paralela — hueco a propósito,
-- como el 165, 167-169 y 171. El 176 lo tomó la 0218 y el 177 la 0219.)
-- Lo que solo la base demuestra: (a) `cotizador_config` es UNA fila por
-- flota — la segunda rebota por PK; (b) los CHECKs de sanidad rebotan el
-- factor de regreso fuera de 1–3 y el margen fuera de 0–90 (un factor 4 o
-- un margen 200 cotizarían fantasía con cara de política); (c) el CHECK
-- `cotizacion_ganada_completa` de la 0051 sigue vivo con las columnas
-- nuevas: 'ganada' sin precio o sin viaje rebota; (d) el desglose jsonb y el
-- claim `decidida_en` existen y aceptan escritura; (e) el doble candado:
-- ni anon ni authenticated tocan `cotizador_config`.
do $$
declare
  ta uuid;
  segunda_config_rebota boolean; factor_alto_rebota boolean; margen_alto_rebota boolean;
  ganada_incompleta_rebota boolean; desglose_entra boolean; cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ COTIZADOR 0225') returning id into ta;

  -- (a) Una config por flota.
  insert into cotizador_config (tenant_id, diesel_por_km) values (ta, 12.5);
  begin
    insert into cotizador_config (tenant_id, salario_dia) values (ta, 800);
    segunda_config_rebota := false;
  exception when unique_violation then
    segunda_config_rebota := true;
  end;

  -- (b) Los CHECKs de sanidad.
  begin
    update cotizador_config set factor_regreso_vacio = 4 where tenant_id = ta;
    factor_alto_rebota := false;
  exception when check_violation then
    factor_alto_rebota := true;
  end;
  begin
    update cotizador_config set margen_objetivo_pct = 200 where tenant_id = ta;
    margen_alto_rebota := false;
  exception when check_violation then
    margen_alto_rebota := true;
  end;

  -- (c) 'ganada' exige precio Y viaje — el candado de la 0051, intacto.
  begin
    insert into cotizacion (tenant_id, origen, destino, estado)
      values (ta, 'León', 'CDMX', 'ganada');
    ganada_incompleta_rebota := false;
  exception when check_violation then
    ganada_incompleta_rebota := true;
  end;

  -- (d) El desglose citable y el claim entran.
  begin
    insert into cotizacion (tenant_id, origen, destino, estado, desglose, decidida_en)
      values (ta, 'León', 'CDMX', 'borrador',
              '{"lineas":[{"concepto":"Diésel","monto":100,"supuesto":"prueba"}],"costoTotal":100,"faltantes":[],"precioSugerido":120,"notas":[]}'::jsonb,
              now());
    desglose_entra := true;
  exception when others then
    desglose_entra := false;
  end;

  -- (e) El doble candado.
  cerrado := not has_table_privilege('anon', 'public.cotizador_config', 'SELECT')
    and not has_table_privilege('authenticated', 'public.cotizador_config', 'SELECT')
    and has_table_privilege('service_role', 'public.cotizador_config', 'SELECT');

  raise exception 'COTIZADOR_0225  segunda_config_rebota=%  factor_alto_rebota=%  margen_alto_rebota=%  ganada_incompleta_rebota=%  desglose_entra=%  cerrado=%   (esperado t / t / t / t / t / t)',
    segunda_config_rebota, factor_alto_rebota, margen_alto_rebota, ganada_incompleta_rebota, desglose_entra, cerrado;
end $$;

-- ── 179. El timbre: uno vigente por viaje, uuid único, formas y doble candado (mig. 0226) ──
-- Lo que solo la base demuestra: (a) UN timbre vigente por viaje — el doble
-- clic lo resuelve el índice parcial, gana exactamente uno; (b) cancelado
-- LIBERA: tras cancelar, el re-timbre de la corrección entra; (c) el mismo
-- uuid fiscal no entra dos veces (ni cambiando mayúsculas) — el reintento de
-- un timbre ya aceptado rebota en la base; (d) la FK compuesta: un timbre no
-- se cuelga del viaje de OTRA flota; (e) las formas del perfil fiscal: RFC
-- torcido y régimen de 2 dígitos rebotan, y el modo solo admite
-- sandbox/produccion; (f) el doble candado en las dos tablas nuevas.
do $$
declare
  ta uuid; tb uuid; va uuid; vb uuid; op_a uuid; op_b uuid;
  segundo_vigente_rebota boolean; recancelado_entra boolean;
  uuid_repetido_rebota boolean; cruzado_rebota boolean;
  rfc_torcido_rebota boolean; regimen_corto_rebota boolean; modo_basura_rebota boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0226 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0226 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'Op 0226 A', '+5215550002261') returning id into op_a;
  -- Dos operadores: `uq_viaje_abierto_por_operador` no admite dos viajes
  -- abiertos del mismo chofer, y este bloque necesita dos viajes vivos.
  insert into operador (tenant_id, nombre, telefono) values (ta, 'Op 0226 B', '+5215550002262') returning id into op_b;
  insert into viaje (tenant_id, operador_id) values (ta, op_a) returning id into va;
  insert into viaje (tenant_id, operador_id) values (ta, op_b) returning id into vb;

  -- (a) Dos timbres vigentes del mismo viaje: el segundo rebota.
  insert into ccp_timbre (tenant_id, viaje_id, uuid_fiscal, proveedor, modo, fecha_timbrado, xml)
    values (ta, va, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', 'sw', 'sandbox', now(), '<xml/>');
  begin
    insert into ccp_timbre (tenant_id, viaje_id, uuid_fiscal, proveedor, modo, fecha_timbrado, xml)
      values (ta, va, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', 'sw', 'sandbox', now(), '<xml/>');
    segundo_vigente_rebota := false;
  exception when unique_violation then
    segundo_vigente_rebota := true;
  end;

  -- (b) Cancelar libera el viaje para el re-timbre de la corrección.
  update ccp_timbre set estado = 'cancelado'
    where tenant_id = ta and viaje_id = va and uuid_fiscal = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
  begin
    insert into ccp_timbre (tenant_id, viaje_id, uuid_fiscal, proveedor, modo, fecha_timbrado, xml)
      values (ta, va, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', 'sw', 'sandbox', now(), '<xml/>');
    recancelado_entra := true;
  exception when unique_violation then
    recancelado_entra := false;
  end;

  -- (c) El mismo uuid fiscal, en mayúsculas, en otro viaje: rebota igual.
  begin
    insert into ccp_timbre (tenant_id, viaje_id, uuid_fiscal, proveedor, modo, fecha_timbrado, xml)
      values (ta, vb, 'AAAAAAAA-BBBB-4CCC-8DDD-000000000002', 'sw', 'sandbox', now(), '<xml/>');
    uuid_repetido_rebota := false;
  exception when unique_violation then
    uuid_repetido_rebota := true;
  end;

  -- (d) El timbre de la flota B sobre el viaje de la flota A: la FK compuesta
  -- lo rebota (foreign_key_violation, no un filtro de app).
  begin
    insert into ccp_timbre (tenant_id, viaje_id, uuid_fiscal, proveedor, modo, fecha_timbrado, xml)
      values (tb, va, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003', 'sw', 'sandbox', now(), '<xml/>');
    cruzado_rebota := false;
  exception when foreign_key_violation then
    cruzado_rebota := true;
  end;

  -- (e) Las formas del perfil del emisor y el dominio del modo.
  begin
    insert into flota_fiscal (tenant_id, rfc) values (tb, 'no-es-rfc');
    rfc_torcido_rebota := false;
  exception when check_violation then
    rfc_torcido_rebota := true;
  end;
  begin
    insert into flota_fiscal (tenant_id, regimen_fiscal) values (tb, '61');
    regimen_corto_rebota := false;
  exception when check_violation then
    regimen_corto_rebota := true;
  end;
  begin
    insert into flota_fiscal (tenant_id, modo) values (tb, 'demo');
    modo_basura_rebota := false;
  exception when check_violation then
    modo_basura_rebota := true;
  end;

  -- (f) El doble candado en las dos tablas nuevas.
  cerrado := not has_table_privilege('anon', 'public.flota_fiscal', 'SELECT')
    and not has_table_privilege('authenticated', 'public.flota_fiscal', 'SELECT')
    and has_table_privilege('service_role', 'public.flota_fiscal', 'SELECT')
    and not has_table_privilege('anon', 'public.ccp_timbre', 'SELECT')
    and not has_table_privilege('authenticated', 'public.ccp_timbre', 'SELECT')
    and has_table_privilege('service_role', 'public.ccp_timbre', 'SELECT');

  raise exception 'TIMBRE_0226  segundo_vigente_rebota=%  recancelado_entra=%  uuid_repetido_rebota=%  cruzado_rebota=%  rfc_torcido_rebota=%  regimen_corto_rebota=%  modo_basura_rebota=%  cerrado=%   (esperado t / t / t / t / t / t / t / t)',
    segundo_vigente_rebota, recancelado_entra, uuid_repetido_rebota, cruzado_rebota,
    rfc_torcido_rebota, regimen_corto_rebota, modo_basura_rebota, cerrado;
end $$;

-- ── 180. La RESERVA del timbre (claim-then-act) y el dominio del interruptor repuesto (mig. 0227) ──
-- Lo que solo la base demuestra, y que es EL arreglo de c6-1: (a) la reserva
-- ('pendiente', sin uuid/fecha/xml) ENTRA — sin eso no hay claim que tomar
-- antes de llamar al PAC; (b) una SEGUNDA reserva del mismo viaje rebota
-- contra `ccp_timbre_vigente_unico`, que desde la 0227 cubre 'pendiente': ese
-- rebote es lo que impide que el perdedor llame al PAC y emita un segundo
-- CFDI real; (c) una reserva tampoco convive con un timbre vigente del mismo
-- viaje, ni al revés; (d) el CHECK de coherencia: un 'vigente' SIN uuid/fecha/
-- xml rebota — relajar los NOT NULL no aflojó la garantía, la condicionó;
-- (e) la reserva puede llevar uuid a medias (el PAC contestó, la
-- consolidación no cerró) — es el caso que evita perder un folio fiscal;
-- (f) `fecha_timbrado_origen` solo admite tfd/pac/servidor; (g) las cuatro
-- palancas del back office SIGUEN en el dominio del interruptor (la trampa de
-- c6-11: la 0218 aplicada después de la 0219 las borraba).
do $$
declare
  ta uuid; va uuid; vb uuid; op_a uuid; op_b uuid;
  reserva_entra boolean; segunda_reserva_rebota boolean;
  reserva_sobre_vigente_rebota boolean; vigente_incompleto_rebota boolean;
  reserva_con_uuid_entra boolean; origen_basura_rebota boolean;
  palancas int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0227') returning id into ta;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'Op 0227 A', '+5215550002271') returning id into op_a;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'Op 0227 B', '+5215550002272') returning id into op_b;
  insert into viaje (tenant_id, operador_id) values (ta, op_a) returning id into va;
  insert into viaje (tenant_id, operador_id) values (ta, op_b) returning id into vb;

  -- (a) La reserva entra sin uuid, sin fecha y sin xml.
  begin
    insert into ccp_timbre (tenant_id, viaje_id, estado, proveedor, modo, reservado_en)
      values (ta, va, 'pendiente', 'sw', 'sandbox', now());
    reserva_entra := true;
  exception when others then
    reserva_entra := false;
  end;

  -- (b) La SEGUNDA reserva del mismo viaje rebota: es el claim arbitrando.
  begin
    insert into ccp_timbre (tenant_id, viaje_id, estado, proveedor, modo, reservado_en)
      values (ta, va, 'pendiente', 'sw', 'sandbox', now());
    segunda_reserva_rebota := false;
  exception when unique_violation then
    segunda_reserva_rebota := true;
  end;

  -- (c) Un timbre vigente y una reserva del mismo viaje tampoco conviven.
  insert into ccp_timbre (tenant_id, viaje_id, uuid_fiscal, proveedor, modo, fecha_timbrado, xml)
    values (ta, vb, 'cccccccc-bbbb-4ccc-8ddd-000000000001', 'sw', 'sandbox', now(), '<xml/>');
  begin
    insert into ccp_timbre (tenant_id, viaje_id, estado, proveedor, modo, reservado_en)
      values (ta, vb, 'pendiente', 'sw', 'sandbox', now());
    reserva_sobre_vigente_rebota := false;
  exception when unique_violation then
    reserva_sobre_vigente_rebota := true;
  end;

  -- (d) Un 'vigente' incompleto rebota: el hecho del timbre sigue siendo
  -- obligatorio en cuanto la fila deja de ser una reserva.
  begin
    update ccp_timbre set estado = 'vigente'
      where tenant_id = ta and viaje_id = va and estado = 'pendiente';
    vigente_incompleto_rebota := false;
  exception when check_violation then
    vigente_incompleto_rebota := true;
  end;

  -- (e) La reserva SÍ puede llevar el uuid a medias — el folio no se pierde
  -- aunque la consolidación falle.
  begin
    update ccp_timbre set uuid_fiscal = 'cccccccc-bbbb-4ccc-8ddd-000000000002'
      where tenant_id = ta and viaje_id = va and estado = 'pendiente';
    reserva_con_uuid_entra := true;
  exception when others then
    reserva_con_uuid_entra := false;
  end;

  -- (f) El origen de la fecha es un dominio cerrado: 'inventado' no existe.
  begin
    update ccp_timbre set fecha_timbrado_origen = 'inventado'
      where tenant_id = ta and viaje_id = vb;
    origen_basura_rebota := false;
  exception when check_violation then
    origen_basura_rebota := true;
  end;

  -- (g) c6-11: las cuatro palancas del back office siguen en el dominio.
  palancas := 0;
  begin
    insert into interruptor (id, apagado) values ('agente:vigilante_calidad', false);
    palancas := palancas + 1;
    insert into interruptor (id, apagado) values ('agente:documentacion', false);
    palancas := palancas + 1;
    insert into interruptor (id, apagado) values ('agente:legal_compliance', false);
    palancas := palancas + 1;
    insert into interruptor (id, apagado) values ('agente:talento', false);
    palancas := palancas + 1;
  exception when check_violation then
    -- palancas se queda en cuántas alcanzaron a entrar: el número dice cuál.
    null;
  end;

  raise exception 'TIMBRE_CLAIM_0227  reserva_entra=%  segunda_reserva_rebota=%  reserva_sobre_vigente_rebota=%  vigente_incompleto_rebota=%  reserva_con_uuid_entra=%  origen_basura_rebota=%  palancas_backoffice=%   (esperado t / t / t / t / t / t / 4)',
    reserva_entra, segunda_reserva_rebota, reserva_sobre_vigente_rebota,
    vigente_incompleto_rebota, reserva_con_uuid_entra, origen_basura_rebota, palancas;
end $$;

-- ── 181. El portal de pago: una liga viva por factura, el token que no se puede guardar en claro, y la propuesta que no salda nada (mig. 0228) ──
-- Lo que solo la base demuestra: (a) UNA liga viva por factura — el doble clic
-- en "generar enlace" lo resuelve el índice parcial, gana exactamente una;
-- (b) revocar LIBERA: tras revocar, la liga nueva entra; (c) el token EN CLARO
-- no cabe en la columna — el CHECK de 64 hex es la red que impide guardarlo
-- por accidente; (d) idempotencia de la propuesta: la misma referencia con
-- otras mayúsculas es el mismo movimiento bancario y rebota; (e) la FK
-- compuesta: la flota B no cuelga su liga de la factura de la flota A; (f) el
-- estado de la propuesta es coherente — 'conciliada' sin el pago real rebota,
-- que es el candado de "la conciliación propone, el humano confirma"; (g) el
-- REP emitido no admite el mismo folio fiscal dos veces ni un UUID en
-- mayúsculas; (h) LA PROPUESTA NO MUEVE `factura_saldo`: es la afirmación
-- central de la migración y se comprueba contra la vista, no contra el código;
-- (i) el doble candado en las cuatro tablas nuevas.
do $$
declare
  ta uuid; tb uuid; ca uuid; cb uuid; fa uuid; fb uuid;
  liga_a uuid; liga_b uuid; pago_a uuid;
  segunda_liga_rebota boolean := false;
  revocada_libera boolean := false;
  token_en_claro_rebota boolean := false;
  propuesta_repetida_rebota boolean := false;
  liga_cruzada_rebota boolean := false;
  conciliada_sin_pago_rebota boolean := false;
  rep_uuid_repetido_rebota boolean := false;
  rep_mayusculas_rebota boolean := false;
  saldo_antes numeric; saldo_despues numeric; saldo_intacto boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0228 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0228 B') returning id into tb;
  insert into cliente (tenant_id, nombre) values (ta, 'ZZZ cli 0228 A') returning id into ca;
  insert into cliente (tenant_id, nombre) values (tb, 'ZZZ cli 0228 B') returning id into cb;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, ca, 1000, 160, 1160, 'emitida') returning id into fa;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (tb, cb, 500, 80, 580, 'emitida') returning id into fb;

  -- (a) Una liga viva por factura. La segunda rebota contra el índice parcial.
  insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
    values (ta, fa, repeat('a', 64), 'pgo_aaaa', now() + interval '90 days')
    returning id into liga_a;
  begin
    insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
      values (ta, fa, repeat('b', 64), 'pgo_bbbb', now() + interval '90 days');
    segunda_liga_rebota := false;
  exception when unique_violation then
    segunda_liga_rebota := true;
  end;

  -- (b) Revocar LIBERA: el índice es parcial sobre las vivas.
  update portal_pago_liga set revocada_en = now() where id = liga_a;
  begin
    insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
      values (ta, fa, repeat('c', 64), 'pgo_cccc', now() + interval '90 days')
      returning id into liga_a;
    revocada_libera := true;
  exception when others then
    revocada_libera := false;
  end;

  -- (c) El token EN CLARO no cabe: 64 hex o nada. Si alguien escribiera el
  -- token en vez de su sha256, el insert falla en vez de conservarlo.
  begin
    insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
      values (tb, fb, 'pgo_EstoEsElTokenEnClaro', 'pgo_Esto', now() + interval '90 days');
    token_en_claro_rebota := false;
  exception when check_violation then
    token_en_claro_rebota := true;
  end;

  -- (e) La liga de la flota A sobre la factura de la flota B: la FK compuesta
  -- lo rebota, no un filtro de aplicación.
  -- Se ataca `fb` y no `fa` A PROPÓSITO: `fa` ya tiene liga viva, y entonces el
  -- rebote vendría del índice único —la garantía del inciso (a)— y este inciso
  -- estaría midiendo dos veces lo mismo en vez de la FK. `fb` está libre: el
  -- (c) rebotó antes de insertar.
  begin
    insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
      values (ta, fb, repeat('d', 64), 'pgo_dddd', now() + interval '90 days');
    liga_cruzada_rebota := false;
  exception when foreign_key_violation then
    liga_cruzada_rebota := true;
  end;

  -- (h) LA PROPUESTA NO MUEVE EL SALDO. Se mide la vista antes y después.
  select saldo into saldo_antes from factura_saldo where factura_id = fa;
  insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
    values (ta, liga_a, fa, current_date, 1160, 'REF-8891');
  select saldo into saldo_despues from factura_saldo where factura_id = fa;
  saldo_intacto := saldo_antes = 1160 and saldo_despues = 1160;

  -- (d) La misma referencia con otras mayúsculas es el mismo movimiento.
  begin
    insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
      values (ta, liga_a, fa, current_date, 1160, 'ref-8891');
    propuesta_repetida_rebota := false;
  exception when unique_violation then
    propuesta_repetida_rebota := true;
  end;

  -- (f) 'conciliada' EXIGE el pago real. Sin él, la propuesta no puede
  -- declararse conciliada: es el candado de que solo un abono de verdad cierra
  -- el circuito.
  begin
    update portal_pago_propuesta set estado = 'conciliada', resuelta_en = now()
      where liga_id = liga_a;
    conciliada_sin_pago_rebota := false;
  exception when check_violation then
    conciliada_sin_pago_rebota := true;
  end;

  -- (g) El REP emitido: un folio fiscal, una vez, y siempre en minúsculas.
  insert into pago_recibido (tenant_id, factura_id, monto) values (ta, fa, 1160) returning id into pago_a;
  insert into rep_emitido (tenant_id, factura_id, pago_id, cfdi_uuid, fecha_pago, imp_pagado)
    values (ta, fa, pago_a, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', current_date, 1160);
  begin
    insert into rep_emitido (tenant_id, factura_id, pago_id, cfdi_uuid, fecha_pago, imp_pagado)
      values (ta, fa, pago_a, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', current_date, 1160);
    rep_uuid_repetido_rebota := false;
  exception when unique_violation then
    rep_uuid_repetido_rebota := true;
  end;
  begin
    insert into rep_emitido (tenant_id, factura_id, pago_id, cfdi_uuid, fecha_pago, imp_pagado)
      values (ta, fa, pago_a, 'AAAAAAAA-BBBB-4CCC-8DDD-000000000002', current_date, 1160);
    rep_mayusculas_rebota := false;
  exception when check_violation then
    rep_mayusculas_rebota := true;
  end;

  -- (i) El doble candado en las cuatro tablas nuevas.
  cerrado := not has_table_privilege('anon', 'public.portal_pago_liga', 'SELECT')
    and not has_table_privilege('authenticated', 'public.portal_pago_liga', 'SELECT')
    and has_table_privilege('service_role', 'public.portal_pago_liga', 'SELECT')
    and not has_table_privilege('anon', 'public.portal_pago_propuesta', 'SELECT')
    and not has_table_privilege('authenticated', 'public.portal_pago_propuesta', 'SELECT')
    and has_table_privilege('service_role', 'public.portal_pago_propuesta', 'INSERT')
    and not has_table_privilege('anon', 'public.rep_emitido', 'SELECT')
    and not has_table_privilege('authenticated', 'public.rep_emitido', 'SELECT')
    and not has_table_privilege('anon', 'public.portal_pago_acceso', 'SELECT')
    and not has_table_privilege('authenticated', 'public.portal_pago_acceso', 'SELECT');

  raise exception 'PORTAL_PAGO_0228  segunda_liga_rebota=%  revocada_libera=%  token_en_claro_rebota=%  liga_cruzada_rebota=%  saldo_intacto=%  propuesta_repetida_rebota=%  conciliada_sin_pago_rebota=%  rep_uuid_repetido_rebota=%  rep_mayusculas_rebota=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t)',
    segunda_liga_rebota, revocada_libera, token_en_claro_rebota, liga_cruzada_rebota,
    coalesce(saldo_intacto, false), propuesta_repetida_rebota, conciliada_sin_pago_rebota,
    rep_uuid_repetido_rebota, rep_mayusculas_rebota, cerrado;
end $$;

-- ── 182. Las reglas en lenguaje natural: la firma humana, el catálogo cerrado y el sello por ciclo (mig. 0229) ──
-- El bloque 181 es del portal de pago (rama paralela); esta ola toma el 182.
--
-- Lo que SOLO la base puede demostrar de A19, y que es donde vive la promesa
-- entera de la feature:
--
--  (a) Una regla NO puede salir de 'pendiente' sin quién la confirmó y
--      cuándo. La confirmación humana no es un `if` de una server action —es
--      un CHECK—, así que un POST directo tampoco la puede rodear. Si este
--      valor sale `f`, el producto está mandando WhatsApps por vigilancias
--      que nadie leyó.
--  (b) Con firma sí entra: el candado condiciona, no prohíbe.
--  (c) El CATÁLOGO ES CERRADO. Una plantilla inventada rebota — es la mitad
--      que impide guardar una vigilancia que el lector no sabe correr.
--  (d) `params` tiene que ser un OBJETO: un arreglo o un escalar sería una
--      regla que `validarParams` no puede leer.
--  (e) La misma vigilancia con los mismos parámetros no se declara dos veces
--      mientras esté viva (dos reglas idénticas = dos WhatsApps por el mismo
--      hecho), y el orden de las llaves del jsonb NO la disfraza. Una
--      PAUSADA sí deja volver a declararla.
--  (f) EL SELLO ANTI-SPAM (patrón 0202): el mismo (regla, objeto, ciclo) no
--      entra dos veces, y un CICLO NUEVO —otra fecha de vencimiento, otro
--      conteo— sí. Es la diferencia entre avisar una vez y avisar cada hora.
--  (g) La FK COMPUESTA: un sello de la flota B no se puede colgar de una
--      regla de la flota A.
--  (h) El dominio del objeto vigilado.
--  (i) El doble candado (RLS deny-all + solo service_role) en las dos tablas.
do $$
declare
  ta uuid; tb uuid; ua uuid;
  regla_a uuid; regla_b uuid; regla_pausada uuid;
  activa_sin_firma_rebota boolean; activa_con_firma_entra boolean;
  plantilla_inventada_rebota boolean; params_arreglo_rebota boolean;
  duplicada_rebota boolean; llaves_al_reves_rebota boolean; sobre_pausada_entra boolean;
  sello_repetido_rebota boolean; ciclo_nuevo_entra boolean;
  sello_cruzado_rebota boolean; objeto_inventado_rebota boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0229 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0229 B') returning id into tb;
  insert into app_user (id, tenant_id, email, rol)
    values (gen_random_uuid(), ta, 'zzz-verif-0229@likida.test', 'flota_admin') returning id into ua;

  insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
    values (ta, 'gasto_de_concepto_mayor_a', '{"concepto":"caseta","monto":3000}'::jsonb,
            'avísame si un gasto de caseta pasa de $3,000',
            'Voy a avisarte cuando entre un comprobante de casetas por más de $3,000.00.')
    returning id into regla_a;

  -- (a) Sin firma no vigila. Es EL candado del diseño.
  begin
    update regla_vigilancia set estado = 'activa' where id = regla_a;
    activa_sin_firma_rebota := false;
  exception when check_violation then
    activa_sin_firma_rebota := true;
  end;

  -- (b) Con firma sí.
  begin
    update regla_vigilancia
      set estado = 'activa', confirmada_por = ua, confirmada_en = now()
      where id = regla_a;
    activa_con_firma_entra := true;
  exception when others then
    activa_con_firma_entra := false;
  end;

  -- (c) El catálogo es cerrado.
  begin
    insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
      values (ta, 'avisame_de_todo', '{}'::jsonb, 'x', 'y');
    plantilla_inventada_rebota := false;
  exception when check_violation then
    plantilla_inventada_rebota := true;
  end;

  -- (d) `params` es un objeto o no es nada.
  begin
    insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
      values (ta, 'estadia_mayor_a', '[4]'::jsonb, 'x', 'y');
    params_arreglo_rebota := false;
  exception when check_violation then
    params_arreglo_rebota := true;
  end;

  -- (e) La misma vigilancia, viva, no se declara dos veces…
  begin
    insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
      values (ta, 'gasto_de_concepto_mayor_a', '{"concepto":"caseta","monto":3000}'::jsonb, 'otra vez', 'otra vez');
    duplicada_rebota := false;
  exception when unique_violation then
    duplicada_rebota := true;
  end;
  -- …ni disfrazada con las llaves en otro orden (jsonb las normaliza).
  begin
    insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
      values (ta, 'gasto_de_concepto_mayor_a', '{"monto":3000,"concepto":"caseta"}'::jsonb, 'al reves', 'al reves');
    llaves_al_reves_rebota := false;
  exception when unique_violation then
    llaves_al_reves_rebota := true;
  end;
  -- Una PAUSADA no ocupa el lugar: se puede volver a declarar.
  insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase, estado, confirmada_por, confirmada_en)
    values (ta, 'estadia_mayor_a', '{"horas":4}'::jsonb, 'estadias de 4h', 'estadias de 4h', 'pausada', ua, now())
    returning id into regla_pausada;
  begin
    insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
      values (ta, 'estadia_mayor_a', '{"horas":4}'::jsonb, 'otra vez estadias', 'otra vez estadias');
    sobre_pausada_entra := true;
  exception when unique_violation then
    sobre_pausada_entra := false;
  end;

  -- (f) El sello por ciclo.
  insert into regla_disparo (tenant_id, regla_id, objeto, objeto_id, clave, evidencia)
    values (ta, regla_a, 'gasto', '00000000-0000-4000-8000-000000000229', '', '$3,500.00 de casetas');
  begin
    insert into regla_disparo (tenant_id, regla_id, objeto, objeto_id, clave, evidencia)
      values (ta, regla_a, 'gasto', '00000000-0000-4000-8000-000000000229', '', 'el mismo gasto otra vez');
    sello_repetido_rebota := false;
  exception when unique_violation then
    sello_repetido_rebota := true;
  end;
  begin
    insert into regla_disparo (tenant_id, regla_id, objeto, objeto_id, clave, evidencia)
      values (ta, regla_a, 'gasto', '00000000-0000-4000-8000-000000000229', '2027-01-31', 'ciclo nuevo del mismo objeto');
    ciclo_nuevo_entra := true;
  exception when unique_violation then
    ciclo_nuevo_entra := false;
  end;

  -- (g) La FK compuesta: el sello de B no se cuelga de la regla de A.
  insert into regla_vigilancia (tenant_id, plantilla, params, texto_original, frase)
    values (tb, 'gasto_sin_cfdi_mayor_a', '{"monto":2000}'::jsonb, 'sin factura', 'sin factura')
    returning id into regla_b;
  begin
    insert into regla_disparo (tenant_id, regla_id, objeto, objeto_id, clave, evidencia)
      values (tb, regla_a, 'gasto', '00000000-0000-4000-8000-00000000022a', '', 'gasto de otra flota');
    sello_cruzado_rebota := false;
  exception when foreign_key_violation then
    sello_cruzado_rebota := true;
  end;

  -- (h) El dominio de lo vigilado.
  begin
    insert into regla_disparo (tenant_id, regla_id, objeto, objeto_id, clave, evidencia)
      values (ta, regla_a, 'lo_que_sea', '00000000-0000-4000-8000-00000000022b', '', 'objeto inventado');
    objeto_inventado_rebota := false;
  exception when check_violation then
    objeto_inventado_rebota := true;
  end;

  -- (i) El doble candado, en las DOS tablas.
  cerrado := not has_table_privilege('anon', 'public.regla_vigilancia', 'SELECT')
    and not has_table_privilege('authenticated', 'public.regla_vigilancia', 'SELECT')
    and has_table_privilege('service_role', 'public.regla_vigilancia', 'SELECT')
    and not has_table_privilege('anon', 'public.regla_disparo', 'SELECT')
    and not has_table_privilege('authenticated', 'public.regla_disparo', 'SELECT')
    and has_table_privilege('service_role', 'public.regla_disparo', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.regla_vigilancia'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.regla_disparo'::regclass);

  raise exception 'REGLAS_0229  activa_sin_firma_rebota=%  activa_con_firma_entra=%  plantilla_inventada_rebota=%  params_arreglo_rebota=%  duplicada_rebota=%  llaves_al_reves_rebota=%  sobre_pausada_entra=%  sello_repetido_rebota=%  ciclo_nuevo_entra=%  sello_cruzado_rebota=%  objeto_inventado_rebota=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t)',
    activa_sin_firma_rebota, activa_con_firma_entra, plantilla_inventada_rebota,
    params_arreglo_rebota, duplicada_rebota, llaves_al_reves_rebota, sobre_pausada_entra,
    sello_repetido_rebota, ciclo_nuevo_entra, sello_cruzado_rebota, objeto_inventado_rebota, cerrado;
end $$;

-- ── 183. Crecimiento: los 10 vivos con reloj y techo, una pieza por periodo, y las 40 palancas del dominio (mig. 0230) ──
-- El bloque 182 es de las reglas en lenguaje natural (rama paralela); esta ola
-- toma el 183.
--
-- Lo que SOLO la base puede demostrar de la 0230:
--
--  (a) LOS DIEZ PASAN LOS CANDADOS 2 Y 3 DEL RUNNER. `estado='vivo'` +
--      `runner_habilitado` + `disparador='cron'` + techo declarado > 0 no es
--      cosmética: la consulta del runner filtra por los tres primeros y el
--      candado 3 salta a quien no tenga techo. Si este valor no sale 10, hay
--      agentes que el PR dice que encendió y que el cron nunca despacha.
--  (b) EL MODELO SE DECLARA CON LA VERDAD DEL MOTOR. Solo `contenido_fiscal`
--      trae `modelo_rol`; los otros nueve son deterministas y su NULL dice
--      «no usa modelo de texto» (convención 0125), no «se nos olvidó».
--  (c) LAS 40 PALANCAS. Las 10 nuevas entran, y —la trampa que la 0227
--      corrigió y que se repite en cada ola— las 30 ANTERIORES siguen en el
--      dominio: si esta migración hubiera enumerado solo las suyas, apagar a
--      `talento` o a `redactor` rebotaría con check_violation el día del
--      incidente, que es el peor día para descubrirlo.
--  (d) Una palanca inventada rebota: el dominio es cerrado.
--  (e) UNA PIEZA POR PERIODO. El mismo (agente, título) no entra dos veces
--      para un agente de crecimiento — es el árbitro de la carrera entre dos
--      pasadas del runner, y por eso la idempotencia es un constraint y no un
--      `if` que dos procesos concurrentes se saltan.
--  (f) EL ÍNDICE ES PARCIAL. El Redactor SÍ puede repetir título: dos
--      prospectos pueden compartir el asunto de un correo legítimamente, y un
--      índice global rompería la campaña.
--  (g) `aliado_objetivo` sembrado SIN CONTACTO Y SIN FECHA: los tres del
--      blueprint existen y ninguno trae contacto ni acercamiento inventado.
--  (h) Un aliado no puede AVANZAR de estado sin decir cuándo se le tocó (un
--      estado que avanzó sin fecha no es auditable), y sin avanzar sí puede
--      quedarse sin fecha.
--  (i) El dominio cerrado de tipo, y el doble candado (RLS deny-all + grants
--      solo a service_role) de la tabla nueva.
do $$
declare
  vivos_con_reloj_y_techo int;
  con_modelo int; sin_modelo int;
  palancas_nuevas int; palancas_previas int;
  palanca_inventada_rebota boolean;
  pieza_repetida_rebota boolean; redactor_repite boolean;
  aliados_sembrados int; aliados_con_contacto_o_fecha int;
  avance_sin_fecha_rebota boolean; avance_con_fecha_entra boolean;
  tipo_inventado_rebota boolean;
  cerrado boolean;
begin
  -- (a) y (b) — el catálogo, tal como el runner lo consulta.
  select count(*) into vivos_con_reloj_y_techo from agente_definicion
    where id in ('contenido_fiscal','lead_magnet','seo_distribucion','guiones',
                 'noticias_mercado','promos_diarias','visuales','video_demo',
                 'video_marketing','alianzas')
      and estado = 'vivo' and runner_habilitado and disparador = 'cron'
      and presupuesto_dia_usd is not null and presupuesto_dia_usd > 0;

  select count(*) into con_modelo from agente_definicion
    where departamento = 'crecimiento' and modelo_rol is not null;
  select count(*) into sin_modelo from agente_definicion
    where departamento = 'crecimiento' and modelo_rol is null;

  -- (c) Las 10 nuevas…
  palancas_nuevas := 0;
  begin
    insert into interruptor (id, apagado) values
      ('agente:contenido_fiscal', false), ('agente:lead_magnet', false),
      ('agente:seo_distribucion', false), ('agente:guiones', false),
      ('agente:noticias_mercado', false), ('agente:promos_diarias', false),
      ('agente:visuales', false), ('agente:video_demo', false),
      ('agente:video_marketing', false), ('agente:alianzas', false);
    palancas_nuevas := 10;
  exception when check_violation then
    palancas_nuevas := -1;
  end;
  -- …y una muestra de las de CADA ola anterior, que es donde vive la trampa.
  palancas_previas := 0;
  begin
    insert into interruptor (id, apagado) values
      ('global', false), ('agente:redactor', false),
      ('agente:tesoreria', false), ('agente:orquestador', false),
      ('agente:enviador', false), ('agente:atencion_faq', false),
      ('agente:talento', false);
    palancas_previas := 7;
  exception when check_violation then
    palancas_previas := -1;
  end;

  -- (d) El dominio es cerrado.
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:inventado_0230', true, 'basura');
    palanca_inventada_rebota := false;
  exception when check_violation then
    palanca_inventada_rebota := true;
  end;

  -- (e) Una pieza por periodo.
  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('promo_diaria', 'normal', 'promos_diarias', 'Promo del dia — 2026-08-27', 'cuerpo');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('promo_diaria', 'normal', 'promos_diarias', 'Promo del dia — 2026-08-27', 'otra corrida');
    pieza_repetida_rebota := false;
  exception when unique_violation then
    pieza_repetida_rebota := true;
  end;

  -- (f) El índice es PARCIAL: el Redactor sí repite título.
  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('correo_frio', 'normal', 'redactor', 'Tu liquidacion de viajes', 'a');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('correo_frio', 'normal', 'redactor', 'Tu liquidacion de viajes', 'b');
    redactor_repite := true;
  exception when unique_violation then
    redactor_repite := false;
  end;

  -- (g) La siembra: existen y NO traen contacto ni fecha inventados.
  select count(*) into aliados_sembrados from aliado_objetivo
    where id in ('canacar', 'anpact', 'tyt');
  select count(*) into aliados_con_contacto_o_fecha from aliado_objetivo
    where id in ('canacar', 'anpact', 'tyt')
      and (contacto_nota is not null or ultimo_toque_en is not null or estado <> 'sin_contacto');

  -- (h) Avanzar de estado exige decir cuándo.
  begin
    update aliado_objetivo set estado = 'contactado' where id = 'canacar';
    avance_sin_fecha_rebota := false;
  exception when check_violation then
    avance_sin_fecha_rebota := true;
  end;
  begin
    update aliado_objetivo set estado = 'contactado', ultimo_toque_en = current_date where id = 'canacar';
    avance_con_fecha_entra := true;
  exception when others then
    avance_con_fecha_entra := false;
  end;

  -- (i) El dominio del tipo…
  begin
    insert into aliado_objetivo (id, nombre, tipo) values ('x_0230', 'Lo que sea', 'influencer');
    tipo_inventado_rebota := false;
  exception when check_violation then
    tipo_inventado_rebota := true;
  end;
  -- …y el doble candado.
  cerrado := not has_table_privilege('anon', 'public.aliado_objetivo', 'SELECT')
    and not has_table_privilege('authenticated', 'public.aliado_objetivo', 'SELECT')
    and has_table_privilege('service_role', 'public.aliado_objetivo', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.aliado_objetivo'::regclass);

  raise exception 'CRECIMIENTO_0230  vivos_con_reloj_y_techo=%  con_modelo=%  sin_modelo=%  palancas_nuevas=%  palancas_previas=%  palanca_inventada_rebota=%  pieza_repetida_rebota=%  redactor_repite=%  aliados_sembrados=%  aliados_con_contacto_o_fecha=%  avance_sin_fecha_rebota=%  avance_con_fecha_entra=%  tipo_inventado_rebota=%  cerrado=%   (esperado 10 / 1 / 9 / 10 / 7 / t / t / t / 3 / 0 / t / t / t / t)',
    vivos_con_reloj_y_techo, con_modelo, sin_modelo, palancas_nuevas, palancas_previas,
    palanca_inventada_rebota, pieza_repetida_rebota, redactor_repite,
    aliados_sembrados, aliados_con_contacto_o_fecha,
    avance_sin_fecha_rebota, avance_con_fecha_entra, tipo_inventado_rebota, cerrado;
end $$;

-- ── 186. El vínculo con cada portal: tres estados con fecha, sin una cookie en claro (mig. 0232) ──
-- Los bloques 183-185 los toman ramas paralelas de esta misma ola; esta toma
-- el 186. El último en master antes de escribir esto era el 182 (mig. 0229).
--
-- Lo que SOLO la base puede demostrar del estado de vinculación de portales:
--
--  (a) EL DOMINIO. 'vinculado', 'sin_vincular' y 'caducada' y nada más. Un
--      estado inventado que entrara sería una píldora que el panel no sabe
--      pintar, y `aVinculo()` la descartaría con grito — pero descartarla en
--      lectura no sirve si la base la dejó escribir.
--  (b) UN ESTADO SIN SU FECHA REBOTA. 'vinculado' sin `vinculada_en` no le
--      dice a nadie desde cuándo, y 'caducada' sin `caducada_en` no distingue
--      lo de hace diez minutos de lo del mes pasado. Los dos CHECK están.
--  (c) Y CON SU FECHA ENTRA: el candado condiciona, no prohíbe.
--  (d) NINGUNA COOKIE EN CLARO. `motivo` es una frase para una persona; un
--      valor que empiece por `{` o `[` sería un storageState o un volcado, y
--      esta columna la lee el panel SIN descifrar nada. Es la mitad de base
--      de la regla dura de la casa: la sesión vive cifrada en el cofre y aquí
--      solo hay palabras.
--  (e) UNA FILA POR (FLOTA, PORTAL). El escritor hace UPSERT con esa llave —
--      la idempotencia de dos corridas que ven lo mismo depende de que la
--      base no admita dos filas del mismo portal para la misma flota.
--  (f) Y LA MISMA CLAVE DE COMERCIO SÍ ENTRA PARA OTRA FLOTA: el candado es
--      por tenant, no global. Sin esto, la primera flota que vinculara La Gas
--      dejaría a todas las demás fuera.
--  (g) EL BORRADO DE LA FLOTA SE LLEVA SUS VÍNCULOS (cascade). Un estado
--      huérfano es un renglón que nadie puede leer ni borrar.
--  (h) La llave `(id, tenant_id)` de la casa (0028/0145) existe, que es lo
--      que hace posible colgar una FK compuesta de aquí.
--  (i) El doble candado: RLS deny-all + solo service_role.
do $$
declare
  ta uuid; tb uuid;
  estado_inventado_rebota boolean; vinculado_sin_fecha_rebota boolean;
  caducada_sin_fecha_rebota boolean; vinculado_con_fecha_entra boolean;
  motivo_json_rebota boolean; motivo_frase_entra boolean;
  duplicado_rebota boolean; otra_flota_entra boolean;
  cascade_limpia boolean; llave_compuesta boolean; cerrado boolean;
  quedan integer;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0232 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0232 B') returning id into tb;

  -- (a) El dominio de los tres estados.
  begin
    insert into portal_estado (tenant_id, comercio, estado)
      values (ta, 'la_gas', 'medio_vinculado');
    estado_inventado_rebota := false;
  exception when check_violation then
    estado_inventado_rebota := true;
  end;

  -- (b) Un estado sin su fecha no se puede pintar.
  begin
    insert into portal_estado (tenant_id, comercio, estado)
      values (ta, 'la_gas', 'vinculado');
    vinculado_sin_fecha_rebota := false;
  exception when check_violation then
    vinculado_sin_fecha_rebota := true;
  end;

  begin
    insert into portal_estado (tenant_id, comercio, estado)
      values (ta, 'g500', 'caducada');
    caducada_sin_fecha_rebota := false;
  exception when check_violation then
    caducada_sin_fecha_rebota := true;
  end;

  -- (c) Con su fecha sí entra.
  begin
    insert into portal_estado (tenant_id, comercio, estado, vinculada_en)
      values (ta, 'la_gas', 'vinculado', now());
    vinculado_con_fecha_entra := true;
  exception when others then
    vinculado_con_fecha_entra := false;
  end;

  -- (d) Ninguna cookie en claro: un JSON en `motivo` rebota, una frase entra.
  begin
    insert into portal_estado (tenant_id, comercio, estado, caducada_en, motivo)
      values (ta, 'g500', 'caducada', now(), '{"cookies":[{"name":"ASP.NET_SessionId"}]}');
    motivo_json_rebota := false;
  exception when check_violation then
    motivo_json_rebota := true;
  end;

  begin
    insert into portal_estado (tenant_id, comercio, estado, caducada_en, motivo)
      values (ta, 'g500', 'caducada', now(),
              'el portal enseña un campo de contraseña (#pass), o sea la pantalla de entrar');
    motivo_frase_entra := true;
  exception when others then
    motivo_frase_entra := false;
  end;

  -- (e) Una fila por (flota, portal): es de lo que depende el UPSERT.
  begin
    insert into portal_estado (tenant_id, comercio, estado)
      values (ta, 'la_gas', 'sin_vincular');
    duplicado_rebota := false;
  exception when unique_violation then
    duplicado_rebota := true;
  end;

  -- (f) Pero la misma clave para OTRA flota sí entra: el candado es por tenant.
  begin
    insert into portal_estado (tenant_id, comercio, estado, vinculada_en)
      values (tb, 'la_gas', 'vinculado', now());
    otra_flota_entra := true;
  exception when others then
    otra_flota_entra := false;
  end;

  -- (g) Borrar la flota se lleva sus vínculos.
  delete from tenant where id = tb;
  select count(*) into quedan from portal_estado where tenant_id = tb;
  cascade_limpia := (quedan = 0);

  -- (h) La llave que hace posibles las FK compuestas de la casa.
  llave_compuesta := exists (
    select 1 from pg_constraint
    where conname = 'portal_estado_id_tenant_key'
      and conrelid = 'public.portal_estado'::regclass
      and contype = 'u'
  );

  -- (i) El doble candado.
  cerrado := not has_table_privilege('anon', 'public.portal_estado', 'SELECT')
    and not has_table_privilege('authenticated', 'public.portal_estado', 'SELECT')
    and has_table_privilege('service_role', 'public.portal_estado', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.portal_estado'::regclass);

  raise exception 'PORTAL_ESTADO_0232  estado_inventado_rebota=%  vinculado_sin_fecha_rebota=%  caducada_sin_fecha_rebota=%  vinculado_con_fecha_entra=%  motivo_json_rebota=%  motivo_frase_entra=%  duplicado_rebota=%  otra_flota_entra=%  cascade_limpia=%  llave_compuesta=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t / t)',
    estado_inventado_rebota, vinculado_sin_fecha_rebota, caducada_sin_fecha_rebota,
    vinculado_con_fecha_entra, motivo_json_rebota, motivo_frase_entra,
    duplicado_rebota, otra_flota_entra, cascade_limpia, llave_compuesta, cerrado;
end $$;

-- ── 187. La descarga masiva del SAT: la credencial que no cabe, el sello de dedup y el cruce que no puede mentir (mig. 0231) ──
-- Los bloques 183 y 186 los tomaron las olas de crecimiento (0230) y de
-- sesión de portal (0232), paralelas a ésta; aquí se toma el 187.
--
-- Lo que SOLO la base puede demostrar de esta feature, y que es donde vive
-- toda su promesa:
--
--  (a) LA e.firma NO CABE EN LA TABLA. El diseño entero descansa en que
--      Likida jamás custodia la firma electrónica del cliente: la FIEL vive
--      en la bóveda del PAC y aquí solo se guarda una REFERENCIA de 20
--      dígitos. Si este valor sale `f`, alguien puede pegar una llave privada
--      en base64 en la columna del certificado y el producto habría roto su
--      promesa de seguridad sin que ninguna prueba de código se enterara.
--      Una referencia legítima (20 dígitos) sí entra: el candado acota, no
--      prohíbe.
--  (b) EL SELLO DE DEDUP. El mismo folio fiscal no entra dos veces por flota
--      —dos rangos traslapados, el cron repetido, o el ticket que ya había
--      llegado por WhatsApp con su XML—. Es la idempotencia por constraint de
--      toda la ingesta.
--  (c) Pero la MISMA flota SÍ puede tener muchos folios distintos, y DOS
--      FLOTAS pueden tener el mismo folio: un CFDI que le timbraron a dos
--      razones sociales distintas es un caso real, y un unique global lo
--      rompería.
--  (d) EL UUID EN MINÚSCULAS Y CON FORMA DE UUID (regla 0158, extendida): un
--      folio en mayúsculas sería el MISMO comprobante entrando otra vez, y el
--      unique no lo vería.
--  (e) EL CRUCE NO PUEDE MENTIR: 'casado' EXIGE con qué gasto casó, y
--      cualquier otro estatus NO puede traer gasto. Sin este CHECK, una fila
--      podría afirmar un cruce inexistente — que es exactamente la cifra
--      inventada que este producto no se permite.
--  (f) UN SOLO TRÁMITE VIVO POR RANGO. El cron corre cada 6 h y el SAT tarda
--      hasta 6 días: sin el índice parcial, cada corrida volvería a pedir el
--      mismo rango y quemaría el tope diario del RFC contra el mismo periodo.
--      Un rango YA CERRADO (descargada/error/expirada) sí se puede volver a
--      pedir: un reintento deliberado es legítimo.
--  (g) LA FK COMPUESTA: el comprobante de la flota A no puede casar con un
--      gasto de la flota B.
--  (h) EL CICLO DEL AVISO DE PEAJE (patrón 0202): el mismo (flota, mes,
--      umbral) no avisa dos veces, pero un MES NUEVO sí — es la diferencia
--      entre un reloj y un spam. Y el periodo tiene que ser el día 1: guardar
--      el 15 le daría dos ciclos al mismo mes.
--  (i) El doble candado (RLS deny-all + solo service_role) en las cuatro.
do $$
declare
  ta uuid; tb uuid; ua uuid; oa uuid; va uuid; ga uuid; gb uuid;
  sol_a uuid;
  llave_no_cabe boolean; referencia_entra boolean;
  folio_repetido_rebota boolean; otro_folio_entra boolean; otra_flota_entra boolean;
  mayusculas_rebota boolean; no_uuid_rebota boolean;
  casado_sin_gasto_rebota boolean; disponible_con_gasto_rebota boolean;
  rango_vivo_repetido_rebota boolean; rango_cerrado_reentra boolean;
  gasto_cruzado_rebota boolean;
  aviso_repetido_rebota boolean; mes_nuevo_entra boolean; periodo_a_media_rebota boolean;
  cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0231 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0231 B') returning id into tb;
  insert into app_user (id, tenant_id, email, rol)
    values (gen_random_uuid(), ta, 'zzz-verif-0231@likida.test', 'contador') returning id into ua;
  insert into operador (tenant_id, nombre, telefono)
    values (ta, 'ZZZ 0231', '+520000000230') returning id into oa;
  insert into viaje (tenant_id, operador_id, folio) values (ta, oa, 'ZZZ-0231') returning id into va;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
    values (ta, va, 'caseta', 300, current_date) returning id into ga;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
    values (ta, va, 'diesel', 600, current_date) returning id into gb;

  insert into sat_descarga_config (tenant_id, rfc) values (ta, 'EKU9003173C9');
  insert into sat_descarga_config (tenant_id, rfc) values (tb, 'AAA010101AAA');

  -- (a) LA PRUEBA MADRE: una llave privada no cabe donde va la referencia.
  -- El valor de ataque se ARMA aquí en vez de escribirse literal: un blob con
  -- prefijo de certificado real hace que los escáneres de secretos marquen
  -- este archivo para siempre, y lo que el CHECK vigila es la FORMA (20
  -- dígitos), no un prefijo concreto. Cualquier base64 largo lo demuestra
  -- igual de bien.
  begin
    update sat_descarga_config
      set certificado_numero = repeat('QUJDZGVmZ2hpams', 30) || '=='
      where tenant_id = ta;
    llave_no_cabe := false;
  exception when check_violation then
    llave_no_cabe := true;
  end;
  begin
    update sat_descarga_config set certificado_numero = '30001000000500003282' where tenant_id = ta;
    referencia_entra := true;
  exception when others then
    referencia_entra := false;
  end;

  insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado, request_id)
    values (ta, 'recibidos', current_date - 30, current_date, 'en_proceso', 'req-0231-a')
    returning id into sol_a;

  -- (b) El sello de dedup.
  insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, solicitud_id, total, fecha)
    values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000230', sol_a, 300, current_date);
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, total)
      values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000230', 300);
    folio_repetido_rebota := false;
  exception when unique_violation then
    folio_repetido_rebota := true;
  end;

  -- (c) Pero otro folio sí, y la MISMA cadena en OTRA flota también.
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, total)
      values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000231', 600);
    otro_folio_entra := true;
  exception when others then
    otro_folio_entra := false;
  end;
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, total)
      values (tb, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000230', 300);
    otra_flota_entra := true;
  exception when others then
    otra_flota_entra := false;
  end;

  -- (d) Minúsculas y forma de UUID.
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid)
      values (ta, 'AAAAAAAA-BBBB-4CCC-8DDD-000000000232');
    mayusculas_rebota := false;
  exception when check_violation then
    mayusculas_rebota := true;
  end;
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid) values (ta, 'no-soy-un-uuid');
    no_uuid_rebota := false;
  exception when check_violation then
    no_uuid_rebota := true;
  end;

  -- (e) El cruce no puede mentir, en los DOS sentidos.
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus)
      values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000233', 'casado');
    casado_sin_gasto_rebota := false;
  exception when check_violation then
    casado_sin_gasto_rebota := true;
  end;
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus, gasto_id)
      values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000234', 'disponible', ga);
    disponible_con_gasto_rebota := false;
  exception when check_violation then
    disponible_con_gasto_rebota := true;
  end;

  -- (f) Un solo trámite vivo por rango; uno cerrado sí se vuelve a pedir.
  -- 27-AGO-2026: el candado cambió de forma. La 0231 lo hacía con el índice
  -- único parcial `uq_sat_solicitud_viva`, que sólo bloqueaba el PAR EXACTO de
  -- fechas (c7-22: dos rangos distintos sobre los mismos días entraban los
  -- dos); la 0236 lo sustituyó por la restricción de exclusión
  -- `sat_solicitud_viva_sin_traslape`, que cubre el traslape de verdad. Lo que
  -- este bloque afirma —el mismo rango no se pide dos veces mientras vive, y
  -- uno cerrado sí— NO cambió; cambió el SQLSTATE con que la base lo dice
  -- (23P01 en vez de 23505). Se aceptan los dos para que el bloque siga
  -- probando la GARANTÍA y no el mecanismo. El traslape propiamente dicho lo
  -- prueba el bloque 191.
  begin
    insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado)
      values (ta, 'recibidos', current_date - 30, current_date, 'solicitada');
    rango_vivo_repetido_rebota := false;
  exception when unique_violation or exclusion_violation then
    rango_vivo_repetido_rebota := true;
  end;
  update sat_descarga_solicitud set estado = 'descargada' where id = sol_a;
  begin
    insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado)
      values (ta, 'recibidos', current_date - 30, current_date, 'solicitada');
    rango_cerrado_reentra := true;
  exception when unique_violation or exclusion_violation then
    rango_cerrado_reentra := false;
  end;

  -- (g) La FK compuesta: el comprobante de B no casa con un gasto de A.
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus, gasto_id)
      values (tb, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000235', 'casado', ga);
    gasto_cruzado_rebota := false;
  exception when foreign_key_violation then
    gasto_cruzado_rebota := true;
  end;

  -- (h) El ciclo del aviso de peaje.
  insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
    values (ta, date_trunc('month', current_date)::date, 7, 3);
  begin
    insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
      values (ta, date_trunc('month', current_date)::date, 7, 5);
    aviso_repetido_rebota := false;
  exception when unique_violation then
    aviso_repetido_rebota := true;
  end;
  begin
    insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
      values (ta, (date_trunc('month', current_date) + interval '1 month')::date, 7, 2);
    mes_nuevo_entra := true;
  exception when unique_violation then
    mes_nuevo_entra := false;
  end;
  begin
    insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
      values (ta, (date_trunc('month', current_date) + interval '14 days')::date, 7, 1);
    periodo_a_media_rebota := false;
  exception when check_violation then
    periodo_a_media_rebota := true;
  end;

  -- (i) El doble candado, en las CUATRO tablas nuevas.
  cerrado := not has_table_privilege('anon', 'public.sat_descarga_config', 'SELECT')
    and not has_table_privilege('authenticated', 'public.sat_descarga_config', 'SELECT')
    and has_table_privilege('service_role', 'public.sat_descarga_config', 'SELECT')
    and not has_table_privilege('anon', 'public.sat_descarga_solicitud', 'SELECT')
    and not has_table_privilege('authenticated', 'public.sat_descarga_solicitud', 'SELECT')
    and not has_table_privilege('anon', 'public.sat_cfdi_descargado', 'SELECT')
    and not has_table_privilege('authenticated', 'public.sat_cfdi_descargado', 'SELECT')
    and has_table_privilege('service_role', 'public.sat_cfdi_descargado', 'INSERT')
    and not has_table_privilege('anon', 'public.peaje_cierre_aviso', 'SELECT')
    and not has_table_privilege('authenticated', 'public.peaje_cierre_aviso', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.sat_descarga_config'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.sat_cfdi_descargado'::regclass);

  raise exception 'DESCARGA_SAT_0231  llave_no_cabe=%  referencia_entra=%  folio_repetido_rebota=%  otro_folio_entra=%  otra_flota_entra=%  mayusculas_rebota=%  no_uuid_rebota=%  casado_sin_gasto_rebota=%  disponible_con_gasto_rebota=%  rango_vivo_repetido_rebota=%  rango_cerrado_reentra=%  gasto_cruzado_rebota=%  aviso_repetido_rebota=%  mes_nuevo_entra=%  periodo_a_media_rebota=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t)',
    llave_no_cabe, referencia_entra, folio_repetido_rebota, otro_folio_entra,
    otra_flota_entra, mayusculas_rebota, no_uuid_rebota, casado_sin_gasto_rebota,
    disponible_con_gasto_rebota, rango_vivo_repetido_rebota, rango_cerrado_reentra,
    gasto_cruzado_rebota, aviso_repetido_rebota, mes_nuevo_entra,
    periodo_a_media_rebota, cerrado;
end $$;

-- ── 188. El permiso para reconectar sola: consentimiento firmado, candado con motivo, y ni una contraseña en claro (mig. 0233) ──
-- Los bloques 183-187 los tomaron ramas paralelas de esta misma ola; esta toma
-- el 188. Se escribió como 187 sobre el master de esa mañana y el rebase lo
-- encontró ocupado por la 0231 (descarga masiva del SAT): renumerado al
-- reencontrarse con master, que es el momento en que un número de bloque se
-- puede afirmar de verdad.
--
-- Lo que SOLO la base puede demostrar del permiso de re-login automático:
--
--  (a) UN CONSENTIMIENTO SIN FIRMA NO ENTRA. `permitido = true` sin saber
--      QUIÉN lo dio y CUÁNDO es un permiso que nadie dio, y es exactamente el
--      dato que hay que poder enseñar un año después ("¿quién autorizó que
--      guardáramos la contraseña de esta cuenta?"). `autorizarRelogin` lo
--      comprueba también en TypeScript — pero comprobarlo en el escritor no
--      sirve si la base admite la fila que llegue por cualquier otro camino.
--  (b) Y CON FIRMA ENTRA: el candado condiciona, no prohíbe.
--  (c) EL «NO» NO NECESITA FIRMA. `permitido = false` sin autor es el estado
--      normal de todo portal, y es lo que significa no tener fila. Si el CHECK
--      exigiera autor siempre, revocar sería imposible.
--  (d) UN CANDADO SIN MOTIVO REBOTA. `bloqueado = true` sin `ultima_clase`
--      sería un re-login detenido que nadie sabe cómo reabrir.
--  (e) EL CATÁLOGO DE CORTES ES CERRADO. La pantalla enseña un texto distinto
--      por clase; una clase inventada se pintaría como un hueco. Las nueve del
--      catálogo entran, cualquier otra rebota.
--  (f) NI UNA CONTRASEÑA NI UNA COOKIE. Igual que en la 0232: `ultimo_motivo`
--      es una frase para una persona y esta columna la lee el panel EN CLARO.
--      Un valor que empiece por `{` o `[` sería un volcado.
--  (g) EL CONTADOR NO PUEDE IR AL REVÉS. Un `intentos_dia` negativo apagaría
--      el freno antibloqueo — el que impide que Likida le queme los intentos
--      a la cuenta del cliente. Mejor que reviente ruidoso.
--  (h) UNA FILA POR (FLOTA, PORTAL): de eso depende el UPSERT del escritor.
--  (i) Y LA MISMA CLAVE SÍ ENTRA PARA OTRA FLOTA: el candado es por tenant.
--  (j) EL BORRADO DE LA FLOTA SE LLEVA SUS PERMISOS (cascade).
--  (k) La llave `(id, tenant_id)` de la casa (0028/0145).
--  (l) El doble candado: RLS deny-all + solo service_role. Esta tabla decide
--      si una contraseña se descifra; que `anon` no la pueda ni leer es la
--      diferencia entre un permiso y una sugerencia.
do $$
declare
  ta uuid; tb uuid;
  sin_firma_rebota boolean; con_firma_entra boolean; no_sin_firma_entra boolean;
  bloqueo_sin_clase_rebota boolean; clase_inventada_rebota boolean;
  clase_catalogo_entra boolean; motivo_json_rebota boolean;
  intentos_negativos_rebotan boolean; duplicado_rebota boolean;
  otra_flota_entra boolean; cascade_limpia boolean; llave_compuesta boolean;
  cerrado boolean;
  quedan integer;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0233 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0233 B') returning id into tb;

  -- (a) Permiso sin autor ni fecha: no entra.
  begin
    insert into portal_relogin (tenant_id, comercio, permitido)
      values (ta, 'g500', true);
    sin_firma_rebota := false;
  exception when check_violation then
    sin_firma_rebota := true;
  end;

  -- (b) Con quién y cuándo, sí.
  begin
    insert into portal_relogin (tenant_id, comercio, permitido, permitido_por, permitido_en)
      values (ta, 'g500', true, 'contralor@flota.mx', now());
    con_firma_entra := true;
  exception when others then
    con_firma_entra := false;
  end;

  -- (c) El «no» no necesita firma: es el estado de todo portal sin autorizar.
  begin
    insert into portal_relogin (tenant_id, comercio, permitido)
      values (ta, 'la_gas', false);
    no_sin_firma_entra := true;
  exception when others then
    no_sin_firma_entra := false;
  end;

  -- (d) Un candado sin motivo: no entra.
  begin
    insert into portal_relogin (tenant_id, comercio, bloqueado)
      values (ta, 'capufe', true);
    bloqueo_sin_clase_rebota := false;
  exception when check_violation then
    bloqueo_sin_clase_rebota := true;
  end;

  -- (e) El catálogo cerrado de cortes.
  begin
    insert into portal_relogin (tenant_id, comercio, ultima_clase)
      values (ta, 'capufe', 'resolvi_el_captcha');
    clase_inventada_rebota := false;
  exception when check_violation then
    clase_inventada_rebota := true;
  end;

  begin
    insert into portal_relogin (tenant_id, comercio, bloqueado, ultima_clase, ultimo_motivo)
      values (ta, 'capufe', true, 'credencial_invalida',
              'El portal rechazó el usuario o la contraseña guardados. NO se vuelve a intentar.');
    clase_catalogo_entra := true;
  exception when others then
    clase_catalogo_entra := false;
  end;

  -- (f) Ni una cookie ni una contraseña: un JSON en `ultimo_motivo` rebota.
  begin
    insert into portal_relogin (tenant_id, comercio, ultima_clase, ultimo_motivo)
      values (ta, 'megasur', 'captcha', '{"contrasena":"hunter2"}');
    motivo_json_rebota := false;
  exception when check_violation then
    motivo_json_rebota := true;
  end;

  -- (g) El contador del freno no puede ir al revés.
  begin
    insert into portal_relogin (tenant_id, comercio, intentos_dia)
      values (ta, 'megasur', -1);
    intentos_negativos_rebotan := false;
  exception when check_violation then
    intentos_negativos_rebotan := true;
  end;

  -- (h) Una fila por (flota, portal): de eso depende el UPSERT.
  begin
    insert into portal_relogin (tenant_id, comercio) values (ta, 'la_gas');
    duplicado_rebota := false;
  exception when unique_violation then
    duplicado_rebota := true;
  end;

  -- (i) Pero la misma clave para OTRA flota sí entra.
  begin
    insert into portal_relogin (tenant_id, comercio, permitido, permitido_por, permitido_en)
      values (tb, 'la_gas', true, 'otro@flota.mx', now());
    otra_flota_entra := true;
  exception when others then
    otra_flota_entra := false;
  end;

  -- (j) Borrar la flota se lleva sus permisos.
  delete from tenant where id = tb;
  select count(*) into quedan from portal_relogin where tenant_id = tb;
  cascade_limpia := (quedan = 0);

  -- (k) La llave que hace posibles las FK compuestas de la casa.
  llave_compuesta := exists (
    select 1 from pg_constraint
    where conname = 'portal_relogin_id_tenant_key'
      and conrelid = 'public.portal_relogin'::regclass
      and contype = 'u'
  );

  -- (l) El doble candado.
  cerrado := not has_table_privilege('anon', 'public.portal_relogin', 'SELECT')
    and not has_table_privilege('authenticated', 'public.portal_relogin', 'SELECT')
    and has_table_privilege('service_role', 'public.portal_relogin', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.portal_relogin'::regclass);

  raise exception 'PORTAL_RELOGIN_0233  sin_firma_rebota=%  con_firma_entra=%  no_sin_firma_entra=%  bloqueo_sin_clase_rebota=%  clase_inventada_rebota=%  clase_catalogo_entra=%  motivo_json_rebota=%  intentos_negativos_rebotan=%  duplicado_rebota=%  otra_flota_entra=%  cascade_limpia=%  llave_compuesta=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t / t)',
    sin_firma_rebota, con_firma_entra, no_sin_firma_entra, bloqueo_sin_clase_rebota,
    clase_inventada_rebota, clase_catalogo_entra, motivo_json_rebota,
    intentos_negativos_rebotan, duplicado_rebota, otra_flota_entra,
    cascade_limpia, llave_compuesta, cerrado;
end $$;

-- ── 189. Ingeniería: los 8 vivos con reloj y techo, las 49 palancas, el registro del despliegue y las cuatro lecturas del catálogo (mig. 0234) ──
-- Los bloques 183-188 los tomaron las ramas paralelas de esta ola (183
-- crecimiento, 186 el vínculo de portales, 187 la descarga masiva del SAT,
-- 188 el re-login de portales); esta toma el 189.
--
-- Lo que SOLO la base puede demostrar de la 0234:
--
--  (a) LOS OCHO PASAN LOS CANDADOS 2 Y 3 DEL RUNNER. `estado='vivo'` +
--      `runner_habilitado` + `disparador='cron'` + techo declarado > 0 no es
--      cosmética: la consulta del runner filtra por los tres primeros y el
--      candado 3 salta a quien no tenga techo. Si esto no sale 8, hay agentes
--      que el PR dice que encendió y que el cron nunca despacha. `releases`
--      es el caso a vigilar: venía con disparador 'manual' desde la 0125.
--  (b) EL MODELO SE DECLARA CON LA VERDAD DEL MOTOR. Los OCHO son
--      deterministas y su `modelo_rol` es NULL (convención 0125 = no usa
--      modelo de texto). La 0125 les había puesto 'codigo'/'analisis'
--      pensando en agentes que leerían fuentes; el motor construido no llama
--      a ningún modelo, y dejar el rol haría que /admin/consumo esperara un
--      costo que nunca llega.
--  (c) LAS 49 PALANCAS. Las 8 nuevas entran, y —la trampa que la 0227
--      corrigió y que se repite en cada ola— las 41 ANTERIORES siguen en el
--      dominio: si esta migración hubiera enumerado solo las suyas, apagar a
--      `alianzas` o a `redactor` rebotaría con check_violation el día del
--      incidente, que es el peor día para descubrirlo.
--  (d) Una palanca inventada rebota: el dominio es cerrado.
--  (e) UN PARTE POR PERIODO para los ocho, y el índice sigue siendo PARCIAL
--      (el Redactor sí puede repetir título: dos prospectos comparten asunto).
--  (f) `despliegue_visto` no admite un SHA que no lo sea, ni un reloj al
--      revés, ni cero vistas — y lleva el doble candado (RLS + solo
--      service_role).
--  (g) LAS CUATRO LECTURAS ESTÁN CERRADAS: revocadas de anon y authenticated,
--      concedidas solo a service_role, y las dos SECURITY DEFINER traen
--      `search_path` fijo (sin él, una DEFINER resuelve nombres con el
--      search_path de quien la llama).
--  (h) `migraciones_aplicadas()` DEGRADA DICIENDO. En esta base de CI no
--      existe `supabase_migrations`, así que tiene que contestar
--      disponible=false CON MOTIVO — jamás una lista vacía que el agente
--      leería como «no hay migraciones aplicadas».
--  (i) `contrato_de_esquema()` encuentra el CHECK del interruptor y ve el
--      índice único nuevo: es lo que el auditor de código compara contra la
--      constante INTERRUPTORES del bundle.
do $$
declare
  vivos_con_reloj_y_techo int;
  con_modelo int; sin_modelo int;
  palancas_nuevas int; palancas_previas int;
  palanca_inventada_rebota boolean;
  parte_repetido_rebota boolean; redactor_repite boolean;
  sha_falso_rebota boolean; reloj_al_reves_rebota boolean; cero_vistas_rebota boolean;
  despliegue_cerrado boolean;
  funciones_cerradas int; definer_con_search_path int;
  migraciones_degrada boolean;
  check_visto boolean; indice_visto boolean;
begin
  -- (a) y (b) — el catálogo, tal como el runner lo consulta.
  select count(*) into vivos_con_reloj_y_techo from agente_definicion
    where id in ('migraciones','seguridad','rendimiento','pruebas',
                 'auditor_codigo','releases','producto','datos_instrumentacion')
      and estado = 'vivo' and runner_habilitado and disparador = 'cron'
      and presupuesto_dia_usd is not null and presupuesto_dia_usd > 0;

  select count(*) into con_modelo from agente_definicion
    where departamento = 'ingenieria' and modelo_rol is not null;
  select count(*) into sin_modelo from agente_definicion
    where departamento = 'ingenieria' and modelo_rol is null;

  -- (c) Las 8 nuevas…
  palancas_nuevas := 0;
  begin
    insert into interruptor (id, apagado) values
      ('agente:migraciones', false), ('agente:seguridad', false),
      ('agente:rendimiento', false), ('agente:pruebas', false),
      ('agente:auditor_codigo', false), ('agente:releases', false),
      ('agente:producto', false), ('agente:datos_instrumentacion', false);
    palancas_nuevas := 8;
  exception when check_violation then
    palancas_nuevas := -1;
  end;
  -- …y una muestra de las de CADA ola anterior, que es donde vive la trampa.
  palancas_previas := 0;
  begin
    insert into interruptor (id, apagado) values
      ('global', false), ('agente:redactor', false),
      ('agente:tesoreria', false), ('agente:orquestador', false),
      ('agente:enviador', false), ('agente:atencion_faq', false),
      ('agente:talento', false), ('agente:alianzas', false),
      ('agente:descarga_sat', false);
    palancas_previas := 9;
  exception when check_violation then
    palancas_previas := -1;
  end;

  -- (d) El dominio es cerrado.
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:inventado_0234', true, 'basura');
    palanca_inventada_rebota := false;
  exception when check_violation then
    palanca_inventada_rebota := true;
  end;

  -- (e) Un parte por periodo.
  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('parte_seguridad', 'normal', 'seguridad', 'Seguridad — semana del 2026-08-24', 'cuerpo');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('parte_seguridad', 'normal', 'seguridad', 'Seguridad — semana del 2026-08-24', 'otra corrida');
    parte_repetido_rebota := false;
  exception when unique_violation then
    parte_repetido_rebota := true;
  end;

  -- (e bis) El índice es PARCIAL: el Redactor sí repite título.
  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('correo_frio', 'normal', 'redactor', 'Tu liquidacion 0234', 'a');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('correo_frio', 'normal', 'redactor', 'Tu liquidacion 0234', 'b');
    redactor_repite := true;
  exception when unique_violation then
    redactor_repite := false;
  end;

  -- (f) El registro del despliegue.
  begin
    insert into despliegue_visto (sha, entorno) values ('no-es-un-sha', 'production');
    sha_falso_rebota := false;
  exception when check_violation then
    sha_falso_rebota := true;
  end;
  begin
    insert into despliegue_visto (sha, entorno, primera_vista, ultima_vista)
      values ('abc1234', 'production', now(), now() - interval '1 day');
    reloj_al_reves_rebota := false;
  exception when check_violation then
    reloj_al_reves_rebota := true;
  end;
  begin
    insert into despliegue_visto (sha, entorno, vistas) values ('def5678', 'production', 0);
    cero_vistas_rebota := false;
  exception when check_violation then
    cero_vistas_rebota := true;
  end;
  despliegue_cerrado := not has_table_privilege('anon', 'public.despliegue_visto', 'SELECT')
    and not has_table_privilege('authenticated', 'public.despliegue_visto', 'SELECT')
    and has_table_privilege('service_role', 'public.despliegue_visto', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.despliegue_visto'::regclass);

  -- (g) Las cuatro lecturas, cerradas.
  select count(*) into funciones_cerradas
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('migraciones_aplicadas', 'postura_seguridad', 'perfil_almacenamiento', 'contrato_de_esquema')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and has_function_privilege('service_role', p.oid, 'EXECUTE');

  select count(*) into definer_con_search_path
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('migraciones_aplicadas', 'postura_seguridad', 'perfil_almacenamiento', 'contrato_de_esquema')
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) o where o like 'search_path=%');

  -- (h) Degrada DICIENDO, no con una lista vacía.
  migraciones_degrada := (
    to_regclass('supabase_migrations.schema_migrations') is not null
    or ((public.migraciones_aplicadas()->>'disponible')::boolean = false
        and length(coalesce(public.migraciones_aplicadas()->>'motivo', '')) > 20));

  -- (i) El contrato ve el CHECK y el índice nuevo.
  check_visto := position('agente:datos_instrumentacion' in coalesce(public.contrato_de_esquema()->>'interruptor_check', '')) > 0;
  indice_visto := public.contrato_de_esquema()->'indices_unicos_parciales_cola' ? 'cola_parte_ingenieria_por_periodo';

  raise exception 'INGENIERIA_0234  vivos_con_reloj_y_techo=%  con_modelo=%  sin_modelo=%  palancas_nuevas=%  palancas_previas=%  palanca_inventada_rebota=%  parte_repetido_rebota=%  redactor_repite=%  sha_falso_rebota=%  reloj_al_reves_rebota=%  cero_vistas_rebota=%  despliegue_cerrado=%  funciones_cerradas=%  definer_con_search_path=%  migraciones_degrada=%  check_visto=%  indice_visto=%   (esperado 8 / 0 / 8 / 8 / 9 / t / t / t / t / t / t / t / 4 / 2 / t / t / t)',
    vivos_con_reloj_y_techo, con_modelo, sin_modelo, palancas_nuevas, palancas_previas,
    palanca_inventada_rebota, parte_repetido_rebota, redactor_repite,
    sha_falso_rebota, reloj_al_reves_rebota, cero_vistas_rebota, despliegue_cerrado,
    funciones_cerradas, definer_con_search_path, migraciones_degrada, check_visto, indice_visto;
end $$;

-- ── 190. Los nueve que cierran la compañía agente: 60/60 vivos, 58 palancas y una pieza por clave (mig. 0235) ──
-- Los bloques 188 y 189 los tomaron el re-login de portales (0233) y los ocho
-- de ingeniería (0234), las dos olas paralelas a ésta; aquí se toma el 190.
--
-- Lo que SOLO la base puede demostrar de la 0235:
--
--  (a) LOS NUEVE PASAN LOS CANDADOS 2 Y 3 DEL RUNNER. `estado='vivo'` +
--      `runner_habilitado` + `disparador='cron'` + techo declarado > 0 no es
--      cosmética: la consulta del runner filtra por los tres primeros y el
--      candado 3 salta a quien no tenga techo. Si este valor no sale 9, hay
--      agentes que el PR dice que encendió y que el cron nunca despacha.
--  (b) EL MODELO SE DECLARA CON LA VERDAD DEL MOTOR. Los nueve motores
--      construidos son deterministas, así que su `modelo_rol` tiene que ser
--      NULL (convención 0125). Los nueve traían uno del BLUEPRINT y si alguno
--      sobrevivió, el catálogo estaría contando un LLM que nadie llama.
--  (c) DIRECCIÓN Y LEADS QUEDAN COMPLETOS: cero filas de esos dos
--      departamentos fuera de 'vivo'. Es el hito que esta ola cierra, y es una
--      afirmación que solo la base puede sostener. (Ingeniería sigue en
--      'disenado' — la enciende otra ola, y por eso este conteo se acota a los
--      dos departamentos de esta migración en vez de mirar el catálogo entero;
--      con la 0234 ya dentro, ingeniería también quedó viva y el catálogo llega
--      a 60/60, pero afirmarlo aquí ataría este bloque al de la otra ola.)
--  (d) LAS 58 PALANCAS. Las 9 nuevas entran, y —la trampa que la 0227 corrigió
--      y que se repite en cada ola— las 49 ANTERIORES siguen en el dominio: si
--      esta migración hubiera enumerado solo las suyas, apagar a `talento`, a
--      `redactor`, a `descarga_sat` o a `seguridad` rebotaría con
--      check_violation el día del incidente, que es el peor día para
--      descubrirlo. Las 8 de ingeniería se absorbieron EN EL REBASE: la 0234
--      entró después de escribir esta migración y antes de mergearla, así que
--      el conteo tuvo que rehacerse contra el dominio vigente.
--  (e) Una palanca inventada rebota: el dominio es cerrado.
--  (f) UNA PIEZA POR CLAVE, en los DOS índices nuevos (dirección y leads). El
--      título es determinista por semana, por mes, por empresa o por
--      expediente, y estos índices son el árbitro de la carrera entre dos
--      pasadas del runner: la idempotencia es un constraint, no un `if` que
--      dos procesos concurrentes se saltan.
--  (g) LOS ÍNDICES SON PARCIALES. El Redactor SÍ puede repetir título: dos
--      prospectos pueden compartir el asunto de un correo legítimamente, y un
--      índice global rompería la campaña.
--  (h) EL INVARIANTE DEL QUE VIVE `especialistas_incidente`: `hay_lesionados`
--      admite NULL y NO tiene default. La 0198 lo dice con todas sus letras —
--      NULL significa NO PREGUNTADO— y el agente cuelga de eso su decisión más
--      delicada: sobre un NULL no propone avisarle a ninguna familia. Si algún
--      día alguien le pusiera `default false`, el silencio del chofer se
--      convertiría en un parte médico y este agente empezaría a callar.
--  (i) EL INVARIANTE DEL QUE VIVE `propuestas`: `plan.precio_mensual` admite
--      NULL. Si dejara de admitirlo, el «este borrador va sin precio» dejaría
--      de tener sentido — y peor, alguien habría tenido que inventar un número
--      para poder migrar.
--  (j) EL INVARIANTE DEL QUE VIVE `dossier`: un contacto `inferido` no puede
--      declararse de confianza `alta`. Es lo que le permite a la ficha rotular
--      «NO VERIFICADO» sin tener que confiar en el criterio de quien capturó.
do $$
declare
  ta uuid; oa uuid; pa uuid;
  vivos_con_reloj_y_techo int;
  con_modelo int; departamentos_incompletos int;
  palancas_nuevas int; palancas_previas int;
  palanca_inventada_rebota boolean;
  pieza_direccion_repetida_rebota boolean; pieza_leads_repetida_rebota boolean;
  redactor_repite boolean;
  lesionados_nulo boolean;
  plan_sin_precio_entra boolean;
  inferido_alta_rebota boolean; inferido_baja_entra boolean;
begin
  -- (a) y (b) — el catálogo, tal como el runner lo consulta.
  select count(*) into vivos_con_reloj_y_techo from agente_definicion
    where id in ('automejora','especialistas_incidente','fundraising',
                 'scorer','dossier','vigia','demo_prep','propuestas','cazador')
      and estado = 'vivo' and runner_habilitado and disparador = 'cron'
      and presupuesto_dia_usd is not null and presupuesto_dia_usd > 0;

  select count(*) into con_modelo from agente_definicion
    where id in ('automejora','especialistas_incidente','fundraising',
                 'scorer','dossier','vigia','demo_prep','propuestas','cazador')
      and modelo_rol is not null;

  -- (c) Los dos departamentos de esta ola, completos.
  select count(*) into departamentos_incompletos from agente_definicion
    where departamento in ('direccion', 'leads') and estado <> 'vivo';

  -- (d) Las 9 nuevas…
  palancas_nuevas := 0;
  begin
    insert into interruptor (id, apagado) values
      ('agente:automejora', false), ('agente:especialistas_incidente', false),
      ('agente:fundraising', false), ('agente:scorer', false),
      ('agente:dossier', false), ('agente:vigia', false),
      ('agente:demo_prep', false), ('agente:propuestas', false),
      ('agente:cazador', false);
    palancas_nuevas := 9;
  exception when check_violation then
    palancas_nuevas := -1;
  end;
  -- …y una muestra de las de CADA ola anterior, que es donde vive la trampa.
  palancas_previas := 0;
  begin
    insert into interruptor (id, apagado) values
      ('global', false), ('agente:redactor', false),
      ('agente:tesoreria', false), ('agente:orquestador', false),
      ('agente:enviador', false), ('agente:atencion_faq', false),
      ('agente:talento', false), ('agente:alianzas', false),
      ('agente:descarga_sat', false), ('agente:seguridad', false);
    palancas_previas := 10;
  exception when check_violation then
    palancas_previas := -1;
  end;

  -- (e) El dominio es cerrado.
  begin
    insert into interruptor (id, apagado, motivo) values ('agente:inventado_0235', true, 'basura');
    palanca_inventada_rebota := false;
  exception when check_violation then
    palanca_inventada_rebota := true;
  end;

  -- (f) Una pieza por clave, en los dos índices.
  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('parte_automejora', 'normal', 'automejora', 'Automejora - semana del 2026-08-17', 'cuerpo');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('parte_automejora', 'normal', 'automejora', 'Automejora - semana del 2026-08-17', 'otra corrida');
    pieza_direccion_repetida_rebota := false;
  exception when unique_violation then
    pieza_direccion_repetida_rebota := true;
  end;

  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('vigilancia_leads', 'normal', 'vigia', 'Vigia de leads - 2026-08-27', 'cuerpo');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('vigilancia_leads', 'normal', 'vigia', 'Vigia de leads - 2026-08-27', 'otra corrida');
    pieza_leads_repetida_rebota := false;
  exception when unique_violation then
    pieza_leads_repetida_rebota := true;
  end;

  -- (g) Los índices son PARCIALES: el Redactor sí repite título.
  insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
    values ('correo_frio', 'normal', 'redactor', 'Tu cuadre de viajes', 'a');
  begin
    insert into cola_aprobacion (tipo, prioridad, agente, titulo, cuerpo)
      values ('correo_frio', 'normal', 'redactor', 'Tu cuadre de viajes', 'b');
    redactor_repite := true;
  exception when unique_violation then
    redactor_repite := false;
  end;

  -- (h) `hay_lesionados` sin preguntar sigue siendo NULL, no false.
  insert into tenant (nombre) values ('ZZZ VERIF 0235') returning id into ta;
  insert into operador (tenant_id, nombre, telefono)
    values (ta, 'ZZZ 0235', '+520000000235') returning id into oa;
  insert into incidencia (tenant_id, operador_id, tipo, prioridad, estado)
    values (ta, oa, 'siniestro', 'critica', 'abierta');
  select hay_lesionados is null into lesionados_nulo from incidencia
    where tenant_id = ta;

  -- (i) Un plan sin precio declarado sigue cabiendo.
  begin
    insert into plan (clave, nombre, precio_mensual, orden)
      values ('zzz_0235', 'ZZZ sin precio', null, 99);
    plan_sin_precio_entra := true;
  exception when others then
    plan_sin_precio_entra := false;
  end;

  -- (j) Un contacto INFERIDO no puede declararse de confianza alta.
  insert into prospecto (empresa) values ('ZZZ VERIF 0235 SA') returning id into pa;
  begin
    insert into prospecto_persona (prospecto_id, nombre, origen, confianza)
      values (pa, 'ZZZ Persona', 'inferido', 'alta');
    inferido_alta_rebota := false;
  exception when check_violation then
    inferido_alta_rebota := true;
  end;
  begin
    insert into prospecto_persona (prospecto_id, nombre, origen, confianza)
      values (pa, 'ZZZ Persona', 'inferido', 'baja');
    inferido_baja_entra := true;
  exception when others then
    inferido_baja_entra := false;
  end;

  raise exception 'AGENTES_0235  vivos_con_reloj_y_techo=%  con_modelo=%  departamentos_incompletos=%  palancas_nuevas=%  palancas_previas=%  palanca_inventada_rebota=%  pieza_direccion_repetida_rebota=%  pieza_leads_repetida_rebota=%  redactor_repite=%  lesionados_nulo=%  plan_sin_precio_entra=%  inferido_alta_rebota=%  inferido_baja_entra=%   (esperado 9 / 0 / 0 / 9 / 10 / t / t / t / t / t / t / t / t)',
    vivos_con_reloj_y_techo, con_modelo, departamentos_incompletos,
    palancas_nuevas, palancas_previas, palanca_inventada_rebota,
    pieza_direccion_repetida_rebota, pieza_leads_repetida_rebota, redactor_repite,
    lesionados_nulo, plan_sin_precio_entra, inferido_alta_rebota, inferido_baja_entra;
end $$;

-- ── 191. La descarga del SAT, corregida: borrar SÍ se puede, el traslape rebota y las cifras no se truncan (mig. 0236) ──
-- El 189 lo tomó la ola de ingeniería (0234) y el 190 el de dirección+leads
-- (0235), paralelas a ésta; aquí se toma el 191. Los números se confirmaron al
-- rebasar contra master, que es el momento en que un número se puede afirmar.
--
-- Este bloque prueba lo que la auditoría adversarial del ciclo 7 encontró en la
-- 0231 y que el bloque 187 NO podía ver, porque 187 verifica la feature tal
-- como se creyó escrita: nunca BORRA nada, y un arreglo de FK que no se prueba
-- borrando algo no está probado.
--
--  (a) c7-3 · BORRAR UN GASTO CON UN CFDI CASADO COLGANDO. La 0231 dejó
--      `on delete set null` SIN lista de columnas sobre una FK compuesta
--      `(gasto_id, tenant_id)` — y `tenant_id` es NOT NULL. Postgres intentaba
--      anular también el tenant y el DELETE del gasto (o del viaje que lo
--      cascadea, o de la flota entera) reventaba con un error de NOT NULL que
--      no dice ni una palabra del origen real. Aquí se BORRA de verdad.
--  (b) …Y EL COMPROBANTE SOBREVIVE, DEGRADADO Y DICIENDO POR QUÉ. No se
--      cascadea: `sat_cfdi_descargado` es EL SELLO DE DEDUP de toda la
--      feature, y borrarlo dejaría entrar el mismo folio fiscal otra vez. Pero
--      tampoco puede seguir diciendo 'casado' sin gasto: eso rompería
--      `casado_coherente`, que es el candado que impide afirmar un cruce que
--      no existe. Queda 'disponible' con el motivo escrito.
--  (c) LO MISMO AL BORRAR LA SOLICITUD, Y AL BORRAR LA FLOTA ENTERA
--      (`delete from tenant`, que es el camino real de borrado de una flota en
--      `src/lib/admin/qa-motor.ts`).
--  (d) EL BARRIDO DEL CATÁLOGO, para que no vuelva a pasar sin que nadie lo
--      note: NINGUNA FK compuesta de la base puede tener `on delete set null`
--      sin lista de columnas cuando alguna de sus columnas referenciantes es
--      NOT NULL. `confdelsetcols` (Postgres 15+) es exactamente esa lista;
--      vacía significa "anula todas". Esperado: lista vacía. Una migración
--      futura que copie el patrón aparece aquí con nombre y CI se pone rojo —
--      que es lo que le faltó al bloque 112, que sólo mira FKs SIMPLES sin
--      hermana compuesta y nunca miró `confdeltype`.
--  (e) c7-2 · LA MEMORIA DEL AVANCE. `paquetes_bajados` existe y sólo admite
--      un ARREGLO: sin ella, una solicitud de más de 3 paquetes re-descargaba
--      los mismos 3 cada 6 h contra el buzón fiscal real, para siempre.
--  (f) c7-22 · EL TRASLAPE, NO SÓLO EL PAR EXACTO. Dos rangos DISTINTOS sobre
--      los mismos días eran dos trámites vivos y dos peticiones al SAT contra
--      el mismo periodo. Un rango pegado pero sin traslape sí entra (si no,
--      el calendario no podría avanzar), y un rango ya CERRADO se puede volver
--      a pedir: un reintento deliberado sigue siendo legítimo.
--  (g) c7-27 · LOS CONTEOS, CONTADOS EN LA BASE. La pantalla traía 20,000
--      filas y contaba en JS: con más comprobantes que eso, las cuatro cifras
--      salían falsas sin que nada lo dijera. Y la función está cerrada a
--      anon/authenticated como todo lo demás de la feature.
do $$
declare
  ta uuid; tb uuid; oa uuid; va uuid; ga uuid; sol uuid; sol2 uuid;
  set_null_compuestas text;
  borrar_gasto_ok boolean; cfdi_sobrevive boolean; cfdi_degradado boolean; motivo_escrito boolean;
  borrar_solicitud_ok boolean; cfdi_sin_solicitud boolean; borrar_flota_ok boolean;
  paquetes_objeto_rebota boolean; paquetes_arreglo_entra boolean;
  traslape_rebota boolean; pegado_entra boolean; cerrado_reentra boolean;
  conteos_exactos boolean; conteos_cerrados boolean;
begin
  -- ── (d) El barrido, ANTES de tocar datos: es catálogo, no filas ──────────
  select coalesce(string_agg(
           con.conrelid::regclass::text || '.' || con.conname, ', ' order by con.conname), '—')
    into set_null_compuestas
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and con.contype = 'f'
     and con.confdeltype = 'n'                              -- ON DELETE SET NULL
     and array_length(con.conkey, 1) > 1                    -- compuesta
     and coalesce(array_length(con.confdelsetcols, 1), 0) = 0  -- sin lista: anula TODAS
     and exists (
       select 1 from pg_attribute a
        where a.attrelid = con.conrelid
          and a.attnum = any (con.conkey)
          and a.attnotnull and not a.attisdropped);

  insert into tenant (nombre) values ('ZZZ VERIF 0236 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0236 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono)
    values (ta, 'ZZZ 0236', '+520000000236') returning id into oa;
  insert into viaje (tenant_id, operador_id, folio) values (ta, oa, 'ZZZ-0236') returning id into va;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
    values (ta, va, 'caseta', 300, current_date) returning id into ga;
  insert into sat_descarga_config (tenant_id, rfc) values (ta, 'EKU9003173C9');
  insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado, request_id)
    values (ta, 'recibidos', date '2026-08-01', date '2026-08-31', 'en_proceso', 'req-0236-a')
    returning id into sol;

  -- Un comprobante CASADO con ese gasto: el escenario del hallazgo.
  insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, solicitud_id, gasto_id, estatus, total, fecha)
    values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000236', sol, ga, 'casado', 300, current_date);
  -- Dos más, para que los conteos de (g) tengan algo que contar.
  insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, solicitud_id, estatus, total)
    values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000237', sol, 'ambiguo', 100),
           (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000238', sol, 'disponible', 200);

  -- ── (g) Los conteos, antes de empezar a borrar ───────────────────────────
  select descargados = 3 and casados = 1 and ambiguos = 1 and disponibles = 1 and ignorados = 0
    into conteos_exactos
    from public.sat_descarga_conteos(ta);
  conteos_cerrados :=
        not has_function_privilege('anon', 'public.sat_descarga_conteos(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.sat_descarga_conteos(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.sat_descarga_conteos(uuid)', 'EXECUTE');

  -- ── (e) c7-2: la memoria del avance ──────────────────────────────────────
  begin
    update sat_descarga_solicitud set paquetes_bajados = '{"p1": true}'::jsonb where id = sol;
    paquetes_objeto_rebota := false;
  exception when check_violation then
    paquetes_objeto_rebota := true;
  end;
  begin
    update sat_descarga_solicitud set paquetes_bajados = '["p1","p2"]'::jsonb where id = sol;
    paquetes_arreglo_entra := true;
  exception when others then
    paquetes_arreglo_entra := false;
  end;

  -- ── (f) c7-22: el traslape ───────────────────────────────────────────────
  -- Rango DISTINTO (un día menos) que cubre los mismos días: el índice único
  -- viejo lo dejaba pasar porque el PAR de fechas no era el mismo.
  begin
    insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado)
      values (ta, 'recibidos', date '2026-08-01', date '2026-08-30', 'solicitada');
    traslape_rebota := false;
  exception when exclusion_violation then
    traslape_rebota := true;
  end;
  -- Pegado pero SIN traslape: el calendario tiene que poder avanzar.
  begin
    insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado)
      values (ta, 'recibidos', date '2026-09-01', date '2026-09-30', 'solicitada')
      returning id into sol2;
    pegado_entra := true;
  exception when others then
    pegado_entra := false;
  end;
  -- Y un rango CERRADO se puede volver a pedir.
  update sat_descarga_solicitud set estado = 'descargada' where id = sol2;
  begin
    insert into sat_descarga_solicitud (tenant_id, tipo, desde, hasta, estado)
      values (ta, 'recibidos', date '2026-09-10', date '2026-09-20', 'solicitada');
    cerrado_reentra := true;
  exception when others then
    cerrado_reentra := false;
  end;

  -- ── (a)(b) c7-3: BORRAR EL GASTO. Lo que hasta la 0236 reventaba ─────────
  begin
    delete from gasto where id = ga;
    borrar_gasto_ok := true;
  exception when others then
    borrar_gasto_ok := false;
  end;
  select count(*) = 1 into cfdi_sobrevive
    from sat_cfdi_descargado where cfdi_uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000236';
  select estatus = 'disponible' and gasto_id is null and tenant_id = ta
    into cfdi_degradado
    from sat_cfdi_descargado where cfdi_uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000236';
  select candidatos ->> 'motivo' like '%se borró%' into motivo_escrito
    from sat_cfdi_descargado where cfdi_uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000236';

  -- ── (c) Borrar la solicitud, y después la flota entera ───────────────────
  begin
    delete from sat_descarga_solicitud where id = sol;
    borrar_solicitud_ok := true;
  exception when others then
    borrar_solicitud_ok := false;
  end;
  select solicitud_id is null and tenant_id = ta into cfdi_sin_solicitud
    from sat_cfdi_descargado where cfdi_uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000236';

  begin
    delete from tenant where id = ta;
    borrar_flota_ok := true;
  exception when others then
    borrar_flota_ok := false;
  end;

  raise exception 'DESCARGA_SAT_0236  set-null-compuestas-sin-columna=%  borrar_gasto_ok=%  cfdi_sobrevive=%  cfdi_degradado=%  motivo_escrito=%  borrar_solicitud_ok=%  cfdi_sin_solicitud=%  borrar_flota_ok=%  paquetes_objeto_rebota=%  paquetes_arreglo_entra=%  traslape_rebota=%  pegado_entra=%  cerrado_reentra=%  conteos_exactos=%  conteos_cerrados=%   (esperado — / t / t / t / t / t / t / t / t / t / t / t / t / t / t)',
    set_null_compuestas, borrar_gasto_ok, cfdi_sobrevive, cfdi_degradado, motivo_escrito,
    borrar_solicitud_ok, cfdi_sin_solicitud, borrar_flota_ok,
    paquetes_objeto_rebota, paquetes_arreglo_entra,
    traslape_rebota, pegado_entra, cerrado_reentra, conteos_exactos, conteos_cerrados;
end $$;

-- ── 192. La corrección del portal de pago: el abono no se puede duplicar, el REP no se puede colgar de otra factura, y un CFDI cancelado no cobra (mig. 0237) ──
-- Los bloques 189-191 los toman ramas paralelas de esta misma ola (ingeniería,
-- dirección+leads y SAT); aquí se toma el 192.
--
-- Lo que SOLO la base puede demostrar, y que la auditoría del ciclo 7 encontró
-- abierto:
--
--  (a) `c7-5` — CONCILIAR DOS VECES NO PUEDE CREAR DOS ABONOS. Es el hallazgo
--      caro: dinero duplicado en la cartera de un cliente real. Se ataca como
--      pasaba de verdad —la misma propuesta conciliada dos veces— y se exige
--      que rebote LA BASE (`unique_violation` contra
--      `pago_recibido_propuesta_unica`), no un `if` de TypeScript. Un `if`
--      previo no se puede probar aquí, y ese es justamente el punto: lo que no
--      es una restricción no es una garantía.
--  (b) El pago TECLEADO a mano no compite por esa llave: `propuesta_id` es NULL
--      y el índice es parcial, así que dos abonos manuales sobre la misma
--      factura siguen entrando (los pagos parciales son la norma).
--  (c) `c7-25` — un REP no se puede colgar del abono de OTRA factura. Con las
--      FK de dos columnas de la 0228 esto pasaba: solo garantizaban la misma
--      flota. Ahora la llave es de tres.
--  (d) Lo mismo para la propuesta conciliada: su `pago_id` tiene que ser un
--      abono de SU factura.
--  (e) `c7-18` — la idempotencia de la bandeja es PARCIAL sobre las pendientes:
--      dos pendientes idénticas chocan, pero una DESCARTADA ya no bloquea que
--      el cliente vuelva a registrar su depósito (antes la página le contestaba
--      «ya estaba registrado, no hace falta hacer nada más», que era falso). Y
--      la llave es por FACTURA, no por liga: revocar el enlace y generar otro
--      ya no deja entrar la misma referencia dos veces.
--  (f) `c7-15` — existe un índice que EMPIEZA por `token_prefijo`, que es la
--      columna por la que busca cada visita de la ruta pública.
--  (g) `c7-7` — un abono contra una factura CANCELADA rebota en la propia RPC,
--      y `factura_saldo` SIGUE reportando saldo sobre ella: eso último es la
--      razón por la que la puerta tiene que estar además en la lectura pública
--      (`vistaDelPortal` → `no_cobrable`, probado en
--      `portal_pago_lectura.test.ts`). La vista no miente: calcula total menos
--      pagos, que es lo suyo; quien no puede confiarse es la página.
--  (h) La forma de las llaves nuevas: la FK compuesta a la propuesta anula SOLO
--      su columna (`on delete set null (propuesta_id)`, patrón 0145 — `set
--      null` a secas reventaría el DELETE contra un `tenant_id` NOT NULL), y la
--      del REP es de tres columnas.
do $$
declare
  ta uuid; ca uuid; fa uuid; fb uuid; fc uuid;
  liga_a uuid; liga_b uuid; prop uuid; prop2 uuid;
  pago_a uuid; pago_b uuid; res jsonb;
  segundo_abono_rebota boolean := false;
  abonos_de_la_propuesta int;
  manuales_entran boolean := false;
  rep_de_otra_factura_rebota boolean := false;
  rep_correcto_entra boolean := false;
  propuesta_con_pago_ajeno_rebota boolean := false;
  pendiente_repetida_rebota boolean := false;
  descartada_permite_reintento boolean := false;
  llave_por_factura_no_por_liga boolean := false;
  prefijo_indexado boolean;
  abono_a_cancelada_rebota boolean := false;
  saldo_de_cancelada_sigue boolean;
  set_null_por_columna boolean;
  fk_rep_tres_columnas boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0237') returning id into ta;
  insert into cliente (tenant_id, nombre) values (ta, 'ZZZ cli 0237') returning id into ca;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, ca, 30000, 4800, 34800, 'emitida') returning id into fa;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, ca, 500, 80, 580, 'emitida') returning id into fb;
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, ca, 1000, 160, 1160, 'emitida') returning id into fc;
  insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
    values (ta, fa, repeat('a', 64), 'pgo_aaaa', now() + interval '90 days')
    returning id into liga_a;

  -- (a) EL HALLAZGO c7-5, tal como pasaba: dos pestañas del contralor sobre la
  -- MISMA propuesta de $5,000 contra un saldo de $34,800. Ninguna es sobrepago,
  -- así que el `for update` de la RPC no rechaza a ninguna: lo único que puede
  -- impedir el segundo abono es la restricción.
  insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
    values (ta, liga_a, fa, current_date, 5000, 'SPEI-8891') returning id into prop;
  res := registrar_pago_tx(ta, fa, current_date, 5000, 'transferencia', 'SPEI-8891', prop);
  pago_a := (res->>'pago_id')::uuid;
  begin
    perform registrar_pago_tx(ta, fa, current_date, 5000, 'transferencia', 'SPEI-8891', prop);
    segundo_abono_rebota := false;
  exception when unique_violation then
    segundo_abono_rebota := true;
  end;
  select count(*) into abonos_de_la_propuesta from pago_recibido where propuesta_id = prop;

  -- (b) El pago tecleado a mano NO nace de una propuesta y no compite: dos
  -- abonos parciales idénticos sobre la misma factura siguen entrando.
  begin
    perform registrar_pago_tx(ta, fa, current_date, 1000, 'efectivo', null);
    perform registrar_pago_tx(ta, fa, current_date, 1000, 'efectivo', null);
    manuales_entran := true;
  exception when others then
    manuales_entran := false;
  end;

  -- (c) c7-25: el REP de la factura B colgado del abono de la factura A. Con la
  -- FK de dos columnas de la 0228 esto entraba —ambos son de la misma flota— y
  -- el portal del cliente enseñaba un importe que fue a otro papel.
  begin
    insert into rep_emitido (tenant_id, factura_id, pago_id, cfdi_uuid, fecha_pago, imp_pagado)
      values (ta, fb, pago_a, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', current_date, 5000);
    rep_de_otra_factura_rebota := false;
  exception when foreign_key_violation then
    rep_de_otra_factura_rebota := true;
  end;
  begin
    insert into rep_emitido (tenant_id, factura_id, pago_id, cfdi_uuid, fecha_pago, imp_pagado)
      values (ta, fa, pago_a, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', current_date, 5000);
    rep_correcto_entra := true;
  exception when others then
    rep_correcto_entra := false;
  end;

  -- (d) Y la propuesta conciliada tampoco puede apuntar al abono de otra
  -- factura. Se arma la fila COMPLETA y coherente (estado + resuelta_en) para
  -- que lo único que pueda rebotar sea la llave, no el CHECK de estados.
  insert into pago_recibido (tenant_id, factura_id, monto) values (ta, fb, 100) returning id into pago_b;
  begin
    update portal_pago_propuesta
       set estado = 'conciliada', pago_id = pago_b, resuelta_en = now()
     where id = prop;
    propuesta_con_pago_ajeno_rebota := false;
  exception when foreign_key_violation then
    propuesta_con_pago_ajeno_rebota := true;
  end;
  -- Con SU abono sí se sella.
  update portal_pago_propuesta
     set estado = 'conciliada', pago_id = pago_a, resuelta_en = now()
   where id = prop;

  -- (e) c7-18: dos PENDIENTES idénticas chocan…
  insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
    values (ta, liga_a, fa, current_date, 700, 'REF-PARCIAL') returning id into prop2;
  begin
    insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
      values (ta, liga_a, fa, current_date, 700, 'ref-parcial');
    pendiente_repetida_rebota := false;
  exception when unique_violation then
    pendiente_repetida_rebota := true;
  end;

  -- … pero una DESCARTADA ya no bloquea. El contralor descarta, el cliente
  -- revisa su banco, ve que sí pagó y vuelve a registrar: eso tiene que poder
  -- volver a la bandeja, no recibir un «ya estaba registrado» que era mentira.
  update portal_pago_propuesta set estado = 'descartada', resuelta_en = now(), nota = 'no aparece en el estado de cuenta'
   where id = prop2;
  begin
    insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
      values (ta, liga_a, fa, current_date, 700, 'REF-PARCIAL');
    descartada_permite_reintento := true;
  exception when unique_violation then
    descartada_permite_reintento := false;
  end;

  -- Y la llave es por FACTURA, no por liga: se revoca el enlace, se genera otro
  -- —el flujo normal cuando el link se pierde— y la misma referencia sigue sin
  -- poder entrar dos veces.
  update portal_pago_liga set revocada_en = now() where id = liga_a;
  insert into portal_pago_liga (tenant_id, factura_id, token_hash, token_prefijo, expira_en)
    values (ta, fa, repeat('b', 64), 'pgo_bbbb', now() + interval '90 days')
    returning id into liga_b;
  begin
    insert into portal_pago_propuesta (tenant_id, liga_id, factura_id, fecha, monto, referencia)
      values (ta, liga_b, fa, current_date, 700, 'REF-PARCIAL');
    llave_por_factura_no_por_liga := false;
  exception when unique_violation then
    llave_por_factura_no_por_liga := true;
  end;

  -- (f) c7-15: la ruta pública busca por prefijo en cada visita.
  prefijo_indexado := exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'portal_pago_liga'
      and indexdef like '%(token_prefijo%'
  );

  -- (g) c7-7: la base rechaza el abono contra una cancelada…
  update factura_emitida set estatus = 'cancelada' where id = fc;
  begin
    perform registrar_pago_tx(ta, fc, current_date, 100, 'transferencia', 'X');
    abono_a_cancelada_rebota := false;
  exception when others then
    abono_a_cancelada_rebota := (sqlerrm like '%cancelada%');
  end;
  -- … y AUN ASÍ la vista sigue diciendo que esa factura debe $1,160.00. No es
  -- un defecto de la vista —calcula total menos pagos, que es lo suyo—: es la
  -- prueba de que la página pública no puede fiarse del saldo para decidir si
  -- cobra, y de ahí el `no_cobrable` de `vistaDelPortal`.
  select coalesce((select saldo from factura_saldo where factura_id = fc), -1) = 1160
    into saldo_de_cancelada_sigue;

  -- (h) La forma de las llaves nuevas.
  select exists (
    select 1 from pg_constraint
    where conname = 'pago_recibido_propuesta_tenant_fkey'
      and conrelid = 'public.pago_recibido'::regclass
      and confdeltype = 'n'
      and array_length(confdelsetcols, 1) = 1
  ) into set_null_por_columna;
  select exists (
    select 1 from pg_constraint
    where conname = 'rep_emitido_pago_factura_tenant_fkey'
      and conrelid = 'public.rep_emitido'::regclass
      and array_length(conkey, 1) = 3
  ) into fk_rep_tres_columnas;

  raise exception 'PORTAL_PAGO_0237  segundo_abono_rebota=%  abonos_de_la_propuesta=%  manuales_entran=%  rep_de_otra_factura_rebota=%  rep_correcto_entra=%  propuesta_con_pago_ajeno_rebota=%  pendiente_repetida_rebota=%  descartada_permite_reintento=%  llave_por_factura_no_por_liga=%  prefijo_indexado=%  abono_a_cancelada_rebota=%  saldo_de_cancelada_sigue=%  set_null_por_columna=%  fk_rep_tres_columnas=%   (esperado t / 1 / t / t / t / t / t / t / t / t / t / t / t / t)',
    segundo_abono_rebota, abonos_de_la_propuesta, manuales_entran,
    rep_de_otra_factura_rebota, rep_correcto_entra, propuesta_con_pago_ajeno_rebota,
    pendiente_repetida_rebota, descartada_permite_reintento, llave_por_factura_no_por_liga,
    prefijo_indexado, abono_a_cancelada_rebota, saldo_de_cancelada_sigue,
    set_null_por_columna, fk_rep_tres_columnas;
end $$;

-- ── 193. La correctiva del ciclo 7: el top de plazas contado ENTERO y el sello de peaje como reserva (mig. 0238) ──
-- Los bloques 189-192 los toman las otras ramas de esta ola (ingeniería,
-- dirección+leads, SAT y portal de pago); ésta toma el 193.
--
-- Lo que SOLO la base puede demostrar de la 0238:
--
--  (a) EL TOP-5 ES EL TOP-5. Es el hallazgo c7-4 escrito como prueba: se
--      siembran ~1,000 prospectos donde la plaza REALMENTE más grande —Nuevo
--      Laredo— se inserta AL FINAL, así que una lectura truncada por orden
--      físico se la pierde. Eso es exactamente lo que pasaba: el motor traía
--      5,000 de 33,071 filas sin `order` y Nuevo Laredo, Manzanillo y Puebla
--      desaparecían del parte que Javier le enseña a un gremio, mientras
--      entraban tres plazas que no eran del top. La función cuenta EN LA BASE,
--      así que el orden de inserción no puede cambiar el resultado — y un
--      `.order()` del lado del cliente no habría arreglado nada: ordenar una
--      muestra sesgada da una muestra sesgada ordenada.
--  (b) EL CRITERIO DE «VIVO» ES EL DEL PARTE. Un duplicado (`duplicado_de`
--      puesto) y un `perdido` NO cuentan — contarlos inflaría el censo que el
--      parte afirma, y aquí los dos son de una plaza que si contara ganaría.
--  (c) LOS SIN CIUDAD SE DICEN, NO SE REPARTEN. Un prospecto sin ciudad (NULL
--      o cadena de puros espacios) no vive en ninguna plaza; sumarlo a la más
--      grande sería inventar dónde está.
--  (d) EL EMPATE ES DETERMINISTA (por nombre de ciudad, ascendente): dos
--      corridas sobre el mismo censo tienen que producir el MISMO parte, o el
--      «material del acercamiento» cambiaría de orden sin que nada cambiara.
--  (e) `p_top` RECORTA DE VERDAD, y un `p_top` absurdo (0 o NULL) ni revienta
--      ni devuelve el censo entero por accidente.
--  (f) EL DOBLE CANDADO DE LA FUNCIÓN: ni `anon` ni `authenticated` la pueden
--      ejecutar, y `service_role` sí. Lee el pipeline comercial de Likida
--      ENTERO, sin filtro de flota: una sesión de navegador no tiene por qué
--      poder contarlo.
--  (g) EL SELLO DEL AVISO DE PEAJE ES UNA RESTRICCIÓN, NO UN `if` (c7-17). La
--      PK `(tenant_id, periodo, umbral)` rebota la segunda reserva: es lo que
--      hace que de dos invocaciones solapadas del cron solo UNA mande el
--      WhatsApp. Antes se preguntaba, se mandaba y se sellaba al final, y el
--      mensaje duplicado ya estaba en el teléfono cuando el 23505 llegaba.
--  (h) Y SOLTAR LA RESERVA LA DEJA LIBRE: borrar la fila permite volver a
--      reservar el MISMO (flota, mes, umbral). Sin esto, un envío fallido
--      enterraría el aviso del mes — y el umbral es un día exacto que no
--      vuelve, porque PASE extingue el derecho a facturar el último día del
--      mes en curso.
--  (i) DOS UMBRALES DEL MISMO MES SON DOS AVISOS LEGÍTIMOS (el de «faltan 7» y
--      el de «hoy vence»): el segundo entra, no rebota.
do $$
declare
  mapa jsonb;
  top1 text; top1_n bigint; top2 text; empate_1 text; empate_2 text;
  total bigint; sin_ciudad bigint; cuantas_plazas int;
  top_cero int; top_nulo int;
  cerrado boolean;
  ta uuid; original uuid;
  reserva_repetida_rebota boolean; reserva_tras_soltar_entra boolean;
  otro_umbral_entra boolean;
  i int;
begin
  -- Tijuana va PRIMERO y con menos; Nuevo Laredo va al FINAL y con más.
  for i in 1..300 loop
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 tij ' || i, 'Tijuana');
  end loop;
  for i in 1..100 loop
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 gdl ' || i, 'Guadalajara');
  end loop;
  -- (c) Sin ciudad: NULL y cadena de puros espacios. Ninguno vive en una plaza.
  for i in 1..50 loop
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 nada ' || i, null);
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 blanco ' || i, '   ');
  end loop;
  -- (d) Empate exacto entre dos plazas: el desempate tiene que ser por nombre.
  for i in 1..7 loop
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 emp_b ' || i, 'Bbb');
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 emp_a ' || i, 'Aaa');
  end loop;
  -- (b) Perdidos y duplicados de una plaza que, si contaran, ganaría.
  for i in 1..400 loop
    insert into prospecto (empresa, ciudad, estado) values ('ZZZ VERIF 0238 perd ' || i, 'Monterrey', 'perdido');
  end loop;
  insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 mty original', 'Monterrey')
    returning id into original;
  for i in 1..400 loop
    insert into prospecto (empresa, ciudad, duplicado_de) values ('ZZZ VERIF 0238 dup ' || i, 'Monterrey', original);
  end loop;
  -- El último en entrar, y el más grande de verdad. Con espacios de sobra: la
  -- misma plaza escrita con holgura no puede volverse otra plaza.
  for i in 1..500 loop
    insert into prospecto (empresa, ciudad) values ('ZZZ VERIF 0238 nvl ' || i, ' Nuevo Laredo ');
  end loop;

  mapa := public.prospecto_mapa_ciudades(5);
  top1       := mapa -> 'top' -> 0 ->> 'ciudad';
  top1_n     := (mapa -> 'top' -> 0 ->> 'n')::bigint;
  top2       := mapa -> 'top' -> 1 ->> 'ciudad';
  total      := (mapa ->> 'total')::bigint;
  sin_ciudad := (mapa ->> 'sin_ciudad')::bigint;
  cuantas_plazas := jsonb_array_length(mapa -> 'top');

  -- (d) El empate, mirado sobre el top completo: Aaa antes que Bbb.
  mapa := public.prospecto_mapa_ciudades(50);
  select c ->> 'ciudad' into empate_1
    from jsonb_array_elements(mapa -> 'top') with ordinality t(c, orden)
    where c ->> 'ciudad' in ('Aaa', 'Bbb') order by orden limit 1;
  select c ->> 'ciudad' into empate_2
    from jsonb_array_elements(mapa -> 'top') with ordinality t(c, orden)
    where c ->> 'ciudad' in ('Aaa', 'Bbb') order by orden offset 1 limit 1;

  -- (e) Un tope absurdo no revienta ni devuelve el censo entero.
  top_cero := jsonb_array_length(public.prospecto_mapa_ciudades(0) -> 'top');
  top_nulo := jsonb_array_length(public.prospecto_mapa_ciudades(null) -> 'top');

  -- (f) El doble candado de la función.
  cerrado := not has_function_privilege('anon', 'public.prospecto_mapa_ciudades(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.prospecto_mapa_ciudades(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.prospecto_mapa_ciudades(integer)', 'EXECUTE');

  -- (g) La reserva del sello: la PK arbitra la carrera.
  insert into tenant (nombre) values ('ZZZ VERIF 0238') returning id into ta;
  insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
    values (ta, date '2026-09-01', 7, 12);
  begin
    insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
      values (ta, date '2026-09-01', 7, 12);
    reserva_repetida_rebota := false;
  exception when unique_violation then
    reserva_repetida_rebota := true;
  end;

  -- (h) Soltarla la deja libre para el reintento de la corrida siguiente.
  delete from peaje_cierre_aviso where tenant_id = ta and periodo = date '2026-09-01' and umbral = 7;
  begin
    insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
      values (ta, date '2026-09-01', 7, 12);
    reserva_tras_soltar_entra := true;
  exception when others then
    reserva_tras_soltar_entra := false;
  end;

  -- (i) El otro umbral del mismo mes es otro aviso, y entra.
  begin
    insert into peaje_cierre_aviso (tenant_id, periodo, umbral, gastos)
      values (ta, date '2026-09-01', 0, 12);
    otro_umbral_entra := true;
  exception when others then
    otro_umbral_entra := false;
  end;

  raise exception 'CORRECTIVA_0238  top1=%  top1_n=%  top2=%  total=%  sin_ciudad=%  plazas=%  empate_1=%  empate_2=%  top_cero=%  top_nulo=%  cerrado=%  reserva_repetida_rebota=%  reserva_tras_soltar_entra=%  otro_umbral_entra=%   (esperado Nuevo Laredo / 500 / Tijuana / 1015 / 100 / 5 / Aaa / Bbb / 0 / 5 / t / t / t / t)',
    top1, top1_n, top2, total, sin_ciudad, cuantas_plazas, empate_1, empate_2,
    top_cero, top_nulo, cerrado,
    reserva_repetida_rebota, reserva_tras_soltar_entra, otro_umbral_entra;
end $$;

-- ── 195. Los portales declarativos y su renglón en `portal_estado` (mig. 0232, sin migración nueva) ──
-- Los bloques 189-194 los tomaron las ramas paralelas de esta ola; esta toma
-- el 195. NO trae migración propia: la Fase A de portales es código —el motor
-- declarativo de `adaptadores/guion.ts` y las tablas de selectores de
-- `adaptadores/portales.ts`—, y el sitio donde ese motor DICE por qué un
-- portal no avanzó ya existe: `portal_estado`, de la 0232.
--
-- Precisamente por eso hace falta este bloque. La 0232 se escribió cuando el
-- único portal automatizado era CAPUFE y el único escritor era la vinculación
-- asistida. Ahora escriben cuatro portales más y un motor que produce mensajes
-- MUCHO más largos (el de captcha, el de «el portal cambió su HTML» con los
-- selectores dentro). Lo que se verifica es que los candados de la 0232 sigan
-- siendo verdad CONTRA ESOS MENSAJES, y no contra los de hace tres semanas:
--
--  (a) LAS CUATRO CLAVES NUEVAS CABEN. `portal_estado.comercio` es texto
--      acotado a 64 y no vacío, a propósito (el catálogo vive en TypeScript y
--      un enum obligaría a una migración por gasolinera). Se comprueba que
--      'office_depot', 'controlnet', 'enerser' y 'autozone' entran.
--  (b) Y CONVIVEN CON CAPUFE EN LA MISMA FLOTA. `portal_estado_unico` es por
--      (tenant, comercio): cinco portales de una flota son cinco renglones,
--      no cinco flotas peleándose uno.
--  (c) EL MOTIVO DEL MOTOR ENTRA TAL CUAL. El mensaje de «el portal cambió su
--      HTML» lleva DENTRO los selectores que faltaron —«`#folio` ni
--      `input[name="folio"]`»— con backticks, comillas y corchetes de
--      atributo. Que un mensaje así entre no es obvio: el CHECK
--      `portal_estado_motivo_sin_json` rebota lo que EMPIECE por `{` o `[`, y
--      un selector de atributo empieza por `[`. Si el motor llegara a escribir
--      un motivo que arranque con el selector, la anotación se perdería EN
--      SILENCIO (`anotarVinculo` es best-effort y no lanza) y el contralor
--      vería «caducada» sin motivo. Aquí se fija que el mensaje real entra Y
--      que uno que empieza por `[` NO.
--  (d) UNA BOLSA DE COOKIES SIGUE REBOTANDO. Es el candado de la 0232 y no se
--      relaja porque haya más escritores: esta columna la lee el panel sin
--      descifrar nada.
--  (e) EL MENSAJE DE CAPTCHA NO CABE EN 400, Y POR ESO `anotarVinculo`
--      RECORTA. Se demuestra las dos mitades: el texto entero rebota contra
--      `portal_estado_motivo_acotado`, y recortado a 400 —lo que hace el
--      escritor— entra. Sin esta prueba, alguien que suba el mensaje de
--      captcha rompería la anotación de todos los portales a la vez.
--  (f) LOS DOS CANDADOS DE FECHA siguen puestos con las claves nuevas:
--      'vinculado' sin `vinculada_en` y 'caducada' sin `caducada_en` rebotan.
--      Una píldora sin fecha no se puede pintar.
--  (g) EL AISLAMIENTO POR FLOTA. El mismo portal, dos flotas, dos renglones.
--  (h) El doble candado de la casa: RLS deny-all + solo service_role.
do $$
declare
  ta uuid; tb uuid;
  claves text[] := array['office_depot', 'controlnet', 'enerser', 'autozone'];
  c text;
  cuatro_entran boolean := true;
  conviven integer;
  motivo_del_motor boolean; motivo_que_empieza_corchete_rebota boolean;
  cookies_rebotan boolean;
  captcha_entero_rebota boolean; captcha_recortado_entra boolean;
  vinculado_sin_fecha_rebota boolean; caducada_sin_fecha_rebota boolean;
  otra_flota_entra boolean;
  cerrado boolean;
  -- El mensaje LITERAL que produce `guion.ts` cuando el pre-vuelo encuentra
  -- selectores idos. Se escribe entero y no resumido: la mitad del valor de
  -- este bloque es que el texto de verdad entre, no uno parecido.
  msg_cambio text := 'https://facturacion.officedepot.com.mx/ ya no tiene estos selectores: el campo "Monto" -> `input[formcontrolname="monto"]` ni `input[name*="monto" i]`. Hay que actualizar el mapeo de "office_depot". La sesion sigue viva: esto NO se arregla volviendo a entrar, lo corrige Likida rehaciendo la tabla del guion.';
  -- Y el de captcha, que es el largo. `mensajeCaptcha` en `pasos.ts`.
  msg_captcha text := 'https://facturacion.officedepot.com.mx/ pidio CAPTCHA al abrir el formulario (selector `.g-recaptcha`): hay que facturarlo a mano. No se intento resolverlo - rodear un CAPTCHA es operar contra los terminos del portal y la cuenta que se bloquea es la del CLIENTE, no la de Likida. Esto NO es "no pude", es "no se puede": reintentar no va a cambiar nada, tiene que entrar una persona. Se le deja la pantalla con todo lo leido del ticket para que solo teclee lo que falta.';
begin
  insert into tenant (nombre) values ('ZZZ VERIF 195 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 195 B') returning id into tb;

  -- (a) Las cuatro claves nuevas entran.
  foreach c in array claves loop
    begin
      insert into portal_estado (tenant_id, comercio, estado, vinculada_en)
        values (ta, c, 'vinculado', now());
    exception when others then
      cuatro_entran := false;
    end;
  end loop;

  -- (b) Y conviven con CAPUFE en la MISMA flota: cinco renglones, no uno.
  insert into portal_estado (tenant_id, comercio, estado, vinculada_en)
    values (ta, 'capufe', 'vinculado', now());
  select count(*) into conviven from portal_estado where tenant_id = ta;

  -- (c) El motivo que escribe el motor cuando el portal cambió, tal cual.
  begin
    update portal_estado
      set estado = 'caducada', caducada_en = now(), motivo = left(msg_cambio, 400)
      where tenant_id = ta and comercio = 'office_depot';
    motivo_del_motor := true;
  exception when others then
    motivo_del_motor := false;
  end;

  -- … pero uno que EMPIEZA por un selector de atributo rebota. Es la trampa:
  -- `[` es lo que el CHECK usa para cazar un volcado JSON.
  begin
    update portal_estado
      set motivo = '[data-sitekey] aparecio en la pagina'
      where tenant_id = ta and comercio = 'controlnet';
    motivo_que_empieza_corchete_rebota := false;
  exception when check_violation then
    motivo_que_empieza_corchete_rebota := true;
  end;

  -- (d) Una bolsa de cookies sigue sin poder entrar.
  begin
    update portal_estado
      set motivo = '{"cookies":[{"name":"SESSION","value":"abc"}]}'
      where tenant_id = ta and comercio = 'enerser';
    cookies_rebotan := false;
  exception when check_violation then
    cookies_rebotan := true;
  end;

  -- (e) El mensaje de captcha ENTERO no cabe; recortado a 400 sí. Las dos
  -- mitades, porque juntas son las que justifican el `slice` del escritor.
  begin
    update portal_estado set motivo = msg_captcha
      where tenant_id = ta and comercio = 'autozone';
    captcha_entero_rebota := false;
  exception when check_violation then
    captcha_entero_rebota := true;
  end;
  begin
    update portal_estado set motivo = left(msg_captcha, 400)
      where tenant_id = ta and comercio = 'autozone';
    captcha_recortado_entra := true;
  exception when others then
    captcha_recortado_entra := false;
  end;

  -- (f) Los dos candados de fecha, con una clave nueva.
  begin
    insert into portal_estado (tenant_id, comercio, estado)
      values (tb, 'office_depot', 'vinculado');
    vinculado_sin_fecha_rebota := false;
  exception when check_violation then
    vinculado_sin_fecha_rebota := true;
  end;
  begin
    insert into portal_estado (tenant_id, comercio, estado)
      values (tb, 'controlnet', 'caducada');
    caducada_sin_fecha_rebota := false;
  exception when check_violation then
    caducada_sin_fecha_rebota := true;
  end;

  -- (g) El mismo portal, otra flota: renglón propio.
  begin
    insert into portal_estado (tenant_id, comercio, estado, vinculada_en)
      values (tb, 'office_depot', 'vinculado', now());
    otra_flota_entra := true;
  exception when others then
    otra_flota_entra := false;
  end;

  -- (h) El doble candado de la casa.
  cerrado := not has_table_privilege('anon', 'public.portal_estado', 'SELECT')
    and not has_table_privilege('authenticated', 'public.portal_estado', 'SELECT')
    and has_table_privilege('service_role', 'public.portal_estado', 'SELECT')
    and has_table_privilege('service_role', 'public.portal_estado', 'INSERT')
    and (select relrowsecurity from pg_class where oid = 'public.portal_estado'::regclass);

  raise exception 'PORTALES_FASE_A_195  cuatro_entran=%  conviven=%  motivo_del_motor=%  motivo_que_empieza_corchete_rebota=%  cookies_rebotan=%  captcha_entero_rebota=%  captcha_recortado_entra=%  vinculado_sin_fecha_rebota=%  caducada_sin_fecha_rebota=%  otra_flota_entra=%  cerrado=%   (esperado t / 5 / t / t / t / t / t / t / t / t / t)',
    cuatro_entran, conviven, motivo_del_motor, motivo_que_empieza_corchete_rebota,
    cookies_rebotan, captcha_entero_rebota, captcha_recortado_entra,
    vinculado_sin_fecha_rebota, caducada_sin_fecha_rebota, otra_flota_entra, cerrado;
end $$;

-- ── 196. El carril completo del panel de QA: la foto no se procesa dos veces y la pasada la arbitra la base (mig. 0240) ──
-- El bloque 194 lo toma el fork de tickets de esta ola; éste toma el 196 (el
-- 195 ya estaba escrito).
--
-- POR QUÉ ESTE BLOQUE EXISTE. Una corrida de 91 comprobantes no cabe en una
-- invocación de Vercel, así que avanza en PASADAS. Todo lo que impide que eso
-- cueste dinero de más vive en la base y no en TypeScript, y un test con
-- supabase-js mockeado probaría el mock:
--
--  (a) LA MISMA FOTO NO SE PUEDE TOMAR DOS VECES. Es la PK
--      `(corrida_id, foto_id)`. Dos pasadas solapadas —el navegador reintenta,
--      alguien abre la pantalla en dos pestañas, una pasada que Vercel dio por
--      muerta sigue viva unos segundos— piden la misma foto: una entra y la
--      otra rebota con 23505. Un `if (yaProcesada)` leído antes de mandar sería
--      una carrera, y perderla significa mandar el mismo ticket dos veces al
--      modelo (dinero real) y contarlo dos veces (una cifra inventada).
--  (b) PERO LA MISMA FOTO EN OTRA CORRIDA SÍ ENTRA. La llave es por corrida,
--      no por foto: el banco se reusa entre corridas y una PK demasiado
--      estrecha convertiría el segundo día de pruebas en un rebote perpetuo.
--  (c) LA LLAVE DE LA PASADA LA ARBITRA POSTGRES. `tomarPasada` es un UPDATE
--      con `pasada_en_vuelo is null` en el WHERE. Dos pasadas simultáneas
--      piden; una toca 1 fila y la otra 0, y la que tocó 0 se va SIN GASTAR.
--      Se comprueba también el fencing al soltar: quien ya fue relevado no le
--      quita la llave a quien la tiene (`eq('pasada_en_vuelo', <la mía>)`).
--  (d) BORRAR UNA FOTO DEL BANCO QUE UNA CORRIDA CITA REBOTA
--      (`on delete restrict`), en contra del reflejo de poner cascade: lo que
--      NO puede pasar es que desaparezca en silencio la prueba de que esta
--      corrida procesó ese ticket y cuánto costó. Fallar cerrado y decirlo.
--  (e) BORRAR LA CORRIDA SÍ SE LLEVA SU AVANCE (`on delete cascade`): el
--      avance no significa nada sin la corrida que lo produjo.
--  (f) `costo_usd` ADMITE NULL Y RECHAZA NEGATIVOS. NULL = NO SE MIDIÓ, y es
--      distinto de 0: un 0 afirmaría que la foto salió gratis. La columna es
--      NULL-able a propósito y el CHECK sólo prohíbe lo imposible.
--  (g) LOS DOMINIOS SE CIERRAN: `estado` de la foto admite los cuatro
--      —incluido 'interrumpida', que es "no se sabe cómo acabó" y no es ni
--      acierto ni fallo— y rechaza cualquier otro; `fase` admite las seis y
--      `corte` sólo 'reloj', 'dinero' o NULL. NULL en `corte` es "no se cortó",
--      que no es lo mismo que "se cortó por nada".
--  (h) `n` Y `pasada` SON 1-BASED y `pasadas` no puede ser negativo: la
--      pantalla dice «foto 47 de 91» leyendo `n`, y un 0 ahí sería un renglón
--      que ninguna foto ocupa.
--  (i) EL DOBLE CANDADO DE LA CASA: RLS deny-all + grants sólo a service_role.
do $$
declare
  co1 uuid; co2 uuid; f1 uuid; f2 uuid;
  p_a uuid := gen_random_uuid(); p_b uuid := gen_random_uuid();
  segunda_toma_rebota boolean; misma_foto_otra_corrida_entra boolean;
  gano integer; perdio integer;
  suelta_ajena integer; suelta_propia integer;
  borrar_foto_citada_rebota boolean; borrar_corrida_se_lleva_avance integer;
  costo_nulo_entra boolean; costo_negativo_rebota boolean;
  cuatro_estados integer := 0; estado_inventado_rebota boolean;
  seis_fases integer := 0; fase_inventada_rebota boolean;
  corte_nulo_entra boolean; corte_inventado_rebota boolean;
  n_cero_rebota boolean; pasadas_negativas_rebotan boolean;
  cerrado boolean;
  e text;
begin
  insert into qa_foto (hash, path, mime, etiqueta, bytes)
    values ('zzz-verif-196-a', 'banco/zzz-a.jpg', 'image/jpeg', 'ZZZ VERIF 196 a', 100)
    returning id into f1;
  insert into qa_foto (hash, path, mime, etiqueta, bytes)
    values ('zzz-verif-196-b', 'banco/zzz-b.jpg', 'image/jpeg', 'ZZZ VERIF 196 b', 100)
    returning id into f2;
  insert into qa_corrida (escenario, parametros, estado, tenant_nombre, carril)
    values ('demo_guion', '{"fotoIds":[]}'::jsonb, 'corriendo', 'ZZZ QA VERIF 196 A', 'completo')
    returning id into co1;
  insert into qa_corrida (escenario, parametros, estado, tenant_nombre, carril)
    values ('demo_guion', '{"fotoIds":[]}'::jsonb, 'corriendo', 'ZZZ QA VERIF 196 B', 'completo')
    returning id into co2;

  -- (a) La misma foto, dos veces en la MISMA corrida: la segunda rebota.
  insert into qa_corrida_foto (corrida_id, foto_id, n, estado, pasada)
    values (co1, f1, 1, 'corriendo', 1);
  begin
    insert into qa_corrida_foto (corrida_id, foto_id, n, estado, pasada)
      values (co1, f1, 1, 'corriendo', 2);
    segunda_toma_rebota := false;
  exception when unique_violation then
    segunda_toma_rebota := true;
  end;

  -- (b) La misma foto en OTRA corrida sí entra: la llave es por corrida.
  begin
    insert into qa_corrida_foto (corrida_id, foto_id, n, estado, pasada)
      values (co2, f1, 1, 'ok', 1);
    misma_foto_otra_corrida_entra := true;
  exception when others then
    misma_foto_otra_corrida_entra := false;
  end;

  -- (c) La llave de la pasada: dos UPDATE condicionales, uno gana.
  update qa_corrida set pasada_en_vuelo = p_a
    where id = co1 and pasada_en_vuelo is null;
  get diagnostics gano = row_count;
  update qa_corrida set pasada_en_vuelo = p_b
    where id = co1 and pasada_en_vuelo is null;
  get diagnostics perdio = row_count;

  -- Y el fencing al soltar: quien ya fue relevado no suelta la llave ajena.
  update qa_corrida set pasada_en_vuelo = null
    where id = co1 and pasada_en_vuelo = p_b;
  get diagnostics suelta_ajena = row_count;
  update qa_corrida set pasada_en_vuelo = null
    where id = co1 and pasada_en_vuelo = p_a;
  get diagnostics suelta_propia = row_count;

  -- (f) NULL = no se midió; negativo es imposible.
  begin
    insert into qa_corrida_foto (corrida_id, foto_id, n, estado, pasada, costo_usd)
      values (co2, f2, 2, 'interrumpida', 1, null);
    costo_nulo_entra := true;
  exception when others then
    costo_nulo_entra := false;
  end;
  begin
    update qa_corrida_foto set costo_usd = -0.0001 where corrida_id = co2 and foto_id = f2;
    costo_negativo_rebota := false;
  exception when check_violation then
    costo_negativo_rebota := true;
  end;

  -- (g) Los dominios. Los cuatro estados de la foto entran…
  foreach e in array array['corriendo', 'ok', 'bad', 'interrumpida'] loop
    begin
      update qa_corrida_foto set estado = e where corrida_id = co1 and foto_id = f1;
      cuatro_estados := cuatro_estados + 1;
    exception when others then
      null;
    end;
  end loop;
  begin
    update qa_corrida_foto set estado = 'pendiente' where corrida_id = co1 and foto_id = f1;
    estado_inventado_rebota := false;
  exception when check_violation then
    estado_inventado_rebota := true;
  end;

  foreach e in array array['siembra', 'fotos', 'cierre', 'oraculos', 'limpieza', 'terminada'] loop
    begin
      update qa_corrida set fase = e where id = co1;
      seis_fases := seis_fases + 1;
    exception when others then
      null;
    end;
  end loop;
  begin
    update qa_corrida set fase = 'a-medias' where id = co1;
    fase_inventada_rebota := false;
  exception when check_violation then
    fase_inventada_rebota := true;
  end;

  -- NULL en `corte` = no se cortó. Es un valor legítimo, no un hueco.
  begin
    update qa_corrida set corte = null where id = co1;
    update qa_corrida set corte = 'reloj' where id = co1;
    update qa_corrida set corte = 'dinero' where id = co1;
    corte_nulo_entra := true;
  exception when others then
    corte_nulo_entra := false;
  end;
  begin
    update qa_corrida set corte = 'cansancio' where id = co1;
    corte_inventado_rebota := false;
  exception when check_violation then
    corte_inventado_rebota := true;
  end;

  -- (h) 1-based, y las pasadas no cuentan hacia atrás.
  begin
    insert into qa_corrida_foto (corrida_id, foto_id, n, estado, pasada)
      values (co2, f2, 0, 'ok', 1);
    n_cero_rebota := false;
  exception when check_violation then
    n_cero_rebota := true;
  when unique_violation then
    n_cero_rebota := null;   -- no debería pasar: f2 ya está en co2 con n=2
  end;
  begin
    update qa_corrida set pasadas = -1 where id = co1;
    pasadas_negativas_rebotan := false;
  exception when check_violation then
    pasadas_negativas_rebotan := true;
  end;

  -- (d) Borrar del banco una foto que una corrida cita: rebota.
  begin
    delete from qa_foto where id = f1;
    borrar_foto_citada_rebota := false;
  exception when foreign_key_violation then
    borrar_foto_citada_rebota := true;
  end;

  -- (e) Borrar la corrida se lleva su avance.
  delete from qa_corrida where id = co2;
  select count(*) into borrar_corrida_se_lleva_avance
    from qa_corrida_foto where corrida_id = co2;

  -- (i) El doble candado de la casa.
  cerrado := not has_table_privilege('anon', 'public.qa_corrida_foto', 'SELECT')
    and not has_table_privilege('authenticated', 'public.qa_corrida_foto', 'SELECT')
    and not has_table_privilege('anon', 'public.qa_corrida_foto', 'INSERT')
    and has_table_privilege('service_role', 'public.qa_corrida_foto', 'SELECT')
    and has_table_privilege('service_role', 'public.qa_corrida_foto', 'INSERT')
    and has_table_privilege('service_role', 'public.qa_corrida_foto', 'UPDATE')
    and (select relrowsecurity from pg_class where oid = 'public.qa_corrida_foto'::regclass);

  raise exception 'QA_CARRIL_COMPLETO_0240  segunda_toma_rebota=%  misma_foto_otra_corrida_entra=%  gano=%  perdio=%  suelta_ajena=%  suelta_propia=%  costo_nulo_entra=%  costo_negativo_rebota=%  cuatro_estados=%  estado_inventado_rebota=%  seis_fases=%  fase_inventada_rebota=%  corte_nulo_entra=%  corte_inventado_rebota=%  n_cero_rebota=%  pasadas_negativas_rebotan=%  borrar_foto_citada_rebota=%  avance_tras_borrar_corrida=%  cerrado=%   (esperado t / t / 1 / 0 / 0 / 1 / t / t / 4 / t / 6 / t / t / t / t / t / t / 0 / t)',
    segunda_toma_rebota, misma_foto_otra_corrida_entra, gano, perdio,
    suelta_ajena, suelta_propia, costo_nulo_entra, costo_negativo_rebota,
    cuatro_estados, estado_inventado_rebota, seis_fases, fase_inventada_rebota,
    corte_nulo_entra, corte_inventado_rebota, n_cero_rebota, pasadas_negativas_rebotan,
    borrar_foto_citada_rebota, borrar_corrida_se_lleva_avance, cerrado;
end $$;

-- ── 197. El registro de jornada: la procedencia obligatoria, la corrección que se anota, y el chofer que no se puede borrar (mig. 0241) ──
-- El bloque 173 que la consigna reservaba YA ESTABA TOMADO (la dirección, mig.
-- 0216, línea 9712). El 196 se lo llevó el carril de QA (mig. 0240) al entrar
-- a master mientras esta rama estaba abierta, así que éste toma el 197.
--
-- Lo que SOLO la base puede demostrar de la 0241 —y que un `if` en TypeScript
-- no sostiene, porque el `if` se puede quitar sin que nada truene—:
--
--  (a) UN EXPEDIENTE POR OPERADOR Y DÍA. `jornada_dia_unica` arbitra la carrera
--      entre el chofer declarando su inicio y el cron derivando el hito. Sin
--      este índice las dos preguntan «¿ya existe el día?», las dos oyen que no,
--      y quedan DOS expedientes con la mitad de las marcas cada uno — o sea, un
--      documento laboral que parte la jornada de una persona en dos mitades sin
--      que nadie lo note.
--  (b) LA DECLARACIÓN LE GANA A LA DERIVACIÓN, Y NO LO DECIDE UN `if`. Con un
--      `inicio_jornada` declarado vivo, el asiento derivado del GPS rebota con
--      23505 contra `jornada_asiento_marca_unica`. El derivador lee ese código
--      como «ya estaba», no como fallo. Si mañana alguien borra el `if` del
--      motor, el índice sigue ahí.
--  (c) Y LA CORRECCIÓN CABE JUSTO CUANDO SE ANOTA. El índice es PARCIAL sobre
--      `anulado_en is null`: mientras el viejo esté vivo el nuevo NO entra;
--      anulado el viejo —con motivo, autor y hora— el nuevo sí. Eso es lo que
--      hace que corregir sea imposible sin dejar rastro: no hay camino de
--      sustituir una hora que no pase por anular la anterior.
--  (d) EL DERIVADOR ES IDEMPOTENTE POR EL HECHO, NO POR LA HORA. Dos corridas
--      del cron sobre el mismo hito producen UN asiento (`origen_ref` único).
--      Sin esto, un cron que corre cada hora acumula veinticuatro «inicios»
--      derivados del mismo viaje.
--  (e) UNA HORA DERIVADA SIN ORIGEN NO ENTRA. `hito_viaje` y `gps` exigen
--      `origen_ref`: es la diferencia entre un registro que prueba y una hoja
--      de cálculo. En un juicio laboral una hora sin procedencia no prueba nada.
--  (f) UNA CAPTURA DE OFICINA SIN FIRMA NO ENTRA, y una ANULACIÓN sin motivo
--      ni firma tampoco. Un registro editable en silencio es peor que no
--      tenerlo: destruye su propia credibilidad ante el perito.
--  (g) LA CONFORMIDAD DEL OPERADOR FALLA CERRADO. El párrafo tercero de la LFT
--      132 fr. XXXIV pide que el acuerdo se ACREDITE para que el registro haga
--      prueba plena; sin el id del mensaje de WhatsApp que lo acredita, la
--      fecha de conformidad no se puede sellar. Una casilla marcada sin
--      evidencia no es un acuerdo acreditado.
--  (h) BORRAR AL CHOFER NO BORRA SU JORNADA. `on delete restrict` sobre
--      `operador`: el art. 804 fr. III obliga a conservar el control de
--      asistencia «durante el último año y un año después de que se extinga la
--      relación laboral», y el 805 castiga no exhibirlo con la presunción de
--      ser ciertos los hechos del actor. Que dar de baja a un operador borrara
--      su registro sería destruir justo la prueba cuya ausencia se castiga.
--  (i) BORRAR EL VIAJE SÍ SE PUEDE, Y NO REVIENTA. `on delete set null
--      (viaje_id)` CON LISTA DE COLUMNAS: a secas anularía también `tenant_id`,
--      que es NOT NULL, y el DELETE del viaje fallaría — el bug exacto que
--      arregló la 0236 y que aquí no se reintroduce. La hora trabajada sigue
--      siendo cierta aunque el viaje ya no esté.
--  (j) NINGUNA FLOTA TOCA LA JORNADA DE OTRA. Las FK son COMPUESTAS
--      `(id, tenant_id)`: colgar un día del operador de otra flota rebota, y un
--      asiento no puede corregir el de otra flota.
--  (k) EL CATÁLOGO DE CRONS ESTÁ COMPLETO. `jornada` entra, y los dos que
--      llevaban meses mudos —`asistencia` y `descarga-sat`— también. Un id
--      inventado rebota. Una lista corta aquí no falla ruidosamente: silencia
--      latidos, y `/api/health` no puede llamar muerto a un cron del que nunca
--      tuvo un latido que juzgar.
--  (l) UN UMBRAL DE CERO HORAS NO ES UN UMBRAL. Marcaría excedido TODO día.
--      Cero, NaN y más de 24 h rebotan en la base; y una política por flota, no
--      dos, porque el reporte no sabría cuál enseñó.
--  (m) EL DOBLE CANDADO DE LA CASA. Aquí el dato no es una cifra de negocio: es
--      el horario de una persona identificada, dato personal del art. 3 fr. V
--      de la LFPDPPP.
do $$
declare
  ta uuid; tb uuid; op_a uuid; op_b uuid; uni_a uuid; via_a uuid; usr uuid;
  dia_a uuid; dia_b uuid; asiento_declarado uuid; asiento_viaje uuid;
  dia_repetido_rebota boolean; derivado_rebota_si_hay_declarado boolean;
  corregido_entra_tras_anular boolean; anulado_no_estorba boolean;
  origen_repetido_rebota boolean; wa_repetido_rebota boolean;
  dos_sin_wa_conviven boolean; dos_descansos_conviven boolean;
  derivado_sin_origen_rebota boolean; captura_sin_firma_rebota boolean;
  anulacion_sin_motivo_rebota boolean; anulacion_sin_firma_rebota boolean;
  conformidad_sin_mensaje_rebota boolean; cierre_sin_firma_rebota boolean;
  cierre_incoherente_rebota boolean; procedencia_inventada_rebota boolean;
  borrar_operador_rebota boolean; borrar_viaje_deja_asiento boolean;
  tenant_sobrevive boolean; dia_de_otra_flota_rebota boolean;
  corrige_otra_flota_rebota boolean;
  jornada_late boolean; asistencia_late boolean; sat_late boolean;
  cron_inventado_rebota boolean;
  cero_horas_rebota boolean; nan_rebota boolean; mas_de_24_rebota boolean;
  dos_politicas_rebotan boolean; cerrado boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0241 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0241 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono) values (ta, 'ZZZ Chofer A', '5210000000241') returning id into op_a;
  insert into operador (tenant_id, nombre, telefono) values (tb, 'ZZZ Chofer B', '5210000000242') returning id into op_b;
  insert into unidad (tenant_id, numero_economico) values (ta, 'ZZZ-0241') returning id into uni_a;
  insert into viaje (tenant_id, operador_id) values (ta, op_a) returning id into via_a;
  insert into app_user (id, tenant_id, email) values (gen_random_uuid(), ta, 'zzz-0241@likida.test') returning id into usr;

  insert into jornada_dia (tenant_id, operador_id, dia) values (ta, op_a, date '2026-08-27') returning id into dia_a;

  -- (a) El MISMO operador, el MISMO día: un solo expediente.
  begin
    insert into jornada_dia (tenant_id, operador_id, dia) values (ta, op_a, date '2026-08-27');
    dia_repetido_rebota := false;
  exception when unique_violation then
    dia_repetido_rebota := true;
  end;

  -- (b) El chofer declara su inicio; el GPS intenta derivar otro. Rebota.
  insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia, wa_message_id)
    values (ta, dia_a, 'inicio_jornada', timestamptz '2026-08-27 04:00-06', 'declarado_operador', 'wamid.ZZZ0241A')
    returning id into asiento_declarado;
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia, origen_ref, unidad_id)
      values (ta, dia_a, 'inicio_jornada', timestamptz '2026-08-27 05:12-06', 'gps', 'gps:zzz:2026-08-27:primera', uni_a);
    derivado_rebota_si_hay_declarado := false;
  exception when unique_violation then
    derivado_rebota_si_hay_declarado := true;
  end;

  -- (c) Se anula el declarado —con motivo, autor y hora— y ENTONCES el
  --     corregido entra. No hay camino de sustituir una hora sin dejar rastro.
  update jornada_asiento
     set anulado_en = now(), anulado_por = usr, anulado_por_email = 'zzz-0241@likida.test',
         anulado_motivo = 'El operador dictó mal la hora por teléfono.'
   where id = asiento_declarado;
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia,
                                 registrado_por, registrado_por_email, corrige_a, nota)
      values (ta, dia_a, 'inicio_jornada', timestamptz '2026-08-27 03:40-06', 'capturado_contralor',
              usr, 'zzz-0241@likida.test', asiento_declarado, 'Corregido contra la bitácora de patio.');
    corregido_entra_tras_anular := true;
  exception when others then
    corregido_entra_tras_anular := false;
  end;
  -- Y el anulado SIGUE en el expediente: anular no es borrar.
  anulado_no_estorba := exists (
    select 1 from jornada_asiento where id = asiento_declarado and anulado_en is not null);

  -- (d) El mismo hecho derivado dos veces: un solo asiento.
  insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia, origen_ref, viaje_id)
    values (ta, dia_a, 'fin_jornada', timestamptz '2026-08-27 18:00-06', 'hito_viaje',
            'viaje:' || via_a || ':aceptado_en', via_a)
    returning id into asiento_viaje;
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia, origen_ref, viaje_id)
      values (ta, dia_a, 'inicio_descanso', timestamptz '2026-08-27 13:00-06', 'hito_viaje',
              'viaje:' || via_a || ':aceptado_en', via_a);
    origen_repetido_rebota := false;
  exception when unique_violation then
    origen_repetido_rebota := true;
  end;

  -- El mismo mensaje de WhatsApp reentregado por Meta no duplica la marca…
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia, wa_message_id)
      values (ta, dia_a, 'inicio_descanso', timestamptz '2026-08-27 13:00-06', 'declarado_operador', 'wamid.ZZZ0241A');
    wa_repetido_rebota := false;
  exception when unique_violation then
    wa_repetido_rebota := true;
  end;
  -- …pero el índice es PARCIAL: los asientos sin mensaje no compiten entre sí.
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia,
                                 registrado_por_email)
      values (ta, dia_a, 'inicio_descanso', timestamptz '2026-08-27 13:00-06', 'capturado_contralor', 'zzz-0241@likida.test');
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia,
                                 registrado_por_email)
      values (ta, dia_a, 'fin_descanso', timestamptz '2026-08-27 13:35-06', 'capturado_contralor', 'zzz-0241@likida.test');
    dos_sin_wa_conviven := true;
  exception when others then
    dos_sin_wa_conviven := false;
  end;
  -- Y los DESCANSOS son varios en un día: `marca_unica` no los alcanza.
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia,
                                 registrado_por_email)
      values (ta, dia_a, 'inicio_descanso', timestamptz '2026-08-27 16:00-06', 'capturado_contralor', 'zzz-0241@likida.test');
    dos_descansos_conviven := true;
  exception when others then
    dos_descansos_conviven := false;
  end;

  -- (e) Una hora derivada sin decir de qué hecho salió no entra.
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia)
      values (ta, dia_a, 'fin_descanso', timestamptz '2026-08-27 16:30-06', 'gps');
    derivado_sin_origen_rebota := false;
  exception when check_violation then
    derivado_sin_origen_rebota := true;
  end;

  -- (f) Captura de oficina sin firma; anulación sin motivo; anulación sin firma.
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia)
      values (ta, dia_a, 'fin_descanso', timestamptz '2026-08-27 16:30-06', 'capturado_contralor');
    captura_sin_firma_rebota := false;
  exception when check_violation then
    captura_sin_firma_rebota := true;
  end;
  begin
    update jornada_asiento set anulado_en = now(), anulado_por_email = 'zzz-0241@likida.test'
     where id = asiento_viaje;
    anulacion_sin_motivo_rebota := false;
  exception when check_violation then
    anulacion_sin_motivo_rebota := true;
  end;
  begin
    update jornada_asiento set anulado_en = now(), anulado_motivo = 'sin firmar'
     where id = asiento_viaje;
    anulacion_sin_firma_rebota := false;
  exception when check_violation then
    anulacion_sin_firma_rebota := true;
  end;

  -- Y la lista de procedencias es CERRADA: no hay una quinta que se cuele.
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia)
      values (ta, dia_a, 'fin_descanso', timestamptz '2026-08-27 16:30-06', 'estimado');
    procedencia_inventada_rebota := false;
  exception when check_violation then
    procedencia_inventada_rebota := true;
  end;

  -- (g) La conformidad del art. 132 fr. XXXIV párr. 3 falla cerrado.
  begin
    update jornada_dia set conforme_operador_en = now() where id = dia_a;
    conformidad_sin_mensaje_rebota := false;
  exception when check_violation then
    conformidad_sin_mensaje_rebota := true;
  end;
  -- El cierre sin la firma congelada tampoco pasa…
  begin
    update jornada_dia set estado = 'cerrado', cerrado_en = now(), cerrado_por = usr where id = dia_a;
    cierre_sin_firma_rebota := false;
  exception when check_violation then
    cierre_sin_firma_rebota := true;
  end;
  -- …ni un expediente que miente sobre su propio estado.
  begin
    update jornada_dia set estado = 'cerrado', cerrado_por_email = 'zzz-0241@likida.test' where id = dia_a;
    cierre_incoherente_rebota := false;
  exception when check_violation then
    cierre_incoherente_rebota := true;
  end;

  -- (h) Dar de baja al chofer NO puede borrar el documento que la ley obliga a
  --     conservar (LFT 804 fr. III y 805).
  begin
    delete from operador where id = op_a;
    borrar_operador_rebota := false;
  exception when foreign_key_violation then
    borrar_operador_rebota := true;
  end;

  -- (i) Borrar el viaje SÍ se puede: `set null (viaje_id)` con lista, así que
  --     `tenant_id` sobrevive NOT NULL y el DELETE no revienta (bug de la 0236).
  begin
    delete from viaje where id = via_a;
    borrar_viaje_deja_asiento := exists (select 1 from jornada_asiento where id = asiento_viaje and viaje_id is null);
    tenant_sobrevive := exists (select 1 from jornada_asiento where id = asiento_viaje and tenant_id = ta);
  exception when others then
    borrar_viaje_deja_asiento := false;
    tenant_sobrevive := false;
  end;

  -- (j) Ninguna flota toca la jornada de otra. Las FK son compuestas.
  begin
    insert into jornada_dia (tenant_id, operador_id, dia) values (ta, op_b, date '2026-08-27');
    dia_de_otra_flota_rebota := false;
  exception when foreign_key_violation then
    dia_de_otra_flota_rebota := true;
  end;
  insert into jornada_dia (tenant_id, operador_id, dia) values (tb, op_b, date '2026-08-27') returning id into dia_b;
  begin
    insert into jornada_asiento (tenant_id, jornada_id, tipo, momento, procedencia,
                                 registrado_por_email, corrige_a)
      values (tb, dia_b, 'inicio_jornada', timestamptz '2026-08-27 05:00-06', 'capturado_contralor',
              'zzz-0241@likida.test', asiento_declarado);
    corrige_otra_flota_rebota := false;
  exception when foreign_key_violation then
    corrige_otra_flota_rebota := true;
  end;

  -- (k) El catálogo de crons, COMPLETO. `jornada` entra y los dos mudos también.
  insert into cron_latido (id) values ('jornada')
    on conflict (id) do update set ultimo_latido = now();
  jornada_late := exists (select 1 from cron_latido where id = 'jornada');
  insert into cron_latido (id) values ('asistencia')
    on conflict (id) do update set ultimo_latido = now();
  asistencia_late := exists (select 1 from cron_latido where id = 'asistencia');
  insert into cron_latido (id) values ('descarga-sat')
    on conflict (id) do update set ultimo_latido = now();
  sat_late := exists (select 1 from cron_latido where id = 'descarga-sat');
  begin
    insert into cron_latido (id) values ('cron-que-nadie-escribio');
    cron_inventado_rebota := false;
  exception when check_violation then
    cron_inventado_rebota := true;
  end;

  -- (l) Un umbral de cero horas marcaría excedido TODO día.
  begin
    insert into jornada_politica (tenant_id, horas_max_jornada, declarada_por_email)
      values (ta, 0, 'zzz-0241@likida.test');
    cero_horas_rebota := false;
  exception when check_violation then
    cero_horas_rebota := true;
  end;
  begin
    insert into jornada_politica (tenant_id, horas_max_jornada, declarada_por_email)
      values (ta, 'NaN'::numeric, 'zzz-0241@likida.test');
    nan_rebota := false;
  exception when check_violation then
    nan_rebota := true;
  end;
  begin
    insert into jornada_politica (tenant_id, horas_max_jornada, declarada_por_email)
      values (ta, 25, 'zzz-0241@likida.test');
    mas_de_24_rebota := false;
  exception when check_violation then
    mas_de_24_rebota := true;
  end;
  insert into jornada_politica (tenant_id, horas_max_jornada, declarada_por_email)
    values (ta, 11.5, 'zzz-0241@likida.test');
  begin
    insert into jornada_politica (tenant_id, horas_max_jornada, declarada_por_email)
      values (ta, 10, 'zzz-0241@likida.test');
    dos_politicas_rebotan := false;
  exception when unique_violation then
    dos_politicas_rebotan := true;
  end;

  -- (m) El doble candado. Horario de una persona identificada: dato personal.
  cerrado := not has_table_privilege('anon', 'public.jornada_dia', 'SELECT')
    and not has_table_privilege('authenticated', 'public.jornada_dia', 'SELECT')
    and not has_table_privilege('anon', 'public.jornada_asiento', 'SELECT')
    and not has_table_privilege('authenticated', 'public.jornada_asiento', 'SELECT')
    and not has_table_privilege('anon', 'public.jornada_politica', 'SELECT')
    and not has_table_privilege('authenticated', 'public.jornada_politica', 'SELECT')
    and has_table_privilege('service_role', 'public.jornada_dia', 'SELECT')
    and has_table_privilege('service_role', 'public.jornada_asiento', 'INSERT')
    and has_table_privilege('service_role', 'public.jornada_politica', 'UPDATE')
    and (select relrowsecurity from pg_class where oid = 'public.jornada_dia'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.jornada_asiento'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.jornada_politica'::regclass);

  raise exception 'JORNADA_LFT_0241  dia_repetido_rebota=%  derivado_rebota_si_hay_declarado=%  corregido_entra_tras_anular=%  anulado_no_estorba=%  origen_repetido_rebota=%  wa_repetido_rebota=%  dos_sin_wa_conviven=%  dos_descansos_conviven=%  derivado_sin_origen_rebota=%  captura_sin_firma_rebota=%  anulacion_sin_motivo_rebota=%  anulacion_sin_firma_rebota=%  procedencia_inventada_rebota=%  conformidad_sin_mensaje_rebota=%  cierre_sin_firma_rebota=%  cierre_incoherente_rebota=%  borrar_operador_rebota=%  borrar_viaje_deja_asiento=%  tenant_sobrevive=%  dia_de_otra_flota_rebota=%  corrige_otra_flota_rebota=%  jornada_late=%  asistencia_late=%  sat_late=%  cron_inventado_rebota=%  cero_horas_rebota=%  nan_rebota=%  mas_de_24_rebota=%  dos_politicas_rebotan=%  cerrado=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t)',
    dia_repetido_rebota, derivado_rebota_si_hay_declarado, corregido_entra_tras_anular,
    anulado_no_estorba, origen_repetido_rebota, wa_repetido_rebota, dos_sin_wa_conviven,
    dos_descansos_conviven, derivado_sin_origen_rebota, captura_sin_firma_rebota,
    anulacion_sin_motivo_rebota, anulacion_sin_firma_rebota, procedencia_inventada_rebota,
    conformidad_sin_mensaje_rebota, cierre_sin_firma_rebota, cierre_incoherente_rebota,
    borrar_operador_rebota, borrar_viaje_deja_asiento, tenant_sobrevive,
    dia_de_otra_flota_rebota, corrige_otra_flota_rebota,
    jornada_late, asistencia_late, sat_late, cron_inventado_rebota,
    cero_horas_rebota, nan_rebota, mas_de_24_rebota, dos_politicas_rebotan, cerrado;
end $$;
-- ── 194. La verdad-de-terreno del banco de QA y sus lecturas (mig. 0239) ────
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTIVA 0239 — LA VERDAD-DE-TERRENO ES UN CONTRATO DE LA BASE, Y CADA
-- LECTURA DEL OCR QUEDA ESCRITA CON SU MEDICIÓN
--
-- El ordinal es el 194, que el fork del carril completo (#173, bloque 196)
-- dejó reservado para esta rama al escribir el suyo. El número
-- del título es lo ÚNICO que `migraciones_verificadas.test.ts` sabe leer para
-- contestar "¿está comprobada la 0239?", así que tiene que existir aunque el
-- cuerpo se identifique por el número de migración.
--
-- Qué se prueba, y por qué cada punto importa:
--
--  (a) EL CONTRATO ACEPTA LA ETIQUETA BIEN FORMADA. Sin esto la migración
--      podría ser un CHECK que rebota todo, y "nada entra" también es un
--      contrato — uno inútil.
--  (b) UN `null` SIN CLASIFICAR REBOTA. Es el caso central: en la etiqueta,
--      `null` significa "el papel no lo imprime" o "el papel lo imprime y no
--      se ve", y las dos dan veredictos OPUESTOS al medir el OCR (alucinación
--      vs campo sin medir). Un null sin clasificar obliga al motor a elegir a
--      ciegas entre las dos, y el porcentaje que sale se cita en una decisión.
--  (c) LA MISMA CLAVE EN LAS DOS LISTAS REBOTA: son afirmaciones que se
--      contradicen, y quedarse con cualquiera de las dos sería inventar.
--  (d) UN VALOR NO NULO LISTADO COMO ILEGIBLE REBOTA. Ese campo se
--      descontaría del denominador teniendo un esperado perfectamente bueno:
--      el porcentaje saldría inflado sobre menos campos de los que se midieron.
--  (e) LAS 7 CLAVES TIENEN QUE ESTAR PRESENTES, aunque valgan null. Una clave
--      AUSENTE se leería como null sin que nadie la haya considerado nunca.
--  (f) EL CHECK DE LA TABLA REBOTA DE VERDAD (no solo la función suelta), y
--      la etiqueta buena entra con su firma.
--  (g) LOS TRES CONTADORES DE `qa_foto_lectura` SUMAN 7. Si no suman, la fila
--      describe una medición que no ocurrió — y es justo el número que luego
--      se agrega en un porcentaje.
--  (h) BORRAR LA FOTO SE LLEVA SUS LECTURAS (`on delete cascade`): una lectura
--      sin su foto no tiene ni imagen que revisar ni etiqueta contra la cual
--      entenderse.
--  (i) EL DOBLE CANDADO: RLS activo y `anon`/`authenticated` sin un solo
--      privilegio sobre `qa_foto_lectura`, que guarda RFC, razón social y
--      sucursal de comprobantes REALES (art. 2 fr. VI LFPDPPP). Solo
--      `service_role`.
do $$
declare
  buena jsonb;
  acepta_buena boolean;
  null_sin_clasificar boolean; en_las_dos boolean; valor_listado boolean;
  clave_ausente boolean;
  check_tabla_rebota boolean; etiqueta_buena_entra boolean;
  contadores_rebotan boolean;
  fid uuid; lecturas_tras_borrar bigint;
  rls_activo boolean; cerrado boolean;
begin
  buena := jsonb_build_object(
    'comercioClave', 'capufe',
    'emisor', 'Caminos y Puentes Federales',
    'rfcEmisor', 'CPF890101AAA',
    'folio', '000123',
    'monto', 1234.50,
    'fecha', '2026-07-31',
    'sucursal', 'Caseta Palmillas',
    'dominioFacturacion', 'facturacioncapufe.com.mx',
    'ilegibles', '[]'::jsonb,
    'noAplica', '[]'::jsonb,
    'clase', 'ticket',
    'notas', null
  );

  -- (a)
  acepta_buena := public.qa_verdad_terreno_valida(buena);

  -- (b) folio en null y en NINGUNA de las dos listas.
  null_sin_clasificar := public.qa_verdad_terreno_valida(buena || jsonb_build_object('folio', null));

  -- (c) folio en null y en LAS DOS listas.
  en_las_dos := public.qa_verdad_terreno_valida(
    buena || jsonb_build_object('folio', null, 'ilegibles', '["folio"]'::jsonb, 'noAplica', '["folio"]'::jsonb));

  -- (d) folio CON valor, pero listado como ilegible.
  valor_listado := public.qa_verdad_terreno_valida(buena || jsonb_build_object('ilegibles', '["folio"]'::jsonb));

  -- (e) la clave `sucursal` quitada del objeto entero.
  clave_ausente := public.qa_verdad_terreno_valida(buena - 'sucursal');

  -- (f) el CHECK de la tabla, con una foto de verdad.
  insert into qa_foto (hash, path, mime, etiqueta, bytes)
    values ('zzz-verif-0239-hash', 'banco/zzz-verif-0239.jpg', 'image/jpeg', 'ZZZ VERIF 0239', 100)
    returning id into fid;

  begin
    update qa_foto
      set ocr_esperado = buena || jsonb_build_object('folio', null),
          confirmado_en = now()
      where id = fid;
    check_tabla_rebota := false;
  exception when check_violation then
    check_tabla_rebota := true;
  end;

  begin
    update qa_foto set ocr_esperado = buena, confirmado_en = now() where id = fid;
    etiqueta_buena_entra := true;
  exception when others then
    etiqueta_buena_entra := false;
  end;

  -- (g) los contadores que no suman 7 no describen ninguna medición real.
  begin
    insert into qa_foto_lectura (foto_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos)
      values (fid, 'zzz-verif', '{}'::jsonb, '{}'::jsonb, 3, 1, 1);
    contadores_rebotan := false;
  exception when check_violation then
    contadores_rebotan := true;
  end;

  insert into qa_foto_lectura (foto_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos, costo_usd)
    values (fid, 'zzz-verif', '{}'::jsonb, '{}'::jsonb, 7, 0, 0, 0.0031);

  -- (h) el cascade.
  delete from qa_foto where id = fid;
  select count(*) into lecturas_tras_borrar from qa_foto_lectura where foto_id = fid;

  -- (i) el doble candado.
  select relrowsecurity into rls_activo from pg_class where oid = 'public.qa_foto_lectura'::regclass;
  cerrado :=
    not has_table_privilege('anon', 'public.qa_foto_lectura', 'SELECT')
    and not has_table_privilege('anon', 'public.qa_foto_lectura', 'INSERT')
    and not has_table_privilege('authenticated', 'public.qa_foto_lectura', 'SELECT')
    and not has_table_privilege('authenticated', 'public.qa_foto_lectura', 'INSERT')
    and has_table_privilege('service_role', 'public.qa_foto_lectura', 'SELECT')
    and has_table_privilege('service_role', 'public.qa_foto_lectura', 'INSERT');

  raise exception 'CORRECTIVA_0239  acepta_buena=%  null_sin_clasificar=%  en_las_dos=%  valor_listado=%  clave_ausente=%  check_tabla_rebota=%  etiqueta_buena_entra=%  contadores_rebotan=%  lecturas_tras_borrar=%  rls_activo=%  cerrado=%   (esperado t / f / f / f / f / t / t / t / 0 / t / t)',
    acepta_buena, null_sin_clasificar, en_las_dos, valor_listado, clave_ausente,
    check_tabla_rebota, etiqueta_buena_entra, contadores_rebotan,
    lecturas_tras_borrar, rls_activo, cerrado;
end $$;

-- ── 198. Los litros del consolidado: dominio y el índice de la 3.3.1.7 (mig. 0242) ──
-- (El ordinal 174 que la consigna reservaba YA ESTABA TOMADO desde la máquina
--  de prospección, mig. 0217. El máximo vivo era el 197; este es el siguiente.
--  El conteo de `do $$` es 173 porque seis ordinales quedaron reservados sin
--  bloque — ver el 171 y los 165, 167-169.)
--
-- Lo que solo la base demuestra de la 0242:
--   (a) un litro NEGATIVO no entra. El motor tiene su propio `litros > 0`
--       antes de acumular, pero eso protege el cálculo de hoy, no la columna:
--       cualquier reporte futuro que sume `cfdi_consolidado_linea.litros`
--       heredaría el negativo, y un negativo entre las líneas del mes RESTA
--       litros realmente cargados del estímulo de la LIF 2026 art. 20 ap. A;
--   (b) `null` SÍ entra y significa "esta línea no midió volumen" (una caseta
--       trae Cantidad=1 y eso es UN CRUCE). `null` ≠ 0, y el CHECK no lo
--       confunde con un dato faltante que haya que rellenar;
--   (c) el cero entra: una línea de $0 con 0.000 L es rara pero no imposible
--       (una corrección del emisor), y rebotarla obligaría al intake a
--       inventar `null` donde el documento sí midió;
--   (d) el índice parcial del camino B de `evidenciaMonedero` EXISTE y su
--       predicado es el del WHERE de `lineasEccParaCuadre` — un índice con
--       otro predicado no lo usaría el planner y la consulta seguiría
--       escaneando la cola entera de casetas del tenant en cada cuadre.
do $$
declare
  ta uuid; xid uuid;
  negativo_rebota boolean; nulo_entra boolean; cero_entra boolean;
  indice_existe boolean; predicado_correcto boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0242') returning id into ta;
  insert into cfdi_xml (tenant_id, cfdi_uuid, xml, tiene_multiples_conceptos, total_conceptos)
    values (ta, 'zzz-verif-0242-uuid', '<x/>', true, 3)
    returning id into xid;

  -- (a) El litro negativo.
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, litros)
      values (ta, xid, 1, 'ecc12', 1200.00, -450.000);
    negativo_rebota := false;
  exception when check_violation then
    negativo_rebota := true;
  end;

  -- (b) NULL: "no se midió volumen" sigue siendo un valor legítimo.
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, litros)
      values (ta, xid, 2, 'concepto_base', 118.00, null);
    nulo_entra := true;
  exception when others then
    nulo_entra := false;
  end;

  -- (c) El cero medido no se confunde con el negativo.
  begin
    insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, litros)
      values (ta, xid, 3, 'ecc12', 0.00, 0.000);
    cero_entra := true;
  exception when others then
    cero_entra := false;
  end;

  -- (d) El índice del camino B, con SU predicado.
  select count(*) = 1 into indice_existe
    from pg_class
    where relname = 'cfdi_consolidado_linea_ecc_por_fecha_idx' and relkind = 'i';
  select pg_get_indexdef(c.oid) like '%WHERE%ecc12%estacion_rfc IS NOT NULL%'
    into predicado_correcto
    from pg_class c
    where c.relname = 'cfdi_consolidado_linea_ecc_por_fecha_idx';

  delete from tenant where id = ta;

  raise exception 'CONSOLIDADO_LITROS_0242  negativo_rebota=%  nulo_entra=%  cero_entra=%  indice_existe=%  predicado_correcto=%   (esperado t / t / t / t / t)',
    negativo_rebota, nulo_entra, cero_entra, indice_existe, predicado_correcto;
end $$;

-- ── 199. La bandeja de conciliación del SAT: la firma no se pierde, el expediente no se edita, y deshacer no borra (mig. 0243) ──
-- El bloque 191 tomó la 0236 y el 197 la 0241. El 198 lo tomó la 0242
-- (litros del consolidado) mientras esta rama trabajaba, así que al rebasar
-- este bloque se renumeró de 198 a 199 — el siguiente libre.
--
-- LO QUE SOLO LA BASE PUEDE DEMOSTRAR, y que hasta la 0243 estaba abierto:
--
--  (a) LA FIRMA A MEDIAS NO EXISTE. `resuelto_en` sin `resuelto_por_email`
--      —o al revés— es un expediente que dice «lo resolvió alguien el
--      martes». El CHECK lo rebota en los dos sentidos.
--  (b) LA FIRMA SOBREVIVE AL BORRADO DE LA CUENTA. `resuelto_por` es uuid con
--      `on delete set null` por ARCO: al borrar al contralor, el uuid se anula
--      y el CORREO CONGELADO se queda. Sin él, el cruce quedaría firmado por
--      nadie (misma razón que `cola_aprobacion.resuelto_por_email`, 0120, y
--      `jornada_dia.cerrado_por_email`, 0241).
--  (c) EL CHECK DE LA 0231 SIGUE APRETADO. Un 'casado' sin gasto rebota, y un
--      gasto pegado a un estatus que no es 'casado' también. Resolver un
--      ambiguo —estatus y gasto en el MISMO update— lo deja contento.
--  (d) LA FLOTA A NO CASA CON UN GASTO DE LA FLOTA B. La FK compuesta
--      `(gasto_id, tenant_id)` lo rebota, y el aislamiento no depende de que
--      el TypeScript se acuerde de filtrar.
--  (e) EL EXPEDIENTE ES APPEND-ONLY POR PRIVILEGIO, NO POR COMENTARIO.
--      Supabase concede `update`/`delete` por DEFAULT PRIVILEGES a
--      `service_role` al crear cualquier tabla nueva: sin el REVOKE explícito
--      de la 0243, «append-only» habría sido una promesa de comentario. Se
--      mide con `has_table_privilege`, que es el único que no se puede
--      contradecir.
--  (f) UN ACTO QUE QUITA UNA AFIRMACIÓN EXIGE MOTIVO, y todo acto de una
--      PERSONA exige firma. El único acto sin firma es el de la base
--      ('degradado'), y por eso se llama distinto.
--  (g) BORRAR EL GASTO SIGUE SIENDO POSIBLE — y ahora, además, limpia la
--      firma vieja y escribe su propio renglón. Ésta es la parte que más fácil
--      se rompe: la 0243 añadió un CHECK de firma Y un insert dentro del
--      trigger que la acción referencial dispara. Si cualquiera de los dos
--      estuviera mal, borrar un viaje con gastos casados volvería a reventar —
--      que es el bug c7-3 que la 0236 cerró, resucitado por su sucesora.
--      (Se probó con `on delete set null (gasto_id)` sobre el expediente y
--      REVENTABA: el CHECK `ligado_con_gasto` chocaba con la acción
--      referencial. Por eso `sat_cfdi_resolucion.gasto_id` NO tiene FK.)
--  (h) EL EXPEDIENTE NOMBRA UN GASTO QUE YA NO EXISTE. Es el punto entero de
--      no ponerle FK: «alguien afirmó este cruce» es un hecho que sobrevive a
--      que el gasto se borre.
--  (i) BORRAR LA FLOTA ENTERA SIGUE FUNCIONANDO, y se lleva el expediente por
--      cascade — aunque `service_role` no tenga DELETE sobre esa tabla: las
--      acciones referenciales corren por dentro.
do $$
declare
  ta uuid; tb uuid; oa uuid; ob uuid; va uuid; vb uuid; ga uuid; gb uuid;
  usr uuid; cf uuid;
  firma_a_medias_rebota boolean; firma_sobrevive_borrado boolean;
  casado_sin_gasto_rebota boolean; gasto_sin_casado_rebota boolean;
  ambiguo_resuelto_entra boolean; otra_flota_rebota boolean;
  expediente_cerrado boolean; ignorar_sin_motivo_rebota boolean;
  revertir_sin_motivo_rebota boolean; acto_humano_sin_firma_rebota boolean;
  ligado_sin_gasto_rebota boolean; acto_inventado_rebota boolean;
  borrar_gasto_ok boolean; degradado_limpia_firma boolean;
  degradado_anotado boolean; expediente_nombra_gasto_muerto boolean;
  ligado_sobrevive boolean; indice_bandeja_existe boolean;
  borrar_flota_ok boolean; expediente_barrido boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0243 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0243 B') returning id into tb;
  insert into operador (tenant_id, nombre, telefono)
    values (ta, 'ZZZ 0243 A', '+520000000243') returning id into oa;
  insert into operador (tenant_id, nombre, telefono)
    values (tb, 'ZZZ 0243 B', '+520000000244') returning id into ob;
  insert into viaje (tenant_id, operador_id, folio) values (ta, oa, 'ZZZ-0243-A') returning id into va;
  insert into viaje (tenant_id, operador_id, folio) values (tb, ob, 'ZZZ-0243-B') returning id into vb;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
    values (ta, va, 'caseta', 300, current_date) returning id into ga;
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha)
    values (tb, vb, 'caseta', 300, current_date) returning id into gb;
  insert into app_user (id, tenant_id, email)
    values (gen_random_uuid(), ta, 'zzz-0243@likida.test') returning id into usr;

  -- El comprobante que el motor dejó AMBIGUO: dos gastos empataron y no ligó
  -- ninguno. Es la fila que existe para que un humano decida.
  insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus, total, fecha, candidatos)
    values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000243', 'ambiguo', 300, current_date,
            '{"candidatos":[{"gastoId":"x","monto":300},{"gastoId":"y","monto":300}]}')
    returning id into cf;

  -- ── (c) EL CHECK DE LA 0231, en sus dos sentidos ─────────────────────────
  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus)
      values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000244', 'casado');
    casado_sin_gasto_rebota := false;
  exception when check_violation then casado_sin_gasto_rebota := true; end;

  begin
    insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus, gasto_id)
      values (ta, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000245', 'disponible', ga);
    gasto_sin_casado_rebota := false;
  exception when check_violation then gasto_sin_casado_rebota := true; end;

  -- ── (d) LIGAR UN GASTO DE OTRA FLOTA ─────────────────────────────────────
  begin
    update sat_cfdi_descargado
       set estatus = 'casado', gasto_id = gb,
           resuelto_por = usr, resuelto_por_email = 'zzz-0243@likida.test', resuelto_en = now()
     where id = cf;
    otra_flota_rebota := false;
  exception when foreign_key_violation then otra_flota_rebota := true; end;

  -- ── (c) RESOLVER EL AMBIGUO: estatus y gasto EN EL MISMO UPDATE ─────────
  begin
    update sat_cfdi_descargado
       set estatus = 'casado', gasto_id = ga,
           resuelto_por = usr, resuelto_por_email = 'zzz-0243@likida.test', resuelto_en = now()
     where id = cf;
    ambiguo_resuelto_entra := true;
  exception when others then ambiguo_resuelto_entra := false; end;

  insert into sat_cfdi_resolucion
    (tenant_id, cfdi_id, acto, gasto_id, estatus_antes, estatus_despues, actor_id, actor_email)
    values (ta, cf, 'ligado', ga, 'ambiguo', 'casado', usr, 'zzz-0243@likida.test');

  -- ── (a) LA FIRMA A MEDIAS ────────────────────────────────────────────────
  begin
    update sat_cfdi_descargado set resuelto_por_email = null where id = cf;
    firma_a_medias_rebota := false;
  exception when check_violation then firma_a_medias_rebota := true; end;

  -- ── (f) LOS CANDADOS DEL EXPEDIENTE ──────────────────────────────────────
  begin
    insert into sat_cfdi_resolucion (tenant_id, cfdi_id, acto, estatus_antes, estatus_despues, actor_email)
      values (ta, cf, 'ignorado', 'disponible', 'ignorado', 'zzz-0243@likida.test');
    ignorar_sin_motivo_rebota := false;
  exception when check_violation then ignorar_sin_motivo_rebota := true; end;

  begin
    insert into sat_cfdi_resolucion (tenant_id, cfdi_id, acto, gasto_id, estatus_antes, estatus_despues, actor_email)
      values (ta, cf, 'revertido', ga, 'casado', 'disponible', 'zzz-0243@likida.test');
    revertir_sin_motivo_rebota := false;
  exception when check_violation then revertir_sin_motivo_rebota := true; end;

  begin
    insert into sat_cfdi_resolucion (tenant_id, cfdi_id, acto, gasto_id, estatus_antes, estatus_despues, motivo)
      values (ta, cf, 'revertido', ga, 'casado', 'disponible', 'sin firmar');
    acto_humano_sin_firma_rebota := false;
  exception when check_violation then acto_humano_sin_firma_rebota := true; end;

  begin
    insert into sat_cfdi_resolucion (tenant_id, cfdi_id, acto, estatus_antes, estatus_despues, actor_email)
      values (ta, cf, 'ligado', 'ambiguo', 'casado', 'zzz-0243@likida.test');
    ligado_sin_gasto_rebota := false;
  exception when check_violation then ligado_sin_gasto_rebota := true; end;

  begin
    insert into sat_cfdi_resolucion (tenant_id, cfdi_id, acto, estatus_antes, estatus_despues, motivo, actor_email)
      values (ta, cf, 'perdonado', 'casado', 'disponible', 'x', 'zzz-0243@likida.test');
    acto_inventado_rebota := false;
  exception when check_violation then acto_inventado_rebota := true; end;

  -- ── (e) APPEND-ONLY POR PRIVILEGIO ───────────────────────────────────────
  expediente_cerrado :=
        not has_table_privilege('anon', 'public.sat_cfdi_resolucion', 'SELECT')
    and not has_table_privilege('anon', 'public.sat_cfdi_resolucion', 'INSERT')
    and not has_table_privilege('authenticated', 'public.sat_cfdi_resolucion', 'SELECT')
    and not has_table_privilege('authenticated', 'public.sat_cfdi_resolucion', 'INSERT')
    and has_table_privilege('service_role', 'public.sat_cfdi_resolucion', 'SELECT')
    and has_table_privilege('service_role', 'public.sat_cfdi_resolucion', 'INSERT')
    and not has_table_privilege('service_role', 'public.sat_cfdi_resolucion', 'UPDATE')
    and not has_table_privilege('service_role', 'public.sat_cfdi_resolucion', 'DELETE');

  -- El índice que hace que la lista se pueda paginar sin barrer la tabla.
  select count(*) = 1 into indice_bandeja_existe
    from pg_indexes where schemaname = 'public' and indexname = 'sat_cfdi_descargado_bandeja_idx';

  -- ── (b) LA FIRMA SOBREVIVE AL BORRADO DE LA CUENTA (ARCO) ────────────────
  delete from app_user where id = usr;
  select resuelto_por is null and resuelto_por_email = 'zzz-0243@likida.test'
    into firma_sobrevive_borrado
    from sat_cfdi_descargado where id = cf;

  -- ── (g)(h) BORRAR EL GASTO ───────────────────────────────────────────────
  begin
    delete from gasto where id = ga;
    borrar_gasto_ok := true;
  exception when others then borrar_gasto_ok := false; end;

  select estatus = 'disponible' and gasto_id is null
     and resuelto_por_email is null and resuelto_en is null
    into degradado_limpia_firma
    from sat_cfdi_descargado where id = cf;

  select count(*) = 1 into degradado_anotado
    from sat_cfdi_resolucion
   where cfdi_id = cf and acto = 'degradado' and actor_email is null
     and estatus_despues = 'disponible' and motivo like '%zzz-0243@likida.test%';

  -- El expediente NOMBRA el gasto que ya no existe: ése es el punto de que la
  -- columna no tenga llave foránea.
  select count(*) = 1 into expediente_nombra_gasto_muerto
    from sat_cfdi_resolucion where cfdi_id = cf and acto = 'degradado' and gasto_id = ga;
  select count(*) = 1 into ligado_sobrevive
    from sat_cfdi_resolucion where cfdi_id = cf and acto = 'ligado' and gasto_id = ga;

  -- ── (i) BORRAR LA FLOTA ENTERA ───────────────────────────────────────────
  begin
    delete from tenant where id = ta;
    borrar_flota_ok := true;
  exception when others then borrar_flota_ok := false; end;
  select count(*) = 0 into expediente_barrido from sat_cfdi_resolucion where tenant_id = ta;

  raise exception 'BANDEJA_SAT_0243  casado_sin_gasto_rebota=%  gasto_sin_casado_rebota=%  otra_flota_rebota=%  ambiguo_resuelto_entra=%  firma_a_medias_rebota=%  ignorar_sin_motivo_rebota=%  revertir_sin_motivo_rebota=%  acto_humano_sin_firma_rebota=%  ligado_sin_gasto_rebota=%  acto_inventado_rebota=%  expediente_cerrado=%  indice_bandeja_existe=%  firma_sobrevive_borrado=%  borrar_gasto_ok=%  degradado_limpia_firma=%  degradado_anotado=%  expediente_nombra_gasto_muerto=%  ligado_sobrevive=%  borrar_flota_ok=%  expediente_barrido=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t / t)',
    casado_sin_gasto_rebota, gasto_sin_casado_rebota, otra_flota_rebota, ambiguo_resuelto_entra,
    firma_a_medias_rebota, ignorar_sin_motivo_rebota, revertir_sin_motivo_rebota,
    acto_humano_sin_firma_rebota, ligado_sin_gasto_rebota, acto_inventado_rebota,
    expediente_cerrado, indice_bandeja_existe, firma_sobrevive_borrado,
    borrar_gasto_ok, degradado_limpia_firma, degradado_anotado,
    expediente_nombra_gasto_muerto, ligado_sobrevive, borrar_flota_ok, expediente_barrido;
end $$;

-- ── 200. El anti-join de anomalías por IGUALDAD y el presupuesto de IA por propósito (mig. 0244) ──
--
-- (Renumerado de 199 a 200 al rebasar: la 0243 —bandeja SAT— tomó el 199.)
--
-- D.20: `anomalias_gasto_tenant` descartaba "folios que en realidad son un
-- CFDI conocido" con `position()` contra todos los UUID del tenant — un
-- escaneo O(grupos × UUIDs) que cinco auditorías señalaron. Ahora es igualdad
-- contra `uq_gasto_cfdi_uuid` (medido: anti-join de 934 ms → ~1.5 ms con 20k
-- UUIDs y 110 grupos; la función completa 2 633 → 310 ms).
--   (a) un folio repetido en 2 viajes cuyo texto ES un UUID timbrado del
--       tenant NO se reporta como folio_duplicado (ya vive en el mundo CFDI);
--   (b) un folio repetido normal SÍ se reporta — la igualdad no se comió la
--       detección;
--   (c) el cuerpo desplegado ya no contiene `position(` — el pin que evita
--       que una migración futura lo regrese sin querer.
--
-- D.23: la reserva del camino interactivo. El fondo ('ocr_lote'/'fondo') solo
-- gasta hasta (tope_tenant − reserva_interactivo); el interactivo usa el
-- techo completo. Un lote de OCR ya no puede dejar al chofer sin servicio.
--   (d) fondo dentro de su parte → 'ok';
--   (e) fondo tocando la reserva → 'tope_proposito' (falla cerrado, con
--       nombre);
--   (f) interactivo entra HASTA el techo aunque el fondo esté en su límite;
--   (g) un propósito fuera del dominio LANZA (no se cuela a una cubeta);
--   (h) anon/authenticated sin execute sobre la RPC de 8 args; service_role sí.
do $$
declare
  t uuid; op1 uuid; op2 uuid; v1 uuid; v2 uuid;
  j jsonb;
  folio_uuid_descartado boolean; folio_normal_reportado boolean;
  sin_position boolean;
  fondo_ok text; fondo_rebota text; interactivo_entra text;
  proposito_malo_rebota boolean;
  rpc_oid oid;
  anon_ciego boolean; auth_ciego boolean; svc_puede boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0244') returning id into t;
  insert into operador (tenant_id, nombre, telefono) values (t, 'ZZZ 0244 A', '5215559990244') returning id into op1;
  insert into operador (tenant_id, nombre, telefono) values (t, 'ZZZ 0244 B', '5215559990245') returning id into op2;
  insert into viaje (tenant_id, operador_id, folio, estatus, anticipo) values (t, op1, 'ZZZ-0244-1', 'abierto', 100) returning id into v1;
  insert into viaje (tenant_id, operador_id, folio, estatus, anticipo) values (t, op2, 'ZZZ-0244-2', 'abierto', 100) returning id into v2;

  -- El CFDI timbrado del tenant, y dos tickets sin uuid cuyo FOLIO impreso ES
  -- ese UUID (mismo concepto y monto, viajes distintos) — el caso que el
  -- anti-join existe para descartar. Más un folio repetido normal de control.
  insert into gasto (tenant_id, viaje_id, concepto, monto, fecha, folio, cfdi_uuid, cfdi_orden) values
    (t, v1, 'diesel', 900, current_date - 3, 'D1', 'deadbeef-0000-4000-8000-000000000244', 1),
    (t, v1, 'caseta', 333, current_date - 2, 'DEADBEEF-0000-4000-8000-000000000244', null, 1),
    (t, v2, 'caseta', 333, current_date - 2, 'DEADBEEF-0000-4000-8000-000000000244', null, 1),
    (t, v1, 'caseta', 200, current_date - 2, 'A-991', null, 1),
    (t, v2, 'caseta', 200, current_date - 2, 'A-991', null, 1);

  j := anomalias_gasto_tenant(t);
  folio_uuid_descartado := not exists (
    select 1 from jsonb_array_elements(j) e
    where e->>'tipo' = 'folio_duplicado' and e->>'detalle' ilike '%DEADBEEF%');
  folio_normal_reportado := exists (
    select 1 from jsonb_array_elements(j) e
    where e->>'tipo' = 'folio_duplicado' and e->>'detalle' like '%A-991%');
  sin_position := pg_get_functiondef('public.anomalias_gasto_tenant(uuid)'::regprocedure)
    not ilike '%position(%';

  -- ── D.23: tope tenant 1.00, reserva interactivo 0.40 → fondo llega a 0.60 ─
  fondo_ok := public.reservar_presupuesto_llm(gen_random_uuid(), t, gen_random_uuid(), 0.50, 5.00, 1.00, 'ocr_lote', 0.40);
  fondo_rebota := public.reservar_presupuesto_llm(gen_random_uuid(), t, gen_random_uuid(), 0.20, 5.00, 1.00, 'fondo', 0.40);
  interactivo_entra := public.reservar_presupuesto_llm(gen_random_uuid(), t, gen_random_uuid(), 0.45, 5.00, 1.00, 'interactivo', 0.40);

  begin
    perform public.reservar_presupuesto_llm(gen_random_uuid(), t, gen_random_uuid(), 0.01, 5.00, 1.00, 'marketing', 0.40);
    proposito_malo_rebota := false;
  exception when others then
    proposito_malo_rebota := true;
  end;

  select p.oid into rpc_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reservar_presupuesto_llm' and p.pronargs = 8;
  anon_ciego := not has_function_privilege('anon', rpc_oid, 'execute');
  auth_ciego := not has_function_privilege('authenticated', rpc_oid, 'execute');
  svc_puede := has_function_privilege('service_role', rpc_oid, 'execute');

  delete from llm_presupuesto_reserva where tenant_id = t;
  delete from tenant where id = t;

  raise exception 'ANTIJOIN_Y_PROPOSITO_0244  folio_uuid_descartado=%  folio_normal_reportado=%  sin_position=%  fondo_ok=%  fondo_rebota=%  interactivo_entra=%  proposito_malo_rebota=%  anon=%  auth=%  svc=%   (esperado t / t / t / ok / tope_proposito / ok / t / t / t / t)',
    folio_uuid_descartado, folio_normal_reportado, sin_position, fondo_ok, fondo_rebota, interactivo_entra, proposito_malo_rebota, anon_ciego, auth_ciego, svc_puede;
end $$;

-- ── 201. La purga de prospectos borra TODO lo que el aviso promete, y el ledger comercial pierde lo personal pero no el hecho (mig. 0245) ──
--
-- (Renumerado dos veces al fusionar: nació 199 —la bandeja SAT tomó ese—,
-- pasó a 200, y el anti-join de la 0244 tomó el 200. La numeración es de
-- lectura, no de ejecución.)
--
-- /aviso/prospectos promete «tu nombre, puesto, correo y teléfono se eliminan
-- automáticamente… lo único que queda es el registro de la empresa». Tras la
-- 0191 la fila del prospecto frío CONSERVABA los mensajes redactados (llevan
-- el nombre de pila ADENTRO, repuesto tras la completion) y la `atribucion`
-- del lead (fbclid/gclid identifican a quien llenó /getdemo); y un prospecto
-- 'lost' (el 'perdido' del CRM de la 0181) nunca entraba a la purga porque la
-- condición de estado se quedó con la lista vieja. La 0245 cierra las tres.
--
-- El ledger comercial (comercial_evento, 0181) guardaba el payload ENTERO de
-- Cal.com —nombre, correo, respuestas del formulario— sin ningún plazo. La
-- 0245 lo anonimiza a los 365 días: payload fuera, el hecho (fuente, tipo,
-- fecha) se queda — borrar el renglón mataría la idempotencia del webhook y
-- el valor del ledger, y el dato personal no vive ahí.
--
-- Todo revierte con el RAISE final. Esperado:
--   PURGA_0245  lost_persona_fuera=t  lost_limpio=t  empresa_viva=t  ledger_viejo_vacio=t  ledger_reciente_intacto=t  llave_nueva=t  llave_120=t  anon=f
do $$
declare
  lost uuid; ev_viejo uuid; ev_reciente uuid; res jsonb;
  lost_persona_fuera boolean; lost_limpio boolean; empresa_viva boolean;
  ledger_viejo_vacio boolean; ledger_reciente_intacto boolean;
  llave_nueva boolean; llave_120 boolean; anon_ok boolean;
begin
  -- El prospecto 'lost' de hace 400 días, con TODO lo que la purga promete
  -- quitar: persona, contacto de cabecera, notas, clave, mensajes redactados
  -- (con el nombre adentro, como los deja reponerDecisor) y atribución.
  insert into public.prospecto (
      empresa, estado, contacto_nombre, telefono, correo, notas, lead_clave,
      mensaje_wa, mensaje_correo_asunto, mensaje_correo,
      mensajes_generados_en, mensajes_modelo, atribucion, created_at)
    values (
      '__verif_0243_lost__', 'lost', 'Ing. Prueba Lost', '5219990002431', 'lost@verif.test', 'hablar con lost@verif.test',
      'lost@verif.test',
      'Hola Prueba, ¿le vienen bien 15 minutos el jueves?', 'Asunto de prueba', 'Hola Prueba, le escribo de…',
      now() - interval '400 days', 'modelo-de-prueba',
      '{"fbclid": "verif-0243"}'::jsonb, now() - interval '400 days')
    returning id into lost;
  insert into public.prospecto_persona (prospecto_id, nombre, correo, origen, created_at)
    values (lost, '__V243 lost__', 'lost.persona@verif.test', 'directorio', now() - interval '400 days');

  -- El ledger: un evento de hace 400 días con payload personal, y uno de hace
  -- 10 días que tiene que quedarse intacto.
  insert into public.comercial_evento (clave_idempotencia, fuente, tipo, payload, ocurrido_en)
    values ('__verif_0243_viejo__', 'calcom', 'appointment',
            '{"attendee": {"name": "Prueba Persona", "email": "persona@verif.test"}}'::jsonb,
            now() - interval '400 days')
    returning id into ev_viejo;
  insert into public.comercial_evento (clave_idempotencia, fuente, tipo, payload, ocurrido_en)
    values ('__verif_0243_reciente__', 'calcom', 'appointment',
            '{"attendee": {"name": "Otra Persona"}}'::jsonb, now() - interval '10 days')
    returning id into ev_reciente;

  res := public.mantenimiento_de_datos(30);

  select count(*) = 0 into lost_persona_fuera from public.prospecto_persona where prospecto_id = lost;
  select (contacto_nombre is null and telefono is null and correo is null and notas is null
          and lead_clave is null and mensaje_wa is null and mensaje_correo is null
          and mensaje_correo_asunto is null and mensajes_generados_en is null
          and mensajes_modelo is null and atribucion is null)
    into lost_limpio from public.prospecto where id = lost;
  select (empresa = '__verif_0243_lost__' and estado = 'lost') into empresa_viva
    from public.prospecto where id = lost;
  select (payload = '{}'::jsonb) into ledger_viejo_vacio from public.comercial_evento where id = ev_viejo;
  select (payload ? 'attendee') into ledger_reciente_intacto from public.comercial_evento where id = ev_reciente;
  llave_nueva := res ? 'comercialEventosAnonimizados';
  llave_120 := res ? 'prospectoPersonasPurgadas';
  select has_function_privilege('anon', 'public.purgar_comercial_evento(integer, timestamptz)', 'EXECUTE') into anon_ok;

  raise exception E'PURGA_0245  lost_persona_fuera=%  lost_limpio=%  empresa_viva=%  ledger_viejo_vacio=%  ledger_reciente_intacto=%  llave_nueva=%  llave_120=%  anon=%   (esperado t/t/t/t/t/t/t/f)',
    lost_persona_fuera, lost_limpio, empresa_viva, ledger_viejo_vacio, ledger_reciente_intacto, llave_nueva, llave_120, anon_ok;
end $$;

-- ── 202. La lectura del OCR conoce su corrida, y una corrida no mide dos veces (mig. 0246) ──
-- (Renumerado tres veces al fusionar: nació 199 —lo tomó la bandeja SAT
--  (0243)—, pasó a 200 —lo tomó el anti-join del frente D (0244)— y a 201
--  —lo tomó la purga del frente C legal (0245)—. La numeración es de
--  lectura, no de ejecución.)
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTIVA 0246 — `qa_foto_lectura.corrida_id` + el índice único PARCIAL
-- `qa_foto_lectura_una_por_corrida`.
--
-- El agujero medido que la migración cierra: la corrida del 28-ago-2026
-- procesó las 90 fotos reales ($0.29 de modelo, qa_corrida_foto = 90) y
-- `qa_foto_lectura` quedó en CERO — nadie comparaba lo leído contra la
-- verdad-de-terreno. El medidor nuevo (qa-medicion.ts) escribe una fila por
-- foto, y su idempotencia NO es un `if` en TypeScript: es este índice. Lo que
-- solo la base puede demostrar, se demuestra aquí:
--
--  (a) LA MISMA FOTO EN LA MISMA CORRIDA REBOTA (23505). Repetir la medición
--      (una pasada muerta a medias, el script corrido dos veces) no puede
--      duplicar filas: una fila doble entra al porcentaje dos veces y el
--      número que se cita queda inventado.
--  (b) LA MISMA FOTO EN OTRA CORRIDA SÍ ENTRA: comparar dos corridas (prompt
--      A vs prompt B) es exactamente lo que hace útil la medición — una
--      corrida nueva jamás borra ni bloquea a la anterior.
--  (c) LAS LECTURAS SUELTAS (corrida_id NULL) SE APILAN LIBRES: el botón del
--      banco escribe historial, y el índice es parcial justo para no
--      convertir ese historial en un rebote.
--  (d) BORRAR LA CORRIDA NO BORRA LA MEDICIÓN (`on delete set null`): la
--      lectura es historial del modelo contra la foto; la corrida es su
--      contexto, no su dueña. La fila queda viva y huérfana de corrida.
do $$
declare
  fid uuid; cid uuid;
  segunda_rebota boolean;
  misma_foto_otra_corrida integer;
  sueltas integer;
  tras_borrar_corrida integer;
  con_corrida_nula integer;
begin
  insert into qa_foto (hash, path, mime, etiqueta, bytes)
    values ('zzz-verif-0246-hash', 'banco/zzz-verif-0246.jpg', 'image/jpeg', 'ZZZ VERIF 0246', 100)
    returning id into fid;
  insert into qa_corrida (escenario, parametros, estado, tenant_nombre)
    values ('demo_guion', '{}'::jsonb, 'ok', 'ZZZ VERIF 0246')
    returning id into cid;

  -- (a) la primera entra; la segunda de la MISMA corrida rebota.
  insert into qa_foto_lectura (foto_id, corrida_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos)
    values (fid, cid, 'zzz-verif', '{}'::jsonb, '{}'::jsonb, 7, 0, 0);
  begin
    insert into qa_foto_lectura (foto_id, corrida_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos)
      values (fid, cid, 'zzz-verif-2', '{}'::jsonb, '{}'::jsonb, 0, 7, 0);
    segunda_rebota := false;
  exception when unique_violation then
    segunda_rebota := true;
  end;

  -- (b) la misma foto medida por OTRA corrida entra sin tocar la anterior.
  insert into qa_corrida (escenario, parametros, estado, tenant_nombre)
    values ('demo_guion', '{}'::jsonb, 'ok', 'ZZZ VERIF 0246 B')
    returning id into cid;
  insert into qa_foto_lectura (foto_id, corrida_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos)
    values (fid, cid, 'zzz-verif', '{}'::jsonb, '{}'::jsonb, 6, 1, 0);
  select count(*) into misma_foto_otra_corrida from qa_foto_lectura where foto_id = fid and corrida_id is not null;

  -- (c) las sueltas (sin corrida) se apilan: dos inserts idénticos, dos filas.
  insert into qa_foto_lectura (foto_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos)
    values (fid, 'zzz-suelta', '{}'::jsonb, '{}'::jsonb, 7, 0, 0);
  insert into qa_foto_lectura (foto_id, modelo, ocr_leido, medicion, campos_ok, campos_mal, campos_no_medidos)
    values (fid, 'zzz-suelta', '{}'::jsonb, '{}'::jsonb, 7, 0, 0);
  select count(*) into sueltas from qa_foto_lectura where foto_id = fid and corrida_id is null;

  -- (d) borrar la SEGUNDA corrida: su lectura sobrevive, huérfana de corrida.
  delete from qa_corrida where id = cid;
  select count(*) into tras_borrar_corrida from qa_foto_lectura where foto_id = fid;
  select count(*) into con_corrida_nula from qa_foto_lectura where foto_id = fid and corrida_id is null;

  raise exception 'QA_LECTURA_CORRIDA_0246  segunda_rebota=%  misma_foto_otra_corrida=%  sueltas=%  tras_borrar_corrida=%  con_corrida_nula=%   (esperado t / 2 / 2 / 4 / 3)',
    segunda_rebota, misma_foto_otra_corrida, sueltas, tras_borrar_corrida, con_corrida_nula;
end $$;

-- ── 203. El vigilante de portales entra al catálogo de crons, y los diez de antes siguen (mig. 0248) ──
--
-- Lo que SOLO la base puede demostrar de la 0248, y por qué vale un bloque:
--
--  (a) `portales-vivos` ES UN LATIDO LEGÍTIMO. Si no lo fuera, el cron correría
--      perfecto y cada `registrarLatido` rebotaría contra el CHECK — y como el
--      latido es best-effort (traga el error con un `warn`), nadie se enteraría.
--      `/api/health` tampoco podría llamarlo muerto, porque nunca tendría un
--      latido suyo que juzgar. Es EXACTAMENTE lo que les pasó a `asistencia` y
--      a `descarga-sat` durante semanas hasta que la 0241 lo cazó, y repetirlo
--      aquí tendría una ironía especial: el cron silenciado sería justo el que
--      existe para que nada se pudra en silencio.
--
--  (b) LOS DIEZ DE LA 0241 SIGUEN ENTRANDO. Ésta es la mitad que de verdad se
--      escapa. El CHECK se reescribe ENTERO cada vez que se toca (se hace
--      `drop` y `add`), así que olvidar un id no da error: lo borra del
--      catálogo. Una migración que solo comprobara «el nuevo entra» pasaría en
--      verde habiendo dejado mudos a los diez anteriores. Por eso se prueban
--      los once, uno por uno.
--
--  (c) UN ID INVENTADO SIGUE REBOTANDO. Si el CHECK se hubiera quedado sin
--      restricción —un `drop` sin su `add`, por ejemplo— (a) y (b) pasarían en
--      verde igual, porque todo entraría. Esta es la que distingue «la lista es
--      correcta» de «no hay lista».
do $$
declare
  vigilante_late boolean;
  faltantes text;
  cron_inventado_rebota boolean;
  ids text[] := array[
    'wa-pendientes','wa-outbox','escalar','facturar','purgar',
    'runner','gps','asistencia','descarga-sat','jornada','portales-vivos'
  ];
  k text;
  no_entraron text[] := '{}';
begin
  -- (a) el nuevo.
  insert into cron_latido (id) values ('portales-vivos')
    on conflict (id) do update set ultimo_latido = now();
  vigilante_late := exists (select 1 from cron_latido where id = 'portales-vivos');

  -- (b) los once, uno por uno: el CHECK se reescribe entero y un olvido no grita.
  foreach k in array ids loop
    begin
      insert into cron_latido (id) values (k)
        on conflict (id) do update set ultimo_latido = now();
    exception when check_violation then
      no_entraron := no_entraron || k;
    end;
  end loop;
  faltantes := coalesce(array_to_string(no_entraron, ','), '');
  if faltantes = '' then faltantes := 'ninguno'; end if;

  -- (c) y la lista sigue siendo una lista.
  begin
    insert into cron_latido (id) values ('cron-que-nadie-escribio');
    cron_inventado_rebota := false;
  exception when check_violation then
    cron_inventado_rebota := true;
  end;

  raise exception 'CRONS_0248  vigilante_late=%  faltantes=%  cron_inventado_rebota=%   (esperado t / ninguno / t)',
    vigilante_late, faltantes, cron_inventado_rebota;
end $$;

-- ── 204. Las palancas de carta_porte y copiloto entran al catálogo, y las 58 de antes siguen (mig. 0250) ──
--
-- Lo que SOLO la base puede demostrar de la 0250 (mismo molde que el bloque
-- 203 le aplicó al `cron_latido_id_dominio` de la 0248):
--
--  (a) LAS DOS NUEVAS ENTRAN. `agente:carta_porte` y `agente:copiloto` tienen
--      desde la 0250 call sites reales que las preguntan (carta_porte_wa.ts y
--      /api/admin/copiloto): si el CHECK no las admitiera, apagar al agente
--      desde Observabilidad rebotaría con check_violation justo durante el
--      incidente para el que la palanca existe.
--
--  (b) LAS 58 DE ANTES SIGUEN ENTRANDO. La mitad que de verdad se escapa: el
--      CHECK se reescribe ENTERO (drop + add) y un id olvidado no da error —
--      lo borra del catálogo en silencio (el incidente que la 0227 corrigió).
--      Por eso se prueban los 60, uno por uno, contra la lista del espejo
--      INTERRUPTORES (interruptores.ts).
--
--  (c) UN ID INVENTADO SIGUE REBOTANDO. Si el dominio se hubiera quedado sin
--      CHECK, los 60 entrarían — y también cualquier basura.
--
-- El DO revierte con su excepción final: no queda ni una fila.
do $$
declare
  ids text[] := array[
    'global',
    'agente:liquidacion', 'agente:facturas', 'agente:cobranza',
    'agente:conductores', 'agente:peajes', 'agente:proveedores',
    'agente:ventas', 'agente:redactor',
    'agente:analista_metricas', 'agente:control_costos',
    'agente:tesoreria', 'agente:cierre_mensual',
    'agente:kpi_whatsapp', 'agente:desempeno_startup',
    'agente:orquestador', 'agente:orquestador_semanal',
    'agente:enriquecedor', 'agente:sdr', 'agente:enviador',
    'agente:soporte', 'agente:onboarding_cliente', 'agente:exito_cliente',
    'agente:atencion_faq', 'agente:cobranza_saas', 'agente:retencion',
    'agente:vigilante_calidad', 'agente:documentacion',
    'agente:legal_compliance', 'agente:talento',
    'agente:contenido_fiscal', 'agente:lead_magnet', 'agente:seo_distribucion',
    'agente:guiones', 'agente:noticias_mercado', 'agente:promos_diarias',
    'agente:visuales', 'agente:video_demo', 'agente:video_marketing',
    'agente:alianzas',
    'agente:descarga_sat',
    'agente:migraciones', 'agente:seguridad', 'agente:rendimiento',
    'agente:pruebas', 'agente:auditor_codigo', 'agente:releases',
    'agente:producto', 'agente:datos_instrumentacion',
    'agente:automejora', 'agente:especialistas_incidente', 'agente:fundraising',
    'agente:scorer', 'agente:dossier', 'agente:vigia',
    'agente:demo_prep', 'agente:propuestas', 'agente:cazador',
    'agente:carta_porte', 'agente:copiloto'
  ];
  k text;
  n_catalogo int;
  no_entraron text[] := '{}';
  faltantes text;
  invento_rebota boolean;
begin
  n_catalogo := array_length(ids, 1);

  -- (a)+(b) los 60, uno por uno: el CHECK se reescribe entero y un olvido no grita.
  foreach k in array ids loop
    begin
      insert into public.interruptor (id) values (k)
        on conflict (id) do nothing;
    exception when check_violation then
      no_entraron := no_entraron || k;
    end;
  end loop;
  faltantes := coalesce(array_to_string(no_entraron, ','), '');
  if faltantes = '' then faltantes := 'ninguno'; end if;

  -- (c) y la lista sigue siendo una lista.
  begin
    insert into public.interruptor (id) values ('agente:que_nadie_declaro');
    invento_rebota := false;
  exception when check_violation then
    invento_rebota := true;
  end;

  raise exception 'PALANCAS_0250  n_catalogo=%  faltantes=%  invento_rebota=%   (esperado 60 / ninguno / t)',
    n_catalogo, faltantes, invento_rebota;
end $$;

-- ── 205. La purga alcanza las tablas satélite de `prospecto` y no toca las del vivo (mig. 0258) ──
--
-- La 0245 auditó columna por columna la tabla `prospecto` y no miró las
-- satélite: `prospecto_correo` (1,414 filas de 852 prospectos fríos medidas
-- en producción, correo+nombre+puesto), las piezas de `cola_aprobacion` (el
-- borrador completo con el nombre de pila adentro), `prospecto_dossier`
-- (teléfonos y hallazgos con correos en `datos`) y `prospecto_toque` (prosa
-- libre en `resumen`). La 0258 las alcanza; aquí se comprueba con corrida
-- real que el frío pierde exactamente eso, que el prospecto VIVO conserva
-- todo, y que `mantenimiento_de_datos` reporta las cuatro llaves nuevas.
-- Todo revierte con el RAISE final. Esperado:
--   SATELITES_PURGA_0258  correos_frio_fuera=t  pieza_fria_fuera=t  dossier_frio_anonimo=t  empresa_dossier_viva=t  toque_frio_sin_prosa=t  vivo_intacto=t  llaves_nuevas=4
do $$
declare
  frio uuid; vivo uuid; res jsonb;
  correos_frio_fuera boolean; pieza_fria_fuera boolean; dossier_frio_anonimo boolean;
  empresa_dossier_viva boolean; toque_frio_sin_prosa boolean; vivo_intacto boolean;
  llaves_nuevas int;
begin
  insert into public.prospecto (empresa, estado, correo, created_at)
    values ('__verif_0258_frio__', 'contactado', 'frio@verif0258.test', now() - interval '400 days')
    returning id into frio;
  insert into public.prospecto (empresa, estado, correo, created_at)
    values ('__verif_0258_vivo__', 'contactado', 'vivo@verif0258.test', now() - interval '400 days')
    returning id into vivo;
  -- El vivo tuvo un toque hace 10 días; el frío, ninguno.
  insert into public.prospecto_contacto (prospecto_id, canal, direccion, resumen, ocurrio_en)
    values (vivo, 'correo', 'salida', '__verif_0258__', now() - interval '10 days');

  insert into public.prospecto_correo (prospecto_id, correo, contacto_nombre, puesto, fuente) values
    (frio, 'ramon.perez@verif0258.test', 'Ramón Pérez', 'Gerente de Tráfico', 'https://verif0258.test/equipo'),
    (frio, 'contacto@verif0258.test', null, null, 'https://verif0258.test'),
    (vivo, 'ana.lopez@verif0258.test', 'Ana López', 'Directora', 'https://verif0258.test/equipo');
  insert into public.cola_aprobacion (tipo, agente, prospecto_id, titulo, cuerpo) values
    ('correo_frio', 'enviador', frio, 'Correo a Ramón', 'Hola Ramón, ¿le vienen bien 15 minutos el jueves?'),
    ('correo_frio', 'enviador', vivo, 'Correo a Ana', 'Hola Ana, le escribo de Likida…');
  insert into public.prospecto_dossier (prospecto_id, historia, telefonos, datos) values
    (frio, 'Fundada en 1990, 40 unidades.', '["5215590000001"]'::jsonb,
     '[{"dato": "correo de tráfico: ramon.perez@verif0258.test", "fuente": "https://verif0258.test"}]'::jsonb),
    (vivo, 'Fundada en 2001.', '["5215590000002"]'::jsonb, '[]'::jsonb);
  insert into public.prospecto_toque (prospecto_id, canal, resumen, actor) values
    (frio, 'nota', 'Hablé con Ramón, pide llamar en marzo.', 'javier'),
    (vivo, 'nota', 'Ana pidió propuesta.', 'javier');

  res := public.mantenimiento_de_datos(30);

  select count(*) = 0 into correos_frio_fuera from public.prospecto_correo where prospecto_id = frio;
  select count(*) = 0 into pieza_fria_fuera from public.cola_aprobacion where prospecto_id = frio;
  select (telefonos is null and datos is null) into dossier_frio_anonimo
    from public.prospecto_dossier where prospecto_id = frio;
  select (historia = 'Fundada en 1990, 40 unidades.') into empresa_dossier_viva
    from public.prospecto_dossier where prospecto_id = frio;
  select (resumen is null) into toque_frio_sin_prosa from public.prospecto_toque where prospecto_id = frio;
  select ((select count(*) from public.prospecto_correo where prospecto_id = vivo) = 1
      and (select count(*) from public.cola_aprobacion where prospecto_id = vivo) = 1
      and (select telefonos is not null from public.prospecto_dossier where prospecto_id = vivo)
      and (select resumen is not null from public.prospecto_toque where prospecto_id = vivo)
      and (select correo is not null from public.prospecto where id = vivo))
    into vivo_intacto;
  llaves_nuevas := (case when res ? 'prospectoCorreosPurgados' then 1 else 0 end)
                 + (case when res ? 'prospectoPiezasPurgadas' then 1 else 0 end)
                 + (case when res ? 'prospectoDossiersAnonimizados' then 1 else 0 end)
                 + (case when res ? 'prospectoToquesAnonimizados' then 1 else 0 end);

  raise exception E'SATELITES_PURGA_0258  correos_frio_fuera=%  pieza_fria_fuera=%  dossier_frio_anonimo=%  empresa_dossier_viva=%  toque_frio_sin_prosa=%  vivo_intacto=%  llaves_nuevas=%   (esperado t/t/t/t/t/t/4)',
    correos_frio_fuera, pieza_fria_fuera, dossier_frio_anonimo, empresa_dossier_viva, toque_frio_sin_prosa, vivo_intacto, llaves_nuevas;
end $$;

-- ── 206. Ninguna tabla colgada de `prospecto` se escapa de la purga sin decisión escrita (estructural, mig. 0258) ──
--
-- La lección de tres pasadas (0148 miró una columna, 0191 miró cinco, 0245
-- miró una tabla): el error no fue nunca la tabla que se arregló, sino la
-- que nadie enumeró. Este bloque cierra la CLASE: barre `pg_constraint`
-- buscando toda FK que apunte a `prospecto` (menos el self-FK
-- `duplicado_de`) y exige que cada tabla satélite esté DECIDIDA — o su
-- nombre aparece en el fuente de `purgar_prospecto_persona` /
-- `purgar_comercial_evento` (la purga la conoce), o está en la lista de
-- exentas de abajo CON su razón escrita. Una tabla satélite nueva sin
-- decisión pone este bloque en rojo el mismo día que su migración.
--
-- LAS EXENTAS Y SUS RAZONES (mantener en sincronía con la 0258):
--   · prospecto_contacto — índice de la relación SIN datos de persona POR
--     DISEÑO (0118: «SIN el cuerpo completo ni datos personales de más»;
--     medido en producción: 0 resúmenes con '@') y es el INSUMO del filtro
--     de frialdad: purgarlo destruiría el instrumento que decide qué purgar.
--   · comercial_evento — ya la anonimiza `purgar_comercial_evento` (0245)
--     por EDAD del evento, con o sin prospecto_id (el payload de Cal.com
--     llega también huérfano); un segundo camino por frialdad solo taparía
--     al primero. Además su nombre SÍ se exige en el fuente de esa función.
--
-- Esperado:
--   SATELITES_ESTRUCTURAL_0258  sin_decidir=ninguna  exentas=2  ledger_cubierto=t
do $$
declare
  exentas text[] := array['prospecto_contacto', 'comercial_evento'];
  src_purga text; src_ledger text;
  t text; sin_decidir text[] := '{}'; faltantes text; ledger_cubierto boolean;
begin
  select p.prosrc into src_purga
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purgar_prospecto_persona';
  select p.prosrc into src_ledger
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purgar_comercial_evento';

  for t in
    select cl.relname
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
     where c.contype = 'f'
       and c.confrelid = 'public.prospecto'::regclass
       and c.conrelid <> c.confrelid
     group by cl.relname
     order by cl.relname
  loop
    if t = any(exentas) then
      continue;
    end if;
    if position(t in coalesce(src_purga, '')) = 0
       and position(t in coalesce(src_ledger, '')) = 0 then
      sin_decidir := sin_decidir || t;
    end if;
  end loop;

  faltantes := coalesce(array_to_string(sin_decidir, ','), '');
  if faltantes = '' then faltantes := 'ninguna'; end if;
  -- La exención de comercial_evento descansa en que la función del ledger
  -- exista Y la nombre; si alguien la vacía, la exención deja de valer.
  ledger_cubierto := position('comercial_evento' in coalesce(src_ledger, '')) > 0;

  raise exception E'SATELITES_ESTRUCTURAL_0258  sin_decidir=%  exentas=%  ledger_cubierto=%   (esperado ninguna / 2 / t)',
    faltantes, cardinality(exentas), ledger_cubierto;
end $$;

-- ── 207. Los secretos OAuth del MCP no se pueden guardar en claro, y un código solo se canjea una vez (mig. 0260) ──
--
-- Lo que SOLO la base puede demostrar de la 0260 — el código de la app ya
-- promete hashear y marcar usado con condición; aquí se prueba que la BASE
-- lo exige aunque el código de la app se equivoque:
--
--  (a) EL CHECK DE 64 HEX RECHAZA UN SECRETO EN CLARO. Un token real empieza
--      con `lk_mcp_at_` y no tiene la forma de un SHA-256: si alguien
--      intentara guardarlo entero (el bug clásico de "ya luego lo hasheo"),
--      el insert truena en vez de dejar la credencial legible en la tabla.
--      Se prueba en las DOS tablas con hash (código y token).
--
--  (b) EL DOMINIO DE `tipo` ES CERRADO. Un token que no sea acceso/refresco
--      no existe: `eterno` rebota con check_violation.
--
--  (c) EL CANDADO DEL CANJE ÚNICO VIVE EN LA BASE. El canje marca `usado_en`
--      con `update … where usado_en is null`: el primer update toca UNA
--      fila y el segundo (el código robado que se canjea otra vez, o la
--      carrera de dos canjes simultáneos) toca CERO. Si una migración
--      futura le quitara la columna o un trigger la rellenara solo, esta
--      cuenta cambiaría.
--
-- El DO revierte con su excepción final: no queda ni cliente, ni código, ni
-- fila alguna.
do $$
declare
  t uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
  cli uuid;
  cod uuid;
  claro_rebota_codigo boolean := false;
  claro_rebota_token boolean := false;
  tipo_rebota boolean := false;
  primer_canje int;
  segundo_canje int;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0260__');
  insert into public.app_user (id, email, rol, tenant_id)
    values (u, '__verif_0260__@likida.ai', 'contador', t);
  insert into public.mcp_oauth_cliente (nombre, redirect_uris)
    values ('__verif_0260__', '["https://claude.ai/api/mcp/auth_callback"]'::jsonb)
    returning id into cli;

  -- (a) el secreto en claro no entra: ni como código…
  begin
    insert into public.mcp_oauth_codigo
      (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en)
    values
      ('lk_mcp_ac_secreto-en-claro-que-alguien-olvido-hashear', cli, u, t, 'contador',
       'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '5 min');
  exception when check_violation then
    claro_rebota_codigo := true;
  end;
  -- …ni como token.
  begin
    insert into public.mcp_oauth_token
      (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values
      ('lk_mcp_at_secreto-en-claro-que-alguien-olvido-hashear', 'acceso', cli, u, t, 'contador',
       gen_random_uuid(), now() + interval '8 hours');
  exception when check_violation then
    claro_rebota_token := true;
  end;

  -- (b) el dominio de tipo es cerrado.
  begin
    insert into public.mcp_oauth_token
      (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values
      (repeat('a', 64), 'eterno', cli, u, t, 'contador', gen_random_uuid(), now() + interval '8 hours');
  exception when check_violation then
    tipo_rebota := true;
  end;

  -- (c) el canje único: un código bien hasheado, dos intentos de marcarlo.
  insert into public.mcp_oauth_codigo
    (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en)
  values
    (repeat('b', 64), cli, u, t, 'contador',
     'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '5 min')
  returning id into cod;

  update public.mcp_oauth_codigo set usado_en = now() where id = cod and usado_en is null;
  get diagnostics primer_canje = row_count;
  update public.mcp_oauth_codigo set usado_en = now() where id = cod and usado_en is null;
  get diagnostics segundo_canje = row_count;

  raise exception 'MCP_OAUTH_0260  claro_rebota_codigo=%  claro_rebota_token=%  tipo_rebota=%  primer_canje=%  segundo_canje=%   (esperado t / t / t / 1 / 0)',
    claro_rebota_codigo, claro_rebota_token, tipo_rebota, primer_canje, segundo_canje;
end $$;

-- ── 208. producto_evento se consolida al cerrar el mes, purga su detalle y el lector no ve encoger nada (mig. 0259) ──
--
-- (Nació 205 en su rama y se renumeró a 207 al fusionar con la 0258, que tomó
-- el 205 y el 206; y otra vez a 208 al fusionar con el 207 del MCP — la
-- numeración es de lectura, no de ejecución, como ya pasó dos veces con el 201.)
--
-- La 0251 dejó `uso_producto_mensual()` agrupando la tabla ENTERA sin rango
-- (cada visita a /admin/crecimiento, force-dynamic, un escaneo completo) y
-- `producto_evento` sin purga: millones de filas al año con 200 flotas. La
-- 0259 aplica el patrón de llm_costo (0072/0155): consolidado mensual +
-- purga del detalle, consolidar ANTES de purgar y en la misma función.
--
-- Lo que se fija con corrida real:
--   · el mes cerrado queda en el consolidado con su conteo exacto;
--   · el detalle viejo muere y el del mes en curso vive;
--   · el lector devuelve los DOS meses con las cifras correctas (cerrado
--     desde el consolidado, en curso desde el detalle) — mismo nombre, misma
--     firma que la 0251;
--   · repetir el mantenimiento tras la purga NO encoge el mes consolidado
--     (`do nothing`: el snapshot del cierre es inmutable — un `do update`
--     re-agregaría desde un detalle ya parcial);
--   · el piso de 62 días rebota (PU001): purgar antes de consolidar sería
--     borrar sin snapshot;
--   · `anon` no ejecuta el mantenimiento.
-- Todo revierte con el RAISE final. Esperado:
--   PRODUCTO_MENSUAL_0259  consolidado=t  detalle_viejo_fuera=t  detalle_vivo=t  lector_dos_meses=t  no_encoge=t  piso_rebota=t  anon=f
do $$
declare
  t uuid; res jsonb; res2 jsonb;
  -- Día 10 de hace CUATRO meses (local MX): siempre a más de 92 días de hoy
  -- (mínimo ~107) y nunca pegado a una frontera de mes — la siembra no puede
  -- volverse intermitente por la hora a la que corra el CI.
  mes_viejo date := (date_trunc('month', now() at time zone 'America/Mexico_City') - interval '4 months')::date;
  viejo_ts timestamptz := ((date_trunc('month', now() at time zone 'America/Mexico_City')
                            - interval '4 months' + interval '10 days') at time zone 'America/Mexico_City');
  mes_actual date := date_trunc('month', now() at time zone 'America/Mexico_City')::date;
  consolidado boolean; detalle_viejo_fuera boolean; detalle_vivo boolean;
  lector_dos_meses boolean; no_encoge boolean; piso_rebota boolean := false; anon_ok boolean;
begin
  -- Esta fixture representa el primer rollover. Aislar el singleton permite
  -- repetirla aun si otra prueba ya consolidó el mes; todo revierte al final.
  update public.producto_evento_estado set detalle_desde=null;
  insert into public.tenant (nombre) values ('__verif_0259__') returning id into t;
  insert into public.producto_evento (tenant_id, pantalla, accion, created_at) values
    (t, 'resumen', 'pageview', viejo_ts),
    (t, 'viajes',  'pageview', viejo_ts + interval '1 hour'),
    (t, 'resumen', 'pageview', viejo_ts + interval '2 hours'),
    (t, 'resumen', 'pageview', now()),
    (t, 'viajes',  'pageview', now());

  res := public.mantener_producto_evento(92, now());

  select (eventos = 3) into consolidado
    from public.producto_evento_mensual where tenant_id = t and mes = mes_viejo;
  select count(*) = 2 into detalle_viejo_fuera
    from public.producto_evento where tenant_id = t;
  select count(*) = 2 into detalle_vivo
    from public.producto_evento where tenant_id = t and created_at >= now() - interval '1 day';
  select count(*) = 2
     and count(*) filter (where u.mes = mes_viejo and u.eventos = 3) = 1
     and count(*) filter (where u.mes = mes_actual and u.eventos = 2) = 1
    into lector_dos_meses
    from public.uso_producto_mensual() u where u.tenant_id = t;

  -- Repetir tras la purga: el consolidado NO se reescribe desde el detalle
  -- (ya parcial: las filas del mes viejo murieron).
  res2 := public.mantener_producto_evento(92, now());
  select (eventos = 3) into no_encoge
    from public.producto_evento_mensual where tenant_id = t and mes = mes_viejo;

  begin
    perform public.mantener_producto_evento(30, now());
  exception when sqlstate 'PU001' then piso_rebota := true;
  end;

  select has_function_privilege('anon', 'public.mantener_producto_evento(integer, timestamptz, timestamptz)', 'EXECUTE') into anon_ok;

  raise exception E'PRODUCTO_MENSUAL_0259  consolidado=%  detalle_viejo_fuera=%  detalle_vivo=%  lector_dos_meses=%  no_encoge=%  piso_rebota=%  anon=%   (esperado t/t/t/t/t/t/f)',
    coalesce(consolidado, false), detalle_viejo_fuera, detalle_vivo,
    coalesce(lector_dos_meses, false), coalesce(no_encoge, false), piso_rebota, anon_ok;
end $$;

-- ── 209. La llave de idempotencia del examen del contador (mig. 0254) ──
-- El banco dorado se sincroniza por upsert sobre (agente, clave): la columna
-- existe, el índice único rechaza el duplicado con clave, y los casos del
-- analista (clave null) siguen conviviendo — NULLS DISTINCT, no un candado
-- accidental sobre lo sembrado en 0134.
do $$
declare
  col_existe boolean;
  duplicado_rebota boolean;
  nulls_conviven boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'eval_caso' and column_name = 'clave'
  ) into col_existe;

  -- (a) dos casos del contador con la MISMA clave: el segundo rebota.
  insert into public.eval_caso (agente, pregunta, espera, tipo, clave)
    values ('contador_v205', 'p1', 'e1', 'factica', 'Q1');
  begin
    insert into public.eval_caso (agente, pregunta, espera, tipo, clave)
      values ('contador_v205', 'p2', 'e2', 'factica', 'Q1');
    duplicado_rebota := false;
  exception when unique_violation then
    duplicado_rebota := true;
  end;

  -- (b) dos casos SIN clave del mismo agente conviven (los del analista, 0134).
  begin
    insert into public.eval_caso (agente, pregunta, espera, tipo)
      values ('contador_v205', 'p3', 'e3', 'factica'), ('contador_v205', 'p4', 'e4', 'factica');
    nulls_conviven := true;
  exception when unique_violation then
    nulls_conviven := false;
  end;

  raise exception 'EXAMEN_CONTADOR_0254  col_existe=%  duplicado_rebota=%  nulls_conviven=%   (esperado t / t / t)',
    col_existe, duplicado_rebota, nulls_conviven;
end $$;

-- ── 211. Ligar un CFDI a un gasto es ATÓMICO: un fallo a medio camino no deja la cuña sin salida (mig. 0263, auditoría E.28 C-1) ──
-- (Nació 210 en su rama; renumerado a 211 al fusionar con el 210 de la 0262
-- de LEG-C2, que reclamó el mismo número desde otra rama — mismo patrón que
-- ya le pasó al 201 y al 207 esta noche.)
--
-- `ligarComprobante` hacía DOS escrituras sueltas desde TypeScript —primero
-- el gasto, después el comprobante—, con el expediente escrito después de
-- las dos como mejor esfuerzo. Los fallos EN BANDA se compensaban soltando
-- el gasto por su folio, pero una MUERTE DEL PROCESO entre las dos
-- escrituras no pasaba por ningún `catch`: el gasto quedaba afirmando estar
-- facturado (`cfdi_uuid` + `xml_verificado=true`) con el CFDI todavía
-- 'disponible' del otro lado, y esa cuña NO TENÍA SALIDA desde la interfaz
-- (re-ligar el mismo gasto rebotaba con `gasto_ya_tiene_cfdi`, ligar a otro
-- violaba `uq_gasto_cfdi_uuid` de la 0065, revertir decía
-- `nada_que_revertir`).
--
-- `sat_cfdi_ligar_tx` mueve las dos escrituras Y el expediente a una sola
-- función de Postgres. Aquí se prueba con un fallo INYECTADO —un CHECK
-- temporal que solo dispara para la fila de la prueba (`total = 999999`,
-- para no estorbar el camino bueno de arriba), y que revienta justo en la
-- SEGUNDA escritura, después de que la primera (el gasto) ya corrió dentro
-- de la misma llamada— que Postgres deshace también la escritura del gasto:
-- no queda «a medias» que reparar a mano. Se prueba además el camino bueno
-- (las dos escrituras, el expediente y el valor de retorno juntos), el
-- ancla optimista (`p_estatus_esperado`, que decide la carrera igual que el
-- `.eq('estatus', …)` que reemplaza) y que solo `service_role` ejecuta el
-- RPC.
do $$
declare
  v_t uuid; v_o uuid; v_v uuid; v_g uuid; v_a uuid; v_cfdi uuid;
  res jsonb;
  exito_gasto boolean; exito_cfdi boolean; exito_expediente boolean; retorno_ok boolean;
  carrera_rebota boolean := false;
  falla_sqlstate text := '';
  gasto_intacto boolean; cfdi_intacto boolean; expediente_vacio boolean;
  anon_ok boolean; auth_ok boolean;
begin
  insert into tenant (nombre) values ('ZZZ VERIF LIGAR TX') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P', '520000009210') returning id into v_o;
  insert into app_user (id, email, rol, tenant_id) values (gen_random_uuid(), '__verif_210__@likida.ai', 'contador', v_t) returning id into v_a;
  insert into viaje (tenant_id, operador_id) values (v_t, v_o) returning id into v_v;

  -- ── (a) EL CAMINO BUENO: las dos escrituras, el expediente y el retorno ──
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'diesel', 300) returning id into v_g;
  insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus, total)
    values (v_t, lower(gen_random_uuid()::text), 'disponible', 300) returning id into v_cfdi;

  res := public.sat_cfdi_ligar_tx(v_t, v_cfdi, v_g, 'disponible', '{}'::jsonb, v_a, 'contralor@verif.test');
  retorno_ok := (res ->> 'gasto_id') = v_g::text;

  select (cfdi_uuid is not null and xml_verificado is true and cfdi_orden = 1) into exito_gasto
    from gasto where id = v_g;
  select (estatus = 'casado' and gasto_id = v_g) into exito_cfdi
    from sat_cfdi_descargado where id = v_cfdi;
  select count(*) = 1 into exito_expediente
    from sat_cfdi_resolucion where cfdi_id = v_cfdi and acto = 'ligado' and gasto_id = v_g;

  -- ── (b) EL ANCLA OPTIMISTA: contra el estatus que YA NO es, rebota CU014 ─
  begin
    perform public.sat_cfdi_ligar_tx(v_t, v_cfdi, v_g, 'disponible', '{}'::jsonb, v_a, 'contralor@verif.test');
  exception when others then carrera_rebota := (sqlstate = 'CU014');
  end;

  -- ── (c) EL FALLO A MEDIO CAMINO: un CHECK que solo dispara para ESTA fila ─
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'caseta', 200) returning id into v_g;
  insert into sat_cfdi_descargado (tenant_id, cfdi_uuid, estatus, total)
    values (v_t, lower(gen_random_uuid()::text), 'disponible', 999999) returning id into v_cfdi;

  execute 'alter table public.sat_cfdi_descargado add constraint __verif_210_falla_a_medias
             check (not (total = 999999 and estatus = ''casado''))';

  begin
    perform public.sat_cfdi_ligar_tx(v_t, v_cfdi, v_g, 'disponible', '{}'::jsonb, v_a, 'contralor@verif.test');
  exception when others then falla_sqlstate := sqlstate;
  end;

  -- Si la transacción NO hubiera revertido el UPDATE del gasto —que corrió
  -- PRIMERO, dentro de la misma llamada, antes de que el CHECK reventara en
  -- la segunda escritura— aquí quedaría con el folio pegado y CERO renglones
  -- de expediente que lo expliquen: exactamente la cuña que encontró el
  -- auditor.
  select (cfdi_uuid is null and xml_verificado is null) into gasto_intacto from gasto where id = v_g;
  select (estatus = 'disponible' and gasto_id is null) into cfdi_intacto from sat_cfdi_descargado where id = v_cfdi;
  select count(*) = 0 into expediente_vacio from sat_cfdi_resolucion where cfdi_id = v_cfdi;

  select has_function_privilege('anon', 'public.sat_cfdi_ligar_tx(uuid,uuid,uuid,text,jsonb,uuid,text)', 'EXECUTE') into anon_ok;
  select has_function_privilege('authenticated', 'public.sat_cfdi_ligar_tx(uuid,uuid,uuid,text,jsonb,uuid,text)', 'EXECUTE') into auth_ok;

  raise exception E'LIGAR_TX_0263  gasto_ok=%  cfdi_ok=%  expediente_ok=%  retorno_ok=%  carrera_rebota=%  falla_sqlstate=%  gasto_intacto=%  cfdi_intacto=%  expediente_vacio=%  anon=%  auth=%   (esperado t/t/t/t/t/23514/t/t/t/f/f)',
    coalesce(exito_gasto,false), coalesce(exito_cfdi,false), coalesce(exito_expediente,false), coalesce(retorno_ok,false),
    carrera_rebota, falla_sqlstate, coalesce(gasto_intacto,false), coalesce(cfdi_intacto,false),
    coalesce(expediente_vacio,false), anon_ok, auth_ok;
end $$;

-- ── 212. La identidad congelada de un token MCP deja de ser válida el instante en que app_user cambia (mig. 0265, HALLAZGO 1) ──
--
-- Esto es lo que un test de TypeScript con Supabase mockeado NO puede
-- demostrar: que la GARANTÍA vive en la base, contra una fila REAL de
-- `app_user` que cambia entre el momento en que el token nació y el momento
-- en que se intenta refrescar. `refrescarTokens` llama exactamente esta RPC
-- antes de rotar (oauth.ts) — aquí se prueba la RPC misma, con Postgres de
-- verdad, no con un mock que solo probaría que el mock contesta lo que se le
-- programó.
--
--  (a) Recién consentido: usuario vigente en su tenant y su rol → true.
--  (b) El ADMIN LE CAMBIA EL ROL (el escenario exacto del hallazgo: "un
--      contador... el admin le cambia el rol... sin borrar la fila de
--      app_user") → la MISMA pregunta con el rol viejo ahora contesta false.
--  (c) Lo mueven a OTRO tenant (incluida la variante que el hallazgo llama
--      "lo desvincula") → false con el tenant viejo.
--  (d) Restaurado a su tenant y rol originales → vuelve a true: no es un
--      candado de una sola vez, es el estado ACTUAL en cada llamada.
--  (e) La fila de `app_user` ya no existe → false (y, aparte, el FK cascade
--      de mcp_oauth_token.user_id ya habría borrado el token solo; esta rama
--      cubre el caso en que la RPC se llama con un user_id que nunca fue, o
--      cuya fila se borró por otro camino).
--
--  (f) `revocar_mcp_oauth_usuario`: tumba TODOS los tokens activos de un
--      usuario en su tenant de un tiro, deja intacto el de OTRO usuario de
--      la misma flota, y una segunda llamada no vuelve a tocar lo ya
--      revocado (idempotente por el propio `where revocado_en is null`).
do $$
declare
  t uuid := gen_random_uuid();
  t_otro uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
  u_otro uuid := gen_random_uuid();
  cli uuid;
  tok_a uuid; tok_r uuid; tok_otro uuid;
  vigente_inicial boolean;
  vigente_tras_rol boolean;
  vigente_tras_tenant boolean;
  vigente_restaurado boolean;
  vigente_usuario_borrado boolean;
  revocados_primera bigint;
  revocados_segunda bigint;
  otro_token_intacto boolean;
  ambos_revocados boolean;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0265_a__');
  insert into public.tenant (id, nombre) values (t_otro, '__verif_0265_b__');
  insert into public.app_user (id, email, rol, tenant_id) values (u, '__verif_0265_u__@likida.ai', 'contador', t);
  insert into public.app_user (id, email, rol, tenant_id) values (u_otro, '__verif_0265_v__@likida.ai', 'contador', t);
  insert into public.mcp_oauth_cliente (nombre, redirect_uris)
    values ('__verif_0265__', '["https://claude.ai/api/mcp/auth_callback"]'::jsonb)
    returning id into cli;

  -- (a) recién consentido: la identidad congelada (tenant=t, rol=contador)
  -- es exactamente la actual.
  select public.mcp_oauth_usuario_vigente(u, t, 'contador') into vigente_inicial;

  -- (b) EL ESCENARIO DEL HALLAZGO: el admin cambia el rol sin borrar la fila.
  update public.app_user set rol = 'encargado' where id = u;
  select public.mcp_oauth_usuario_vigente(u, t, 'contador') into vigente_tras_rol;

  -- (c) lo mueven a otro tenant (con el rol ya restaurado, para aislar la variable).
  update public.app_user set rol = 'contador', tenant_id = t_otro where id = u;
  select public.mcp_oauth_usuario_vigente(u, t, 'contador') into vigente_tras_tenant;

  -- (d) restaurado del todo: no es un candado de un solo uso.
  update public.app_user set tenant_id = t where id = u;
  select public.mcp_oauth_usuario_vigente(u, t, 'contador') into vigente_restaurado;

  -- (e) la fila ya no existe.
  select public.mcp_oauth_usuario_vigente(gen_random_uuid(), t, 'contador') into vigente_usuario_borrado;

  -- (f) revocar_mcp_oauth_usuario: dos tokens activos de `u` en `t`, uno de
  -- `u_otro` en el mismo tenant.
  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('1', 64), 'acceso', cli, u, t, 'contador', gen_random_uuid(), now() + interval '8 hours')
    returning id into tok_a;
  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('2', 64), 'refresco', cli, u, t, 'contador', gen_random_uuid(), now() + interval '60 days')
    returning id into tok_r;
  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('3', 64), 'acceso', cli, u_otro, t, 'contador', gen_random_uuid(), now() + interval '8 hours')
    returning id into tok_otro;

  select public.revocar_mcp_oauth_usuario(t, u) into revocados_primera;
  select (revocado_en is null) into otro_token_intacto from public.mcp_oauth_token where id = tok_otro;
  select bool_and(revocado_en is not null) into ambos_revocados
    from public.mcp_oauth_token where id in (tok_a, tok_r);
  -- Segunda llamada: ya no hay nada activo que tocar (idempotente).
  select public.revocar_mcp_oauth_usuario(t, u) into revocados_segunda;

  raise exception 'MCP_OAUTH_VIGENCIA_0265  inicial=%  tras_rol=%  tras_tenant=%  restaurado=%  usuario_borrado=%  revocados_1=%  revocados_2=%  otro_intacto=%  ambos_revocados=%   (esperado t / f / f / t / f / 2 / 0 / t / t)',
    vigente_inicial, vigente_tras_rol, vigente_tras_tenant, vigente_restaurado, vigente_usuario_borrado,
    revocados_primera, revocados_segunda, otro_token_intacto, ambos_revocados;
end $$;

-- ── 213. `mantener_mcp_oauth` purga tokens revocados/expirados, códigos muertos y clientes DCR que nunca completaron un login — y nada más (mig. 0265, HALLAZGO 3) ──
--
-- Mismo criterio que el bloque 208 (`mantener_producto_evento`, 0259): lo
-- que solo Postgres puede demostrar es que el DELETE se detiene exactamente
-- donde debe. Un cliente DCR SÍ usado (con un token, aunque ya expirado) NO
-- se borra por su antigüedad — perdería la trazabilidad de qué cliente
-- consintió qué, que es justo el dato que la 0260 nació para guardar.
do $$
declare
  t uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
  cli_vivo uuid; cli_muerto uuid; cli_joven uuid;
  tok_vivo uuid; tok_revocado_viejo uuid; tok_revocado_reciente uuid; tok_expirado_viejo uuid;
  cod_viejo uuid; cod_reciente uuid;
  piso_rebota boolean := false;
  r jsonb;
  vivo_token_sigue boolean;
  revocado_viejo_se_fue boolean;
  revocado_reciente_sigue boolean;
  expirado_viejo_se_fue boolean;
  cliente_vivo_sigue boolean;
  cliente_muerto_se_fue boolean;
  cliente_joven_sigue boolean;
  codigo_viejo_se_fue boolean;
  codigo_reciente_sigue boolean;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0265_purga__');
  insert into public.app_user (id, email, rol, tenant_id) values (u, '__verif_0265_purga__@likida.ai', 'contador', t);

  -- El piso (PU001): 29 días rebota, sin tocar nada.
  begin
    perform public.mantener_mcp_oauth(29);
  exception when others then piso_rebota := (sqlstate = 'PU001');
  end;

  -- Un cliente que SÍ produjo un token (aunque el token ya haya muerto):
  -- nunca se borra por antigüedad — tiene historia que contar.
  insert into public.mcp_oauth_cliente (id, nombre, redirect_uris, creado_en)
    values (gen_random_uuid(), '__cliente_vivo__', '["https://claude.ai/api/mcp/auth_callback"]'::jsonb, now() - interval '200 days')
    returning id into cli_vivo;
  -- Un cliente que JAMÁS produjo un token, viejo: el escenario del hallazgo
  -- (DCR abierto, un escáner que se registra y se va).
  insert into public.mcp_oauth_cliente (id, nombre, redirect_uris, creado_en)
    values (gen_random_uuid(), '__cliente_muerto__', '["https://claude.ai/api/mcp/auth_callback"]'::jsonb, now() - interval '200 days')
    returning id into cli_muerto;
  -- Un cliente sin token pero RECIÉN registrado: todavía puede estar a
  -- mitad del primer login — no se toca.
  insert into public.mcp_oauth_cliente (id, nombre, redirect_uris, creado_en)
    values (gen_random_uuid(), '__cliente_joven__', '["https://claude.ai/api/mcp/auth_callback"]'::jsonb, now())
    returning id into cli_joven;

  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en, revocado_en)
    values (repeat('4', 64), 'acceso', cli_vivo, u, t, 'contador', gen_random_uuid(), now() + interval '8 hours', null)
    returning id into tok_vivo;
  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en, revocado_en)
    values (repeat('5', 64), 'refresco', cli_vivo, u, t, 'contador', gen_random_uuid(), now() + interval '60 days', now() - interval '100 days')
    returning id into tok_revocado_viejo;
  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en, revocado_en)
    values (repeat('6', 64), 'refresco', cli_vivo, u, t, 'contador', gen_random_uuid(), now() + interval '60 days', now() - interval '1 day')
    returning id into tok_revocado_reciente;
  insert into public.mcp_oauth_token (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en, revocado_en)
    values (repeat('7', 64), 'acceso', cli_vivo, u, t, 'contador', gen_random_uuid(), now() - interval '100 days', null)
    returning id into tok_expirado_viejo;

  insert into public.mcp_oauth_codigo (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en, usado_en, creado_en)
    values (repeat('a', 64), cli_vivo, u, t, 'contador', 'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() - interval '10 days', now() - interval '10 days', now() - interval '10 days')
    returning id into cod_viejo;
  insert into public.mcp_oauth_codigo (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en, usado_en, creado_en)
    values (repeat('b', 64), cli_vivo, u, t, 'contador', 'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '3 min', null, now())
    returning id into cod_reciente;

  r := public.mantener_mcp_oauth(30);

  select exists(select 1 from public.mcp_oauth_token where id = tok_vivo) into vivo_token_sigue;
  select not exists(select 1 from public.mcp_oauth_token where id = tok_revocado_viejo) into revocado_viejo_se_fue;
  select exists(select 1 from public.mcp_oauth_token where id = tok_revocado_reciente) into revocado_reciente_sigue;
  select not exists(select 1 from public.mcp_oauth_token where id = tok_expirado_viejo) into expirado_viejo_se_fue;
  select exists(select 1 from public.mcp_oauth_cliente where id = cli_vivo) into cliente_vivo_sigue;
  select not exists(select 1 from public.mcp_oauth_cliente where id = cli_muerto) into cliente_muerto_se_fue;
  select exists(select 1 from public.mcp_oauth_cliente where id = cli_joven) into cliente_joven_sigue;
  select not exists(select 1 from public.mcp_oauth_codigo where id = cod_viejo) into codigo_viejo_se_fue;
  select exists(select 1 from public.mcp_oauth_codigo where id = cod_reciente) into codigo_reciente_sigue;

  raise exception 'MANTENER_MCP_OAUTH_0265  piso_rebota=%  vivo=%  rev_viejo_fue=%  rev_reciente=%  exp_viejo_fue=%  cli_vivo=%  cli_muerto_fue=%  cli_joven=%  cod_viejo_fue=%  cod_reciente=%  borrados=%   (esperado t/t/t/t/t/t/t/t/t/t/{3 tokens,1 codigo,1 cliente})',
    piso_rebota, vivo_token_sigue, revocado_viejo_se_fue, revocado_reciente_sigue, expirado_viejo_se_fue,
    cliente_vivo_sigue, cliente_muerto_se_fue, cliente_joven_sigue, codigo_viejo_se_fue, codigo_reciente_sigue, r;
end $$;

-- ── 214. El estudio de marketing: banco de hooks y personajes/lugares, deny-all con su dominio cerrado (mig. 0266) ──
--
-- Lo que solo la base puede demostrar: las dos tablas nuevas (marketing_hook,
-- marketing_referencia) quedan CERRADAS a anon/authenticated y abiertas solo
-- a service_role (mismo doble candado que aliado_objetivo, bloque 185), sus
-- CHECK de "no vacío" rebotan una fila vacía en vez de guardar un hook o una
-- referencia sin contenido, el dominio de `tipo` es cerrado (personaje/lugar,
-- nada más), y los dos buckets nuevos (marketing_hooks_video,
-- marketing_referencias) nacen PRIVADOS — un video o una foto de referencia
-- interna servida en un bucket público sería indexable por cualquiera que
-- adivine la ruta (mismo criterio que `comprobantes`, 0039).
do $$
declare
  hook_id uuid;
  hook_creado boolean;
  hook_vacio_rebota boolean;
  ruta_vacia_rebota boolean;
  ref_id uuid;
  ref_creado boolean;
  ref_nombre_vacio_rebota boolean;
  ref_foto_vacia_rebota boolean;
  tipo_inventado_rebota boolean;
  hook_cerrado boolean;
  referencia_cerrado boolean;
  bucket_hooks_privado boolean;
  bucket_referencias_privado boolean;
begin
  -- El hook normal entra.
  insert into public.marketing_hook (video_ruta, hook_texto)
    values ('verif/0266/video.mp4', 'la pregunta llega igual en todas las flotas')
    returning id into hook_id;
  hook_creado := hook_id is not null;

  -- Un hook sin texto (solo espacios) rebota.
  begin
    insert into public.marketing_hook (video_ruta, hook_texto) values ('verif/0266/otro.mp4', '   ');
    hook_vacio_rebota := false;
  exception when check_violation then
    hook_vacio_rebota := true;
  end;

  -- Una ruta vacía también rebota.
  begin
    insert into public.marketing_hook (video_ruta, hook_texto) values ('   ', 'algo');
    ruta_vacia_rebota := false;
  exception when check_violation then
    ruta_vacia_rebota := true;
  end;

  -- La referencia normal entra.
  insert into public.marketing_referencia (tipo, nombre, foto_ruta)
    values ('personaje', 'Chofer Ramon', 'verif/0266/ramon.jpg')
    returning id into ref_id;
  ref_creado := ref_id is not null;

  -- Un nombre vacío rebota.
  begin
    insert into public.marketing_referencia (tipo, nombre, foto_ruta) values ('lugar', '   ', 'verif/0266/x.jpg');
    ref_nombre_vacio_rebota := false;
  exception when check_violation then
    ref_nombre_vacio_rebota := true;
  end;

  -- Una foto vacía rebota.
  begin
    insert into public.marketing_referencia (tipo, nombre, foto_ruta) values ('lugar', 'Patio norte', '   ');
    ref_foto_vacia_rebota := false;
  exception when check_violation then
    ref_foto_vacia_rebota := true;
  end;

  -- El dominio de tipo es cerrado: ni un tercer valor entra.
  begin
    insert into public.marketing_referencia (tipo, nombre, foto_ruta) values ('vehiculo', 'x', 'verif/0266/y.jpg');
    tipo_inventado_rebota := false;
  exception when check_violation then
    tipo_inventado_rebota := true;
  end;

  -- El doble candado de las dos tablas.
  hook_cerrado := not has_table_privilege('anon', 'public.marketing_hook', 'SELECT')
    and not has_table_privilege('authenticated', 'public.marketing_hook', 'SELECT')
    and has_table_privilege('service_role', 'public.marketing_hook', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.marketing_hook'::regclass);
  referencia_cerrado := not has_table_privilege('anon', 'public.marketing_referencia', 'SELECT')
    and not has_table_privilege('authenticated', 'public.marketing_referencia', 'SELECT')
    and has_table_privilege('service_role', 'public.marketing_referencia', 'SELECT')
    and (select relrowsecurity from pg_class where oid = 'public.marketing_referencia'::regclass);

  -- Los dos buckets nacen privados.
  select public = false into bucket_hooks_privado
    from storage.buckets where id = 'marketing_hooks_video';
  select public = false into bucket_referencias_privado
    from storage.buckets where id = 'marketing_referencias';

  raise exception 'ESTUDIO_MARKETING_0266  hook_creado=%  hook_vacio_rebota=%  ruta_vacia_rebota=%  ref_creado=%  ref_nombre_vacio_rebota=%  ref_foto_vacia_rebota=%  tipo_inventado_rebota=%  hook_cerrado=%  referencia_cerrado=%  bucket_hooks_privado=%  bucket_referencias_privado=%   (esperado t / t / t / t / t / t / t / t / t / t / t)',
    hook_creado, hook_vacio_rebota, ruta_vacia_rebota, ref_creado, ref_nombre_vacio_rebota, ref_foto_vacia_rebota,
    tipo_inventado_rebota, hook_cerrado, referencia_cerrado, bucket_hooks_privado, bucket_referencias_privado;
end $$;

-- ── 215. `agente_insumo` es deny-all: ningún `authenticated` —dueño de la fila o no— la lee ni la escribe (mig. 0267) ──
--
-- La bandeja de contexto universal (Fase D, plan-de-cierre.md): RLS activa,
-- CERO policies, y REVOKE ALL de `public, anon, authenticated` — mismo
-- patrón que `agente_definicion` (0116) y `mcp_oauth_*` (0260). No es solo
-- RLS: la tabla ni siquiera tiene el GRANT (mismo caso que el bloque 153,
-- QA_PANEL_0185), así que el intento rebota en el PRIVILEGIO antes de que
-- RLS entre a evaluar — el candado más fuerte que existe, y por eso el
-- `esperado` de las lecturas es `-1` ("denegado por privilegio"), no `0`
-- ("RLS me deja a ciegas").
--
-- Se impersonan DOS sesiones (mismo mecanismo del bloque 27): un app_user de
-- la flota DUEÑA de un insumo con `tenant_id` (el caso reservado para el día
-- que un agente de producto reciba un insumo de una flota concreta — hoy
-- casi todo insumo nace con `tenant_id` NULL, ver la cabecera de la 0267) y
-- un app_user de OTRA flota. Las DOS quedan ciegas exactamente igual: el
-- candado no depende de a quién pertenezca la fila, que es la demostración
-- de aislamiento que esta migración pide — ni siquiera el dueño legítimo
-- entra por el camino de sesión de navegador; el único camino es el
-- `service_role` del servidor, filtrando `tenant_id` a mano (capa 2).
do $$
declare
  v_agente text := 'control_costos';
  t_propio uuid := gen_random_uuid();
  t_ajeno uuid := gen_random_uuid();
  u_propio uuid := gen_random_uuid();
  u_ajeno uuid := gen_random_uuid();
  n_propio int;
  n_ajeno int;
  n_sin_rls int;
  escribe_propio boolean;
  escribe_ajeno boolean;
begin
  insert into public.tenant (id, nombre) values (t_propio, '__verif_0267_propio__');
  insert into public.tenant (id, nombre) values (t_ajeno, '__verif_0267_ajeno__');
  insert into public.app_user (id, email, rol, tenant_id) values (u_propio, '__verif_0267_u1__@likida.ai', 'flota_admin', t_propio);
  insert into public.app_user (id, email, rol, tenant_id) values (u_ajeno, '__verif_0267_u2__@likida.ai', 'flota_admin', t_ajeno);

  -- Un insumo de PLATAFORMA (tenant_id null, el caso normal de hoy) y uno
  -- hipotético atado a t_propio — las dos formas a la vez.
  insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
    values (v_agente, null, 'texto', '__verif plataforma__', 'idea de plataforma', u_propio);
  insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
    values (v_agente, t_propio, 'texto', '__verif de flota__', 'idea de la flota propia', u_propio);

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', u_propio)::text, true);
    select count(*) into n_propio from public.agente_insumo where agente = v_agente;
    reset role;
  exception when insufficient_privilege then
    reset role;
    n_propio := -1;
  end;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', u_propio)::text, true);
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
      values (v_agente, t_propio, 'texto', 'x', 'x', u_propio);
    escribe_propio := true;
    reset role;
  exception when insufficient_privilege then
    reset role;
    escribe_propio := false;
  end;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', u_ajeno)::text, true);
    select count(*) into n_ajeno from public.agente_insumo where agente = v_agente;
    reset role;
  exception when insufficient_privilege then
    reset role;
    n_ajeno := -1;
  end;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', u_ajeno)::text, true);
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
      values (v_agente, t_ajeno, 'texto', 'x', 'x', u_ajeno);
    escribe_ajeno := true;
    reset role;
  exception when insufficient_privilege then
    reset role;
    escribe_ajeno := false;
  end;

  -- Sin cambiar de rol: esta sesión corre con el superusuario de CI, que
  -- bypassa RLS igual que `service_role` en producción (documentado por
  -- Supabase, ver cabecera de andamio_ci.sql) — confirma que las DOS filas
  -- (plataforma y de flota) siguen ahí y son el servidor, no RLS, quien
  -- tiene que separarlas por tenant.
  select count(*) into n_sin_rls from public.agente_insumo where agente = v_agente;

  raise exception 'AGENTE_INSUMO_DENY_ALL_0267  ve_propio=%  escribe_propio=%  ve_ajeno=%  escribe_ajeno=%  ve_sin_rls=%   (esperado -1 / false / -1 / false / >=2)',
    n_propio, escribe_propio, n_ajeno, escribe_ajeno, n_sin_rls;
end $$;

-- ── 216. Los CHECK de `agente_insumo` rechazan basura: tipo fuera de dominio, contenido en el campo equivocado, y un resumen sin fecha de proceso (mig. 0267) ──
--
-- Tres garantías que solo la base puede demostrar con certeza (un mock de
-- supabase-js jamás ejercita un CHECK real): (1) el dominio de `tipo` es
-- CERRADO — cualquier palabra que no sea de las cinco del plan rebota; (2) el
-- contenido vive en EXACTAMENTE el campo de su tipo — un documento sin ruta,
-- o un documento CON texto además de ruta, o un texto/link sin contenido, o
-- CON una ruta que no le corresponde, todos rebotan; (3) un `resumen_uso` no
-- puede existir sin `procesado_en` — la regla de "nunca afirmar un uso que
-- nadie midió" (CLAUDE.md), aplicada al agente en vez de a una cifra.
do $$
declare
  v_agente text := 'control_costos';
  u uuid := gen_random_uuid();
  rebota_tipo boolean := false;
  rebota_doc_sin_ruta boolean := false;
  rebota_doc_con_texto boolean := false;
  rebota_texto_sin_contenido boolean := false;
  rebota_texto_con_ruta boolean := false;
  rebota_resumen_sin_proceso boolean := false;
  acepta_documento boolean := false;
  acepta_texto boolean := false;
  acepta_resumen_con_proceso boolean := false;
begin
  -- `subido_por` exige un app_user real (FK) — de PLATAFORMA (tenant_id
  -- null): el superadmin también sube insumos, sin necesitar una flota.
  insert into public.app_user (id, email, rol, tenant_id) values (u, '__verif_0267_check__@likida.ai', 'superadmin', null);

  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
      values (v_agente, null, 'video_de_gatos', '__verif__', 'x', u);
  exception when check_violation then rebota_tipo := true;
  end;

  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, storage_path, subido_por)
      values (v_agente, null, 'documento', '__verif__', null, u);
  exception when check_violation then rebota_doc_sin_ruta := true;
  end;

  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, storage_path, contenido_texto, subido_por)
      values (v_agente, null, 'documento', '__verif__', 'x/y.pdf', 'texto de más', u);
  exception when check_violation then rebota_doc_con_texto := true;
  end;

  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
      values (v_agente, null, 'texto', '__verif__', null, u);
  exception when check_violation then rebota_texto_sin_contenido := true;
  end;

  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, storage_path, contenido_texto, subido_por)
      values (v_agente, null, 'texto', '__verif__', 'x/y.pdf', 'idea', u);
  exception when check_violation then rebota_texto_con_ruta := true;
  end;

  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por, resumen_uso)
      values (v_agente, null, 'texto', '__verif__', 'idea', u, 'ya lo usé sin haberlo procesado');
  exception when check_violation then rebota_resumen_sin_proceso := true;
  end;

  -- Las formas buenas SÍ entran — un CHECK demasiado estricto sería tan
  -- falso como uno demasiado laxo.
  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, storage_path, subido_por)
      values (v_agente, null, 'documento', '__verif ok doc__', 'control_costos/ok.pdf', u);
    acepta_documento := true;
  exception when others then acepta_documento := false;
  end;
  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por)
      values (v_agente, null, 'texto', '__verif ok texto__', 'idea de verdad', u);
    acepta_texto := true;
  exception when others then acepta_texto := false;
  end;
  begin
    insert into public.agente_insumo (agente, tenant_id, tipo, titulo, contenido_texto, subido_por, procesado_en, resumen_uso)
      values (v_agente, null, 'texto', '__verif ok procesado__', 'idea ya usada', u, now(), 'Incluida en el parte de Costos.');
    acepta_resumen_con_proceso := true;
  exception when others then acepta_resumen_con_proceso := false;
  end;

  raise exception 'AGENTE_INSUMO_CHECKS_0267  tipo=%  doc_sin_ruta=%  doc_con_texto=%  texto_sin_contenido=%  texto_con_ruta=%  resumen_sin_proceso=%  ok_doc=%  ok_texto=%  ok_procesado=%   (esperado t / t / t / t / t / t / t / t / t)',
    rebota_tipo, rebota_doc_sin_ruta, rebota_doc_con_texto, rebota_texto_sin_contenido, rebota_texto_con_ruta, rebota_resumen_sin_proceso, acepta_documento, acepta_texto, acepta_resumen_con_proceso;
end $$;

-- ── 217. El hilo del ticket: la nota interna NO la ve el cliente y el hilo ajeno ni se lee ni se escribe (mig. 0268, auditoría H1) ──
--
-- La 0051 escribió, textual, que «una nota interna no la ve el cliente». Su
-- policy no lo hacía: `tenant_data` era `for all` con un único predicado de
-- tenant (y la 0086 la reescribió conservando esa forma), así que un
-- `flota_admin` con sesión de navegador leía `interna=true` de SUS tickets
-- igual que cualquier otro mensaje. El comentario prometía una garantía que la
-- policy no daba — y eso es peor que no prometerla, porque nadie la vuelve a
-- revisar.
--
-- Y LA SUPLANTACIÓN DE AUTOR, que encontró la revisión de Fable (29-ago-2026)
-- sobre la primera versión de esta migración: la rama tenant del `with check`
-- no anclaba `autor_id` a `auth.uid()`, así que un flota_admin con sesión de
-- navegador insertaba un mensaje PÚBLICO firmado con el uuid de OTRO usuario —
-- un compañero suyo, o un uuid de superadmin filtrado, y entonces la pantalla
-- lo pinta como "Likida". Ese mensaje falso cumple `cuentaComoRespuesta`
-- (interna=false, autor≠solicitante) y APAGA la alarma «sin respuesta» del
-- agente de Éxito sin que nadie haya contestado: el hueco dejaba que el propio
-- cliente desactivara la garantía que esta migración vino a construir.
--
-- Este bloque ataca las esquinas con TRES app_user REALES (dos de la flota A,
-- uno de la B), impersonados con `set local role authenticated` + el claim del
-- sub (que es lo que hace PostgREST en cada request):
--
--   a) El dueño de A ve el mensaje PÚBLICO de su ticket.                → 1
--   b) El dueño de A NO ve la nota interna de su propio ticket.         → 0
--   c) El dueño de B no ve NADA del hilo de A.                          → 0
--   d) El dueño de B no puede ESCRIBIR en el hilo de A (with check).    → t
--   e) El dueño de A no puede fabricar una nota interna en su hilo.     → t
--   f) El dueño de A no puede FIRMAR COMO OTRO usuario de su flota.     → t
--   g) …pero SÍ puede escribir firmando con su propio uuid.             → t
--   h) `asignado_a` (0268) existe y acepta el id de un app_user.        → t
--
-- (g) NO es relleno: sin un control positivo, una policy que negara TODA
-- escritura del tenant pasaría este bloque con honores, y el panel del cliente
-- se habría quedado mudo sin que nada lo dijera.
--
-- Lo que este bloque NO prueba, y por eso no se presenta como si lo probara:
-- el camino REAL del producto corre con `service_role`, que salta RLS. Esa
-- primera red es el `.eq('interna', false)` de `getHilo` y el rechazo de
-- `responderTicket`, probados en `src/lib/likida/soporte.test.ts`. Esto es la
-- segunda red: la que protege una sesión de navegador.
do $$
declare
  v_a uuid; v_b uuid; v_u_a uuid := gen_random_uuid(); v_u_b uuid := gen_random_uuid();
  -- El COMPAÑERO de flota del dueño de A: la víctima de la suplantación. Tiene
  -- que ser del MISMO tenant, porque si no el rechazo podría venir del filtro
  -- de tenant y no del ancla de autor — y entonces el bloque probaría otra cosa.
  v_u_a2 uuid := gen_random_uuid();
  v_tk uuid;
  n_publico_propio int; n_interna_propia int; n_hilo_ajeno int;
  b_no_escribe boolean := false;
  a_no_fabrica_interna boolean := false;
  a_no_suplanta boolean := false;
  a_firma_propia boolean := false;
  asignado_ok boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0268 A') returning id into v_a;
  insert into tenant (nombre) values ('ZZZ VERIF 0268 B') returning id into v_b;
  insert into app_user (id, tenant_id, email, rol) values (v_u_a, v_a, 'zzz-0268-a@likida.test', 'flota_admin');
  insert into app_user (id, tenant_id, email, rol) values (v_u_a2, v_a, 'zzz-0268-a2@likida.test', 'encargado');
  insert into app_user (id, tenant_id, email, rol) values (v_u_b, v_b, 'zzz-0268-b@likida.test', 'flota_admin');

  insert into ticket_soporte (tenant_id, abierto_por, asunto)
    values (v_a, v_u_a, 'ZZZ ticket 0268') returning id into v_tk;
  -- El hilo, escrito con service_role (que es como lo escribe el producto):
  -- una respuesta pública del equipo y una nota interna sobre la misma flota.
  insert into ticket_mensaje (ticket_id, autor_id, cuerpo, interna)
    values (v_tk, null, 'Ya lo estamos viendo.', false);
  insert into ticket_mensaje (ticket_id, autor_id, cuerpo, interna)
    values (v_tk, null, 'Nota interna: esta flota lleva tres tickets del mismo tema.', true);

  -- `asignado_a` acepta a un app_user (0268). Si la columna no existiera, la
  -- migración no habría aplicado y esto tronaría antes de llegar aquí.
  update ticket_soporte set asignado_a = v_u_a where id = v_tk;
  select (asignado_a = v_u_a) into asignado_ok from ticket_soporte where id = v_tk;

  -- ── El flota_admin de A, impersonado ────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u_a)::text, true);

  select count(*) into n_publico_propio from ticket_mensaje where ticket_id = v_tk and interna = false;
  select count(*) into n_interna_propia  from ticket_mensaje where ticket_id = v_tk and interna = true;

  begin
    insert into ticket_mensaje (ticket_id, autor_id, cuerpo, interna)
      values (v_tk, v_u_a, 'Nota que el cliente NO debería poder fabricar', true);
  exception when insufficient_privilege then a_no_fabrica_interna := true;
  end;

  -- LA SUPLANTACIÓN (hallazgo de Fable): mensaje PÚBLICO, en SU propio ticket,
  -- de SU propia flota — todo legítimo salvo la firma, que es la de su
  -- compañero. Sin el ancla `autor_id = (select auth.uid())` esto entraba, y
  -- ese mensaje apagaba la alarma «sin respuesta» sin que nadie contestara.
  begin
    insert into ticket_mensaje (ticket_id, autor_id, cuerpo, interna)
      values (v_tk, v_u_a2, 'Respuesta falsa firmada por otro usuario', false);
  exception when insufficient_privilege then a_no_suplanta := true;
  end;

  -- EL CONTROL POSITIVO: lo mismo, firmado con su propio uuid, SÍ entra. Sin
  -- esto, una policy que negara toda escritura del tenant pasaría el bloque.
  begin
    insert into ticket_mensaje (ticket_id, autor_id, cuerpo, interna)
      values (v_tk, v_u_a, 'Sigo esperando, ¿alguna novedad?', false);
    a_firma_propia := true;
  exception when insufficient_privilege then a_firma_propia := false;
  end;

  reset role;

  -- ── El flota_admin de B, impersonado ────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u_b)::text, true);

  select count(*) into n_hilo_ajeno from ticket_mensaje where ticket_id = v_tk;

  begin
    insert into ticket_mensaje (ticket_id, autor_id, cuerpo, interna)
      values (v_tk, v_u_b, 'Mensaje en el hilo de otra flota', false);
  exception when insufficient_privilege then b_no_escribe := true;
  end;

  reset role;

  delete from tenant where id in (v_a, v_b);   -- cascade limpia el resto
  raise exception E'HILO_TICKET_0268  publico-propio=%  interna-propia=%  hilo-ajeno=%  b-no-escribe=%  a-no-fabrica-interna=%  a-no-suplanta=%  a-firma-propia=%  asignado=%   (esperado 1 / 0 / 0 / t / t / t / t / t)',
    n_publico_propio, n_interna_propia, n_hilo_ajeno, b_no_escribe, a_no_fabrica_interna,
    a_no_suplanta, a_firma_propia, asignado_ok;
end $$;

-- ── 218. `cola_correo_frio_por_prospecto`: dos invocaciones que compiten por el mismo prospecto no fabrican dos piezas `correo_frio` pendientes (mig. 0270) ──
--
-- (auditoría 21, agéntico, MEDIO.)
--
-- El hallazgo: `redactarCorreoFrio` frenaba la duplicada con una LECTURA
-- previa ("¿hay una pieza pendiente de este prospecto?"), que basta contra un
-- humano pero no contra el botón del tablero y el cron nivel 2 compitiendo por
-- el mismo prospecto — las dos pasan la lectura ANTES de que ninguna inserte,
-- las dos ven cero, las dos intentan encolar. Este bloque simula esa carrera
-- con dos INSERT consecutivos dentro de la misma transacción (la forma en que
-- esta batería reproduce una condición de carrera real — mismo patrón que el
-- bloque 172, `parte_costos`/0215, y el 64, `cobranza_contacto`/0089): si el
-- índice es el árbitro, el SEGUNDO insert debe rebotar con 23505 sin importar
-- que la lectura de ambas invocaciones haya dado "cero pendientes".
--
-- (a) primera pieza entra; (b) la segunda, MISMO prospecto y MISMO tipo,
-- rebota — exactamente la carrera del hallazgo; (c) tras esas dos, sigue
-- habiendo UNA sola pendiente de ese prospecto (el índice no dejó pasar la
-- segunda ni a medias); (d) resuelto (rechazado) el sobreviviente, el
-- prospecto queda libre y una TERCERA pieza SÍ entra — la parcialidad a
-- `estado = 'pendiente'` funciona en el sentido "se resuelve, se libera"; (e)
-- una pieza `respuesta_ads` (el SDR) del MISMO prospecto convive con un
-- `correo_frio` pendiente — el índice es parcial también a `tipo`, a
-- propósito (0270, misma exclusión que 0215/0218 hacen con el Redactor); (f)
-- dos prospectos DISTINTOS con el MISMO título de campaña no chocan entre
-- sí — el árbitro es por prospecto, no por título (a diferencia de 0215/0218,
-- cuyos títulos SÍ son deterministas por periodo).
do $$
declare
  v_p1 uuid; v_p2 uuid;
  segunda_rebota boolean := false;
  n_pendientes_tras_carrera int;
  tercera_entra boolean := false;
  ads_convive boolean := false;
  otro_prospecto_entra boolean := false;
begin
  insert into prospecto (empresa, fuente) values ('ZZZ VERIF 0270 — uno', 'censo') returning id into v_p1;
  insert into prospecto (empresa, fuente) values ('ZZZ VERIF 0270 — dos', 'censo') returning id into v_p2;

  -- (a) La primera invocación gana la carrera.
  insert into cola_aprobacion (tipo, agente, prospecto_id, titulo, cuerpo)
    values ('correo_frio', 'redactor', v_p1, 'Asunto de campaña 0270', 'pieza de la 1a invocación');

  -- (b) La segunda invocación, la que la LECTURA previa no pudo frenar
  -- (leyó cero pendientes antes de que la primera terminara de insertar):
  -- el índice único parcial es quien de verdad arbitra.
  begin
    insert into cola_aprobacion (tipo, agente, prospecto_id, titulo, cuerpo)
      values ('correo_frio', 'redactor', v_p1, 'Asunto de campaña 0270', 'pieza de la 2a invocación (perdedora)');
  exception when unique_violation then
    segunda_rebota := true;
  end;

  -- (c) Sigue habiendo UNA sola pendiente de v_p1.
  select count(*) into n_pendientes_tras_carrera
    from cola_aprobacion where prospecto_id = v_p1 and tipo = 'correo_frio' and estado = 'pendiente';

  -- (d) Se resuelve (rechaza) la sobreviviente: el prospecto queda libre.
  update cola_aprobacion
    set estado = 'rechazado', motivo_rechazo = 'prueba 0270', resuelto_en = now(), resuelto_por_email = 'verif@likida.ai'
    where prospecto_id = v_p1 and tipo = 'correo_frio' and estado = 'pendiente';
  begin
    insert into cola_aprobacion (tipo, agente, prospecto_id, titulo, cuerpo)
      values ('correo_frio', 'redactor', v_p1, 'Asunto de campaña 0270', 'pieza de la 3a invocación (tras liberar)');
    tercera_entra := true;
  exception when unique_violation then
    tercera_entra := false;
  end;

  -- (e) `respuesta_ads` del mismo prospecto convive con el `correo_frio`
  -- pendiente que acaba de entrar arriba (la 3a invocación sigue pendiente).
  begin
    insert into cola_aprobacion (tipo, agente, prospecto_id, titulo, cuerpo)
      values ('respuesta_ads', 'redactor', v_p1, 'Respondió el ads de Facebook', 'pieza del SDR');
    ads_convive := true;
  exception when unique_violation then
    ads_convive := false;
  end;

  -- (f) Otro prospecto, MISMO título de campaña: el árbitro es por
  -- prospecto, no por título — no debe chocar con nada de lo de arriba.
  begin
    insert into cola_aprobacion (tipo, agente, prospecto_id, titulo, cuerpo)
      values ('correo_frio', 'redactor', v_p2, 'Asunto de campaña 0270', 'pieza de otro prospecto, mismo asunto');
    otro_prospecto_entra := true;
  exception when unique_violation then
    otro_prospecto_entra := false;
  end;

  delete from cola_aprobacion where prospecto_id in (v_p1, v_p2);
  delete from prospecto where id in (v_p1, v_p2);
  raise exception E'CORREO_FRIO_UNICO_0270  segunda-rebota=%  pendientes-tras-carrera=%  tercera-entra=%  ads-convive=%  otro-prospecto-entra=%   (esperado t / 1 / t / t / t)',
    segunda_rebota, n_pendientes_tras_carrera, tercera_entra, ads_convive, otro_prospecto_entra;
end $$;

-- ── 219. Un token/código MCP con (user_id, tenant_id, rol) cruzados nunca se escribe, y un rol fuera de dominio tampoco (mig. 0271) ──
--
-- El hallazgo: `mcp_oauth_codigo`/`mcp_oauth_token` llevaban `user_id` y
-- `tenant_id` con FK SIMPLES e INDEPENDIENTES a `app_user(id)` y `tenant(id)`
-- — nada ataba el par, así que un INSERT con el usuario de la flota A y el
-- `tenant_id` de la flota B pasaba las dos FK. La 0271 cierra esto con la
-- misma técnica de 0028/0145 (FK compuesta contra una `unique (id, tenant_id,
-- rol)` en `app_user`) y le agrega a `rol` el dominio cerrado que le faltaba
-- desde la 0260 — más ESTRECHO que `app_user_rol_dominio` a propósito: solo
-- los tres roles que `/mcp/autorizar` de verdad deja consentir.
--
-- Lo que este bloque demuestra, con las DOS tablas y un solo tenant real de
-- por medio:
--
--  (a) El trío REAL (usuario, SU tenant, SU rol) → el INSERT pasa.
--  (b) EL ESCENARIO LITERAL DEL HALLAZGO: mismo usuario, `tenant_id` de OTRA
--      flota → `foreign_key_violation`, en las dos tablas.
--  (c) Mismo usuario y tenant, un rol que el usuario NO TIENE HOY
--      (`flota_admin` en vez de su `contador` real) → también
--      `foreign_key_violation`, aunque ese rol sí sea válido en general —
--      esto es lo que la FK compuesta cierra y un CHECK de dominio, solo,
--      jamás habría podido cerrar.
--  (d) Un rol que NUNCA es de `app_user` (`auditor`) → `check_violation` del
--      dominio de la 0271, ANTES de que la FK ni se evalúe.
do $$
declare
  ta uuid := gen_random_uuid();
  tb uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
  cli uuid;
  real_codigo boolean := false; real_token boolean := false;
  tenant_cruzado_codigo boolean := false; tenant_cruzado_token boolean := false;
  rol_no_vigente_codigo boolean := false; rol_no_vigente_token boolean := false;
  rol_fuera_dominio_codigo boolean := false; rol_fuera_dominio_token boolean := false;
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0271_a__');
  insert into public.tenant (id, nombre) values (tb, '__verif_0271_b__');
  insert into public.app_user (id, email, rol, tenant_id) values (u, '__verif_0271__@likida.ai', 'contador', ta);
  insert into public.mcp_oauth_cliente (nombre, redirect_uris)
    values ('__verif_0271__', '["https://claude.ai/api/mcp/auth_callback"]'::jsonb)
    returning id into cli;

  -- (a) el trío real: pasa en las dos tablas.
  begin
    insert into public.mcp_oauth_codigo
      (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en)
    values (repeat('1', 64), cli, u, ta, 'contador',
      'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '5 min');
    real_codigo := true;
  exception when foreign_key_violation then real_codigo := false;
  end;
  begin
    insert into public.mcp_oauth_token
      (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('1', 64), 'acceso', cli, u, ta, 'contador', gen_random_uuid(), now() + interval '8 hours');
    real_token := true;
  exception when foreign_key_violation then real_token := false;
  end;

  -- (b) el escenario literal del hallazgo: usuario de A, tenant_id de B.
  begin
    insert into public.mcp_oauth_codigo
      (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en)
    values (repeat('2', 64), cli, u, tb, 'contador',
      'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '5 min');
  exception when foreign_key_violation then tenant_cruzado_codigo := true;
  end;
  begin
    insert into public.mcp_oauth_token
      (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('2', 64), 'acceso', cli, u, tb, 'contador', gen_random_uuid(), now() + interval '8 hours');
  exception when foreign_key_violation then tenant_cruzado_token := true;
  end;

  -- (c) tenant correcto, pero un rol que el usuario no tiene HOY (es
  -- 'contador', no 'flota_admin' — ambos válidos en general, solo uno cierto).
  begin
    insert into public.mcp_oauth_codigo
      (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en)
    values (repeat('3', 64), cli, u, ta, 'flota_admin',
      'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '5 min');
  exception when foreign_key_violation then rol_no_vigente_codigo := true;
  end;
  begin
    insert into public.mcp_oauth_token
      (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('3', 64), 'acceso', cli, u, ta, 'flota_admin', gen_random_uuid(), now() + interval '8 hours');
  exception when foreign_key_violation then rol_no_vigente_token := true;
  end;

  -- (d) un rol que ni siquiera es de app_user: el CHECK de dominio de la
  -- 0271 lo rechaza antes de tocar la FK.
  begin
    insert into public.mcp_oauth_codigo
      (codigo_hash, cliente_id, user_id, tenant_id, rol, redirect_uri, code_challenge, familia, expira_en)
    values (repeat('4', 64), cli, u, ta, 'auditor',
      'https://claude.ai/api/mcp/auth_callback', repeat('E', 43), gen_random_uuid(), now() + interval '5 min');
  exception when check_violation then rol_fuera_dominio_codigo := true;
  end;
  begin
    insert into public.mcp_oauth_token
      (token_hash, tipo, cliente_id, user_id, tenant_id, rol, familia, expira_en)
    values (repeat('4', 64), 'acceso', cli, u, ta, 'auditor', gen_random_uuid(), now() + interval '8 hours');
  exception when check_violation then rol_fuera_dominio_token := true;
  end;

  raise exception E'MCP_OAUTH_IDENTIDAD_ATADA_0271  real-codigo=%  real-token=%  tenant-cruzado-codigo=%  tenant-cruzado-token=%  rol-no-vigente-codigo=%  rol-no-vigente-token=%  rol-fuera-dominio-codigo=%  rol-fuera-dominio-token=%   (esperado t / t / t / t / t / t / t / t)',
    real_codigo, real_token, tenant_cruzado_codigo, tenant_cruzado_token,
    rol_no_vigente_codigo, rol_no_vigente_token, rol_fuera_dominio_codigo, rol_fuera_dominio_token;
end $$;

-- ── 220. `poliza_datos_tenant` entrega los insumos de deducibilidad, y no los clasifica (mig. 0272) ──
--
-- AUDITORÍA 22, FIS-C1 (CRÍTICO). La función devolvía UNA base por concepto y
-- la ruta la cargaba entera a la cuenta de gasto DEDUCIBLE, aunque el motor
-- hubiera marcado ese comprobante `cfdi_efos` o `efectivo_sobre_tope`: el PDF
-- decía «No deducible $58,000» y el archivo del ERP lo asentaba como deducible.
--
-- Lo que este bloque asevera es la FORMA del contrato nuevo, que es lo que la
-- base sí puede demostrar:
--   (a) cada fila trae `gastos`, con un renglón POR COMPROBANTE — no agregado
--       por concepto — con su `id`, su base y `tieneCfdi`;
--   (b) cada fila trae `diferencias`, el jsonb que la liquidación ya guarda;
--   (c) `porConcepto` y `baseDesconocida` SIGUEN ahí: los consumidores previos
--       no se enteran de este cambio.
--
-- Lo que este bloque NO asevera, a propósito: en qué cubeta cae cada gasto. Esa
-- pregunta tiene UNA definición (`cubetaDe`, cuadre/engine.ts) y vive en TS.
-- Copiar `NO_DEDUCIBLE_ISR` aquí sería la segunda fuente de verdad que diverge
-- en la primera auditoría que agregue un tipo. Se prueba en
-- `poliza_deducibilidad.test.ts` y en el reparto de la ruta.
do $$
declare
  t uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  l uuid := gen_random_uuid(); g uuid := gen_random_uuid();
  op uuid := gen_random_uuid();
  fila jsonb;
  trae_gastos boolean := false;
  gasto_por_comprobante boolean := false;
  trae_diferencias boolean := false;
  conserva_por_concepto boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0272__');
  -- `viaje.operador_id` es NOT NULL: el fixture necesita un operador real.
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op, t, 'Operador 0272', '+5218100000272');
  insert into public.viaje (id, tenant_id, operador_id, folio, anticipo, estatus)
    values (v, t, op, 'VJ-0272', 10000, 'liquidado');
  insert into public.gasto (id, tenant_id, viaje_id, concepto, monto, sub_total, cfdi_uuid)
    values (g, t, v, 'hospedaje', 5800, 5000, null);
  insert into public.liquidacion
    (id, tenant_id, viaje_id, total_anticipo, total_comprobado, diferencia, iva_acreditable, diferencias)
    values (l, t, v, 10000, 5800, 4200, 0,
      jsonb_build_array(jsonb_build_object('tipo','efectivo_sobre_tope','gastoId',g::text,'concepto','hospedaje','monto',0)));

  select x into fila
    from jsonb_array_elements(public.poliza_datos_tenant(t, current_date - 1, current_date + 1)) x
   limit 1;

  trae_gastos           := jsonb_typeof(fila->'gastos') = 'array' and jsonb_array_length(fila->'gastos') = 1;
  gasto_por_comprobante := (fila->'gastos'->0->>'id') = g::text
                           and (fila->'gastos'->0->>'subtotal')::numeric = 5000
                           and (fila->'gastos'->0->>'tieneCfdi') = 'false';
  trae_diferencias      := jsonb_array_length(fila->'diferencias') = 1
                           and (fila->'diferencias'->0->>'gastoId') = g::text;
  conserva_por_concepto := jsonb_typeof(fila->'porConcepto') = 'array'
                           and (fila->'baseDesconocida')::numeric = 0;

  raise exception E'POLIZA_DEDUCIBILIDAD_0272  gastos=%  por-comprobante=%  diferencias=%  conserva-porConcepto=%   (esperado t / t / t / t)',
    trae_gastos, gasto_por_comprobante, trae_diferencias, conserva_por_concepto;
end $$;

-- ── 221. La cancelación ARCO retira el texto libre que el titular escribió (mig. 0273) ──
--
-- AUDITORÍA 22, LEG-A4 (ALTO). La 0262 declaró su alcance como «el esquema
-- completo de `operador`», y las tablas donde vive lo que el TITULAR ESCRIBIÓ
-- quedaron fuera. Si Juan escribió «soy Juan Pérez de la unidad 12, choqué en
-- el km 84», esa cadena sobrevivía íntegra mientras el panel le confirmaba al
-- contralor «el titular quedó anonimizado en la base».
--
-- Se asevera lo que la base sí puede demostrar, END TO END sobre la RPC real:
--   (a) `incidencia.descripcion` deja de contener el nombre del titular;
--   (b) `incidencia.operador_id` queda suelto;
--   (c) `incidencia_evento.detalle->>'texto'` tampoco lo contiene;
--   (d) el RENGLÓN de la incidencia SIGUE ahí — es un hecho operativo de la
--       flota, y borrarlo sería pasarse del derecho que se está ejerciendo;
--   (e) la evidencia de la solicitud cuenta lo retirado.
do $$
declare
  t uuid := gen_random_uuid(); op uuid := gen_random_uuid();
  inc uuid := gen_random_uuid(); sol uuid := gen_random_uuid();
  desc_final text; ev_final jsonb; op_final uuid; txt_evento text;
  incidencia_viva boolean;
  sin_nombre_desc boolean := false; sin_nombre_evento boolean := false;
  operador_suelto boolean := false; evidencia_lo_cuenta boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0273__');
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op, t, 'Juan Pérez', '+5218112345678');
  insert into public.incidencia (id, tenant_id, operador_id, tipo, prioridad, descripcion, hay_lesionados)
    values (inc, t, op, 'siniestro', 'critica',
            'soy Juan Pérez de la unidad 12, choqué en el km 84 y me llevaron al IMSS', true);
  insert into public.incidencia_evento (tenant_id, incidencia_id, tipo, detalle)
    values (t, inc, 'mensaje_adicional',
            jsonb_build_object('texto', 'aquí Juan Pérez otra vez, ya llegó la grúa'));
  -- Dos cosas que el esquema de la 0053 exige y el primer fixture no traía:
  -- `vence_en` es NOT NULL (la LFPDPPP da plazo de respuesta y se guarda), y
  -- el estado inicial del dominio es `recibida`, no `pendiente`.
  insert into public.solicitud_arco (id, tenant_id, operador_id, tipo, estado, vence_en)
    values (sol, t, op, 'cancelacion', 'recibida', now() + interval '20 days');

  perform public.ejecutar_arco_cancelacion(t, sol);

  select i.descripcion, i.operador_id into desc_final, op_final
    from public.incidencia i where i.id = inc;
  select e.detalle->>'texto' into txt_evento
    from public.incidencia_evento e where e.incidencia_id = inc limit 1;
  select s.evidencia into ev_final from public.solicitud_arco s where s.id = sol;

  incidencia_viva     := desc_final is not null;
  sin_nombre_desc     := desc_final not ilike '%Juan Pérez%';
  sin_nombre_evento   := coalesce(txt_evento, '') not ilike '%Juan Pérez%';
  operador_suelto     := op_final is null;
  evidencia_lo_cuenta := (ev_final->>'incidencia_texto_anonimizado')::int >= 1;

  raise exception E'ARCO_TEXTO_LIBRE_0273  incidencia-viva=%  desc-sin-nombre=%  evento-sin-nombre=%  operador-suelto=%  evidencia=%   (esperado t / t / t / t / t)',
    incidencia_viva, sin_nombre_desc, sin_nombre_evento, operador_suelto, evidencia_lo_cuenta;
end $$;

-- ── 222. La conversación de WhatsApp se identifica por el teléfono NORMALIZADO (mig. 0274) ──
--
-- AUDITORÍA 22, DATOS-1 (ALTO). `wa_conversacion_tenant_tel_uidx` (0005:13) es
-- `(tenant_id, telefono)` sobre el TEXTO CRUDO. La 0024 diagnosticó este mismo
-- modo de falla para `operador` y lo cerró con `telefono_normalizado(...)`;
-- `wa_conversacion` nunca recibió ese tratamiento, aunque `conv.ts:64` documenta
-- que el mismo celular llega como 52… o 521… según por dónde entre.
--
-- Se asevera lo único que la base puede demostrar y que es justo el arreglo:
--   (a) dos formas del MISMO número chocan contra el índice nuevo;
--   (b) dos números DISTINTOS de la misma flota siguen conviviendo;
--   (c) el mismo número en OTRA flota también (el índice es por tenant).
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  choca_variante boolean := false;
  otro_numero_ok boolean := false;
  otra_flota_ok  boolean := false;
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0274_a__');
  insert into public.tenant (id, nombre) values (tb, '__verif_0274_b__');

  insert into public.wa_conversacion (tenant_id, telefono, estado)
    values (ta, '529993700779', '{}'::jsonb);

  -- (a) la MISMA persona con el "1" de Telmex: tiene que rebotar.
  begin
    insert into public.wa_conversacion (tenant_id, telefono, estado)
      values (ta, '5219993700779', '{}'::jsonb);
  exception when unique_violation then choca_variante := true;
  end;

  -- (b) otro chofer de la misma flota: convive.
  begin
    insert into public.wa_conversacion (tenant_id, telefono, estado)
      values (ta, '528112345678', '{}'::jsonb);
    otro_numero_ok := true;
  exception when others then otro_numero_ok := false;
  end;

  -- (c) el mismo número en otra flota: convive (el índice es por tenant).
  begin
    insert into public.wa_conversacion (tenant_id, telefono, estado)
      values (tb, '5219993700779', '{}'::jsonb);
    otra_flota_ok := true;
  exception when others then otra_flota_ok := false;
  end;

  raise exception E'WA_CONVERSACION_TEL_NORM_0274  variante-choca=%  otro-numero=%  otra-flota=%   (esperado t / t / t)',
    choca_variante, otro_numero_ok, otra_flota_ok;
end $$;

-- ── 244. `interruptor_tenant`: el CHECK de motivo, el dominio de pipeline, la PK compuesta y el cascade (mig. 0297) ──
--
-- AUDITORÍA 24, ADM-6 (MEDIO). Antes de la 0297 no había NINGUNA palanca para
-- cortar el pipeline del chofer (whatsapp/ocr/cuadre) de UNA sola flota: las
-- 58 de `interruptor` (0110) son de agentes de back office, y `global`
-- apagaría TODAS las flotas de golpe. Esta migración añade una tabla
-- hermana, deliberadamente SEPARADA (no una columna `tenant_id` nullable en
-- `interruptor`) para que la ausencia de filtro nunca pueda mezclar los dos
-- dominios (ver el comentario de la migración).
--
-- Se aseveran las CUATRO garantías que solo la base puede demostrar: (1) el
-- mismo CHECK de motivo obligatorio que ya tiene `interruptor` — apagado sin
-- motivo, o con motivo en blanco, rebota; (2) el dominio de `pipeline` es
-- CERRADO a los tres pasos del camino del chofer; (3) la PK es COMPUESTA
-- (tenant_id, pipeline) — el mismo pipeline convive en dos flotas distintas,
-- y dos pipelines conviven en la misma flota, pero repetir el MISMO par
-- choca; (4) borrar el tenant borra en cascada su fila — un tenant demo
-- purgado en `verificaciones` no deja basura huérfana.
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  rebota_sin_motivo boolean := false;
  rebota_motivo_blanco boolean := false;
  acepta_con_motivo boolean := false;
  rebota_pipeline_fuera_dominio boolean := false;
  convive_dos_pipelines_misma_flota boolean := false;
  convive_mismo_pipeline_otra_flota boolean := false;
  choca_mismo_par boolean := false;
  cascade_al_borrar_tenant boolean := false;
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0297_a__');
  insert into public.tenant (id, nombre) values (tb, '__verif_0297_b__');

  -- (1) apagado=true sin motivo (NULL) rebota.
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado)
      values (ta, 'ocr', true);
  exception when check_violation then rebota_sin_motivo := true;
  end;

  -- (1b) apagado=true con motivo en blanco rebota igual (mismo criterio
  -- que `interruptor_apagado_con_motivo`, 0110: espacios no son un porqué).
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado, motivo)
      values (ta, 'ocr', true, '   ');
  exception when check_violation then rebota_motivo_blanco := true;
  end;

  -- (2) el dominio de pipeline es cerrado — 'facturacion' no es de los tres.
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado, motivo)
      values (ta, 'facturacion', true, 'motivo real');
  exception when check_violation then rebota_pipeline_fuera_dominio := true;
  end;

  -- La forma buena SÍ entra.
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado, motivo)
      values (ta, 'ocr', true, 'gasto disparado en Innovativos');
    acepta_con_motivo := true;
  exception when others then acepta_con_motivo := false;
  end;

  -- (3a) otro pipeline de LA MISMA flota convive.
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado, motivo)
      values (ta, 'cuadre', true, 'otro motivo');
    convive_dos_pipelines_misma_flota := true;
  exception when others then convive_dos_pipelines_misma_flota := false;
  end;

  -- (3b) el MISMO pipeline en OTRA flota convive (la PK es por tenant).
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado, motivo)
      values (tb, 'ocr', true, 'motivo de la otra flota');
    convive_mismo_pipeline_otra_flota := true;
  exception when others then convive_mismo_pipeline_otra_flota := false;
  end;

  -- (3c) repetir el MISMO (tenant, pipeline) choca contra la PK.
  begin
    insert into public.interruptor_tenant (tenant_id, pipeline, apagado, motivo)
      values (ta, 'ocr', true, 'segundo intento');
  exception when unique_violation then choca_mismo_par := true;
  end;

  -- (4) borrar el tenant borra en cascada sus interruptores.
  delete from public.tenant where id = ta;
  cascade_al_borrar_tenant := not exists (select 1 from public.interruptor_tenant where tenant_id = ta);

  raise exception E'INTERRUPTOR_TENANT_0297  sin-motivo=%  motivo-blanco=%  ok-con-motivo=%  pipeline-fuera-dominio=%  convive-pipelines=%  convive-flotas=%  choca-mismo-par=%  cascade-tenant=%   (esperado t / t / t / t / t / t / t / t)',
    rebota_sin_motivo, rebota_motivo_blanco, acepta_con_motivo, rebota_pipeline_fuera_dominio,
    convive_dos_pipelines_misma_flota, convive_mismo_pipeline_otra_flota, choca_mismo_par, cascade_al_borrar_tenant;
end $$;

-- ── 249. Los nueve agentes TEATRO se gradúan tras la auditoría, sin tocar al resto del catálogo (mig. 0303) ──
--
-- Lo que solo la base puede demostrar de la 0303 (el espejo de la 248/0301):
--
--  (a) los NUEVE ids quedan `experimental = false` — uno por uno, porque un
--      UPDATE con un `where id in (...)` mal escrito deja alguno fuera en
--      silencio, igual que pudo haber pasado al marcarlos.
--  (b) los NUEVE quedan con `prompt_ref IS NULL` — cerraban una referencia a
--      un archivo que nunca se escribió; dejarla apuntando a nada sería la
--      misma promesa falsa con otro nombre.
--  (c) los NUEVE quedan con una `descripcion` que YA NO contiene la frase
--      VIGENTE de cada uno al llegar la 0303 (la de 0230/0234/0235, no la
--      de la 0125 original — ésa ya la habían reemplazado tres migraciones
--      antes) — cada agente contra SU PROPIA frase, una por una, para que
--      un `CASE WHEN` borrado (o que dejara alguna fila sin tocar) sí
--      dispare la sonda de esa fila en vez de depender de un texto que
--      ninguna descripción real llegó a tener nunca (auditoría 25, DATOS-M2:
--      la lista anterior probaba contra la 0125, que 0230/0234/0235 ya
--      habían sobrescrito por completo antes de que la 0303 corriera —
--      cero de esas cinco frases podía dispararse).
--  (d) un agente REAL del catálogo (`redactor`) NO quedó tocado — la
--      migración no pudo haber puesto `experimental = false` a TODOS por
--      accidente, ni tocado su `descripcion`.
--  (e) el DEFAULT de la columna `experimental` sigue siendo `false` — este
--      bloque hereda ese sub-check del retirado 248/0301 (ver EXENTAS de
--      `migraciones_verificadas.test.ts`, entrada 0301): esa migración
--      solo declaró el default una vez, y la garantía de la base sobre eso
--      no cambió con la 0303, así que se mueve aquí en vez de perderse.
do $$
declare
  ids text[] := array[
    'cazador','seo_distribucion','guiones','noticias_mercado',
    'promos_diarias','visuales','video_demo','video_marketing','pruebas'
  ];
  -- Una frase por id, EN EL MISMO ORDEN que `ids` — la que su descripción
  -- vigente traía justo antes de la 0303 (0230 para los siete de mercadeo,
  -- 0234 para pruebas, 0235 para cazador), verificada de que NO aparece en
  -- la descripción que la 0303 escribe.
  frases_viejas text[] := array[
    'el encargo de caza sobre lo que ya está en la base',                    -- cazador       (0235)
    'el <title> que de verdad se sirve',                                     -- seo_distribucion (0230)
    'no tiene los videos de referencia ni whisper',                          -- guiones       (0230)
    'no navega la web y no finge una investigación',                        -- noticias_mercado (0230)
    'cada beneficio del catálogo declara qué símbolo del producto lo sostiene', -- promos_diarias (0230)
    'produce el encargo de la pieza gráfica',                                -- visuales      (0230)
    'produce el encargo del video que se manda antes de la llamada',        -- video_demo    (0230)
    'produce el encargo del reel para el gremio',                           -- video_marketing (0230)
    'vigila los resultados que sí llegan a la base'                          -- pruebas       (0234)
  ];
  i int; k text; f text;
  no_graduados text[] := '{}';
  con_prompt_ref text[] := '{}';
  con_frase_vieja text[] := '{}';
  descripcion_actual text;
  redactor_experimental boolean;
  redactor_descripcion_antes text;
  redactor_descripcion_despues text;
  default_es_false boolean;
begin
  select descripcion into redactor_descripcion_antes from public.agente_definicion where id = 'redactor';

  for i in 1..array_length(ids, 1) loop
    k := ids[i];
    f := frases_viejas[i];
    -- (a)
    if exists (select 1 from public.agente_definicion where id = k and experimental = true) then
      no_graduados := no_graduados || k;
    end if;
    -- (b)
    if exists (select 1 from public.agente_definicion where id = k and prompt_ref is not null) then
      con_prompt_ref := con_prompt_ref || k;
    end if;
    -- (c) la frase vigente ANTES de la 0303, contra SU PROPIO id.
    select descripcion into descripcion_actual from public.agente_definicion where id = k;
    if descripcion_actual is not null and lower(descripcion_actual) like '%' || f || '%' then
      con_frase_vieja := con_frase_vieja || (k || ':' || f);
    end if;
  end loop;

  -- (d) redactor intacto, antes y después de esta migración.
  select (experimental = false) into redactor_experimental from public.agente_definicion where id = 'redactor';
  select descripcion into redactor_descripcion_despues from public.agente_definicion where id = 'redactor';

  -- (e) el default de la columna, sobre una fila nueva que no la toca
  -- (heredado del bloque 248/0301, retirado — ver arriba).
  insert into public.agente_definicion (id, nombre, departamento)
    values ('__verif_0303_default__', 'Verificación 0303', 'ingenieria');
  select (experimental = false) into default_es_false
    from public.agente_definicion where id = '__verif_0303_default__';

  raise exception E'AGENTES_GRADUADOS_0303  no_graduados=%  con_prompt_ref=%  con_frase_vieja=%  redactor_experimental_false=%  redactor_descripcion_intacta=%  default_es_false=%   (esperado ninguno / ninguno / ninguno / t / t / t)',
    coalesce(array_to_string(no_graduados, ','), 'ninguno'),
    coalesce(array_to_string(con_prompt_ref, ','), 'ninguno'),
    coalesce(array_to_string(con_frase_vieja, ','), 'ninguno'),
    redactor_experimental,
    (redactor_descripcion_antes is not distinct from redactor_descripcion_despues),
    default_es_false;
end $$;

-- ── 243. `tenant_perfil_merge` mezcla el perfil ATÓMICAMENTE — leer+escribir en el mismo UPDATE, no en dos viajes de Node (mig. 0296, auditoría 24, H20/H21/H22) ──
--
-- El hallazgo: `guardarPerfilPatch` (lib/likida/repo.ts) hacía SELECT
-- perfil → mezclar en JS → UPDATE perfil, en dos statements separados. Dos
-- respuestas de la entrevista de onboarding mandadas casi juntas (doble
-- clic, dos pestañas) intercalan sus dos SELECT antes de que cualquiera
-- escriba: la segunda UPDATE pisa la primera con un `perfil` que nunca vio
-- su patch — un "lost update" de libro de texto. `tenant_perfil_merge` hace
-- la lectura Y la escritura en el MISMO statement (`perfil = perfil ||
-- patch` dentro del propio UPDATE), así que cada invocación siempre parte
-- del valor MÁS RECIENTE persistido, sin importar cuántas otras invocaciones
-- corrieron entre medio — a diferencia de un INSERT contra un índice único
-- (el patrón de los bloques 172/218/64), aquí no hay un árbitro que rechace
-- a un "perdedor": la prueba de la atomicidad es que DOS llamadas
-- SECUENCIALES, cada una con SU PROPIO patch y SIN que ninguna reciba el
-- perfil de la otra como argumento, terminan con las dos contribuciones
-- presentes — que es precisamente lo que el código viejo NO garantizaba
-- bajo concurrencia real (ahí sí hacía falta una carrera de verdad para
-- perder una escritura; aquí la garantía es estructural: el RPC nunca
-- mantiene una copia del perfil fuera de la fila).
--
-- (a) primera llamada aplica su patch sobre un perfil vacío; (b) segunda
-- llamada, patch DISTINTO, sin arrastrar el resultado de la primera como
-- argumento — el resultado final trae AMBAS claves; (c) el merge es
-- superficial: una clave repetida la gana el patch más reciente, las demás
-- sobreviven; (d) `perfil_actualizado_por` queda en el actor de la ÚLTIMA
-- llamada; (e) el trigger de la 0169 selló DOS versiones en
-- `tenant_perfil_version` (una por UPDATE real); (f) un tenant que no existe
-- falla cerrado (excepción, no perfil vacío ni silencio); (g) un patch que
-- no es un objeto jsonb (aquí, un arreglo) también falla cerrado, antes de
-- tocar la fila.
do $$
declare
  t uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb;
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  perfil_final jsonb;
  actualizado_final uuid;
  n_versiones int;
  tiene_ambas_claves boolean;
  clave_repetida_gana_ultima boolean;
  actor_es_ultimo boolean;
  sella_dos_versiones boolean;
  tenant_inexistente_falla boolean := false;
  patch_no_objeto_falla boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0296__');
  insert into public.app_user (id, tenant_id, email, rol) values (u1, t, 'verif-0296-u1@likida.ai', 'flota_admin');
  insert into public.app_user (id, tenant_id, email, rol) values (u2, t, 'verif-0296-u2@likida.ai', 'contador');

  -- (a) Primera "invocación": declara el stack de GPS.
  r1 := public.tenant_perfil_merge(t, jsonb_build_object('stackGps', 'samsara'), u1);

  -- (b) Segunda "invocación", CASI JUNTA a la primera en el mundo real: NO
  -- recibe `r1` como base — el RPC tiene que ir a buscar el valor vigente
  -- por su cuenta. Declara el umbral de ingresos, y de paso REPITE
  -- 'stackGps' con un valor distinto (para probar (c)).
  r2 := public.tenant_perfil_merge(t, jsonb_build_object('ingresosMenoresA300M', true, 'stackGps', 'geotab'), u2);

  select perfil, perfil_actualizado_por into perfil_final, actualizado_final
    from public.tenant where id = t;

  tiene_ambas_claves := (perfil_final ? 'ingresosMenoresA300M') and (perfil_final->>'ingresosMenoresA300M' = 'true');
  clave_repetida_gana_ultima := (perfil_final->>'stackGps') = 'geotab';
  actor_es_ultimo := actualizado_final = u2;

  select count(*) = 2 into sella_dos_versiones
    from public.tenant_perfil_version where tenant_id = t;

  -- (f) Tenant inexistente: falla cerrado, no devuelve un perfil de mentiras.
  begin
    perform public.tenant_perfil_merge(gen_random_uuid(), '{}'::jsonb, u1);
  exception when others then
    tenant_inexistente_falla := true;
  end;

  -- (g) Un patch que no es objeto (aquí, un arreglo jsonb): falla cerrado
  -- ANTES de tocar la fila — no hay `perfil = perfil || '[1,2]'` silencioso.
  begin
    perform public.tenant_perfil_merge(t, '[1,2]'::jsonb, u1);
  exception when others then
    patch_no_objeto_falla := true;
  end;

  raise exception E'TENANT_PERFIL_MERGE_0296  ambas-claves=%  repetida-gana-ultima=%  actor-ultimo=%  dos-versiones=%  tenant-inexistente-falla=%  patch-no-objeto-falla=%   (esperado t / t / t / t / t / t)',
    tiene_ambas_claves, clave_repetida_gana_ultima, actor_es_ultimo, sella_dos_versiones, tenant_inexistente_falla, patch_no_objeto_falla;
end $$;

-- ── 245. La terminal gana escritor: unidad.terminal_id atado al tenant, un patio por nombre, y el registro paginado cuenta de verdad (mig. 0298) ──
--
-- AUDITORÍA 24 (ADM-2 / producto-completitud, faltante 3). `terminal` era la
-- huérfana de la 0001 y `unidad` no tenía patio. La 0298 le da columna a la
-- unidad, unicidad al nombre del patio y lecturas paginadas en SQL para que
-- 800 tractos no viajen enteros a la pantalla.
--
-- Lo que solo la base puede demostrar:
--   (a) `uq_terminal_tenant_nombre`: «Patio Norte» y « patio norte » de la
--       MISMA flota chocan; el mismo nombre en OTRA flota convive.
--   (b) `unidad_terminal_tenant_fkey`: una unidad de la flota A NO puede
--       colgar de un patio de la flota B aunque el uuid exista.
--   (c) `on delete set null`: borrar el patio deja la unidad con
--       terminal_id NULL, no la borra.
--   (d) `operadores_registro_tenant`: con 3 operadores y límite 2, la página
--       trae 2 filas y `total`=3 (el total NO es el largo de la página); la
--       búsqueda «ramirez» encuentra a «Ramírez» (sin acentos).
--   (e) `unidades_conteos_tenant`: con una unidad vencida ayer, una que vence
--       en 10 días, una sin papeles y una de baja, los cuatro contadores
--       salen 1-1-0-1 y la baja no cuenta en ninguno.
-- Esperado: TERMINAL_ESCRITOR_0298 choca-variante=t otra-flota-ok=t patio-ajeno=f set-null=t pagina=2 total=3 busca=1 conteos=1-1-0-1
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  pa uuid; pb uuid; u1 uuid;
  choca_variante boolean := false;
  otra_flota_ok boolean := false;
  patio_ajeno boolean := true;
  set_null boolean := false;
  r jsonb; c jsonb;
  n_pagina int; n_total int; n_busca int;
  conteos text;
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0298_a__');
  insert into public.tenant (id, nombre) values (tb, '__verif_0298_b__');

  -- (a) un patio por nombre, por flota
  insert into public.terminal (tenant_id, nombre) values (ta, 'Patio Norte') returning id into pa;
  begin
    insert into public.terminal (tenant_id, nombre) values (ta, ' patio norte ');
  exception when unique_violation then choca_variante := true;
  end;
  begin
    insert into public.terminal (tenant_id, nombre) values (tb, 'Patio Norte') returning id into pb;
    otra_flota_ok := true;
  exception when others then otra_flota_ok := false;
  end;

  -- (b) la unidad de A no cuelga del patio de B
  begin
    insert into public.unidad (tenant_id, numero_economico, terminal_id) values (ta, 'T-01', pb);
    patio_ajeno := true;
  exception when foreign_key_violation then patio_ajeno := false;
  end;

  -- (c) borrar el patio deja la unidad, con terminal_id NULL
  insert into public.unidad (tenant_id, numero_economico, terminal_id) values (ta, 'T-02', pa) returning id into u1;
  delete from public.terminal where id = pa;
  select (terminal_id is null) into set_null from public.unidad where id = u1;

  -- (d) el registro paginado cuenta de verdad y busca sin acentos
  insert into public.operador (tenant_id, nombre, telefono) values
    (ta, 'Juan Ramírez', '525511111101'),
    (ta, 'Pedro López', '525511111102'),
    (ta, 'Ana Torres',  '525511111103');
  r := public.operadores_registro_tenant(ta, null, 0, 2);
  n_pagina := jsonb_array_length(r -> 'filas');
  n_total  := (r ->> 'total')::int;
  r := public.operadores_registro_tenant(ta, 'ramirez', 0, 25);
  n_busca := jsonb_array_length(r -> 'filas');

  -- (e) los contadores de papeles van sobre la flota entera, activas nada más
  insert into public.unidad (tenant_id, numero_economico, poliza_vence) values (ta, 'T-03', date '2026-09-01' - 1);
  insert into public.unidad (tenant_id, numero_economico, verificacion_vence) values (ta, 'T-04', date '2026-09-01' + 10);
  insert into public.unidad (tenant_id, numero_economico, poliza_vence, activo) values (ta, 'T-05', date '2026-09-01' - 40, false);
  -- T-02 (de arriba) es la que no tiene papeles.
  c := public.unidades_conteos_tenant(ta, date '2026-09-01', 30);
  conteos := (c ->> 'vencidos') || '-' || (c ->> 'porVencer') || '-' || (c ->> 'vigentes') || '-' || (c ->> 'sinDato');

  raise exception E'TERMINAL_ESCRITOR_0298 choca-variante=% otra-flota-ok=% patio-ajeno=% set-null=% pagina=% total=% busca=% conteos=%   (esperado t / t / f / t / 2 / 3 / 1 / 1-1-0-1)',
    choca_variante, otra_flota_ok, patio_ajeno, set_null, n_pagina, n_total, n_busca, conteos;
end $$;


-- ── 246. `revisar_liquidacion`: aprobar firma una vez, ajustar en negativo rebota, rechazar reabre a en_cuadre, y la revisión no se toca por fuera (mig. 0299) ──
--
-- AUDITORÍA 24, BLOQUEANTE 6. «Tú firmas lo que la máquina cuadró» no tenía
-- botón: cero UPDATE sobre `liquidacion.revision` porque la columna no
-- existía. Este bloque ataca la RPC nueva por sus cuatro costados:
--   (a) un UPDATE suelto de `revision` rebota (LR003): la firma solo entra por
--       la RPC, que deja quién/cuándo/por qué;
--   (b) aprobar firma (`aprobada`, revisada_por = la persona) y deja bitácora
--       en la MISMA transacción;
--   (c) la segunda aprobación rebota (LR010): una firma no se pone dos veces;
--   (d) ajustar con monto ≤ 0 rebota (LR016) y NO mueve ni el gasto ni el total;
--   (e) ajustar bien mueve `gasto.monto`, el total y la diferencia por la
--       delta, y queda `ajustada` con el arreglo de ajustes;
--   (f) rechazar deja `rechazada` y devuelve el viaje a `en_cuadre` — y tras
--       el rechazo el chofer SÍ puede volver a mandar un ticket (la 0036 ya no
--       cuenta esa liquidación como emitida).
-- Esperado: REVISAR_LIQUIDACION_0299 suelto-rebota=t aprobada=t bitacora=t doble-rebota=t negativo-rebota=t negativo-intacto=t ajustada=t delta-ok=t rechazada=t en-cuadre=t ticket-tras-rechazo=t
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid(); v_o uuid; v_o2 uuid; v_o3 uuid;
  v_v1 uuid; v_v2 uuid; v_v3 uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid; v_g uuid;
  r jsonb;
  suelto_rebota boolean := false; aprobada boolean := false; bitacora boolean := false;
  doble_rebota boolean := false; negativo_rebota boolean := false; negativo_intacto boolean := false;
  ajustada boolean := false; delta_ok boolean := false; rechazada boolean := false;
  en_cuadre boolean := false; ticket_tras_rechazo boolean := false;
  n_monto numeric; n_total numeric; n_dif numeric; est text; rev text; quien uuid;
begin
  insert into tenant (nombre) values ('ZZZ VERIF REVISION 0299') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-revisa-0299@likida.test', 'flota_admin');
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P1', '520000009901') returning id into v_o;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P2', '520000009902') returning id into v_o2;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P3', '520000009903') returning id into v_o3;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o, 'R-1', 5000) returning id into v_v1;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o2, 'R-2', 5000) returning id into v_v2;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o3, 'R-3', 5000) returning id into v_v3;

  -- Un ticket leído como $800 que era de $8,000 (WA-3), en el viaje 2.
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v2, 'diesel', 800) returning id into v_g;

  v_l1 := guardar_liquidacion_tx(v_t, v_v1, 4200, 5000, 800, 'revisar', '[]'::jsonb, 0,0,0, null, 0);
  v_l2 := guardar_liquidacion_tx(v_t, v_v2,  800, 5000, 4200, 'revisar', '[]'::jsonb, 0,0,0, null, 0);
  v_l3 := guardar_liquidacion_tx(v_t, v_v3, 4900, 5000, 100, 'con_diferencias', '[]'::jsonb, 0,0,0, null, 0);

  -- (a) la firma no entra por la puerta de atrás.
  begin
    update liquidacion set revision = 'aprobada', revisada_en = now() where id = v_l1;
  exception when sqlstate 'LR003' then suelto_rebota := true;
  end;

  -- (b) aprobar.
  r := revisar_liquidacion(v_t, v_l1, 'aprobar', null, null, v_u, null);
  select revision, revisada_por into rev, quien from liquidacion where id = v_l1;
  aprobada := (rev = 'aprobada' and quien = v_u and (r ->> 'revision') = 'aprobada');
  bitacora := exists (select 1 from bitacora_auditoria
                       where tenant_id = v_t and accion = 'liquidacion.aprobada'
                         and entidad = 'liquidacion' and entidad_id = v_l1::text and actor_id = v_u);

  -- (c) no se firma dos veces.
  begin
    perform revisar_liquidacion(v_t, v_l1, 'aprobar', null, null, v_u, null);
  exception when sqlstate 'LR010' then doble_rebota := true;
  end;

  -- (d) un ajuste a negativo rebota y no deja nada movido. p_recalculo va
  -- con CUALQUIER forma válida a propósito (mig. 0306): lo que este caso
  -- prueba es que el monto negativo (LR016) rebota ANTES de llegar a
  -- comparar el recálculo con nada.
  begin
    perform revisar_liquidacion(v_t, v_l2, 'ajustar', 'se leyó mal',
      jsonb_build_array(jsonb_build_object('gastoId', v_g, 'montoNuevo', -5)), v_u, null,
      jsonb_build_object('totalComprobado', 0, 'diferencia', 0, 'estatus', 'revisar', 'diferencias', '[]'::jsonb,
        'iepsAcreditable', 0, 'litrosDieselAcreditables', 0, 'ivaAcreditable', 0, 'peajeAcreditable', 0));
  exception when sqlstate 'LR016' then negativo_rebota := true;
  end;
  select monto into n_monto from gasto where id = v_g;
  select total_comprobado, revision into n_total, rev from liquidacion where id = v_l2;
  negativo_intacto := (n_monto = 800 and n_total = 800 and rev = 'pendiente');

  -- (e) el ajuste bueno: $800 → $8,000, delta +7,200 sobre el total y la
  -- diferencia. AUDITORÍA 25 (mig. 0306): p_recalculo ya es obligatorio —
  -- el octavo argumento es lo que `revision_recalculo.ts` arma con
  -- `cuadrarDesdeDB` en TypeScript; aquí se le da el mismo total/diferencia
  -- que la delta ya predice, que es justo lo que LR020 exige que coincida.
  r := revisar_liquidacion(v_t, v_l2, 'ajustar', 'el ticket dice 8,000, el OCR leyó 800',
    jsonb_build_array(jsonb_build_object('gastoId', v_g, 'montoNuevo', 8000)), v_u, null,
    jsonb_build_object(
      'totalComprobado', 8000, 'diferencia', -3000, 'estatus', 'con_diferencias',
      'diferencias', '[]'::jsonb, 'iepsAcreditable', 0, 'litrosDieselAcreditables', 0,
      'ivaAcreditable', 1200, 'peajeAcreditable', 0
    ));
  select monto into n_monto from gasto where id = v_g;
  select total_comprobado, diferencia, revision into n_total, n_dif, rev from liquidacion where id = v_l2;
  ajustada := (rev = 'ajustada' and jsonb_array_length((select ajustes from liquidacion where id = v_l2)) = 1);
  delta_ok := (n_monto = 8000 and n_total = 8000 and n_dif = -3000);

  -- (f) rechazar reabre a en_cuadre y el ticket tardío YA entra.
  r := revisar_liquidacion(v_t, v_l3, 'rechazar', 'faltan las casetas del regreso', null, v_u, null);
  select revision into rev from liquidacion where id = v_l3;
  select estatus into est from viaje where id = v_v3;
  rechazada := (rev = 'rechazada');
  en_cuadre := (est = 'en_cuadre');
  begin
    insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v3, 'caseta', 120);
    ticket_tras_rechazo := true;
  exception when others then ticket_tras_rechazo := false;
  end;

  raise exception E'REVISAR_LIQUIDACION_0299  suelto-rebota=%  aprobada=%  bitacora=%  doble-rebota=%  negativo-rebota=%  negativo-intacto=%  ajustada=%  delta-ok=%  rechazada=%  en-cuadre=%  ticket-tras-rechazo=%   (esperado t / t / t / t / t / t / t / t / t / t / t)',
    suelto_rebota, aprobada, bitacora, doble_rebota, negativo_rebota, negativo_intacto,
    ajustada, delta_ok, rechazada, en_cuadre, ticket_tras_rechazo;
end $$;


-- ── 247. La revisión en la tabla: cuadró sola = firme por el motor, el re-cierre retira la firma, y viaje.estatus no contradice a la revisión (mig. 0299) ──
--
-- Lo que la RPC no puede garantizar sola (DAT-6: «la coherencia se puso en la
-- RPC y no en la tabla»):
--   (a) una liquidación `cuadrada` nace `aprobada` con revisada_por NULL (la
--       firmó el motor): «tú firmas lo que NO cuadró»;
--   (b) el re-cierre del motor (upsert de guardar_liquidacion_tx) con cifras
--       distintas RETIRA la firma humana: vuelve a `pendiente` sin firmante;
--   (c) el mismo re-cierre sobre una RECHAZADA la devuelve a `pendiente` y el
--       viaje a `liquidado` — el ciclo cierra;
--   (d) un UPDATE suelto que devuelve a `abierto` un viaje con liquidación
--       firmada por una persona rebota al confirmar (23514, trigger diferido);
--   (e) `reabrir_viaje_tx` sobre ese mismo viaje SÍ pasa: abre el viaje y
--       retira la liquidación en la misma transacción, y al commit no hay
--       contradicción que comprobar.
-- Esperado: REVISION_TABLA_0299 sola-firme=t sin-humano=t recierre-retira=t rechazada-vuelve=t viaje-liquidado=t suelto-rebota=t reabrir-pasa=t
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid(); v_o uuid; v_o2 uuid; v_o3 uuid;
  v_v1 uuid; v_v2 uuid; v_v3 uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid;
  sola_firme boolean := false; sin_humano boolean := false; recierre_retira boolean := false;
  rechazada_vuelve boolean := false; viaje_liquidado boolean := false;
  suelto_rebota boolean := false; reabrir_pasa boolean := false;
  rev text; quien uuid; est text;
begin
  insert into tenant (nombre) values ('ZZZ VERIF REVISION TABLA 0299') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-revisa-tabla-0299@likida.test', 'flota_admin');
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P1', '520000009911') returning id into v_o;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P2', '520000009912') returning id into v_o2;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P3', '520000009913') returning id into v_o3;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o,  'T-1', 5000) returning id into v_v1;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o2, 'T-2', 5000) returning id into v_v2;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o3, 'T-3', 5000) returning id into v_v3;

  -- (a) cuadró sola.
  v_l1 := guardar_liquidacion_tx(v_t, v_v1, 5000, 5000, 0, 'cuadrada', '[]'::jsonb, 0,0,0, null, 0);
  select revision, revisada_por into rev, quien from liquidacion where id = v_l1;
  sola_firme := (rev = 'aprobada');
  sin_humano := (quien is null);

  -- (b) firmada por persona, luego re-cerrada con otras cifras.
  v_l2 := guardar_liquidacion_tx(v_t, v_v2, 4200, 5000, 800, 'revisar', '[]'::jsonb, 0,0,0, null, 0);
  perform revisar_liquidacion(v_t, v_l2, 'aprobar', null, null, v_u, null);
  perform guardar_liquidacion_tx(v_t, v_v2, 4300, 5000, 700, 'revisar', '[]'::jsonb, 0,0,0, null, 0);
  select revision, revisada_por into rev, quien from liquidacion where id = v_l2;
  recierre_retira := (rev = 'pendiente' and quien is null);

  -- (c) rechazada, y el motor vuelve a cuadrar.
  v_l3 := guardar_liquidacion_tx(v_t, v_v3, 4900, 5000, 100, 'con_diferencias', '[]'::jsonb, 0,0,0, null, 0);
  perform revisar_liquidacion(v_t, v_l3, 'rechazar', 'faltan casetas', null, v_u, null);
  perform guardar_liquidacion_tx(v_t, v_v3, 5000, 5000, 0, 'cuadrada', '[]'::jsonb, 0,0,0, null, 0);
  select revision into rev from liquidacion where id = v_l3;
  select estatus into est from viaje where id = v_v3;
  rechazada_vuelve := (rev = 'aprobada');   -- cuadró sola esta vez: firme por el motor
  viaje_liquidado := (est = 'liquidado');

  -- (d) el S9 de DAT-6: firmada por persona y alguien la abre con un UPDATE.
  perform revisar_liquidacion(v_t, v_l2, 'aprobar', null, null, v_u, null);
  begin
    update viaje set estatus = 'abierto' where id = v_v2;
    set constraints all immediate;   -- lo que pasaría al commit, ahora
  exception when check_violation then suelto_rebota := true;
  end;
  set constraints all deferred;

  -- (e) el camino auditado sí pasa.
  begin
    perform reabrir_viaje_tx(v_t, v_v2);
    set constraints all immediate;
    select estatus into est from viaje where id = v_v2;
    reabrir_pasa := (est = 'abierto' and not exists (select 1 from liquidacion where id = v_l2));
  exception when others then reabrir_pasa := false;
  end;

  raise exception E'REVISION_TABLA_0299  sola-firme=%  sin-humano=%  recierre-retira=%  rechazada-vuelve=%  viaje-liquidado=%  suelto-rebota=%  reabrir-pasa=%   (esperado t / t / t / t / t / t / t)',
    sola_firme, sin_humano, recierre_retira, rechazada_vuelve, viaje_liquidado, suelto_rebota, reabrir_pasa;
end $$;

-- ── 241. Un usuario dado de baja (`app_user.activo = false`) no tiene tenant ni permisos para RLS (mig. 0294) ──
--
-- AUDITORÍA 24, SEG-1 (ALTO) / H5. Hasta la 0294 no había baja: el contador
-- externo que dejó de trabajar con la flota conservaba su cookie y sus
-- permisos. Lo que este bloque asevera es la SEGUNDA capa —la base—: con un
-- JWT todavía vigente, un usuario con `activo = false` obtiene de las cuatro
-- funciones de RLS lo mismo que un extraño (cero tenants, cero permisos), y
-- por tanto `tenant_data` no le devuelve una sola fila aunque la capa de app
-- tuviera un hueco. El usuario ACTIVO de la misma flota sigue entero (control).
-- Esperado: RLS_USUARIO_INACTIVO_0294 activo-tenants=1 activo-administra=t inactivo-tenants=0 inactivo-finanzas=f inactivo-administra=f inactivo-superadmin=f
do $$
declare
  t uuid := gen_random_uuid();
  u_activo uuid := gen_random_uuid();
  u_baja uuid := gen_random_uuid();
  activo_tenants int; activo_administra boolean;
  baja_tenants int; baja_finanzas boolean; baja_administra boolean; baja_superadmin boolean;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0294__');
  insert into public.app_user (id, tenant_id, email, nombre, rol)
    values (u_activo, t, 'activo-0294@verif.local', 'Activo', 'flota_admin');
  -- El superadmin dado de baja es el caso más caro: `is_superadmin()` abre
  -- TODAS las flotas, y es exactamente lo que no puede sobrevivir a la baja.
  insert into public.app_user (id, tenant_id, email, nombre, rol, activo, desactivado_en, desactivado_por)
    values (u_baja, t, 'baja-0294@verif.local', 'Baja', 'superadmin', false, now(), u_activo);

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u_activo)::text, true);
  activo_tenants    := coalesce(array_length(public.get_user_tenant_ids(), 1), 0);
  activo_administra := public.administra_flota();

  perform set_config('request.jwt.claims', json_build_object('sub', u_baja)::text, true);
  baja_tenants    := coalesce(array_length(public.get_user_tenant_ids(), 1), 0);
  baja_finanzas   := public.ve_finanzas();
  baja_administra := public.administra_flota();
  baja_superadmin := public.is_superadmin();
  reset role;

  raise exception E'RLS_USUARIO_INACTIVO_0294  activo-tenants=%  activo-administra=%  inactivo-tenants=%  inactivo-finanzas=%  inactivo-administra=%  inactivo-superadmin=%   (esperado 1 / t / 0 / f / f / f)',
    activo_tenants, activo_administra, baja_tenants, baja_finanzas, baja_administra, baja_superadmin;
end $$;

-- ── 242. Una llave de API puede caducar, y no puede nacer ya vencida (mig. 0294) ──
--
-- AUDITORÍA 24, SEG-8. `tenant_api_key.expira_en` es opcional (null = no
-- caduca, decisión explícita). Lo que la base demuestra: (a) una llave con
-- `expira_en` anterior a `creada_en` rebota (el CHECK), (b) una con fecha
-- futura entra, (c) sin fecha sigue entrando. Que el camino caliente la
-- rechace vencida se prueba en TS (llave-api.test.ts).
-- Esperado: LLAVE_API_EXPIRA_0294 pasado-rebota=t futuro-ok=t nulo-ok=t
do $$
declare
  t uuid := gen_random_uuid();
  pasado_rebota boolean := false;
  futuro_ok boolean := false;
  nulo_ok boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0294_llaves__');

  begin
    insert into public.tenant_api_key (tenant_id, nombre, prefijo, hash, expira_en)
      values (t, 'vencida al nacer', 'lk_live_aaaaaa', repeat('a', 64), now() - interval '1 day');
  exception when check_violation then pasado_rebota := true;
  end;

  begin
    insert into public.tenant_api_key (tenant_id, nombre, prefijo, hash, expira_en)
      values (t, 'un año', 'lk_live_bbbbbb', repeat('b', 64), now() + interval '365 days');
    futuro_ok := true;
  exception when others then futuro_ok := false;
  end;

  begin
    insert into public.tenant_api_key (tenant_id, nombre, prefijo, hash)
      values (t, 'sin caducidad', 'lk_live_cccccc', repeat('c', 64));
    nulo_ok := true;
  exception when others then nulo_ok := false;
  end;

  raise exception E'LLAVE_API_EXPIRA_0294  pasado-rebota=%  futuro-ok=%  nulo-ok=%   (esperado t / t / t)',
    pasado_rebota, futuro_ok, nulo_ok;
end $$;

-- ── 234. La cancelación ARCO borra la conversación por teléfono NORMALIZADO y su search_path vive en la base (mig. 0286) ──
--
-- AUDITORÍA 24, DAT-2 / LEG-2 (CRÍTICO, reincidente de DATOS-23-2). El bloque
-- 210 pasaba en verde con `"wa_conversacion": 0` porque su fixture no insertaba
-- conversación; la app la crea por TELÉFONO (`loadConversation`) y nunca llena
-- `operador_id`, así que el `delete … where operador_id = v_operador` borraba
-- cero filas mientras el panel decía «el titular quedó anonimizado».
--
-- Aquí la conversación se inserta COMO LA CREA LA APP (sin `operador_id`) y
-- además con OTRA variante del mismo celular (`529…` contra el `521…` del
-- operador): la 0274 ya declaró que son el mismo número.
--
--   (a) la conversación del titular desaparece;
--   (b) la evidencia lo cuenta (wa_conversacion = 1, envio_mensaje = 1);
--   (c) DATOS-23-5: el evento de OTRO titular ya anonimizado NO se reescribe;
--   (d) DAT-1: `pg_proc.proconfig` de la función —EN LA BASE, no en el
--       archivo— trae `extensions` (sin él, digest() truena en gestionado).
do $$
declare
  t uuid := gen_random_uuid(); op uuid := gen_random_uuid(); otro uuid := gen_random_uuid();
  inc_otro uuid := gen_random_uuid(); sol uuid := gen_random_uuid();
  ev jsonb; n_conv int; n_envio int; txt_otro text; cfg text;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0286__');
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op, t, 'Juan Pérez', '5219993700779');
  -- La conversación tal cual la escribe conv.ts: por teléfono, sin operador_id,
  -- y en la variante SIN el "1" de Telmex.
  insert into public.wa_conversacion (tenant_id, telefono, estado)
    values (t, '529993700779', '{"turns": []}'::jsonb);
  insert into public.envio_mensaje (tenant_id, telefono, canal, estado)
    values (t, '+5219993700779', 'whatsapp', 'enviado');

  -- Otro titular, YA anonimizado por una cancelación anterior: su evento no
  -- debe volver a tocarse (DATOS-23-5).
  insert into public.operador (id, tenant_id, nombre, telefono, anonimizado_en)
    values (otro, t, 'Operador AAAAAA', 'anon:0000000000000000', now());
  insert into public.incidencia (id, tenant_id, operador_id, tipo, prioridad, descripcion, texto_anonimizado_en)
    values (inc_otro, t, null, 'siniestro', 'critica', '[texto retirado por cancelación ARCO del titular]', now() - interval '1 day');
  insert into public.incidencia_evento (tenant_id, incidencia_id, tipo, detalle)
    values (t, inc_otro, 'mensaje_adicional', jsonb_build_object('texto', 'marca intacta del otro titular'));

  insert into public.solicitud_arco (id, tenant_id, operador_id, tipo, canal, vence_en)
    values (sol, t, op, 'cancelacion', 'whatsapp', current_date + 15);

  perform public.ejecutar_arco_cancelacion(t, sol);

  select count(*) into n_conv from public.wa_conversacion
    where tenant_id = t and public.telefono_normalizado(telefono) = public.telefono_normalizado('5219993700779');
  select count(*) into n_envio from public.envio_mensaje
    where tenant_id = t and public.telefono_normalizado(telefono) = public.telefono_normalizado('5219993700779');
  select s.evidencia into ev from public.solicitud_arco s where s.id = sol;
  select e.detalle->>'texto' into txt_otro from public.incidencia_evento e where e.incidencia_id = inc_otro;
  select array_to_string(p.proconfig, ' ') into cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ejecutar_arco_cancelacion';

  raise exception E'ARCO_TELEFONO_NORM_0286  conv-vivas=%  envios-vivos=%  evidencia-conv=%  evidencia-envio=%  otro-intacto=%  proconfig-extensions=%   (esperado 0 / 0 / 1 / 1 / t / t)',
    n_conv, n_envio, ev->>'wa_conversacion', ev->>'envio_mensaje',
    txt_otro = 'marca intacta del otro titular', cfg like '%extensions%';
end $$;

-- ── 235. `ultimas_posiciones_tenant` y `estado_rastreo_tenant` sondean por unidad, no barren el tenant (mig. 0287) ──
--
-- AUDITORÍA 24, DAT-8 / REN-3 (ALTO). El `distinct on` de la 0269 leía TODAS
-- las posiciones de la flota para quedarse con 800 (4.5 s con 6.9 M filas).
-- Se asevera lo que la base puede demostrar:
--   (a) el RESULTADO es el mismo que el `distinct on`: una fila por unidad
--       activa, la más reciente, sin la unidad inactiva ni la de otra flota;
--   (b) el PLAN del cuerpo vigente no tiene nodo `Unique` (no hay distinct
--       on) y sondea `posicion` con un Index Scan Backward sobre
--       `uq_posicion_lectura` — con `enable_seqscan` apagado para que la
--       tabla diminuta de la prueba no esconda la forma;
--   (c) `estado_rastreo_tenant` conserva su contrato: 2 unidades con
--       posición (una inactiva cuenta, como en la 0162) y la última fecha;
--   (d) una lectura fechada en el futuro (reloj del GPS mal) rebota (23514).
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); ux uuid := gen_random_uuid();
  n_filas int; lat_u1 double precision; con_unique boolean; con_indice boolean;
  plan text := ''; linea text; cuerpo text; rastreo jsonb; futura_rebota boolean := false;
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0287_a__'), (tb, '__verif_0287_b__');
  insert into public.unidad (id, tenant_id, numero_economico, activo) values
    (u1, ta, 'U1', true), (u2, ta, 'U2', true), (u3, ta, 'U3-baja', false), (ux, tb, 'UX', true);
  insert into public.posicion (tenant_id, unidad_id, lat, lng, medida_en, proveedor) values
    (ta, u1, 19.0, -99.0, now() - interval '2 hours', 'samsara'),
    (ta, u1, 19.5, -99.5, now() - interval '1 hour',  'samsara'),   -- la más reciente de U1
    (ta, u2, 20.0, -100.0, now() - interval '3 days', 'samsara'),
    (ta, u3, 21.0, -101.0, now() - interval '1 hour', 'samsara'),   -- inactiva: fuera del mapa
    (tb, ux, 22.0, -102.0, now() - interval '1 hour', 'samsara');   -- otra flota

  select count(*) into n_filas from public.ultimas_posiciones_tenant(ta);
  select r.lat into lat_u1 from public.ultimas_posiciones_tenant(ta) r where r.unidad_id = u1;

  -- La función lleva `set search_path`, así que el planificador NO la inlinea
  -- y `explain select * from f()` solo enseña «Function Scan». Se explica el
  -- CUERPO vigente leído de pg_proc — lo que de verdad corre en esta base.
  select prosrc into cuerpo from pg_proc where proname = 'ultimas_posiciones_tenant'
    and pronamespace = 'public'::regnamespace;
  -- Con las 2 filas del fixture un Seq Scan es LEGÍTIMAMENTE más barato, así
  -- que sin esto el plan variaría con el volumen y la prueba sería una moneda
  -- al aire. Lo que se asevera es la FORMA, no el costo.
  set local enable_seqscan = off;
  for linea in execute 'explain (costs off) ' || replace(cuerpo, 'p_tenant', '$1') using ta loop
    plan := plan || linea || E'\n';
  end loop;
  reset enable_seqscan;

  -- `Unique` es la firma del `distinct on` de la 0269: barrer TODAS las
  -- posiciones del tenant y desduplicar. Es la regresión que esto vigila.
  con_unique := plan like '%Unique%';
  -- La forma `lateral`: un sondeo POR UNIDAD (`Nested Loop` + `Limit`) que
  -- entra por índice a `posicion`. Se comprueba la forma y NO el nombre del
  -- índice: `uq_posicion_lectura (tenant, unidad, medida_en)` y
  -- `posicion_unidad_medida_idx (… medida_en desc)` sirven las dos, y cuál
  -- elige el planificador depende de cuáles existan el día que corra.
  con_indice := plan like '%Nested Loop%'
            and plan like '%Limit%'
            and plan like '%Index Scan%on posicion p%';

  rastreo := public.estado_rastreo_tenant(ta);

  begin
    insert into public.posicion (tenant_id, unidad_id, lat, lng, medida_en, proveedor)
      values (ta, u1, 19.0, -99.0, now() + interval '2 hours', 'samsara');
  exception when check_violation then futura_rebota := true;
  end;

  raise exception E'POSICIONES_LATERAL_0287  filas=%  u1-mas-reciente=%  plan-sin-unique=%  plan-por-indice=%  rastreo-unidades=%  rastreo-ultima-hoy=%  futura-rebota=%   (esperado 2 / t / t / t / 3 / t / t)',
    n_filas, lat_u1 = 19.5, not con_unique, con_indice,
    rastreo->>'unidadesConPosicion', (rastreo->>'ultimaPosicion')::timestamptz > now() - interval '2 hours', futura_rebota;
end $$;

-- ── 236. `wa_outbox` y `evento_seguridad_flota` tienen plazo, y `posicion` ya no paga índices repetidos (mig. 0288) ──
--
-- AUDITORÍA 24, DAT-9 / REN-4 (MEDIO). Dos tablas que crecían sin purga —la
-- bandeja de salida con su payload y la telemetría de cámara con lat/lng— y
-- una tabla de 230k filas/día con dos índices repetidos y ninguno que
-- sirviera al `delete … where medida_en < X` nocturno.
--
--   (a) el outbox: lo `sent` viejo se va, lo `sent` reciente y lo `pending`
--       viejo (trabajo por hacer) se quedan;
--   (b) los eventos: el leve viejo se va, el grave de 200 días se queda
--       (dura 365), el grave de 400 se va, el leve reciente se queda;
--   (c) `mantenimiento_de_datos` los reporta con nombre;
--   (d) el catálogo de `posicion`: sin `posicion_unidad_medida_idx` ni
--       `posicion_sin_duplicado`, con `posicion_medida_idx`, y ninguna
--       pareja de índices con la misma definición.
do $$
declare
  t uuid := gen_random_uuid();
  o_sent_viejo uuid := gen_random_uuid(); o_sent_nuevo uuid := gen_random_uuid(); o_pending_viejo uuid := gen_random_uuid();
  r jsonb; m jsonb;
  outbox_quedan int; leve_viejo int; grave_200 int; grave_400 int; leve_nuevo int;
  sin_dup boolean; con_medida boolean; repetidos int;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0288__');
  insert into public.wa_outbox (id, payload, estado, creada_en, enviada_en) values
    (o_sent_viejo,    '{}'::jsonb, 'sent',    now() - interval '91 days', now() - interval '91 days'),
    (o_sent_nuevo,    '{}'::jsonb, 'sent',    now() - interval '10 days', now() - interval '10 days'),
    (o_pending_viejo, '{}'::jsonb, 'pending', now() - interval '200 days', null);
  insert into public.evento_seguridad_flota (tenant_id, proveedor, evento_id_externo, etiquetas, grave, lat, lng, ocurrido_en) values
    (t, 'samsara', 'leve-viejo',  '{harsh_brake}', false, 19.0, -99.0, now() - interval '181 days'),
    (t, 'samsara', 'grave-200',   '{crash}',       true,  19.0, -99.0, now() - interval '200 days'),
    (t, 'samsara', 'grave-400',   '{crash}',       true,  19.0, -99.0, now() - interval '400 days'),
    (t, 'samsara', 'leve-nuevo',  '{harsh_brake}', false, 19.0, -99.0, now() - interval '10 days');

  r := public.purgar_wa_outbox(90, now(), null);
  m := public.mantenimiento_de_datos(30, now());

  select count(*) into outbox_quedan from public.wa_outbox where id in (o_sent_viejo, o_sent_nuevo, o_pending_viejo);
  select count(*) into leve_viejo from public.evento_seguridad_flota where tenant_id = t and evento_id_externo = 'leve-viejo';
  select count(*) into grave_200  from public.evento_seguridad_flota where tenant_id = t and evento_id_externo = 'grave-200';
  select count(*) into grave_400  from public.evento_seguridad_flota where tenant_id = t and evento_id_externo = 'grave-400';
  select count(*) into leve_nuevo from public.evento_seguridad_flota where tenant_id = t and evento_id_externo = 'leve-nuevo';

  -- Sólo `posicion_sin_duplicado` se retira (un único MÁS LAXO que
  -- `uq_posicion_lectura`, que ningún `on conflict` de src/ nombra).
  -- `posicion_unidad_medida_idx` SE QUEDA aunque repita la clave de
  -- `uq_posicion_lectura`: el bloque GPS_0176 lo asevera por nombre desde
  -- mucho antes de esta ronda, y retirarlo exige cambiar ese bloque en el
  -- mismo movimiento. Queda anotado en el CIERRE de la auditoría 24.
  sin_dup := not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posicion'
                           and indexname = 'posicion_sin_duplicado');
  con_medida := exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posicion'
                          and indexname = 'posicion_medida_idx');
  select count(*) into repetidos from (
    select regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \S+ ON', '') as def
      from pg_indexes where schemaname = 'public' and tablename = 'posicion'
     group by 1 having count(*) > 1) d;

  raise exception E'PURGAS_0288  outbox-quedan=%  outbox-borrado-directo=%  leve-viejo=%  grave-200=%  grave-400=%  leve-nuevo=%  mant-outbox=%  mant-eventos=%  sin-indices-repetidos=%  con-indice-purga=%  definiciones-repetidas=%   (esperado 2 / 1 / 0 / 1 / 0 / 1 / t / t / t / t / 0)',
    outbox_quedan, r->>'borradas', leve_viejo, grave_200, grave_400, leve_nuevo,
    m ? 'waOutboxPurgado', (m->>'eventosSeguridadPurgados')::int >= 2, sin_dup, con_medida, repetidos;
end $$;

-- ── 237. La geolocalización del pin de asistencia se retira a los 90 días de resuelta la incidencia (mig. 0289) ──
--
-- AUDITORÍA 24, LEG-6 (ALTO). El aviso dice «se borra a los 90 días» y
-- `incidencia.lat/lng` e `incidencia_evento.detalle->lat/lng` vivían para
-- siempre. Se asevera:
--   (a) resuelta hace 91 días: lat/lng en NULL y el evento sin lat/lng pero
--       CON la marca `geolocalizacion_purgada_en` (el hueco no se lee como
--       «nunca hubo pin») y con el renglón vivo;
--   (b) resuelta hace 30 días: intacta;
--   (c) ABIERTA hace 200 días: intacta — el pin es la herramienta de la mesa
--       mientras el expediente sigue abierto;
--   (d) `mantenimiento_de_datos` lo reporta con nombre.
do $$
declare
  t uuid := gen_random_uuid(); op uuid := gen_random_uuid();
  i91 uuid := gen_random_uuid(); i30 uuid := gen_random_uuid(); iab uuid := gen_random_uuid();
  r jsonb; m jsonb;
  lat91 double precision; lat30 double precision; latab double precision;
  det91 jsonb; det30 jsonb; eventos_91 int;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0289__');
  insert into public.operador (id, tenant_id, nombre, telefono) values (op, t, 'Chofer', '+520000028901');
  insert into public.incidencia (id, tenant_id, operador_id, tipo, prioridad, estado, descripcion, lat, lng, resuelta_en) values
    (i91, t, op, 'siniestro', 'critica', 'resuelta', 'choque km 84', 19.1, -99.1, now() - interval '91 days'),
    (i30, t, op, 'varado',    'alta',    'resuelta', 'varado',       19.2, -99.2, now() - interval '30 days'),
    (iab, t, op, 'robo',      'critica', 'abierta',  'robo',         19.3, -99.3, null);
  insert into public.incidencia_evento (tenant_id, incidencia_id, tipo, detalle) values
    (t, i91, 'ubicacion_anclada', jsonb_build_object('lat', 19.1, 'lng', -99.1)),
    (t, i91, 'mensaje_adicional', jsonb_build_object('texto', 'ya llegó la grúa')),
    (t, i30, 'ubicacion_anclada', jsonb_build_object('lat', 19.2, 'lng', -99.2));

  r := public.purgar_geolocalizacion_incidencia(90, now());
  m := public.mantenimiento_de_datos(30, now());

  select lat into lat91 from public.incidencia where id = i91;
  select lat into lat30 from public.incidencia where id = i30;
  select lat into latab from public.incidencia where id = iab;
  select detalle into det91 from public.incidencia_evento where incidencia_id = i91 and tipo = 'ubicacion_anclada';
  select detalle into det30 from public.incidencia_evento where incidencia_id = i30 and tipo = 'ubicacion_anclada';
  select count(*) into eventos_91 from public.incidencia_evento where incidencia_id = i91;

  raise exception E'GEO_INCIDENCIA_0289  lat-91-nula=%  evento-91-sin-lat=%  evento-91-marcado=%  eventos-91-vivos=%  lat-30=%  evento-30-con-lat=%  lat-abierta=%  purgadas=%  mant-reporta=%   (esperado t / t / t / 2 / 19.2 / t / 19.3 / 1 / t)',
    lat91 is null, not (det91 ? 'lat'), det91 ? 'geolocalizacion_purgada_en', eventos_91, lat30, det30 ? 'lat', latab,
    r->>'incidencias', m ? 'incidenciaGeoPurgada';
end $$;

-- ── 238. Teléfono, RFC y placas tienen forma; el operador ligado es de la flota (mig. 0290) ──
--
-- AUDITORÍA 24, DAT-10 y DAT-11 (MEDIO). Lo que se asevera:
--   (a) `telefono = 'abc'` ya NO entra (23514) — y con eso desaparece el
--       choque entre flotas: dos operadores sin celular en tenants distintos
--       reventaban con `uq_operador_telefono_activo Key ()=()`;
--   (b) un teléfono de verdad sigue entrando, en cualquiera de sus formas;
--   (c) `rfc` chatarra rebota, `rfc` con molde del SAT pasa, NULL pasa;
--   (d) `anio = 3000`, `km_actual = -5` y `numero_economico = ' 12'` rebotan;
--   (e) las mismas placas con otra caja/espacios rebotan DENTRO de la flota
--       (23505) y sí entran en OTRA flota;
--   (f) `app_user.operador_id` de otra flota rebota (23503) y el de la propia
--       entra.
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  opa uuid := gen_random_uuid(); opb uuid := gen_random_uuid();
  tel_chatarra text := 'no'; tel_bueno text := 'no'; rfc_malo text := 'no'; rfc_bueno text := 'no';
  anio_malo text := 'no'; km_malo text := 'no'; eco_malo text := 'no';
  placa_dup text := 'no'; placa_otra_flota text := 'no';
  fk_ajena text := 'no'; fk_propia text := 'no';
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0290_a__'), (tb, '__verif_0290_b__');

  -- (a) el teléfono que no es un teléfono
  begin
    insert into public.operador (tenant_id, nombre, telefono) values (ta, 'Sin celular', 'abc');
    tel_chatarra := 'ENTRO';
  exception when check_violation then tel_chatarra := 'rebota'; end;

  -- (b) el teléfono de verdad, con el 1 de móvil que Meta a veces manda
  begin
    insert into public.operador (id, tenant_id, nombre, telefono) values (opa, ta, 'Juan', '+52 1 999 370 0779');
    tel_bueno := 'entro';
  exception when others then tel_bueno := 'REBOTO: ' || sqlerrm; end;

  -- (c) RFC
  begin
    insert into public.operador (tenant_id, nombre, telefono, rfc) values (ta, 'Malo', '5299937007 80', 'xx');
    rfc_malo := 'ENTRO';
  exception when check_violation then rfc_malo := 'rebota'; end;
  begin
    insert into public.operador (tenant_id, nombre, telefono, rfc) values (ta, 'Bueno', '5299937007 81', 'PECJ850101H23');
    rfc_bueno := 'entro';
  exception when others then rfc_bueno := 'REBOTO: ' || sqlerrm; end;

  -- (d) unidad: año, km y económico
  begin
    insert into public.unidad (tenant_id, numero_economico, anio) values (ta, 'U-anio', 3000);
    anio_malo := 'ENTRO';
  exception when check_violation then anio_malo := 'rebota'; end;
  begin
    insert into public.unidad (tenant_id, numero_economico, km_actual) values (ta, 'U-km', -5);
    km_malo := 'ENTRO';
  exception when check_violation then km_malo := 'rebota'; end;
  begin
    insert into public.unidad (tenant_id, numero_economico) values (ta, ' 12');
    eco_malo := 'ENTRO';
  exception when check_violation then eco_malo := 'rebota'; end;

  -- (e) placas: la misma placa con otra caja, dentro y fuera de la flota
  insert into public.unidad (tenant_id, numero_economico, placas) values (ta, '12', 'ABC-123-A');
  begin
    insert into public.unidad (tenant_id, numero_economico, placas) values (ta, '13', ' abc-123-a ');
    placa_dup := 'ENTRO';
  exception when unique_violation then placa_dup := 'rebota'; end;
  begin
    insert into public.unidad (tenant_id, numero_economico, placas) values (tb, '12', 'ABC-123-A');
    placa_otra_flota := 'entro';
  exception when others then placa_otra_flota := 'REBOTO: ' || sqlerrm; end;

  -- (f) DAT-11: el operador ligado a un usuario es de su flota
  insert into public.operador (id, tenant_id, nombre, telefono) values (opb, tb, 'Chofer B', '5299937007 82');
  begin
    insert into public.app_user (id, tenant_id, email, rol, operador_id)
      values (gen_random_uuid(), ta, '__verif_0290_a__@likida.test', 'flota_admin', opb);
    fk_ajena := 'ENTRO';
  exception when foreign_key_violation then fk_ajena := 'rebota'; end;
  begin
    insert into public.app_user (id, tenant_id, email, rol, operador_id)
      values (gen_random_uuid(), ta, '__verif_0290_b__@likida.test', 'flota_admin', opa);
    fk_propia := 'entro';
  exception when others then fk_propia := 'REBOTO: ' || sqlerrm; end;

  raise exception E'OPERADOR_UNIDAD_FORMA_0290  tel-chatarra=%  tel-bueno=%  rfc-malo=%  rfc-bueno=%  anio=%  km=%  eco=%  placa-dup=%  placa-otra-flota=%  fk-ajena=%  fk-propia=%   (esperado rebota / entro / rebota / entro / rebota / rebota / rebota / rebota / entro / rebota / entro)',
    tel_chatarra, tel_bueno, rfc_malo, rfc_bueno, anio_malo, km_malo, eco_malo,
    placa_dup, placa_otra_flota, fk_ajena, fk_propia;
end $$;

-- ── 239. La sesión del contador ya no puede REESCRIBIR la liquidación (mig. 0292) ──
--
-- AUDITORÍA 24, SEG-2 (MEDIO). El contador tiene cookie de sesión legítima y
-- la anon key viaja en el bundle: con `curl` hacía
-- `PATCH /rest/v1/liquidacion` y `tenant_finanzas_update` lo dejaba pasar —204,
-- la fila cambiaba, el PDF archivado decía otra cifra y `bitacora_auditoria`
-- no tenía entrada. Se asevera, actuando DE VERDAD como `authenticated` con
-- su `sub` en el JWT:
--   (a) SIGUE LEYENDO su liquidación (no se rompió el panel);
--   (b) el UPDATE afecta 0 filas;
--   (c) el INSERT de un gasto rebota;
--   (d) el DELETE de un operador afecta 0 filas;
--   (e) no puede borrar ni reescribir la bitácora (0 filas: RLS sin policy);
--   (f) `service_role` —el rol con el que la app escribe— sí puede.
do $$
declare
  t uuid := gen_random_uuid(); conta uuid := gen_random_uuid();
  op uuid := gen_random_uuid(); vj uuid := gen_random_uuid(); liq uuid := gen_random_uuid();
  -- Un viaje ABIERTO aparte: el gasto se prueba contra éste para que lo que
  -- rebote sea la RLS y no `trg_gasto_no_tras_liquidar` (que ya lo frenaría
  -- por llegar tarde, y entonces la prueba no mediría nada).
  vj2 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid();
  -- Un chofer SIN viajes: si se borrara el de `vj`, lo que rebota es el FK
  -- `restrict` de `viaje`, no la RLS — y otra vez la prueba no mediría nada.
  op3 uuid := gen_random_uuid();
  leidas int; tocadas int; borrados int; bit_tocadas int;
  gasto_insert text := 'no'; bit_borradas int := -1; por_admin text := 'no';
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0292__');
  insert into public.app_user (id, tenant_id, email, rol)
    values (conta, t, '__verif_0292@likida.test', 'contador');
  insert into public.operador (id, tenant_id, nombre, telefono) values (op, t, 'Juan', '5299937007 91');
  insert into public.viaje (id, tenant_id, operador_id, folio, estatus, anticipo)
    values (vj, t, op, 'VJ-0292-0001', 'liquidado', 10000);
  insert into public.liquidacion (id, tenant_id, viaje_id, estatus, total_anticipo, total_comprobado, diferencia)
    values (liq, t, vj, 'cuadrada', 10000, 10000, 0);
  insert into public.operador (id, tenant_id, nombre, telefono) values (op2, t, 'Pedro', '5299937007 92');
  insert into public.viaje (id, tenant_id, operador_id, folio, estatus, anticipo)
    values (vj2, t, op2, 'VJ-0292-0002', 'abierto', 0);
  insert into public.operador (id, tenant_id, nombre, telefono) values (op3, t, 'Sin viajes', '5299937007 93');
  insert into public.bitacora_auditoria (tenant_id, actor_id, accion, entidad, entidad_id)
    values (t, conta, 'liquidacion.emitida', 'liquidacion', liq::text);

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', conta)::text, true);

  -- (a) el panel sigue leyendo
  -- Por `viaje_id` y no por `id`: `liquidacion_id_del_viaje` deriva la llave
  -- del viaje (md5), así que el id que se insertó arriba no es el que quedó.
  select count(*) into leidas from public.liquidacion where viaje_id = vj;

  -- (b) el PATCH que inventaba la cifra
  -- La cifra inventada CUADRA con `liquidacion_diferencia_cuadra`
  -- (diferencia = anticipo - comprobado): así lo único que puede frenarla es
  -- la RLS, que es justo lo que se está midiendo. El PDF firmado decía 10,000
  -- comprobados; esto dice 18,500.
  update public.liquidacion set total_comprobado = 18500, diferencia = -8500 where viaje_id = vj;
  get diagnostics tocadas = row_count;

  -- (c) meter un gasto por la puerta de atrás
  begin
    insert into public.gasto (tenant_id, viaje_id, concepto, monto, fecha)
      values (t, vj2, 'diesel', 5800, current_date);
    gasto_insert := 'ENTRO';
  exception when insufficient_privilege then gasto_insert := 'rebota'; end;

  -- (d) borrar al chofer
  delete from public.operador where id = op3;
  get diagnostics borrados = row_count;

  -- (e) la bitácora es constancia: ni se reescribe ni se borra
  -- RLS niega por AUSENCIA de policy de escritura: afecta 0 filas, no truena.
  -- (Revocar además los grants de tabla es el candado pendiente del CIERRE.)
  begin
    update public.bitacora_auditoria set accion = 'nada que ver' where tenant_id = t;
    get diagnostics bit_tocadas = row_count;
  exception when insufficient_privilege then bit_tocadas := 0; end;
  begin
    delete from public.bitacora_auditoria where tenant_id = t;
    get diagnostics bit_borradas = row_count;
  exception when insufficient_privilege then bit_borradas := 0; end;

  reset role;

  -- (f) el rol con el que la app SÍ escribe no se tocó
  begin
    update public.liquidacion set total_comprobado = 12000, diferencia = -2000 where viaje_id = vj;
    por_admin := 'entro';
  exception when others then por_admin := 'REBOTO: ' || sqlerrm; end;

  raise exception E'POLICIES_SOLO_LECTURA_0292  contador-lee=%  update-liquidacion=%  insert-gasto=%  delete-operador=%  update-bitacora=%  delete-bitacora=%  por-service-role=%   (esperado 1 / 0 / rebota / 0 / 0 / 0 / entro)',
    leidas, tocadas, gasto_insert, borrados, bit_tocadas, bit_borradas, por_admin;
end $$;

-- ── 240. Los jsonb que el producto lee como objeto, y el expediente ARCO (mig. 0291) ──
--
-- AUDITORÍA 24, DAT-13 (BAJO). Se asevera:
--   (a) `wa_conversacion.estado = '"hola"'` y `tenant.perfil = '[1,2]'`
--       rebotan —el código hace `estado.turns` / `perfil.algo` sobre lo que
--       salga— y el objeto de verdad entra;
--   (b) una solicitud ARCO sin titular (ni `operador_id` ni `titular_ref`)
--       rebota: un expediente que no dice de quién es no se puede resolver;
--   (c) una solicitud que VENCE antes de recibirse rebota — el plazo del
--       art. 32 LFPDPPP se cuenta desde que se recibe, y nacer vencida
--       dispararía los relojes legales el primer día.
--
-- DAT-6 (`liquidado` ⇔ existe `liquidacion`) NO se asevera aquí: quedó
-- diferido. La cabecera de la 0291 y el CIERRE de la auditoría 24 explican por
-- qué —16 bloques de esta misma batería usan `estatus='liquidado'` como atajo
-- de fixture, y `TARDE` (línea 779) asevera que el hueco existe a propósito.
do $$
declare
  t uuid := gen_random_uuid(); op1 uuid := gen_random_uuid();
  estado_malo text := 'no'; estado_bueno text := 'no'; perfil_malo text := 'no';
  perfil_bueno text := 'no'; arco_sin_titular text := 'no'; arco_vencida text := 'no';
  arco_buena text := 'no';
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0291__');
  insert into public.operador (id, tenant_id, nombre, telefono) values (op1, t, 'Juan', '5299937007 94');

  -- (a) los jsonb que el producto lee como objeto
  begin
    insert into public.wa_conversacion (tenant_id, telefono, estado)
      values (t, '5299937007 96', '"hola"'::jsonb);
    estado_malo := 'ENTRO';
  exception when check_violation then estado_malo := 'rebota'; end;
  begin
    insert into public.wa_conversacion (tenant_id, telefono, estado)
      values (t, '5299937007 97', '{"turns": []}'::jsonb);
    estado_bueno := 'entro';
  exception when others then estado_bueno := 'REBOTO: ' || sqlerrm; end;
  begin
    update public.tenant set perfil = '[1,2]'::jsonb where id = t;
    perfil_malo := 'ENTRO';
  exception when check_violation then perfil_malo := 'rebota'; end;
  begin
    update public.tenant set perfil = '{"giro": "carga"}'::jsonb where id = t;
    perfil_bueno := 'entro';
  exception when others then perfil_bueno := 'REBOTO: ' || sqlerrm; end;

  -- (b) y (c) el expediente ARCO
  begin
    insert into public.solicitud_arco (tenant_id, tipo, canal, estado, recibida_en, vence_en)
      values (t, 'cancelacion', 'whatsapp', 'recibida', now(), (now() + interval '20 days')::date);
    arco_sin_titular := 'ENTRO';
  exception when check_violation then arco_sin_titular := 'rebota'; end;
  begin
    insert into public.solicitud_arco (tenant_id, operador_id, tipo, canal, estado, recibida_en, vence_en)
      values (t, op1, 'cancelacion', 'whatsapp', 'recibida', now(), (now() - interval '10 days')::date);
    arco_vencida := 'ENTRO';
  exception when check_violation then arco_vencida := 'rebota'; end;
  begin
    insert into public.solicitud_arco (tenant_id, operador_id, tipo, canal, estado, recibida_en, vence_en)
      values (t, op1, 'cancelacion', 'whatsapp', 'recibida', now(), (now() + interval '20 days')::date);
    arco_buena := 'entro';
  exception when others then arco_buena := 'REBOTO: ' || sqlerrm; end;

  raise exception E'FORMAS_JSONB_Y_ARCO_0291  estado-chatarra=%  estado-objeto=%  perfil-arreglo=%  perfil-objeto=%  arco-sin-titular=%  arco-nace-vencida=%  arco-buena=%   (esperado rebota / entro / rebota / entro / rebota / rebota / entro)',
    estado_malo, estado_bueno, perfil_malo, perfil_bueno, arco_sin_titular, arco_vencida, arco_buena;
end $$;

-- ── 232. Cancelar y abonar se serializan; la cobranza tiene techo (mig. 0284) ──
--
-- AUDITORÍA 24, BE-3 (ALTO) + DAT-7 (MEDIO). `cancelarFactura` contaba los
-- pagos y cancelaba en dos viajes: un abono en medio dejaba un CFDI cancelado
-- con dinero encima. Y `pago_recibido` aceptaba sobrepagos, abonos sobre
-- canceladas y «pagada» sin pagos.
--
-- Se asevera lo que solo Postgres puede demostrar:
--   (a) `cancelar_factura_tx` cancela una emitida sin pagos;
--   (b) con un abono encima rebota CU016 motivo=con_pagos y la factura sigue
--       `emitida`;
--   (c) un abono sobre una cancelada rebota 23514 (pago_sobre_factura_viva);
--   (d) un abono que rebasa el total rebota 23514 (pago_dentro_de_saldo)
--       aunque entre por INSERT directo, sin pasar por registrar_pago_tx;
--   (e) `update … set estatus='pagada'` sin dinero rebota 23514;
--   (f) el camino bueno sigue: registrar_pago_tx salda y marca pagada;
--   (g) una `pagada` no se cancela desde aquí (CU016 motivo=estatus);
--   (h) la factura de otra flota ni se traba (CU010);
--   (i) nada de esto se ejecuta desde internet.
-- Esperado: CANCELAR_FACTURA_TX_0284 cancela=t con-pagos-rebota=t
--           sobre-cancelada-rebota=t sobrepago-rebota=t pagada-sin-dinero-rebota=t
--           salda-y-marca=t pagada-no-se-cancela=t ajena-rebota=t anon=f
do $$
declare
  ta uuid; tb uuid; cli uuid;
  f_limpia uuid; f_abonada uuid; fx uuid;
  res jsonb;
  cancela boolean := false;
  con_pagos_rebota boolean := false;
  sobre_cancelada_rebota boolean := false;
  sobrepago_rebota boolean := false;
  pagada_sin_dinero_rebota boolean := false;
  salda_y_marca boolean := false;
  pagada_no_se_cancela boolean := false;
  ajena_rebota boolean := false;
  anon_ok boolean := true;
begin
  insert into tenant (nombre) values ('ZZZ VERIF 0284 A') returning id into ta;
  insert into tenant (nombre) values ('ZZZ VERIF 0284 B') returning id into tb;
  insert into cliente (tenant_id, nombre, rfc) values (ta, 'ZZZ cli 0284', 'XAXX010101000') returning id into cli;

  -- (a) Sin pagos: se cancela, y el RPC devuelve de dónde venía.
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, cli, 10000, 1600, 11600, 'emitida') returning id into f_limpia;
  res := cancelar_factura_tx(ta, f_limpia);
  cancela := (select estatus from factura_emitida where id = f_limpia) = 'cancelada'
             and res ->> 'estatus_previo' = 'emitida';

  -- (b) Con un abono encima: NO se cancela. Es el escenario de BE-3 con el
  -- abono ya dentro; el intercalado imposible lo garantiza el `for update`.
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, cli, 10000, 1600, 11600, 'emitida') returning id into f_abonada;
  res := registrar_pago_tx(ta, f_abonada, current_date, 10000, 'transferencia', null);
  begin
    res := cancelar_factura_tx(ta, f_abonada);
  exception when sqlstate 'CU016' then
    con_pagos_rebota := position('motivo=con_pagos' in sqlerrm) > 0
                        and (select estatus from factura_emitida where id = f_abonada) = 'emitida';
  end;

  -- (c) Un abono sobre la cancelada de (a) rebota como violación de dominio.
  begin
    insert into pago_recibido (tenant_id, factura_id, monto) values (ta, f_limpia, 100);
  exception when check_violation then sobre_cancelada_rebota := true;
  end;

  -- (d) Sobrepago por INSERT DIRECTO (saldo 1,600, abono 2,000): rebota sin
  -- pasar por registrar_pago_tx — que es lo que DAT-7 encontró abierto.
  begin
    insert into pago_recibido (tenant_id, factura_id, monto) values (ta, f_abonada, 2000);
  exception when check_violation then sobrepago_rebota := true;
  end;

  -- (e) «pagada» sin el dinero encima: rebota.
  begin
    update factura_emitida set estatus = 'pagada' where id = f_abonada;
  exception when check_violation then pagada_sin_dinero_rebota := true;
  end;

  -- (f) El camino bueno no se rompió: el abono que salda marca `pagada`.
  res := registrar_pago_tx(ta, f_abonada, current_date, 1600, 'efectivo', 'REF-0284');
  salda_y_marca := (res ->> 'saldada')::boolean
                   and (select estatus from factura_emitida where id = f_abonada) = 'pagada';

  -- (g) Y una pagada no se cancela de un clic. El RPC cuenta los abonos ANTES
  -- de mirar el estatus (una pagada siempre tiene dinero encima), así que el
  -- motivo que llega es `con_pagos`; lo que se afirma es que NO se canceló.
  begin
    res := cancelar_factura_tx(ta, f_abonada);
  exception when sqlstate 'CU016' then
    pagada_no_se_cancela := position('motivo=' in sqlerrm) > 0
                            and (select estatus from factura_emitida where id = f_abonada) = 'pagada';
  end;

  -- (h) La factura de OTRA flota ni se traba.
  insert into factura_emitida (tenant_id, cliente_id, subtotal, iva, total, estatus)
    values (ta, cli, 100, 16, 116, 'emitida') returning id into fx;
  begin
    res := cancelar_factura_tx(tb, fx);
  exception when sqlstate 'CU010' then ajena_rebota := true;
  end;

  -- (i) Permisos.
  select has_function_privilege('anon', 'public.cancelar_factura_tx(uuid, uuid)', 'EXECUTE')
      or has_function_privilege('authenticated', 'public.cancelar_factura_tx(uuid, uuid)', 'EXECUTE')
    into anon_ok;

  raise exception E'CANCELAR_FACTURA_TX_0284  cancela=%  con-pagos-rebota=%  sobre-cancelada-rebota=%  sobrepago-rebota=%  pagada-sin-dinero-rebota=%  salda-y-marca=%  pagada-no-se-cancela=%  ajena-rebota=%  anon=%   (esperado t / t / t / t / t / t / t / t / f)',
    cancela, con_pagos_rebota, sobre_cancelada_rebota, sobrepago_rebota, pagada_sin_dinero_rebota,
    salda_y_marca, pagada_no_se_cancela, ajena_rebota, anon_ok;
end $$;

-- ── 233. Cerrar una orden del bus exige ser quien la tomó (mig. 0285) ──────
--
-- AUDITORÍA 24, BE-22 (BAJO). `ordenes-resolver` cerraba con `.eq('id', id)` a
-- secas: el worker B marcaba `hecha` la orden que tomó A, y `resultado` contaba
-- lo que hizo B sobre el trabajo de A. La ruta ancla ahora por estado Y por
-- dueño; el dueño no existía en el esquema (la 0127 guarda `creado_por` y
-- `tomada_en`, no quién tomó) y lo agrega la 0285.
--
-- Se asevera lo que solo Postgres puede demostrar:
--   (a) la columna existe y es anulable (las tomadas antes de la 0285 no
--       tienen dueño y no se les inventa uno);
--   (b) el UPDATE anclado a OTRO dueño no toca ni una fila;
--   (c) el anclado al dueño bueno sí la cierra;
--   (d) y una orden ya cerrada no se vuelve a cerrar (el ancla por estado).
--
-- Esperado: BUS_ORDEN_TOMADA_POR_0285 existe=t anulable=t ajeno=0 propio=1 recierre=0
do $$
declare
  existe boolean;
  anulable boolean;
  o uuid;
  ajeno integer;
  propio integer;
  recierre integer;
begin
  select true, (is_nullable = 'YES')
    into existe, anulable
    from information_schema.columns
   where table_schema = 'public' and table_name = 'bus_orden' and column_name = 'tomada_por';
  existe := coalesce(existe, false);
  anulable := coalesce(anulable, false);

  insert into public.bus_orden (tipo, rutina, creado_por)
    values ('correr_ahora', 'auditoria-24', 'verificaciones')
    returning id into o;

  -- El claim, como lo hace la ruta: anclado a `pendiente` y firmando quién.
  update public.bus_orden
     set estado = 'tomada', tomada_en = now(), tomada_por = 'worker-a'
   where id = o and estado = 'pendiente';

  -- (b) El worker B intenta cerrarla: no toca nada.
  update public.bus_orden
     set estado = 'hecha', resuelta_en = now(), resultado = 'la cerró B'
   where id = o and estado = 'tomada' and tomada_por = 'worker-b';
  get diagnostics ajeno = row_count;

  -- (c) El worker A sí.
  update public.bus_orden
     set estado = 'hecha', resuelta_en = now(), resultado = 'la cerró A'
   where id = o and estado = 'tomada' and tomada_por = 'worker-a';
  get diagnostics propio = row_count;

  -- (d) Y ya cerrada, nadie la vuelve a cerrar.
  update public.bus_orden
     set estado = 'fallida', resuelta_en = now(), resultado = 'segundo cierre'
   where id = o and estado = 'tomada' and tomada_por = 'worker-a';
  get diagnostics recierre = row_count;

  raise exception E'BUS_ORDEN_TOMADA_POR_0285  existe=%  anulable=%  ajeno=%  propio=%  recierre=%   (esperado t / t / 0 / 1 / 0)',
    existe, anulable, ajeno, propio, recierre;
end $$;

-- ── 228. `poliza_datos_tenant` v281 entrega los insumos por comprobante y `gasto` tiene piso en sus cinco columnas de dinero (mig. 0281) ──
--
-- AUDITORÍA 24, FIS-2 + FIS-3 (CRÍTICOS) + DAT-3 (ALTO). La 0272 entregaba
-- `gastos` sin monto, sin folio, sin forma de pago: la ruta no podía ni
-- deduplicar (una foto repetida se asentaba dos veces) ni partir un gasto
-- parcialmente deducible (la comida de $2,000 con tope de $750 se asentaba
-- entera como deducible). Y las cinco columnas de dinero distintas de `monto`
-- aceptaban negativos que la póliza volvía cargos.
--
-- Lo que este bloque asevera (la FORMA del contrato, que es lo que la base
-- puede demostrar; la clasificación sigue viviendo en TS — bloque 220):
--   (a) cada fila trae `version` = 281;
--   (b) cada gasto trae `monto`, `folioNorm`, `cfdiUuid` y `formaPago` — lo que
--       `copiasDeComprobante`, `cubetaDe` y `proporcionesDeducibles` leen —, y
--       las DOS fotos del mismo ticket vienen las dos (deduplica la ruta con la
--       misma función que el motor, no SQL);
--   (c) `sub_total = -1` no entra (23514), y un descuento mayor al SubTotal
--       tampoco.
do $$
declare
  t uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  l uuid := gen_random_uuid(); op uuid := gen_random_uuid();
  g1 uuid := gen_random_uuid(); g2 uuid := gen_random_uuid();
  fila jsonb;
  version_281 boolean := false;
  insumos_por_gasto boolean := false;
  dos_fotos boolean := false;
  piso_subtotal boolean := false;
  piso_descuento boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0281__');
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op, t, 'Operador 0281', '+5218100000281');
  insert into public.viaje (id, tenant_id, operador_id, folio, anticipo, estatus)
    values (v, t, op, 'VJ-0281', 10000, 'liquidado');
  -- Dos fotos del MISMO ticket de diésel: sin UUID, mismo folio normalizado y
  -- mismo monto (el caso real de la base: el índice único de (uuid, orden)
  -- impide la copia por UUID, la copia por folio no la impide nadie).
  insert into public.gasto (id, tenant_id, viaje_id, concepto, monto, sub_total, folio, folio_norm, forma_pago, fecha)
    values (g1, t, v, 'diesel', 3480, 3000, '05461', '5461', '01', current_date),
           (g2, t, v, 'diesel', 3480, 3000, '5461',  '5461', '01', current_date);
  -- (c) antes de liquidar: con liquidación emitida el trigger de la 0036
  -- rebota cualquier alta (CU001) y taparía el CHECK que aquí se prueba.
  begin
    insert into public.gasto (tenant_id, viaje_id, concepto, monto, sub_total)
      values (t, v, 'diesel', 100, -1);
  exception when check_violation then
    piso_subtotal := true;
  end;
  begin
    insert into public.gasto (tenant_id, viaje_id, concepto, monto, sub_total, descuento)
      values (t, v, 'caseta', 100, 50, 60);
  exception when check_violation then
    piso_descuento := true;
  end;

  insert into public.liquidacion
    (id, tenant_id, viaje_id, total_anticipo, total_comprobado, diferencia, iva_acreditable, diferencias)
    values (l, t, v, 10000, 3480, 6520, 0, '[]'::jsonb);

  select x into fila
    from jsonb_array_elements(public.poliza_datos_tenant(t, current_date - 1, current_date + 1)) x
   limit 1;

  version_281       := (fila->>'version')::int = 281;
  insumos_por_gasto := (fila->'gastos'->0->>'monto')::numeric = 3480
                       and (fila->'gastos'->0->>'folioNorm') = '5461'
                       and (fila->'gastos'->0->>'formaPago') = '01'
                       and (fila->'gastos'->0) ? 'cfdiUuid'
                       and (fila->'gastos'->0) ? 'pagadoEn'
                       and (fila->'gastos'->0) ? 'ivaRetenido';
  dos_fotos         := jsonb_array_length(fila->'gastos') = 2;

  raise exception E'POLIZA_V2_0281  version=%  insumos-por-gasto=%  dos-fotos=%  piso-subtotal=%  piso-descuento=%   (esperado t / t / t / t / t)',
    version_281, insumos_por_gasto, dos_fotos, piso_subtotal, piso_descuento;
end $$;

-- ── 229. El agregado fiscal parte las celdas por el sello del complemento de pago (mig. 0282) ──
--
-- AUDITORÍA 24, FIS-7 (MEDIO). Dos CFDI '99' idénticos en todo menos en
-- `pagado_en` caían en UNA celda y el panel del contador negaba el IVA de los
-- dos. Con la 0282 son DOS celdas, cada una con `pagado` y `pagadoForma`, y
-- `ivaSostenible` (fiscal.ts) puede sostener el pagado — la ley sigue en TS.
do $$
declare
  t uuid := gen_random_uuid(); v uuid := gen_random_uuid(); op uuid := gen_random_uuid();
  celdas jsonb;
  dos_celdas boolean := false;
  trae_pagado boolean := false;
  forma_del_rep boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0282__');
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op, t, 'Operador 0282', '+5218100000282');
  insert into public.viaje (id, tenant_id, operador_id, folio, anticipo, estatus)
    values (v, t, op, 'VJ-0282', 10000, 'abierto');
  insert into public.gasto (tenant_id, viaje_id, concepto, monto, sub_total, iva_traslado, cfdi_uuid, forma_pago, metodo_pago, fecha, pagado_en, pagado_forma)
    values (t, v, 'diesel', 1160, 1000, 160, 'aaaaaaaa-0282-0282-0282-000000000001', '99', 'PPD', current_date, null, null),
           (t, v, 'diesel', 1160, 1000, 160, 'aaaaaaaa-0282-0282-0282-000000000002', '99', 'PPD', current_date, current_date, '03');

  celdas := public.gastos_fiscales_agregados_tenant(t, null, null, 2000, 750, array['alimentacion','viaticos'], '{}'::date[]);

  dos_celdas   := jsonb_array_length(celdas) = 2;
  trae_pagado  := (select bool_and(x ? 'pagado' and x ? 'pagadoForma') from jsonb_array_elements(celdas) x);
  forma_del_rep := exists (select 1 from jsonb_array_elements(celdas) x where (x->>'pagado')::boolean and x->>'pagadoForma' = '03' and (x->>'n')::int = 1)
               and exists (select 1 from jsonb_array_elements(celdas) x where not (x->>'pagado')::boolean and x->'pagadoForma' = 'null'::jsonb and (x->>'n')::int = 1);

  raise exception E'FISCAL_AGREGADO_PAGADO_0282  dos-celdas=%  trae-pagado=%  forma-del-rep=%   (esperado t / t / t)',
    dos_celdas, trae_pagado, forma_del_rep;
end $$;

-- ── 230. Lo liquidado no se mueve, y el REP tiene piso y forma (mig. 0283) ──
--
-- AUDITORÍA 24, DAT-4 (ALTO) + DAT-12 (MEDIO). Con la liquidación emitida, el
-- escenario S21 movía el gasto a otro viaje y reescribía retenciones y
-- descuento sin que el trigger de la 0037/0158 se enterara (solo miraba 10
-- columnas y solo `new.viaje_id`). S13/S27: `cfdi_pago` aceptaba importes
-- negativos y UUID en MAYÚSCULAS —el mismo REP dos veces para
-- `uq_cfdi_pago_docto`, IVA liberado dos veces—, y `codigo_pendiente.monto`
-- tampoco tenía piso.
-- Esperado: INMUTABLE_TRAS_LIQUIDAR_0283 mover=t reten=t descuento=t viaje=t
--           unidad-libre=t rep-negativo=t rep-mayusculas=t codigo-negativo=t
do $$
declare
  t uuid := gen_random_uuid(); v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid();
  op uuid := gen_random_uuid(); op2 uuid := gen_random_uuid();
  g uuid := gen_random_uuid(); u uuid := gen_random_uuid();
  mover boolean := false; reten boolean := false; descuento boolean := false;
  viaje_enc boolean := false; unidad_libre boolean := false;
  rep_negativo boolean := false; rep_mayusculas boolean := false; codigo_negativo boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0283__');
  -- Dos operadores: `uq_viaje_abierto_por_operador` (0029) solo deja UN viaje
  -- abierto por operador, y aquí hacen falta dos viajes.
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op,  t, 'Operador 0283 A', '+5218100000283'),
           (op2, t, 'Operador 0283 B', '+5218100000284');
  insert into public.unidad (id, tenant_id, numero_economico, placas) values (u, t, 'U-0283', 'V283ABC');
  insert into public.viaje (id, tenant_id, operador_id, folio, anticipo, estatus, origen, destino, fecha_inicio)
    values (v1, t, op,  'VJ-0283-A', 10000, 'abierto', 'Monterrey', 'Saltillo', current_date),
           (v2, t, op2, 'VJ-0283-B', 10000, 'abierto', 'Monterrey', 'Saltillo', current_date);
  insert into public.gasto (id, tenant_id, viaje_id, concepto, monto, sub_total, iva_traslado, fecha)
    values (g, t, v1, 'diesel', 5800, 5000, 800, current_date);

  -- El papel: a partir de aquí v1 está firmado.
  insert into public.liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia)
    values (t, v1, 5800, 10000, 4200);

  -- (1) Mover el gasto a OTRO viaje — la punta que la 0036 no miraba.
  begin
    update public.gasto set viaje_id = v2 where id = g;
  exception when sqlstate 'CU001' then mover := true;
  end;

  -- (2) Reescribir las retenciones que la póliza asienta como cuenta por pagar.
  begin
    update public.gasto set iva_retenido = 99999, isr_retenido = 99999 where id = g;
  exception when sqlstate 'CU001' then reten := true;
  end;

  -- (3) Y el descuento (0171), base del estímulo de peaje.
  begin
    update public.gasto set descuento = 4000 where id = g;
  exception when sqlstate 'CU001' then descuento := true;
  end;

  -- (4) El encabezado del PDF: origen/destino/fechas/cliente.
  begin
    update public.viaje set fecha_inicio = current_date - 30, origen = 'Otra' where id = v1;
  exception when sqlstate 'CU004' then viaje_enc := true;
  end;

  -- (5) `unidad_id` sigue LIBRE a propósito (se captura tarde de rutina):
  --     si esto fallara, el tablero del encargado quedaría trabado.
  update public.viaje set unidad_id = u where id = v1;
  unidad_libre := true;

  -- (6) DAT-12: piso del complemento de pago.
  begin
    insert into public.cfdi_pago (tenant_id, cfdi_uuid, fecha_pago, docto_relacionado_uuid, imp_pagado)
      values (t, 'bbbbbbbb-0283-0283-0283-000000000001', current_date, 'bbbbbbbb-0283-0283-0283-000000000002', -500);
  exception when check_violation then rep_negativo := true;
  end;

  -- (7) …y su forma: 'AAAA…' y 'aaaa…' no pueden ser dos complementos.
  begin
    insert into public.cfdi_pago (tenant_id, cfdi_uuid, fecha_pago, docto_relacionado_uuid, imp_pagado)
      values (t, 'BBBBBBBB-0283-0283-0283-000000000003', current_date, 'bbbbbbbb-0283-0283-0283-000000000004', 500);
  exception when check_violation then rep_mayusculas := true;
  end;

  -- (8) La cola de códigos, misma familia.
  begin
    insert into public.codigo_pendiente (tenant_id, viaje_id, codigo_barras, monto)
      values (t, v2, 'ABC283', -100);
  exception when check_violation then codigo_negativo := true;
  end;

  raise exception E'INMUTABLE_TRAS_LIQUIDAR_0283  mover=%  reten=%  descuento=%  viaje=%  unidad-libre=%  rep-negativo=%  rep-mayusculas=%  codigo-negativo=%   (esperado t / t / t / t / t / t / t / t)',
    mover, reten, descuento, viaje_enc, unidad_libre, rep_negativo, rep_mayusculas, codigo_negativo;
end $$;

-- ── 225. El techo diario de IA cabe en tenant.config y es un número > 0 (mig. 0278) ──
-- Esperado: PRESUPUESTO_LLM_TENANT_0278  declara=t  texto-rebota=t  cero-rebota=t  negativo-rebota=t  null-ok=t  hermanas-ok=t  inventada-rebota=t
--
-- AUDITORÍA 24, TC-N1 / WA-1 / OP-P7 (CRÍTICO). El techo diario de IA era una
-- env global; ahora `llm/budget.ts` lee primero `tenant.config.presupuestoLlmUsdDia`.
-- Pero `config_tenant_valida` (regla 2, 0026) rechaza cualquier llave que no
-- conozca: sin la 0278 la palanca del piloto NO SE PODÍA GUARDAR. Se asevera lo
-- único que la base puede demostrar:
--   (a) la llave con un número > 0 entra;
--   (b) texto, cero y negativo rebotan (una llave mal puesta no se guarda en
--       silencio para que nadie la lea);
--   (c) `null` = sin declarar, entra;
--   (d) las hermanas siguen vivas: `agentes` (0159) y `politica` conviven con
--       la llave nueva, y una llave inventada sigue rebotando — o sea, el CHECK
--       recreado conserva el `- 'agentes'` y la función de siempre.
do $$
declare
  t uuid := gen_random_uuid();
  declara boolean := false;
  texto_rebota boolean := false;
  cero_rebota boolean := false;
  negativo_rebota boolean := false;
  null_ok boolean := false;
  hermanas_ok boolean := false;
  inventada_rebota boolean := false;
begin
  insert into public.tenant (id, nombre) values (t, '__verif_0278__');

  -- (a) la palanca del piloto se guarda.
  begin
    update public.tenant set config = '{"presupuestoLlmUsdDia": 40}'::jsonb where id = t;
    declara := true;
  exception when others then declara := false;
  end;

  -- (b) texto, cero y negativo rebotan.
  begin
    update public.tenant set config = '{"presupuestoLlmUsdDia": "40"}'::jsonb where id = t;
  exception when others then texto_rebota := true;
  end;
  begin
    update public.tenant set config = '{"presupuestoLlmUsdDia": 0}'::jsonb where id = t;
  exception when others then cero_rebota := true;
  end;
  begin
    update public.tenant set config = '{"presupuestoLlmUsdDia": -3}'::jsonb where id = t;
  exception when others then negativo_rebota := true;
  end;

  -- (c) null = sin declarar.
  begin
    update public.tenant set config = '{"presupuestoLlmUsdDia": null}'::jsonb where id = t;
    null_ok := true;
  exception when others then null_ok := false;
  end;

  -- (d) convive con `agentes` (0159) y `politica`; la regla 2 sigue viva.
  begin
    update public.tenant set config =
      '{"presupuestoLlmUsdDia": 27.5, "agentes": {"conductores": {"horasEscalacion": 5}}, "politica": [{"concepto": "diesel", "topeMonto": 8000}]}'::jsonb
      where id = t;
    hermanas_ok := true;
  exception when others then hermanas_ok := false;
  end;
  begin
    update public.tenant set config = '{"presupuestoLlmUsdDia": 40, "presupuestoLlmUsdDIa": 40}'::jsonb where id = t;
  exception when others then inventada_rebota := true;
  end;

  raise exception E'PRESUPUESTO_LLM_TENANT_0278  declara=%  texto-rebota=%  cero-rebota=%  negativo-rebota=%  null-ok=%  hermanas-ok=%  inventada-rebota=%   (esperado t / t / t / t / t / t / t)',
    declara, texto_rebota, cero_rebota, negativo_rebota, null_ok, hermanas_ok, inventada_rebota;
end $$;

-- ── 226. La liquidación lleva los dos sellos de entrega, nulos de fábrica (mig. 0279) ──
--
-- AUDITORÍA 24, AGEN-4 (ALTO). Toda muerte posterior al commit del cierre
-- aterrizaba en «pídeselo a tu contralor» sin mandar el PDF que existe ni avisar
-- al jefe, porque la entrega no dejaba marca en la base. Se asevera lo que la
-- base puede demostrar: las dos columnas existen, son timestamptz NULLABLES
-- (null = «falta entregar»; el reintento del «listo» decide por ellas), nacen
-- en null sin default (un default now() diría «entregado» sobre un PDF que
-- nadie mandó), y el índice parcial del barrido existe.
-- Esperado: LIQUIDACION_SELLOS_ENTREGA_0279 col-operador=t col-oficina=t nulables=t sin-default=t idx-parcial=t
do $$
declare
  col_operador boolean; col_oficina boolean; nulables boolean; sin_default boolean; idx_parcial boolean;
begin
  select exists(select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'liquidacion'
                  and column_name = 'entregada_operador_en' and data_type = 'timestamp with time zone') into col_operador;
  select exists(select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'liquidacion'
                  and column_name = 'avisada_oficina_en' and data_type = 'timestamp with time zone') into col_oficina;
  select coalesce(bool_and(is_nullable = 'YES'), false) from information_schema.columns
    where table_schema = 'public' and table_name = 'liquidacion'
      and column_name in ('entregada_operador_en', 'avisada_oficina_en') into nulables;
  select coalesce(bool_and(column_default is null), false) from information_schema.columns
    where table_schema = 'public' and table_name = 'liquidacion'
      and column_name in ('entregada_operador_en', 'avisada_oficina_en') into sin_default;
  select exists(select 1 from pg_indexes
                where schemaname = 'public' and tablename = 'liquidacion'
                  and indexname = 'liquidacion_entrega_pendiente_idx'
                  and indexdef ilike '%where%entregada_operador_en is null%') into idx_parcial;

  raise exception E'LIQUIDACION_SELLOS_ENTREGA_0279  col-operador=%  col-oficina=%  nulables=%  sin-default=%  idx-parcial=%   (esperado t / t / t / t / t)',
    col_operador, col_oficina, nulables, sin_default, idx_parcial;
end $$;

-- ── 227. El mutex del viaje tiene dueño y el inbox ordena por la hora del mensaje (mig. 0280) ──
--
-- AUDITORÍA 24, BE-11 (MEDIO) y AGEN-6 (MEDIO). `unlock_viaje` borraba el lease
-- de quien fuera —el XML que se pasaba de su TTL le quitaba el lock al cierre y
-- entraba un segundo «listo» completo— y el orden causal del inbox lo daba
-- `recibido_en`, la hora de NUESTRO servidor, no la del mensaje: un «listo» que
-- Meta entregaba antes que la última foto cerraba sin ella, irreversible.
-- Se asevera lo que la base puede demostrar: la columna del dueño existe, las
-- dos funciones del lock llevan el parámetro del token, `wa_orden_evento` existe
-- y es IMMUTABLE (si no, no se puede indexar ni razonar sobre ella), y las dos
-- RPC del inbox la USAN en su cuerpo.
-- Esperado: MUTEX_Y_ORDEN_0280 col-token=t unlock-token=t trylock-token=t orden-fn=t orden-inmutable=t listar-usa=t reclamar-usa=t
do $$
declare
  col_token boolean; unlock_token boolean; trylock_token boolean;
  orden_fn boolean; orden_inmutable boolean; listar_usa boolean; reclamar_usa boolean;
  prefijo text := 'verif-0280-'||gen_random_uuid();
  orden_causal boolean; claim_causal boolean; lease_prefijo boolean;
begin
  select exists(select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'viaje_lock'
                  and column_name = 'token' and data_type = 'uuid') into col_token;

  select exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'unlock_viaje'
                  and pg_get_function_identity_arguments(p.oid) like '%p_token uuid%') into unlock_token;
  select exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'try_lock_viaje'
                  and pg_get_function_identity_arguments(p.oid) like '%p_token uuid%') into trylock_token;

  select exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'wa_orden_evento') into orden_fn;
  select coalesce((select p.provolatile = 'i' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'wa_orden_evento' limit 1), false) into orden_inmutable;
  orden_fn := orden_fn and exists (
    select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.wa_evento_pendiente'::regclass and a.attname='orden_evento'
      and a.attgenerated='s' and pg_get_expr(d.adbin,d.adrelid) ilike '%wa_orden_evento%'
  );

  select coalesce((select pg_get_functiondef(p.oid) ilike '%orden_evento%'
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'listar_wa_pendientes' limit 1), false) into listar_usa;
  select coalesce((select pg_get_functiondef(p.oid) ilike '%orden_evento%'
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'reclamar_wa_pendiente' limit 1), false) into reclamar_usa;

  -- La cola puede tener backlog ajeno; ocultarlo sólo durante esta prueba.
  -- El RAISE final restaura sus filas, leases y estados originales.
  update public.wa_evento_pendiente set procesado_en=clock_timestamp() where procesado_en is null;

  -- El orden materializado debe gobernar también el comportamiento: las
  -- horas de recepción se invierten para que no puedan reemplazar a Meta.
  insert into public.wa_evento_pendiente(id,evento,recibido_en) values
    (prefijo||'-primero',jsonb_build_object('from',prefijo,'type','image','timestampMs',1000),clock_timestamp()),
    (prefijo||'-segundo',jsonb_build_object('from',prefijo,'type','text','timestampMs',2000),clock_timestamp()-interval '1 hour');
  select id=prefijo||'-primero' into orden_causal from public.listar_wa_pendientes(1);
  select count(*)=0 into claim_causal
    from public.reclamar_wa_pendiente(prefijo||'-segundo',0,prefijo,180);
  select count(*)=1 into lease_prefijo
    from public.reclamar_wa_pendiente(prefijo||'-primero',0,prefijo,180);
  lease_prefijo := lease_prefijo and not exists(
    select 1 from public.listar_wa_pendientes(200) where id=prefijo||'-segundo'
  );

  raise exception E'MUTEX_Y_ORDEN_0280  col-token=%  unlock-token=%  trylock-token=%  orden-fn=%  orden-inmutable=%  listar-usa=%  reclamar-usa=% orden-causal=% claim-causal=% lease-prefijo=%   (esperado t / t / t / t / t / t / t / t / t / t)',
    col_token, unlock_token, trylock_token, orden_fn, orden_inmutable, listar_usa, reclamar_usa, coalesce(orden_causal,false), claim_causal, lease_prefijo;
end $$;

-- ── 250. `transcripcion` entra al dominio de fases del costo (mig. 0304) ──
--
-- AUDITORÍA 25, DATOS-A1 (ALTO). `llm_costo_fase_dominio` nació en la 0025 con
-- SEIS fases y ninguna migración lo recreó; `FaseCosto` (costos.ts) tiene SIETE
-- desde el 29-ago-2026. El INSERT de cada nota de voz rebotaba con 23514 y
-- `registrarCosto` —best-effort a propósito— se lo tragaba: el costo de la voz
-- no entraba a la medición con la que se fija el precio del producto, y nada
-- visible fallaba.
--
-- Se asevera lo que SOLO la base puede demostrar: que el constraint existe,
-- que cuelga de `llm_costo`, y que su expresión vigente nombra las SIETE fases
-- —en particular `transcripcion`, que es la que faltaba—.
--
-- Lo que este bloque NO hace, a propósito: insertar una fila de prueba.
-- `llm_costo.tenant_id` es `not null references tenant(id)` (0003:9) y la base
-- de producción está en cero tenants, así que el INSERT fallaría por la FK y
-- este bloque reportaría rojo por una razón que no es la suya. Un chequeo que
-- falla por el motivo equivocado es peor que no tenerlo — es la lección que la
-- 0030 dejó escrita.
--
-- La otra mitad del arnés vive en TS y no puede vivir aquí: `costos_dominio.test.ts`
-- cruza esta misma lista contra `FaseCosto` en cada corrida de CI, sin base de
-- datos, y sale en rojo en cuanto las dos vuelvan a divergir. Esa es la
-- comprobación que impide la reincidencia; esta confirma que la base de verdad
-- se aplicó.
-- Esperado: LLM_COSTO_FASE_0304 existe=t sobre-llm-costo=t siete=t transcripcion=t
do $$
declare
  expr text; existe boolean; sobre_tabla boolean; siete boolean; tiene_transcripcion boolean;
begin
  select pg_get_constraintdef(c.oid) into expr
    from pg_constraint c
   where c.conname = 'llm_costo_fase_dominio'
     and c.conrelid = 'public.llm_costo'::regclass
     and c.contype = 'c';

  existe := expr is not null;
  sobre_tabla := coalesce(expr ilike '%fase%', false);
  tiene_transcripcion := coalesce(expr ilike '%''transcripcion''%', false);

  siete := coalesce(
    expr ilike '%''ocr''%' and expr ilike '%''cuadre''%' and expr ilike '%''escalacion''%'
    and expr ilike '%''chat''%' and expr ilike '%''router''%' and expr ilike '%''whatsapp''%'
    and expr ilike '%''transcripcion''%', false);

  raise exception E'LLM_COSTO_FASE_0304  existe=%  sobre-llm-costo=%  siete=%  transcripcion=%   (esperado t / t / t / t)',
    existe, sobre_tabla, siete, tiene_transcripcion;
end $$;

-- ── 251. Ajustar EXIGE y USA el recálculo del motor — no una delta a mano sobre el desglose (mig. 0306, AUDITORÍA 25 BE-C1a/BE-C1b/DATOS-C1) ──
--
-- Hasta la 0306, `revisar_liquidacion(..., 'ajustar')` movía `total_comprobado`
-- y `diferencia` por una delta aritmética y dejaba `iva_acreditable`,
-- `ieps_acreditable`, `peaje_acreditable`, `litros_diesel_acreditables`,
-- `diferencias` y `estatus` con la cifra de ANTES del ajuste — la póliza
-- contable de `poliza.ts` ya había declarado esa divergencia como «un IVA no
-- acreditable inventado», y el PDF archivado se quedaba con el número viejo.
--
-- Lo que este bloque asevera, todo contra Postgres real:
--   (a) ajustar SIN el octavo argumento (`p_recalculo`) rebota (LR021): la
--       RPC ya no acepta un ajuste sin el recálculo completo del motor;
--   (b) un `p_recalculo` cuyo `totalComprobado` NO coincide con la delta que
--       la propia RPC acaba de aplicar rebota (LR020) y NO deja NADA
--       movido — ni el monto del gasto, ni una sola columna de la
--       liquidación: la RPC es transaccional, un rebote no dejä a medias;
--   (c) un ajuste BUENO sustituye TODO el desglose por el recálculo —no solo
--       total_comprobado/diferencia— incluidas las cifras que antes se
--       quedaban con el valor viejo;
--   (d) `pdf_historial` nace `[]` y `agregar_pdf_historial` le empuja
--       entradas con `||` sin pisar lo que ya había.
-- Esperado: AJUSTAR_RECALCULO_0306  sin-recalculo-rebota=t  mismatch-rebota=t  mismatch-nada-movido=t  bueno-total=t  bueno-iva=t  bueno-ieps=t  bueno-peaje=t  bueno-litros=t  bueno-estatus=t  bueno-diferencias=t  historial-nace-vacio=t  historial-acumula=t
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid(); v_o uuid;
  v_v uuid; v_l uuid; v_g uuid;
  r jsonb;
  sin_recalculo_rebota boolean := false; mismatch_rebota boolean := false; mismatch_nada_movido boolean := false;
  bueno_total boolean := false; bueno_iva boolean := false; bueno_ieps boolean := false;
  bueno_peaje boolean := false; bueno_litros boolean := false; bueno_estatus boolean := false; bueno_diferencias boolean := false;
  historial_nace_vacio boolean := false; historial_acumula boolean := false;
  n_monto numeric; n_total numeric; n_iva numeric; n_ieps numeric; n_peaje numeric; n_litros numeric;
  n_estatus text; n_diferencias jsonb; n_hist jsonb;
  recalculo_bueno jsonb := jsonb_build_object(
    'totalComprobado', 8000, 'diferencia', -3000, 'estatus', 'con_diferencias',
    'diferencias', '[{"tipo":"sobre_politica"}]'::jsonb, 'iepsAcreditable', 15.5,
    'litrosDieselAcreditables', 42.123, 'ivaAcreditable', 1200.75, 'peajeAcreditable', 60
  );
begin
  insert into tenant (nombre) values ('ZZZ VERIF AJUSTAR RECALCULO 0306') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-recalculo-0306@likida.test', 'flota_admin');
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P1', '520000009920') returning id into v_o;
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o, 'RC-1', 5000) returning id into v_v;
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v, 'diesel', 800) returning id into v_g;
  -- Con desglose VIEJO ya asentado, para comprobar que el ajuste lo SUSTITUYE
  -- (y no solo mueve total_comprobado/diferencia, que es el bug que cierra).
  v_l := guardar_liquidacion_tx(v_t, v_v, 800, 5000, 4200, 'revisar', '[{"tipo":"sobre_tope"}]'::jsonb, 3, 9, 5, null, 7);

  historial_nace_vacio := (select pdf_historial = '[]'::jsonb from liquidacion where id = v_l);

  -- (a) sin p_recalculo.
  begin
    perform revisar_liquidacion(v_t, v_l, 'ajustar', 'sin recálculo a propósito',
      jsonb_build_array(jsonb_build_object('gastoId', v_g, 'montoNuevo', 8000)), v_u, null);
  exception when sqlstate 'LR021' then sin_recalculo_rebota := true;
  end;

  -- (b) p_recalculo que NO coincide con la delta (800 + 7200 = 8000, no 9999).
  begin
    perform revisar_liquidacion(v_t, v_l, 'ajustar', 'recálculo que no cuadra',
      jsonb_build_array(jsonb_build_object('gastoId', v_g, 'montoNuevo', 8000)), v_u, null,
      jsonb_build_object('totalComprobado', 9999, 'diferencia', -1799, 'estatus', 'con_diferencias',
        'diferencias', '[]'::jsonb, 'iepsAcreditable', 0, 'litrosDieselAcreditables', 0, 'ivaAcreditable', 0, 'peajeAcreditable', 0));
  exception when sqlstate 'LR020' then mismatch_rebota := true;
  end;
  select monto into n_monto from gasto where id = v_g;
  select total_comprobado into n_total from liquidacion where id = v_l;
  mismatch_nada_movido := (n_monto = 800 and n_total = 800);

  -- (c) el ajuste bueno: el desglose ENTERO se sustituye por el recálculo.
  r := revisar_liquidacion(v_t, v_l, 'ajustar', 'el ticket dice 8,000',
    jsonb_build_array(jsonb_build_object('gastoId', v_g, 'montoNuevo', 8000)), v_u, null, recalculo_bueno);
  select total_comprobado, iva_acreditable, ieps_acreditable, peaje_acreditable,
         litros_diesel_acreditables, estatus, diferencias
    into n_total, n_iva, n_ieps, n_peaje, n_litros, n_estatus, n_diferencias
    from liquidacion where id = v_l;
  bueno_total := (n_total = 8000 and (r ->> 'total_comprobado')::numeric = 8000);
  bueno_iva := (n_iva = 1200.75);
  bueno_ieps := (n_ieps = 15.5);
  bueno_peaje := (n_peaje = 60);
  bueno_litros := (n_litros = 42.123);
  bueno_estatus := (n_estatus = 'con_diferencias');
  bueno_diferencias := (n_diferencias = '[{"tipo":"sobre_politica"}]'::jsonb);

  -- (d) pdf_historial acumula con `||`, sin pisar lo que ya había.
  perform agregar_pdf_historial(v_t, v_l, jsonb_build_object('url', 't1/x-ajustada-1.pdf', 'archivadaEn', now()));
  perform agregar_pdf_historial(v_t, v_l, jsonb_build_object('url', 't1/x-ajustada-2.pdf', 'archivadaEn', now()));
  select pdf_historial into n_hist from liquidacion where id = v_l;
  historial_acumula := (jsonb_array_length(n_hist) = 2
    and n_hist -> 0 ->> 'url' = 't1/x-ajustada-1.pdf' and n_hist -> 1 ->> 'url' = 't1/x-ajustada-2.pdf');

  raise exception E'AJUSTAR_RECALCULO_0306  sin-recalculo-rebota=%  mismatch-rebota=%  mismatch-nada-movido=%  bueno-total=%  bueno-iva=%  bueno-ieps=%  bueno-peaje=%  bueno-litros=%  bueno-estatus=%  bueno-diferencias=%  historial-nace-vacio=%  historial-acumula=%   (esperado t / t / t / t / t / t / t / t / t / t / t / t)',
    sin_recalculo_rebota, mismatch_rebota, mismatch_nada_movido, bueno_total, bueno_iva, bueno_ieps,
    bueno_peaje, bueno_litros, bueno_estatus, bueno_diferencias, historial_nace_vacio, historial_acumula;
end $$;
-- ── 252. Una liquidación RECHAZADA no cuenta: ni para la póliza (0281), ni para bloquear la reasignación del viaje (0158/0283) (mig. 0307, AUDITORÍA 25) ──
--
-- backend.md MEDIO (línea 226) + datos.md ALTO DATOS-24 (línea 194,
-- REINCIDENTE de la 24). La MISMA causa raíz en dos consumidores: la columna
-- `liquidacion.revision` (0299) nunca se propagó a todos los lugares que
-- preguntan «¿esta liquidación cuenta?».
--
-- Lo que este bloque asevera, contra Postgres real:
--   (a) `poliza_datos_tenant` YA NO trae la fila de una liquidación
--       rechazada — el MISMO criterio que `api/export/liquidaciones`
--       (`sin_rechazadas` por omisión, probado en TS) — y SÍ sigue trayendo
--       una `pendiente` (el filtro es solo `<> 'rechazada'`, no "solo
--       firmadas": eso lo decide la ruta, no esta RPC);
--   (b) reasignar `operador_id` de un viaje con una liquidación RECHAZADA ya
--       NO rebota con CU004 — el escenario medido: el contralor rechaza,
--       el encargado reasigna al chofer correcto, y antes de la 0307 el
--       trigger lo bloqueaba con «ya tiene liquidación emitida» sobre una
--       liquidación que el propio panel acababa de invalidar;
--   (c) el MISMO viaje, con una liquidación APROBADA (no rechazada), SIGUE
--       bloqueando la reasignación — la 0307 no abre la puerta de más.
-- Esperado: RECHAZADA_NO_CUENTA_0307  poliza-sin-rechazada=t  poliza-con-pendiente=t  reasignar-tras-rechazo=t  reasignar-tras-aprobada-rebota=t
do $$
declare
  v_t uuid; v_u uuid := gen_random_uuid(); v_o1 uuid; v_o2 uuid;
  v_v1 uuid; v_v2 uuid; v_l1 uuid; v_l2 uuid;
  j jsonb;
  poliza_sin_rechazada boolean; poliza_con_pendiente boolean;
  reasignar_tras_rechazo boolean := false; reasignar_tras_aprobada_rebota boolean := false;
begin
  insert into tenant (nombre) values ('ZZZ VERIF RECHAZADA NO CUENTA 0307') returning id into v_t;
  insert into app_user (id, tenant_id, email, rol) values (v_u, v_t, 'zzz-rechazada-0307@likida.test', 'flota_admin');
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P1', '520000009930') returning id into v_o1;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'P2', '520000009931') returning id into v_o2;

  -- (a) una liquidación que se RECHAZA por la RPC de verdad (el único camino
  -- que la tabla acepta — un INSERT/UPDATE directo de `revision` rebota con
  -- LR003) y una que se queda PENDIENTE, mismo periodo.
  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o1, 'RN-1', 5000) returning id into v_v1;
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v1, 'diesel', 4900);
  v_l1 := guardar_liquidacion_tx(v_t, v_v1, 4900, 5000, 100, 'con_diferencias', '[]'::jsonb, 0, 0, 0, null, 0);
  perform revisar_liquidacion(v_t, v_l1, 'rechazar', 'no es de este viaje', null, v_u, null);
  -- El rechazo YA devolvió el viaje a 'en_cuadre' (0299) — el escenario real.

  insert into viaje (tenant_id, operador_id, folio, anticipo) values (v_t, v_o2, 'RN-2', 5000) returning id into v_v2;
  insert into gasto (tenant_id, viaje_id, concepto, monto) values (v_t, v_v2, 'diesel', 5000);
  v_l2 := guardar_liquidacion_tx(v_t, v_v2, 5000, 5000, 0, 'con_diferencias', '[]'::jsonb, 0, 0, 0, null, 0); -- nace 'pendiente'

  j := poliza_datos_tenant(v_t, current_date - 1, current_date + 1);
  poliza_sin_rechazada := not (j::text like '%RN-1%');
  poliza_con_pendiente := (j::text like '%RN-2%');

  -- (b) el viaje de la RECHAZADA (v_v1, ya en 'en_cuadre') SÍ acepta
  -- reasignar operador ahora — antes de la 0307, CU004 lo bloqueaba.
  begin
    update viaje set operador_id = v_o2 where id = v_v1;
    reasignar_tras_rechazo := true;
  exception when others then
    reasignar_tras_rechazo := false;
  end;

  -- (c) control: una liquidación APROBADA (no rechazada, también por la RPC)
  -- SIGUE bloqueando la reasignación — la 0307 no abre la puerta de más.
  perform revisar_liquidacion(v_t, v_l2, 'aprobar', null, null, v_u, null);
  begin
    update viaje set operador_id = v_o1 where id = v_v2;
  exception when sqlstate 'CU004' then reasignar_tras_aprobada_rebota := true;
  end;

  raise exception E'RECHAZADA_NO_CUENTA_0307  poliza-sin-rechazada=%  poliza-con-pendiente=%  reasignar-tras-rechazo=%  reasignar-tras-aprobada-rebota=%   (esperado t / t / t / t)',
    poliza_sin_rechazada, poliza_con_pendiente, reasignar_tras_rechazo, reasignar_tras_aprobada_rebota;
end $$;

-- ── 253. El upsert del webhook de Stripe contra `factura_saas` YA NO revienta con 42P10 (mig. 0309) ──
--
-- AUDITORÍA 25, DATOS-A2 (ALTO). `factura_saas_stripe_unica` nació PARCIAL
-- (0052:105-106, `where stripe_invoice_id is not null`) y `aplicarFactura`
-- (suscripcion.ts) la usa como blanco de `.upsert({...}, { onConflict:
-- 'stripe_invoice_id' })`. PostgREST traduce eso a un `ON CONFLICT
-- (stripe_invoice_id) DO UPDATE` SIN predicado — Postgres solo infiere un
-- único PARCIAL si el ON CONFLICT repite su WHERE, que PostgREST no puede
-- escribir. La 0309 lo dejó NO parcial, la misma lección que la 0176 ya
-- aplicó a `uq_posicion_lectura`.
--
-- Este bloque reproduce el `INSERT … ON CONFLICT (stripe_invoice_id) DO
-- UPDATE …` EXACTO que PostgREST emite (sin WHERE), tal como lo haría el
-- primer webhook de Stripe: si el índice siguiera parcial, `upsert_sin_where`
-- saldría en `f` (rebota 42P10, atrapado por el `exception when others`).
-- También confirma que el segundo intento con el MISMO `stripe_invoice_id`
-- ACTUALIZA la misma fila (no inserta una segunda) y que el predicado viejo
-- era decorativo: dos facturas SIN `stripe_invoice_id` (pago por
-- transferencia) siguen conviviendo sin chocar contra el único no-parcial —
-- la semántica estándar de Postgres para NULLs en un índice único.
-- Esperado: STRIPE_ONCONFLICT_0309  no_parcial=t  upsert_sin_where=t
--   segunda_actualiza=t  una_sola_fila=t  nulos_conviven=t
do $$
declare
  v_t uuid;
  no_parcial boolean;
  upsert_sin_where boolean := false;
  v_f uuid;
  segunda_actualiza boolean := false;
  una_sola_fila boolean := false;
  nulos_conviven boolean := false;
begin
  select indpred is null into no_parcial
    from pg_index
   where indexrelid = 'public.factura_saas_stripe_unica'::regclass;

  insert into tenant (nombre) values ('ZZZ VERIF 0309') returning id into v_t;

  -- El upsert real de aplicarFactura, tal cual lo arma PostgREST: SIN WHERE.
  begin
    insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro, stripe_invoice_id)
      values (v_t, date '2026-09-01', date '2026-09-30', 2900, 'stripe', 'in_zzz_0309')
      on conflict (stripe_invoice_id) do update set monto = excluded.monto
      returning id into v_f;
    upsert_sin_where := true;
  exception when others then upsert_sin_where := false;
  end;

  -- El reintento de Stripe con el MISMO invoice: debe pisar la misma fila.
  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro, stripe_invoice_id)
    values (v_t, date '2026-09-01', date '2026-09-30', 3200, 'stripe', 'in_zzz_0309')
    on conflict (stripe_invoice_id) do update set monto = excluded.monto
    returning id into v_f;

  select (monto = 3200) into segunda_actualiza from factura_saas where id = v_f;
  select (count(*) = 1) into una_sola_fila from factura_saas where stripe_invoice_id = 'in_zzz_0309';

  -- El predicado viejo era decorativo: dos filas SIN invoice (transferencia)
  -- ya convivían sin él — un único no-parcial no compite entre NULLs.
  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro)
    values (v_t, date '2026-09-01', date '2026-09-30', 1000, 'transferencia');
  insert into factura_saas (tenant_id, periodo_inicio, periodo_fin, monto, metodo_cobro)
    values (v_t, date '2026-10-01', date '2026-10-31', 1500, 'transferencia');
  select (count(*) = 2) into nulos_conviven
    from factura_saas where tenant_id = v_t and stripe_invoice_id is null;

  raise exception E'STRIPE_ONCONFLICT_0309  no_parcial=%  upsert_sin_where=%  segunda_actualiza=%  una_sola_fila=%  nulos_conviven=%   (esperado t / t / t / t / t)',
    no_parcial, upsert_sin_where, segunda_actualiza, una_sola_fila, nulos_conviven;
end $$;

-- ── 254. Borrar un operador vacía SOLO `app_user.operador_id`, nunca `tenant_id` (mig. 0310) ──
--
-- AUDITORÍA 25, DATOS-M3 (MEDIO, REINCIDENTE DATOS-24). La 0290 dejó
-- `app_user_operador_tenant_fkey` con `on delete set null` SIN lista de
-- columnas — en Postgres eso anula TODAS las columnas de la FK compuesta, no
-- solo `operador_id`. `app_user.tenant_id` es nullable a propósito (0001:17,
-- «null = superadmin»), así que borrar un operador dejaba al encargado que lo
-- tenía con la FORMA reservada al superadmin: `get_user_tenant_ids()` le
-- devuelve `[]` y `/dashboard` le pinta su flota vacía sin un solo error.
--
-- La 0310 recreó la FK con `on delete set null (operador_id)`. Este bloque
-- hace el `DELETE FROM operador` real y mide las dos columnas por separado —
-- es justo la distinción que un `on delete set null` sin lista no puede
-- hacer, así que es lo único que puede demostrar que se corrigió.
-- Esperado: OPERADOR_TENANT_SET_NULL_0310  operador_id_null=t  tenant_id_intacto=t
do $$
declare
  ta uuid := gen_random_uuid();
  op uuid := gen_random_uuid();
  au uuid := gen_random_uuid();
  operador_id_null boolean;
  tenant_id_intacto boolean;
begin
  insert into public.tenant (id, nombre) values (ta, '__verif_0310__');
  insert into public.operador (id, tenant_id, nombre, telefono) values (op, ta, 'Duplicado', '5299937007 83');
  insert into public.app_user (id, tenant_id, email, rol, operador_id)
    values (au, ta, '__verif_0310__@likida.test', 'encargado', op);

  delete from public.operador where id = op;

  select (operador_id is null) into operador_id_null from public.app_user where id = au;
  select (tenant_id = ta) into tenant_id_intacto from public.app_user where id = au;

  raise exception E'OPERADOR_TENANT_SET_NULL_0310  operador_id_null=%  tenant_id_intacto=%   (esperado t / t)',
    operador_id_null, tenant_id_intacto;
end $$;

-- ── 255. `tenant_perfil_merge` ya no lo puede ejecutar `anon`/`authenticated` (mig. 0312) ──
--
-- AUDITORÍA 25, DATOS-B2 (BAJO, REINCIDENTE DE LA 24). La 0296 solo traía
-- `grant execute ... to service_role` — Postgres concede EXECUTE a PUBLIC por
-- default en funciones nuevas, y Supabase además concede explícito a
-- `anon`/`authenticated` por sus default privileges (0284:110-112). Un
-- `grant` a `service_role` no retira eso: hacía falta el `revoke` explícito.
-- Esperado: TENANT_PERFIL_MERGE_REVOKE_0312  anon=f  authenticated=f
do $$
declare
  anon_ok boolean; authenticated_ok boolean;
begin
  select has_function_privilege('anon', 'public.tenant_perfil_merge(uuid, jsonb, uuid)', 'EXECUTE')
    into anon_ok;
  select has_function_privilege('authenticated', 'public.tenant_perfil_merge(uuid, jsonb, uuid)', 'EXECUTE')
    into authenticated_ok;

  raise exception E'TENANT_PERFIL_MERGE_REVOKE_0312  anon=%  authenticated=%   (esperado f / f)',
    anon_ok, authenticated_ok;
end $$;

-- ── 256. `viaje` y `cfdi_consolidado_linea` entran al dominio de ve_finanzas() (mig. 0314) ──
--
-- AUDITORÍA 25, SEGURIDAD (ALTO, línea 88). El jefe de tráfico (`encargado`)
-- no debe ver el dinero de la flota — `visibilidad.ts:41` solo le da
-- 'operacion' — pero el panel lee con `supabaseAdmin()` (service_role, salta
-- RLS): la única frontera real contra un `curl` directo a PostgREST con la
-- cookie del propio encargado es esta policy. `viaje.anticipo`/`ingreso_flete`
-- y `cfdi_consolidado_linea.monto` se quedaron fuera de `ve_finanzas()` desde
-- que la 0048 empezó a aplicarla tabla por tabla — la 0158 partió la policy de
-- `viaje` en `tenant_data_select`/`_insert`/`_update` (por eso NO es
-- `tenant_data` como en el resto: la 0292 solo barre policies con ESE nombre
-- exacto) y `cfdi_consolidado_linea` nunca pasó por ninguna de las dos rondas.
--
-- Se impersona a un ENCARGADO. Esperado: 0 filas en las dos tablas.
do $$
declare
  v_t uuid; v_op uuid; v_cfdi uuid; v_u1 uuid := gen_random_uuid();
  n_viaje int; n_cfdi int;
begin
  insert into tenant (nombre) values ('ZZZ VERIF SEG88 RLS') returning id into v_t;
  insert into operador (tenant_id, nombre, telefono) values (v_t, 'ZZZ operador seg88', '5215559990188') returning id into v_op;
  insert into viaje (tenant_id, operador_id, folio, anticipo, ingreso_flete)
    values (v_t, v_op, 'ZZZ-SEG88', 5000.00, 18500.00);
  insert into cfdi_xml (tenant_id, cfdi_uuid, xml, tiene_multiples_conceptos)
    values (v_t, 'zzz-seg88-uuid', '<xml/>', true) returning id into v_cfdi;
  insert into cfdi_consolidado_linea (tenant_id, cfdi_xml_id, indice, fuente, monto, descripcion, estacion_rfc, fecha)
    values (v_t, v_cfdi, 1, 'ecc12', 1234.56, 'diesel zzz', 'XAXX010101000', now());

  insert into app_user (id, tenant_id, email, rol)
    values (v_u1, v_t, 'zzz-verif-encargado-seg88@likida.test', 'encargado');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1)::text, true);

  select count(*) into n_viaje from viaje where tenant_id = v_t;
  select count(*) into n_cfdi from cfdi_consolidado_linea where tenant_id = v_t;

  reset role;

  raise exception E'SEG88_RLS_DINERO  viaje_visible_a_encargado=%  cfdi_visible_a_encargado=%   (esperado 0 / 0 — cualquier otra cosa le abre el dinero de la flota al jefe de tráfico)',
    n_viaje, n_cfdi;
end $$;

-- ── 257. `tenant_perfil_merge` no es ejecutable por anon/authenticated (mig. 0315) ──
--
-- AUDITORÍA 25, SEGURIDAD (MEDIO, línea 202, REINCIDENTE). La 0296 concedía
-- `execute` a `service_role` sobre una función que ESCRIBE en `public.tenant`
-- sin el `revoke from public, anon, authenticated` que cierra el default
-- privilege de Postgres (lección de la 0013, mismo molde que 0284:110-113).
do $$
declare anon_puede boolean; authenticated_puede boolean; service_role_puede boolean;
begin
  anon_puede := has_function_privilege('anon', 'public.tenant_perfil_merge(uuid,jsonb,uuid)', 'EXECUTE');
  authenticated_puede := has_function_privilege('authenticated', 'public.tenant_perfil_merge(uuid,jsonb,uuid)', 'EXECUTE');
  service_role_puede := has_function_privilege('service_role', 'public.tenant_perfil_merge(uuid,jsonb,uuid)', 'EXECUTE');
  raise exception E'GRANT_TENANT_PERFIL_MERGE_0315  anon-ejecuta=%  authenticated-ejecuta=%  service-role-ejecuta=%   (esperado false / false / true)',
    anon_puede, authenticated_puede, service_role_puede;
end $$;

-- ── 258. Un superadmin inactivo no conserva PII ni siquiera con JWT vivo (mig. 0320) ──
-- Esperado: RLS_INACTIVO_PROSPECTO_0320 activo-ve-pii=1 inactivo-ve-pii=0 inactivo-ve-self=0
do $$
declare
  u_activo uuid := gen_random_uuid();
  u_baja uuid := gen_random_uuid();
  p uuid;
  activo_ve_pii int;
  inactivo_ve_pii int;
  inactivo_ve_self int;
begin
  insert into public.app_user (id, email, nombre, rol)
    values (u_activo, 'activo-0320@verif.local', 'Activo 0320', 'superadmin');
  insert into public.app_user (id, email, nombre, rol, activo, desactivado_en, desactivado_por)
    values (u_baja, 'baja-0320@verif.local', 'Baja 0320', 'superadmin', false, now(), u_activo);
  insert into public.prospecto (empresa) values ('ZZZ VERIF PII 0320') returning id into p;
  insert into public.prospecto_persona (prospecto_id, nombre, correo, origen, confianza)
    values (p, 'Persona 0320', 'persona-0320@example.invalid', 'sitio_empresa', 'alta');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u_activo)::text, true);
  select count(*) into activo_ve_pii from public.prospecto_persona where prospecto_id = p;

  perform set_config('request.jwt.claims', json_build_object('sub', u_baja)::text, true);
  select count(*) into inactivo_ve_pii from public.prospecto_persona where prospecto_id = p;
  select count(*) into inactivo_ve_self from public.app_user where id = u_baja;
  reset role;

  raise exception E'RLS_INACTIVO_PROSPECTO_0320 activo-ve-pii=% inactivo-ve-pii=% inactivo-ve-self=%   (esperado 1 / 0 / 0)',
    activo_ve_pii, inactivo_ve_pii, inactivo_ve_self;
end $$;

-- ── 263. Cal.com aplica ledger, orden y embudo en una sola transacción (mig. 0323) ──
-- Esperado: CALCOM_ATOMICO_0323 aplica=t unico=t orden=t terminal=t permisos=t
do $$
declare
  p uuid := gen_random_uuid();
  base timestamptz := clock_timestamp() - interval '3 hours';
  r record;
  aplica boolean := false;
  unico boolean := false;
  orden boolean := false;
  terminal boolean := false;
  permisos boolean := false;
begin
  insert into public.prospecto(id, empresa, correo, estado)
    values (p, 'ZZZ CALCOM ATOMICO 0323', 'calcom-0323@verif.invalid', 'contactado');

  select * into r from public.aplicar_evento_calcom_tx(
    'verif-0323-created-' || p, 'BOOKING_CREATED', 'booking-0323', p,
    '{}'::jsonb, base, null
  );
  aplica := r.resultado = 'aplicado' and exists (
    select 1 from public.prospecto
     where id = p and estado = 'appointment' and calcom_booking_id = 'booking-0323'
  );

  select * into r from public.aplicar_evento_calcom_tx(
    'verif-0323-created-' || p, 'BOOKING_CREATED', 'booking-0323', p,
    '{}'::jsonb, base, null
  );
  unico := r.resultado = 'repetido' and 1 = (
    select count(*) from public.comercial_evento
     where clave_idempotencia = 'verif-0323-created-' || p
  );

  perform public.aplicar_evento_calcom_tx(
    'verif-0323-cancel-' || p, 'BOOKING_CANCELLED', 'booking-0323', p,
    '{}'::jsonb, base + interval '2 hours', null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'verif-0323-late-' || p, 'BOOKING_CREATED', 'booking-0323', p,
    '{}'::jsonb, base + interval '1 hour', null
  );
  orden := r.resultado = 'ignorado' and exists (
    select 1 from public.prospecto where id = p and estado = 'cancelled'
  );

  update public.prospecto set estado = 'won', cerrado_en = clock_timestamp() where id = p;
  select * into r from public.aplicar_evento_calcom_tx(
    'verif-0323-terminal-' || p, 'BOOKING_RESCHEDULED', 'booking-0323-b', p,
    '{}'::jsonb, clock_timestamp(), 'booking-0323'
  );
  terminal := r.resultado = 'ignorado' and exists (
    select 1 from public.prospecto where id = p and estado = 'won'
  );

  select proc.prosecdef
      and coalesce(array_to_string(proc.proconfig, ','), '') like '%search_path=""%'
      and not has_function_privilege('anon', proc.oid, 'execute')
      and not has_function_privilege('authenticated', proc.oid, 'execute')
      and has_function_privilege('service_role', proc.oid, 'execute')
    into permisos
    from pg_proc proc
   where proc.oid = 'public.aplicar_evento_calcom_tx(text,text,text,uuid,jsonb,timestamptz,text,text[],text[],boolean,text,text)'::regprocedure;

  raise exception E'CALCOM_ATOMICO_0323 aplica=% unico=% orden=% terminal=% permisos=%   (esperado t / t / t / t / t)',
    aplica, unico, orden, terminal, permisos;
end $$;

-- ── 259. Snapshot de cierre: mismo conteo ya no oculta cambios fiscales (mig. 0321) ──
--
-- Toma un snapshot con UN gasto y conserva exactamente una fila mientras
-- cambia, por separado, monto, IVA y UUID; después prueba DELETE+INSERT con el
-- mismo conteo. Las cuatro llamadas deben abortar con CU006/snapshot_changed.
-- Finalmente toma el hash vigente y el cierre feliz debe guardar ese mismo
-- sello v1. Todo el DO termina con RAISE, así que no deja datos de verificación.
-- Esperado: CIERRE_SNAPSHOT_0321 monto=t iva=t uuid=t reemplazo=t feliz=t sello=t
do $$
declare
  ta uuid := gen_random_uuid();
  op uuid := gen_random_uuid();
  vi uuid := gen_random_uuid();
  ga uuid := gen_random_uuid();
  gb uuid := gen_random_uuid();
  h text;
  li uuid;
  monto_bloqueado boolean := false;
  iva_bloqueado boolean := false;
  uuid_bloqueado boolean := false;
  reemplazo_bloqueado boolean := false;
  feliz boolean := false;
  sello boolean := false;
begin
  insert into public.tenant (id, nombre, rfc, config, perfil)
    values (ta, 'ZZZ VERIF SNAPSHOT 0321', 'EKU9003173C9', '{}', '{}');
  insert into public.operador (id, tenant_id, nombre, telefono, rfc)
    values (op, ta, 'Operador 0321', '529993703217', 'EKU9003173C9');
  insert into public.viaje (id, tenant_id, operador_id, folio, anticipo, fecha_inicio)
    values (vi, ta, op, 'ZZZ-0321', 1000, date '2026-09-03');
  insert into public.gasto (
    id, tenant_id, viaje_id, concepto, monto, fecha, folio, folio_norm,
    cfdi_uuid, cfdi_orden, sub_total, iva_traslado, forma_pago
  ) values (
    ga, ta, vi, 'diesel', 1000, date '2026-09-03', 'A-0321', 'A-0321',
    '11111111-1111-4111-8111-111111111111', 1, 862.07, 137.93, '04'
  );

  h := public.cierre_insumos_hash(ta, vi);
  update public.gasto set monto = 900 where id = ga;
  begin
    perform public.guardar_liquidacion_tx(
      ta, vi, 900, 1000, 100, 'cuadrada', '[]', 0, 137.93, 0, null, 0, 1, h, 1
    );
  exception when sqlstate 'CU006' then monto_bloqueado := true;
  end;

  update public.gasto set monto = 1000 where id = ga;
  h := public.cierre_insumos_hash(ta, vi);
  update public.gasto set iva_traslado = 99 where id = ga;
  begin
    perform public.guardar_liquidacion_tx(
      ta, vi, 1000, 1000, 0, 'cuadrada', '[]', 0, 99, 0, null, 0, 1, h, 1
    );
  exception when sqlstate 'CU006' then iva_bloqueado := true;
  end;

  update public.gasto set iva_traslado = 137.93 where id = ga;
  h := public.cierre_insumos_hash(ta, vi);
  update public.gasto set cfdi_uuid = '22222222-2222-4222-8222-222222222222' where id = ga;
  begin
    perform public.guardar_liquidacion_tx(
      ta, vi, 1000, 1000, 0, 'cuadrada', '[]', 0, 137.93, 0, null, 0, 1, h, 1
    );
  exception when sqlstate 'CU006' then uuid_bloqueado := true;
  end;

  h := public.cierre_insumos_hash(ta, vi);
  delete from public.gasto where id = ga;
  insert into public.gasto (
    id, tenant_id, viaje_id, concepto, monto, fecha, folio, folio_norm,
    cfdi_uuid, cfdi_orden, sub_total, iva_traslado, forma_pago
  ) values (
    gb, ta, vi, 'diesel', 1000, date '2026-09-03', 'A-0321', 'A-0321',
    '22222222-2222-4222-8222-222222222222', 1, 862.07, 137.93, '04'
  );
  begin
    perform public.guardar_liquidacion_tx(
      ta, vi, 1000, 1000, 0, 'cuadrada', '[]', 0, 137.93, 0, null, 0, 1, h, 1
    );
  exception when sqlstate 'CU006' then reemplazo_bloqueado := true;
  end;

  h := public.cierre_insumos_hash(ta, vi);
  li := public.guardar_liquidacion_tx(
    ta, vi, 1000, 1000, 0, 'cuadrada', '[]', 0, 137.93, 0, null, 0, 1, h, 1
  );
  select estatus = 'liquidado' into feliz from public.viaje where id = vi;
  select insumos_hash = h and insumos_hash_version = 1 into sello
    from public.liquidacion where id = li;

  raise exception E'CIERRE_SNAPSHOT_0321 monto=% iva=% uuid=% reemplazo=% feliz=% sello=%   (esperado t / t / t / t / t / t)',
    monto_bloqueado, iva_bloqueado, uuid_bloqueado, reemplazo_bloqueado, feliz, sello;
end $$;

-- ── 260. Huérfano OCR: registro/vínculo atómico sin secuestro (mig. 0322) ──
-- Esperado: HUERFANO_VINCULO_0322 mismo=t vinculado=t secuestro=t permisos=t
do $$
declare
  ta uuid := gen_random_uuid();
  op1 uuid := gen_random_uuid();
  vi1 uuid := gen_random_uuid();
  vi2 uuid := gen_random_uuid();
  h jsonb := jsonb_build_object('id', gen_random_uuid(), 'concepto', 'diesel', 'monto', 0, 'imgHash', repeat('a', 64));
  id1 uuid;
  id2 uuid;
  mismo boolean := false;
  vinculado boolean := false;
  secuestro_bloqueado boolean := false;
  permisos boolean := false;
begin
  insert into public.tenant (id, nombre) values (ta, 'ZZZ VERIF HUERFANO 0322');
  insert into public.operador (id, tenant_id, nombre, telefono)
    values (op1, ta, 'Operador 0322 A', '529993703221');
  insert into public.viaje (id, tenant_id, operador_id, folio)
    values (vi1, ta, op1, 'ZZZ-HU-0322-A');

  id1 := public.guardar_comprobante_huerfano_tx(
    ta, op1, h, 'fallo_ocr', 'ta/v1/a.jpg', null
  );
  id2 := public.guardar_comprobante_huerfano_tx(
    ta, op1, h, 'fallo_ocr', 'ta/v1/a.jpg', vi1
  );
  mismo := id1 = id2;
  select viaje_id = vi1 into vinculado
    from public.comprobante_huerfano where id = id1;

  -- El mismo operador ya terminó el viaje A y abre el B. Reenviar exactamente
  -- la misma imagen no puede mover al B el incidente que quedó sellado en A.
  update public.viaje set estatus = 'liquidado' where id = vi1;
  insert into public.viaje (id, tenant_id, operador_id, folio)
    values (vi2, ta, op1, 'ZZZ-HU-0322-B');
  begin
    perform public.guardar_comprobante_huerfano_tx(
      ta, op1, h, 'fallo_ocr', 'ta/v2/a.jpg', vi2
    );
  exception when sqlstate 'HU001' then
    secuestro_bloqueado := true;
  end;
  secuestro_bloqueado := secuestro_bloqueado and exists (
    select 1 from public.comprobante_huerfano
    where id = id1 and operador_id = op1 and viaje_id = vi1
  );

  permisos := not has_function_privilege(
      'anon', 'public.guardar_comprobante_huerfano_tx(uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'
    ) and not has_function_privilege(
      'authenticated', 'public.guardar_comprobante_huerfano_tx(uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'
    ) and has_function_privilege(
      'service_role', 'public.guardar_comprobante_huerfano_tx(uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'
    );

  raise exception E'HUERFANO_VINCULO_0322 mismo=% vinculado=% secuestro=% permisos=%   (esperado t / t / t / t)',
    mismo, vinculado, secuestro_bloqueado, permisos;
end $$;
