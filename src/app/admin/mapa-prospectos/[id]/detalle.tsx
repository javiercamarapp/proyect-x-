'use client';

// ═══════════════════════════════════════════════════════════════════════════
// LA FICHA DE UN PROSPECTO (orden del 20-ago) — todo lo que el Cerebro resume
// en una tarjeta, aquí desglosado: decisor(es) con su fuente y confianza
// (0138), flota/historia (0140, NULL declarado si no se encontró — nunca se
// infiere), los tres % (urgencia/cierre/completitud del mapa + similitud ICP/
// necesidad de la 0140, que son columnas GENERADAS: se leen, no se
// recalculan aquí), y los mensajes con sus botones de envío reales.
// Mismos tokens y componentes que cerebro.tsx — es la misma pantalla, con
// más aire.
// ═══════════════════════════════════════════════════════════════════════════

import Link from 'next/link';
import { useState } from 'react';
import type { DetalleProspecto } from '@/lib/admin/prospectos-mapa-client';
import { COLOR_EMBUDO, NOMBRE_GIRO, esProspectoTerminal } from '@/lib/admin/prospectos-mapa-client';
import { hrefWa, hrefCorreo, mensajeWa, correoProspecto } from '../mensajes';
import { fechaHoraMx, numero } from '@/lib/formato';

const TINTA = 'var(--ink)';
const TENUE = 'var(--muted)';
const LINEA = 'var(--line)';
const SUPERFICIE = 'var(--surface)';

const CONFIANZA_COLOR: Record<string, string> = { alta: '#16a34a', media: '#d97706', baja: '#94a3b8' };
const CONFIANZA_LABEL: Record<string, string> = { alta: 'Confianza alta', media: 'Confianza media', baja: 'Confianza baja' };
const ORIGEN_LABEL: Record<string, string> = {
  sitio_empresa: 'Sitio oficial', linkedin: 'LinkedIn', directorio: 'Directorio corporativo',
  denue: 'DENUE', prensa: 'Prensa', inferido: 'Inferido (sin verificar)', otro: 'Otra fuente',
};

function Barra({ etiqueta, pct, color, sub }: { etiqueta: string; pct: number; color: string; sub?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px]" style={{ color: TENUE }}>
        <span className="flex-1">{etiqueta}</span>
        <span className="tabular-nums font-semibold" style={{ color: TINTA }}>{pct}%</span>
      </div>
      <span className="block h-1.5 rounded-full overflow-hidden" style={{ background: LINEA }}>
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      {sub && <p className="text-[10px]" style={{ color: TENUE }}>{sub}</p>}
    </div>
  );
}

function Campo({ etiqueta, children, mono }: { etiqueta: string; children: React.ReactNode; mono?: boolean }) {
  const vacio = children === null || children === undefined || children === '';
  return (
    <div className="rounded-xl p-3.5" style={{ background: 'var(--canvas)', border: `1px solid ${LINEA}` }}>
      <dt className="text-[10px] uppercase tracking-wider mb-1" style={{ color: TENUE }}>{etiqueta}</dt>
      <dd className={mono ? 'text-[13px] tabular-nums' : 'text-[13.5px] font-medium'}
        style={{ color: vacio ? TENUE : TINTA, fontStyle: vacio ? 'italic' : 'normal' }}>
        {vacio ? 'no disponible' : children}
      </dd>
    </div>
  );
}

