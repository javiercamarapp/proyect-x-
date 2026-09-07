import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { getResumenNegocio } from '@/lib/admin/negocio';
import { getOnboardingFlotas, type OnboardingFlota } from '@/lib/admin/onboarding';
import { telefonosJefe } from '@/lib/likida/contactos';
import { usd } from '@/lib/utils';
import { numero } from '@/lib/formato';
import {
  Truck, ExternalLink, Plus, ClipboardCheck, CheckCircle2, Circle,
  AlertTriangle, ArrowRight,
} from 'lucide-react';
import { requireSuperadmin } from '@/lib/auth/guard';
import { crearFlota, mensajeParaPantalla } from '@/lib/likida/administracion';
import { actualizarFacilidad15 } from '@/lib/likida/repo';
import { getSenalesPmfTodas, SENALES_SIN_DATOS, type SenalesPmf } from '@/lib/likida/pmf';
import { BarraPagina, TituloSeccion } from '../../dashboard/resumen-visual';
import ContadorRetro from '../contador-retro';
import { HBars } from '../ui/graficas';
import { ChartCard, EstadoVacio } from '../ui/kit';
import { FormaConAviso, Campo, type ResultadoAccion } from '../ui/forma';
import { REGIMENES, USOS_CFDI } from '@/lib/saas/fiscal';
import { SenalesPmfPorFlota } from './senales-pmf';

export const dynamic = 'force-dynamic';

/**
 * Dar de alta una flota — hasta hoy, un INSERT tecleado a mano.
 *
 * Repite `requireSuperadmin` adentro aunque el layout de /admin ya gatee: un
 * server action es su propio endpoint y no pasa por el layout. Va FUERA del
 * try porque redirige lanzando, y atraparlo convertiría "no eres superadmin"
 * en un aviso rojo dentro de una consola que no debería estar sirviéndose.
 */
/** ¿Vienen los CINCO del receptor? Es la condición exacta de `getFiscalDeFlota`. */
function fiscalListo(fd: FormData): boolean {
  return ['rfc', 'razonSocial', 'regimenFiscal', 'codigoPostalFiscal', 'usoCfdi']
    .every((c) => String(fd.get(c) ?? '').trim().length > 0);
}

async function accionCrearFlota(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
  'use server';
  const s = await requireSuperadmin();

  const nombre = String(fd.get('nombre') ?? '').trim();
  const emailAdmin = String(fd.get('emailAdmin') ?? '').trim();
  try {
    const { userId } = await crearFlota(
      {
        nombre,
        rfc: String(fd.get('rfc') ?? ''),
        ciudad: String(fd.get('ciudad') ?? ''),
        emailAdmin,
        nombreAdmin: String(fd.get('nombreAdmin') ?? ''),
        telefonoAdmin: String(fd.get('telefonoAdmin') ?? '') || undefined,
        dedicacionExclusivaCarga: fd.get('dedicacionExclusivaCarga') === 'on' ? true : undefined,
        regimenFiscal: String(fd.get('regimenFiscal') ?? '') || undefined,
        razonSocial: String(fd.get('razonSocial') ?? '') || undefined,
        codigoPostalFiscal: String(fd.get('codigoPostalFiscal') ?? '') || undefined,
        usoCfdi: String(fd.get('usoCfdi') ?? '') || undefined,
      },
      { id: s.userId },
    );

    revalidatePath('/admin/flotas');
    // SE DICE SI PUEDE FACTURAR O NO, aquí y ahora. El alta callaba: una flota
    // sin los cinco datos del receptor se creaba con el mismo mensaje verde que
    // una completa, y el hueco se descubría semanas después como un cron de
    // facturación que no hacía nada. Un "listo" que no distingue entre las dos
    // cosas es peor que no decir nada.
    const faltaFiscal = !fiscalListo(fd);
    const base = userId
      ? `"${nombre}" dada de alta, con ${emailAdmin} como administrador. Ya puede entrar a su panel.`
      : `"${nombre}" dada de alta. Todavía no tiene a nadie que pueda entrar: falta darle de alta un usuario.`;
    return {
      ok: faltaFiscal
        ? `${base} OJO: le faltan datos fiscales (RFC, razón social, régimen, CP fiscal y uso del CFDI). Hasta que estén los CINCO, esta flota no factura ni un ticket. Se capturan en su panel, en Suscripción.`
        : base,
    };
  } catch (e) {
    return { error: mensajeParaPantalla(e, 'dar de alta la flota') };
  }
}

