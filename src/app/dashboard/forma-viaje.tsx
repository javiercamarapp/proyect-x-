'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Plus } from 'lucide-react';
import { ComboCatalogo, type BuscarCatalogo } from './combo-catalogo';

/**
 * El formulario de NUEVO VIAJE — pieza REUSABLE a propósito (12-ago-2026):
 * la embebe Despacho (la página suelta /viajes/nuevo se retiró el 13-ago), que
 * es la siguiente página por reconstruir. Presentación pura: la mutación
 * llega como server action del host, que es quien re-verifica permisos
 * adentro (el patrón del repo: el gateo de la UI solo decide si se pinta).
 *
 * Campos = los de `NuevoViaje` (operacion.ts). La unidad ya se ofrece aquí
 * (14-ago-2026): `viaje.unidad_id` es nullable, así que "Sin asignar todavía"
 * es una opción que la base sí admite — a diferencia del operador.
 *
 * FE-2 (22-ago-2026): los tres catálogos (operador, unidad, cliente) YA NO
 * viajan como `<option>`. A 7,500 choferes y 5,000 unidades eran cientos de
 * KB de HTML por carga — y encima recortados a 1,000 en silencio por
 * PostgREST, así que el chofer 1,001 no se podía elegir. Ahora son
 * `ComboCatalogo`: se busca en el servidor al escribir, 20 a la vez, y lo que
 * se manda sigue siendo el id.
 */

export type AccionCrearViaje = (
  prev: { error?: string } | null,
  fd: FormData,
) => Promise<{ error?: string } | null>;

const CAMPO = 'w-full hairline rounded-lg px-3 h-9 text-sm outline-none focus:border-[var(--muted)] transition-colors';
const ETIQUETA = 'block text-xs font-medium mb-1.5';

function BotonCrear() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="h-9 px-4 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 transition-opacity hover:opacity-85 disabled:opacity-50"
      style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
      <Plus width={15} height={15} strokeWidth={2} />
      {pending ? 'Creando…' : 'Crear viaje'}
    </button>
  );
}

