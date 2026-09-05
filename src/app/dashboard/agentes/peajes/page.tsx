import { redirect } from 'next/navigation';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { requireSessionTenant } from '@/lib/auth/guard';
import { puedeVerRuta, puedeVerArea } from '@/lib/auth/visibilidad';
import {
  getConciliacionConsolidado, getLineasPorConciliar, getDesglosesRecibidos, getAcreditables,
} from '@/lib/likida/analytics';
import { parseCfdiXml, esConsolidado } from '@/lib/likida/intake/cfdi_xml';
import { guardarYConciliarConsolidado, barrerPorConciliar, type ResumenBarrido } from '@/lib/likida/intake/consolidado';
import {
  importarDesglose, conciliarDesglose, listarDesgloses, detalleDesglose,
} from '@/lib/likida/intake/desglose_peaje';
import { evidenciaGpsDeDesglose } from '@/lib/likida/peajes/evidencia_gps';
import { logger } from '@/lib/logger';
import { sufijoTenant } from '../../sufijo';
import { avisoAgentePeajesApagado } from './apagado';
import { VistaAgentePeajes } from './vista';
import { SeccionNotificaciones } from '../seccion-notificaciones';
import { FichaCorridas } from '../ficha-corridas';
import { registrarCorrida, ultimasCorridas } from '@/lib/likida/agentes/corridas';
import type { EstadoImportar } from './subir-desglose';
import type { EstadoConciliar } from './conciliar-desglose';
import { MAX_ARCHIVO_SUBIDA_BYTES, MENSAJE_ARCHIVO_GRANDE } from '@/lib/http/subidas_formulario';

export const dynamic = 'force-dynamic';

/** El estado de cuenta más grande que se acepta por pantalla. Un CFDI
 *  consolidado de un mes pesa decenas de KB; 4 MB es ya un archivo
 *  equivocado, no un desglose grande. */
const MAX_XML_BYTES = 4 * 1024 * 1024;

const MAX_DESGLOSE_BYTES = MAX_ARCHIVO_SUBIDA_BYTES;

function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  return fn().catch(() => null);
}

/**
 * Agente de Peajes (F5 del plan) — el conciliador del "martirio": el estado
 * de cuenta del TAG/monedero (CFDI consolidado) contra los gastos reales de
 * los viajes. El JOIN automático ya corre cuando el XML llega por WhatsApp
 * de la oficina; esta página agrega la ingesta por pantalla, la ventana del
 * agente y el estado honesto del estímulo de peaje (RMF 9.1.8).
 *
 * La MESA para resolver líneas a mano vive en Combustible y casetas — esta
 * ventana la enseña y enlaza, no la duplica.
 */
