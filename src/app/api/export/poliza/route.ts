// ═══════════════════════════════════════════════════════════════════════════
// EL EXPORT QUE LA LANDING PROMETE: una póliza que el ERP asienta.
//
// El export que había era un CSV de ocho columnas —folio, operador, fecha,
// comprobado, anticipo, diferencia, estatus, n_diferencias—: un resumen para
// revisar, no un asiento para importar. La landing decía «el formato que SAP
// Business One o CONTPAQi ya sabe importar, sin retecleo», y esa frase era más
// grande que el archivo.
//
// LOS MISMOS GUARDAS QUE EL RESTO DE `export/`, y por la misma razón: aquí sale
// dinero de una flota. Rate limit por IP y por tenant, tenant resuelto de la
// sesión (nunca del query a secas), y ROL — `puedeExportar` excluye al operador,
// y olvidar preguntárselo es el IDOR que este repo ya documentó como el fallo
// más común del código escrito por agentes.
//
// SIN CATÁLOGO NO HAY PÓLIZA. Si la flota no declaró sus cuentas, esta ruta
// contesta 409 con la lista de lo que falta, no un archivo a medias. Una cuenta
// inventada no se detecta al importar: se detecta en la auditoría del año
// siguiente.
// ═══════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { resolverTenantApi } from '@/lib/auth/tenant-api';
import { puedeExportar } from '@/lib/auth/permisos';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { logger } from '@/lib/logger';
import { acotada } from '@/lib/likida/presupuesto';
import { polizaDeLiquidacion, type LiquidacionParaPoliza } from '@/lib/likida/contabilidad/poliza';
import { catalogoDeclarado, CUENTAS_BALANCE } from '@/lib/likida/contabilidad/catalogo';
import { archivoContpaqi, archivoSapB1 } from '@/lib/likida/contabilidad/formatos';
import { perfilExportacionDeclarado } from '@/lib/likida/contabilidad/perfiles';
import { cubetaDe, copiasDeComprobante, proporcionesDeducibles } from '@/lib/likida/cuadre/engine';
import type { ConceptoGasto, Diferencia, Gasto } from '@/types/likida';
// El redondeo a centavos vive SOLO en formato.ts — `formato.test.ts` enrojece
// con una quinta copia, y esta ruta escribe pesos que se importan a un ERP.
import { round2 } from '@/lib/formato';

export const runtime = 'nodejs';
// BE-19 (auditoría 24): sin esto el tope lo pone el default de la plataforma
// (15 s en Node sin Fluid Compute) y un export de 92 días sobre 45,000
// liquidaciones muere en 504 mudo. Literal a propósito: Next lo lee en build.
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

type Formato = 'contpaqi' | 'sap_b1';

interface FilaPoliza {
  liquidacionId: string;
  revision?: 'pendiente' | 'aprobada' | 'ajustada' | 'rechazada';
  folioViaje: string;
  operador: string;
  fecha: string;
  anticipo: number;
  diferencia: number;
  ivaAcreditable: number;
  porConcepto: Array<{ concepto: ConceptoGasto; subtotal: number | null; baseConocida?: boolean }>;
  baseDesconocida: number;
  /**
   * AUDITORÍA 24 (FIS-2/FIS-3/FIS-4): `version` de la RPC. Sin ella, o menor
   * que `RPC_VERSION_MINIMA`, la ruta contesta 409 en vez de degradar.
   */
  version?: number;
  /** FIS-C1: un renglón por comprobante, para clasificarlo con `cubetaDe`. */
  gastos?: GastoRpc[];
  /** FIS-A1: Σ IVA/ISR retenido al proveedor. Va como ABONO en el asiento. */
  retenciones?: number;
  /** Las diferencias que la liquidación ya guarda (`gastoId` + `tipo`). */
  diferencias?: Diferencia[];
}

