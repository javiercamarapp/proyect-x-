'use client';

import { useActionState, useState } from 'react';
import { CheckCircle2, PencilLine, XCircle, ShieldCheck } from 'lucide-react';
import { Aviso, ESTILO_CONTROL, type ResultadoAccion } from '@/app/admin/ui/forma';
import { mxn, fechaMx } from '@/lib/formato';
import type { AccionRevision, RevisionDetalle } from '@/lib/likida/revision';

// ═══════════════════════════════════════════════════════════════════════════
// LA FIRMA HUMANA, EN PANTALLA (auditoría 24, bloqueante 6 — mig. 0299).
//
// «El agente cuadra, tú firmas lo que no.» Hasta hoy la segunda mitad no
// existía: no había NI UN `update` sobre `liquidacion` en toda la app, así que
// el contralor leía el PDF y decidía en Excel. Tres botones y un motivo:
//
//   · APROBAR  — el cierre queda firmado con tu nombre y tu hora.
//   · AJUSTAR  — corrige el monto de un comprobante mal leído (WA-3: el ticket
//                de $8,000 que el modelo leyó $800). Mueve `gasto.monto` y el
//                total por la delta; NO vuelve a cuadrar, y lo dice.
//   · RECHAZAR — el viaje vuelve a cuadre y al chofer le llega el motivo por
//                WhatsApp, tal como lo escribiste.
//
// Ajustar y rechazar EXIGEN motivo: sin él es un botón, no una revisión. Todo
// queda en la bitácora dentro de la misma transacción (la RPC), y el botón se
// deshabilita mientras corre — un doble clic en una red lenta no puede firmar
// dos veces (además la base lo rebota con LR010, pero eso es el cinturón).
// ═══════════════════════════════════════════════════════════════════════════

export interface GastoAjustable { id: string; etiqueta: string; monto: number }

export function PanelRevision({ estado, gastos, accion, folio }: {
  estado: RevisionDetalle;
  /** Los comprobantes con id — los únicos que se pueden ajustar. */
  gastos: GastoAjustable[];
  /** `null` = el rol puede VER la firma pero no ponerla. */
  accion: ((previo: ResultadoAccion, fd: FormData) => Promise<ResultadoAccion>) | null;
  folio: string;
}) {
  return (
    <section className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck width={14} height={14} strokeWidth={1.75} aria-hidden />
        <h2 className="font-display text-[15px] font-semibold m-0">Revisión</h2>
      </div>

      <FirmaActual estado={estado} />

      {accion && estado.firmable && (
        <Forma accion={accion} gastos={gastos} folio={folio} yaFirmadaPorElMotor={estado.revision !== 'pendiente'} />
      )}
      {!accion && estado.firmable && (
        <p className="text-[12px] mt-2" style={{ color: 'var(--muted)' }}>
          Tu rol no firma liquidaciones. Pídeselo al dueño de la flota o a tu contador.
        </p>
      )}
      {!estado.firmable && estado.revision === 'rechazada' && (
        <p className="text-[12px] mt-2" style={{ color: 'var(--muted)' }}>
          El viaje volvió a cuadre. Cuando el operador mande lo que falta y el agente vuelva a cerrar,
          esta liquidación regresa a la cola con las cifras nuevas.
        </p>
      )}
    </section>
  );
}

const ROTULO: Record<string, string> = {
  pendiente: 'Espera tu firma',
  aprobada: 'Aprobada',
  ajustada: 'Ajustada',
  rechazada: 'Rechazada',
};

