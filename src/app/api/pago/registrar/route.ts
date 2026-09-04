import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { logger } from '@/lib/logger';
import { DatoInvalido } from '@/lib/likida/errores';
import { esCarnada, validarPropuesta, identificaFactura, TEXTO_LIGA_NO_VALIDA } from '@/lib/likida/portal_pago';
import { resolverLiga, vistaDelPortal, anotarAcceso } from '@/lib/likida/portal_pago_lectura';
// `portal_pago_propuesta` y NO `portal_pago_escritura`: aquél trae SOLO el
// verbo del cliente. Importar el de las escrituras del contralor metería
// `sharp` y `zxing-wasm` (vía `registrarPago` → `intake/cfdi`) en el arranque
// en frío de la página que un tercero abre desde su teléfono para pagar.
import { registrarPropuesta } from '@/lib/likida/portal_pago_propuesta';
import { avisarPropuestaAlContralor } from '@/lib/likida/portal_pago_aviso';

// ═══════════════════════════════════════════════════════════════════════════
// EL CLIENTE REGISTRA SU PAGO. La segunda ruta pública de escritura del
// producto, y la primera que toca dinero.
//
// Candados, EN ESTE ORDEN (el molde es `/api/marketing/prospecto`, #124):
//
//  1. Límite de tasa por IP (10 / 10 min), antes de leer el stream.
//  2. Tope de cuerpo (4 KB) durante la lectura. Cinco campos caben de sobra.
//  3. Honeypot (`sitioWeb`): si viene lleno, 200 SIN escribir. Decirle al bot
//     que lo cachamos es enseñarle a esquivarlo la próxima vez.
//  4. El token, resuelto contra la base. Un token que no vale contesta 404 con
//     el MISMO texto para las cuatro razones (no existe / caducó / revocado /
//     basura): distinguirlas volvería esta ruta un oráculo para quien prueba.
//  5. La validación REAL, contra la factura de verdad: no se puede pagar antes
//     de que exista, ni después de hoy, ni por encima del saldo. Y si el saldo
//     NO SE PUDO LEER, no se acepta nada — ver `validarPropuesta`.
//
// ── POR QUÉ EL TOKEN VIAJA EN EL CUERPO Y NO EN LA RUTA ──────────────────
//
// Un POST a `/api/pago/<token>` deja la credencial en el path, que es lo que
// acaba en los logs de acceso de la plataforma y en cualquier traza. La página
// que muestra la factura no tiene alternativa —es una URL que la persona
// abre—, pero el envío sí: aquí va en el body, que no se registra.
//
// ── LO QUE ESTA RUTA NO PUEDE HACER ───────────────────────────────────────
//
// Escribir en `pago_recibido`. No hay camino desde aquí hasta el abono real:
// `registrarPropuesta` inserta en una tabla que la cartera no lee. La única
// función que crea un abono es `conciliarPropuesta`, que exige sesión y rol.
// ═══════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

