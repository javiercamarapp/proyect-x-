'use client';

import { useEffect, useState } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Upload, Check, X, Copy, Mail } from 'lucide-react';
import { validarArchivoElegido } from '@/lib/http/subidas_formulario';

export type AccionProveedores = (
  prev: { error?: string; aviso?: string } | null,
  fd: FormData,
) => Promise<{ error?: string; aviso?: string } | null>;

/** Subida del XML. Tras guardar, la página se refresca para que la bandeja
 *  y los KPIs cuenten la factura nueva. */
export function SubirFactura({ subirFactura }: { subirFactura: AccionProveedores }) {
  const [estado, accion] = useActionState(subirFactura, null);
  const router = useRouter();

  useEffect(() => {
    if (estado?.aviso) router.refresh();
  }, [estado, router]);

  return (
    <div>
      <form action={accion} className="flex items-center gap-2 flex-wrap">
        <input type="file" name="archivo" accept=".xml,text/xml,application/xml" required
          aria-label="XML de la factura de proveedor"
          className="text-[12.5px] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-medium file:cursor-pointer"
          style={{ color: 'var(--muted)' }} />
        <BotonSubir />
      </form>
      {estado?.error && <p className="text-[12px] mt-2" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
      {estado?.aviso && (
        <p className="text-[12px] mt-2" style={{ color: estado.aviso.includes('OJO') ? 'var(--warn)' : 'var(--muted)' }}>
          {estado.aviso}
        </p>
      )}
    </div>
  );
}

function BotonSubir({ rotulo = 'Subir a la bandeja', pendienteRotulo = 'Leyendo…' }: {
  rotulo?: string; pendienteRotulo?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-lg transition-opacity hover:opacity-85 disabled:opacity-50"
      style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
      <Upload width={13} height={13} strokeWidth={2} className={pending ? 'animate-pulse' : ''} />
      {pending ? pendienteRotulo : rotulo}
    </button>
  );
}

/**
 * La vía de FOTO (F6): cuando solo hay papel. El botón dice "leer con IA" a
 * propósito — las cifras van a salir de visión, no del XML, y el aviso de la
 * action manda a revisarlas contra el papel antes de aprobar.
 */
export function SubirFotoFactura({ subirFoto }: { subirFoto: AccionProveedores }) {
  const [estado, accion] = useActionState(subirFoto, null);
  const router = useRouter();

  useEffect(() => {
    if (estado?.aviso) router.refresh();
  }, [estado, router]);

  return (
    <div>
      <form action={accion} className="flex items-center gap-2 flex-wrap">
        <input type="file" name="archivo" accept="image/jpeg,image/png,image/webp" required
          onChange={(e) => validarArchivoElegido(e.currentTarget)}
          aria-label="Foto de la factura de proveedor"
          className="text-[12.5px] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-medium file:cursor-pointer"
          style={{ color: 'var(--muted)' }} />
        <BotonSubir rotulo="Leer foto con IA" pendienteRotulo="Leyendo la foto…" />
      </form>
      <p className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>Máximo 4 MB por foto.</p>
      {estado?.error && <p className="text-[12px] mt-2" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
      {estado?.aviso && (
        <p className="text-[12px] mt-2" style={{ color: estado.aviso.includes('OJO') ? 'var(--warn)' : 'var(--muted)' }}>
          {estado.aviso}
        </p>
      )}
    </div>
  );
}

/** Aprobar / rechazar, con confirmación de dos pasos en el rechazo (aprobar
 *  es reversible en el ERP; rechazar la saca del export sin vuelta aquí). */
export function BotonesDecision({ facturaId, decidir }: { facturaId: string; decidir: AccionProveedores }) {
  const [estado, accion] = useActionState(decidir, null);
  const [confirmando, setConfirmando] = useState(false);

  return (
    <div className="min-w-[190px]">
      {confirmando ? (
        <form action={accion} onSubmit={() => setConfirmando(false)} className="inline-flex items-center gap-2">
          <input type="hidden" name="facturaId" value={facturaId} />
          <input type="hidden" name="decision" value="rechazada" />
          <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>¿Rechazarla?</span>
          <BotonMini texto="Sí" pendienteTexto="…" destructivo />
          <button type="button" onClick={() => setConfirmando(false)}
            className="hairline text-[11.5px] font-medium px-2 py-1 rounded-lg transition-colors hover:bg-[var(--canvas)]"
            style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
            No
          </button>
        </form>
      ) : (
        <div className="inline-flex items-center gap-1.5">
          <form action={accion} className="inline">
            <input type="hidden" name="facturaId" value={facturaId} />
            <input type="hidden" name="decision" value="aprobada" />
            <BotonMini texto="Aprobar" pendienteTexto="Guardando…" IconoOk />
          </form>
          <button type="button" onClick={() => setConfirmando(true)} title="Rechazar la factura"
            className="hairline inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-1 rounded-lg transition-colors hover:bg-[var(--canvas)]"
            style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
            <X width={11} height={11} strokeWidth={2} /> Rechazar
          </button>
        </div>
      )}
      {estado?.error && <p className="text-[11px] mt-1" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
    </div>
  );
}

/** La dirección del buzón en mono con su botón de copiar — el mismo patrón
 *  `copiar()` de la cola del jefe: confirmación de 1.5 s, sin alertas. */
export function DireccionBuzon({ direccion }: { direccion: string }) {
  const [copiado, setCopiado] = useState(false);

  function copiar() {
    void navigator.clipboard.writeText(direccion).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    });
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <code className="cifra-mono text-[12.5px] px-2 py-1 rounded-lg hairline break-all"
        style={{ background: 'var(--surface)' }}>{direccion}</code>
      <button type="button" aria-label="Copiar la dirección del buzón" onClick={copiar}
        className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-[var(--canvas)]"
        style={{ color: copiado ? 'var(--ok)' : 'var(--muted)' }}>
        {copiado ? <Check width={13} height={13} strokeWidth={2} /> : <Copy width={13} height={13} strokeWidth={2} />}
      </button>
    </div>
  );
}

/** Generar la dirección por primera vez. La action redirige al terminar, así
 *  que aquí solo se enseña el error si lo hubo. */
export function GenerarBuzon({ generar }: { generar: AccionProveedores }) {
  const [estado, accion] = useActionState(generar, null);
  return (
    <div>
      <form action={accion}>
        <BotonBuzon texto="Generar dirección" pendienteTexto="Generando…" />
      </form>
      {estado?.error && <p className="text-[12px] mt-2" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
    </div>
  );
}

/**
 * Rotar, escondido en un `<details>` A PROPÓSITO: no es una acción de todos
 * los días y su consecuencia es irreversible en el acto — el correo que
 * llegue al buzón viejo cae en `buzon_desconocido` y se ignora. La
 * advertencia va ANTES del botón, no en un tooltip.
 */
export function RotarBuzon({ rotar }: { rotar: AccionProveedores }) {
  const [estado, accion] = useActionState(rotar, null);
  return (
    <details className="mt-3">
      <summary className="text-[12px] cursor-pointer select-none" style={{ color: 'var(--muted)' }}>
        ¿Necesitas rotar la dirección?
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[12px] max-w-xl" style={{ color: 'var(--warn)' }}>
          Rotar genera una dirección nueva e <strong>invalida la actual en el acto</strong>: los
          correos que lleguen al buzón viejo se ignoran sin avisarle a quien los mandó. Hazlo solo
          si la dirección se filtró a donde no debía, y pásales la nueva a tus proveedores.
        </p>
        <form action={accion}>
          <BotonBuzon texto="Rotar e invalidar la anterior" pendienteTexto="Rotando…" destructivo />
        </form>
        {estado?.error && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
      </div>
    </details>
  );
}

function BotonBuzon({ texto, pendienteTexto, destructivo }: {
  texto: string; pendienteTexto: string; destructivo?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-lg transition-opacity hover:opacity-85 disabled:opacity-50"
      style={destructivo
        ? { background: 'var(--badbg)', color: 'var(--bad)' }
        : { background: 'var(--marca)', color: 'var(--marca-fg)' }}>
      <Mail width={13} height={13} strokeWidth={2} className={pending ? 'animate-pulse' : ''} />
      {pending ? pendienteTexto : texto}
    </button>
  );
}

function BotonMini({ texto, pendienteTexto, IconoOk, destructivo }: {
  texto: string; pendienteTexto: string; IconoOk?: boolean; destructivo?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2.5 py-1 rounded-lg transition-opacity hover:opacity-85 disabled:opacity-50"
      style={destructivo
        ? { background: 'var(--badbg)', color: 'var(--bad)' }
        : { background: 'var(--marca)', color: 'var(--marca-fg)' }}>
      {IconoOk && <Check width={11} height={11} strokeWidth={2} />}
      {pending ? pendienteTexto : texto}
    </button>
  );
}
