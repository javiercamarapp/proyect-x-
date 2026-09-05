import { randomUUID } from 'node:crypto';

/** Los dos ejemplares comparten versión; pdf_url es el único puntero vigente. */
export function rutasPdfVersionadas(tenantId: string, viajeId: string) {
  const contralor = `${tenantId}/${viajeId}-version-${randomUUID()}.pdf`;
  return { contralor, operador: rutaPdfOperador(contralor, tenantId, viajeId) };
}

export function rutaPdfOperador(contralor: string, tenantId: string, viajeId: string): string {
  const base = `${tenantId}/${viajeId}`;
  const version = contralor.slice(base.length);
  if (!contralor.startsWith(base) || (version !== '.pdf' && !/^-version-[0-9a-f-]{36}\.pdf$/.test(version))) {
    throw new Error('La ruta PDF no corresponde a esta liquidación');
  }
  return contralor.replace(/\.pdf$/, '-operador.pdf');
}
