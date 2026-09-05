'use client';

import { useEffect } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { FileUp } from 'lucide-react';
import { validarArchivoElegido } from '@/lib/http/subidas_formulario';

export interface ResultadoImportarUI {
  error?: string;
  resumen?: {
    creados: number;
    saltados: number;
    descartadas: Array<{ fila: number; motivo: string }>;
    operadoresSinAmarrar: string[];
    /** Folios sin operador amarrable — NO se crean (operador_id es NOT NULL). */
    sinOperador: string[];
    /** Folios saltados porque su operador ya trae un viaje abierto (0029). */
    operadorOcupado: string[];
    /** Números económicos del archivo que no existen en Unidades. */
    unidadesSinAmarrar: string[];
    /** Folios NO creados porque su unidad no se pudo amarrar. */
    sinUnidad: string[];
    /** Nombres de cliente del archivo que no existen en Clientes y tarifas. */
    clientesSinAmarrar: string[];
    /** Folios NO creados porque su cliente no se pudo amarrar. */
    sinCliente: string[];
  };
}

export type AccionImportar = (prev: ResultadoImportarUI | null, fd: FormData) => Promise<ResultadoImportarUI | null>;

/**
 * El export del TMS (CSV/Excel) entra al Registro — el kit del PoC: sin
 * esto, el conciliador de peajes no tiene contra qué cruzar. La lectura y
 * la inserción viven en el servidor; NADIE recibe WhatsApp por un import.
 */
export function ImportarViajes({ importar }: { importar: AccionImportar }) {
  const [estado, accion] = useActionState(importar, null);
  const router = useRouter();

  useEffect(() => {
    if (estado?.resumen) router.refresh();
  }, [estado, router]);

  const r = estado?.resumen;

  return (
    <div className="min-w-0">
      <form action={accion} className="flex items-center gap-2 flex-wrap">
        <input type="file" name="archivo" accept=".csv,.xlsx,.xls" required
          onChange={(e) => validarArchivoElegido(e.currentTarget)}
          aria-label="CSV o Excel con los viajes"
          className="text-[12.5px] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-medium file:cursor-pointer"
          style={{ color: 'var(--muted)' }} />
        <BotonImportar />
      </form>
      <p className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>
        Máximo 4 MB por archivo.{' '}
        Columnas: folio (obligatoria), origen, destino, fecha, anticipo, operador, unidad, cliente, ingreso, km.
        La unidad y el cliente se amarran contra el catálogo; ingreso vacío no es cero.
        Sin avisos de WhatsApp; los folios que ya existen se saltan solos.
      </p>
      {estado?.error && <p className="text-[12px] mt-1.5" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
      {r && (
        <div className="text-[12px] mt-1.5 space-y-0.5" style={{ color: 'var(--muted)' }}>
          <p>
            <span className="cifra-mono font-medium" style={{ color: 'var(--ink)' }}>{r.creados}</span> viajes creados
            {r.saltados > 0 && <> · {r.saltados} saltados (el folio ya existía)</>}
            {r.descartadas.length > 0 && <span style={{ color: 'var(--warn)' }}> · {r.descartadas.length} filas descartadas</span>}
          </p>
          {r.descartadas.slice(0, 5).map((d) => (
            <p key={d.fila} style={{ color: 'var(--warn)' }}>fila {d.fila}: {d.motivo}</p>
          ))}
          {r.descartadas.length > 5 && <p style={{ color: 'var(--faint)' }}>y {r.descartadas.length - 5} más.</p>}
          {r.sinOperador.length > 0 && (
            <p style={{ color: 'var(--warn)' }}>
              {r.sinOperador.length === 1 ? '1 viaje NO se creó' : `${r.sinOperador.length} viajes NO se crearon`} por
              no traer operador amarrable ({r.sinOperador.join(', ')})
              {r.operadoresSinAmarrar.length > 0 && <> — nombres sin amarrar: {r.operadoresSinAmarrar.join(', ')}</>}.
              Da de alta o corrige el nombre en Operadores y vuelve a subir el archivo: los ya creados se saltan solos.
            </p>
          )}
          {r.operadorOcupado.length > 0 && (
            <p style={{ color: 'var(--warn)' }}>
              {r.operadorOcupado.length === 1 ? '1 viaje saltado' : `${r.operadorOcupado.length} viajes saltados`} porque
              su operador ya trae un viaje abierto ({r.operadorOcupado.join(', ')}) — ciérralo o liquídalo primero.
            </p>
          )}
          {r.sinUnidad.length > 0 && (
            <p style={{ color: 'var(--warn)' }}>
              {r.sinUnidad.length === 1 ? '1 viaje NO se creó' : `${r.sinUnidad.length} viajes NO se crearon`} porque
              su unidad no está dada de alta ({r.sinUnidad.join(', ')})
              {r.unidadesSinAmarrar.length > 0 && <> — números sin amarrar: {r.unidadesSinAmarrar.join(', ')}</>}.
              Regístrala en Unidades y vuelve a subir el archivo: los ya creados se saltan solos.
            </p>
          )}
          {r.sinCliente.length > 0 && (
            <p style={{ color: 'var(--warn)' }}>
              {r.sinCliente.length === 1 ? '1 viaje NO se creó' : `${r.sinCliente.length} viajes NO se crearon`} porque
              su cliente no está dado de alta ({r.sinCliente.join(', ')})
              {r.clientesSinAmarrar.length > 0 && <> — nombres sin amarrar: {r.clientesSinAmarrar.join(', ')}</>}.
              Regístralo en Clientes y tarifas y vuelve a subir el archivo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BotonImportar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-lg transition-opacity hover:opacity-85 disabled:opacity-50"
      style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
      <FileUp width={13} height={13} strokeWidth={2} className={pending ? 'animate-pulse' : ''} />
      {pending ? 'Importando…' : 'Importar viajes'}
    </button>
  );
}
