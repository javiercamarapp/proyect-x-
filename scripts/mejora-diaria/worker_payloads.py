"""Transporte del worker: cada JSON cabe antes de salir hacia Functions."""
import json

MAX_BODY_BYTES = 4_400_000
MAX_MEDIA_BYTES = 3 * 1024 * 1024


def codificar(cuerpo):
    datos = json.dumps(cuerpo, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(datos) > MAX_BODY_BYTES:
        raise ValueError("El cuerpo del worker excede el límite de transporte")
    return datos


def lotes_catalogo(filas):
    lote = []
    for fila in filas:
        candidato = lote + [fila]
        if len(candidato) > 50 or len(json.dumps({"rutinas": candidato}, ensure_ascii=False).encode("utf-8")) > MAX_BODY_BYTES:
            if not lote:
                raise ValueError("Una rutina excede el límite de transporte")
            yield codificar({"rutinas": lote})
            lote = [fila]
        else:
            lote = candidato
    if lote:
        yield codificar({"rutinas": lote})