// AUDITORÍA 14: la declaración del 15% (RFA 2.9) se puede VER y CORREGIR.
async function accionFacilidad(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
  'use server';
  const s = await requireSuperadmin();
  const flotaId = String(fd.get('flotaId') ?? '');
  const ded = fd.get('ded') === 'si' ? true : fd.get('ded') === 'no' ? false : undefined;
  const reg = fd.get('reg') === 'si' ? true : fd.get('reg') === 'no' ? false : undefined;
  if (!flotaId) return { error: 'Falta la flota.' };
  try {
    // AUDITORÍA 28, FIS-A3: `actualizarFacilidad15` ahora escribe también
    // `tenant.perfil` (la fuente única que lee `facilidad15Vigente`) — antes
    // esta pantalla SOLO tocaba `tenant.config` y una corrección del
    // superadmin podía quedar tapada por una declaración vieja del perfil.
    await actualizarFacilidad15(flotaId, ded, reg, s.userId);
  } catch (e) {
    return { error: mensajeParaPantalla(e, 'guardar la declaración') };
  }
  revalidatePath('/admin/flotas');
  return { ok: ded !== undefined ? 'Declaración del 15% actualizada.' : 'Declaración del 15% borrada (sin declarar).' };
}

/**
 * Una casilla del checklist de onboarding. Tres estados y los tres se
 * dibujan distinto: `ok` (medido y cumplido), `pendiente` (medido y falta) y
 * `sin_medir` (la lectura falló — NO se pinta como pendiente, porque
 * "no se pudo mirar" no es "falta"). Cada casilla lleva a DONDE se resuelve.
 */
function Casilla({ estado, texto, href, accion }: {
  estado: 'ok' | 'pendiente' | 'sin_medir';
  texto: string;
  href: string;
  accion: string;
}) {
  const icono = estado === 'ok'
    ? <CheckCircle2 width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--ok)' }} />
    : estado === 'pendiente'
      ? <Circle width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
      : <AlertTriangle width={14} height={14} strokeWidth={1.75} style={{ color: 'var(--warn)' }} />;
  return (
    <div className="flex items-start gap-2 text-sm py-1">
      <span className="mt-0.5 shrink-0">{icono}</span>
      <span className="flex-1 min-w-0" style={estado === 'ok' ? undefined : { color: 'var(--muted)' }}>{texto}</span>
      {estado !== 'ok' && (
        <Link href={href} className="shrink-0 inline-flex items-center gap-1 text-xs font-medium underline hover:opacity-70 transition-opacity">
          {accion} <ArrowRight width={11} height={11} strokeWidth={1.75} />
        </Link>
      )}
    </div>
  );
}
/**
 * Flotas / Clientes — versión dedicada y con más aire de la sección
 * "Flotas" de Inicio. Misma tabla real (`resumen.flotas`: nombre, plan,
 * viajes, costoIaUsd) de `getResumenNegocio()`, aquí ordenada por costo de
 * IA de mayor a menor (el único "sort" que aplica sin over-engineering).
 * El contador retro es el mismo componente Solari que usa Inicio para el
 * MRR, mostrando aquí `resumen.tenants` — el único número de cabecera de
 * esta página con un dato real y singular detrás.
 *
 * Anatomía de página (14-ago): BarraPagina + tarjetas blancas sobre el lienzo
 * tenue (--g1), como consola.tsx. El contador (45px de alto) no cabe en la
 * barra de 44px, así que encabeza la tarjeta de la tabla.
 */