function FirmaActual({ estado }: { estado: RevisionDetalle }) {
  const { revision, revisadaPor, revisadaEn, motivo, ajustes } = estado;
  return (
    <div className="text-[12.5px] mb-3" style={{ color: 'var(--muted)' }}>
      <p className="m-0">
        <strong style={{ color: 'var(--ink)' }}>{ROTULO[revision] ?? revision}</strong>
        {revision !== 'pendiente' && (
          revisadaPor
            ? <> · la firmó {revisadaPor}{revisadaEn ? ` el ${fechaMx(revisadaEn)}` : ''}</>
            /* Sin persona detrás no se dice «la firmó alguien»: cuadró sola y
               eso es lo que se pone. La persona todavía puede corregirla. */
            : <> · cuadró sola, sin diferencias{revisadaEn ? ` (${fechaMx(revisadaEn)})` : ''}</>
        )}
      </p>
      {motivo && <p className="m-0 mt-1">Motivo: {motivo}</p>}
      {ajustes.length > 0 && (
        <ul className="m-0 mt-1 pl-4 list-disc">
          {ajustes.map((a) => (
            <li key={a.gastoId}>
              {a.concepto}: <span className="cifra-mono">{mxn(a.montoAnterior)}</span> →{' '}
              <span className="cifra-mono">{mxn(a.montoNuevo)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const OPCIONES: Array<{ id: AccionRevision; rotulo: string; icono: React.ReactNode }> = [
  { id: 'aprobar', rotulo: 'Aprobar', icono: <CheckCircle2 width={13} height={13} strokeWidth={2} aria-hidden /> },
  { id: 'ajustar', rotulo: 'Ajustar montos', icono: <PencilLine width={13} height={13} strokeWidth={2} aria-hidden /> },
  { id: 'rechazar', rotulo: 'Rechazar', icono: <XCircle width={13} height={13} strokeWidth={2} aria-hidden /> },
];

function Forma({ accion, gastos, folio, yaFirmadaPorElMotor }: {
  accion: (previo: ResultadoAccion, fd: FormData) => Promise<ResultadoAccion>;
  gastos: GastoAjustable[];
  folio: string;
  yaFirmadaPorElMotor: boolean;
}) {
  const [resultado, enviar, pendiente] = useActionState<ResultadoAccion, FormData>(accion, null);
  const [elegida, setElegida] = useState<AccionRevision>('aprobar');
  const exigeMotivo = elegida !== 'aprobar';

  return (
    <form action={enviar} className="flex flex-col gap-3">
      {yaFirmadaPorElMotor && (
        <p className="text-[12px] m-0" style={{ color: 'var(--muted)' }}>
          Cuadró sola, pero si una cifra no es la del ticket todavía la puedes corregir aquí.
        </p>
      )}

      <div role="radiogroup" aria-label="Qué hacer con esta liquidación" className="flex flex-wrap gap-2">
        {OPCIONES.map((o) => (
          <label key={o.id}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium rounded-lg px-3 py-1.5 cursor-pointer"
            style={elegida === o.id
              ? { background: 'var(--marca)', color: 'var(--marca-fg)' }
              : { ...ESTILO_CONTROL }}>
            <input type="radio" name="accion" value={o.id} checked={elegida === o.id}
              onChange={() => setElegida(o.id)} className="sr-only" />
            {o.icono}{o.rotulo}
          </label>
        ))}
      </div>

      {elegida === 'ajustar' && (
        <div>
          <p className="text-[12px] mb-2" style={{ color: 'var(--muted)' }}>
            Escribe el monto CORRECTO del comprobante que se leyó mal. Los que dejes vacíos no se tocan.
            El sistema recalcula el cuadre con los montos corregidos antes de guardar el ajuste con tu firma.
          </p>
          {gastos.length === 0 ? (
            <p className="text-[12px] m-0" style={{ color: 'var(--muted)' }}>
              Esta liquidación no trae comprobantes individuales registrados: no hay monto que ajustar.
              Si la cifra está mal, rechaza y pide el comprobante de nuevo.
            </p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
              {gastos.map((g) => (
                <li key={g.id} className="flex items-center gap-2 text-[12.5px]">
                  <span className="flex-1 truncate">{g.etiqueta}</span>
                  <span className="cifra-mono" style={{ color: 'var(--muted)' }}>{mxn(g.monto)}</span>
                  <input type="text" inputMode="decimal" name={`monto:${g.id}`} placeholder="monto correcto"
                    aria-label={`Monto correcto de ${g.etiqueta}`}
                    className="text-[12.5px] rounded-lg px-2 py-1 w-32 text-right cifra-mono" style={ESTILO_CONTROL} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="etiqueta-mono text-[10px] uppercase" style={{ color: 'var(--faint)' }}>
          Motivo{exigeMotivo ? ' (obligatorio)' : ' (opcional)'}
        </span>
        <textarea name="motivo" rows={2} required={exigeMotivo}
          className="text-[12.5px] rounded-lg px-2 py-1.5" style={ESTILO_CONTROL}
          placeholder={elegida === 'rechazar'
            ? 'Lo que va a leer el operador: «faltan las casetas del regreso»'
            : elegida === 'ajustar'
              ? 'Por qué se corrige: «el ticket dice 8,000, no 800»'
              : 'Si quieres dejar una nota en la bitácora'} />
      </label>

      {elegida === 'rechazar' && (
        <p className="text-[12px] m-0" style={{ color: 'var(--muted)' }}>
          El viaje {folio} vuelve a aceptar comprobantes y al operador le llega este motivo por WhatsApp.
        </p>
      )}

      <Aviso estado={resultado} />

      <div>
        <button type="submit" disabled={pendiente}
          className="text-sm font-medium rounded-lg px-4 py-2 w-full md:w-auto disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
          {pendiente ? 'Firmando…' : OPCIONES.find((o) => o.id === elegida)!.rotulo}
        </button>
      </div>
    </form>
  );
}
