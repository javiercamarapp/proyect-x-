import { revalidatePath } from 'next/cache';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { puedeTimbrar } from '@/lib/auth/permisos';
import type { ViajeCcp } from '@/lib/likida/carta_porte_datos';
import { armarCfdiTimbrable } from '@/lib/likida/carta_porte_cfdi';
import { generarIdCcp } from '@/lib/likida/carta_porte';
import {
  leerContextoTimbre, timbrarViaje, guardarReceptorFiscal, motivoDeReservaViva,
} from '@/lib/likida/carta_porte_timbre';
import { mensajeParaPantalla } from '@/lib/likida/administracion';
// FE-23: las cifras del panel SOLO salen de aquí. Éstas se leen junto al botón
// que emite un CFDI irreversible, así que con más razón.
import { mxn } from '@/lib/formato';
import { sufijoTenant } from '../../sufijo';
import { FormaConAviso, Campo, Selector, type ResultadoAccion } from '../../../admin/ui/forma';

/**
 * LA SECCIÓN DE TIMBRE (0226; mudada al área `dinero` por la 0227 — auditoría
 * Fable c6-3) — el botón que convierte el borrador validado en CFDI timbrado,
 * con TODAS sus verdades a la vista:
 *
 *   · Sin PAC configurado la sección lo dice y no hay botón — jamás se
 *     simula un timbre.
 *   · Con faltantes, la lista dice QUÉ y DÓNDE se captura (el perfil del
 *     emisor vive con el contador; los datos del receptor se capturan aquí
 *     mismo porque el cliente es de este viaje).
 *   · El timbre sandbox se rotula como lo que es: una prueba que no ampara
 *     nada.
 *   · El botón lo aprieta un humano CON EL VERBO (`puedeTimbrar`: dueño o
 *     contador, nunca el jefe de tráfico); la acción re-lee y re-valida todo
 *     — el estado de esta pantalla pudo envejecer.
 *   · Una RESERVA viva (0227) se dice en pantalla: hay un timbrado en curso o
 *     uno que quedó ambiguo, y el botón no aparece.
 *
 * LAS DOS PUERTAS DE CADA ACCIÓN: el ÁREA (`puedeVerRuta` sobre esta ruta de
 * `dinero`) y el VERBO (`puedeTimbrar`). El área sola no bastaba: dejaba
 * timbrar a cualquiera que viera la pantalla.
 */

const t = (v: FormDataEntryValue | null): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

