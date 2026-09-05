import { NextRequest, NextResponse } from 'next/server';
import { verificarFirmaStripe, webhookConfigurado, eventoEnModoDeLaLlave } from '@/lib/saas/stripe';
import {
  marcarEvento, sellarEventoAplicado, aplicarSuscripcion, aplicarFactura, estadoDesdeStripe,
  tenantDeCustomer, planDePrice, cancelarFacturaDeStripe,
} from '@/lib/saas/suscripcion';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { logger } from '@/lib/logger';
import { registrarEventoSeguridad } from '@/lib/seguridad/eventos';
import { hoyMx } from '@/lib/formato';

// ── EL TECHO DEL CUERPO (auditoría prod, DAT-40) ──────────────────────────
//
// Estaban 256 KB, y un evento de Stripe los pasa sin ser raro: un `invoice`
// con muchas líneas, o cualquier objeto con `previous_attributes` grande. Y el
// 413 no es inocuo aquí: Stripe reintenta con backoff, se rinde a los tres
// días y ESE cobro no se registra nunca — el mismo modo de falla silencioso
// que el resto del archivo existe para evitar. 1 MiB deja pasar lo que Stripe
// manda de verdad y sigue frenando un cuerpo absurdo.
const MAX_BODY = 1024 * 1024;

export const runtime = 'nodejs';
export const maxDuration = 60;

// ═══════════════════════════════════════════════════════════════════════════
// EL WEBHOOK DE STRIPE — lo que convierte un pago en un plan activo.
//
// ESTE ENDPOINT ES PÚBLICO Y CAMBIA QUIÉN TIENE PLAN PAGADO. Sin firma válida,
// cualquiera puede llamarlo y activarse el plan Empresa gratis; por eso lo
// primero es el HMAC y por eso NO hay modo "sin secreto configurado": si falta
// `STRIPE_WEBHOOK_SECRET` se contesta 503 y no se procesa nada. Un endpoint que
// acepta sin verificar porque "todavía no está configurado" es una puerta
// abierta que nadie recuerda cerrar.
//
// SE CONTESTA 200 SOLO SI SE APLICÓ. Stripe reintenta ante cualquier no-2xx, y
// eso es exactamente lo que se quiere cuando la base falló: el evento vuelve.
// Contestar 200 "para que deje de insistir" pierde el pago en silencio.
// ═══════════════════════════════════════════════════════════════════════════

interface EventoStripe {
  id: string;
  type: string;
  /** `true` = evento de dinero real; `false` = sandbox. Es lo ÚNICO que
   *  distingue un cobro de una prueba (DAT-32). */
  livemode?: boolean;
  /** Segundos Unix. Es lo ÚNICO que ordena dos eventos de la misma
   *  suscripción cuando Stripe los entrega al revés (RES-11). */
  created?: number;
  data: { object: Record<string, unknown> };
}

