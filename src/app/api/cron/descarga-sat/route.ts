import { NextResponse } from 'next/server';
import { correrDescargaSat } from '@/lib/likida/sat_descarga/ciclo';
import { avisarCierrePeaje } from '@/lib/likida/sat_descarga/peaje_cierre';
import { leerInterruptor, type NombreInterruptor } from '@/lib/likida/interruptores';
import { logger } from '@/lib/logger';
import { codigoDeError } from '@/lib/observability/sentry';
import { alertarOperador } from '@/lib/observability/alerta';
import { puertaCron, registrarLatido } from '@/lib/admin/salud';
import { margenUnidadAtomicaMs } from '@/lib/likida/presupuesto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * EL CRON DE LA DESCARGA MASIVA DEL SAT (0231).
 *
 * CADA 6 HORAS, AL MINUTO 25. La cadencia la fija el SAT, no nosotros: una
 * solicitud tarda hasta seis días en madurar, así que preguntar cada minuto
 * sería quemar cuota para oír "sigue en proceso". Cuatro veces al día recoge
 * un paquete el mismo día que queda listo y deja margen de sobra dentro de las
 * 72 horas que vive antes de caducar.
 *
 * EL MINUTO 25 ESTÁ DESFASADO A PROPÓSITO. Los otros crons salen en 0, 5, 7 y
 * 15: amontonar uno más en el minuto 0 es pedir que la estampida se lleve la
 * cuota de la plataforma y el pool de conexiones a la misma hora. 25 no lo
 * comparte nadie.
 *
 * DOS TRABAJOS, UNA CORRIDA, y no es una mezcla arbitraria: son las dos caras
 * del mismo problema.
 *   1. `correrDescargaSat` recoge lo que el comercio YA timbró — lo que cae
 *      solo.
 *   2. `avisarCierrePeaje` avisa de lo que NO cae solo y cuyo derecho a
 *      facturar se extingue el último día del mes (PASE). Corre aquí porque
 *      necesita el mismo grano fino: un aviso que llegue el día 1 del mes
 *      siguiente no vale nada.
 *
 * EL AVISO DE PEAJE NO DEPENDE DE QUE LA DESCARGA ESTÉ CONFIGURADA. Es la
 * distinción entera: una flota SIN e.firma ni contrato de PAC igual pierde el
 * derecho a facturar sus casetas cada 30 días, y merece el aviso. Por eso los
 * dos trabajos se cuentan por separado en la respuesta y el segundo corre
 * aunque el primero devuelva "no configurado".
 */
