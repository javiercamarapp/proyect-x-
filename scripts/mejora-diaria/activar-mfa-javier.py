#!/usr/bin/env python3
"""Retiro seguro del enrolamiento automatizado de MFA.

La versión anterior creaba y verificaba un factor TOTP con service role,
guardaba su QR fuera del repositorio y enviaba el secreto/URI por WhatsApp.
Eso duplicaba el factor en canales recuperables y anulaba el propósito del
segundo factor. El enrolamiento ahora se hace únicamente en Mi perfil, dentro
de una sesión autenticada, y el secreto no sale del dispositivo del usuario.
"""

raise SystemExit(
    "Este script fue retirado por seguridad. Abre /dashboard/mi-perfil en "
    "Likida, inscribe el TOTP ahí y guarda los códigos de recuperación en el "
    "gestor de contraseñas aprobado. Nunca envíes el secreto ni el QR por chat."
)