export async function POST(req: NextRequest) {
  if (!webhookConfigurado()) {
    logger.error('stripe.webhook.sin_secreto', {});
    return new NextResponse('Stripe webhook no configurado', { status: 503 });
  }

  const lectura = await leerTextoAcotado(req, MAX_BODY);
  if (!lectura.ok) {
    return new NextResponse(
      lectura.motivo === 'demasiado_grande' ? 'Payload too large' : 'Could not read payload',
      { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 },
    );
  }
  const crudo = lectura.texto;

  // La firma va sobre el cuerpo EXACTO como llegó. Cualquier `JSON.parse` +
  // `stringify` antes de esto cambia bytes y la firma deja de validar.
  if (!verificarFirmaStripe(crudo, req.headers.get('stripe-signature'))) {
    logger.warn('stripe.webhook.firma_invalida', {});
    void registrarEventoSeguridad({ origen: 'stripe_webhook', tipo: 'firma_invalida', severidad: 'alta' });
    return new NextResponse('Firma inválida', { status: 401 });
  }

  let evt: EventoStripe;
  try {
    evt = JSON.parse(crudo) as EventoStripe;
  } catch {
    return new NextResponse('JSON inválido', { status: 400 });
  }

  // ── EL MODO TIENE QUE COINCIDIR (DAT-32) ─────────────────────────────────
  //
  // La firma NO contesta esto: el secreto es del ENDPOINT, no del modo. Un
  // endpoint de prueba apuntando al dominio de producción —o el mismo secreto
  // pegado en los dos— entrega eventos de sandbox que la base no distingue de
  // los reales: plan activado, factura "pagada", cero pesos cobrados.
  //
  // Se contesta 400 y NO se marca el evento: marcarlo lo daría por atendido
  // para siempre, y lo que hace falta es que quede visible en el panel de
  // Stripe como entrega fallida. Si la llave estaba mal, se arregla y se
  // reenvía desde ahí.
  if (!eventoEnModoDeLaLlave(evt.livemode)) {
    logger.error('stripe.webhook.modo_no_coincide', { id: evt.id, tipo: evt.type, livemode: evt.livemode ?? null });
    void registrarEventoSeguridad({
      origen: 'stripe_webhook', tipo: 'otro', severidad: 'alta',
      detalle: { que: 'modo_no_coincide', tipoEvento: evt.type, livemode: evt.livemode ?? null },
    });
    return new NextResponse('Modo (test/live) del evento distinto al de la llave configurada', { status: 400 });
  }

  try {
    // Candado ANTES de aplicar: el insert es la carrera ganada, no un select.
    // CICLO DE VIDA (0132): 'aplicada' contesta repetido; 'pendiente' es un
    // intento anterior muerto a medias y se RE-aplica (los apliques son
    // idempotentes); la marca NO se borra jamás — la "marca huérfana" dejó
    // de existir como modo de falla.
    const marca = await marcarEvento(evt.id, evt.type, evt.data?.object ?? null);
    if (marca === 'aplicada') return NextResponse.json({ ok: true, repetido: true });

    await aplicar(evt);
    await sellarEventoAplicado(evt.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // 500 A PROPÓSITO: que Stripe reintente. La fila queda con
    // `aplicado_en = null`, así que el reintento entra como 'pendiente' y
    // vuelve a aplicar — nada que borrar, nada que quede huérfano.
    logger.error('stripe.webhook.fallo', {
      id: evt.id, tipo: evt.type, err: e instanceof Error ? e.message : String(e),
    });
    return new NextResponse('Error al aplicar', { status: 500 });
  }
}

// ── La distinción que sostiene este switch ─────────────────────────────────
// · "Evento que NO nos concierne" (el default): se contesta 200 y se ignora.
//   Stripe manda decenas de tipos; no reconocerlos no es un fallo.
// · "Evento que SÍ nos concierne pero cuya lógica falló" (sin tenant, price
//   sin plan): se LANZA. Un `return` aquí dejaría el evento marcado como
//   aplicado + 200 → Stripe JAMÁS lo reintenta y el pago se pierde en
//   silencio. Lanzando, el catch del POST desmarca y contesta 500, y el
//   reintento de Stripe (con backoff de días) vuelve a intentar — que además
//   es el camino que SÍ se arregla solo: un invoice que llegó antes que su
//   subscription resuelve el tenant al reintento, y un price recién creado
//   aplica en cuanto /admin lo liga al plan.
// ───────────────────────────────────────────────────────────────────────────
async function aplicar(evt: EventoStripe): Promise<void> {
  const obj = evt.data?.object ?? {};

  switch (evt.type) {
    // El checkout terminó. Trae `client_reference_id` con la flota; es el único
    // evento que la sabe con certeza sin consultar nada.
    case 'checkout.session.completed': {
      const tenantId = (obj.client_reference_id as string) ?? (obj.metadata as Record<string, string>)?.tenant_id;
      const subId = obj.subscription as string | null;
      if (!tenantId || !subId) {
        // `crearCheckout` SIEMPRE manda client_reference_id + metadata.tenant_id
        // y solo crea checkouts de suscripción: que falte cualquiera de los dos
        // es un pago real que no se puede atribuir, no un evento ajeno.
        logger.error('stripe.checkout.sin_atribucion', { evt: evt.id, tenantId: tenantId ?? null, subId });
        throw new Error(`checkout ${evt.id} sin flota o sin suscripción atribuible — un pago real quedaría sin aplicar; se lanza para que Stripe lo reintente`);
      }
      // El estado real lo trae `customer.subscription.*`, que Stripe manda
      // junto con este. Aquí solo se ata el customer para no perderlo.
      logger.info('stripe.checkout.ok', { tenantId, subId });
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subId = obj.id as string;
      const customerId = (obj.customer as string) ?? null;
      const meta = (obj.metadata as Record<string, string>) ?? {};
      const tenantId = meta.tenant_id ?? (customerId ? await tenantDeCustomer(customerId) : null);

      if (!tenantId) {
        // Sin flota no se puede atribuir. NO se inventa una: activarle el plan
        // a la flota equivocada es peor que no activárselo a nadie. Pero
        // tampoco se traga: se lanza para que el reintento vuelva — cuando el
        // customer ya esté atado (el checkout puede llegar después), resuelve.
        logger.error('stripe.suscripcion.sin_tenant', { evt: evt.id, subId, customerId });
        throw new Error(`suscripción ${subId} sin flota atribuible (customer ${customerId ?? 'ausente'} desconocido) — sin lanzar, el plan pagado no se activaría nunca`);
      }

      const item = (obj.items as { data?: Array<{ price?: { id?: string } }> })?.data?.[0];
      const priceId = item?.price?.id;
      const planClave = priceId ? await planDePrice(priceId) : null;
      if (!planClave) {
        // Un price sin plan en la base es configuración incompleta, no un
        // evento ajeno: se lanza para que el reintento aplique en cuanto
        // /admin ligue el price al plan.
        logger.error('stripe.suscripcion.price_desconocido', { evt: evt.id, priceId });
        throw new Error(`price ${priceId ?? 'ausente'} sin plan que le corresponda — no se sabe qué plan activar; se lanza para que Stripe reintente cuando el price esté ligado`);
      }

      // ── DÓNDE VIVE EL FIN DE PERIODO, SEGÚN LA VERSIÓN DE LA API (DAT-40) ──
      //
      // Stripe MOVIÓ `current_period_end` de la suscripción al ITEM en la
      // versión 2025-03-31. Con una cuenta ya en esa versión, el campo de
      // arriba llega `undefined` y `periodo_fin` se guardaba NULL: la pantalla
      // dice "Sin fecha de corte" de una flota que sí tiene corte, y nadie
      // sabe cuándo vuelve a cobrarse. Se leen los dos, empezando por el viejo
      // para no cambiarle nada a las cuentas que siguen en la API anterior.
      const itemPeriodo = (obj.items as { data?: Array<{ current_period_end?: number }> })?.data?.[0];
      const finUnix = (obj.current_period_end as number | undefined) ?? itemPeriodo?.current_period_end;
      await aplicarSuscripcion({
        tenantId,
        stripeSubscriptionId: subId,
        stripeCustomerId: customerId,
        planClave,
        estado: evt.type === 'customer.subscription.deleted'
          ? 'cancelada'
          : estadoDesdeStripe(obj.status as string),
        // DAT-23: el fin de periodo se guardaba como el día UTC del instante
        // de Stripe. Un corte a las 19:00 del 31-dic (01:00Z del 1-ene) se
        // registraba con fecha del 1 de enero: la flota veía su suscripción
        // vigente un día de más y la mensualidad de enero se emitía duplicada.
        periodoFin: finUnix ? hoyMx(new Date(finUnix * 1000)) : null,
        // Stripe NO promete orden de entrega (RES-11): `aplicarSuscripcion`
        // descarta un evento más viejo que el ya aplicado para esta misma
        // suscripción. Sin esto, el reintento de un `.updated` de anteayer
        // resucitaba una suscripción cancelada.
        eventoCreadoUnix: typeof evt.created === 'number' ? evt.created : undefined,
      });
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const customerId = obj.customer as string | null;
      const tenantId = ((obj.metadata as Record<string, string>)?.tenant_id)
        ?? (customerId ? await tenantDeCustomer(customerId) : null);
      if (!tenantId) {
        // El invoice puede llegar ANTES que el subscription que ata el
        // customer: al reintento de Stripe el tenant ya resuelve. Tragarse
        // este caso dejaría el cobro real sin registrar para siempre.
        logger.error('stripe.factura.sin_tenant', { evt: evt.id, customerId });
        throw new Error(`factura ${String(obj.id)} sin flota atribuible (customer ${customerId ?? 'ausente'} desconocido) — se lanza para que el reintento la registre cuando el customer esté atado`);
      }

      const linea = (obj.lines as { data?: Array<{ period?: { start?: number; end?: number } }> })?.data?.[0];
      const ini = linea?.period?.start;
      const fin = linea?.period?.end;
      const hoy = hoyMx();

      await aplicarFactura({
        tenantId,
        stripeInvoiceId: obj.id as string,
        // Donde el cliente ve la CLABE y la referencia de su transferencia.
        // Se guarda también en el cobro fallido: es justo cuando la necesita.
        urlPago: (obj.hosted_invoice_url as string) ?? null,
        // Días DE MÉXICO (DAT-23): el índice `una_por_periodo` (0057) es por
        // (tenant, periodo_inicio, periodo_fin) — un periodo corrido un día
        // deja de chocar con el que ya existe y la flota recibe dos facturas
        // del mismo mes.
        periodoInicio: ini ? hoyMx(new Date(ini * 1000)) : hoy,
        periodoFin: fin ? hoyMx(new Date(fin * 1000)) : hoy,
        // ── EL MONTO SEGÚN EL EVENTO (auditoría prod, DAT-24) ─────────────
        //
        // `amount_paid ?? amount_due` estaba MAL en el cobro fallido: en un
        // `invoice.payment_failed`, `amount_paid` no viene `undefined` — viene
        // 0, porque justamente no se pagó. El `??` solo salta el `null`, así
        // que la factura se registraba con monto CERO y la pantalla le decía
        // al cliente "transfiere $0.00" de una mensualidad de miles de pesos.
        // Lo que se debe cobrar es `amount_due` (o `amount_remaining`).
        monto: evt.type === 'invoice.paid'
          ? Number(obj.amount_paid ?? obj.amount_due ?? 0) / 100
          : Number(obj.amount_remaining ?? obj.amount_due ?? obj.total ?? 0) / 100,
        moneda: String(obj.currency ?? 'mxn').toUpperCase(),
        pagada: evt.type === 'invoice.paid',
        // CUÁNDO se pagó lo sabe Stripe, no el reloj de este proceso (DAT-23).
        // Un webhook reintentado horas después —o una carga de eventos vieja—
        // sellaba `pagada_en` con la hora del reintento: el corte mensual de
        // la cobranza movía el cobro de mes.
        pagadaEn: (obj.status_transitions as { paid_at?: number } | null)?.paid_at
          ? new Date((obj.status_transitions as { paid_at: number }).paid_at * 1000).toISOString()
          : null,
        // BACK-C4-1: la MISMA guardia de orden que la suscripción. Stripe
        // reentrega hasta 3 días; sin esto, un `payment_failed` de las 10:02
        // reentregado a las 11:05 devolvía a 'fallida' la mensualidad que se
        // cobró a las 10:20, y las dos pantallas volvían a pedir el dinero.
        eventoCreadoUnix: typeof evt.created === 'number' ? evt.created : undefined,
      });
      return;
    }

    // ── LO QUE SE DEVUELVE O SE ANULA (auditoría prod, DAT-33 / DAT-12) ────
    //
    // Los tres caían en el `default` —"Stripe manda decenas de tipos"— y la
    // factura se quedaba 'pagada' con su CFDI vivo: dinero devuelto, papel
    // fiscal en pie y el cliente deduciendo un gasto que ya no existe.
    case 'invoice.voided':
    case 'invoice.marked_uncollectible': {
      await cancelarFacturaDeStripe(String(obj.id), '02', undefined, typeof evt.created === 'number' ? evt.created : undefined);
      return;
    }

    case 'credit_note.created': {
      const invoiceId = obj.invoice as string | null;
      if (!invoiceId) {
        logger.warn('stripe.nota_credito_sin_factura', { evt: evt.id });
        return;
      }
      // Una nota de crédito PARCIAL no anula el comprobante: `cancelarFacturaDeStripe`
      // compara contra el total de la factura y solo avisa.
      await cancelarFacturaDeStripe(invoiceId, '02', Number(obj.total ?? 0) / 100, typeof evt.created === 'number' ? evt.created : undefined);
      return;
    }

    case 'charge.refunded': {
      const invoiceId = obj.invoice as string | null;
      if (!invoiceId) {
        // Un cargo suelto (fuera de suscripción) no tiene factura nuestra.
        logger.info('stripe.reembolso_sin_factura', { evt: evt.id });
        return;
      }
      await cancelarFacturaDeStripe(invoiceId, '02', Number(obj.amount_refunded ?? 0) / 100, typeof evt.created === 'number' ? evt.created : undefined);
      return;
    }

    default:
      // No es un error: Stripe manda decenas de tipos y solo importan estos.
      logger.info('stripe.evento_ignorado', { tipo: evt.type });
  }
}