interface Cuerpo {
  token?: unknown;
  fecha?: unknown;
  monto?: unknown;
  referencia?: unknown;
  metodo?: unknown;
  /** El honeypot. Ninguna persona lo ve. */
  sitioWeb?: unknown;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function POST(req: Request) {
  if (!(await rateLimit(`portal-pago:${clientIp(req)}`, 10, 10 * 60_000))) {
    return NextResponse.json({ error: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.' }, { status: 429 });
  }
  const lectura = await leerTextoAcotado(req, 4_000);
  if (!lectura.ok) {
    return NextResponse.json(
      { error: lectura.motivo === 'demasiado_grande' ? 'El cuerpo es demasiado grande.' : 'No se entendió el envío. Recarga la página.' },
      { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 },
    );
  }

  let c: Cuerpo;
  try {
    c = JSON.parse(lectura.texto) as Cuerpo;
  } catch {
    return NextResponse.json({ error: 'No se entendió el envío. Recarga la página.' }, { status: 400 });
  }

  // Honeypot: 200 sin escribir, y el log queda para poder medir el ruido.
  if (esCarnada(c.sitioWeb)) {
    logger.info('portal_pago.honeypot', {});
    return NextResponse.json({ ok: true, mensaje: 'Listo. Ya quedó registrado tu pago.' });
  }

  const resolucion = await resolverLiga(s(c.token));
  if (!resolucion.ok) {
    // 503 cuando no se pudo PREGUNTAR: un bache de red no puede decirle a un
    // cliente legítimo que su enlace murió y mandarlo a pedir otro.
    if (resolucion.motivo === 'no_disponible') {
      return NextResponse.json(
        { error: 'Ahora mismo no podemos consultar tu factura. Vuelve a intentarlo en unos minutos.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: TEXTO_LIGA_NO_VALIDA }, { status: 404 });
  }
  const liga = resolucion.liga;

  // La factura REAL, para validar contra ella y para poder redactar el aviso.
  const vista = await vistaDelPortal(liga);
  if (!vista.ok) {
    if (vista.motivo === 'no_disponible') {
      return NextResponse.json(
        { error: 'Ahora mismo no podemos consultar tu factura. Vuelve a intentarlo en unos minutos.' },
        { status: 503 },
      );
    }
    if (vista.motivo === 'no_cobrable') {
      // `c7-7`: una factura CANCELADA no recibe pagos, ni siquiera por POST
      // directo. La página ya no enseña el formulario, pero esta ruta es
      // pública y no puede depender de que nadie la llame a mano. 409: el
      // envío se entiende perfectamente, lo que ya no existe es la deuda.
      return NextResponse.json(
        {
          error: vista.estatus === 'cancelada'
            ? 'Esa factura fue cancelada, así que aquí ya no se puede registrar un pago. Si ya la pagaste, escríbele directamente a quien te la emitió.'
            : 'Esa factura todavía no está emitida, así que aquí no se puede registrar un pago.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: TEXTO_LIGA_NO_VALIDA }, { status: 404 });
  }
  const v = vista.vista;

  let valores;
  try {
    valores = validarPropuesta(
      { fecha: s(c.fecha), monto: s(c.monto), referencia: s(c.referencia), metodo: s(c.metodo) },
      { fechaFactura: v.factura.fecha, saldo: v.factura.saldo },
    );
  } catch (e) {
    if (e instanceof DatoInvalido) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    logger.error('portal_pago.validacion', { err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: 'No pudimos registrar tu pago. Vuelve a intentarlo.' }, { status: 500 });
  }

  const r = await registrarPropuesta(liga, valores);
  if (!r.ok) {
    return NextResponse.json({ error: r.motivo }, { status: 503 });
  }

  if (r.repetida) {
    // No es un error y no se cuenta como hecho nuevo: ni bitácora de acceso ni
    // aviso. Es el segundo clic, o el cliente comprobando que sí quedó.
    // El texto puede afirmar esto porque el índice de la 0237 es PARCIAL sobre
    // las pendientes (`c7-18`): un 23505 significa que hay una propuesta igual
    // ESPERANDO en la bandeja del contralor. Con el índice anterior también
    // chocaba contra una ya DESCARTADA, y entonces esta frase era falsa: le
    // decía «no hace falta hacer nada más» a un cliente cuyo registro no iba a
    // volver a la bandeja de nadie.
    return NextResponse.json({
      ok: true,
      mensaje: 'Ese pago ya estaba registrado con la misma fecha, monto y referencia, y sigue por confirmar. No hace falta hacer nada más.',
    });
  }

  await anotarAcceso(liga, 'pago_propuesto', { monto: valores.monto, fecha: valores.fecha });

  // El aviso NUNCA lanza y NUNCA cambia la respuesta al cliente: su pago ya
  // quedó registrado. Que el correo del contralor no salga es un problema de
  // la flota, no del cliente que acaba de cumplir.
  const aviso = await avisarPropuestaAlContralor(
    v.tenantId,
    {
      flota: v.flota,
      cliente: v.cliente,
      identificaFactura: identificaFactura(v.factura),
      fecha: valores.fecha,
      monto: valores.monto,
      referencia: valores.referencia,
      metodo: valores.metodo,
    },
    r.id,
  );
  if (!aviso.enviado) logger.warn('portal_pago.aviso_no_salio', { porque: aviso.porque });

  return NextResponse.json({
    ok: true,
    mensaje: 'Listo. Tu pago quedó registrado y le avisamos a quien te emitió la factura. Todavía tiene que confirmarlo contra su estado de cuenta — cuando lo haga, lo verás aquí mismo.',
  });
}