export default async function FlotasPage() {
  const r = await getResumenNegocio();
  const flotasOrdenadas = [...r.flotas].sort((a, b) => b.costoIaUsd - a.costoIaUsd);

  // ── Las mediciones del checklist de onboarding ─────────────────────────
  // Cada lectura cae POR SU LADO a `null`: si `telefonosJefe` falla, sus
  // casillas dicen "no se pudo medir" (que no es "pendiente") y las demás
  // siguen midiendo. La tabla maestra no depende de ninguna de las dos.
  const [telefonos, onboarding, senalesPmf] = await Promise.all([
    r.flotas.length === 0
      ? Promise.resolve<Record<string, string> | null>({})
      : telefonosJefe(r.flotas.map((f) => f.id)).catch(() => null),
    getOnboardingFlotas().catch(() => null as Map<string, OnboardingFlota> | null),
    // Las 3 señales de PMF (mig. 0114), de TODAS las flotas en UNA consulta.
    //
    // ERA UN `Promise.all` DE SIETE `count exact` POR FLOTA (ESC-9): 7 × N
    // consultas simultáneas contra el mismo pooler para pintar esta tabla —
    // con 50 flotas, 350. Ahora `senales_pmf()` (mig. 0162) las agrupa en la
    // base y cruza la red un arreglo del tamaño del número de FLOTAS.
    //
    // Lo que se perdió al juntarlas, dicho: antes una flota con la lectura
    // rota dejaba a las demás midiendo; ahora la lectura es una sola, así que
    // si falla, TODAS las fichas dicen "no se pudo leer" (que es la verdad).
    // El `.catch` de aquí sigue siendo el que impide que se lleve la página.
    getSenalesPmfTodas().catch(() => null as Map<string, SenalesPmf> | null),
  ]);
  /** Una flota sin filas en las tablas de onboarding = ceros CONTADOS (la
   *  lectura sí se completó); `null` solo cuando la lectura entera falló. */
  const onboardingDe = (tenantId: string): OnboardingFlota | null =>
    onboarding === null
      ? null
      : onboarding.get(tenantId) ?? {
          credenciales: { total: 0, probadas: 0 },
          avisosConfigurados: 0,
          avisoPrivacidad: { razonSocial: false, domicilio: false },
        };

  return (
    <main className="h-full">
      <div className="rounded-2xl overflow-hidden min-h-full flex flex-col hairline" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<Truck width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Flotas / Clientes"
        />

        <div className="px-5 py-5 flex-1 space-y-2.5">
          <div className="card overflow-hidden">
            <div className="px-4 pt-3 pb-1 flex items-center justify-between gap-4">
              <div>
                <TituloSeccion>Tabla maestra</TituloSeccion>
                {r.flotas.length > 1 && (
                  <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                    Ordenada por costo de IA, de mayor a menor
                  </p>
                )}
              </div>
              <ContadorRetro valor={r.tenants} digitos={3} etiqueta="Flotas dadas de alta" tamaño="lg" />
            </div>
            {flotasOrdenadas.length === 0 ? (
              <div className="px-4 pt-2 pb-4">
                <EstadoVacio icono={<Truck width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}>
                  Sin flotas dadas de alta todavía.
                </EstadoVacio>
              </div>
            ) : (
              <div className="overflow-x-auto mt-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ color: 'var(--muted)' }} className="text-left">
                      <th className="px-4 py-2 font-medium">Flota</th>
                      <th className="px-4 py-2 font-medium">Plan</th>
                      <th className="px-4 py-2 font-medium text-right">Viajes</th>
                      <th className="px-4 py-2 font-medium text-right">Costo de IA</th>
                      <th className="px-4 py-2 font-medium">Facilidad 15% (RFA 2.9)</th>
                      <th className="px-4 py-2 font-medium text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {flotasOrdenadas.map((f) => (
                      <tr key={f.id} className="border-t transition-colors hover:bg-[var(--canvas)]" style={{ borderColor: 'var(--line2)' }}>
                        <td className="px-4 py-2.5 font-medium">{f.nombre}</td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>{f.plan}</td>
                        <td className="px-4 py-2.5 text-right tabular">{numero(f.viajes)}</td>
                        <td className="px-4 py-2.5 text-right tabular">{usd(f.costoIaUsd)}</td>
                        <td className="px-4 py-2.5">
                          <FormaConAviso accion={accionFacilidad} boton="Guardar" columnas="110px auto">
                            <input type="hidden" name="flotaId" value={f.id} />
                            <select name="ded" defaultValue={f.facilidad15?.dedicacionExclusivaCarga === true ? 'si' : f.facilidad15?.dedicacionExclusivaCarga === false ? 'no' : ''}
                              className="text-xs" style={{ width: 110 }}>
                              <option value="">Carga: —</option>
                              <option value="si">Carga: Sí</option>
                              <option value="no">Carga: No</option>
                            </select>
                            <select name="reg" defaultValue={f.facilidad15?.regimenElegible === true ? 'si' : f.facilidad15?.regimenElegible === false ? 'no' : ''}
                              className="text-xs" style={{ width: 110 }}>
                              <option value="">Régimen: —</option>
                              <option value="si">Régimen: Sí</option>
                              <option value="no">Régimen: No</option>
                            </select>
                          </FormaConAviso>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {/* Ve el panel REAL que ve esa flota (mismo /dashboard del
                              cliente), no una copia — "Login as" honesto: sin
                              fingir ser un usuario de esa flota, el superadmin
                              entra con su propia sesión y `?tenant=` resuelve el
                              tenant, validado contra la tabla real (ver
                              dashboard/page.tsx). */}
                          {/* DOS PUERTAS, no una. El dueño y el jefe de tráfico
                              comparten la misma URL y ven cosas distintas
                              (visibilidad.ts): sin el segundo link no había forma
                              de comprobar qué ve cada quien sin la contraseña de
                              los dos. `?rol=` solo QUITA visibilidad y solo se
                              honra si la sesión real es superadmin. */}
                          <div className="inline-flex items-center gap-1.5">
                            {/* La ficha 360 (16-ago-2026): TODO el cliente en
                                una pantalla — el hueco que el plan nombró. */}
                            <Link href={`/admin/flotas/${f.id}`}
                              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full hairline hover:opacity-70 transition-opacity">
                              Ficha 360
                            </Link>
                            <Link href={`/dashboard?tenant=${f.id}&rol=flota_admin`} target="_blank"
                              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full hairline hover:opacity-70 transition-opacity">
                              <ExternalLink width={11} height={11} strokeWidth={1.75} /> Panel de dueño
                            </Link>
                            <Link href={`/dashboard?tenant=${f.id}&rol=encargado`} target="_blank"
                              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full hairline hover:opacity-70 transition-opacity">
                              <ExternalLink width={11} height={11} strokeWidth={1.75} /> Panel de jefe de flota
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Ranking real de las mismas flotas de la tabla, por costo de IA —
              HBars (design system v2) compara categorías de un vistazo; la
              tabla arriba se queda porque tiene columnas que una barra no
              puede mostrar (plan, viajes, el link "Ver dashboard"). Solo con
              2+ flotas: con 1 sola, "ranking" no dice nada que la tabla ya no
              diga. */}
          {flotasOrdenadas.length > 1 && (
            <ChartCard titulo="Top flotas por costo de IA" tamano="M">
              <HBars datos={flotasOrdenadas.map((f) => ({ etiqueta: f.nombre, valor: f.costoIaUsd }))} formato="usd" />
            </ChartCard>
          )}

          {/* ── Checklist de onboarding por flota (auditoría D9) ────────────
              SOLO casillas que se pueden MEDIR hoy — cada una con su dato y
              su link a donde se resuelve. Lo que no se puede medir (que el
              jefe ya entendió el flujo, que el bot le contestó bien) no
              aparece como casilla: una palomita sin medición sería inventada. */}
          {flotasOrdenadas.length > 0 && (
            <section className="card p-4">
              <div className="flex items-center gap-2">
                <ClipboardCheck width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
                <TituloSeccion>Onboarding por flota — el ciclo real de arranque</TituloSeccion>
              </div>
              <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
                {flotasOrdenadas.map((f) => {
                  const tel = telefonos === null ? null : telefonos[f.id] ?? null;
                  const ob = onboardingDe(f.id);
                  return (
                    <div key={f.id} className="hairline rounded-lg px-3 py-2.5" style={{ background: 'var(--surface)' }}>
                      <div className="text-[13px] font-medium mb-1">{f.nombre}</div>
                      {/* 1. El teléfono de quien decide (encargado o dueño) —
                          sin él, la escalación por WhatsApp no tiene a quién. */}
                      <Casilla
                        estado={telefonos === null ? 'sin_medir' : tel ? 'ok' : 'pendiente'}
                        texto={telefonos === null
                          ? 'Teléfono del jefe: no se pudo leer (≠ que falte)'
                          : tel
                            ? `Teléfono del jefe capturado (${tel})`
                            : 'Sin teléfono de jefe ni de dueño — la escalación por WhatsApp no tiene a quién avisar'}
                        href="/admin/usuarios/nuevo" accion="capturar"
                      />
                      {/* 2. La política de gastos PROPIA (override crudo, ver
                          negocio.ts — getConfig fusiona y no distingue). */}
                      <Casilla
                        estado={f.politicaPropia ? 'ok' : 'pendiente'}
                        texto={f.politicaPropia
                          ? 'Política de gastos propia guardada'
                          : 'Sin política propia — el motor cuadra con los topes de demo'}
                        href={`/dashboard/politicas?tenant=${f.id}`} accion="configurar"
                      />
                      {/* 3. Credenciales de conectores PROBADAS (guardar no es
                          conectar: la prueba real es `probada_en`, 0094). */}
                      <Casilla
                        estado={ob === null ? 'sin_medir' : ob.credenciales.probadas > 0 ? 'ok' : 'pendiente'}
                        texto={ob === null
                          ? 'Credenciales de conectores: no se pudo leer (≠ que falten)'
                          : ob.credenciales.total === 0
                            ? 'Sin credenciales de conectores guardadas'
                            : `Credenciales de conectores: ${numero(ob.credenciales.probadas)} de ${numero(ob.credenciales.total)} probadas contra el sistema real`}
                        href={`/dashboard/conexiones?tenant=${f.id}`} accion="conectar"
                      />
                      {/* 4. Avisos de los agentes — filas en la config (0097).
                          Sin fila NO está roto: corren los defaults del código. */}
                      <Casilla
                        estado={ob === null ? 'sin_medir' : ob.avisosConfigurados > 0 ? 'ok' : 'pendiente'}
                        texto={ob === null
                          ? 'Avisos de agentes: no se pudo leer (≠ que falten)'
                          : ob.avisosConfigurados > 0
                            ? `Avisos ajustados en ${numero(ob.avisosConfigurados)} ${ob.avisosConfigurados === 1 ? 'agente' : 'agentes'}`
                            : 'Avisos sin ajustar — corren los defaults del código (no está roto, pero nadie los decidió)'}
                        href={`/dashboard/agentes/liquidacion?tenant=${f.id}`} accion="ajustar"
                      />
                      {/* 5. El primer viaje — el conteo real que ya trae la
                          tabla maestra, no una consulta nueva. */}
                      <Casilla
                        estado={f.viajes > 0 ? 'ok' : 'pendiente'}
                        texto={f.viajes > 0
                          ? `${numero(f.viajes)} ${f.viajes === 1 ? 'viaje registrado' : 'viajes registrados'}`
                          : 'Ni un viaje registrado todavía'}
                        href={`/dashboard/viajes?tenant=${f.id}`} accion="ver viajes"
                      />
                      {/* 6. El aviso de privacidad de la flota (auditoría 19,
                          legal C3 / C.16). Sin razón social el aviso NO existe
                          (404) y el tratamiento de datos de choferes queda
                          frenado en el primer mensaje; sin domicilio existe
                          pero sale con la fr. I pendiente. */}
                      <Casilla
                        estado={ob === null
                          ? 'sin_medir'
                          : ob.avisoPrivacidad.razonSocial && ob.avisoPrivacidad.domicilio ? 'ok' : 'pendiente'}
                        texto={ob === null
                          ? 'Aviso de privacidad: no se pudo leer (≠ que falte)'
                          : !ob.avisoPrivacidad.razonSocial
                            ? 'Aviso de privacidad SIN responsable: falta la razón social — sus choferes no pueden mandar comprobantes'
                            : !ob.avisoPrivacidad.domicilio
                              ? 'Aviso de privacidad incompleto: falta el domicilio fiscal (la fr. I sale marcada pendiente)'
                              : 'Aviso de privacidad completo: razón social y domicilio capturados'}
                        href={`/dashboard/suscripcion?tenant=${f.id}`} accion="capturar"
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                Solo aparecen casillas medibles con datos de hoy: teléfono de quien decide (app_user),
                política propia (override de tenant.config), credenciales probadas (probada_en),
                avisos ajustados (agente_notificacion_config) y viajes. «No se pudo leer» significa
                que la consulta falló — no que la casilla esté pendiente.
              </p>
            </section>
          )}

          {/* ── Las 3 señales de PMF (mig. 0114): ¿el producto se USA, no
              solo se firmó? El lector vive en lib/likida/pmf.ts; aquí y no
              en una pantalla nueva porque con un cliente la pregunta se
              contesta en la misma ficha del onboarding. */}
          {flotasOrdenadas.length > 0 && (
            <SenalesPmfPorFlota
              flotas={flotasOrdenadas.map((f) => ({
                id: f.id,
                nombre: f.nombre,
                // `null` (la lectura entera falló) → "no se pudo leer".
                // Mapa vivo y flota ausente → la flota NO TIENE datos todavía,
                // que es otra cosa y se dibuja distinto (cero ≠ ciego).
                senales: senalesPmf === null ? null : senalesPmf.get(f.id) ?? SENALES_SIN_DATOS,
              }))}
            />
          )}

          <section className="card p-4">
            <div className="flex items-center gap-2">
              <Plus width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
              <TituloSeccion>Dar de alta una flota</TituloSeccion>
            </div>
            <div className="mt-3">
              <FormaConAviso accion={accionCrearFlota} boton="Dar de alta">
                <Campo nombre="nombre" etiqueta="Nombre de la flota" requerido placeholder="Flota de ejemplo" />
                <Campo nombre="rfc" etiqueta="RFC" placeholder="Opcional"
                  ayuda="Se rechaza si no pasa el dígito verificador." />
                <Campo nombre="ciudad" etiqueta="Ciudad" placeholder="Opcional" />
                {/* LOS CINCO DEL RECEPTOR. Sin ellos `getFiscalDeFlota` se niega
                    a registrar la flota y NADA de esa flota se factura — el alta
                    pedía tres, así que cada flota nueva nacía sin poder facturar
                    y el hueco solo aparecía semanas después, como un cron que no
                    hacía nada. Siguen siendo opcionales: se pueden capturar en
                    /dashboard/suscripcion. Lo que ya no pasa es capturarlos a
                    medias y que parezca completo. */}
                <Campo nombre="razonSocial" etiqueta="Razón social" placeholder="MI FLOTA SA DE CV — opcional"
                  ayuda="TAL CUAL su Constancia de Situación Fiscal: el SAT la compara contra lo que tiene para ese RFC y rechaza por diferencias que se ven inofensivas." />
                <Campo nombre="codigoPostalFiscal" etiqueta="Código postal fiscal" placeholder="5 dígitos — opcional"
                  ayuda="El del domicilio FISCAL ante el SAT, no el del patio. El PAC lo compara contra el registrado para ese RFC." />
                <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                  <span className="mt-1">Uso del CFDI:</span>
                  <select name="usoCfdi" className="text-xs" defaultValue="">
                    <option value="">Sin declarar</option>
                    {USOS_CFDI.map((u) => (
                      <option key={u.clave} value={u.clave}>{u.clave} — {u.nombre}</option>
                    ))}
                  </select>
                </label>
                <Campo nombre="emailAdmin" etiqueta="Correo del administrador" tipo="email" placeholder="dueño@flota.mx"
                  ayuda="Sin él, la flota nace sin quién pueda entrar." />
                <Campo nombre="nombreAdmin" etiqueta="Nombre del administrador" placeholder="Opcional" />
                {/* D5 (auditoría 4): sin este teléfono, el dueño no puede
                    escribirle al bot — el matcher de oficina no lo reconoce. */}
                <Campo nombre="telefonoAdmin" etiqueta="WhatsApp del administrador" placeholder="10 dígitos — opcional, para que el bot lo reconozca"
                  ayuda="Con él, el bot reconoce al administrador cuando escribe (avisos contestables, despacho por chat). Se puede capturar después." />
                <label className="flex items-start gap-2 text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  <input type="checkbox" name="dedicacionExclusivaCarga" className="mt-0.5" />
                  <span>
                    <b>¿Exclusivamente autotransporte de carga federal?</b> — habilita la
                    facilidad del 15% de diésel en efectivo (RFA 2026 regla 2.9).
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                  <span className="mt-1">Régimen fiscal (c_RegimenFiscal SAT):</span>
                  {/* EL MISMO CATÁLOGO QUE VALIDA `validarDatosFiscales`, y no
                      por gusto: esta lista ofrecía 605, 606, 607, 608, 610, 611,
                      615 y 616 —sueldos, arrendamiento, dividendos— que el
                      validador fiscal rechaza con "elige uno de la lista",
                      hablándole de una lista donde el valor SÍ estaba. Dos
                      catálogos del mismo dato siempre acaban discrepando; el que
                      manda es el que la facturación acepta. De paso entran 603 y
                      626 (RESICO), que esta lista no ofrecía y sí califican. */}
                  <select name="regimenFiscal" className="text-xs" defaultValue="">
                    <option value="">Sin declarar</option>
                    {REGIMENES.map((r) => (
                      <option key={r.clave} value={r.clave}>{r.clave} — {r.nombre}</option>
                    ))}
                  </select>
                  <span>
                    — la facilidad del 15% (RFA 2.9) exige 624 Coordinados o 612 persona física;
                    cualquier otro, 601 incluido, no califica y el efectivo en combustible no se
                    deduce.
                  </span>
                </label>
              </FormaConAviso>
            </div>
            <p className="text-xs mt-3" style={{ color: 'var(--muted)' }}>
              El RFC se valida en el alta porque es la única oportunidad barata: con uno inválido, el motor apaga la
              comprobación de a nombre de quién vienen las facturas y ninguna se rechaza por estar a nombre de otro. La
              flota creería que se está revisando.
            </p>
          </section>

          {/* ADM-5 (auditoría 24): decía que uso vs. límite, salud
              (activa/en riesgo/morosa) y el audit log de impersonación
              "siguen en el roadmap" — ya existen: los dos primeros en la
              ficha de cada flota (`ficha.tsx`, `lib/saas/suscripcion.ts`), el
              audit log en `impersonacion_dia`/`bitacora_auditoria`
              (`tenant-efectivo.ts`). Lo único que de verdad falta es el MRR
              DESGLOSADO por cliente (hoy `getMrr()` solo trae el total). */}
          <EstadoVacio>
            &quot;Ver dashboard&quot; ya existe (arriba) — entra al panel real de esa flota con tu propia sesión de superadmin, sin credenciales nuevas. Uso vs. límite y salud (activa/en riesgo/morosa) ya están en la ficha de cada flota; el audit log de qué flota viste y cuándo ya se escribe (impersonación). Lo que falta: MRR desglosado por cliente — hoy solo hay el total de la plataforma.
            <br /><br />
            Retención por cohortes, distribución por plan — necesita más de 1 tenant para decir algo real.
          </EstadoVacio>
        </div>
      </div>
    </main>
  );
}
