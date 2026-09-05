'use client';

import { useEffect } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet } from 'lucide-react';
import { validarArchivoElegido } from '@/lib/http/subidas_formulario';

export type ResumenImportado = {
  totalLineas: number;
  cuadra: number;
  noCuadra: number;
  sinContraparte: number;
  avisos: string[];
};
export type EstadoImportar = { error?: string; resumen?: ResumenImportado } | null;
export type AccionImportar = (prev: EstadoImportar, fd: FormData) => Promise<EstadoImportar>;

/**
 * El desglose del proveedor (Excel/CSV/PDF), por pantalla. El servidor lo
 * importa Y corre el cruce en el mismo paso (el momento del PoC: sube el
 * archivo, ve sus tres cubetas); el acuse dice los tres números y los avisos
 * del parseo — lo que se saltó se DICE, no desaparece. Tras importar, la
 * página completa se refresca para que la lista y el detalle cuenten lo nuevo.
 */
export function SubirDesgloseProveedor({ importar }: { importar: AccionImportar }) {
  const [estado, accion] = useActionState(importar, null);
  const router = useRouter();

  useEffect(() => {
    if (estado?.resumen) router.refresh();
  }, [estado, router]);

  const r = estado?.resumen;

  return (
    <div>
      <form action={accion} className="flex items-center gap-2 flex-wrap">
        <input type="file" name="archivo" accept=".xlsx,.xls,.csv,.tsv,.ods,.pdf" required
          onChange={(e) => validarArchivoElegido(e.currentTarget)}
          aria-label="Desglose del proveedor de peaje (Excel, CSV o PDF)"
          className="text-[12.5px] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-medium file:cursor-pointer"
          style={{ color: 'var(--muted)' }} />
        <input type="text" name="proveedor" placeholder="Proveedor (IAVE, PASE, TeleVía…)"
          aria-label="Proveedor del desglose (opcional)"
          className="hairline text-[12.5px] px-2.5 py-1.5 rounded-lg w-[210px]"
          style={{ background: 'var(--surface)', color: 'var(--ink)' }} />
        <BotonImportar />
      </form>
      <p className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>Máximo 4 MB por archivo.</p>
      {estado?.error && <p className="text-[12px] mt-2" style={{ color: 'var(--bad)' }}>{estado.error}</p>}
      {r && (
        <div className="text-[12px] mt-2 space-y-0.5" style={{ color: 'var(--muted)' }}>
          <p>
            Desglose importado (<span className="cifra-mono">{r.totalLineas}</span> líneas) y cruzado:{' '}
            <span className="cifra-mono font-medium" style={{ color: 'var(--ink)' }}>{r.cuadra}</span> cuadran
            {r.noCuadra > 0 && <> · <span className="cifra-mono">{r.noCuadra}</span> con discrepancia</>}
            {r.sinContraparte > 0 && <> · <span className="cifra-mono">{r.sinContraparte}</span> sin contraparte</>}.
          </p>
          {r.avisos.map((a) => (
            <p key={a} style={{ color: 'var(--faint)' }}>{a}</p>
          ))}
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
      <FileSpreadsheet width={13} height={13} strokeWidth={2} className={pending ? 'animate-pulse' : ''} />
      {pending ? 'Cruzando…' : 'Importar y cruzar'}
    </button>
  );
}