export function FormaViaje({ action, buscarCatalogo, totalOperadores, totalClientes, totalUnidades, puedeCapturarDinero = false }: {
  action: AccionCrearViaje;
  /** Sólo visibilidad; la acción vuelve a exigir el permiso de la sesión viva. */
  puedeCapturarDinero?: boolean;
  /** La búsqueda de catálogos en el servidor (server action del host, con el
   *  tenant por closure). Una sola referencia para los tres combos. */
  buscarCatalogo: BuscarCatalogo;
  /** Cuántos operadores activos hay — `count exact, head`, sin traer ninguno.
   *  `0` = todavía no hay ninguno dado de alta, y se dice; `null` = no se pudo
   *  contar, y entonces NO se afirma que falten (la base caída no es un
   *  catálogo vacío). */
  totalOperadores: number | null;
  /** Los clientes de la flota, para atar el viaje a quien paga el flete.
   *  Mismo contrato que `totalOperadores`. */
  totalClientes: number | null;
  /** Las unidades activas de la flota. Mismo contrato. */
  totalUnidades: number | null;
}) {
  const [estado, dispatch] = useActionState(action, null);

  return (
    <form action={dispatch} className="space-y-3.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div>
          <label htmlFor="folio" className={ETIQUETA}>Folio</label>
          <input id="folio" name="folio" type="text" maxLength={40} placeholder="F-0148"
            className={`${CAMPO} cifra-mono`} style={{ background: 'var(--surface)' }} />
        </div>
        <div>
          <label htmlFor="fechaInicio" className={ETIQUETA}>Fecha de inicio</label>
          <input id="fechaInicio" name="fechaInicio" type="date"
            className={CAMPO} style={{ background: 'var(--surface)' }} />
        </div>
        <div>
          <label htmlFor="origen" className={ETIQUETA}>Origen</label>
          <input id="origen" name="origen" type="text" maxLength={120} placeholder="Silao"
            className={CAMPO} style={{ background: 'var(--surface)' }} />
        </div>
        <div>
          <label htmlFor="destino" className={ETIQUETA}>Destino</label>
          <input id="destino" name="destino" type="text" maxLength={120} placeholder="Monterrey"
            className={CAMPO} style={{ background: 'var(--surface)' }} />
        </div>
        {puedeCapturarDinero && <div>
          <label htmlFor="anticipo" className={ETIQUETA}>Anticipo (MXN)</label>
          <input id="anticipo" name="anticipo" type="number" min={0} step="0.01" placeholder="8000"
            className={`${CAMPO} cifra-mono`} style={{ background: 'var(--surface)' }} />
        </div>}
        <div>
          <label htmlFor="operadorId" className={ETIQUETA}>Operador</label>
          {/* SIN "Sin asignar todavía". `viaje.operador_id` es NOT NULL desde la
              0001, así que esa opción no creaba un viaje sin operador: tronaba
              con un 23502 y el usuario veía "No se pudo crear el viaje" sin
              saber por qué. Verificado contra producción el 14-ago-2026.
              Ofrecer una opción que la base rechaza es peor que no ofrecerla. */}
          <ComboCatalogo tipo="operador" name="operadorId" campoId="operadorId" buscar={buscarCatalogo} requerido
            aria-label="Operador" etiquetaVacia="Escribe el nombre del chofer…"
            total={totalOperadores} className={CAMPO} estilo={{ background: 'var(--surface)' }} />
          <p className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>
            {totalOperadores === 0
              ? 'Necesitas al menos un operador dado de alta: un viaje no puede existir sin quién lo maneje. El alta rápida está a la derecha.'
              : 'Likida le avisa por WhatsApp en cuanto el viaje exista.'}
          </p>
        </div>
        <div>
          <label htmlFor="unidadId" className={ETIQUETA}>Unidad</label>
          {totalUnidades === 0 ? (
            <p className="text-[12px] py-2" style={{ color: 'var(--faint)' }}>
              Todavía no hay unidades dadas de alta. Se registran en Unidades.
            </p>
          ) : (
            <ComboCatalogo tipo="unidad" name="unidadId" campoId="unidadId" buscar={buscarCatalogo}
              aria-label="Unidad" etiquetaVacia="Sin asignar todavía"
              total={totalUnidades} className={`${CAMPO} cifra-mono`} estilo={{ background: 'var(--surface)' }} />
          )}
        </div>
      </div>

      {/* ── EL LADO DEL INGRESO ──────────────────────────────────────────
          Va en su propio bloque, DESPUÉS de lo operativo y visualmente
          separado, porque son datos de otra naturaleza y de otra persona: lo
          de arriba lo llena el jefe de tráfico al despachar, esto lo llena
          quien conoce lo que se le cobra al cliente. Juntos en la misma
          cuadrícula, el anticipo y el ingreso se confunden — y confundirlos
          produce márgenes que se ven bien y están mal. */}
      {puedeCapturarDinero && <fieldset className="pt-3.5 border-t" style={{ borderColor: 'var(--line)' }}>
        <legend className="etiqueta-mono text-[10px] uppercase mb-2.5" style={{ color: 'var(--faint)' }}>
          Lo que se le cobra al cliente · opcional
        </legend>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label htmlFor="clienteId" className={ETIQUETA}>Cliente</label>
            {totalClientes === 0 ? (
              <p className="text-[12px] py-2" style={{ color: 'var(--faint)' }}>
                Todavía no hay clientes dados de alta. Se registran en Clientes y tarifas.
              </p>
            ) : (
              <ComboCatalogo tipo="cliente" name="clienteId" campoId="clienteId" buscar={buscarCatalogo}
                aria-label="Cliente" etiquetaVacia="Sin asignar todavía"
                total={totalClientes} className={CAMPO} estilo={{ background: 'var(--surface)' }} />
            )}
          </div>

          <div>
            <label htmlFor="ingresoFlete" className={ETIQUETA}>Ingreso del flete (MXN)</label>
            <input id="ingresoFlete" name="ingresoFlete" type="text" inputMode="decimal" placeholder="38,500"
              className={`${CAMPO} cifra-mono`} style={{ background: 'var(--surface)' }} />
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>
              Lo que le cobras al cliente. NO es el anticipo: el anticipo es lo que le adelantas al
              operador. Déjalo vacío si todavía no lo sabes — vacío no es cero.
            </p>
          </div>

          <div>
            <label htmlFor="kmRecorridos" className={ETIQUETA}>Kilómetros</label>
            <input id="kmRecorridos" name="kmRecorridos" type="text" inputMode="numeric" placeholder="1,240"
              className={`${CAMPO} cifra-mono`} style={{ background: 'var(--surface)' }} />
          </div>
        </div>

        <p className="text-[11px] mt-2.5" style={{ color: 'var(--faint)' }}>
          Sin el ingreso capturado, este viaje no entra en la medición de margen — ni la suya ni la de
          su ruta, su cliente o su unidad. Se puede llenar después.
        </p>
      </fieldset>}

      {!puedeCapturarDinero && <div>
        <label htmlFor="kmRecorridos" className={ETIQUETA}>Kilómetros</label>
        <input id="kmRecorridos" name="kmRecorridos" type="text" inputMode="numeric" placeholder="1,240"
          className={`${CAMPO} cifra-mono`} style={{ background: 'var(--surface)' }} />
      </div>}

      {estado?.error && (
        <div className="rounded-lg px-3 py-2.5 text-[13px]" style={{ background: 'var(--badbg)', color: 'var(--bad)' }}>
          {estado.error}
        </div>
      )}

      <div className="pt-1">
        <BotonCrear />
      </div>
    </form>
  );
}
