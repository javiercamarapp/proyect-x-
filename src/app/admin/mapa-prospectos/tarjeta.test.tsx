// ═══════════════════════════════════════════════════════════════════════════
// FE-16, EN EL RENDER — el botón no puede abrirse con el mensaje equivocado.
//
// Al sacar los textos largos del listado, los href de WhatsApp y correo se
// quedaron sin el texto del agente experto hasta que llega su petición. La
// plantilla determinista es el respaldo CORRECTO para el prospecto que nadie
// ha trabajado, y sería un error para el que sí: mandaría un primer toque
// distinto del que se redactó, firmado por Javier, y eso no se deshace.
//
// Esta prueba mira el HTML que sale, no la lógica: los tres estados de la
// tarjeta (sin mensaje redactado, esperándolo, y ya con él).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DetalleProspecto, ProspectoMapa, TextosProspecto } from '@/lib/admin/prospectos-mapa';
import { TarjetaProspecto } from './cerebro';
import { Detalle } from './[id]/detalle';
import { mensajeWa } from './mensajes';

const base: ProspectoMapa = {
  id: 'p1', empresa: 'Fletes del Norte', ciudad: 'Escobedo', entidad: 'Nuevo León',
  lat: 25.8, lng: -100.3, telefono: '8112345678', correo: 'dg@fletes.mx',
  contacto: 'Ramón Treviño', vacante: 'Auxiliar de liquidaciones',
  estado: 'contactado', fuente: 'censo', giro: 'transportista',
  urgencia: 70, cierre: 60, tamano: '51-100', completitud: 90,
  ultimoToque: null, mensajesGeneradosEn: null,
  numUnidades: 40, similitudIcpPct: 80, necesidadPct: 70,
};

const pintar = (p: ProspectoMapa, t?: TextosProspecto) =>
  renderToStaticMarkup(<TarjetaProspecto p={p} t={t} nuevo={false} onAfinar={() => undefined} />);

describe('la tarjeta del Cerebro con los textos fuera del listado', () => {
  it('sin mensaje redactado: los botones abren YA, con la plantilla', () => {
    const html = pintar(base);
    expect(html).toContain('WhatsApp →');
    expect(html).toContain(encodeURIComponent(mensajeWa(base)));
    expect(html).toContain('mailto:dg@fletes.mx');
    expect(html).not.toContain('WhatsApp …');
  });

  it('CON mensaje redactado y sin los textos todavía: no hay href — ni el de la plantilla', () => {
    const html = pintar({ ...base, mensajesGeneradosEn: '2026-08-20T10:00:00.000Z' });
    expect(html).toContain('WhatsApp …');
    expect(html).toContain('Correo …');
    expect(html).not.toContain('wa.me');
    // El `mailto:` pelón de la línea de contacto sigue (es la dirección, no
    // un mensaje); lo que no puede existir es un correo YA REDACTADO con la
    // plantilla mientras el del agente viene en camino.
    expect(html).not.toContain('?subject=');
    expect(html).not.toContain(encodeURIComponent(mensajeWa(base)));
    // El sello de que hay algo redactado sí se ve desde el listado: viaja la
    // MARCA, no el texto.
    expect(html).toContain('mensaje del agente experto listo');
  });

  it('cuando los textos llegan: el botón abre con el texto del agente y aparecen las notas', () => {
    const html = pintar(
      { ...base, mensajesGeneradosEn: '2026-08-20T10:00:00.000Z' },
      {
        id: 'p1', notas: 'DENUE: Autotransporte foráneo de carga general',
        mensajeWaIa: 'TEXTO-DEL-AGENTE', correoAsuntoIa: 'ASUNTO-IA', correoCuerpoIa: 'CUERPO-IA',
      },
    );
    expect(html).toContain(encodeURIComponent('TEXTO-DEL-AGENTE'));
    expect(html).toContain(encodeURIComponent('ASUNTO-IA'));
    expect(html).toContain('Autotransporte foráneo de carga general');
    expect(html).not.toContain('WhatsApp …');
  });

  it('sin teléfono ni correo no se inventa un botón apagado', () => {
    const html = pintar({ ...base, telefono: null, correo: null, mensajesGeneradosEn: '2026-08-20T10:00:00.000Z' });
    expect(html).not.toContain('WhatsApp');
    expect(html).not.toContain('Correo');
    // La ruta a la dirección real sí sigue: no depende de ningún texto.
    expect(html).toContain('Cómo llegar');
  });

  it.each(['won', 'cerrado', 'lost', 'perdido'])('en %s no muestra el botón de Mensaje IA', (estado) => {
    const html = pintar({ ...base, estado });
    expect(html).not.toContain('Mensaje IA');
  });

  it.each(['won', 'cerrado', 'lost', 'perdido'])('la ficha en %s tampoco muestra Redactar con IA', (estado) => {
    const detalle: DetalleProspecto = {
      ...base, estado,
      notas: null, mensajeWaIa: null, correoAsuntoIa: null, correoCuerpoIa: null,
      sitio: null, sitioVerificado: false, historia: null, viajesMesEstimado: null,
      fuenteCruda: 'censo', creadoEn: '2026-08-01T00:00:00.000Z', personas: [],
    };
    expect(renderToStaticMarkup(<Detalle p={detalle} />)).not.toContain('Redactar con IA');
  });
});
