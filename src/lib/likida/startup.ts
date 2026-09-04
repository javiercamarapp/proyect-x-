import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';

/**
 * Verifica que la migración 0005 (mutex try_lock_viaje + unique(viaje_id)) esté
 * aplicada. Si falta, la protección de doble liquidación NO está activa y hoy se
 * caía en SILENCIO — aquí se deja un error ruidoso. Best-effort: no tumba el
 * arranque (demo-safe; sin env/DB en build no rompe). 2.1.
 */

/**
 * ¿El error dice "eso no existe", o dice "no pude preguntar"?
 *
 * NO es una distinción cosmética. En producción, el 28-jul-2026, este chequeo
 * gritó «FALTA la migración 0005: la protección de doble liquidación NO está
 * activa» — y las cuatro migraciones estaban aplicadas. El error real era
 * `TypeError: fetch failed`: la base nunca contestó.
 *
 * Un diagnóstico falso cuesta dos veces. Primero manda a alguien a correr
 * `supabase db push` contra un problema que no existe. Y después, cuando el
 * aviso resulta ser mentira una vez, se aprende a ignorarlo — justo el aviso que
 * avisa de que el dinero se puede liquidar dos veces.
 *
 * Cómo se distinguen: PostgREST contesta a una función inexistente con un código
 * ('PGRST202', '42883'). Hubo respuesta, y dice que no está. Un fallo de red no
 * trae código: supabase-js envuelve el `TypeError` del fetch y `code` viene
 * vacío. Sin respuesta no se afirma nada sobre el esquema.
 */
function sinRespuesta(error: { code?: string; message?: string }): boolean {
  if (error.code) return false;
  return /fetch failed|network|timeout|abort|ECONN|EAI_AGAIN|socket/i.test(error.message ?? '');
}

/** Un solo sitio donde se decide qué se dice ante un error de probe. */
function reportarProbe(error: { code?: string; message?: string }, faltaMsg: string): void {
  if (sinRespuesta(error)) {
    logger.warn('startup.migraciones_sin_verificar', {
      msg: 'NO se pudo verificar el esquema: la base no respondió. Esto NO dice que falte ninguna migración — dice que no se pudo preguntar. Revisa conectividad con Supabase.',
      err: error.message,
    });
    return;
  }
  logger.error('startup.migraciones', { msg: faltaMsg, code: error.code, err: error.message });
}

/**
 * Un sondeo del esquema. Cada uno es INDEPENDIENTE: corre en paralelo con
 * los demás, acotado por `acotada` (TOPE_CONSULTA_MS), y reporta lo suyo.
 *
 * AUDITORÍA PROD (22-ago-2026), RES-2: hasta hoy eran 11 sondeos EN SERIE,
 * sin `acotada`, cada uno heredando el backstop de 25 s del cliente admin, y
 * `register()` los ESPERABA. Una base lenta en un arranque en frío podía
 * retener la primera petición de la instancia —el webhook de Meta incluido—
 * hasta 4-5 minutos antes del primer 200. Ahora el peor caso por sondeo es el
 * tope de consulta, todos corren a la vez, y `register()` no espera
 * (`void`): el diagnóstico sale por el log igual.
 *
 * Devuelve `true` si algo FALTA (no si no se pudo preguntar).
 */
type Sondeo = () => Promise<boolean>;

