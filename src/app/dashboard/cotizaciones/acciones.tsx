'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { AccionDeForma, ResultadoAccion } from '../../admin/ui/forma';

// ═══════════════════════════════════════════════════════════════════════════
// FE-13b (auditoría 24) — "Marcar enviada" / "Crear viaje" / "Perdida" /
// "Vencida" eran `<form action={fn}>` con `fn: Promise<void>`: sin
// `useActionState` no había `pending` (doble clic = doble envío, y "Crear
// viaje" es exactamente la acción que no debe dispararse dos veces) y el
// `catch` del servidor solo escribía al log — el humano veía la fila
// intacta tras el clic y no sabía si pasó algo.
// ═══════════════════════════════════════════════════════════════════════════

function Boton({ texto, pendienteTexto, className, disabled, title }: {
  texto: string; pendienteTexto: string; className: string; disabled?: boolean; title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} title={title} className={className}>
      {pending ? pendienteTexto : texto}
    </button>
  );
}

const BTN = 'rounded border px-2 py-1 hover:bg-[var(--canvas)] disabled:opacity-50';
const BTN_VERDE = 'rounded border border-emerald-600 px-2 py-1 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:hover:bg-emerald-950';

export function FilaAccionesCotizacion({
  id, puedeEnviar, precio, enviada, convertir, perdida,
}: {
  id: string;
  puedeEnviar: boolean;
  precio: number | null;
  enviada: AccionDeForma;
  convertir: AccionDeForma;
  perdida: AccionDeForma;
}) {
  const [estadoEnviada, accEnviada] = useActionState<ResultadoAccion, FormData>(enviada, null);
  const [estadoConvertir, accConvertir] = useActionState<ResultadoAccion, FormData>(convertir, null);
  const [estadoPerdidaP, accPerdida] = useActionState<ResultadoAccion, FormData>(perdida, null);
  const [estadoPerdidaV, accVencida] = useActionState<ResultadoAccion, FormData>(perdida, null);

  const error = estadoEnviada?.error ?? estadoConvertir?.error ?? estadoPerdidaP?.error ?? estadoPerdidaV?.error ?? null;

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="flex gap-2">
        {puedeEnviar && (
          <form action={accEnviada}>
            <input type="hidden" name="id" value={id} />
            <Boton texto="Marcar enviada" pendienteTexto="Marcando…" className={BTN} />
          </form>
        )}
        <form action={accConvertir}>
          <input type="hidden" name="id" value={id} />
          <Boton
            texto="Crear viaje" pendienteTexto="Creando…" className={BTN_VERDE}
            disabled={precio === null}
            title={precio === null ? 'Sin precio no hay viaje que crear' : 'Crea el viaje con esta ruta, cliente y precio'}
          />
        </form>
        <form action={accPerdida}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="como" value="perdida" />
          <Boton texto="Perdida" pendienteTexto="…" className={BTN} />
        </form>
        <form action={accVencida}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="como" value="vencida" />
          <Boton texto="Vencida" pendienteTexto="…" className={BTN} />
        </form>
      </span>
      {error && <span className="text-xs" style={{ color: 'var(--color-bad)' }}>{error}</span>}
    </div>
  );
}