export async function GET(req: Request) {
  const puerta = await puertaCron('descarga-sat', req, 'La descarga masiva del SAT no corre sin él.');
  if (puerta) return puerta;

  // Fail-closed: `ilegible` es FALLO (500), no salto. No saber si algo está
  // apagado no es lo mismo que saber que está encendido.
  for (const nombre of ['global', 'agente:descarga_sat'] as NombreInterruptor[]) {
    const v = await leerInterruptor(nombre);
    if (v === 'ilegible') {
      // El latido ANTES del 500 (tableros al día, 28-ago-2026): sin él este
      // camino era mudo y el tablero decía «No late» sin la causa. El nombre
      // de la palanca ilegible va en `cual`, NUNCA en `interruptor`: esa llave
      // del detalle es la que `motivoDeSalto()` lee como «apagado a propósito».
      await registrarLatido('descarga-sat', 'fallo', { codigo: 'interruptor_ilegible', cual: nombre });
      return NextResponse.json({
        corrio: false,
        error: `No se pudo leer el interruptor ${nombre}: la descarga no corre sin saber si está apagada.`,
        codigo: 'interruptor_ilegible',
        interruptor: nombre,
      }, { status: 500 });
    }
    if (v === 'apagado') {
      logger.warn('cron.descarga-sat.saltado', { interruptor: nombre });
      await registrarLatido('descarga-sat', 'saltado', { interruptor: nombre });
      return NextResponse.json({ corrio: false, saltado: `interruptor ${nombre}` });
    }
  }

  // EL RELOJ DE LA VUELTA, fijado ANTES del primer trabajo (patrón #152 y de
  // la ruta del runner). `avisarCierrePeaje` itera flota por flota con un
  // WhatsApp de por medio y corre DESPUÉS de `correrDescargaSat`, que se lleva
  // el tiempo que quiera: sin un instante límite absoluto, el barrido del peaje
  // hereda lo que sobre y se lo come entero, y Vercel corta la función dentro
  // del bucle sin que se escriba el latido. Es el modo de falla que dejó al
  // runner mudo el 25-ago-2026 y el 28-ago-2026.
  //
  // El margen protege lo que va DESPUÉS del barrido: el latido y la respuesta.
  // Es lo último de la fila, o sea lo primero que se pierde — y es justo lo
  // único que haría visible el problema en un tablero.
  //
  // ── AUDITORÍA 28, ALTO REINCIDENTE (REN-A5): 20 s era el mismo literal
  // copiado de `cron/gps/route.ts`, sin derivarlo de las dos cadenas que este
  // cron de verdad despacha (ambas comparten el MISMO `venceEn`, corren en
  // SERIE — nunca en vuelo las dos a la vez — así que el margen cubre a la MÁS
  // CARA de las dos, no la suma). Verificado contra el código de HOY,
  // 7-sep-2026:
  //   • `correrDescargaSat` → `ingerir()` (sat_descarga/ciclo.ts), camino
  //     "casado" (el más caro de sus cuatro destinos, sin `consolidado`: ese
  //     JOIN pagina sobre TODO el mes y queda fuera de esta cuenta a
  //     propósito — no es una unidad atómica de costo fijo, es una lectura
  //     acotada por su propio `traerTodo`/`MAX_PAGINAS`, un riesgo aparte que
  //     este PR no toca): sello (upsert) + ligar + saveCfdiXmlRaw + marcar
  //     → 4 consultas, 0 envíos (~38 s).
  //   • `avisarCierrePeaje` (sat_descarga/peaje_cierre.ts), por flota:
  //     reservar + telefonoParaDineroDe + sendText (envío SÍNCRONO real, con
  //     `AbortSignal.timeout(SEND_TIMEOUT_MS)`, a diferencia del encolado del
  //     cron de gps) + soltarReserva si no se entregó
  //     → 3 consultas + 1 envío (~38.5 s) ← la más cara de las dos.
  // (La 27 hablaba de "4 consultas + 1 envío ≈ 48 s" para "la cadena más cara
  // de sus dos bucles": el código de hoy da 38.5 s para `avisarCierrePeaje`,
  // no 48 — se documenta la diferencia aquí y en el PR y se deriva el margen
  // de la cadena real en vez de la cifra vieja.)
  const MARGEN_MS = margenUnidadAtomicaMs({ consultas: 3, envios: 1 });
  const venceEn = Date.now() + maxDuration * 1000 - MARGEN_MS;

  try {
    // EL RELOJ ENTRA TAMBIÉN A LA DESCARGA (c7-1; deuda anotada por el fork del
    // #160). Antes `venceEn` se calculaba aquí arriba y solo se le pasaba a
    // `avisarCierrePeaje`: el barrido del SAT corría sin reloj propio, y cuando
    // se comía la vuelta el síntoma era el aviso de peaje saliendo con
    // `sinTurno` alto — o sea que el trabajo que se sacrificaba era el del OTRO,
    // el que sí se había portado bien. El problema era visible y no estaba
    // arreglado. Ahora los dos comparten el MISMO instante límite, que es lo
    // que hace que el reparto del tiempo sea una regla y no una carrera.
    const descarga = await correrDescargaSat(new Date(), { venceEn });
    // El aviso de peaje va DESPUÉS y en su propio try: si la descarga tropieza
    // con el proveedor, el reloj del cierre de mes sigue corriendo igual y el
    // contralor merece su aviso.
    let peaje: Awaited<ReturnType<typeof avisarCierrePeaje>> | null = null;
    let peajeError: string | null = null;
    try {
      peaje = await avisarCierrePeaje(new Date(), { venceEn });
    } catch (e) {
      peajeError = e instanceof Error ? e.message : String(e);
      logger.error('cron.descarga-sat.peaje_falló', { error: peajeError });
    }

    const errores = descarga.resumenes.reduce((n, r) => n + r.errores.length, 0);
    const cfdis = descarga.resumenes.reduce((n, r) => n + r.cfdisNuevos, 0);
    const casados = descarga.resumenes.reduce((n, r) => n + r.casados, 0);
    logger.info('cron.descarga-sat.ok', {
      corrio: descarga.corrio, flotas: descarga.flotas, cfdis, casados, errores,
    });

    // 'parcial' cuando algo no salió limpio: un latido verde con errores
    // adentro es la clase de mentira que este panel no se permite. "No
    // configurado" TAMBIÉN es parcial — el circuito no está haciendo su
    // trabajo, y llamarlo 'ok' escondería que falta el contrato del PAC.
    //
    // UN BARRIDO CORTADO POR EL RELOJ, O UNA LECTURA TRUNCADA, TAMPOCO SON
    // 'ok'. Las dos significan flotas que no recibieron su aviso —y el aviso
    // de peaje no admite postergarse: el derecho a facturar el cruce se
    // extingue el último día del mes—. Un latido verde encima de eso es
    // exactamente la clase de mentira que este panel no se permite, y es la
    // única señal que haría visible el problema.
    // Y LA DESCARGA CORTADA POR RELOJ TAMPOCO ES 'ok'. Es la mitad que faltaba:
    // el latido ya sabía leer un barrido de peaje cortado, pero un barrido del
    // SAT cortado —flotas sin abrir, solicitudes sin verificar, paquetes listos
    // sin bajar— se reportaba verde. Son CFDI que no entraron: el gasto sigue
    // sin su comprobante y nadie se entera hasta que alguien cuadra a mano.
    const peajeParcial = (peaje?.sinTurno ?? 0) > 0 || (peaje?.truncado ?? false);
    const descargaParcial = descarga.sinTurno > 0;
    const sano = descarga.corrio && errores === 0 && peajeError === null && !peajeParcial && !descargaParcial;
    await registrarLatido('descarga-sat', sano ? 'ok' : 'parcial', {
      flotas: descarga.flotas, cfdis, casados, errores,
      motivo: descarga.motivo ?? null,
      // AUDITORÍA PROD 29-AGO-2026 (ronda 21): señal ESTRUCTURADA de hueco de
      // configuración, no la prosa de `motivo`. `esHuecoDeConfiguracion`
      // (`admin/salud.ts`) la prefiere sobre el regex de texto libre, así que
      // las cuatro ramas de `estadoDescargaSat()` (proveedor ausente,
      // declarado y no construido, desconocido, o credenciales incompletas)
      // se clasifican igual sin depender de cómo esté redactado `motivo`.
      configAusente: !descarga.configurado,
      descargaSinTurno: descarga.sinTurno,
      peajeAvisadas: peaje?.avisadas ?? null,
      peajeSinTurno: peaje?.sinTurno ?? null,
      peajeTruncado: peaje?.truncado ?? null,
    });

    return NextResponse.json({
      ...descarga,
      cfdis, casados, errores,
      peaje: peaje ?? { corrio: false, error: peajeError },
    }, { status: 200 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const codigo = codigoDeError(e);
    logger.error('cron.descarga-sat.falló', { error, codigo });
    await alertarOperador('cron.descarga-sat', { error, codigo });
    await registrarLatido('descarga-sat', 'fallo', { codigo });
    return NextResponse.json({ error }, { status: 500 });
  }
}