export async function verificarMigracionesCriticas(): Promise<void> {
  try {
    const admin = supabaseAdmin();
    // NINGÚN `return` temprano entre los sondeos. Los cuatro salían al primer
    // fallo, así que con dos migraciones ausentes solo se veía UNA por ciclo de
    // despliegue: se arreglaba, se volvía a desplegar, y aparecía la siguiente.
    // El arranque tiene que decir de una vez TODO lo que falta.
    const sondeos: Sondeo[] = [
      // AUDITORÍA PROD 03-sep-2026: los probes de funciones NO deben ejecutar
      // lógica de negocio. `guardar_liquidacion_tx` con UUID cero generó decenas
      // de errores reales en Postgres; el mutex tomó un viaje real y el CHECK 624
      // insertaba/borraba un tenant en cada arranque frío. La 0326 expone un solo
      // lector de catálogo que comprueba firma exacta, sobrecargas y definición
      // del CHECK sin tocar una fila de cliente.
      garantiasEsquema(admin),

      // Migración 0031: el TTL del MISMO contador. Se sonda leyendo la columna que
      // la migración agrega, y aquí sí sirve —al revés que el sondeo de la 0019,
      // que leía `cfdi_uuid`, una columna de `0001_init.sql` que responde igual con
      // índice o sin él—: `intake_pendientes_en` NACE en la 0031, así que su
      // ausencia es exactamente la señal. Lo que este sondeo no puede distinguir es
      // una base con la columna y el cuerpo viejo de la función; van en el mismo
      // archivo, que se aplica entero o no se aplica.
      //
      // Sin ella, un proceso que muere entre el `+1` y el `-1` deja el viaje con el
      // contador clavado: cada "listo" posterior espera la barrera completa y le
      // avisa al operador que su liquidación salió corta cuando estaba entera.
      columna(admin, 'viaje', 'intake_pendientes_en', 'FALTA la migración 0031 (viaje.intake_pendientes_en): el contador de la barrera no expira. Un OCR que muera sin ejecutar su `finally` deja ese viaje esperando 20s y avisando "liquidación corta" en cada cierre, para siempre. Corre `supabase db push`.'),

      // Migración 0016 (bandeja de códigos pendientes). Si falta, el acercamiento
      // que llega ANTES que su ticket no se puede guardar: el gasto se queda con
      // el folio que leyó la visión —el que baila— y nadie se entera, porque el
      // camino sigue "funcionando". Probe de lectura: no escribe nada.
      columna(admin, 'codigo_pendiente', 'id', 'FALTA la migración 0016 (codigo_pendiente): el acercamiento que llegue antes que su ticket pierde el folio exacto y el gasto se queda con el folio del OCR. Corre `supabase db push`.'),

      // ── ÍNDICES ÚNICOS. SE MIRA EL CATÁLOGO, QUE ES LO ÚNICO QUE LOS VE ─────
      //
      // AUDITORÍA 6, arquitectura. Aquí había un `select cfdi_uuid from gasto
      // where cfdi_uuid is not null limit 1` con un comentario afirmando que "se
      // sonda leyendo el índice". No lo leía: `cfdi_uuid` es una columna de
      // `0001_init.sql` y esa consulta responde igual de bien en una base donde la
      // 0019 nunca se aplicó. Tercera ronda seguida con el mismo hallazgo
      // —"anuncia que verifica y no verifica"—, y la última lo empeoró poniéndole
      // encima seis líneas que aseguraban lo contrario.
      //
      // Un chequeo que no puede fallar no protege nada. Sin la 0019 el MISMO CFDI
      // de diésel entra dos veces: se cuenta doble en el comprobado, su IVA se
      // acredita doble, y el operador aparece habiendo gastado lo que no gastó. El
      // motor deduplica por UUID en memoria, pero solo dentro de UNA liquidación.
      //
      // `indices_faltantes` (migración 0030) es de solo lectura y sirve para
      // cualquier índice futuro. Si ELLA falta, `reportarProbe` lo dirá como "no
      // se pudo preguntar", que es la verdad — no como "falta la 0019".
      catalogo(admin, 'indices_faltantes', INDICES, 'índice',
        'No se pudieron verificar los índices únicos (falta la migración 0030, `indices_faltantes`). Corre `supabase db push`.'),

      // AUDITORÍA 9, CRÍTICO (operabilidad): 0036/0037, el trigger que impide
      // que un gasto se inserte o se modifique DESPUÉS de emitida la
      // liquidación — "el peor bug histórico del camino del dinero" en
      // palabras de la propia 0036 (PDF y WhatsApp diciendo cifras contrarias
      // del mismo viaje), y ninguna línea de este archivo lo sondeaba. Mismo
      // motivo que los índices de arriba: PostgREST no expone `pg_trigger`,
      // así que hace falta `triggers_faltantes` (migración 0043).
      catalogo(admin, 'triggers_faltantes', TRIGGERS, 'trigger',
        'No se pudieron verificar los triggers de "nada entra tras liquidar" (falta la migración 0043, `triggers_faltantes`). Corre `supabase db push`.'),

      // ── LAS QUE EL CÓDIGO USA Y NADIE SONDEABA (auditoría prod, RES-9) ───
      //
      // El sondeo llegaba hasta la 0043 y el código vivo depende de la 0119
      // (bandeja durable del webhook), la 0132 (ciclo del evento de Stripe) y la
      // 0149 (claim completado ≠ reclamado). Un deploy sobre una base sin ellas
      // no rompe al arrancar: rompe en el primer mensaje, en el primer webhook
      // de Stripe, y —el peor— en el cron que sella como "procesado" un mensaje
      // que nunca corrió el OCR. Regla que esto fija: la migración aditiva va
      // ANTES que el código que la lee, y el arranque lo comprueba.
      ...Object.entries(COLUMNAS_RECIENTES).map(([clave, c]) => columna(admin, c.tabla, c.columna, `FALTA la migración ${clave} (${c.tabla}.${c.columna}): ${c.consecuencia} Corre \`supabase db push\`.`)),

    ];

    const resultados = await Promise.allSettled(sondeos.map((s) => s()));
    let faltan = false;
    for (const r of resultados) {
      if (r.status === 'fulfilled') { faltan = faltan || r.value; continue; }
      // Un sondeo que LANZA (cliente sin env, bucket inexistente…) no es
      // "falta la migración": se dice como lo que es y no se afirma nada.
      logger.warn('startup.migraciones_sondeo_fallo', { err: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
    if (!faltan) logger.info('startup.migraciones', { ok: true });
  } catch (e) {
    // Sin env/DB (p. ej. durante el build) → no romper, solo avisar.
    logger.warn('startup.migraciones_skip', { err: e instanceof Error ? e.message : String(e) });
  }
}

const GARANTIAS_ESQUEMA: Record<string, string> = {
  '0005:try_lock_viaje': 'FALTA la firma única de `try_lock_viaje` (0005/0280): el mutex del cierre no se puede adquirir de forma inequívoca.',
  '0280:unlock_viaje': 'FALTA la firma única de `unlock_viaje` (0280): el dueño del lease no puede liberarlo de forma cercada.',
  '0011:intake_delta': 'FALTA la firma única de `intake_delta` (0011/0031): la barrera de ráfaga no está disponible.',
  '0017:enriquecer_gasto_codigo': 'FALTA la firma única de `enriquecer_gasto_codigo` (0017): el folio exacto no se puede conciliar atómicamente.',
  '0033:confirmar_aviso_privacidad': 'FALTA la firma única de `confirmar_aviso_privacidad` (0033): no se puede escribir la constancia de entrega.',
  '0033:liberar_aviso_privacidad': 'FALTA la firma única de `liberar_aviso_privacidad` (0033): una reserva fallida puede quedar retenida.',
  '0022:guardar_liquidacion_tx': 'FALTA la firma única vigente de `guardar_liquidacion_tx` (0022/0321): una sobrecarga vuelve ambigua la llamada y NINGUNA liquidación puede cerrar.',
  '0172:tenant_regimen_fiscal_dominio:624': 'FALTA la garantía 0172: `tenant_regimen_fiscal_dominio` no está validado o no admite el régimen 624 Coordinados.',
};

/**
 * Un solo RPC de lectura reemplaza los probes que antes ejecutaban negocio.
 * La 0326 compara pg_proc/pg_constraint; no toma leases ni toca filas.
 */
function garantiasEsquema(admin: ReturnType<typeof supabaseAdmin>): Sondeo {
  return async () => {
    const { data, error } = await acotada(
      admin.rpc('garantias_arranque_faltantes'),
      'startup.garantias_arranque_faltantes',
    );
    if (error) {
      reportarProbe(
        error,
        'No se pudieron verificar las firmas críticas ni el CHECK 624 (falta la migración 0326, `garantias_arranque_faltantes`). Corre `supabase db push`.',
      );
      return true;
    }
    if (!Array.isArray(data) || data.length === 0) return false;
    for (const clave of data as string[]) {
      logger.error('startup.migraciones', {
        msg: `${GARANTIAS_ESQUEMA[clave] ?? `Garantía de esquema desconocida: ${clave}`}. Corre \`supabase db push\`.`,
      });
    }
    return true;
  };
}

const INDICES = {
  uq_gasto_cfdi_uuid: 'migración 0019: sin ella el mismo CFDI se liquida dos veces, con su IVA acreditado por duplicado',
  uq_operador_telefono_activo: 'migración 0024: sin ella un mismo teléfono puede resolver a dos operadores y el gasto se le carga a quien no fue',
  viaje_lock_pkey: 'migración 0005: sin el unique sobre viaje_id dos cierres concurrentes crean dos liquidaciones para el mismo viaje',
} as const;

const TRIGGERS = {
  trg_gasto_no_tras_liquidar: 'migración 0036: un gasto puede INSERTARSE después de emitida la liquidación — el PDF archivado y el WhatsApp que lee el operador dicen cifras contrarias del mismo viaje',
  trg_gasto_no_tras_liquidar_update: 'migraciones 0037/0042: un gasto puede REESCRIBIRSE (monto, fecha, CFDI) después de emitida la liquidación, con el mismo efecto',
} as const;

/**
 * Columnas que NACEN en migraciones recientes y que el código vivo lee. Se
 * sondean por lectura (`select columna limit 1`): la ausencia de la columna es
 * exactamente la señal. Exportada para que la prueba compruebe que la lista
 * alcanza a las migraciones de las que dependen conv.ts, wa_pendientes.ts y
 * suscripcion.ts.
 */
export const COLUMNAS_RECIENTES: Record<string, { tabla: string; columna: string; consecuencia: string }> = {
  '0119': { tabla: 'wa_evento_pendiente', columna: 'id', consecuencia: 'el webhook de WhatsApp no puede encolar el mensaje y el cron de la bandeja no tiene de dónde drenar: un mensaje que no cupo en la invocación se pierde.' },
  '0132': { tabla: 'evento_stripe', columna: 'aplicado_en', consecuencia: 'el webhook de Stripe no puede marcar el evento y cada cobro real responde 500: Stripe reintenta hasta rendirse y el plan pagado no se activa.' },
  '0149': { tabla: 'wa_mensaje_procesado', columna: 'completado_en', consecuencia: 'el claim del mensaje no distingue reclamado de completado: el cron de la bandeja sella como procesado un mensaje cuyo OCR nunca corrió.' },
  '0168': { tabla: 'cfdi_consolidado_linea', columna: 'litros', consecuencia: 'los litros del ECC se leen y se tiran: flota con monedero queda en cero IEPS.' },
  '0169': { tabla: 'tenant', columna: 'perfil', consecuencia: 'el onboarding no tiene dónde guardar lo declarado; el motor sigue aplicando el 50% de peaje sin condición.' },
  '0171': { tabla: 'gasto', columna: 'descuento', consecuencia: 'el estímulo de peaje se calcula sobre el SubTotal sin restar @Descuento del CFDI.' },
};

/** Sondeo por lectura de una columna: su ausencia ES la señal. */
function columna(admin: ReturnType<typeof supabaseAdmin>, tabla: string, col: string, faltaMsg: string): Sondeo {
  return async () => {
    const { error } = await acotada(admin.from(tabla).select(col).limit(1), `startup.${tabla}.${col}`);
    if (!error) return false;
    reportarProbe(error, faltaMsg);
    return true;
  };
}

/** Sondeo contra el catálogo vía una RPC `*_faltantes(p_esperados)`. */
function catalogo(
  admin: ReturnType<typeof supabaseAdmin>,
  rpc: 'indices_faltantes' | 'triggers_faltantes',
  esperados: Record<string, string>,
  clase: string,
  sinRpcMsg: string,
): Sondeo {
  return async () => {
    const { data, error } = await acotada(admin.rpc(rpc, { p_esperados: Object.keys(esperados) }), `startup.${rpc}`);
    if (error) {
      reportarProbe(error, sinRpcMsg);
      return true;
    }
    if (!Array.isArray(data) || data.length === 0) return false;
    for (const nombre of data as string[]) {
      logger.error('startup.migraciones', {
        msg: `FALTA el ${clase} \`${nombre}\` (${esperados[nombre] ?? 'sin descripción'}). Corre \`supabase db push\`.`,
      });
    }
    return true;
  };
}

/**
 * ¿La liga del aviso de privacidad integral EXISTE de verdad?
 *
 * ── EL MECANISMO ESTABA ESCRITO Y NADIE LO LLAMABA (auditoría 6, legal) ─────
 *
 * `revisarAvisoIntegral` es una revisión de FORMA: comprueba que la URL esté
 * bien escrita y sea https. Un dominio perfectamente escrito y sin registrar la
 * pasa. `sondearAvisoIntegral` es lo único que prueba existencia, y su propio
 * comentario dice dónde va: *"en un arranque, en un preflight de despliegue o en
 * un cron, donde un fallo se puede mirar"*. Ese arranque no existía: la función
 * solo la llamaban sus pruebas.
 *
 * Mientras tanto, el tenant real de producción cita
 * `flotademo.mx`, que responde NXDOMAIN. El aviso simplificado le
 * manda al operador esa liga rota y la respuesta ARCO también — y la rama
 * degradada que se escribió para ese caso ("la empresa aún no lo publica") no se
 * activa nunca, porque la revisión de forma dice `ok`.
 *
 * LFPDPPP art. 16 fr. II: el aviso simplificado debe *"señalar el sitio donde se
 * podrá consultar el aviso de privacidad integral"*. Un sitio que no resuelve no
 * es un sitio. Y como el integral es además el canal ARCO (art. 15 fr. V), la
 * liga rota se lleva por delante el ejercicio de derechos.
 *
 * NO bloquea el arranque ni el envío del aviso: un corte de red transitorio
 * daría un falso negativo, y cambiar un incumplimiento por otro no arregla nada.
 * Deja el diagnóstico donde se puede mirar, que es lo que faltaba.
 */
export async function verificarAvisoDePrivacidad(): Promise<void> {
  const tenantId = process.env.DEMO_TENANT_ID;
  if (!tenantId) return; // `arranque.ts` ya avisa de su ausencia; no se duplica.
  try {
    const { getDatosResponsable } = await import('./repo');
    const { sondearAvisoIntegral } = await import('./privacidad');

    const datos = await getDatosResponsable(tenantId);
    if (!datos) {
      logger.error('startup.aviso_privacidad', {
        msg: 'El tenant no tiene razón social o domicilio fiscal, así que NO se puede armar el aviso de privacidad y el tratamiento de datos se detiene en el primer mensaje. Captura `razon_social` y `domicilio_fiscal` en la tabla `tenant`.',
      });
      return;
    }

    const sondeo = await sondearAvisoIntegral(datos.urlAvisoIntegral);
    if (sondeo.abre) {
      logger.info('startup.aviso_privacidad', { ok: true });
      return;
    }
    logger.error('startup.aviso_privacidad', {
      motivo: sondeo.motivo,
      msg: `La liga del aviso de privacidad integral NO abre (${sondeo.motivo}). El aviso simplificado se la manda igual al operador, y es además el único canal para ejercer derechos ARCO (LFPDPPP art. 15 fr. V y 16 fr. II). Publica el aviso integral en una URL que resuelva y actualiza \`tenant.url_aviso_privacidad\`.`,
    });
  } catch (e) {
    // Igual que los sondeos de migración: sin env/DB durante el build, no rompe.
    logger.warn('startup.aviso_privacidad_skip', { err: e instanceof Error ? e.message : String(e) });
  }
}