export async function SeccionTimbrado({ v, searchParams }: {
  v: ViajeCcp;
  searchParams: { tenant?: string; rol?: string; vista?: string };
}) {
  const RUTA = '/dashboard/timbrado';
  const { tenantId, rol } = await resolverTenantEfectivo(RUTA, searchParams);

  // Un error de lectura aquí LANZA (error boundary de la página): operar el
  // timbre a ciegas es peor que no pintar la sección.
  const ctx = await leerContextoTimbre(tenantId, v.viajeId);
  if (ctx === null) return null;

  const rutaActual = `${RUTA}/${v.viajeId}`;
  const puedeEmitir = puedeTimbrar(rol);

  async function timbrar(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, searchParams);
    // El ÁREA y el VERBO, en ese orden y los dos: el rol del render no es el
    // de la acción, y ver la pantalla nunca fue permiso para emitir un CFDI.
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no ve el timbrado de la flota.' };
    if (!puedeTimbrar(s.rol)) {
      return { error: 'Tu rol no puede timbrar: emitir un CFDI es del dueño de la flota o del contador.' };
    }
    const metodo = String(fd.get('metodoPago')) === 'PUE' ? 'PUE' as const : 'PPD' as const;
    // Con PPD la forma ES 99 (Anexo 20) — el selector de forma solo aplica a PUE.
    const forma = metodo === 'PPD' ? '99' : (t(fd.get('formaPago')) ?? '');
    const fechaLlegadaEstimada = t(fd.get('fechaLlegadaEstimada'));
    // AUDITORÍA 24, FE-24 (MEDIO): esto NO estaba en try/catch. Un fallo de
    // red con el PAC lanzaba dentro de la server action, tiraba la página
    // entera al `error.tsx` y —peor— se saltaba el `revalidatePath`: el
    // contador no leía el «SIN RESPUESTA DEL PAC — verifica en el panel del
    // PAC» que la ruta controlada sí da (carta_porte_timbre.ts:359) y podía
    // reintentar creyendo que no pasó nada. Un CFDI se puede haber emitido.
    // El `finally` revalida SIEMPRE, también cuando lanzó: si el timbre salió
    // y la respuesta se perdió, la pantalla recargada lo enseña.
    try {
      const r = await timbrarViaje(s.tenantId, v.viajeId, {
        metodoPago: metodo,
        formaPago: forma,
        fechaLlegadaEstimada,
      }, { id: s.userId });
      if (!r.ok) {
        const detalle = r.faltantes && r.faltantes.length > 0 ? ` · ${r.faltantes.join(' · ')}` : '';
        return { error: `${r.motivo}${detalle}` };
      }
      return {
        ok: r.yaExistia
          ? `Este viaje ya tenía su timbre: ${r.uuid} (${r.modo}).`
          : `Timbrado ${r.modo === 'sandbox' ? 'DE PRUEBA (no ampara nada)' : ''} — folio fiscal ${r.uuid}.`,
      };
    } catch (e) {
      return {
        error: `${mensajeParaPantalla(e, 'timbrar')} No des el timbre por fallido: si el PAC alcanzó a sellar, ` +
          'el CFDI existe. Recarga esta pantalla y, si sigue sin folio fiscal, verifica en el panel de tu PAC antes de reintentar.',
      };
    } finally {
      revalidatePath(rutaActual);
    }
  }

  async function guardarReceptor(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, searchParams);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no ve el timbrado de la flota.' };
    // Mismo verbo que timbrar: la razón social, el régimen y el uso CFDI del
    // receptor VAN DENTRO del comprobante. Capturarlos es declarar, y quien
    // declara es quien firma.
    if (!puedeTimbrar(s.rol)) {
      return { error: 'Tu rol no puede capturar los datos fiscales del cliente: van dentro del CFDI.' };
    }
    const clienteId = t(fd.get('clienteId'));
    if (clienteId === null) return { error: 'El viaje no tiene cliente asignado — asígnalo antes de capturar sus datos fiscales.' };
    try {
      await guardarReceptorFiscal(s.tenantId, clienteId, {
        razonSocial: t(fd.get('razonSocial')),
        regimenFiscal: t(fd.get('regimenFiscal')),
        usoCfdi: t(fd.get('usoCfdi'))?.toUpperCase() ?? null,
        cpFiscal: t(fd.get('cpFiscal')),
      }, { id: s.userId });
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'guardar los datos fiscales del cliente') };
    }
    revalidatePath(rutaActual);
    return { ok: 'Datos fiscales del cliente guardados.' };
  }

  // ── Timbre ya emitido: el hecho, citable, con su descarga ────────────────
  if (ctx.timbreVigente !== null) {
    const tv = ctx.timbreVigente;
    return (
      <section className="space-y-2 print:hidden">
        <h2 className="font-display text-[15px] font-semibold">Timbre</h2>
        <p className="text-[12.5px]">
          {tv.modo === 'sandbox' ? 'Timbre DE PRUEBA (sandbox — no ampara ningún traslado). ' : 'Timbrado. '}
          Folio fiscal <span className="font-mono">{tv.uuidFiscal}</span> · {tv.fechaTimbrado} · PAC {tv.proveedor.toUpperCase()}.
        </p>
        <a
          className="inline-block text-[12.5px] font-medium hover:opacity-75"
          style={{ color: 'var(--marca)' }}
          href={`/api/export/carta-porte-xml${sufijoTenant(searchParams) ? `${sufijoTenant(searchParams)}&` : '?'}viaje=${v.viajeId}&timbrado=1`}
        >
          Descargar XML timbrado ↓
        </a>
      </section>
    );
  }

  // ── Reserva viva (0227): un intento en curso, o uno ambiguo ──────────────
  // Sin botón a propósito: volver a llamar al PAC podría emitir un SEGUNDO
  // CFDI real. El bloqueo real es el unique de la base; esto solo lo explica.
  if (ctx.reservaPendiente !== null) {
    return (
      <section className="space-y-2 print:hidden">
        <h2 className="font-display text-[15px] font-semibold">Timbre</h2>
        <p className="text-[12.5px]" style={{ color: 'var(--warn)' }}>
          {motivoDeReservaViva(ctx.reservaPendiente)}
        </p>
        {ctx.reservaPendiente.reservadoEn !== null && (
          <p className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
            Apartado desde {ctx.reservaPendiente.reservadoEn}.
          </p>
        )}
      </section>
    );
  }

  // ── Sin PAC: la verdad y cero botones ────────────────────────────────────
  if (!ctx.pac.configurado) {
    return (
      <section className="space-y-2 print:hidden">
        <h2 className="font-display text-[15px] font-semibold">Timbre</h2>
        <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
          Sin PAC configurado: el timbrado directo está apagado (se enciende con las variables
          LIKIDA_PAC_* del servidor). Mientras tanto, el XML del borrador se descarga y se timbra en
          tu facturador — Likida jamás simula un timbre.
        </p>
      </section>
    );
  }

  // ── El ensayo en seco: la MISMA función que arma el CFDI dice qué falta ──
  const ensayo = armarCfdiTimbrable(v, generarIdCcp(), ctx.emisor, ctx.receptor, ctx.ingresoFlete, {
    metodoPago: 'PPD', formaPago: '99', fechaLlegadaEstimada: null,
  });

  return (
    <section className="space-y-3 print:hidden">
      <h2 className="font-display text-[15px] font-semibold">Timbre</h2>
      <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
        PAC {ctx.pac.proveedor?.toUpperCase()} · ambiente {ctx.emisor.modo === 'sandbox' ? 'SANDBOX (timbres de prueba)' : 'PRODUCCIÓN'}.
        El CFDI sale del borrador validado + tu perfil fiscal (panel del contador) + los datos fiscales del cliente.
      </p>

      {!ensayo.ok && (
        <div className="space-y-1">
          <p className="text-[12.5px] font-medium" style={{ color: 'var(--warn)' }}>Para timbrar falta:</p>
          <ul className="text-[12px] list-disc pl-5 space-y-0.5" style={{ color: 'var(--muted)' }}>
            {ensayo.faltantes.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}

      {ctx.clienteId !== null && puedeEmitir && (
        <details className="rounded-lg hairline px-3 py-2">
          <summary className="text-[12.5px] font-medium cursor-pointer">Datos fiscales del cliente (receptor)</summary>
          <div className="pt-2">
            <FormaConAviso accion={guardarReceptor} boton="Guardar datos del cliente" columnas="md:grid-cols-2">
              <input type="hidden" name="clienteId" value={ctx.clienteId} />
              <Campo nombre="razonSocial" etiqueta="Razón social (exacta a SU constancia)" valorInicial={ctx.receptor.razonSocial ?? ''} />
              <Campo nombre="regimenFiscal" etiqueta="Régimen fiscal (clave)" valorInicial={ctx.receptor.regimenFiscal ?? ''} placeholder="601" />
              <Campo nombre="usoCfdi" etiqueta="Uso CFDI" valorInicial={ctx.receptor.usoCfdi ?? ''} placeholder="S01 o G03" />
              <Campo nombre="cpFiscal" etiqueta="CP fiscal" valorInicial={ctx.receptor.cpFiscal ?? ''} placeholder="64000" />
            </FormaConAviso>
          </div>
        </details>
      )}

      {ensayo.ok && !puedeEmitir && (
        <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
          El comprobante está listo para emitirse, pero timbrar es del dueño de la flota o del
          contador: emitir un CFDI es un acto fiscal irreversible y lo firma quien responde por él.
        </p>
      )}

      {puedeEmitir && (
        <div className="space-y-1">
          {ensayo.ok && (
            <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
              Flete {mxn(ensayo.subTotal)} + IVA 16% {mxn(ensayo.iva)}
              {ensayo.retencionIva !== null ? ` − retención IVA 4% ${mxn(ensayo.retencionIva)} (receptor persona moral, LIVA 1-A II c)` : ''}
              {' '}= <span className="font-medium">Total {mxn(ensayo.total)}</span>.
            </p>
          )}
          <FormaConAviso accion={timbrar} boton={ctx.emisor.modo === 'sandbox' ? 'Timbrar (PRUEBA)' : 'Timbrar'} columnas="md:grid-cols-2">
            {/* AUDITORÍA 24, FIS-8 (MEDIO): el valor por defecto era PPD, y un
                CFDI PPD OBLIGA a emitir después un complemento de pago (CFDI
                de Pagos 2.0) al cobrar. Likida no lo emite todavía —
                `pac/sw.ts` lo declara, la pantalla no— y sin el REP el cliente
                de la flota no puede acreditar su IVA y la flota queda con una
                obligación pendiente que su sistema no le dijo. El defecto pasa
                a PUE (pago en una exhibición: se agota con el timbre y no
                arrastra nada) y PPD queda como elección explícita, con lo que
                arrastra escrito al lado. */}
            <Selector nombre="metodoPago" etiqueta="Método de pago" valorInicial="PUE" opciones={[
              { valor: 'PUE', texto: 'PUE — pago en una exhibición (ya cobrado o se cobra al entregar)' },
              { valor: 'PPD', texto: 'PPD — pago en parcialidades/diferido (forma 99)' },
            ]} />
            <Campo nombre="formaPago" etiqueta="Forma de pago (obligatoria con PUE)" placeholder="03 transferencia · 01 efectivo" ayuda="Con PPD se envía 99 «Por definir» (Anexo 20) y este campo se ignora. PUE con 99 se rechaza aquí mismo: se contradicen." />
            <Campo nombre="fechaLlegadaEstimada" etiqueta="Llegada estimada (hora local de México)" tipo="datetime-local" requerido ayuda="Debe ser posterior a la salida; se escribe como FechaHoraSalidaLlegada del destino." />
          </FormaConAviso>
          <p className="text-[11.5px]" style={{ color: 'var(--warn)' }}>
            Si eliges PPD: ese CFDI te obliga a emitir un complemento de pago cuando cobres, y Likida
            todavía no lo emite. Mientras no exista, tu cliente no puede acreditar su IVA y la
            obligación queda abierta a tu nombre. Elige PPD solo si tu contador va a emitir el
            complemento por su cuenta.
          </p>
        </div>
      )}
    </section>
  );
}
