import { LogOut } from 'lucide-react';
import Fondo from '../fondo';
import { MARCO_FILA, MARCO_SIDEBAR, MARCO_COLUMNA, MARCO_SCROLL, CLASE_COLUMNA_CENTRO } from '../marco';
import SidebarNav, { SidebarAbajo } from './sidebar-nav';
import { BotonSidebar } from '../boton-sidebar';
import AvisoRol from './aviso-rol';
import { Logo } from '../logo';
import { EnlaceCuenta } from './enlace-cuenta';
import { ROL_BADGE, type RolAppUser } from '@/lib/auth/provisionar';

/**
 * El marco visual de /dashboard — fondo shader, sidebar glass con el logo,
 * navegación, perfil y cerrar sesión. SIN autorización adentro a propósito:
 * la puerta vive en `layout.tsx` (y la resolución de tenant, en cada
 * página), y así este archivo es puro dibujo.
 *
 * Separarlo del layout no es ceremonia: es lo que permite verificar el
 * marco DE VERDAD en un render de prueba (screenshot headless) en vez de
 * verificar una copia del marco que podría haber divergido del real. Un
 * layout con `redirect()` adentro no se puede renderizar sin sesión.
 *
 * AUDITORÍA 28, ARQ-B5 (BAJO, reincidente 26/27): el badge de rol del
 * sidebar ERA una quinta copia del dominio de roles, declarada aquí sin
 * tipar. Ahora se importa `ROL_BADGE` de `@/lib/auth/provisionar` — la misma
 * fuente de `ROL_LABEL` (0044/0086/0105) — para que un rol nuevo ponga
 * `tsc` en rojo en un solo lugar, no en ninguno.
 */

export default function DashboardChrome({
  nombre, rol, cerrarSesion, usoIa, children,
}: {
  nombre: string | null;
  rol: string;
  /** Server action. Opcional: el render de prueba no cierra sesión de nadie. */
  cerrarSesion?: () => Promise<void>;
  /** El % usado del presupuesto diario de análisis con IA (16-ago-2026).
   *  Lo trae layout.tsx; omitido (render de prueba / preview de superadmin)
   *  no se pinta. */
  usoIa?: { pct: number } | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh tema-neutro" style={{ fontFamily: 'var(--font-sans-ui), var(--font-sans)' }}>
      <Fondo />
            <div className={MARCO_FILA}>
        <aside className={`${MARCO_SIDEBAR} sb-aside`}>
          <div className="px-3 py-3 flex items-center justify-center lg:justify-start gap-1.5 sb-centrable">
            <span className="sb-logo min-w-0"><Logo alto="h-[18px]" /></span>
            <span className="ml-auto hidden lg:block"><BotonSidebar /></span>
            {/* La insignia usa el rol REAL de la sesión, no el previsualizado.
                Para un superadmin eso significa que el panel que se presenta
                como "el de una flota ejemplo" lleva SUPERADMIN escrito
                junto al logo durante todo el demo — y con `?rol=encargado` se
                contradice con la cinta que dice "estás viendo como Jefe de
                tráfico". Se esconde solo en ese caso: para los roles reales
                (flota_admin, contador, encargado) la insignia sí dice la
                verdad y se queda, porque ahí sirve. */}
{/* El rol vive en el user card de abajo (12-ago-2026) — junto al logo
                no hay badge. */}
          </div>

          <nav className="flex-1 overflow-y-auto px-2 space-y-2 pb-3">
            <SidebarNav rol={rol} />
          </nav>

          {/* El bloque inferior fijo, con su propio
              fondo (el "cambio de color de hasta abajo", 13-ago-2026). */}
          <div className="px-2 pt-2 pb-1.5 space-y-0.5 shrink-0" style={{ background: 'var(--canvas)', borderTop: '1px solid var(--line)' }}>
            <SidebarAbajo rol={rol} usoIa={usoIa} />
          </div>

          {/* El user card: tarjeta con hairline,
              avatar + nombre + rol, y salir como icono al lado — el botón
              rojo de ancho completo gritaba más que cualquier contenido.
              H10/H11 (auditoría 24): en modo ícono (72px — colapso manual
              en escritorio o CUALQUIER pantalla bajo `lg`, es decir, todo
              teléfono) no caben avatar y botón uno junto al otro, así que se
              apilan en columna (`lg:flex-row` los pone en fila desde 1024px;
              `.sb-user-card` en globals.css cubre el colapso manual, que se
              queda en viewport `lg` pero en ancho de 72px). "Cerrar sesión"
              ya NO lleva `hidden lg:block`: antes desaparecía entero en un
              teléfono y no había ningún control de salir de la cuenta desde
              el panel. */}
          <div className="px-2 pb-2 pt-2" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="hairline rounded-xl p-2 flex flex-col items-center lg:flex-row lg:justify-start gap-2 sb-centrable sb-user-card" style={{ background: 'var(--surface)' }}>
              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[11px] font-semibold" style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
                {(nombre ?? 'F')[0].toUpperCase()}
              </div>
              <div className="hidden lg:block min-w-0 flex-1 sb-texto">
                {/* H29 (auditoría 24): iba a `/cuenta` a secas — un superadmin
                    previsualizando una flota (`?tenant=X&vista=demo`) que
                    tocara su nombre perdía esos parámetros. Mismo contrato de
                    sufijo que `sidebar-nav.tsx` (Client Component, lee
                    `useSearchParams()` — `layout.tsx` no recibe `searchParams`,
                    limitación de Next.js documentada ahí mismo). */}
                <EnlaceCuenta rol={rol} className="block text-[13px] font-medium hover:opacity-70 transition-opacity truncate leading-tight">
                  {nombre ?? 'Mi cuenta'}
                </EnlaceCuenta>
                <div className="text-[10px] truncate" style={{ color: 'var(--faint)' }}>{ROL_BADGE[rol as RolAppUser] ?? rol.toUpperCase()}</div>
              </div>
              {cerrarSesion && (
                <form action={cerrarSesion} className="shrink-0">
                  <button type="submit" title="Cerrar sesión" aria-label="Cerrar sesión"
                    className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--badbg)]"
                    style={{ color: 'var(--bad)' }}>
                    <LogOut width={14} height={14} strokeWidth={1.75} />
                  </button>
                </form>
              )}
            </div>
          </div>
        </aside>

        <div className={`${MARCO_COLUMNA} ${CLASE_COLUMNA_CENTRO}`}>
          <div className={MARCO_SCROLL}>
            <AvisoRol rolReal={rol} />
            {children}
          </div>
        </div>

        {/* El rail del Asistente se BORRÓ el 12-ago-2026 (pedido explícito:
            "nunca más debe aparecer en ninguna página") — su casa es
            /dashboard/chat, "Chatea con tus datos". Con él se fue su
            endpoint /api/dashboard/asistente. */}
      </div>
    </div>
  );
}