/** Un comprobante tal como lo entrega `poliza_datos_tenant` (mig. 0281). */
interface GastoRpc {
  id: string;
  concepto: ConceptoGasto;
  subtotal: number | null;
  descuento?: number | null;
  tieneCfdi: boolean;
  // Desde la 0281 — lo que `cubetaDe`, `copiasDeComprobante` y
  // `proporcionesDeducibles` leen. Opcionales en el TIPO solo para poder
  // detectar la RPC vieja y fallar cerrado; con la 0281 vienen siempre.
  monto?: number;
  fecha?: string | null;
  cfdiUuid?: string | null;
  cfdiOrden?: number | null;
  folio?: string | null;
  folioNorm?: string | null;
  formaPago?: string | null;
  pagadoEn?: string | null;
  pagadoForma?: string | null;
  ivaRetenido?: number | null;
  isrRetenido?: number | null;
  ivaTraslado?: number | null;
  iepsTraslado?: number | null;
}

/**
 * La migración cuyo contrato esta ruta exige. Antes de la 0272 la RPC no traía
 * `gastos` y la ruta «conservaba el comportamiento previo: todo a la cubeta
 * deducible» — la única rama que no puede tener un rótulo verdadero, y la
 * causa del CRÍTICO FIS-4: producción iba en la 0271 y el archivo del
 * contador asentaba el 100% como deducible. Aquí se FALLA CERRADO y se dice
 * qué migración falta.
 */
const RPC_VERSION_MINIMA = 342;

function rpcDesactualizada(f: FilaPoliza): string | null {
  if (!Array.isArray(f.gastos)) return 'la RPC no entrega `gastos` por comprobante (anterior a la 0272)';
  if (typeof f.version !== 'number' || f.version < RPC_VERSION_MINIMA) {
    return `la RPC va en una versión anterior a la ${RPC_VERSION_MINIMA} (sin revisión humana ni traslados fiscales por comprobante)`;
  }
  if (!['pendiente', 'aprobada', 'ajustada', 'rechazada'].includes(f.revision ?? '')) return 'la RPC no entrega un estado de revisión reconocido';
  return null;
}