export default async function PaginaAgentePeajes({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; tenant?: string; rol?: string; desglose?: string }>;
}) {
  const sp = await searchParams;
  const { tenantId, rol } = await resolverTenantEfectivo('/dashboard/agentes/peajes', sp);
  if (!puedeVerRuta(rol, '/dashboard/agentes/peajes')) redirect('/dashboard');
  const sufijo = sufijoTenant(sp);

  const [conciliacion, lineas, desgloses, acreditables, corridas, desglosesProveedor] = await Promise.all([
    getConciliacionConsolidado(tenantId),
    safe(() => getLineasPorConciliar(tenantId)),
    safe(() => getDesglosesRecibidos(tenantId)),
    safe(() => getAcreditables(tenantId)),
    // La ficha de corridas (B3): null = no se pudo leer, y la ficha lo dice.
    safe(() => ultimasCorridas(tenantId, 'peajes')),
    // Los desgloses del proveedor (F5): null = no se pudo leer, y se dice.
    safe(() => listarDesgloses(tenantId)),
  ]);

  // El desglose abierto en detalle: el de `?desglose=` SOLO si aparece en la
  // lista del tenant (la lista ya viene acotada a la flota — un uuid ajeno en
  // la URL cae al más reciente, no a datos de otro), o el más reciente.
  const desgloseSel = desglosesProveedor?.find((d) => d.desgloseId === sp.desglose)
    ?? desglosesProveedor?.[0]
    ?? null;
  // FE-33: las dos lecturas de abajo solo dependen de `desgloseSel` — nada
  // de la segunda depende del resultado de la primera —, así que van en
  // paralelo en vez de en serie.
  const [detalleSel, evidenciaSel] = desgloseSel
    ? await Promise.all([
        safe(() => detalleDesglose(tenantId, desgloseSel.desgloseId)),
        // La evidencia GPS del desglose seleccionado (post-plan-maestro #1).
        // Se computa al leer — no escribe nada — y `safe()` la degrada a "no
        // se pudo leer" igual que el detalle: un resumen a medias diría "sin
        // evidencia" de cruces que sí la tienen.
        safe(async () => {
          const e = await evidenciaGpsDeDesglose(tenantId, desgloseSel.desgloseId);
          // El Map → objeto plano: la vista solo anota las líneas visibles.
          return { resumen: e.resumen, porLinea: Object.fromEntries(e.porLinea) };
        }),
      ])
    : [null, null];

  async function subirDesglose(
    _prev: { error?: string; resumen?: { totalLineas: number; conciliadas: number; porConciliar: number } } | null,
    fd: FormData,
  ): Promise<{ error?: string; resumen?: { totalLineas: number; conciliadas: number; porConciliar: number } } | null> {
    'use server';
    // EL CHEQUEO SE REPITE ADENTRO (patrón del repo): POST directo posible.
    const sesion = await requireSessionTenant('/dashboard/agentes/peajes');
    if (!puedeVerArea(sesion.rol, 'dinero')) return { error: 'Tu rol no puede subir estados de cuenta.' };
    if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) return { error: 'Este agente no es de tu flota.' };
    // El kill switch (0110), después de la puerta y antes de trabajar — el
    // punto único vive en ./apagado.ts, las cuatro actions lo consultan.
    const apagado = await avisoAgentePeajesApagado();
    if (apagado) return { error: apagado };

    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Elige el archivo XML del estado de cuenta.' };
    if (archivo.size > MAX_XML_BYTES) return { error: 'Ese archivo pesa demasiado para ser un CFDI — revisa que sea el XML del estado de cuenta.' };

    const texto = await archivo.text();
    const xml = parseCfdiXml(texto);
    if (!xml?.uuid) return { error: 'No pude leerlo como CFDI (XML). El desglose en Excel/PDF todavía no entra por aquí — solo el XML del consolidado.' };
    if (!esConsolidado(xml)) {
      return { error: 'Ese CFDI trae un solo concepto — los tickets individuales entran por WhatsApp con su foto. Aquí va el CONSOLIDADO del TAG o monedero.' };
    }

    try {
      const r = await guardarYConciliarConsolidado(tenantId, xml, texto);
      logger.info('peajes.desglose_subido', { tenantId, uuid: xml.uuid, lineas: r.totalLineas, conciliadas: r.conciliadas });
      return { resumen: { totalLineas: r.totalLineas, conciliadas: r.conciliadas, porConciliar: r.porConciliar } };
    } catch (e) {
      logger.error('peajes.desglose_fallo', { tenantId, err: e instanceof Error ? e.message : String(e) });
      return { error: 'No se pudo procesar el estado de cuenta. Inténtalo de nuevo.' };
    }
  }

  /**
   * El desglose del PROVEEDOR (F5, el PoC del Plaud #2): Excel/CSV/PDF con
   * los cruces del TAG. Se importa Y se cruza en el mismo paso contra los
   * gastos de caseta de los viajes — el resultado son las tres cubetas
   * honestas del cruce (`intake/desglose_peaje.ts`). El parseo dice QUÉ
   * columna faltó cuando no entiende el archivo; jamás adivina.
   */
  async function importarYCruzarDesglose(_prev: EstadoImportar, fd: FormData): Promise<EstadoImportar> {
    'use server';
    // EL CHEQUEO SE REPITE ADENTRO (patrón del repo): POST directo posible.
    const sesion = await requireSessionTenant('/dashboard/agentes/peajes');
    if (!puedeVerArea(sesion.rol, 'dinero')) return { error: 'Tu rol no puede subir desgloses.' };
    if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) return { error: 'Este agente no es de tu flota.' };
    const apagado = await avisoAgentePeajesApagado();
    if (apagado) return { error: apagado };

    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Elige el archivo del desglose (Excel, CSV o PDF).' };
    if (archivo.size > MAX_DESGLOSE_BYTES) return { error: MENSAJE_ARCHIVO_GRANDE };
    const proveedor = String(fd.get('proveedor') ?? '').trim();

    try {
      const buffer = Buffer.from(await archivo.arrayBuffer());
      const importado = await importarDesglose(tenantId, {
        nombre: archivo.name, buffer, proveedor: proveedor || undefined,
      });
      // El motivo del parseo VIAJA al usuario tal cual: nombra la columna que
      // faltó o por qué el PDF no alcanza — es el error útil, no uno genérico.
      if (!importado.ok) return { error: importado.motivo };
      const cruce = await conciliarDesglose(tenantId, importado.desgloseId, 'manual');
      logger.info('peajes.desglose_proveedor', {
        tenantId, desglose: importado.desgloseId, lineas: importado.totalLineas, cuadra: cruce.cuadra,
      });
      return {
        resumen: {
          totalLineas: importado.totalLineas,
          cuadra: cruce.cuadra,
          noCuadra: cruce.noCuadra,
          sinContraparte: cruce.sinContraparte,
          avisos: importado.avisos,
        },
      };
    } catch (e) {
      logger.error('peajes.desglose_proveedor_fallo', { tenantId, err: e instanceof Error ? e.message : String(e) });
      return { error: 'No se pudo procesar el desglose. Inténtalo de nuevo.' };
    }
  }

  /**
   * «Conciliar» a demanda: re-corre el cruce COMPLETO de un desglose contra
   * los gastos de caseta que hay HOY (los tickets rezagados llegan durante la
   * semana). Idempotente: es anotación recalculable, no sello fiscal. La
   * corrida queda en la bitácora del agente (la registra `conciliarDesglose`).
   */
  async function conciliarDesgloseAhora(_prev: EstadoConciliar, fd: FormData): Promise<EstadoConciliar> {
    'use server';
    // EL CHEQUEO SE REPITE ADENTRO (patrón del repo): POST directo posible.
    const sesion = await requireSessionTenant('/dashboard/agentes/peajes');
    if (!puedeVerArea(sesion.rol, 'dinero')) return { error: 'Tu rol no puede operar este agente.' };
    if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) return { error: 'Este agente no es de tu flota.' };
    const apagado = await avisoAgentePeajesApagado();
    if (apagado) return { error: apagado };

    const desgloseId = String(fd.get('desglose') ?? '').trim();
    if (!desgloseId) return { error: 'Falta el desglose a conciliar.' };

    try {
      // `conciliarDesglose` acota al tenant de la SESIÓN: un id ajeno en el
      // form no alcanza datos de otra flota — truena como "no existe".
      const r = await conciliarDesglose(tenantId, desgloseId, 'manual');
      return { resumen: { total: r.total, cuadra: r.cuadra, noCuadra: r.noCuadra, sinContraparte: r.sinContraparte, noEscritas: r.noEscritas } };
    } catch (e) {
      logger.error('peajes.conciliar_desglose_fallo', { tenantId, err: e instanceof Error ? e.message : String(e) });
      return { error: 'No se pudo correr el cruce. Inténtalo de nuevo.' };
    }
  }

  /**
   * El barrido a demanda (auditoría 4, B1): re-corre el cruce de las líneas
   * `por_conciliar` contra los gastos que llegaron DESPUÉS del estado de
   * cuenta. Es el mismo patrón que el «Ejecutar ahora» de Cobranza
   * (`cobranza/page.tsx`): el humano que confirma es quien dispara, y el
   * acuse dice lo que de verdad pasó.
   */
  async function ejecutarAhora(
    _prev: { error?: string; resumen?: ResumenBarrido } | null,
    _fd: FormData,
  ): Promise<{ error?: string; resumen?: ResumenBarrido } | null> {
    'use server';
    // EL CHEQUEO SE REPITE ADENTRO (patrón del repo): POST directo posible.
    const sesion = await requireSessionTenant('/dashboard/agentes/peajes');
    if (!puedeVerArea(sesion.rol, 'dinero')) return { error: 'Tu rol no puede operar este agente.' };
    if (sesion.rol !== 'superadmin' && sesion.tenantId !== tenantId) return { error: 'Este agente no es de tu flota.' };
    const apagado = await avisoAgentePeajesApagado();
    if (apagado) return { error: apagado };

    const inicio = new Date();
    try {
      const resumen = await barrerPorConciliar(tenantId);
      // La bitácora de corridas (B3). `registrarCorrida` nunca lanza.
      await registrarCorrida(tenantId, 'peajes', {
        inicio,
        fin: new Date(),
        estado: 'ok',
        disparo: 'manual',
        tareasHechas: resumen.conciliadas,
        tareasTotal: resumen.revisadas,
        resumen: { ...resumen },
      });
      return { resumen };
    } catch (e) {
      logger.error('peajes.barrido_fallo', { tenantId, err: e instanceof Error ? e.message : String(e) });
      await registrarCorrida(tenantId, 'peajes', {
        inicio,
        fin: new Date(),
        estado: 'fallo',
        disparo: 'manual',
        error: 'El barrido no se pudo completar. El detalle quedó en los registros del sistema.',
      });
      return { error: 'No se pudo correr el barrido. Inténtalo de nuevo.' };
    }
  }

  return (
    <VistaAgentePeajes
      conciliacion={conciliacion}
      lineas={lineas}
      desgloses={desgloses}
      peajeAcreditable={acreditables?.peaje ?? null}
      sufijo={sufijo}
      subirDesglose={subirDesglose}
      ejecutarAhora={ejecutarAhora}
      desglosesProveedor={desglosesProveedor}
      desgloseSeleccionado={desgloseSel}
      detalleSeleccionado={detalleSel}
      evidenciaGps={evidenciaSel}
      importarDesglose={importarYCruzarDesglose}
      conciliarDesglose={conciliarDesgloseAhora}
      notificaciones={
        <>
          <FichaCorridas corridas={corridas} />
          <SeccionNotificaciones tenantId={tenantId} agenteId="peajes" />
        </>
      }
    />
  );
}
