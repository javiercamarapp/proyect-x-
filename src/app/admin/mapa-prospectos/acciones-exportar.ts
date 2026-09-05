'use server';

// ═══════════════════════════════════════════════════════════════════════════
// ADM-8 (auditoría 24, MEDIO) — el rastro de una exportación del Cerebro.
//
// "Exportar CSV (N)" arma el archivo ENTERO en el navegador (`cerebro.tsx`,
// `exportarCsv`) con los datos ya cargados ahí — no hay una ruta GET/POST
// dedicada al export que pudiera firmar la bitácora en el camino. Este
// server action es el único punto de paso obligado antes de servir el
// archivo: `cerebro.tsx` lo llama justo antes de armar el Blob, y
// `registrarExportacionProspectos` (lib/admin/prospectos-mapa.ts) escribe
// en `bitacora_auditoria` — nunca prospectos.ts (el CSV se sigue armando en
// el cliente; solo el RASTRO de que se pidió pasa por el servidor).
//
// RE-GATEO: la acción es un endpoint público en la práctica — el layout solo
// protegió el render (mismo patrón que el resto de /admin).
// ═══════════════════════════════════════════════════════════════════════════

import { requireSuperadmin } from '@/lib/auth/guard';
import { registrarExportacionProspectos } from '@/lib/admin/prospectos-mapa';

/** Tope de contexto en la bitácora: filtros libres (texto de búsqueda) no
 *  pueden crecer sin límite en `detalle` — la bitácora es evidencia, no un
 *  segundo almacén de lo que alguien escribió. */
const MAX_TEXTO_FILTRO = 200;

export async function accionRegistrarExportacion(n: number, filtros: Record<string, unknown>): Promise<void> {
  const { userId } = await requireSuperadmin();
  const nSano = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  const filtrosSanos: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(filtros ?? {})) {
    filtrosSanos[k] = typeof v === 'string' ? v.slice(0, MAX_TEXTO_FILTRO) : v;
  }
  await registrarExportacionProspectos(userId, nSano, filtrosSanos);
}