/** El ajuste cambia monto; el CFDI conserva base, descuentos y tributos. */
function ajustesIncompatibles(f: FilaPoliza): string[] {
  if (f.revision !== 'ajustada') return [];
  const copias = copiasDeComprobante((f.gastos ?? []).map(aGasto));
  return (f.gastos ?? []).flatMap((g) => {
    if (copias.has(g.id) || (num(g.monto) ?? 0) <= 0) return [];
    const campos = [g.monto, g.subtotal, g.descuento ?? 0, g.ivaTraslado,
      g.iepsTraslado, g.ivaRetenido ?? 0, g.isrRetenido ?? 0];
    if (!Object.hasOwn(g, 'ivaTraslado') || !Object.hasOwn(g, 'iepsTraslado') || campos.some((v) => num(v) === undefined)) {
      return [`ajuste del comprobante ${g.id}: falta un desglose fiscal completo para comprobar su importe. Revisa o corrige el XML antes de exportar.`];
    }
    const [monto, subtotal, descuento, iva, ieps, retenidoIva, retenidoIsr] = campos as number[];
    const totalFiscal = round2(subtotal - descuento + iva + ieps - retenidoIva - retenidoIsr);
    if (Math.abs(round2(monto - totalFiscal)) <= 0.01) return [];
    return [`ajuste del comprobante ${g.id}: el importe ${monto.toFixed(2)} no coincide con el desglose fiscal ${totalFiscal.toFixed(2)}. Revisa el ajuste y corrige los datos del comprobante antes de exportar; la diferencia no se convierte en IVA/IEPS.`];
  });
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** El `Gasto` que las tres funciones del motor leen, sin inventar campos. */
function aGasto(g: GastoRpc): Gasto {
  return {
    id: g.id,
    concepto: g.concepto,
    monto: num(g.monto) ?? 0,
    fecha: g.fecha ?? undefined,
    cfdiUuid: g.cfdiUuid ?? undefined,
    cfdiOrden: num(g.cfdiOrden),
    folio: g.folio ?? undefined,
    folioNorm: g.folioNorm ?? undefined,
    formaPago: g.formaPago ?? undefined,
    pagadoEn: g.pagadoEn ?? undefined,
    pagadoForma: g.pagadoForma ?? undefined,
    subTotal: num(g.subtotal ?? undefined),
    descuento: num(g.descuento ?? undefined),
    ivaRetenido: num(g.ivaRetenido ?? undefined),
    isrRetenido: num(g.isrRetenido ?? undefined),
  };
}

/**
 * AUDITORÍA 22, FIS-C1 (CRÍTICO) — reparte la base de cada concepto en las TRES
 * cubetas del motor. AUDITORÍA 24, FIS-2 + FIS-3: con la MISMA regla, entera.
 *
 * NADA se reimplementa aquí ni en SQL: se llaman las tres funciones que el PDF
 * y el panel usan —`copiasDeComprobante` (una deducción por comprobante, no
 * por fotografía), `cubetaDe` (la cubeta) y `proporcionesDeducibles` (qué
 * fracción de un gasto parcialmente deducible lo es: tope de alimentación de
 * LISR 28-V y frontera del 15% de la RFA 2.9)—. Si mañana un tipo nuevo entra
 * a `NO_DEDUCIBLE_ISR`, este reparto se entera solo.
 *
 * Mismo filtro que `totalComprobado` en el motor: copias y montos ≤ 0 no
 * cuentan, para que las cubetas de la póliza sumen lo mismo que el PDF.
 */
function repartirPorCubeta(f: FilaPoliza): { porConcepto: LiquidacionParaPoliza['porConcepto']; retenciones: number } {
  const base = (f.porConcepto ?? []).map((c) => ({
    concepto: c.concepto, subtotal: 0,
    subtotalNoDeducible: 0, subtotalPorConfirmar: 0,
  }));
  const porConcepto = new Map(base.map((b) => [b.concepto, b]));
  const difs = f.diferencias ?? [];
  const todos = (f.gastos ?? []).map(aGasto);
  const copias = copiasDeComprobante(todos);
  const vivos = todos.filter((g) => !copias.has(g.id) && g.monto > 0);
  const proporciones = proporcionesDeducibles(vivos, difs);
  let retenciones = 0;

  for (const g of vivos) {
    // FIS-A1 (22): las retenciones NO restan la base, van como ABONO — y se
    // suman aquí, sobre los vivos, para que una foto repetida de un flete
    // retenido no duplique también la cuenta por pagar al SAT.
    retenciones += (g.ivaRetenido ?? 0) + (g.isrRetenido ?? 0);
    // FIS-A1: la base va NETA de `@Descuento`. El Total del CFDI ya lo está,
    // así que el asiento tiene que estarlo o el residuo sale negativo y el
    // export contesta «dato de origen roto» tirando el periodo entero.
    const montoBase = (g.subTotal ?? 0) - (g.descuento ?? 0);
    if (!Number.isFinite(montoBase) || montoBase === 0) continue;
    const fila = porConcepto.get(g.concepto);
    if (!fila) continue;
    const cubeta = cubetaDe(g, difs.filter((d) => d.gastoId === g.id));
    if (cubeta === 'no_deducible') { fila.subtotalNoDeducible += montoBase; continue; }
    if (cubeta === 'por_confirmar') { fila.subtotalPorConfirmar += montoBase; continue; }
    // Parcial (FIS-2): del viático solo se pierde el EXCEDENTE sobre el tope,
    // del combustible en efectivo solo lo que rebasa el 15%. Misma aritmética
    // que el bucle de totales del motor.
    const p = Math.max(0, Math.min(1, proporciones.get(g.id) ?? 1));
    const deducible = round2(montoBase * p);
    fila.subtotal += deducible;
    fila.subtotalNoDeducible += round2(montoBase - deducible);
  }
  return { porConcepto: [...porConcepto.values()], retenciones: round2(retenciones) };
}

const DIAS_MAXIMO = 92;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function fechaValida(iso: string): boolean {
  if (!FECHA_ISO.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === iso;
}

function diasEntre(desde: string, hasta: string): number {
  return Math.floor((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}

export async function GET(req: Request) {
  if (!(await rateLimit(`export:${clientIp(req)}`, 10, 60_000)))
    return new NextResponse('Demasiadas peticiones', { status: 429 });

  const t = await resolverTenantApi(req.url);
  if (!t.ok) return new NextResponse(t.motivo, { status: t.status });
  const tenantId = t.tenantId;

  if (!(await rateLimit(`export:tenant:${tenantId}`, 10, 60_000)))
    return new NextResponse('Demasiadas peticiones', { status: 429 });

  // AUDITORÍA 19, SEG-19-1 (ALTO): faltaba el guarda de ÁREA, y son dos
  // preguntas distintas. `puedeExportar` incluye al `encargado`
  // (`permisos.ts:17`) porque el jefe de tráfico sí descarga documentos de
  // operación; pero sus áreas son `['operacion']` a secas
  // (`visibilidad.ts:41`), así que no ve finanzas. Con un solo guarda se
  // bajaba el asiento contable completo de su flota —anticipo, IVA
  // acreditable y diferencia de cada liquidación— en el formato que su ERP
  // importa. Las tres hermanas de `export/` preguntan las dos cosas; el
  // encabezado de este archivo ya prometía «los mismos guardas que el resto».
  if (!puedeVerArea(t.rol, 'dinero')) {
    logger.warn('export.poliza_area_sin_permiso', { rol: t.rol });
    return new NextResponse('Tu rol no ve las cifras de dinero de la flota.', { status: 403 });
  }
  if (!puedeExportar(t.rol))
    return new NextResponse('Tu rol no puede exportar la contabilidad', { status: 403 });

  const url = new URL(req.url);
  const formato = (url.searchParams.get('formato') ?? 'contpaqi') as Formato;
  if (formato !== 'contpaqi' && formato !== 'sap_b1')
    return new NextResponse('formato debe ser contpaqi o sap_b1', { status: 400 });

  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');
  if (!desde || !hasta || !fechaValida(desde) || !fechaValida(hasta))
    return new NextResponse('desde y hasta son obligatorios en formato AAAA-MM-DD', { status: 400 });
  if (hasta < desde) return new NextResponse('hasta no puede ser anterior a desde', { status: 400 });
  const dias = diasEntre(desde, hasta);
  if (dias > DIAS_MAXIMO) {
    return NextResponse.json({
      error: 'rango_demasiado_grande',
      detalle: `El export de pólizas admite como máximo ${DIAS_MAXIMO} días por archivo; pediste ${dias}. Divide el periodo para que el archivo se revise e importe de forma controlada.`,
      maximoDias: DIAS_MAXIMO,
    }, { status: 413 });
  }
  const preflight = url.searchParams.get('preflight') === '1';

  // ── EL CATÁLOGO DE LA FLOTA ────────────────────────────────────────────
  // Se lee lo DECLARADO (`tenant.config.catalogoCuentas`, la pantalla de
  // Configuración), nunca `getConfig()`: ése fusiona `DEMO_CONFIG`, cuyas
  // cuentas están marcadas 🔴 demo en el código, y las asentaría en el ERP de
  // la flota como si fueran suyas.
  let catalogo;
  try {
    const lectura = await catalogoDeclarado(tenantId);
    if (!lectura.ok) {
      return NextResponse.json(
        {
          error: 'sin_catalogo_contable',
          detalle:
            'Esta flota todavía no declaró su catálogo de cuentas. Sin él no se puede armar una póliza: ' +
            'la cuenta de cada concepto la decide tu contador, y una cuenta inventada no se nota al ' +
            'importar — se nota en la auditoría del año siguiente.',
          comoResolverlo:
            'Captúralo en Configuración → Catálogo de cuentas de tu contador, una por línea como ' +
            '`concepto=cuenta`. Además de los conceptos de gasto, la póliza necesita las cuentas de ' +
            'balance: ' + Object.keys(CUENTAS_BALANCE).join(', ') + '.',
          donde: '/dashboard/configuracion',
        },
        { status: 409 },
      );
    }
    catalogo = lectura.catalogo;
  } catch (e) {
    logger.error('export.poliza.catalogo', { tenantId, err: e instanceof Error ? e.message : String(e) });
    return new NextResponse('No se pudo leer la configuración contable', { status: 503 });
  }

  // Cada ERP usa la plantilla que confirmó ESTA flota. No hay una plantilla
  // universal segura: versiones, segmentos y campos obligatorios cambian. Una
  // credencial guardada tampoco prueba que el archivo importe, así que este
  // perfil es una confirmación separada y explícita.
  let perfil;
  try {
    perfil = await perfilExportacionDeclarado(tenantId, formato);
  } catch (e) {
    logger.error('export.poliza.perfil_erp', { tenantId, formato, err: e instanceof Error ? e.message : String(e) });
    return new NextResponse('No se pudo leer el perfil de exportación ERP', { status: 503 });
  }
  if (!perfil) {
    return NextResponse.json({
      error: 'perfil_erp_sin_confirmar',
      detalle: `No hay una plantilla ${formato === 'contpaqi' ? 'CONTPAQi' : 'SAP Business One DTW'} confirmada para esta flota. No se genera un layout supuesto: pide a tu contador que confirme una plantilla de importación de su instancia.`,
      estado: 'no_listo',
    }, { status: 409 });
  }

  const { data, error } = await acotada(
    supabaseAdmin().rpc('poliza_datos_tenant', { p_tenant: tenantId, p_desde: desde, p_hasta: hasta }),
    'export.poliza.datos',
  );
  if (error) {
    logger.error('export.poliza.datos', { tenantId, err: error.message });
    return new NextResponse('No se pudieron leer las liquidaciones', { status: 503 });
  }

  const filas = (data ?? []) as FilaPoliza[];
  if (filas.length === 0)
    return NextResponse.json({ error: 'sin_liquidaciones', detalle: 'No hay liquidaciones cerradas en ese periodo.' }, { status: 404 });

  // ── SE ARMAN TODAS ANTES DE ESCRIBIR NADA ──────────────────────────────
  // Un archivo con la mitad de los asientos es peor que ninguno: el contador
  // importa, cuadra a medias, y la parte que falta no aparece por ningún lado.
  const polizas: Array<{ folio: string; poliza: ReturnType<typeof polizaDeLiquidacion> }> = [];
  const bloqueos: Array<{ folio: string; falta: string[] }> = [];

  // ── FIS-4 (24): SIN LA RPC CORRECTA NO HAY PÓLIZA ──────────────────────
  // Se comprueba ANTES de armar nada: una fila con la RPC vieja no se puede
  // clasificar, y «todo deducible» no es una degradación, es una cifra falsa.
  const desactualizada = filas.map(rpcDesactualizada).find((m) => m !== null);
  if (desactualizada) {
    logger.error('export.poliza.rpc_desactualizada', { tenantId, motivo: desactualizada });
    return NextResponse.json({
      error: 'rpc_desactualizada',
      detalle:
        `No se puede armar la póliza: ${desactualizada}. Faltan insumos para comprobar la revisión humana ` +
        'y el desglose fiscal; actualiza la base de datos antes de exportar. No se genera un archivo parcial.',
      migracionEsperada: 'supabase/migrations/0342_poliza_revision_y_desglose.sql',
    }, { status: 409 });
  }

  const sinFirma = filas.filter((f) => f.revision !== 'aprobada' && f.revision !== 'ajustada');
  if (sinFirma.length > 0) {
    return NextResponse.json({
      error: 'liquidaciones_sin_firma',
      detalle: 'El periodo contiene liquidaciones sin revisión aprobada o ajustada. Revísalas antes de exportar: no se genera un archivo parcial ni se asienta IVA sin firma.',
      folios: sinFirma.map((f) => f.folioViaje),
    }, { status: 409 });
  }

  for (const f of filas) {
    const ajustes = ajustesIncompatibles(f);
    if (ajustes.length > 0) {
      bloqueos.push({ folio: f.folioViaje, falta: ajustes });
      continue;
    }
    const sinBase = (f.porConcepto ?? []).filter((c) => c.baseConocida !== true || c.subtotal === null);
    if (sinBase.length > 0) {
      bloqueos.push({
        folio: f.folioViaje,
        falta: [`base gravable desconocida para ${sinBase.map((c) => `«${c.concepto}»`).join(', ')}. El XML no informó SubTotal; no se sustituye por el total porque duplicaría o mezclaría IVA en la póliza.`],
      });
      continue;
    }
    const reparto = repartirPorCubeta(f);
    const liq: LiquidacionParaPoliza = {
      folioViaje: f.folioViaje,
      operador: f.operador,
      fecha: f.fecha,
      anticipo: Number(f.anticipo),
      porConcepto: reparto.porConcepto,
      ivaAcreditable: Number(f.ivaAcreditable),
      // FIS-3: sin copias (ver `repartirPorCubeta`), no el crudo de la RPC.
      retenciones: reparto.retenciones,
      diferencia: Number(f.diferencia),
    };
    const r = polizaDeLiquidacion(liq, catalogo);
    if (!r.ok) bloqueos.push({ folio: f.folioViaje, falta: r.falta });
    else polizas.push({ folio: f.folioViaje, poliza: r });
  }

  if (bloqueos.length > 0) {
    return NextResponse.json(
      {
        error: 'polizas_incompletas',
        detalle:
          `${bloqueos.length} de ${filas.length} liquidaciones no se pueden asentar. No se exporta el ` +
          'archivo a medias: un contador que importa la mitad cuadra a medias y lo que falta no aparece ' +
          'por ningún lado.',
        bloqueos,
      },
      { status: 409 },
    );
  }

  const conBaseDesconocida = filas.reduce((s, f) => s + Number(f.baseDesconocida ?? 0), 0);

  if (preflight) {
    return NextResponse.json({
      listo: true,
      formato,
      plantillaConfirmadaEn: perfil.confirmadoEn,
      polizas: polizas.length,
      rango: { desde, hasta, dias, maximoDias: DIAS_MAXIMO },
      advertencias: conBaseDesconocida > 0
        ? [`${conBaseDesconocida} renglón(es) no tienen base gravable conocida y bloquearon el export; carga o corrige el XML antes de importar.`]
        : [],
      estado: 'listo_para_generar_no_importado',
    });
  }

  const nombre = `poliza-${desde}_${hasta}`;
  if (formato === 'contpaqi') {
    if (perfil.sistema !== 'contpaqi') return new NextResponse('Perfil ERP inconsistente', { status: 500 });
    // `archivoContpaqi`, no `aContpaqi` por póliza: el importador recibe UN
    // encabezado por archivo. Repetirlo entre movimientos se interpreta como
    // un asiento corrupto en varios esquemas.
    const cuerpo = archivoContpaqi(polizas.map((p) => p.poliza.ok ? p.poliza.poliza : null).filter((p): p is NonNullable<typeof p> => p !== null), {
      ...perfil.opciones,
      numeroInicial: perfil.opciones.numero,
    });
    return new NextResponse(cuerpo, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${nombre}-contpaqi.csv"`,
        'x-likida-polizas': String(polizas.length),
        'x-likida-base-desconocida': String(conBaseDesconocida),
        'x-likida-estado': 'generado_no_importado',
      },
    });
  }

  if (perfil.sistema !== 'sap_b1') return new NextResponse('Perfil ERP inconsistente', { status: 500 });
  // SAP B1 DTW son DOS archivos ligados por JdtNum. Ambos llevan un único
  // doble encabezado de la plantilla confirmada; devolverlos juntos evita que
  // se importe un hijo sin su cabecera.
  const sap = archivoSapB1(polizas.map((p) => p.poliza.ok ? p.poliza.poliza : null).filter((p): p is NonNullable<typeof p> => p !== null), perfil.plantilla);

  return NextResponse.json({
    formato: 'sap_b1_dtw',
    archivos: {
      'oJournalEntries.txt': sap.cabecera,
      'JournalEntries_Lines.txt': sap.lineas,
    },
    polizas: polizas.length,
    baseDesconocida: conBaseDesconocida,
    nota:
      'Son DOS archivos y el Data Transfer Workbench los importa juntos, ligados por JdtNum. ' +
      'El archivo está generado desde una plantilla confirmada para esta flota; Likida no puede afirmar que ya fue importado hasta que tu contador lo pruebe en su instancia.',
    estado: 'generado_no_importado',
    plantillaConfirmadaEn: perfil.confirmadoEn,
  });
}