export function Detalle({ p }: { p: DetalleProspecto }) {
  const c = COLOR_EMBUDO[p.estado] ?? COLOR_EMBUDO.nuevo;
  const [afinando, setAfinando] = useState(false);
  const [datos, setDatos] = useState(p);

  const tocar = (canal: 'whatsapp' | 'correo') => {
    void fetch('/api/admin/mapa-prospectos/toque', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, canal }),
    }).catch(() => undefined);
  };

  const afinar = async () => {
    setAfinando(true);
    try {
      const r = await fetch('/api/admin/mapa-prospectos/mensaje', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id }),
      });
      if (!r.ok) return;
      const m = (await r.json()) as Pick<DetalleProspecto, 'mensajeWaIa' | 'correoAsuntoIa' | 'correoCuerpoIa' | 'mensajesGeneradosEn'>;
      setDatos((d) => ({ ...d, ...m }));
    } finally {
      setAfinando(false);
    }
  };

  // La ficha SÍ trae los textos largos, así que se pasan explícitos (FE-16:
  // sin ellos los href caerían a la plantilla determinista).
  const linkWa = hrefWa(datos, datos);
  const linkCorreo = hrefCorreo(datos, datos);
  const textoWa = datos.mensajeWaIa ?? mensajeWa(datos);
  const asuntoCorreo = datos.correoAsuntoIa ?? correoProspecto(datos).asunto;
  const cuerpoCorreo = datos.correoCuerpoIa ?? correoProspecto(datos).cuerpo;

  return (
    <div className="w-full px-6 space-y-8 pb-16">
      <Link href="/admin/mapa-prospectos"
        className="inline-flex items-center gap-1.5 text-[12px] hover:underline" style={{ color: TENUE }}>
        ← Volver al Cerebro de ventas
      </Link>

      {/* ── Encabezado ─────────────────────────────────────────────────── */}
      <header className="space-y-2 pb-5" style={{ borderBottom: `1px solid ${LINEA}` }}>
        <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: TENUE }}>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
            style={{ background: `color-mix(in srgb, ${c.color} 14%, var(--surface))`, color: c.color, fontWeight: 500 }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} /> {c.nombre}
          </span>
          <span>· {NOMBRE_GIRO[p.giro]}</span>
          {p.ciudad && <span>· {p.ciudad}{p.entidad ? `, ${p.entidad}` : ''}</span>}
          {p.tamano && <span>· {p.tamano} personas (DENUE)</span>}
        </div>
        <h1 className="text-2xl font-semibold" style={{ color: TINTA }}>{p.empresa}</h1>
        {p.vacante && <p className="text-sm" style={{ color: TENUE }}>Vacante publicada: «{p.vacante}»</p>}
      </header>

      {/* ── Los cinco porcentajes ──────────────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl p-4" style={{ background: SUPERFICIE, border: `1px solid ${LINEA}` }}>
          <h3 className="text-[11px] uppercase tracking-wider mb-3" style={{ color: TENUE }}>Del mapa (Cerebro)</h3>
          <div className="space-y-3">
            <Barra etiqueta="Urgencia" pct={p.urgencia} color="#f59e0b" />
            <Barra etiqueta="Cierre" pct={p.cierre} color="#34d399" />
            <Barra etiqueta="Datos completos" pct={p.completitud} color="#38bdf8" />
          </div>
        </div>
        <div className="rounded-2xl p-4" style={{ background: SUPERFICIE, border: `1px solid ${LINEA}` }}>
          <h3 className="text-[11px] uppercase tracking-wider mb-3" style={{ color: TENUE }}>
            De investigación (0140) — calculadas, nadie las escribe a mano
          </h3>
          <div className="space-y-3">
            <Barra etiqueta="Similitud con el ICP" pct={p.similitudIcpPct} color="#8b5cf6"
              sub="giro correcto +40 · vacante publicada +25 · flota ≥10 +20 · sitio verificado +15" />
            <Barra etiqueta="Necesidad" pct={p.necesidadPct} color="#ef4444"
              sub="vacante de liquidación/cuadre +50 (otra vacante +25) · flota ≥20 +25" />
          </div>
        </div>
      </section>

      {/* ── Decisores ──────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold mb-1" style={{ color: TINTA }}>
          {p.personas.length > 0 ? `Decisor${p.personas.length > 1 ? 'es' : ''} investigado${p.personas.length > 1 ? 's' : ''}` : 'Decisor'}
        </h2>
        {p.personas.length === 0 && !p.contacto && (
          <p className="text-sm italic" style={{ color: TENUE }}>Sin decisor público confirmado todavía.</p>
        )}
        {p.personas.length === 0 && p.contacto && (
          <div className="rounded-xl p-3.5" style={{ background: 'var(--canvas)', border: `1px solid ${LINEA}` }}>
            <p className="text-sm font-medium" style={{ color: TINTA }}>{p.contacto}</p>
          </div>
        )}
        {p.personas.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {p.personas.map((per) => (
              <div key={per.id} className="rounded-xl p-3.5 space-y-1.5" style={{ background: 'var(--canvas)', border: `1px solid ${LINEA}` }}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold" style={{ color: TINTA }}>{per.nombre}</p>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0"
                    style={{ color: CONFIANZA_COLOR[per.confianza], background: `color-mix(in srgb, ${CONFIANZA_COLOR[per.confianza]} 14%, var(--surface))` }}>
                    {CONFIANZA_LABEL[per.confianza]}
                  </span>
                </div>
                {per.puesto && <p className="text-[12.5px]" style={{ color: TENUE }}>{per.puesto}</p>}
                <div className="text-[12px] space-y-0.5 pt-1">
                  {per.telefono && <p><a className="hover:underline" href={`tel:${per.telefono}`} style={{ color: TINTA }}>📞 {per.telefono}</a></p>}
                  {per.correo && <p><a className="hover:underline" href={`mailto:${per.correo}`} style={{ color: TINTA }}>✉️ {per.correo}</a></p>}
                  {per.linkedin && <p><a className="hover:underline" href={per.linkedin} target="_blank" rel="noreferrer" style={{ color: TINTA }}>🔗 LinkedIn</a></p>}
                </div>
                <p className="text-[10.5px] pt-1" style={{ color: TENUE }}>
                  {ORIGEN_LABEL[per.origen] ?? per.origen}{per.evidencia ? ` — ${per.evidencia}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── La ficha ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold mb-3" style={{ color: TINTA }}>Ficha</h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Campo etiqueta="Teléfono" mono>
            {p.telefono ? <a className="hover:underline" href={`tel:${p.telefono}`}>{p.telefono}</a> : null}
          </Campo>
          <Campo etiqueta="Correo" mono>
            {p.correo ? <a className="hover:underline" href={`mailto:${p.correo}`}>{p.correo}</a> : null}
          </Campo>
          <Campo etiqueta="Sitio">
            {p.sitio ? (
              <span className="inline-flex items-center gap-1.5">
                <a className="hover:underline" href={p.sitio.startsWith('http') ? p.sitio : `https://${p.sitio}`} target="_blank" rel="noreferrer">{p.sitio}</a>
                {p.sitioVerificado
                  ? <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: '#16a34a', background: 'color-mix(in srgb, #16a34a 14%, var(--surface))' }}>verificado</span>
                  : <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: TENUE, background: LINEA }}>sin verificar</span>}
              </span>
            ) : null}
          </Campo>
          <Campo etiqueta="Flota" mono>{p.numUnidades !== null ? `${numero(p.numUnidades)} unidades` : null}</Campo>
          <Campo etiqueta="Viajes/mes (estimado)" mono>
            {p.viajesMesEstimado !== null ? `≈ ${numero(p.viajesMesEstimado)}` : null}
          </Campo>
          <Campo etiqueta="Fuente">{p.fuenteCruda}</Campo>
          <Campo etiqueta="Registrado">{fechaHoraMx(p.creadoEn)}</Campo>
          <Campo etiqueta="Último toque">{p.ultimoToque ? fechaHoraMx(p.ultimoToque) : null}</Campo>
        </dl>
        {p.viajesMesEstimado !== null && (
          <p className="text-[10.5px] mt-2" style={{ color: TENUE }}>
            Estimado, no medido: {numero(p.numUnidades ?? 0)} unidades × 18 viajes/unidad/mes (supuesto de sector).
          </p>
        )}
      </section>

      {p.historia && (
        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: TINTA }}>Historia</h2>
          <p className="text-[13.5px] leading-relaxed" style={{ color: TINTA }}>{p.historia}</p>
        </section>
      )}

      {p.notas && (
        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: TINTA }}>Notas de investigación</h2>
          <pre className="text-[12.5px] leading-relaxed whitespace-pre-wrap rounded-xl p-3.5"
            style={{ color: TENUE, background: 'var(--canvas)', border: `1px solid ${LINEA}`, fontFamily: 'inherit' }}>
            {p.notas}
          </pre>
        </section>
      )}

      {/* ── Mensajes ───────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-base font-semibold" style={{ color: TINTA }}>Mensajes</h2>
          {!esProspectoTerminal(p.estado) && (
            <button onClick={() => void afinar()} disabled={afinando}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium"
              style={{ border: '1px solid #7c3aed55', color: '#6d28d9', background: 'color-mix(in srgb, #7c3aed 8%, var(--surface))', opacity: afinando ? 0.6 : 1 }}>
              {afinando ? 'redactando…' : datos.mensajesGeneradosEn ? '↻ Redactar de nuevo con IA' : '✨ Redactar con IA'}
            </button>
          )}
        </div>
        {datos.mensajesGeneradosEn && (
          <p className="text-[11px] mb-3" style={{ color: TENUE }}>
            Última redacción del agente experto: {fechaHoraMx(datos.mensajesGeneradosEn)}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl overflow-hidden flex flex-col" style={{ background: SUPERFICIE, border: `1px solid ${LINEA}` }}>
            <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: `1px solid ${LINEA}` }}>
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: TENUE }}>WhatsApp</span>
              {p.telefono && <span className="text-[11px] tabular-nums" style={{ color: TENUE }}>{p.telefono}</span>}
            </div>
            <p className="text-[13px] leading-relaxed p-4 whitespace-pre-wrap flex-1" style={{ color: TINTA }}>{textoWa}</p>
            <div className="p-3 pt-0">
              {linkWa
                ? <a href={linkWa} target="_blank" rel="noreferrer" onClick={() => tocar('whatsapp')}
                    className="block text-center px-3 py-2 rounded-lg text-[13px] font-medium"
                    style={{ background: '#16a34a', color: '#fff' }}>💬 Enviar WhatsApp</a>
                : <p className="text-[12px] italic" style={{ color: TENUE }}>Sin teléfono — no se puede mandar.</p>}
            </div>
          </div>
          <div className="rounded-2xl overflow-hidden flex flex-col" style={{ background: SUPERFICIE, border: `1px solid ${LINEA}` }}>
            <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: `1px solid ${LINEA}` }}>
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: TENUE }}>Correo</span>
              {p.correo && <span className="text-[11px] tabular-nums" style={{ color: TENUE }}>{p.correo}</span>}
            </div>
            <p className="text-[12px] px-4 pt-3" style={{ color: TENUE }}><strong style={{ color: TINTA }}>Asunto:</strong> {asuntoCorreo}</p>
            <p className="text-[13px] leading-relaxed p-4 whitespace-pre-wrap flex-1" style={{ color: TINTA }}>{cuerpoCorreo}</p>
            <div className="p-3 pt-0">
              {linkCorreo
                ? <a href={linkCorreo} onClick={() => tocar('correo')}
                    className="block text-center px-3 py-2 rounded-lg text-[13px] font-medium"
                    style={{ background: '#2563eb', color: '#fff' }}>✉️ Enviar correo</a>
                : <p className="text-[12px] italic" style={{ color: TENUE }}>Sin correo — no se puede mandar.</p>}
            </div>
          </div>
        </div>
        <p className="text-[11px] mt-3" style={{ color: TENUE }}>Nada se manda solo — los botones abren tu WhatsApp/correo con el texto cargado, tú decides.</p>
      </section>
    </div>
  );
}
