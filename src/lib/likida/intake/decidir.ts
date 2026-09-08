// ═══════════════════════════════════════════════════════════════════════════
// QUÉ HACER con una foto ya extraída.
//
// Vive fuera del processor a propósito: allá adentro esta decisión queda pegada
// a Supabase, WhatsApp y Redis, y es justo la parte donde se decide si el dinero
// entra una vez, dos, o ninguna. Aquí es una función pura y se puede probar.
// ═══════════════════════════════════════════════════════════════════════════

import type { Gasto } from '@/types/likida';
import type { ExtraerResultado } from './ocr';
import { emparejarPorMonto, emparejarCorreccionDeFecha } from './emparejar';
import { fechaDudosa, type VentanaViaje } from '../cuadre/fecha_dudosa';

export type AccionFoto =
  /** Comprobante completo: alta normal. */
  | { accion: 'alta' }
  /** Acercamiento que encontró su comprobante: le pega folio, código y liga. */
  | { accion: 'enriquecer'; gastoId: string }
  /**
   * Trae código o es un voucher, y no hay comprobante al cual pegarlo.
   *
   * `porVoucher` cambia lo que se le pide al operador, y esa distinción salió
   * del ensayo real: a quien mandó el voucher de la terminal se le decía
   * «mándame el ticket completo», y de ese papel NO hay ticket más completo.
   * Se queda esperando algo que no existe. Lo que hay que pedirle es OTRO
   * documento: el del comercio.
   */
  | { accion: 'pedir_ticket'; porVoucher?: boolean }
  /**
   * La segunda foto de un ticket cuya fecha no cuadraba: se le RE-FECHA el
   * gasto que ya existe en vez de dar de alta otro.
   *
   * Sin esto, esa foto entra como `alta` y —si el ticket no trae folio, que es
   * la llave del dedup— el mismo gasto queda contado dos veces.
   */
  | { accion: 'corregir_fecha'; gastoId: string; fecha: string }
  /** La foto de verdad no se lee: reenviarla con mejor luz sirve. */
  | { accion: 'pedir_reenvio' }
  /** Falló nuestro lado: reenviar la misma foto falla igual. */
  | { accion: 'avisar_falla' }
  /**
   * El techo diario de IA de la flota se agotó ANTES de llamar al proveedor
   * (AUDITORÍA 28, REN-A2). Reenviar HOY falla igual —el corte es a
   * medianoche MX—; NO es lo mismo que `avisar_falla` (eso sí puede entrar en
   * minutos si el proveedor se recupera) ni un motivo genérico que caiga a
   * `pedir_reenvio` ("con buena luz" sería mentirle al chofer sobre su foto).
   */
  | { accion: 'avisar_sin_presupuesto' };

export function decidirFoto(
  r: ExtraerResultado,
  gastos: Gasto[],
  /**
   * La ventana del viaje. Opcional porque quien no la tenga se comporta como
   * antes: sin ella no hay forma de saber que una fecha es dudosa, y adivinarlo
   * sería peor que no corregir.
   */
  ventana?: VentanaViaje,
): AccionFoto {
  if (r.legible) {
    // ¿Es la foto que se le PIDIÓ al operador porque la fecha no cuadraba?
    //
    // Solo si la fecha nueva es creíble: si la segunda foto se lee igual de mal,
    // corregir sería cambiar un error por otro, y el gasto entraría duplicado
    // encima. En ese caso cae a `alta` y el cuadre la vuelve a marcar.
    const nueva = r.gasto.fecha?.slice(0, 10);
    if (ventana && nueva && !fechaDudosa(nueva, ventana)) {
      const destino = emparejarCorreccionDeFecha(
        { monto: r.gasto.monto, concepto: r.gasto.concepto, folio: r.gasto.folio },
        gastos,
        (f) => fechaDudosa(f, ventana) != null,
      );
      if (destino) return { accion: 'corregir_fecha', gastoId: destino.id, fecha: nueva };
    }
    return { accion: 'alta' };
  }
  // AUDITORÍA 28, REN-A2: antes de `fallo_tecnico` — un motivo desconocido cae
  // a `pedir_reenvio` (:83), y ese "con buena luz" es falso para un techo de
  // IA agotado.
  if (r.motivo === 'sin_presupuesto') return { accion: 'avisar_sin_presupuesto' };
  if (r.motivo === 'fallo_tecnico') return { accion: 'avisar_falla' };
  // Acercamiento y VOUCHER se resuelven igual, y por la misma razón: los dos
  // valen el mismo dinero que el ticket que les corresponde, así que sumarlos
  // infla la liquidación. El voucher se añadió el 31-jul tras medirlo con 14
  // fotos reales: cuatro pares voucher+ticket duplicaron $1,600.
  if (r.motivo === 'solo_codigo' || r.motivo === 'solo_pago') {
    const destino = emparejarPorMonto(r.gasto.monto, gastos);
    // Sin destino único NO se da de alta: un acercamiento por su cuenta vale el
    // mismo dinero que el ticket que le corresponde, y sumar los dos infla la
    // liquidación. Se le pide la foto del ticket y no se pierde nada.
    return destino
      ? { accion: 'enriquecer', gastoId: destino.id }
      : { accion: 'pedir_ticket', porVoucher: r.motivo === 'solo_pago' };
  }
  return { accion: 'pedir_reenvio' };
}
